/**
 * HarmonizationCampaignService — primitive campagne d'harmonisation flotte
 * Issue #3545 — « Quelle machine n'est pas harmonisée ? » répondu par l'outil,
 * sans archéologie de DM ni relecture de dashboards.
 *
 * Modèle :
 *  - Un canon EXPLICITE, immuable, versionné (changer = nouvelle campagne).
 *    Le hash du canon est lié à chaque confirmation.
 *  - Dispatch par DM `machine:workspace` (MessageManager injecté — jamais
 *    importé en dur : tests avec faux messages).
 *  - Confirmations : la machine cible relit SON settings.json en live et
 *    atteste le hash observé. Un hash fourni par l'appelant ('claimed')
 *    n'est JAMAIS compté comme confirmation.
 *  - Relances idempotentes (cooldown), échecs d'envoi jamais marqués envoyés.
 *  - Re-détection de drift : hash canon vs projection live (machine locale)
 *    ou vs dernier snapshot publié (machines distantes).
 *
 * Sécurité d'écriture — défauts #3545 (review) adressés :
 *  - Preuve participant IMMUABLE : les confirmations/échecs sont des
 *    événements append-only à identifiant unique, par machine, sous
 *    {campaigns}/{id}/events/{machine}/{eventId}.json (create exclusif 'wx',
 *    jamais réécrits, agrégés par machine à la lecture). Deux confirmations
 *    simultanées (machines différentes OU sessions du même hôte) ne peuvent
 *    PAS s'effacer l'une l'autre — il n'y a plus de read-modify-write partagé
 *    sur la preuve participant.
 *  - Mutations coordinateur : dispatches/reminders/close = opérations du
 *    PROPRIÉTAIRE (createdBy) uniquement, sérialisées par un verrou
 *    exclusive-create local ({campaigns}/{id}.lock) + jeton de concurrence
 *    optimiste (rev) en point de contrôle. Un exclusive-create sur DriveFS
 *    asynchronement répliqué n'est PAS un verrou distribué : il sérialise les
 *    sessions du MÊME hôte (FS local cohérent) ; la contention inter-hôtes est
 *    prévenue par l'ownership (un seul propriétaire) et documentée comme
 *    best-effort. Aucune promesse de single-writer distribué.
 *  - Aucun daemon/cron : `remind` est appelé par le coordinateur sur sa cadence.
 *
 * Persistance : fichier JSON par campagne sous {shared}/harmonization/campaigns/,
 * write atomique (tmp+rename) avec relecture. Fail closed : racine shared
 * absente => erreur, pas de mode dégradé.
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger, Logger } from '../utils/logger.js';
import {
  CanonPayload,
  validateCanon,
  hashProjection,
  applyCanonToFile,
  ApplyCanonResult,
  readClaudeSettingsFile,
  isAllowedKeyPath,
  findLatestClaudeSettingsSnapshot,
} from './ClaudeSettingsService.js';

const logger: Logger = createLogger('HarmonizationCampaign');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class HarmonizationCampaignError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
    this.name = 'HarmonizationCampaignError';
  }
}

export type CampaignTargetFile = 'claude-settings';

export interface CampaignDispatchEntry {
  at: string;
  messageId: string;
}

export interface CampaignReminderEntry {
  at: string;
  messageId: string;
}

/** Confirmation immuable (événement) — jamais réécrite (append-only). */
export interface CampaignConfirmedObservation {
  kind: 'confirm';
  machine: string;
  at: string;
  canonHash: string;
  observedHash: string;
  source: 'live-read';
  eventId: string;
}

/** Échec immuable (événement) — jamais réécrit (append-only). */
export interface CampaignFailedObservation {
  kind: 'failed';
  machine: string;
  at: string;
  reason: string;
  observedHash?: string;
  claimed?: boolean;
  eventId: string;
}

export type CampaignObservation = CampaignConfirmedObservation | CampaignFailedObservation;

/** Entrée d'écriture : un événement sans son identifiant (généré à l'écriture). */
export type WriteObservationInput =
  | Omit<CampaignConfirmedObservation, 'eventId'>
  | Omit<CampaignFailedObservation, 'eventId'>;

/** Confirmation dérivée (agrégée) d'un événement 'confirm' — à la lecture. */
export interface CampaignConfirmation {
  machine: string;
  confirmedAt: string;
  canonHash: string;
  observedHash: string;
  provenance: 'live-read';
  eventId: string;
}

export interface HarmonizationCampaignRecord {
  id: string;
  targetFile: CampaignTargetFile;
  createdAt: string;
  createdBy: string;
  canon: CanonPayload & { hash: string };
  /** Entrées 'machine' ou 'machine:workspace'. */
  fleet: string[];
  /** machineId => chemins exemptés pour cette machine. */
  exceptions: Record<string, string[]>;
  /** recipient (full id) => dernier dispatch réussi (état coordinateur). */
  dispatches: Record<string, CampaignDispatchEntry>;
  /** machineId => relances envoyées avec succès (état coordinateur). */
  reminders: Record<string, CampaignReminderEntry[]>;
  status: 'active' | 'closed';
  closedAt?: string;
  closeReason?: string;
  /** Jeton de concurrence optimiste (mutations coordinateur, CAS single-writer). */
  rev: number;
}

