/**
 * Gestionnaire de Baseline RooSync
 *
 * Responsable de la gestion des baselines et du dashboard :
 * - Chargement/Calcul du dashboard
 * - Gestion des rollbacks
 * - État de synchronisation
 */

import { promises as fs, existsSync, constants } from 'fs';
import { join } from 'path';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { RooSyncServiceError } from '../../types/errors.js';
import type { RooSyncDashboard } from '../../utils/roosync-parsers.js';
import { createLogger } from '../../utils/logger.js';
import { ensureStoreSubdir } from '../../utils/shared-state-path.js';
// #4131 Phase D — registre PG-premier (roosync_store_meta, migrations/012)
import {
  MACHINE_REGISTRY_META_KEY,
  readStoreMetaValue,
  upsertStoreMetaValue,
  storeMetaUrl
} from '../unified-store/store-meta.js';

/**
 * Registre central des machines pour éviter les conflits d'identité
 */
interface MachineRegistry {
  /** Map des machineId vers leurs métadonnées */
  machines: Map<string, {
    machineId: string;
    firstSeen: string;
    lastSeen: string;
    // 'service' = source historique du fichier .machine-registry.json, celle
    // qu'écrit `registerMachineId` au démarrage. L'inscription au boot doit la
    // RÉUTILISER : `validateMachineUniqueness` refuse toute source différente
    // sur un machineId déjà présent (conflit d'identité), donc une source neuve
    // ferait rejeter chaque siège déjà semé par le fichier (#4131).
    source: 'dashboard' | 'presence' | 'baseline' | 'config' | 'service';
    status: 'online' | 'offline' | 'conflict';
  }>;

  /** Fichier de sauvegarde du registre */
  registryPath: string;
}

/**
 * État de validation d'unicité
 */
interface UniquenessValidationResult {
  isValid: boolean;
  conflictDetected: boolean;
  conflictingMachineId?: string;
  conflictSource?: string;
  warningMessage?: string;
}

/**
 * Résultat de restauration rollback
 */
export interface RollbackRestoreResult {
  /** Succès de la restauration */
  success: boolean;

  /** Fichiers restaurés */
  restoredFiles: string[];

  /** Logs de restauration */
  logs: string[];

  /** Message d'erreur si échec */
  error?: string;
}

export class BaselineManager {
  private logger = createLogger('BaselineManager');
  private machineRegistry: MachineRegistry;
  // #4131 Phase D (review ms#1563, Hermes 🟠) : état de persistance hérité du
  // chargement. 'refused-blind' = une source EXISTAIT mais était illisible au
  // chargement (fichier EBUSY, ligne PG corrompue) : persister maintenant
  // écrirait le registre partiel en mémoire COMME vérité durable — et la
  // ligne PG, une fois écrite, masquerait pour toujours le fichier redevenu
  // sain au démarrage suivant. On refuse, bruyamment. Une installation neuve
  // (aucune source nulle part) reste 'allowed' : c'est ainsi que le registre naît.
  private registryPersistence: 'allowed' | 'refused-blind' = 'allowed';
  // #2267: registry init promise — avoids blocking constructor on GDrive readFileSync
  private registryInitPromise: Promise<void>;

  constructor(
    private config: RooSyncConfig,
    private baselineService: any,
    private configComparator: any,
    private nonNominativeService?: any
  ) {
    // Initialiser le registre central des machines
    this.machineRegistry = {
      machines: new Map(),
      registryPath: join(this.config.sharedPath, '.machine-registry.json')
    };

    // Initialiser le service non-nominatif si non fourni
    if (!this.nonNominativeService) {
      // Note: NonNominativeBaselineService n'est pas importé, on laisse undefined
      // Le service sera initialisé ailleurs si nécessaire
      this.logger.warn('NonNominativeBaselineService non disponible');
    }

    // #2267: Fire-and-forget async registry load — avoids blocking constructor on GDrive FUSE stalls.
    // Methods that read the registry should await registryInitPromise first.
    this.registryInitPromise = this.loadMachineRegistry();
  }

  /**
   * Wait for the machine registry to be loaded from disk (GDrive).
   * #2267: Safe to call multiple times — resolves immediately after first load.
   */
  async waitForRegistry(): Promise<void> {
    await this.registryInitPromise;
  }

  /**
   * Inscrire CE siège dans le registre machines au démarrage, PG d'abord.
   *
   * #4131 — arbitrage ai-01 (a), message `c.6490889143` : « auto-enregistrement
   * au boot PG-first comme nouveau défaut ; le semis manuel est rejeté ».
   *
   * Le trou mesuré le 29/10 : `addMachineToRegistry` n'avait que deux
   * appelants, tous deux dans `loadDashboard` — or les flux PG-first
   * (inventory, dashboard-pg, channel-pg) ne passent jamais par
   * `loadDashboard`. Chaque siège écrivait donc bien SA ligne d'inventaire,
   * mais la ligne PARTAGÉE `machine_registry` restait au semis d'une seule
   * machine, et un registre à une entrée est indistinguable d'une flotte à
   * une machine (#3459).
   *
   * Trois propriétés, chacune verrouillée par un test :
   *
   *  - **fusion, jamais remplacement** : la ligne partagée est relue juste
   *    avant l'écriture et son contenu est UNIONNÉ à la mémoire. Écrire la
   *    carte chargée au boot écraserait les sièges inscrits entre-temps ;
   *  - **vérification après écriture** : deux sièges qui démarrent ensemble
   *    peuvent encore s'écraser mutuellement ; la perte est détectée par une
   *    relecture et réparée dans le MÊME boot (3 essais bornés) ;
   *  - **jamais d'écriture aveugle** : ligne illisible ⇒ aucune écriture, une
   *    ligne d'erreur qui nomme la cause (garde ms#1563 conservée). Un siège
   *    déjà présent et à jour ne réécrit rien (#2121b).
   *
   * @returns true si la ligne partagée liste ce siège à la sortie.
   */
  public async registerLocalMachineFromBoot(): Promise<boolean> {
    await this.waitForRegistry();

    const machineId = this.config.machineId.toLowerCase();
    const source = 'service' as const;

    if (this.registryPersistence === 'refused-blind') {
      this.logger.error(
        `[registry] inscription de ${machineId} REFUSÉE — le chargement n'a pu lire aucune source : ` +
        'écrire ferait de ce registre partiel la vérité durable (#4131, famille #3459)'
      );
      return false;
    }

    const pgAvailable = Boolean(storeMetaUrl());
    const maxAttempts = pgAvailable ? 3 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const now = new Date().toISOString();

      if (pgAvailable) {
        const row = await this.readSharedRegistryRow();
        if (row === null) {
          this.logger.error(
            `[registry] inscription de ${machineId} NON TENTÉE — la ligne partagée est illisible : ` +
            'aucune écriture (une ligne existait peut-être, l\'écraser perdrait la flotte — #4131, famille #3459)'
          );
          return false;
        }
        // attempt > 1 : la relecture de vérification a montré que notre entrée
        // avait été écrasée → on réécrit même si rien n'a changé en mémoire.
        const merged = this.mergeSharedRegistry(row.machines, machineId, source, now);
        if (!merged && attempt === 1) {
          // Nous y sommes déjà, et la ligne ne contient rien que nous ignorions.
          this.logger.info(
            `[registry] ${machineId} déjà inscrit dans la ligne partagée — aucune réécriture (#2121b)`
          );
          return true;
        }
      } else if (!this.addLocalMachineInMemory(machineId, source, now) && attempt === 1) {
        return true;
      }

      await this.saveMachineRegistry();

      if (!pgAvailable) {
        return true;
      }

      const verified = await this.readSharedRegistryRow();
      if (verified && verified.machines[machineId]) {
        this.logger.info(
          `[registry] ${machineId} inscrit dans la ligne partagée: ` +
          `${Object.keys(verified.machines).length} machines (#4131, essai ${attempt})`
        );
        return true;
      }

      this.logger.warn(
        `[registry] inscription de ${machineId} perdue (écriture concurrente) — ` +
        `nouvel essai ${attempt}/${maxAttempts} (#4131)`
      );
    }

