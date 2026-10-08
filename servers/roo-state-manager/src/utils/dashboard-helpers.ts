/**
 * Helpers pour la mise à jour automatique du dashboard RooSync
 *
 * @module utils/dashboard-helpers
 * @version 1.1.0
 * @issue #546 Phase 2
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getSharedStatePath } from './shared-state-path.js';
import { getLocalMachineId } from './message-helpers.js';
import { createLogger, Logger } from './logger.js';
import { getMessageManager } from '../services/MessageManager.js';
import { tryLoadRooSyncConfig } from '../config/roosync-config.js';
import type { Mention, UserId } from '../tools/roosync/dashboard.js';

const execAsync = promisify(exec);
const logger: Logger = createLogger('DashboardHelpers');

/**
 * Interface pour les métriques GitHub Project
 */
interface GitHubProjectMetrics {
  totalItems: number;
  doneItems: number;
  inProgressItems: number;
  todoItems: number;
  openIssues: number;
}

/**
 * Récupère les métriques du GitHub Project #67 via gh CLI
 */
async function fetchGitHubProjectMetrics(): Promise<GitHubProjectMetrics | null> {
  try {
    // Récupérer les stats du Project #67
    const query = `{
      user(login: "jsboige") {
        projectV2(number: 67) {
          items(first: 1) { totalCount }
        }
      }
    }`;

    const { stdout } = await execAsync(
      `gh api graphql -f query='${query}'`,
      { encoding: 'utf8', timeout: 30000 }
    );

    const data = JSON.parse(stdout);
    const totalItems = data?.data?.user?.projectV2?.items?.totalCount || 0;

    // Compter les issues ouvertes
    const { stdout: issuesStdout } = await execAsync(
      'gh issue list --repo jsboige/roo-extensions --state open --limit 1 --json number | jq "length"',
      { encoding: 'utf8', timeout: 30000 }
    );

    const openIssues = parseInt(issuesStdout.trim(), 10) || 0;

    return {
      totalItems,
      doneItems: 0, // Non disponible sans itérer tous les items
      inProgressItems: 0,
      todoItems: 0,
      openIssues
    };
  } catch (error) {
    logger.debug('Failed to fetch GitHub metrics', { error: String(error) });
    return null;
  }
}

/**
 * Met à jour la section machine du dashboard avec une activité récente
 *
 * Cette fonction est conçue pour être appelée en fire-and-forget
 * (non bloquante) après les opérations RooSync.
 *
 * @param activity Description de l'activité (ex: "Message envoyé à myia-ai-01")
 * @param details Détails additionnels optionnels (ex: ID du message, sujet)
 */
