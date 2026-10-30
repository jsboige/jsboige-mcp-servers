/**
 * Machine registry file access — tolerant of Google Drive conflict copies.
 *
 * WHY — Google Drive File Stream (DriveFS) forks a file that two clients
 * edited concurrently into `<name> (N)<ext>` and DROPS the canonical name.
 * The machine registry `.machine-registry.json` is written by EVERY seat at
 * boot, so the fork is routine, not exceptional. A reader that only looks at
 * the canonical name then reads the registry as ABSENT — measured on
 * myia-po-2028 (30/10/2026): canonical ABSENT, only `.machine-registry (1).json`
 * present (1 435 o, 3 machines) ⇒ the roster reference collapsed to nothing
 * (ROO_FLEET_ROSTER drift, CRITICAL — recurrence of #2570) and the machine
 * registry looked "never written" to every reader.
 *
 * The registry is ADD-ONLY ("il n'oublie aucune machine") ⇒ reading several
 * copies must UNION them, never pick one: a copy written by another seat can
 * be the only place where a machine appears.
 *
 * NOTHING here deletes a twin (no-deletion-without-proof): the twins are read
 * and left in place. The writers keep writing the CANONICAL name, so the
 * canonical is re-created as the sentinel every reader knows — which is what
 * makes the registry readable again for clients that only know that name.
 *
 * A copy that EXISTS but cannot be read is reported apart from an ABSENT
 * registry: a blind load must never be persisted over a canonical file we
 * simply failed to read (ms#1563 guard).
 *
 * @module utils/machine-registry-file
 * @version 1.1.0
 */

import { existsSync, promises as fs } from 'fs';
import { join } from 'path';

/** Canonical name of the shared machine registry. */
export const MACHINE_REGISTRY_FILENAME = '.machine-registry.json';

/** DriveFS fork of `.machine-registry.json` → `.machine-registry (N).json`. */
const TWIN_PATTERN = /^\.machine-registry \((\d+)\)\.json$/;

/** One machine entry of the shared registry. */
export interface MachineRegistryEntry {
  machineId?: string;
  firstSeen?: string;
  lastSeen?: string;
  source?: string;
  status?: string;
  [key: string]: unknown;
}

/** The shared registry file content. */
export interface MachineRegistryFile {
  machines: Record<string, MachineRegistryEntry>;
  lastUpdated?: string;
  [key: string]: unknown;
}

/** Result of a (possibly multi-copy) registry read. */
export interface MachineRegistryRead {
  /** Union of the READABLE copies — `null` when no copy could be read. */
  data: MachineRegistryFile | null;
  /** Files actually read: canonical first (when present), then twins ascending. */
  sources: string[];
  /** Copies that EXIST but could not be read (read error or invalid JSON). */
  unreadableSources: string[];
  /** The canonical name exists but is unreadable ⇒ NEVER write over it. */
  canonicalUnreadable: boolean;
  /** At least one copy of the registry exists. */
  present: boolean;
}

/** Canonical path of the shared machine registry. */
export function machineRegistryPath(sharedPath: string): string {
  return join(sharedPath, MACHINE_REGISTRY_FILENAME);
}

/**
 * DriveFS conflict copies of the registry, ascending by fork index.
 * Never throws: a store that cannot be listed simply has no known twin.
 */
export async function listMachineRegistryTwins(sharedPath: string): Promise<string[]> {
  try {
    const entries = (await fs.readdir(sharedPath, { withFileTypes: true })) as any[];
    const twins: Array<{ name: string; index: number }> = [];
    for (const entry of entries) {
      // Tolerate both a Dirent and a bare name (mocked fs in tests).
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name !== 'string') continue;
      const match = TWIN_PATTERN.exec(name);
      if (!match) continue;
      const isFile = typeof entry === 'string' || typeof entry.isFile !== 'function' ? true : entry.isFile();
      if (!isFile) continue;
      twins.push({ name, index: Number(match[1]) });
    }
    return twins
      .sort((a, b) => a.index - b.index)
      .map(twin => join(sharedPath, twin.name));
  } catch {
    return [];
  }
}

