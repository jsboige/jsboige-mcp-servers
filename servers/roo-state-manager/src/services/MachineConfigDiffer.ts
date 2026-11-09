/**
 * MachineConfigDiffer — compares two `MachineConfig` objects section by section.
 *
 * Issue #4611 (case 14 of #603): "un test d'intégration collecte deux machines
 * simulées par des répertoires de fixtures, les compare, et vérifie les écarts par
 * catégorie". This is the "compare" half; `MachineConfigCollector` is the "collect" half.
 *
 * The output is the `MachineConfigDiff` type defined in `src/types/machine-config.ts`
 * since #603 Phase B3 — already the target vocabulary of `roosync_compare_config`.
 *
 * Severity is a property of WHAT differs, not of how much:
 *  - `critical` — a server, a mode, or the RooSync role differ: the machines do not
 *    run the same thing, or they disagree about who coordinates;
 *  - `warning`  — a settings/permission/env-shape difference: same tooling, different
 *    tuning;
 *  - `info`     — hardware, paths, timestamps: expected to differ between seats.
 *
 * Values are compared AFTER the collector's redaction, so a diff can report
 * "<set:len=51:sha256=ab12cd34>" but never the secret itself. Two DIFFERENT secrets
 * still produce two different markers (digest of the value), so a real divergence is
 * visible and no false conformity is manufactured.
 */

import type { MachineConfig, MachineConfigDiff } from '../types/machine-config.js';

type DiffSection = MachineConfigDiff['sections'][number];
type Severity = 'critical' | 'warning' | 'info';
type ComparableSection = Exclude<keyof MachineConfig, 'machineId' | 'timestamp' | 'schemaVersion' | 'paths'>;

/** Sections compared, in the order they are reported. */
const COMPARED_SECTIONS: ComparableSection[] = ['system', 'roo', 'claude', 'environment', 'roosync'];

const SECTION_LABEL: Record<ComparableSection, string> = {
  system: 'Système & matériel',
  roo: 'Configuration Roo',
  claude: 'Configuration Claude Code',
  environment: 'Environnement & infrastructure',
  roosync: 'État RooSync',
};

/** Path prefixes that make a difference `critical`. Order matters: first match wins. */
const CRITICAL_PREFIXES = [
  'roo.mcpServers',
  'claude.mcpServers',
  'roo.modes',
  'claude.project.hasMcpJson',
  'claude.project.mcpServersCount',
  'roosync.role',
];

/** Path prefixes that make a difference `warning`. */
const WARNING_PREFIXES = [
  'roo.scheduler',
  'roo.rules',
  'claude.settings',
  'claude.userConfig',
  'environment.envVars',
  'environment.docker',
];

/** Human-readable description of a path, used as the `description` field. */
function describe(path: string, kind: 'missing-source' | 'missing-target' | 'changed'): string {
  switch (kind) {
    case 'missing-source':
      return `${path} absent de la machine source`;
    case 'missing-target':
      return `${path} absent de la machine cible`;
    default:
      return `${path} diffère`;
  }
}

/**
 * True when `path` is `prefix` itself or one of its descendants.
 *
 * Descendants are reached either by a key (`prefix.name`) or by an ARRAY INDEX
 * (`prefix[0].name`) — the array form is not cosmetic: `roo.mcpServers` is a list,
 * so every per-field leaf of a differing server arrives as `roo.mcpServers[1].name`.
 * A `.`-only prefix test sent those to `info`, i.e. a machine running a different
 * set of MCP servers was reported as a benign hardware difference.
 */
function underPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  const next = path.charAt(prefix.length);
  return next === '.' || next === '[';
}

function severityFor(path: string): Severity {
  for (const prefix of CRITICAL_PREFIXES) {
    if (underPrefix(path, prefix)) return 'critical';
  }
  for (const prefix of WARNING_PREFIXES) {
    if (underPrefix(path, prefix)) return 'warning';
  }
  return 'info';
}

/** True for values whose presence is structural rather than informative. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively flatten two values into `path → value` leaves.
 *
 * Arrays are compared by index; objects by key. A key present on one side only is
 * reported as a leaf (value on the other side is `undefined`), which is what makes
 * "server X exists only on the source" show up as a single critical finding rather
 * than a cascade of per-field diffs.
 */