export async function updateDashboardActivityAsync(
  activity: string,
  details?: { messageId?: string; subject?: string; [key: string]: any }
): Promise<void> {
  try {
    const sharedStatePath = getSharedStatePath();
    const dashboardPath = path.join(sharedStatePath, 'DASHBOARD.md');

    // Vérifier que le dashboard existe
    try {
      await fs.access(dashboardPath);
    } catch {
      // Le dashboard n'existe pas encore, silencieux
      logger.debug('Dashboard does not exist yet, skipping update');
      return;
    }

    const machineId = getLocalMachineId();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Construire le contenu markdown de l'activité
    const content = `#### Dernière activité (${now})
- **Action :** ${activity}
${details?.messageId ? `- **Message ID :** \`${details.messageId}\`` : ''}
${details?.subject ? `- **Sujet :** ${details.subject}` : ''}
`;

    // Lire le dashboard actuel
    const dashboardContent = await fs.readFile(dashboardPath, 'utf8');
    const lines = dashboardContent.split('\n');

    // Trouver la section de la machine
    const machineHeaderIndex = lines.findIndex(line =>
      line.includes(`### ${machineId}`)
    );

    if (machineHeaderIndex === -1) {
      // Section machine non trouvée, silencieux
      logger.debug('Machine section not found in dashboard', { machineId });
      return;
    }

    // Trouver la sous-section "roo-extensions" ou la créer après la ligne du header
    const workspace = 'roo-extensions';
    const workspaceHeaderIndex = lines.findIndex((line, idx) =>
      idx > machineHeaderIndex && line.trim().startsWith('####') && line.toLowerCase().includes(workspace.toLowerCase())
    );

    let insertIndex: number;

    if (workspaceHeaderIndex !== -1) {
      // Remplacer le contenu de la sous-section workspace
      insertIndex = workspaceHeaderIndex;
      // Supprimer les lignes existantes de la sous-section jusqu'au prochain #### ou ###
      let deleteCount = 1;
      while (
        insertIndex + deleteCount < lines.length &&
        !lines[insertIndex + deleteCount].trim().startsWith('###') &&
        !lines[insertIndex + deleteCount].trim().startsWith('##')
      ) {
        deleteCount++;
      }
      lines.splice(insertIndex, deleteCount);
    } else {
      // Créer la sous-section après le header machine
      insertIndex = machineHeaderIndex + 1;
      // Insérer un saut de ligne si nécessaire
      if (insertIndex < lines.length && lines[insertIndex].trim() !== '') {
        lines.splice(insertIndex, 0, '');
        insertIndex++;
      }
    }

    // Insérer le nouveau contenu
    lines.splice(insertIndex, 0, content);

    // Mettre à jour l'horodatage global du dashboard
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Dernière mise à jour:')) {
        lines[i] = `**Dernière mise à jour:** ${now} par ${machineId}:${workspace}`;
        break;
      }
    }

    // Écrire le dashboard mis à jour
    await fs.writeFile(dashboardPath, lines.join('\n'), 'utf8');

    logger.debug('Dashboard activity updated', { activity, machineId });
  } catch (error) {
    // Fire-and-forget : ne pas propager l'erreur
    logger.debug('Dashboard update failed (non-critical)', { error: String(error) });
  }
}

/**
 * Interface pour les mentions détectées dans les messages dashboard
 */
interface ParsedMention {
  type: 'machine' | 'agent' | 'user' | 'message';
  target: string;
  pattern: string;
}

/**
 * Forme d'un identifiant de machine de la flotte : `myia-*`.
 *
 * Mesuré le 2026-10-08 sur la liste de flotte du shared-state
 * (`.shared-state/configs/`, 8/8 répertoires machine : `myia-ai-01`,
 * `myia-po-2023..2027`, `myia-web1`, `myia-web2`).
 *
 * La validation d'id de machine de RSM (`/^[a-z0-9_-]+$/`,
 * `config/roosync-config.ts`) est bien trop lâche pour filtrer des mentions :
 * elle accepte tout token capté par le pattern catch-all `@mention` dans de la
 * prose libre — `@head`, `@main`, `@v4`, `@gmail`, `@11`, un SHA de commit,
 * `@vscode`, `@NanoClaw` — c'est-à-dire exactement la population orpheline de
 * #2591.
 *
 * Sensible à la casse, volontairement : une graphie `@Myia-Po-2027` est
 * écartée (fail-closed) plutôt que transformée en destinataire que nul inbox
 * ne lit.
 */
export const FLEET_MACHINE_PATTERN = /^myia-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Décide si un destinataire de mention peut être une machine de la flotte.
 *
 * Deux sources indépendantes, en UNION (et non en intersection) :
 *
 * 1. **La forme `myia-*`** — toujours active, aucune configuration requise.
 *    C'est le garde principal, et c'est lui qui rend la validation indépendante
 *    du partitionnement d'indexation : `ROO_FLEET_ROSTER` pilote AUSSI le
 *    partitionnement du task-space (`state.fleetRoster`, `background-services.ts`),
 *    on ne peut donc pas « corriger » les orphelines en posant la variable.
 * 2. **Le roster**, quand il est configuré — seconde voie d'acceptation, pour une
 *    machine dont l'id ne suivrait pas la convention.
 *
 * L'union est délibérée : une intersection ferait perdre des notifications
 * réelles sur un roster divergent (#2591, mesuré le 07/10 — `myia-po-2027` absent
 * du roster du projet vllm, `myia-web2` absent des deux valeurs connues).
 *
 * @issue #2591
 */
