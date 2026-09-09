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
 *    exclusive-create local ({campaigns}/{id}.lock, métadonnées owner/token/
 *    acquiredAt/expiresAt) + jeton de concurrence optimiste (rev) en point de
 *    contrôle. Le verrou est RÉCUPÉRABLE : un détenteur crashé (kill/OOM, qui
 *    ne passe jamais au finally) ne bloque plus indéfiniment — son lock
 *    périmé (TTL explicite, COORDINATOR_LOCK_TTL_MS) est récupéré À GAGNANT
 *    UNIQUE (détachement rename atomique : un seul récupérateur gagne, les
 *    autres refusent CONCURRENT_WRITE — revue passe 3), et le release
 *    détache-then-vérifie vers une quarantaine à token unique : un détenteur
 *    qui reprend la main NE PEUT PAS supprimer le lock du nouveau détenteur,
 *    y compris si le remplacement survient exactement entre lecture et
 *    suppression (TOCTOU fermé). Un exclusive-create sur DriveFS
 *    asynchronement répliqué n'est PAS un verrou distribué : il sérialise les
 *    sessions du MÊME hôte (FS local cohérent) ; la contention inter-hôtes
 *    est prévenue par l'ownership (un seul propriétaire) et documentée comme
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

/**
 * Péremption EXPLICITE du verrou coordinateur (défaut review #2) : un
 * détenteur crashé (kill/OOM après acquisition) ne bloque plus indéfiniment
 * dispatch/remind/close — son lock devient récupérable après TTL. Généreux :
 * les mutations coordinateur durent des secondes ; 30 min couvre une pause
 * longue sans permettre un vol de lock en cours d'opération.
 */
