/**
 * Outil MCP : roosync_harmonization — primitive campagne d'harmonisation flotte
 * Issue #3545.
 *
 * « Quelle machine n'est pas harmonisée ? » en un appel : create → dispatch →
 * (machines: apply + confirm) → remind (cadence coordinateur, idempotent) →
 * status (re-détection de drift) → close.
 *
 * Limitations assumées (docs/CLAUDE-SETTINGS-HARMONIZATION.md) :
 *  - Canon immuable : changer = nouvelle version = nouvelle campagne.
 *  - confirm/apply opèrent UNIQUEMENT sur la machine locale.
 *  - Pas de verrou distribué : mutations coordinateur sérialisées par un verrou
 *    local {id}.lock (owner/token/TTL explicite, RÉCUPÉRABLE après crash,
 *    release par token) + CAS `rev` ; contention inter-hôtes prévenue par
 *    l'ownership, best-effort documenté.
 *  - Dispatch vers sa propre machine:workspace est refusé par MessageManager
 *    (anti-auto-message) : le coordinateur apply/confirm sa machine directement.
 */

import { z } from 'zod';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { getLocalMachineId, getLocalFullId } from '../../utils/message-helpers.js';
import { getMessageManager } from '../../services/MessageManager.js';
import { ClaudeSettingsService } from '../../services/ClaudeSettingsService.js';
import {
  HarmonizationCampaignService,
  HarmonizationCampaignError,
} from '../../services/HarmonizationCampaignService.js';

export const HarmonizationArgsSchema = z.object({
  action: z.enum(['create', 'dispatch', 'remind', 'apply', 'confirm', 'status', 'list', 'close'])
    .describe('Action de campagne: create, dispatch (DM machine:workspace), remind (idempotent, cooldown), apply (canon → settings LOCAL), confirm (relit live, atteste hash), status (drift par machine), list, close'),

  campaign_id: z.string().optional()
    .describe('ID de campagne (ex: hc-claude-settings-2026.09.08-1). Requis pour tout sauf create/list'),

  // create
  target_file: z.enum(['claude-settings']).optional()
    .describe('Fichier cible. create uniquement. Seul ~/.claude/settings.json est couvert (#3545)'),
  canon: z.object({
    version: z.string().min(1).describe('Version du canon — immuable, bump pour changer'),
    mode: z.enum(['ensure-present', 'enforce-value'])
      .describe('ensure-present: préserve les clés déjà présentes localement. enforce-value: impose les valeurs'),
    keys: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe('Chemins allow-listés explicites => valeur (env.ANTHROPIC_BASE_URL, env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL, env.ANTHROPIC_CUSTOM_MODEL_OPTION, env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, env.MCP_TIMEOUT, model, modelMap.{opus,sonnet,haiku,fable} — #3545)'),
    description: z.string().optional(),
  }).optional().describe('Canon explicite (create uniquement). Clés hors allow-list ou valeurs secrètes rejetées'),
  fleet: z.array(z.string()).optional()
    .describe('Machines destinataires, "machine" ou "machine:workspace" (create uniquement)'),
  exceptions: z.record(z.string(), z.array(z.string())).optional()
    .describe('Exemptions par machine: machineId => chemins exemptés (create uniquement)'),

  // dispatch / remind / close
  force: z.boolean().optional().describe('dispatch: renvoyer malgré dispatch existant. remind: ignorer le cooldown. close: fermer sans confirmations complètes (reason requis)'),
  cooldown_hours: z.number().positive().optional().describe('remind: cooldown en heures (défaut 12) — idempotence sur la cadence coordinateur'),

  // apply
  dry_run: z.boolean().optional().describe('apply: simulation, zéro write/zéro backup (défaut false)'),
  backup: z.boolean().optional().describe('apply: backup avant write (défaut true)'),

  // confirm
  claimed_hash: z.string().optional().describe('Jamais compté comme confirmation — la relecture live prime toujours'),

  // close
  reason: z.string().optional().describe('close: motif (requis si force)'),

  // list
  include_closed: z.boolean().optional().describe('list: inclure les campagnes fermées (défaut false)'),
}).refine(
  (data) => {
    if (data.action === 'create') {
      return !!(data.target_file && data.canon && data.fleet);
    }
    if (data.action === 'list') return true;
    return !!data.campaign_id;
  },
  {
    message: "create requiert target_file + canon + fleet. Les autres actions (sauf list) requièrent campaign_id.",
  }
);

export type HarmonizationArgs = z.infer<typeof HarmonizationArgsSchema>;

/**
 * Construit le service campagne câblé sur l'environnement réel.
 * (Testable : chaque dépendance passe par ici — les tests d'intégration
 * instrumentent via ROOSYNC_SHARED_PATH + CLAUDE_SETTINGS_PATH.)
 */