export function isFleetRecipient(machine: string, roster: string[] | null): boolean {
  if (FLEET_MACHINE_PATTERN.test(machine)) return true;
  return roster !== null && roster.includes(machine);
}

/**
 * Envoie des notifications RooSync automatiques quand un message mentionne d'autres machines/agents
 *
 * Cette fonction est fire-and-forget et n'interrompt pas le flux principal.
 *
 * @param messageId ID du message dashboard contenant les mentions
 * @param mentions Liste des mentions détectées
 * @param dashboardKey Clé du dashboard (ex: workspace-roo-extensions)
 * @param contentExcerpt Extrait du contenu du message (pour la notification)
 * @issue #1363
 */
export async function sendMentionNotificationsAsync(
  messageId: string,
  mentions: ParsedMention[],
  dashboardKey: string,
  contentExcerpt: string
): Promise<void> {
  try {
    // Grouper les mentions par machine pour envoyer un seul message par machine
    const mentionsByMachine = new Map<string, ParsedMention[]>();

    for (const mention of mentions) {
      if (mention.type === 'machine' || mention.type === 'agent') {
        // Extract machine ID: for agent types like "roo-myia-ai-01", get "myia-ai-01"
        const machine = mention.type === 'machine' ? mention.target : mention.target.split('-').slice(1).join('-');
        if (!mentionsByMachine.has(machine)) {
          mentionsByMachine.set(machine, []);
        }
        mentionsByMachine.get(machine)!.push(mention);
      }
    }

    // Construire et envoyer les notifications.
    // #2591 — validation du destinataire. Le garde d'origine était conditionné à
    // un roster configuré, donc inerte là où ROO_FLEET_ROSTER est absent : chaque
    // token de prose capté par le pattern catch-all devenait une notification
    // orpheline vers un destinataire inexistant. La garde ne dépend plus du
    // roster (cf. isFleetRecipient).
    const roster = tryLoadRooSyncConfig()?.fleetRoster ?? null;

    for (const [machine, machineMentions] of mentionsByMachine) {
      if (!isFleetRecipient(machine, roster)) {
        logger.debug('Skipping mention notification to non-fleet recipient (#2591)', {
          messageId,
          machine,
          rosterSize: roster?.length ?? null
        });
        continue;
      }

      const subject = `[MENTION] Nouveau message dashboard mentionnant @${machine}`;
      const mentionList = machineMentions
        .map(m => `- @${m.target}${m.type === 'agent' ? ' (agent)' : ''}`)
        .join('\n');

      const body = `Un message a été posté sur le dashboard mentionnant votre machine.

**Message ID:** \`${messageId}\`
**Dashboard:** ${dashboardKey}

**Mentions:**
${mentionList}

**Extrait:**
${contentExcerpt.substring(0, 200)}${contentExcerpt.length > 200 ? '...' : ''}`;

      try {
        // Appel fire-and-forget: on ne blockera pas le flux principal
        const messageManager = getMessageManager();

        // Envoyer le message RooSync de notification
        await messageManager.sendMessage(
          getLocalMachineId(),
          machine,
          subject,
          body,
          'HIGH',
          ['mention', 'notification']
        );

        logger.debug('Mention notification sent via RooSync', {
          messageId,
          machine,
          mentionCount: machineMentions.length
        });
      } catch (error) {
        logger.debug('Failed to send mention notification (non-critical)', {
          error: String(error),
          messageId,
          machine
        });
      }
    }
  } catch (error) {
    // Fire-and-forget : ne pas propager l'erreur
    logger.debug('Mention notification sending failed (non-critical)', {
      error: String(error),
      messageId
    });
  }
}

/**
 * Résout la cible d'une mention v3 en un UserId canonique.
 *
 * - Si la mention porte `userId`, on le renvoie tel quel.
 * - Si la mention porte `messageId` (format `machineId:workspace:ic-...`),
 *   on extrait les deux premiers segments comme userId (= auteur du message référencé).
 *
 * Le schéma Zod garantit qu'exactement un des deux champs est fourni (XOR refine),
 * donc cette fonction n'a pas de branche d'erreur runtime en pratique.
 *
 * @issue #1363
 */