    this.logger.error(
      `[registry] inscription de ${machineId} NON VÉRIFIÉE après ${maxAttempts} essais — ` +
      'la ligne partagée ne le liste toujours pas (#4131)'
    );
    return false;
  }

  /**
   * Relire la ligne partagée du registre.
   * @returns `{ machines }` si la lecture aboutit (objet vide = ligne absente,
   *          création légitime), `null` si la lecture ÉCHOUE — distinct de
   *          « absent » : sur un échec on n'écrit pas (famille #3459).
   */
  private async readSharedRegistryRow(): Promise<{ machines: Record<string, any> } | null> {
    try {
      const raw = await readStoreMetaValue(MACHINE_REGISTRY_META_KEY);
      if (raw === null) {
        return { machines: {} };
      }
      const parsed = JSON.parse(raw);
      return { machines: (parsed && parsed.machines) || {} };
    } catch (error) {
      this.logger.warn('[registry] relecture de la ligne partagée impossible', { error: String(error) });
      return null;
    }
  }

  /**
   * Unionner la ligne partagée dans la carte mémoire, puis (ré)inscrire ce siège.
   * @returns true si quelque chose doit être écrit.
   */
  private mergeSharedRegistry(
    rowMachines: Record<string, any>,
    machineId: string,
    source: 'service',
    now: string
  ): boolean {
    let changed = false;

    // Les sièges inscrits par d'autres process depuis notre chargement entrent
    // en mémoire AVANT toute écriture : sans cette union, sauvegarder la carte
    // du boot remplacerait leur inscription par la nôtre (perte silencieuse).
    for (const [id, entry] of Object.entries(rowMachines)) {
      const key = id.toLowerCase();
      if (!this.machineRegistry.machines.has(key)) {
        this.machineRegistry.machines.set(key, { ...(entry as any), machineId: key });
        changed = true;
      }
    }

    const own = this.machineRegistry.machines.get(machineId);
    if (!own) {
      this.machineRegistry.machines.set(machineId, {
        machineId,
        firstSeen: now,
        lastSeen: now,
        source,
        status: 'online'
      });
      return true;
    }

    if (own.source !== source) {
      // La source est write-once par design (validateMachineUniqueness) : une
      // divergence se NOMME, elle ne se réécrit pas.
      this.logger.warn(
        `[registry] ${machineId} porte déjà la source '${own.source}' — inscription au boot '${source}' ` +
        'non appliquée (source write-once, #4131)'
      );
      return changed;
    }

    if (own.status !== 'online') {
      // Auto-guérison : un siège qui démarre est en ligne.
      own.status = 'online';
      own.lastSeen = now;
      return true;
    }

    return changed;
  }

  /**
   * Variante sans PG (surface fichier seule) : (ré)inscrire le siège en mémoire.
   * @returns true si une écriture est nécessaire.
   */
  private addLocalMachineInMemory(machineId: string, source: 'service', now: string): boolean {
    const own = this.machineRegistry.machines.get(machineId);
    if (!own) {
      this.machineRegistry.machines.set(machineId, {
        machineId,
        firstSeen: now,
        lastSeen: now,
        source,
        status: 'online'
      });
      return true;
    }
    if (own.source === source && own.status === 'online') {
      return false;
    }
    if (own.source === source) {
      own.status = 'online';
      own.lastSeen = now;
    }
    return own.source === source;
  }

  /**
   * Charger le registre des machines — PG d'abord, fichier GDrive en repli.
   *
   * #4131 Phase D (bloqueur 03/11) : le registre était lu UNIQUEMENT sur
   * GDrive (87/87 démarrages mesurés le 28/10) et dégradait EN SILENCE en
   * Map vide quand la lecture échouait — un registre vide était
   * indistinguable de « la flotte n'a pas de machines ». Le nouveau défaut :
   * la ligne PG (`roosync_store_meta`, clé `machine_registry`) est la
   * surface ; le fichier GDrive ne sert que lorsque la ligne est absente,
   * et son chargement SEED alors PG — le registre est une donnée dérivée
   * (chaque machine se ré-enregistre), le seed rend la bascule
   * auto-réparante sans script de migration. Aucune source lisible =
   * une ligne d'erreur qui NOMME les deux causes : registre vide ≠ flotte
   * vide (famille #3459).
   *
   * #2267: async depuis l'origine — les blocages FUSE GDrive ne gèlent pas
   * l'event loop.
   */
  private async loadMachineRegistry(): Promise<void> {
    let pgState = 'absent (pas d\'URL PG)';

    if (storeMetaUrl()) {
      try {
        const raw = await readStoreMetaValue(MACHINE_REGISTRY_META_KEY);
        if (raw !== null) {
          const registryData = JSON.parse(raw);
          this.machineRegistry.machines = new Map(
            Object.entries(registryData.machines || {}).map(
              ([key, value]) => [key.toLowerCase(), value as any]
            )
          );
          this.logger.info(
            `[registry] chargé depuis PG: ${this.machineRegistry.machines.size} machines (#4131)`
          );
          this.registryPersistence = 'allowed';
          return;
        }
        pgState = 'ligne absente';
      } catch (error) {
        pgState = 'lecture PG en échec';
        this.logger.warn('[registry] lecture PG impossible — repli sur le fichier GDrive', { error: String(error) });
      }
    }

    // Repli/seed : le fichier GDrive reste la surface tant que la ligne PG
    // n'existe pas (contrat migration-012 : la DONNÉE décide, pas un drapeau).
    let fileState = 'absent';
    try {
      if (existsSync(this.machineRegistry.registryPath)) {
        // #2267: async read replaces readFileSync — GDrive FUSE stalls no longer block event loop
        const registryContent = await fs.readFile(this.machineRegistry.registryPath, 'utf-8');
        const registryData = JSON.parse(registryContent);

        // Reconstruire la Map depuis les données JSON (normaliser les clés en lowercase)
        this.machineRegistry.machines = new Map(
          Object.entries(registryData.machines || {}).map(
            ([key, value]) => [key.toLowerCase(), value as any]
          )
        );

        this.logger.info(
          `[registry] chargé depuis le fichier GDrive: ${this.machineRegistry.machines.size} machines`
        );
        fileState = `lu (${this.machineRegistry.machines.size} machines)`;
        this.registryPersistence = 'allowed';

        // Seed : première lecture d'un registre qui n'existe pas encore en PG
        // → la donnée migre elle-même, une fois, sans script (#4131 Phase D).
        if (storeMetaUrl() && pgState === 'ligne absente' && this.machineRegistry.machines.size > 0) {
          try {
            await upsertStoreMetaValue(
              MACHINE_REGISTRY_META_KEY,
              JSON.stringify({
                machines: Object.fromEntries(this.machineRegistry.machines),
                lastUpdated: new Date().toISOString()
              })
            );
            this.logger.info(
              `[registry] PG seedé depuis le fichier GDrive (${this.machineRegistry.machines.size} machines, #4131)`
            );
          } catch (error) {
            // Non-fatal : la ligne sera seedée à la prochaine lecture réussie.
            this.logger.warn('[registry] seed PG impossible (reprise à la prochaine lecture)', {
              error: String(error)
            });
          }
        }
        return;
      }
    } catch (error) {
      fileState = 'lecture en échec';
      this.logger.warn('Erreur chargement registre des machines:', { error });
    }

    // Aucune source : registre vide MAIS dit et daté dans le journal —
    // jamais silencieux (l'ancien `catch → new Map()` sans condition).
    this.machineRegistry.machines = new Map();
    // Review ms#1563 (Hermes 🟠) : distinguer « rien n'existe » (installation
    // neuve — la persistance crée le registre) de « quelque chose existe mais
    // est illisible » (aveugle — persister écraserait la vérité). pgState ne
    // dit « ligne absente » que si PG a RÉPONDU ; fileState ne dit « lecture
    // en échec » que si le fichier existait.
    const blindLoad =
      pgState === 'lecture PG en échec' ||
      fileState === 'lecture en échec';
    this.registryPersistence = blindLoad ? 'refused-blind' : 'allowed';
    this.logger.error(
      `[registry] VIDE — aucune source lisible (pg: ${pgState}, fichier: ${fileState}) — ` +
      'registre vide ≠ flotte vide (#4131, famille #3459)'
    );
    if (blindLoad) {
      this.logger.error(
        '[registry] PERSISTANCE REFUSÉE pour cette session — une source existait mais était ' +
        'illisible au chargement : écrire maintenant ferait du registre partiel en mémoire la ' +
        'vérité durable, même après retour du montage (#4131, famille #3459)'
      );
    }
  }

  /**
   * Sauvegarder le registre des machines — PG d'abord, miroir fichier GDrive.
   *
   * #4131 Phase D : la ligne PG est la surface ; l'écriture fichier devient
   * un miroir meilleur-effort (échec toléré et journalisé), symétrique du
   * miroir dashboards hors chemin critique. Les DEUX en échec = une ligne
   * d'erreur, jamais un silence.
   */
  private async saveMachineRegistry(): Promise<void> {
    // Review ms#1563 (Hermes 🟠) : un chargement aveugle ne devient jamais la
    // vérité durable — le refus est une ligne d'erreur, pas un silence.
    if (this.registryPersistence === 'refused-blind') {
      this.logger.error(
        `[registry] sauvegarde REFUSÉE (${this.machineRegistry.machines.size} machines en mémoire) — ` +
        'aucune source n\'était lisible au chargement : persister ferait de ce registre partiel ' +
        'la vérité durable (#4131, famille #3459)'
      );
      return;
    }
    const registryData = {
      machines: Object.fromEntries(this.machineRegistry.machines),
      lastUpdated: new Date().toISOString()
    };

    let pgSaved = false;
    if (storeMetaUrl()) {
      try {
        await upsertStoreMetaValue(
          MACHINE_REGISTRY_META_KEY,
          JSON.stringify(registryData)
        );
        pgSaved = true;
        this.logger.info(
          `[registry] sauvegardé dans PG: ${this.machineRegistry.machines.size} machines (#4131)`
        );
      } catch (error) {
        this.logger.error('[registry] sauvegarde PG impossible', { error: String(error) });
      }
    }

    let mirrorSaved = false;
    try {
      await fs.writeFile(
        this.machineRegistry.registryPath,
        JSON.stringify(registryData, null, 2),
        'utf-8'
      );
      mirrorSaved = true;
    } catch (error) {
      this.logger.warn('[registry] écriture miroir GDrive impossible (toléré)', { error: String(error) });
    }

    if (!pgSaved && !mirrorSaved) {
      this.logger.error('[registry] AUCUNE sauvegarde réussie (PG et GDrive en échec)');
    }
  }

  /**
   * Valider l'unicité d'un machineId avant ajout
   */
  private validateMachineUniqueness(machineId: string, source: string): UniquenessValidationResult {
    machineId = machineId.toLowerCase();
    const existingMachine = this.machineRegistry.machines.get(machineId);

    if (!existingMachine) {
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // Vérifier si c'est la même source (mise à jour normale)
    if (existingMachine.source === source) {
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // #4131 (a) — le siège s'inscrit désormais AU BOOT (source `service`, celle
    // du fichier `.machine-registry.json` historique), et `loadDashboard`
    // l'injecte ensuite depuis le canal `dashboard`. Ces deux déclarations sont
    // la MÊME machine qui se présente par deux canaux du même service : les
    // tenir pour un conflit d'identité faisait refuser l'injection et
    // `getStatus` levait MACHINE_NOT_FOUND (régression e2e mesurée le 29/10).
    // L'exception est bornée à ce couple : une entrée `config`/`baseline`/
    // `presence` reste un conflit (garde #1409 conservée, cf.
    // BaselineManager.gap.test.ts), et un machineId étranger reste strict.
    const bootToDashboard =
      existingMachine.source === 'service' && source === 'dashboard';

    if (bootToDashboard) {
      this.logger.info(
        `Machine ${machineId} déjà inscrite au boot (source 'service') — déclaration 'dashboard' ` +
        'traitée comme la même machine (#4131)'
      );
      return {
        isValid: true,
        conflictDetected: false
      };
    }

    // Conflit détecté : même machineId depuis des sources différentes
    const warningMessage = `⚠️ CONFLIT D'IDENTITÉ DÉTECTÉ: MachineId "${machineId}" déjà utilisé par la source "${existingMachine.source}" (première vue: ${existingMachine.firstSeen}). Tentative d'ajout depuis la source "${source}".`;

    this.logger.warn(warningMessage);

    return {
      isValid: false,
      conflictDetected: true,
      conflictingMachineId: machineId,
      conflictSource: existingMachine.source,
      warningMessage
    };
  }

  /**
   * Ajouter une machine au registre avec validation d'unicité
   */
  private async addMachineToRegistry(
    machineId: string,
    source: 'dashboard' | 'presence' | 'baseline' | 'config' | 'service',
    status: 'online' | 'offline' | 'conflict' = 'online'
  ): Promise<UniquenessValidationResult> {
    machineId = machineId.toLowerCase();
    const validation = this.validateMachineUniqueness(machineId, source);

    if (!validation.isValid) {
      // Ne pas ajouter la machine en conflit, mais logger l'avertissement
      this.logger.error(`REFUS D'AJOUT: ${validation.warningMessage}`);
      return validation;
    }

    const now = new Date().toISOString();
    const existingMachine = this.machineRegistry.machines.get(machineId);

    if (existingMachine) {
      // #2121(b) debounce (review #1202) : état comparé AVANT mutation.
      // Le prédicat ne porte que sur le status — la source est write-once
      // par design (validateMachineUniqueness refuse toute source différente
      // avant qu'on arrive ici : conflit d'identité). Quand l'entrée existe
      // avec le même status, le lastSeen est stampé en mémoire et le registre
      // n'est pas réécrit — les cold starts / dashboards régénérés n'écrivent
      // plus le registre sur GDrive à chaque fois.
      existingMachine.lastSeen = now;

      if (existingMachine.status === status) {
        this.logger.info(
          `Machine ${machineId} état inchangé — lastSeen mis à jour en mémoire, registre non réécrit (#2121b)`
        );
        return validation;
      }

      // Mise à jour d'une machine existante (changement de status)
      existingMachine.status = status;
      this.logger.info(`Machine ${machineId} mise à jour dans le registre`);
    } else {
      // Nouvelle machine
      this.machineRegistry.machines.set(machineId, {
        machineId,
        firstSeen: now,
        lastSeen: now,
        source,
        status
      });
      this.logger.info(`Nouvelle machine ${machineId} ajoutée au registre depuis la source ${source}`);
    }

    // Sauvegarder le registre
    await this.saveMachineRegistry();

    return validation;
  }

  /**
   * Obtenir la liste des IDs machines connues du registre
   * #1409: Source de vérité pour le nombre total de machines du cluster
   */
  public getKnownMachineIds(): string[] {
    return Array.from(this.machineRegistry.machines.keys());
  }

  /**
   * Obtenir les informations d'une machine depuis le registre
   */
  private getMachineFromRegistry(machineId: string) {
    return this.machineRegistry.machines.get(machineId.toLowerCase());
  }

  /**
   * Obtenir le chemin complet d'un fichier RooSync
   */
  private getRooSyncFilePath(filename: string): string {
    return join(this.config.sharedPath, filename);
  }

  /**
   * Charger le dashboard RooSync
   */
  public async loadDashboard(
    cacheCallback: (key: string, fetchFn: () => Promise<RooSyncDashboard>) => Promise<RooSyncDashboard>
  ): Promise<RooSyncDashboard> {
    return cacheCallback('dashboard', async () => {
      this.logger.info(`loadDashboard appelée à ${new Date().toISOString()}`);

      // Vérifier d'abord si le dashboard existe déjà
      const dashboardPath = this.getRooSyncFilePath('sync-dashboard.json');
      if (existsSync(dashboardPath)) {
        this.logger.info(`Dashboard existant trouvé, chargement depuis: ${dashboardPath}`);
        try {
          // #2267: async read avoids blocking Node.js event loop on GDrive FUSE stalls
          const dashboard = JSON.parse(await fs.readFile(dashboardPath, 'utf-8'));
          this.logger.info('Dashboard chargé avec succès depuis le fichier existant');

          // S'assurer que le dashboard a bien la propriété machines
          if (!dashboard.machines) {
            dashboard.machines = {};
          }

          // S'assurer que la machine courante existe dans le dashboard avec validation d'unicité
          if (!dashboard.machines[this.config.machineId]) {
            this.logger.info(`Tentative d'ajout de la machine ${this.config.machineId} au dashboard existant`);

            // Valider l'unicité avant d'ajouter
            const validation = await this.addMachineToRegistry(this.config.machineId, 'dashboard');

            if (validation.isValid) {
              dashboard.machines[this.config.machineId] = {
                lastSync: new Date().toISOString(),
                status: 'synced' as 'diverged' | 'synced' | 'conflict' | 'unknown',
                diffsCount: 0,
                pendingDecisions: 0
              };
              this.logger.info(`Machine ${this.config.machineId} ajoutée avec succès au dashboard`);
            } else {
              this.logger.error(`ÉCHEC AJOUT DASHBOARD: ${validation.warningMessage}`);
              // Ne pas écraser la machine existante, mais logger le conflit
              if (validation.conflictingMachineId && dashboard.machines[validation.conflictingMachineId]) {
                this.logger.warn(`Préservation de la machine existante ${validation.conflictingMachineId} dans le dashboard`);
              }
            }
          } else {
            // La machine existe déjà, valider que ce n'est pas un conflit
            const existingMachine = this.getMachineFromRegistry(this.config.machineId);
            if (existingMachine && existingMachine.source !== 'dashboard') {
              this.logger.warn(`ATTENTION: Machine ${this.config.machineId} existe dans le dashboard mais provient de la source ${existingMachine.source}`);
            }
          }

          return dashboard as RooSyncDashboard;
        } catch (error) {
          this.logger.warn('Erreur lecture dashboard existant, recalcule depuis baseline:', { error });
        }
      }

      return this.calculateDashboardFromBaseline();
    });
  }

  /**
   * Calculer le dashboard à partir de la baseline
   */
  private async calculateDashboardFromBaseline(): Promise<RooSyncDashboard> {
    this.logger.info('calculateDashboardFromBaseline - début de la méthode');
    const dashboardPath = this.getRooSyncFilePath('sync-dashboard.json');

    // S'assurer que la baseline est chargée
    await this.baselineService.loadBaseline();

    // Utiliser ConfigComparator pour obtenir les diffs
    const diffsResult = await this.configComparator.listDiffs('all');
    const totalDiffs = diffsResult.totalDiffs;

    // Récupérer la baseline pour les machines
    const baseline = await this.baselineService.loadBaseline();
    const allMachines = new Set<string>();

    if (baseline) {
      if (baseline.machineId) {
        allMachines.add(baseline.machineId);
      }
      if (this.config.machineId && !allMachines.has(this.config.machineId)) {
        allMachines.add(this.config.machineId);
      }
    }

    const now = new Date().toISOString();

    // Si un dashboard existe déjà, l'utiliser et s'assurer que la machine courante est présente
    if (existsSync(dashboardPath)) {
      try {
        // #2267: async read avoids blocking Node.js event loop on GDrive FUSE stalls
        const existingDashboard = JSON.parse(await fs.readFile(dashboardPath, 'utf-8'));
        this.logger.info('Dashboard existant trouvé, vérification de la machine courante');

        if (!existingDashboard.machines) {
          existingDashboard.machines = {};
        }

        if (!existingDashboard.machines[this.config.machineId]) {
          this.logger.info(`Tentative d'ajout de la machine ${this.config.machineId} au dashboard existant (calculateDashboardFromBaseline)`);

          // Valider l'unicité avant d'ajouter
          const validation = await this.addMachineToRegistry(this.config.machineId, 'dashboard');

          if (validation.isValid) {
            existingDashboard.machines[this.config.machineId] = {
              lastSync: now,
              status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
              diffsCount: totalDiffs,
              pendingDecisions: 0
            };
            this.logger.info(`Machine ${this.config.machineId} ajoutée avec succès au dashboard (calculateDashboardFromBaseline)`);
          } else {
            this.logger.error(`ÉCHEC AJOUT DASHBOARD (calculate): ${validation.warningMessage}`);
            // Ne pas écraser la machine existante, mais logger le conflit
            if (validation.conflictingMachineId && existingDashboard.machines[validation.conflictingMachineId]) {
              this.logger.warn(`Préservation de la machine existante ${validation.conflictingMachineId} dans le dashboard (calculate)`);
            }
          }
        } else {
          // La machine existe déjà, valider que ce n'est pas un conflit
          const existingMachine = this.getMachineFromRegistry(this.config.machineId);
          if (existingMachine && existingMachine.source !== 'dashboard') {
            this.logger.warn(`ATTENTION (calculate): Machine ${this.config.machineId} existe dans le dashboard mais provient de la source ${existingMachine.source}`);
          }
        }
      } catch (error) {
        this.logger.warn('Erreur lecture dashboard existant, fallback sur calcul:', { error });
      }
    }

    // Créer le résultat basé sur les données réelles
    const machinesArray = Array.from(allMachines).map(machineId => ({
      id: machineId,
      status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      lastSync: now,
      pendingDecisions: 0,
      diffsCount: totalDiffs
    }));

    const summary = {
      totalMachines: allMachines.size,
      onlineMachines: allMachines.size,
      totalDiffs: totalDiffs,
      totalPendingDecisions: 0
    };

    const result = {
      version: '2.1.0',
      lastUpdate: now,
      overallStatus: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      lastSync: now,
      status: (totalDiffs > 0 ? 'diverged' : 'synced') as 'diverged' | 'synced' | 'conflict' | 'unknown',
      machines: machinesArray.reduce((acc, machine) => {
        acc[machine.id] = {
          lastSync: machine.lastSync,
          status: machine.status,
          diffsCount: machine.diffsCount,
          pendingDecisions: machine.pendingDecisions
        };
        return acc;
      }, {} as Record<string, any>),
      stats: {
        totalDiffs: totalDiffs,
        totalDecisions: totalDiffs,
        appliedDecisions: 0,
        pendingDecisions: 0
      },
      machinesArray,
      summary
    };

    if (!result.machines) {
      result.machines = {};
    }

    return result as RooSyncDashboard;
  }

  /**
   * Obtenir l'état de synchronisation global
   */
  public async getStatus(
    dashboardLoader: () => Promise<RooSyncDashboard>
  ): Promise<{
    machineId: string;
    overallStatus: string;
    lastSync: string;
    pendingDecisions: number;
    diffsCount: number;
  }> {
    const dashboard = await dashboardLoader();

    if (!dashboard || !dashboard.machines) {
      throw new RooSyncServiceError(
        `Dashboard invalide ou sans propriété machines`,
        'INVALID_DASHBOARD'
      );
    }

    const machineInfo = dashboard.machines[this.config.machineId];

    if (!machineInfo) {
      throw new RooSyncServiceError(
        `Machine ${this.config.machineId} non trouvée dans le dashboard`,
        'MACHINE_NOT_FOUND'
      );
    }

    return {
      machineId: this.config.machineId,
      overallStatus: dashboard.overallStatus,
      lastSync: machineInfo.lastSync,
      pendingDecisions: machineInfo.pendingDecisions,
      diffsCount: machineInfo.diffsCount
    };
  }

  /**
   * Migrer depuis l'ancien système nominatif vers le nouveau système non-nominatif
   */
  public async migrateToNonNominative(options?: {
    createBackup?: boolean;
    updateReason?: string;
  }): Promise<any> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'NonNominativeBaselineService non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    // Charger la baseline actuelle (système nominatif)
    const currentBaseline = await this.baselineService.loadBaseline();

    if (!currentBaseline) {
      throw new RooSyncServiceError(
        'Aucune baseline actuelle trouvée pour la migration',
        'BASELINE_NOT_FOUND'
      );
    }

    // Transformer la baseline nominative en profils non-nominatifs
    const profiles = this.transformBaselineToProfiles(currentBaseline);

    // Créer la nouvelle baseline non-nominative
    const newBaseline = await this.nonNominativeService.createBaseline(
      `Baseline migrée depuis ${currentBaseline.machineId}`,
      `Baseline générée par migration depuis l'ancien système nominatif`,
      profiles
    );

    // Sauvegarder la nouvelle baseline comme active
    await this.nonNominativeService.saveState();

    return {
      success: true,
      oldBaseline: currentBaseline.machineId,
      newBaseline: newBaseline.baselineId,
      profilesCount: profiles.length,
      migratedAt: new Date().toISOString()
    };
  }

  /**
   * Comparer avec la baseline non-nominative
   */
  public async compareWithNonNominativeBaseline(
    machineId: string
  ): Promise<any> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'NonNominativeBaselineService non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    const activeBaseline = await this.nonNominativeService.getActiveBaseline();
    if (!activeBaseline) {
      throw new RooSyncServiceError(
        'Aucune baseline non-nominative active trouvée',
        'BASELINE_NOT_FOUND'
      );
    }

    // Comparer avec la baseline
    const comparison = await this.nonNominativeService.compareMachines(
      [this.nonNominativeService.generateMachineHash(machineId)]
    );

    return comparison;
  }

  /**
   * Transformer une baseline nominative en profils non-nominatifs
   */
  private transformBaselineToProfiles(baseline: any): any[] {
    const now = Date.now();
    const timestamp = new Date().toISOString();
    const baseMetadata = { createdAt: timestamp, updatedAt: timestamp, version: '1.0.0', tags: ['migrated'], stability: 'stable' } as const;
    const emptyCompat = { requiredProfiles: [] as string[], conflictingProfiles: [] as string[], optionalProfiles: [] as string[] };

    const defs: Array<{ guard: any; entries: Array<{ id: string; category: string; name: string; desc: string; config: any }> }> = [
      {
        guard: baseline.config?.roo,
        entries: [{ id: 'roo-core', category: 'roo-core', name: 'Profil Roo Core', desc: 'Configuration Roo de base',
          config: { modes: baseline.config?.roo?.modes || [], mcpSettings: baseline.config?.roo?.mcpSettings || {} } }]
      },
      {
        guard: baseline.config?.hardware,
        entries: [
          { id: 'hardware-cpu', category: 'hardware-cpu', name: 'Profil Hardware CPU', desc: 'Configuration CPU', config: baseline.config?.hardware?.cpu || {} },
          { id: 'hardware-memory', category: 'hardware-memory', name: 'Profil Hardware Mémoire', desc: 'Configuration Mémoire', config: baseline.config?.hardware?.memory || {} },
          { id: 'hardware-storage', category: 'hardware-storage', name: 'Profil Hardware Stockage', desc: 'Configuration Stockage', config: baseline.config?.hardware?.disks || [] }
        ]
      },
      {
        guard: baseline.config?.software,
        entries: [
          { id: 'software-powershell', category: 'software-powershell', name: 'Profil Software PowerShell', desc: 'Version PowerShell', config: { version: baseline.config?.software?.powershell || 'Unknown' } },
          { id: 'software-node', category: 'software-node', name: 'Profil Software Node.js', desc: 'Version Node.js', config: { version: baseline.config?.software?.node || 'Unknown' } },
          { id: 'software-python', category: 'software-python', name: 'Profil Software Python', desc: 'Version Python', config: { version: baseline.config?.software?.python || 'Unknown' } }
        ]
      },
      {
        guard: baseline.config?.system,
        entries: [
          { id: 'system-os', category: 'system-os', name: 'Profil Système OS', desc: "Système d'exploitation", config: { os: baseline.config?.system?.os || 'Unknown' } },
          { id: 'system-architecture', category: 'system-architecture', name: 'Profil Architecture Système', desc: 'Architecture système', config: { arch: baseline.config?.system?.architecture || 'Unknown' } }
        ]
      }
    ];

    const profiles: any[] = [];
    for (const group of defs) {
      if (!group.guard) continue;
      for (const e of group.entries) {
        profiles.push({
          profileId: `profile-${e.id}-${now}`,
          category: e.category,
          name: e.name,
          description: e.desc,
          configuration: e.config,
          priority: 100,
          compatibility: emptyCompat,
          metadata: { ...baseMetadata }
        });
      }
    }
    return profiles;
  }

  /**
   * Crée un point de rollback pour une décision
   */
  public async createRollbackPoint(decisionId: string): Promise<void> {
    try {
      const sharedPath = this.config.sharedPath;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rollbackPath = join(sharedPath, '.rollback', `${decisionId}_${timestamp}`);

      // #3459 (b): création sous la racine via le helper sanctionné
      ensureStoreSubdir(sharedPath, '.rollback', `${decisionId}_${timestamp}`);

      // Backup des fichiers critiques
      const filesToBackup = [
        'sync-config.ref.json',
        'sync-roadmap.md'
      ];

      for (const file of filesToBackup) {
        const sourcePath = this.getRooSyncFilePath(file);
        const targetPath = join(rollbackPath, file);

        if (existsSync(sourcePath)) {
          await fs.copyFile(sourcePath, targetPath);
        }
      }

      // Créer metadata
      const metadata = {
        decisionId,
        timestamp,
        machine: this.config.machineId,
        files: filesToBackup
      };

      await fs.writeFile(
        join(rollbackPath, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );
    } catch (error) {
      throw new RooSyncServiceError(
        `Échec création rollback point: ${error instanceof Error ? error.message : String(error)}`,
        'ROLLBACK_CREATION_FAILED'
      );
    }
  }

  /**
   * Restaurer depuis un point de rollback
   *
   * Améliorations:
   * - Validation des fichiers avant restauration
   * - Rollback partiel en cas d'échec
   * - Logs détaillés pour debugging
   * - Gestion d'erreurs spécifiques par fichier
   * - Vérification d'intégrité après restauration
   */
  public async restoreFromRollbackPoint(
    decisionId: string,
    clearCacheCallback: () => void
  ): Promise<RollbackRestoreResult> {
    const logs: string[] = [];
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ file: string; error: string }> = [];
    const startTime = Date.now();

    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      logs.push(`[ROLLBACK] Début de la restauration pour décision ${decisionId}`);
      logs.push(`[ROLLBACK] Répertoire rollback: ${rollbackDir}`);

      // Vérifier que le répertoire rollback existe
      if (!existsSync(rollbackDir)) {
        logs.push(`[ROLLBACK] ❌ Aucun répertoire rollback trouvé dans ${rollbackDir}`);
        return {
          success: false,
          restoredFiles: [],
          logs,
          error: 'No rollback directory found'
        };
      }

      // Lister les rollbacks pour cette décision
      const allBackups = await fs.readdir(rollbackDir);
      const matchingBackups = allBackups
        .filter(name => name.startsWith(decisionId))
        .sort()
        .reverse(); // Plus récent en premier

      if (matchingBackups.length === 0) {
        logs.push(`[ROLLBACK] ❌ Aucun rollback trouvé pour la décision ${decisionId}`);
        logs.push(`[ROLLBACK] Rollbacks disponibles: ${allBackups.join(', ') || 'aucun'}`);
        return {
          success: false,
          restoredFiles: [],
          logs,
          error: `No rollback found for decision ${decisionId}`
        };
      }

      logs.push(`[ROLLBACK] ${matchingBackups.length} rollback(s) trouvé(s) pour cette décision`);

      // Restaurer depuis le plus récent
      const backupPath = join(rollbackDir, matchingBackups[0]);
      logs.push(`[ROLLBACK] Utilisation du rollback le plus récent: ${matchingBackups[0]}`);

      // Vérifier que le répertoire de backup existe
      if (!existsSync(backupPath)) {
        logs.push(`[ROLLBACK] ❌ Répertoire de backup introuvable: ${backupPath}`);
        return {
          success: false,
          restoredFiles: [],
          logs,
          error: `Backup directory not found: ${backupPath}`
        };
      }

      // Lire metadata
      const metadataPath = join(backupPath, 'metadata.json');
      let filesToRestore: string[] = ['sync-config.ref.json', 'sync-roadmap.md'];
      let metadata: any = null;

      if (existsSync(metadataPath)) {
        try {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataContent);
          filesToRestore = metadata.files || filesToRestore;
          logs.push(`[ROLLBACK] Metadata lue: ${metadata.timestamp}, machine: ${metadata.machine}`);
          logs.push(`[ROLLBACK] Fichiers à restaurer: ${filesToRestore.join(', ')}`);
        } catch (metadataError) {
          logs.push(`[ROLLBACK] ⚠️ Erreur lecture metadata: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
          logs.push(`[ROLLBACK] Utilisation des fichiers par défaut`);
        }
      } else {
        logs.push(`[ROLLBACK] ⚠️ Metadata introuvable, utilisation des fichiers par défaut`);
      }

      // Restaurer les fichiers avec gestion d'erreurs individuelle
      for (const file of filesToRestore) {
        const sourcePath = join(backupPath, file);
        const targetPath = this.getRooSyncFilePath(file);

        try {
          // Vérifier que le fichier source existe
          if (!existsSync(sourcePath)) {
            logs.push(`[ROLLBACK] ⚠️ Fichier source introuvable: ${file}`);
            failedFiles.push({ file, error: 'Source file not found' });
            continue;
          }

          // Vérifier que le fichier source est lisible
          try {
            await fs.access(sourcePath, constants.R_OK);
          } catch (accessError) {
            logs.push(`[ROLLBACK] ❌ Fichier source non lisible: ${file}`);
            failedFiles.push({ file, error: 'Source file not readable' });
            continue;
          }

          // Faire un backup du fichier cible avant restauration (idempotence)
          if (existsSync(targetPath)) {
            const backupTargetPath = `${targetPath}.rollback-backup`;
            await fs.copyFile(targetPath, backupTargetPath);
            logs.push(`[ROLLBACK] Backup du fichier cible: ${file}`);
          }

          // Restaurer le fichier
          await fs.copyFile(sourcePath, targetPath);
          restoredFiles.push(file);
          logs.push(`[ROLLBACK] ✅ Restauré: ${file}`);

          // Vérifier l'intégrité du fichier restauré
          try {
            await fs.access(targetPath, constants.R_OK);
            const stats = await fs.stat(targetPath);
            logs.push(`[ROLLBACK] ✅ Intégrité vérifiée: ${file} (${stats.size} bytes)`);
          } catch (verifyError) {
            logs.push(`[ROLLBACK] ❌ Erreur vérification intégrité: ${file}`);
            failedFiles.push({ file, error: 'Integrity check failed' });

            // Retirer le fichier de restoredFiles et restaurer le backup
            const index = restoredFiles.indexOf(file);
            if (index !== -1) {
              restoredFiles.splice(index, 1);
              const backupTargetPath = `${targetPath}.rollback-backup`;
              if (existsSync(backupTargetPath)) {
                await fs.copyFile(backupTargetPath, targetPath);
                logs.push(`[ROLLBACK] 🔄 Backup restauré: ${file}`);
              }
            }
          }
        } catch (fileError) {
          const errorMsg = fileError instanceof Error ? fileError.message : String(fileError);
          logs.push(`[ROLLBACK] ❌ Erreur restauration ${file}: ${errorMsg}`);
          failedFiles.push({ file, error: errorMsg });
        }
      }

      // Nettoyer les backups temporaires
      for (const file of filesToRestore) {
        const targetPath = this.getRooSyncFilePath(file);
        const backupTargetPath = `${targetPath}.rollback-backup`;
        if (existsSync(backupTargetPath)) {
          try {
            await fs.unlink(backupTargetPath);
            logs.push(`[ROLLBACK] 🗑️ Backup temporaire supprimé: ${backupTargetPath}`);
          } catch (cleanupError) {
            logs.push(`[ROLLBACK] ⚠️ Erreur suppression backup: ${backupTargetPath}`);
          }
        }
      }

      // Invalider le cache
      try {
        clearCacheCallback();
        logs.push(`[ROLLBACK] ✅ Cache invalidé`);
      } catch (cacheError) {
        logs.push(`[ROLLBACK] ⚠️ Erreur invalidation cache: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
      }

      const duration = Date.now() - startTime;
      logs.push(`[ROLLBACK] Durée totale: ${duration}ms`);

      // Déterminer le succès
      // Le rollback est un succès si au moins un fichier a été restauré
      const success = restoredFiles.length > 0;

      if (success && failedFiles.length === 0) {
        logs.push(`[ROLLBACK] ✅ Restauration terminée avec succès (${restoredFiles.length} fichier(s))`);
      } else if (success && failedFiles.length > 0) {
        logs.push(`[ROLLBACK] ⚠️ Restauration partielle réussie (${restoredFiles.length} réussi(s), ${failedFiles.length} échoué(s))`);
      } else {
        logs.push(`[ROLLBACK] ❌ Restauration échouée (${failedFiles.length} erreur(s))`);
      }

      return {
        success,
        restoredFiles,
        logs,
        error: failedFiles.length > 0 ? `Partial failure: ${failedFiles.length} file(s) failed` : undefined
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logs.push(`[ROLLBACK] ❌ Erreur critique: ${errorMsg}`);
      if (errorStack) {
        logs.push(`[ROLLBACK] Stack trace: ${errorStack}`);
      }

      return {
        success: false,
        restoredFiles,
        logs,
        error: errorMsg
      };
    }
  }

  /**
   * Mappe une machine à la baseline non-nominative
   * @param machineId ID de la machine à mapper
   * @returns Mapping de la machine vers la baseline
   */
  public async mapMachineToNonNominativeBaseline(machineId: string): Promise<any> {
    if (!this.nonNominativeService) {
      throw new RooSyncServiceError(
        'NonNominativeBaselineService non disponible',
        'SERVICE_NOT_AVAILABLE'
      );
    }

    const activeBaseline = await this.nonNominativeService.getActiveBaseline();
    if (!activeBaseline) {
      throw new RooSyncServiceError(
        'Aucune baseline non-nominative active trouvée',
        'BASELINE_NOT_FOUND'
      );
    }

    // Générer le hash de la machine
    const machineHash = this.nonNominativeService.generateMachineHash(machineId);

    return {
      machineId,
      machineHash,
      baselineId: activeBaseline.baselineId || 'unknown',
      profileIds: activeBaseline.profiles?.map((p: any) => p.profileId) || [],
      mappedAt: new Date().toISOString()
    };
  }

  /**
   * Calculer le checksum SHA256 d'un répertoire de rollback
   */
  private async calculateChecksum(dirPath: string): Promise<string> {
    try {
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256');

      const files = await fs.readdir(dirPath);

      for (const file of files) {
        if (file === 'metadata.json') continue;

        const filePath = join(dirPath, file);
        const content = await fs.readFile(filePath);
        hash.update(content);
      }

      return hash.digest('hex').substring(0, 16);
    } catch (error) {
      this.logger.warn('Impossible de calculer le checksum:', { error });
      return 'unknown';
    }
  }

  /**
   * Lister tous les points de rollback disponibles
   */
  public async listRollbackPoints(): Promise<Array<{
    decisionId: string;
    timestamp: string;
    machine: string;
    files: string[];
  }>> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      if (!existsSync(rollbackDir)) {
        return [];
      }

      const allBackups = await fs.readdir(rollbackDir);
      const rollbackPoints = [];

      for (const backupName of allBackups) {
        const backupPath = join(rollbackDir, backupName);
        const metadataPath = join(backupPath, 'metadata.json');

        if (!existsSync(metadataPath)) continue;

        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataContent);

        rollbackPoints.push({
          decisionId: metadata.decisionId,
          timestamp: metadata.timestamp,
          machine: metadata.machine,
          files: metadata.files || []
        });
      }

      return rollbackPoints.sort((a, b) => {
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);
        return dateB.getTime() - dateA.getTime();
      });
    } catch (error) {
      this.logger.error('Erreur listRollbackPoints:', error);
      return [];
    }
  }

  /**
   * Nettoyer les vieux points de rollback
   */
  public async cleanupOldRollbacks(options: {
    olderThanDays?: number;
    keepPerDecision?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    deleted: string[];
    kept: string[];
    errors: string[];
  }> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      if (!existsSync(rollbackDir)) {
        return {
          deleted: [],
          kept: [],
          errors: ['Rollback directory not found']
        };
      }

      const allBackups = await fs.readdir(rollbackDir);
      const now = Date.now();
      const cutoffTime = options.olderThanDays
        ? now - (options.olderThanDays * 24 * 60 * 60 * 1000)
        : 0;

      // Filter backups by age if cutoff specified
      const ageFiltered = cutoffTime > 0
        ? allBackups.filter(backupName => {
            const dateMatch = backupName.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
            if (!dateMatch) return true;
            const backupDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4]}:${dateMatch[5]}`).getTime();
            return backupDate < cutoffTime;
          })
        : allBackups;

      const deleted: string[] = [];
      const kept: string[] = [];
      const errors: string[] = [];

      // Grouper par décision
      const decisionGroups = new Map<string, string[]>();
      for (const backupName of ageFiltered) {
        const match = backupName.match(/^([^_]+)_/);
        if (match) {
          const decisionId = match[1];
          if (!decisionGroups.has(decisionId)) {
            decisionGroups.set(decisionId, []);
          }
          decisionGroups.get(decisionId)!.push(backupName);
        }
      }

      // Nettoyer chaque groupe
      for (const [decisionId, backups] of decisionGroups) {
        // Trier par date (plus récent en premier) avec null check
        backups.sort((a, b) => {
          const matchA = a.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
          const matchB = b.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
          const dateA = matchA ? new Date(matchA[1]) : new Date(0);
          const dateB = matchB ? new Date(matchB[1]) : new Date(0);
          return dateB.getTime() - dateA.getTime();
        });

        // Garder les N plus récents
        const toKeep = backups.slice(0, options.keepPerDecision || 1);

        // Supprimer les vieux
        const toDelete = backups.slice(options.keepPerDecision || 1);

        for (const backupName of toDelete) {
          const backupPath = join(rollbackDir, backupName);

          if (options.dryRun) {
            this.logger.info(`[DRY RUN] Supprimer: ${backupName}`);
          } else {
            await fs.rm(backupPath, { recursive: true, force: true });
            this.logger.info(`🗑️ Supprimé: ${backupName}`);
          }

          deleted.push(backupName);
        }

        kept.push(...toKeep);
      }

      return {
        deleted,
        kept,
        errors
      };
    } catch (error) {
      this.logger.error('Erreur cleanupOldRollbacks:', error);
      return {
        deleted: [],
        kept: [],
        errors: [`Error: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  /**
   * Valider un point de rollback
   */
  public async validateRollbackPoint(decisionId: string): Promise<{
    isValid: boolean;
    checksum?: string;
    files: string[];
    errors: string[];
  }> {
    try {
      const sharedPath = this.config.sharedPath;
      const rollbackDir = join(sharedPath, '.rollback');

      if (!existsSync(rollbackDir)) {
        return {
          isValid: false,
          checksum: undefined,
          files: [],
          errors: ['Rollback directory not found']
        };
      }

      // Trouver le rollback le plus récent pour cette décision
      const allBackups = await fs.readdir(rollbackDir);
      const matchingBackups = allBackups
        .filter(name => name.startsWith(decisionId))
        .sort()
        .reverse();

      if (matchingBackups.length === 0) {
        return {
          isValid: false,
          checksum: undefined,
          files: [],
          errors: [`No rollback found for decision ${decisionId}`]
        };
      }

      const backupPath = join(rollbackDir, matchingBackups[0]);

      if (!existsSync(backupPath)) {
        return {
          isValid: false,
          checksum: undefined,
          files: [],
          errors: [`Backup directory not found: ${backupPath}`]
        };
      }

      // Calculer le checksum actuel
      const currentChecksum = await this.calculateChecksum(backupPath);

      // Lire metadata
      const metadataPath = join(backupPath, 'metadata.json');
      let metadata: any = null;
      let files: string[] = [];

      if (existsSync(metadataPath)) {
        try {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataContent);
          files = metadata.files || [];
        } catch (error) {
          this.logger.warn(`Erreur lecture metadata: ${error}`);
        }
      } else {
        this.logger.warn(`Metadata introuvable, utilisation des fichiers par défaut`);
      }

      // Vérifier l'intégrité des fichiers
      const errors: string[] = [];
      const validFiles: string[] = [];

      for (const file of files) {
        const filePath = join(backupPath, file);

        if (!existsSync(filePath)) {
          errors.push(`File not found: ${file}`);
          continue;
        }

        try {
          const stats = await fs.stat(filePath);

          if (stats.size === 0) {
            errors.push(`Empty file: ${file}`);
            continue;
          }

          validFiles.push(file);
        } catch (error) {
          errors.push(`Error checking file ${file}: ${error}`);
        }
      }

      const isValid = errors.length === 0 && validFiles.length > 0;

      return {
        isValid,
        checksum: currentChecksum,
        files: validFiles,
        errors
      };
    } catch (error) {
      this.logger.error('Erreur validateRollbackPoint:', error);
      return {
        isValid: false,
        checksum: undefined,
        files: [],
        errors: [`Error: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }
}