async function buildService(): Promise<HarmonizationCampaignService> {
  const sharedStatePath = getSharedStatePath(); // throw si absent => fail closed
  const settingsPath = new ClaudeSettingsService().getPath();
  const messageManager = getMessageManager();
  const service = new HarmonizationCampaignService({
    sharedStatePath,
    machineId: getLocalMachineId(),
    settingsPath,
    fromFullId: getLocalFullId(),
    sendMessage: async (from, to, subject, body, priority, tags, threadId) => {
      const msg = await messageManager.sendMessage(from, to, subject, body, priority, tags, threadId);
      return { id: msg.id };
    },
  });
  return service;
}

export async function roosyncHarmonization(args: HarmonizationArgs): Promise<Record<string, unknown>> {
  let service: HarmonizationCampaignService;
  try {
    service = await buildService();
  } catch (err) {
    return {
      status: 'error',
      error: `Initialisation impossible (fail closed): ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Vérifier ROOSYNC_SHARED_PATH (racine shared accessible) — aucune opération campagne sans store.',
    };
  }

  try {
    switch (args.action) {
      case 'create': {
        const record = await service.createCampaign({
          targetFile: args.target_file!,
          canon: args.canon!,
          fleet: args.fleet!,
          exceptions: args.exceptions,
        });
        return {
          status: 'success',
          message: `Campagne ${record.id} créée (canon v${record.canon.version}, hash ${record.canon.hash.slice(0, 8)}…, fleet ${record.fleet.length}). Prochaine étape: action "dispatch".`,
          campaign: record,
        };
      }
      case 'dispatch': {
        const result = await service.dispatch(args.campaign_id!, { force: args.force });
        return {
          status: result.failures.length > 0 ? 'partial' : 'success',
          message: `Dispatch: ${result.sent.length} envoyé(s), ${result.skipped.length} ignoré(s), ${result.failures.length} échec(s).`,
          ...result,
        };
      }
      case 'remind': {
        const result = await service.remind(args.campaign_id!, {
          cooldownHours: args.cooldown_hours,
          force: args.force,
        });
        return {
          status: result.failures.length > 0 ? 'partial' : 'success',
          message: `Relances: ${result.sent.length} envoyée(s), ${result.skipped.length} ignorée(s) (confirmées/cooldown), ${result.failures.length} échec(s). Échecs jamais marqués envoyés.`,
          ...result,
        };
      }
      case 'apply': {
        const result = await service.apply(args.campaign_id!, {
          dryRun: args.dry_run,
          backup: args.backup,
        });
        return {
          status: 'success',
          message: args.dry_run
            ? `Dry-run ${args.campaign_id}: ${result.changes.filter(c => c.action === 'set').length} clé(s) seraient posées, ${result.skipped.length} ignorée(s). Aucun write.`
            : `Canon appliqué (${args.campaign_id}): ${result.changes.filter(c => c.action === 'set').length} clé(s) posée(s), ${result.skipped.length} ignorée(s)${result.backupPath ? `, backup: ${result.backupPath}` : ''}. Confirmer avec action "confirm".`,
          ...result,
        };
      }
      case 'confirm': {
        const result = await service.confirm(args.campaign_id!, { claimedHash: args.claimed_hash });
        return {
          status: result.status,
          message: `Confirmation ${args.campaign_id} [${result.status}]: ${result.detail}`,
          observedHash: result.observedHash,
        };
      }
      case 'status': {
        const result = await service.status(args.campaign_id!);
        return {
          status: 'success',
          message: `Campagne ${args.campaign_id}: ${result.summary.confirmed}/${result.summary.fleet} confirmées, ${result.summary.drifted} en drift, ${result.summary.unknown} état inconnu. ${result.summary.allConfirmed ? 'Flotte harmonisée — close possible.' : 'Machines en attente: relancer action "remind".'}`,
          summary: result.summary,
          machines: result.machines,
          canon: { version: result.campaign.canon.version, hash: result.campaign.canon.hash, mode: result.campaign.canon.mode },
        };
      }
      case 'list': {
        const records = await service.listCampaigns(args.include_closed);
        return {
          status: 'success',
          message: `${records.length} campagne(s) ${args.include_closed ? '(toutes)' : '(actives)'}.`,
          campaigns: records.map(r => ({
            id: r.id,
            status: r.status,
            targetFile: r.targetFile,
            canonVersion: r.canon.version,
            fleet: r.fleet.length,
            createdAt: r.createdAt,
          })),
        };
      }
      case 'close': {
        const record = await service.close(args.campaign_id!, { force: args.force, reason: args.reason });
        return {
          status: 'success',
          message: `Campagne ${record.id} fermée${record.closeReason ? ` (${record.closeReason})` : ''}.`,
          closedAt: record.closedAt,
        };
      }
      default:
        throw new HarmonizationCampaignError(`Action inconnue: ${String((args as any).action)}`, 'INVALID_ACTION');
    }
  } catch (err) {
    if (err instanceof HarmonizationCampaignError) {
      return { status: 'error', error: err.message, code: err.code, details: err.details };
    }
    return {
      status: 'error',
      error: `Erreur harmonization (${args.action}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}