export function resolveMentionTarget(mention: Mention): UserId {
  if (mention.userId !== undefined) {
    return mention.userId;
  }
  if (mention.messageId !== undefined) {
    // Format v3: ${machineId}:${workspace}:ic-${ts}-${rand}
    // Splitter sur les DEUX premiers ':' uniquement — le 3e segment contient lui-même des '-' voire des ':'.
    const firstColon = mention.messageId.indexOf(':');
    const secondColon = firstColon >= 0 ? mention.messageId.indexOf(':', firstColon + 1) : -1;
    if (firstColon < 0 || secondColon < 0) {
      throw new Error(`Invalid messageId format: '${mention.messageId}' (expected machineId:workspace:id)`);
    }
    return {
      machineId: mention.messageId.substring(0, firstColon),
      workspace: mention.messageId.substring(firstColon + 1, secondColon)
    };
  }
  throw new Error('Mention has neither userId nor messageId (schema XOR invariant violated)');
}

/**
 * Envoie des notifications RooSync pour des mentions v3 structurées.
 *
 * Contrairement à `sendMentionNotificationsAsync` (v1, pattern @machine parsé),
 * cette variante prend directement des UserId résolus. Une notification par
 * (machineId, workspace) distinct — le dédoublonnage par machineId seul
 * (historique pre-#1472) perdait le workspace avant la comparaison anti-auto-
 * message, bloquant à tort cross-workspace same-machine.
 *
 * Fire-and-forget : aucune erreur n'est propagée au flux principal.
 *
 * @param fromUserId   UserId de l'émetteur (auteur du message dashboard) —
 *                     machineId+workspace portés ensemble pour préserver le
 *                     workspace jusqu'au check anti-auto-message de MessageManager.
 * @param messageId    ID du message dashboard (format v3: machineId:workspace:ic-...)
 * @param targets      UserIds résolus via `resolveMentionTarget`
 * @param dashboardKey Clé du dashboard source (ex: workspace-roo-extensions)
 * @param excerpt      Extrait du contenu (tronqué à 200 chars)
 * @issue #1363 (feature), #1472 (workspace-loss fix)
 */
export async function sendStructuredMentionNotificationsAsync(
  fromUserId: UserId,
  messageId: string,
  targets: UserId[],
  dashboardKey: string,
  excerpt: string
): Promise<void> {
  try {
    // Dédupliquer par (machineId, workspace). Un message mentionnant 2 workspaces
    // sur une même machine produit 2 notifs distinctes (une par target précis).
    // Clé qualifiée = permet à MessageManager.sendMessage de comparer correctement
    // from.workspace vs to.workspace pour l'anti-auto-message.
    const byTarget = new Map<string, UserId>();
    for (const t of targets) {
      const key = `${t.machineId}:${t.workspace}`;
      if (!byTarget.has(key)) {
        byTarget.set(key, t);
      }
    }

    const messageManager = getMessageManager();
    const from = `${fromUserId.machineId}:${fromUserId.workspace}`;

    for (const [qualifiedTarget, _target] of byTarget) {
      const subject = `[MENTION] Dashboard ${dashboardKey} → ${qualifiedTarget}`;
      const body = `Un message dashboard mentionne votre userId.

**Message ID:** \`${messageId}\`
**Dashboard source:** \`${dashboardKey}\`

**UserId ciblé:**
- \`${qualifiedTarget}\`

**Extrait:**
${excerpt.substring(0, 200)}${excerpt.length > 200 ? '...' : ''}`;

      try {
        await messageManager.sendMessage(
          from,
          qualifiedTarget,
          subject,
          body,
          'HIGH',
          ['mention', 'notification', 'v3']
        );

        logger.debug('Structured mention notification sent via RooSync', {
          messageId,
          from,
          target: qualifiedTarget
        });
      } catch (error) {
        // #1472: log at WARN for non-self-message rejections so future dispatch
        // failures don't get silently swallowed like the workspace-loss bug did.
        const msg = String(error);
        const isSelfBlock = msg.includes('Auto-message interdit');
        // La méthode doit rester attachée : une référence détachée perd `this`,
        // jette TypeError depuis l'intérieur de ce catch et masque l'erreur d'origine.
        if (isSelfBlock) {
          logger.debug(
            'Failed to send structured mention notification',
            { error: msg, messageId, from, target: qualifiedTarget, selfBlock: isSelfBlock }
          );
        } else {
          logger.warn(
            'Failed to send structured mention notification',
            { error: msg, messageId, from, target: qualifiedTarget, selfBlock: isSelfBlock }
          );
        }
      }
    }
  } catch (error) {
    // Fire-and-forget — outer catch for unexpected throws (e.g. getMessageManager fails).
    logger.warn('Structured mention notification dispatch failed', {
      error: String(error),
      messageId
    });
  }
}