export type SendMessageFn = (
  from: string,
  to: string,
  subject: string,
  body: string,
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
  tags?: string[],
  threadId?: string
) => Promise<{ id: string }>;

export interface CampaignServiceDeps {
  sharedStatePath: string;
  /** machineId local (confirmations/apply opèrent TOUJOURS en local). */
  machineId: string;
  /** Chemin du settings.json local (injectable — tests). */
  settingsPath: string;
  /** Émetteur des DM (full id 'machine:workspace'). */
  fromFullId: string;
  sendMessage: SendMessageFn;
  /** Horloge injectable (tests). */
  now?: () => Date;
  /** Générateur d'ID d'événement (immutable, unique) — injectable (tests déterministes). Default: randomUUID. */
  eventIdGen?: () => string;
}

export interface CreateCampaignInput {
  targetFile: CampaignTargetFile;
  canon: CanonPayload;
  fleet: string[];
  exceptions?: Record<string, string[]>;
}

/** État disjoint courant d'une machine (close gating). Une et une seule valeur. */
export type MachineState =
  | 'confirmed'           // preuve fraîche (confirm live-read) ET courant aligné (evidence récente)
  | 'aligned-unconfirmed' // courant aligné mais pas de preuve fraîche
  | 'drifted'             // evidence courante diverge du canon
  | 'missing'             // fichier local absent (machine locale)
  | 'unreadable'          // fichier local illisible (machine locale)
  | 'no-snapshot'         // distant : aucun snapshot publié
  | 'snapshot-stale'      // distant : snapshot antérieur à la confirmation (live inconnu)
  | 'stale-canon';        // confirmation liée à un canon d'une autre version

export interface MachineCampaignStatus {
  recipient: string;
  dispatched: boolean;
  lastDispatchAt?: string;
  confirmationState: 'none' | 'confirmed' | 'stale-canon' | 'mismatch-latest';
  confirmedAt?: string;
  lastFailedAttempt?: CampaignFailedObservation;
  /** Alignment vs canon au moment de l'évaluation (live local / snapshot distant). */
  alignment: 'aligned' | 'drifted' | 'missing' | 'unreadable' | 'no-snapshot' | 'snapshot-stale';
  alignmentDetail?: string;
  /** État disjoint courant (autoritaire pour le close gating). */
  state: MachineState;
  reminderCount: number;
  lastReminderAt?: string;
}

export interface CampaignStatusResult {
  campaign: HarmonizationCampaignRecord;
  machines: MachineCampaignStatus[];
  summary: {
    fleet: number;
    confirmed: number;
    pending: number;
    drifted: number;
    unknown: number;
    allConfirmed: boolean;
  };
}

export interface CampaignExemptionsResult {
  /** Exemptions effectives par machine (chemin exempté ET non requis par une campagne active). */
  byMachine: Record<string, string[]>;
  /** Conflits explicites : chemin exempté par une campagne mais REQUIS (dans un canon) par une autre. */
  conflicts: Array<{ machine: string; path: string; exemptedBy: string[]; requiredBy: string[] }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hash d'une carte harmonisation {path: value} après filtrage des exemptés. */
export function hashHarmonizationMap(
  map: Record<string, unknown>,
  exemptedPaths: string[] = []
): string {
  const exempt = new Set(exemptedPaths);
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(map).sort()) {
    if (exempt.has(k)) continue;
    filtered[k] = map[k];
  }
  return hashProjection(filtered);
}

function campaignIdFor(targetFile: CampaignTargetFile, version: string): string {
  const slug = version.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unversioned';
  return `hc-${targetFile}-${slug}`;
}