export const COORDINATOR_LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Métadonnées du verrou coordinateur `{campaigns}/{id}.lock` (défaut review #2) :
 * owner (machine), token unique par acquisition (le release ne supprime QUE le
 * lock qui porte notre token — un détenteur qui reprend la main après crash ne
 * peut pas supprimer le lock du nouveau détenteur), acquiredAt/expiresAt
 * (politique de péremption + récupération).
 */
export interface CoordinatorLock {
  owner: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
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
  /**
   * Seam TEST-ONLY (revue passe 3) : interposé entre la lecture du lock PÉRIMÉ
   * et son détachement — permet de simuler DÉTERMINISTEMENT qu'un autre
   * récupérateur complète sa récupération exactement dans cette fenêtre.
   */
  _testInterposeAfterStaleRead?: () => Promise<void>;
  /**
   * Seam TEST-ONLY (revue passe 3) : interposé entre la lecture du token au
   * release et le détachement — simule un REMPLACEMENT du lock exactement
   * dans la fenêtre lecture→suppression (TOCTOU).
   */
  _testInterposeRelease?: () => Promise<void>;
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
   * PORTÉE RÉELLE du `rev` (revue passe 3, bornée) : c'est un check-then-write
   * NON atomique — deux writers partis du même `rev=N` peuvent TOUS DEUX
   * écrire `rev=N+1` dans la fenêtre lecture→rename (last-writer-wins : la
   * relecture du NUMÉRO ne distingue pas les CONTENUS, une mise à jour peut
   * être perdue). Le `rev` DÉTECTE la divergence (avant et après écriture),
   * il ne l'empêche pas mécaniquement. Ce qui sérialise en pratique : le
   * verrou coordinateur même-hôte (gagnant unique) posé par l'appelant.
   * Inter-hôtes : best-effort documenté, aucune promesse de single-writer
   * distribué.
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

  /**
   * Lit le token d'un fichier lock (null si absent/illisible/token absent).
   */
  private async readLockToken(path: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(path, 'utf-8')) as CoordinatorLock;
      return typeof parsed.token === 'string' ? parsed.token : null;
    } catch {
      return null;
    }
  }

  /**
   * Restaure conditionnellement un lock détaché à tort : `link` est un
   * create-if-absent ATOMIQUE — il ne peut JAMAIS écraser un lock plus récent
   * qui occuperait le chemin. Si le chemin est occupé (EEXIST), le détaché
   * reste en quarantaine comme preuve (jamais supprimé par nous).
   */
  private async restoreQuarantinedLock(quarantinePath: string, lockPath: string): Promise<void> {
    try {
      await fs.link(quarantinePath, lockPath); // atomique, échoue si lockPath existe
      try { await fs.unlink(quarantinePath); } catch { /* best-effort */ }
    } catch {
      logger.warn(
        `Lock détaché à tort non restaurable (${lockPath} occupé) — conservé en quarantaine ${quarantinePath} (preuve, jamais supprimé automatiquement).`
      );
    }
  }

  /**
   * Verrou exclusive-create pour sérialiser les mutations coordinator du même
   * hôte — RÉCUPÉRABLE après crash (défaut review #2) et récupération À
   * GAGNANT UNIQUE (revue passe 3) :
   *  - le lock porte `{owner, token, acquiredAt, expiresAt}` ;
   *  - un lock FRAIS (expiresAt non atteint) => refus CONCURRENT_WRITE ;
   *  - un lock PÉRIMÉ (détenteur crashé) => DÉTACHEMENT par rename vers une
   *    quarantaine `{id}.lock.stale-{tokenPérimé}` : le rename est ATOMIQUE,
   *    UN SEUL récupérateur gagne la course (les autres reçoivent ENOENT =>
   *    refus CONCURRENT_WRITE). Le gagnant VÉRIFIE le contenu détaché :
   *    s'il ne correspond pas au lock périmé lu (un remplacement est survenu
   *    entre lecture et détachement), il est RESTAURÉ par link conditionnel
   *    et nous refusons — jamais supprimé. Seulement après vérification :
   *    suppression de la quarantaine (chemin à token unique) puis open 'wx'
   *    du nouveau lock ; EEXIST => un tiers a pris la place libre => refus.
   *    Un unlink nu (sans rename-gate) laisserait l'entrelacement où le
   *    perdant supprime le lock FRAIS du gagnant puis gagne le wx à son
   *    tour : deux détenteurs. Le rename-gate ferme mécaniquement ce cas.
   *  - release : détachement vers une quarantaine À NOTRE TOKEN UNIQUE puis
   *    vérification — la suppression n'a PLUS de fenêtre TOCTOU (voir
   *    releaseCoordinatorLock).
   * Pas un verrou distribué : exclusive-create/DriveFS asynchrone = best-effort
   * même hôte. Portée RÉELLE du `rev` (documentée, bornée) : save() est un
   * check-then-write NON atomique — deux writers partis du même rev peuvent
   * tous deux écrire rev=N+1 dans la fenêtre lecture→rename (last-writer-wins,
   * perte possible) ; `rev` DÉTECTE la divergence après coup, il ne l'empêche
   * pas. Ce verrou même-hôte est le mécanisme qui sérialise en pratique.
   */
  private async acquireCoordinatorLock(id: string): Promise<() => Promise<void>> {
    await fs.mkdir(this.campaignsDir, { recursive: true });
    const lockPath = join(this.campaignsDir, `${id}.lock`);
    const token = this.eventIdGen();
    const nowMs = this.now().getTime();
    const meta: CoordinatorLock = {
      owner: this.deps.machineId,
      token,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + COORDINATOR_LOCK_TTL_MS).toISOString(),
    };

    let created = false;
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx');
      created = true;
      try {
        await handle.writeFile(stableJson(meta), 'utf-8');
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (created) {
        // Lock créé par nous mais écriture échouée : on en est propriétaire
        // (create exclusif gagné, personne d'autre ne peut créer ce chemin),
        // on le retire pour ne pas laisser un lock vide permanent.
        try { await fs.unlink(lockPath); } catch { /* best-effort */ }
      }
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw err;

      // Lock présent : juger sa fraîcheur — métadonnées si lisibles, sinon
      // mtime du fichier (lock corrompu = vraisemblablement un crash d'écriture).
      let existing: CoordinatorLock | null = null;
      let mtimeMs = 0;
      try {
        const [raw, st] = await Promise.all([fs.readFile(lockPath, 'utf-8'), fs.stat(lockPath)]);
        mtimeMs = st.mtimeMs;
        existing = JSON.parse(raw) as CoordinatorLock;
      } catch { /* illisible — fraîcheur par mtime seule */ }
      const freshUntilMs = existing && typeof existing.expiresAt === 'string' && !Number.isNaN(Date.parse(existing.expiresAt))
        ? Date.parse(existing.expiresAt)
        : mtimeMs + COORDINATOR_LOCK_TTL_MS;
      if (nowMs < freshUntilMs) {
        throw new HarmonizationCampaignError(
          `Opération coordinateur concurrente sur ${id} (verrou ${id}.lock détenu par ${existing?.owner ?? '?'} jusqu'à ${new Date(freshUntilMs).toISOString()} — une autre session du propriétaire agit) — relire et rejouer.`,
          'CONCURRENT_WRITE',
          { id, lockOwner: existing?.owner, expiresAt: existing?.expiresAt }
        );
      }
      // Lock PÉRIMÉ — seam test-only : simule un récupérateur concurrent
      // complétant SA récupération exactement dans la fenêtre lecture→détachement.
      if (this.deps._testInterposeAfterStaleRead) await this.deps._testInterposeAfterStaleRead();

      // Récupération À GAGNANT UNIQUE : le rename est la course atomique.
      const staleToken = existing?.token ?? `corrupt-${mtimeMs}`;
      const quarantine = `${lockPath}.stale-${staleToken}`;
      try {
        await fs.rename(lockPath, quarantine);
      } catch {
        // ENOENT : un autre récupérateur a détaché le lock périmé avant nous.
        throw new HarmonizationCampaignError(
          `Récupération concurrente du verrou ${id}.lock perdue (un autre récupérateur a détaché le lock périmé) — relire et rejouer.`,
          'CONCURRENT_WRITE',
          { id }
        );
      }
      // Vérification du détaché : s'il ne correspond PAS au lock périmé lu,
      // un remplacement est survenu dans la fenêtre — restaurer, refuser.
      const detachedToken = await this.readLockToken(quarantine);
      const detachedMatchesStale = existing
        ? detachedToken === existing.token
        : detachedToken === null; // lock illisible lu ⇒ détaché toujours illisible
      if (!detachedMatchesStale) {
        await this.restoreQuarantinedLock(quarantine, lockPath);
        throw new HarmonizationCampaignError(
          `Récupération du verrou ${id}.lock abandonnée : le lock a été remplacé pendant la récupération (restauré, jamais supprimé) — relire et rejouer.`,
          'CONCURRENT_WRITE',
          { id }
        );
      }
      // Quarantaine vérifiée (chemin à token périmé unique, contenu confirmé) :
      // suppression sans fenêtre — personne d'autre n'écrit ce chemin.
      try { await fs.unlink(quarantine); } catch { /* best-effort */ }

      // Place libre : création exclusive du nouveau lock. EEXIST = un tiers
      // (nouvelle session) a pris la place entre-temps => il détient, nous refusons.
      try {
        const h2 = await fs.open(lockPath, 'wx');
        try {
          await h2.writeFile(stableJson(meta), 'utf-8');
        } finally {
          await h2.close();
        }
      } catch {
        throw new HarmonizationCampaignError(
          `Récupération du verrou ${id}.lock : la place libre a été prise par une autre session — relire et rejouer.`,
          'CONCURRENT_WRITE',
          { id }
        );
      }
    }
    return () => this.releaseCoordinatorLock(lockPath, token);
  }

  /**
   * Libère le verrou coordinateur SANS fenêtre TOCTOU (revue passe 3).
   * L'ancien protocole lecture-token→unlink pouvait supprimer un lock REMPLACÉ
   * entre les deux opérations (récupération survenue dans la fenêtre). Le
   * nouveau protocole ne supprime JAMAIS le chemin vivant :
   *  1. lecture : token ≠ nôtre => no-op (détenu/remplacé par un autre) ;
   *  2. détachement atomique vers une quarantaine dont le NOM EMBARQUE NOTRE
   *     token unique (`{id}.lock.rm-{token}`) — seul notre propre release y
   *     écrit, personne ne peut y substituer un contenu ;
   *  3. vérification du détaché : nôtre => suppression de la quarantaine
   *     (fenêtre nulle : chemin unique par token, contenu vérifié) ; pas
   *     nôtre (remplacement survenu dans la fenêtre) => RESTAURATION par
   *     link conditionnel — le lock du nouveau détenteur n'est jamais
   *     supprimé, au pire brièvement détaché puis restauré.
   */
  private async releaseCoordinatorLock(lockPath: string, token: string): Promise<void> {
    let current: CoordinatorLock | null = null;
    try {
      current = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as CoordinatorLock;
    } catch { return; /* lock absent/illisible — rien à libérer */ }
    if (!current || current.token !== token) return; // détenu par un autre — pas le nôtre
    // Seam test-only : simule un remplacement du lock exactement entre la
    // lecture ci-dessus et le détachement ci-dessous (la fenêtre TOCTOU).
    if (this.deps._testInterposeRelease) await this.deps._testInterposeRelease();
    const quarantine = `${lockPath}.rm-${token}`;
    try {
      await fs.rename(lockPath, quarantine);
    } catch { return; /* déjà supprimé/détaché */ }
    const detachedToken = await this.readLockToken(quarantine);
    if (detachedToken !== token) {
      // Un remplacement est survenu dans la fenêtre : ce n'est PAS notre lock.
      await this.restoreQuarantinedLock(quarantine, lockPath);
      return;
    }
    try { await fs.unlink(quarantine); } catch { /* best-effort */ }
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

  /**
   * Confirmation valide = un événement 'confirm' récent LIÉ au canon courant.
   * La provenance 'live-read' est STRUCTURELLE : le type
   * CampaignConfirmedObservation n'admet que source: 'live-read' (confirm()
   * écrit exclusivement depuis une relecture live) — re-vérifier
   * `c.provenance === 'live-read'` était tautologique (toujours vrai) et a été
   * retiré (défaut review mineur). Le champ `provenance` de la confirmation
   * dérivée reste publié à titre documentaire.
   */
  private async hasValidConfirmation(record: HarmonizationCampaignRecord, machine: string): Promise<boolean> {
    const c = await this.latestConfirmation(record, machine);
    return !!c && c.canonHash === record.canon.hash;
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

    // Refus sur campagne fermée (défaut review mineur) : une confirmation ne
    // doit pas s'accumuler sur une campagne close — plus personne ne la lit,
    // et close gating l'ignore de toute façon. Bump de version pour ré-harmoniser.
    if (record.status === 'closed') {
      throw new HarmonizationCampaignError(
        `Campagne ${id} fermée le ${record.closedAt ?? '?'} — confirmation refusée. Créer une nouvelle version (canon immuable) pour ré-harmoniser.`,
        'CAMPAIGN_CLOSED',
        { id, closedAt: record.closedAt }
      );
    }

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