function flatten(
  source: unknown,
  target: unknown,
  prefix: string,
  out: Array<{ path: string; sourceValue?: unknown; targetValue?: unknown; kind: 'changed' | 'missing-source' | 'missing-target' }>
): void {
  const sourceIsObject = isPlainObject(source);
  const targetIsObject = isPlainObject(target);

  if (sourceIsObject || targetIsObject) {
    // Materialise the narrowed views once: the `sourceHas`/`targetHas` booleans
    // below do not carry the type predicate, so indexing `source` directly would
    // be an `unknown` index access.
    const sourceObject: Record<string, unknown> = sourceIsObject ? source : {};
    const targetObject: Record<string, unknown> = targetIsObject ? target : {};
    const keys = new Set<string>([...Object.keys(sourceObject), ...Object.keys(targetObject)]);
    for (const key of [...keys].sort()) {
      const childPath = `${prefix}.${key}`;
      const sourceHas = key in sourceObject;
      const targetHas = key in targetObject;
      if (sourceHas && !targetHas) {
        out.push({ path: childPath, sourceValue: sourceObject[key], kind: 'missing-target' });
      } else if (!sourceHas && targetHas) {
        out.push({ path: childPath, targetValue: targetObject[key], kind: 'missing-source' });
      } else {
        flatten(sourceObject[key], targetObject[key], childPath, out);
      }
    }
    return;
  }

  if (Array.isArray(source) || Array.isArray(target)) {
    const sourceArray = Array.isArray(source) ? source : [];
    const targetArray = Array.isArray(target) ? target : [];
    const max = Math.max(sourceArray.length, targetArray.length);
    for (let i = 0; i < max; i++) {
      const childPath = `${prefix}[${i}]`;
      if (i >= targetArray.length) {
        out.push({ path: childPath, sourceValue: sourceArray[i], kind: 'missing-target' });
      } else if (i >= sourceArray.length) {
        out.push({ path: childPath, targetValue: targetArray[i], kind: 'missing-source' });
      } else {
        flatten(sourceArray[i], targetArray[i], childPath, out);
      }
    }
    return;
  }

  // Scalars — strict comparison. undefined on both sides could not reach here.
  if (source !== target) {
    out.push({ path: prefix, sourceValue: source, targetValue: target, kind: 'changed' });
  }
}

/** Stable JSON representation for the diff payload (keeps values diff-able). */
function render(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'object' && value !== null) return value;
  return value;
}

export class MachineConfigDiffer {
  /**
   * Compare two collected configs.
   *
   * Sections with no difference are omitted from `sections` — an empty
   * `sections` array means the two machines are aligned on every compared section
   * (`paths` and timestamps are never compared: they are expected to differ).
   */
  diff(source: MachineConfig, target: MachineConfig): MachineConfigDiff {
    const sections: DiffSection[] = [];
    let critical = 0;
    let warning = 0;
    let info = 0;

    for (const section of COMPARED_SECTIONS) {
      const leaves: Parameters<typeof flatten>[3] = [];
      flatten(source[section], target[section], section, leaves);

      const diffs: DiffSection['diffs'] = [];
      for (const leaf of leaves) {
        const severity = severityFor(leaf.path);
        if (severity === 'critical') critical++;
        else if (severity === 'warning') warning++;
        else info++;

        const entry: DiffSection['diffs'][number] = {
          path: leaf.path,
          severity,
          description: describe(leaf.path, leaf.kind),
        };
        const sourceValue = render(leaf.sourceValue);
        const targetValue = render(leaf.targetValue);
        if (sourceValue !== undefined) entry.sourceValue = sourceValue;
        if (targetValue !== undefined) entry.targetValue = targetValue;
        diffs.push(entry);
      }

      if (diffs.length > 0) {
        // Keep the label close to the data for the human reader; the type has no
        // dedicated field, so it rides along as a non-enumerable-free extra key is
        // NOT acceptable — instead the section key already names the area.
        sections.push({ section, diffs });
      }
    }

    return {
      source: source.machineId,
      target: target.machineId,
      timestamp: new Date().toISOString(),
      sections,
      summary: {
        totalDiffs: critical + warning + info,
        critical,
        warning,
        info,
      },
    };
  }
}

/** Human-readable label of a compared section, for reports and dashboards. */
export function sectionLabel(section: ComparableSection): string {
  return SECTION_LABEL[section];
}

/** Convenience wrapper for the tool layer. */
export function diffMachineConfigs(source: MachineConfig, target: MachineConfig): MachineConfigDiff {
  return new MachineConfigDiffer().diff(source, target);
}