/**
 * Met à jour la section Métriques du dashboard avec les données GitHub
 *
 * @issue #546 Phase 2
 */
export async function updateDashboardMetricsAsync(): Promise<void> {
  try {
    const sharedStatePath = getSharedStatePath();
    const dashboardPath = path.join(sharedStatePath, 'DASHBOARD.md');

    // Vérifier que le dashboard existe
    try {
      await fs.access(dashboardPath);
    } catch {
      logger.debug('Dashboard does not exist yet, skipping metrics update');
      return;
    }

    // Récupérer les métriques GitHub
    const metrics = await fetchGitHubProjectMetrics();
    if (!metrics) {
      logger.debug('Could not fetch GitHub metrics, skipping update');
      return;
    }

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Lire le dashboard actuel
    const dashboardContent = await fs.readFile(dashboardPath, 'utf8');
    const lines = dashboardContent.split('\n');

    // Trouver la section Métriques
    const metricsHeaderIndex = lines.findIndex(line =>
      line.includes('## Métriques')
    );

    if (metricsHeaderIndex === -1) {
      logger.debug('Métriques section not found in dashboard');
      return;
    }

    // Trouver la fin de la section Métriques (prochain ##)
    let metricsEndIndex = lines.findIndex((line, idx) =>
      idx > metricsHeaderIndex && line.startsWith('##')
    );
    if (metricsEndIndex === -1) {
      metricsEndIndex = lines.length;
    }

    // Construire le nouveau contenu de la section Métriques
    const newMetricsContent = `## Métriques

| Métrique | Valeur | Source |
|----------|--------|--------|
| **GitHub Project #67** | ${metrics.totalItems} items | gh api graphql |
| **Issues ouvertes** | ${metrics.openIssues} | gh issue list |

### Dernière activité par machine

| Machine | Dernière update | Status |
|---------|----------------|--------|
| myia-ai-01 | ${now} | 🟢 |
| myia-po-2026 | ${now} | 🟢 |
| myia-web1 | - | 🟡 |
| myia-po-2023 | - | 🟡 |
| myia-po-2024 | - | 🟡 |
| myia-po-2025 | - | 🟡 |
`;

    // Remplacer la section Métriques
    const beforeMetrics = lines.slice(0, metricsHeaderIndex);
    const afterMetrics = lines.slice(metricsEndIndex);

    const newLines = [
      ...beforeMetrics,
      newMetricsContent,
      '',
      ...afterMetrics
    ];

    // Mettre à jour l'horodatage global
    const machineId = getLocalMachineId();
    for (let i = 0; i < newLines.length; i++) {
      if (newLines[i].includes('Dernière mise à jour:')) {
        newLines[i] = `**Dernière mise à jour:** ${now} par ${machineId}:roo-extensions`;
        break;
      }
    }

    // Écrire le dashboard mis à jour
    await fs.writeFile(dashboardPath, newLines.join('\n'), 'utf8');

    logger.info('Dashboard metrics updated', { totalItems: metrics.totalItems, openIssues: metrics.openIssues });
  } catch (error) {
    logger.debug('Dashboard metrics update failed (non-critical)', { error: String(error) });
  }
}