function stableJson(obj: unknown): string {
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HarmonizationCampaignService {
  private readonly campaignsDir: string;
  private readonly now: () => Date;
  private readonly eventIdGen: () => string;

  /**
   * Exemptions des campagnes ACTIVES pour un fichier cible, avec provenance et
   * détection de conflit (#3545 défaut review #5) : un chemin exempté par une
   * campagne mais REQUIS par une autre (dans son canon) n'est PAS une exemption
   * effective — il apparaît en `conflicts` pour être exposé, jamais silencieusement
   * supprimé du compare. Best-effort : toute campagne illisible est ignorée.
   */
  static async loadActiveExceptions(
    sharedStatePath: string,
    targetFile: CampaignTargetFile
  ): Promise<CampaignExemptionsResult> {
    const dir = join(sharedStatePath, 'harmonization', 'campaigns');
    const exempts: Array<{ campaign: string; exceptions: Record<string, string[]>; required: Set<string> }> = [];
    if (!existsSync(dir)) return { byMachine: {}, conflicts: [] };
    try {
      const entries = await fs.readdir(dir);
      for (const e of entries) {
        if (!e.endsWith('.json') || e.includes('.tmp-')) continue;
        try {
          const rec = JSON.parse(await fs.readFile(join(dir, e), 'utf-8')) as HarmonizationCampaignRecord;
          if (rec.targetFile !== targetFile || rec.status !== 'active') continue;
          exempts.push({
            campaign: rec.id,
            exceptions: rec.exceptions || {},
            required: new Set(Object.keys(rec.canon?.keys || {})),
          });
        } catch { /* campagne illisible — ignorée */ }
      }
    } catch { /* répertoire illisible — ignoré */ }

    // Chemins requis par AU MOINS UNE campagne active.
    const requiredAnywhere = new Set<string>();
    for (const c of exempts) for (const p of c.required) requiredAnywhere.add(p);

    // Agrège les exemptions par (machine,path) avec leur provenance.
    const machineExemptions: Record<string, Array<{ path: string; campaigns: string[] }>> = {};
    for (const c of exempts) {
      for (const [machine, paths] of Object.entries(c.exceptions)) {
        for (const p of paths) {
          const list = (machineExemptions[machine] = machineExemptions[machine] || []);
          const entry = list.find(x => x.path === p);
          if (entry) entry.campaigns.push(c.campaign);
          else list.push({ path: p, campaigns: [c.campaign] });
        }
      }
    }

    const byMachine: Record<string, string[]> = {};
    const conflicts: CampaignExemptionsResult['conflicts'] = [];
    for (const [machine, entries] of Object.entries(machineExemptions)) {
      for (const { path, campaigns } of entries) {
        if (requiredAnywhere.has(path)) {
          const requiredBy = exempts.filter(x => x.required.has(path)).map(x => x.campaign);
          conflicts.push({ machine, path, exemptedBy: campaigns, requiredBy });
        } else {
          byMachine[machine] = [...new Set([...(byMachine[machine] || []), path])];
        }
      }
    }
    return { byMachine, conflicts };
  }

  constructor(private readonly deps: CampaignServiceDeps) {
    this.campaignsDir = join(deps.sharedStatePath, 'harmonization', 'campaigns');
    this.now = deps.now || (() => new Date());
    this.eventIdGen = deps.eventIdGen || (() => randomUUID());
  }

  // ------------------------------------------------------------- persistance

  private campaignPath(id: string): string {
    // id vient de nous ou est validé (pattern hc-...), pas de traversal
    if (!/^hc-[a-z0-9._-]+$/i.test(id)) {
      throw new HarmonizationCampaignError(`id de campagne invalide: ${id}`, 'INVALID_CAMPAIGN_ID');
    }
    return join(this.campaignsDir, `${id}.json`);
  }

  private async load(id: string): Promise<HarmonizationCampaignRecord> {
    const path = this.campaignPath(id);
    if (!existsSync(path)) {
      throw new HarmonizationCampaignError(
        `Campagne introuvable: ${id} (${path}). Fail closed — vérifier ROOSYNC_SHARED_PATH.`,
        'CAMPAIGN_NOT_FOUND',
        { id, path }
      );
    }
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const rec = JSON.parse(raw) as HarmonizationCampaignRecord;
      if (typeof rec.rev !== 'number') rec.rev = 0; // tolère les anciens enregistrements
      return rec;
    } catch (err) {
      throw new HarmonizationCampaignError(
        `Campagne illisible: ${id} — ${err instanceof Error ? err.message : String(err)}`,
        'CAMPAIGN_CORRUPT',
        { id }
      );
    }
  }

  /** Création exclusive (O_EXCL) — deux creates simultanés ne passent pas tous les deux. */
  private async saveNew(record: HarmonizationCampaignRecord): Promise<void> {
    await fs.mkdir(this.campaignsDir, { recursive: true });
    const path = this.campaignPath(record.id);
    const payload = stableJson(record);
    let handle;
    try {
      handle = await fs.open(path, 'wx');
    } catch {
      throw new HarmonizationCampaignError(
        `Campagne ${record.id} existe déjà — le canon est immuable : bump de version pour changer (#3545).`,
        'CANON_IMMUTABLE',
        { id: record.id }
      );
    }
    try {
      await handle.writeFile(payload, 'utf-8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Write atomique (tmp+rename) avec verrou d'optimisme (rev) + relecture.
   * Le point de contrôle `rev` est adjacent à un verrou exclusive-create posé
   * par l'appelant (mutations coordinateur). Si le rev relu diffère de celui
   * attendu, une ConcurrentWriteError est levée : l'appelant relit et rejoue.
   * Aucune promesse de verrou distribué (documenté).
   */
  private async save(record: HarmonizationCampaignRecord, expectedRev: number): Promise<void> {
    const path = this.campaignPath(record.id);
    await fs.mkdir(this.campaignsDir, { recursive: true });
    let currentRev = 0;
    if (existsSync(path)) {
      try {
        const cur = JSON.parse(await fs.readFile(path, 'utf-8')) as { rev?: number };
        currentRev = typeof cur.rev === 'number' ? cur.rev : 0;
      } catch {
        currentRev = -1;
      }
    }
    if (currentRev !== expectedRev) {
      throw new HarmonizationCampaignError(
        `Mutation coordinateur concurrente sur ${record.id} (rev attendu ${expectedRev}, relu ${currentRev}) — recharger et rejouer.`,
        'CONCURRENT_WRITE',
        { id: record.id, expectedRev, currentRev }
      );
    }
    const next = { ...record, rev: expectedRev + 1 };
    const payload = stableJson(next);
    const tmp = `${path}.tmp-${process.pid}-${this.now().getTime()}-${this.eventIdGen().slice(0, 6)}`;
    await fs.writeFile(tmp, payload, 'utf-8');
    await fs.rename(tmp, path);
    const reread = JSON.parse(await fs.readFile(path, 'utf-8')) as { rev?: number };
    if (reread.rev !== expectedRev + 1) {
      throw new HarmonizationCampaignError(
        `Mutation coordinateur concurrente détectée sur ${record.id} (relecture ≠ écrit) — recharger et rejouer.`,
        'CONCURRENT_WRITE',
        { id: record.id }
      );
    }
  }

  /** Verrou exclusive-create pour sérialiser les mutations coordinator du même hôte. */
  private async acquireCoordinatorLock(id: string): Promise<() => Promise<void>> {
    await fs.mkdir(this.campaignsDir, { recursive: true });
    const lockPath = join(this.campaignsDir, `${id}.lock`);
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch {
      throw new HarmonizationCampaignError(
        `Opération coordinateur concurrente sur ${id} (verrou ${id}.lock présent — une autre session du propriétaire agit) — relire et rejouer.`,
        'CONCURRENT_WRITE',
        { id }
      );
    }
    return async () => {
      try { await handle.close(); } catch { /* déjà fermé */ }
      try { await fs.unlink(lockPath); } catch { /* déjà supprimé */ }
    };
  }

  private assertOwner(record: HarmonizationCampaignRecord): void {
    if (record.createdBy !== this.deps.machineId) {
      throw new HarmonizationCampaignError(
        `Opération refusée : la campagne ${record.id} appartient à ${record.createdBy}, pas à ${this.deps.machineId}. Seul le propriétaire exécute les mutations (dispatch/remind/close).`,
        'NOT_OWNER',
        { id: record.id, createdBy: record.createdBy, machineId: this.deps.machineId }
      );
    }
  }

  // ------------------------------------------------- preuve participant (immutable)

  private eventsDir(id: string): string {
    return join(this.campaignsDir, id, 'events');
  }

  private machineEventsDir(id: string, machine: string): string {
    return join(this.eventsDir(id), machine);
  }

  private async writeObservation(id: string, obs: WriteObservationInput): Promise<void> {
    const eventId = this.eventIdGen();
    if (!eventId || eventId.includes('/') || eventId.includes('\\')) {
      throw new HarmonizationCampaignError('eventId invalide (chemin interdit)', 'INVALID_EVENT_ID', { eventId });
    }
    const payload = stableJson({ ...obs, eventId });
    const dir = this.machineEventsDir(id, obs.machine);
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${eventId}.json`);
    let handle;
    try {
      handle = await fs.open(path, 'wx'); // create exclusif — jamais d'écrasement
    } catch {
      throw new HarmonizationCampaignError(
        `Événement collision pour ${id}/${obs.machine}/${eventId} — régénérer un identifiant.`,
        'EVENT_COLLISION',
        { id, machine: obs.machine, eventId }
      );
    }
    try {
      await handle.writeFile(payload, 'utf-8');
    } finally {
      await handle.close();
    }
  }

  private async loadObservations(id: string, machine: string): Promise<CampaignObservation[]> {
    const dir = this.machineEventsDir(id, machine);
    if (!existsSync(dir)) return [];
    const out: CampaignObservation[] = [];
    try {
      const entries = await fs.readdir(dir);
      for (const e of entries) {
        if (!e.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(await fs.readFile(join(dir, e), 'utf-8')) as CampaignObservation);
        } catch { /* événement illisible — immutable : ignoré, ne bloque pas */ }
      }
    } catch {
      return [];
    }
    return out.sort(
      (a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId)
    );
  }

  private async latestConfirmation(record: HarmonizationCampaignRecord, machine: string): Promise<CampaignConfirmation | undefined> {
    const events = await this.loadObservations(record.id, machine);
    const confirms = events.filter(e => e.kind === 'confirm') as CampaignConfirmedObservation[];
    if (confirms.length === 0) return undefined;
    const last = confirms[confirms.length - 1];
    return {
      machine,
      confirmedAt: last.at,
      canonHash: last.canonHash,
      observedHash: last.observedHash,
      provenance: 'live-read',
      eventId: last.eventId,
    };
  }

  private async hasValidConfirmation(record: HarmonizationCampaignRecord, machine: string): Promise<boolean> {
    const c = await this.latestConfirmation(record, machine);
    return !!c && c.canonHash === record.canon.hash && c.provenance === 'live-read';
  }

  private async lastFailedAttempt(record: HarmonizationCampaignRecord, machine: string): Promise<CampaignFailedObservation | undefined> {
    const events = await this.loadObservations(record.id, machine);
    const fails = events.filter(e => e.kind === 'failed') as CampaignFailedObservation[];
    return fails.length > 0 ? fails[fails.length - 1] : undefined;
  }

  private async machineIds(record: HarmonizationCampaignRecord): Promise<Set<string>> {
    return new Set(record.fleet.map(e => e.split(':')[0]));
  }

  // ------------------------------------------------------------------ create

  async createCampaign(input: CreateCampaignInput): Promise<HarmonizationCampaignRecord> {
    if (input.targetFile !== 'claude-settings') {
      throw new HarmonizationCampaignError(
        `targetFile non supporté: ${input.targetFile} (seul 'claude-settings' est couvert, #3545)`,
        'UNSUPPORTED_TARGET_FILE'
      );
    }
    const validation = validateCanon(input.canon);
    if (!validation.valid || !validation.canonHash) {
      throw new HarmonizationCampaignError(
        `Canon invalide: ${validation.problems.join(' ; ')}`,
        'INVALID_CANON',
        { problems: validation.problems }
      );
    }
    if (!Array.isArray(input.fleet) || input.fleet.length === 0) {
      throw new HarmonizationCampaignError('fleet requis (au moins une machine)', 'INVALID_FLEET');
    }
    const seen = new Set<string>();
    for (const entry of input.fleet) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(entry)) {
        throw new HarmonizationCampaignError(
          `Entrée fleet invalide: "${entry}" (attendu machine ou machine:workspace)`,
          'INVALID_FLEET',
          { entry }
        );
      }
      if (seen.has(entry)) {
        throw new HarmonizationCampaignError(`Doublon fleet: ${entry}`, 'INVALID_FLEET', { entry });
      }
      seen.add(entry);
    }
    const fleetMachines = new Set(input.fleet.map(e => e.split(':')[0]));
    const exceptions: Record<string, string[]> = {};
    for (const [machine, paths] of Object.entries(input.exceptions || {})) {
      if (!fleetMachines.has(machine)) {
        throw new HarmonizationCampaignError(
          `Exception pour une machine hors fleet: ${machine}`,
          'INVALID_EXCEPTIONS',
          { machine }
        );
      }
      for (const p of paths) {
        if (!isAllowedKeyPath(p)) {
          throw new HarmonizationCampaignError(
            `Chemin d'exception non allow-listé: ${p} (machine ${machine})`,
            'INVALID_EXCEPTIONS',
            { machine, path: p }
          );
        }
      }
      exceptions[machine] = [...paths];
    }

    const id = campaignIdFor(input.targetFile, input.canon.version);
    const record: HarmonizationCampaignRecord = {
      id,
      targetFile: input.targetFile,
      createdAt: this.now().toISOString(),
      createdBy: this.deps.machineId,
      canon: { ...input.canon, hash: validation.canonHash },
      fleet: [...input.fleet],
      exceptions,
      dispatches: {},
      reminders: {},
      status: 'active',
      rev: 0,
    };
    await this.saveNew(record);
    logger.info(`Campagne créée: ${id} (canon hash ${validation.canonHash.slice(0, 8)}, fleet ${record.fleet.length})`);
    return record;
  }

  async getCampaign(id: string): Promise<HarmonizationCampaignRecord> {
    return this.load(id);
  }

  async listCampaigns(includeClosed = false): Promise<HarmonizationCampaignRecord[]> {
    if (!existsSync(this.campaignsDir)) return [];
    const entries = await fs.readdir(this.campaignsDir);
    const records: HarmonizationCampaignRecord[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json') || e.includes('.tmp-')) continue;
      try {
        const rec = JSON.parse(await fs.readFile(join(this.campaignsDir, e), 'utf-8')) as HarmonizationCampaignRecord;
        if (!includeClosed && rec.status === 'closed') continue;
        if (typeof rec.rev !== 'number') rec.rev = 0;
        records.push(rec);
      } catch {
        logger.warn(`Campagne illisible ignorée: ${e}`);
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------------------------------------------------------------- dispatch

  private buildDispatchBody(record: HarmonizationCampaignRecord, recipient: string): string {
    const machine = recipient.split(':')[0];
    const exceptions = record.exceptions[machine] || [];
    const keys = Object.entries(record.canon.keys)
      .map(([p, v]) => `- \`${p}\` = \`${typeof v === 'string' ? v : JSON.stringify(v)}\``)
      .join('\n');
    const exemptLine = exceptions.length > 0
      ? `\nChemins EXEMPTÉS pour ${machine} (à ignorer) : ${exceptions.join(', ')}`
      : '';
    return `# Harmonisation ${record.targetFile} — canon v${record.canon.version}

Campagne: \`${record.id}\` — créée par ${record.createdBy} le ${record.createdAt}.
Canon hash: \`${record.canon.hash}\`
Mode: **${record.canon.mode}** (${record.canon.mode === 'ensure-present' ? 'les clés déjà présentes chez toi sont préservées' : 'les valeurs listées sont imposées'})

## Clés du canon
${keys}
${exemptLine}

## Actions attendues (sur ta machine)
1. Simuler : \`roosync_harmonization(action: "apply", campaign_id: "${record.id}", dry_run: true)\`
2. Appliquer : \`roosync_harmonization(action: "apply", campaign_id: "${record.id}")\`
3. Confirmer (relit ton settings.json en live, atteste le hash) : \`roosync_harmonization(action: "confirm", campaign_id: "${record.id}")\`

Aucune clé hors de la liste n'est touchée. permissions/hooks/credentials : intouchables.
`;
  }

  async dispatch(
    id: string,
    options: { force?: boolean } = {}
  ): Promise<{ sent: Array<{ to: string; messageId: string }>; skipped: Array<{ to: string; reason: string }>; failures: Array<{ to: string; error: string }> }> {
    const release = await this.acquireCoordinatorLock(id);
    try {
      const record = await this.load(id);
      if (record.status === 'closed') {
        throw new HarmonizationCampaignError(`Campagne ${id} fermée — dispatch refusé.`, 'CAMPAIGN_CLOSED');
      }
      this.assertOwner(record);
      const sent: Array<{ to: string; messageId: string }> = [];
      const skipped: Array<{ to: string; reason: string }> = [];
      const failures: Array<{ to: string; error: string }> = [];

      for (const recipient of record.fleet) {
        if (!options.force && record.dispatches[recipient]) {
          skipped.push({ to: recipient, reason: 'déjà dispatché (force=true pour renvoyer)' });
          continue;
        }
        const subject = `[HARMONIZATION] ${id} — appliquer le canon v${record.canon.version}`;
        try {
          const msg = await this.deps.sendMessage(
            this.deps.fromFullId,
            recipient,
            subject,
            this.buildDispatchBody(record, recipient),
            'HIGH',
            ['HARMONIZATION', 'TASK', `campaign:${id}`],
            id
          );
          record.dispatches[recipient] = { at: this.now().toISOString(), messageId: msg.id };
          sent.push({ to: recipient, messageId: msg.id });
        } catch (err) {
          // Échec d'envoi : NON enregistré comme dispatché — rejouable.
          failures.push({ to: recipient, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (sent.length > 0) await this.save(record, record.rev);
      return { sent, skipped, failures };
    } finally {
      await release();
    }
  }

  // ----------------------------------------------------------------- remind

  /**
   * Hash attendu POUR UNE MACHINE : canon privé des chemins exemptés de cette
   * machine. Une machine exemptée compare sa projection (elle-même exemptée)
   * à ce hash — sinon elle ne pourrait jamais confirmer.
   */
  private canonHashForMachine(record: HarmonizationCampaignRecord, machine: string): string {
    const exceptions = record.exceptions[machine] || [];
    const exempt = new Set(exceptions);
    const projection: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(record.canon.keys)) {
      if (exempt.has(path)) continue;
      projection[path] = value;
    }
    return hashProjection(projection);
  }

  /**
   * Projection OBSERVÉE restreinte au périmètre des clés du canon (hors
   * exemptions). Les clés allow-listées hors canon (ex: `model` si le canon
   * n'en parle pas) sont le choix de la machine : elles ne doivent NI faire
   * échouer la confirmation, NI apparaître comme drift.
   */
  private observedOverCanonScope(
    record: HarmonizationCampaignRecord,
    machine: string,
    readSettings: Record<string, unknown>
  ): Record<string, unknown> {
    const exceptions = record.exceptions[machine] || [];
    const exempt = new Set(exceptions);
    const observed: Record<string, unknown> = {};
    for (const path of Object.keys(record.canon.keys)) {
      if (exempt.has(path)) continue;
      const segs = path.split('.');
      let cur: unknown = readSettings;
      for (const s of segs) {
        if (cur === null || typeof cur !== 'object') { cur = undefined; break; }
        cur = (cur as Record<string, unknown>)[s];
      }
      if (cur !== undefined) observed[path] = cur;
    }
    return observed;
  }

  async remind(
    id: string,
    options: { cooldownHours?: number; force?: boolean } = {}
  ): Promise<{ sent: Array<{ to: string; messageId: string }>; skipped: Array<{ to: string; reason: string }>; failures: Array<{ to: string; error: string }> }> {
    const release = await this.acquireCoordinatorLock(id);
    try {
      const record = await this.load(id);
      if (record.status === 'closed') {
        throw new HarmonizationCampaignError(`Campagne ${id} fermée — relance refusée.`, 'CAMPAIGN_CLOSED');
      }
      this.assertOwner(record);
      const cooldownMs = (options.cooldownHours ?? 12) * 60 * 60 * 1000;
      const nowMs = this.now().getTime();
      const sent: Array<{ to: string; messageId: string }> = [];
      const skipped: Array<{ to: string; reason: string }> = [];
      const failures: Array<{ to: string; error: string }> = [];

      for (const recipient of record.fleet) {
        const machine = recipient.split(':')[0];
        if (await this.hasValidConfirmation(record, machine)) {
          skipped.push({ to: recipient, reason: 'confirmé' });
          continue;
        }
        const history = record.reminders[machine] || [];
        if (!options.force && history.length > 0) {
          const last = history[history.length - 1];
          const lastMs = Date.parse(last.at);
          if (Number.isFinite(lastMs) && nowMs - lastMs < cooldownMs) {
            skipped.push({ to: recipient, reason: `relance < cooldown (${options.cooldownHours ?? 12}h)` });
            continue;
          }
        }
        const failCount = (await this.loadObservations(record.id, machine)).filter(e => e.kind === 'failed').length;
        const subject = `[HARMONIZATION] Rappel — ${id} en attente de ta confirmation`;
        const body = `Relance de la campagne \`${record.id}\` (canon v${record.canon.version}).
Ta machine n'a pas encore de confirmation valide (tentatives échouées: ${failCount}).
Applique puis confirme :
1. \`roosync_harmonization(action: "apply", campaign_id: "${record.id}")\`
2. \`roosync_harmonization(action: "confirm", campaign_id: "${record.id}")\`
`;
        try {
          const msg = await this.deps.sendMessage(
            this.deps.fromFullId,
            recipient,
            subject,
            body,
            'MEDIUM',
            ['HARMONIZATION', 'TASK', `campaign:${id}`, 'REMINDER'],
            id
          );
          history.push({ at: this.now().toISOString(), messageId: msg.id });
          record.reminders[machine] = history;
          sent.push({ to: recipient, messageId: msg.id });
        } catch (err) {
          // Échec : pas enregistré — la prochaine relance repartira du dernier SUCCÈS.
          failures.push({ to: recipient, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (sent.length > 0) await this.save(record, record.rev);
      return { sent, skipped, failures };
    } finally {
      await release();
    }
  }

  // ---------------------------------------------------------------- confirm

  /**
   * Confirme DEPUIS la machine cible elle-même : relit le settings.json LOCAL
   * en live, projette (hors exceptions locales), compare au hash canon.
   * Un `claimedHash` fourni par l'appelant n'est jamais compté comme
   * confirmation — seulement consigné en échec si le live diverge.
   *
   * Aucune mutation du record partagé : écrit UNIQUEMENT un événement immuable.
   * Donc deux confirmations simultanées (machines différentes ou sessions d'un
   * même hôte) ne peuvent pas s'effacer l'une l'autre (#3545 défaut #2).
   */
  async confirm(
    id: string,
    options: { claimedHash?: string } = {}
  ): Promise<{ status: 'confirmed' | 'mismatch' | 'unreadable'; observedHash?: string; detail: string }> {
    const record = await this.load(id);
    const machine = this.deps.machineId;

    const read = await readClaudeSettingsFile(this.deps.settingsPath);
    if (read.state === 'missing' || read.state === 'invalid') {
      await this.writeObservation(id, {
        kind: 'failed',
        machine,
        at: this.now().toISOString(),
        reason: `settings.json ${read.state} (${read.error || 'fichier absent'})`,
      });
      return { status: 'unreadable', detail: `settings.json local ${read.state} — apply requis avant confirmation` };
    }

    const observed = hashProjection(this.observedOverCanonScope(record, machine, read.settings));
    const expected = this.canonHashForMachine(record, machine);

    if (observed === expected) {
      await this.writeObservation(id, {
        kind: 'confirm',
        machine,
        at: this.now().toISOString(),
        canonHash: record.canon.hash,
        observedHash: observed,
        source: 'live-read',
      });
      return { status: 'confirmed', observedHash: observed, detail: 'projection live conforme au canon' };
    }

    await this.writeObservation(id, {
      kind: 'failed',
      machine,
      at: this.now().toISOString(),
      reason: 'projection live diverge du canon',
      observedHash: observed,
      claimed: !!options.claimedHash,
    });
    return {
      status: 'mismatch',
      observedHash: observed,
      detail: options.claimedHash
        ? 'claimedHash fourni MAIS la relecture live diverge — claim non enregistré comme confirmation'
        : 'projection live diverge du canon — (re)appliquer puis reconfirmer',
    };
  }

  // ------------------------------------------------------------------ apply

  async apply(
    id: string,
    options: { dryRun?: boolean; backup?: boolean } = {}
  ): Promise<ApplyCanonResult> {
    const record = await this.load(id);
    const machine = this.deps.machineId;
    const exceptions = record.exceptions[machine] || [];
    const { hash: _hash, ...canonPayload } = record.canon;
    return applyCanonToFile(this.deps.settingsPath, canonPayload as CanonPayload, {
      dryRun: options.dryRun,
      backup: options.backup,
      exemptedPaths: exceptions,
      now: () => this.now().toISOString(),
    });
  }

  // ----------------------------------------------------------------- status

  private disjointState(
    confirmationState: MachineCampaignStatus['confirmationState'],
    alignment: MachineCampaignStatus['alignment']
  ): MachineState {
    if (confirmationState === 'stale-canon') return 'stale-canon';
    switch (alignment) {
      case 'drifted': return 'drifted';
      case 'missing': return 'missing';
      case 'unreadable': return 'unreadable';
      case 'no-snapshot': return 'no-snapshot';
      case 'snapshot-stale': return 'snapshot-stale';
      case 'aligned':
        return confirmationState === 'confirmed' ? 'confirmed' : 'aligned-unconfirmed';
      default:
        return 'no-snapshot';
    }
  }

  async status(id: string): Promise<CampaignStatusResult> {
    const record = await this.load(id);
    const machines: MachineCampaignStatus[] = [];

    for (const recipient of record.fleet) {
      const machine = recipient.split(':')[0];
      const dispatch = record.dispatches[recipient];
      const confirmation = await this.latestConfirmation(record, machine);
      const lastFailed = await this.lastFailedAttempt(record, machine);

      let confirmationState: MachineCampaignStatus['confirmationState'] = 'none';
      if (confirmation) {
        if (confirmation.canonHash !== record.canon.hash) confirmationState = 'stale-canon';
        else confirmationState = 'confirmed';
      }

      // Alignment : live pour la machine locale, snapshot publié pour les autres.
      let alignment: MachineCampaignStatus['alignment'] = 'no-snapshot';
      let alignmentDetail: string | undefined;
      const exceptions = record.exceptions[machine] || [];

      if (machine === this.deps.machineId) {
        const read = await readClaudeSettingsFile(this.deps.settingsPath);
        if (read.state === 'invalid') {
          alignment = 'unreadable';
          alignmentDetail = read.error;
        } else if (read.state === 'missing') {
          alignment = 'missing';
        } else {
          const observed = hashProjection(this.observedOverCanonScope(record, machine, read.settings));
          alignment = observed === this.canonHashForMachine(record, machine) ? 'aligned' : 'drifted';
        }
      } else {
        const snap = await findLatestClaudeSettingsSnapshot(this.deps.sharedStatePath, machine);
        if (snap.found && snap.snapshot) {
          const restricted: Record<string, unknown> = {};
          for (const p of Object.keys(record.canon.keys)) {
            if (exceptions.includes(p)) continue;
            const v = snap.snapshot.harmonization[p];
            if (v !== undefined) restricted[p] = v;
          }
          const observed = hashProjection(restricted);
          if (observed === this.canonHashForMachine(record, machine)) {
            alignment = 'aligned';
            if (confirmation && snap.snapshot.collectedAt && confirmation.confirmedAt && snap.snapshot.collectedAt < confirmation.confirmedAt) {
              alignment = 'snapshot-stale';
              alignmentDetail = `snapshot ${snap.snapshot.collectedAt} antérieur à la confirmation ${confirmation.confirmedAt} — live distant inconnu`;
            }
          } else {
            alignment = 'drifted';
            alignmentDetail = `snapshot du ${snap.snapshot.collectedAt} diverge du canon`;
          }
        } else {
          alignment = 'no-snapshot';
          alignmentDetail = 'aucun snapshot claude-settings publié par cette machine';
        }
      }

      // drift courant => la confirmation devient mismatch-latest (déjà dérivée).
      if (confirmationState === 'confirmed' && alignment === 'drifted') confirmationState = 'mismatch-latest';

      const state = this.disjointState(confirmationState, alignment);
      const reminders = record.reminders[machine] || [];
      machines.push({
        recipient,
        dispatched: !!dispatch,
        lastDispatchAt: dispatch?.at,
        confirmationState,
        confirmedAt: confirmation?.confirmedAt,
        lastFailedAttempt: lastFailed,
        alignment,
        alignmentDetail,
        state,
        reminderCount: reminders.length,
        lastReminderAt: reminders[reminders.length - 1]?.at,
      });
    }

    const confirmed = machines.filter(m => m.state === 'confirmed').length;
    const drifted = machines.filter(m => m.state === 'drifted' || m.state === 'stale-canon').length;
    const unknown = machines.filter(m =>
      m.state === 'no-snapshot' || m.state === 'unreadable' || m.state === 'missing' || m.state === 'snapshot-stale'
    ).length;
    return {
      campaign: record,
      machines,
      summary: {
        fleet: machines.length,
        confirmed,
        pending: machines.length - confirmed,
        drifted,
        unknown,
        allConfirmed: confirmed === machines.length,
      },
    };
  }

  // ------------------------------------------------------------------ close

  async close(
    id: string,
    options: { force?: boolean; reason?: string } = {}
  ): Promise<HarmonizationCampaignRecord> {
    const release = await this.acquireCoordinatorLock(id);
    try {
      const record = await this.load(id);
      if (record.status === 'closed') {
        throw new HarmonizationCampaignError(`Campagne ${id} déjà fermée.`, 'CAMPAIGN_CLOSED');
      }
      this.assertOwner(record);
      const st = await this.status(id);
      // #3545 défaut #3 : le close ordinaire exige une preuve FRAÎCHE par machine.
      // Une confirmation historique ne compte plus si l'état courant est
      // drifté/missing/unreadable/no-snapshot/snapshot-stale (états disjoints).
      if (!st.summary.allConfirmed && !(options.force && options.reason)) {
        throw new HarmonizationCampaignError(
          `Fermeture refusée : ${st.summary.confirmed}/${st.summary.fleet} machines dans un état confirmé frais (${st.machines.map(m => `${m.recipient}:${m.state}`).join(', ')}). ` +
          `force=true + reason requis pour fermer malgré les manquantes.`,
          'CLOSE_PRECONDITION_FAILED',
          { confirmed: st.summary.confirmed, fleet: st.summary.fleet, states: st.machines.map(m => m.state) }
        );
      }
      record.status = 'closed';
      record.closedAt = this.now().toISOString();
      record.closeReason = options.reason || (st.summary.allConfirmed ? 'flotte entièrement confirmée' : undefined);
      await this.save(record, record.rev);
      return record;
    } finally {
      await release();
    }
  }
}