/**
 * Read one registry copy.
 * @returns the parsed copy, or `null` when it could not be read/parsed.
 */
async function readRegistryCopy(path: string): Promise<MachineRegistryFile | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const machines =
      parsed.machines && typeof parsed.machines === 'object' ? parsed.machines : {};
    return { ...parsed, machines } as MachineRegistryFile;
  } catch {
    return null;
  }
}

/** Earliest of two ISO timestamps (undefined-safe). */
function earliest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Latest of two ISO timestamps (undefined-safe). */
function latest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Merge one machine entry into the union.
 *
 * The registry only ever ADDS a machine, so a machine seen in two copies is
 * ONE machine: keep the most recent knowledge (the copy with the newest
 * `lastSeen` wins on `source`/`status`), and keep the EARLIEST `firstSeen`
 * (the moment the machine was first seen is a fact no copy can refine).
 */
function mergeEntry(
  machines: Record<string, MachineRegistryEntry>,
  rawKey: string,
  entry: MachineRegistryEntry
): void {
  const key = rawKey.toLowerCase();
  const current = machines[key];
  if (!current) {
    machines[key] = { ...entry };
    return;
  }
  const currentSeen = typeof current.lastSeen === 'string' ? current.lastSeen : '';
  const incomingSeen = typeof entry.lastSeen === 'string' ? entry.lastSeen : '';
  const incomingWins = incomingSeen > currentSeen;
  const winner = incomingWins ? entry : current;
  const loser = incomingWins ? current : entry;
  machines[key] = {
    ...loser,
    ...winner,
    firstSeen: earliest(
      typeof current.firstSeen === 'string' ? current.firstSeen : undefined,
      typeof entry.firstSeen === 'string' ? entry.firstSeen : undefined
    ),
    lastSeen: latest(
      typeof current.lastSeen === 'string' ? current.lastSeen : undefined,
      typeof entry.lastSeen === 'string' ? entry.lastSeen : undefined
    )
  };
}

/**
 * Read the shared machine registry, unioning the DriveFS conflict copies.
 *
 * @returns the union of the readable copies plus the copies that exist but
 * could not be read. `data` is `null` when no copy is readable; `present` is
 * `false` when no copy of the registry exists at all.
 */
export async function readMachineRegistryFile(
  sharedPath: string
): Promise<MachineRegistryRead> {
  const canonical = machineRegistryPath(sharedPath);
  const twins = await listMachineRegistryTwins(sharedPath);

  // The canonical is a candidate only if it exists — a twin is always a
  // candidate (its presence is the reason we are here).
  const candidates: string[] = [];
  // existsSync n'est pas enveloppé : une erreur d'accès est un fait qui doit
  // remonter à l'appelant (le registre est-il lisible ?), pas être avalé en
  // « absent ».
  const canonicalPresent = existsSync(canonical);
  if (canonicalPresent) candidates.push(canonical);
  candidates.push(...twins);

  const machines: Record<string, MachineRegistryEntry> = {};
  const sources: string[] = [];
  const unreadableSources: string[] = [];
  let base: Record<string, unknown> = {};
  let lastUpdated: string | undefined;

  for (const path of candidates) {
    const copy = await readRegistryCopy(path);
    if (!copy) {
      unreadableSources.push(path);
      continue;
    }
    sources.push(path);
    if (sources.length === 1) {
      // Top-level keys of the first readable copy (canonical when present).
      const { machines: _ignored, ...rest } = copy as Record<string, unknown>;
      base = rest;
    }
    for (const [key, entry] of Object.entries(copy.machines || {})) {
      if (!entry || typeof entry !== 'object') continue;
      mergeEntry(machines, key, entry as MachineRegistryEntry);
    }
    if (typeof copy.lastUpdated === 'string') {
      lastUpdated = latest(lastUpdated, copy.lastUpdated);
    }
  }

  return {
    data:
      sources.length > 0
        ? ({ ...base, machines, lastUpdated } as MachineRegistryFile)
        : null,
    sources,
    unreadableSources,
    canonicalUnreadable:
      canonicalPresent && unreadableSources.includes(canonical),
    present: candidates.length > 0
  };
}
