import { z } from 'zod';

/**
 * Types de messages basés sur roo-code/packages/types/src/message.ts
 * Documentation: docs/roo-code/ui-messages-deserialization.md lignes 109-176
 */

// Type "ask" - 12 variantes supportées (doc ligne 109-122)
export const clineAskSchema = z.enum([
  'followup',                    // Question de clarification
  'command',                     // Permission d'exécuter commande
  'command_output',              // Permission de lire output
  'completion_result',           // Tâche terminée
  'tool',                        // Permission d'utiliser un outil (🔴 IMPORTANT pour newTask)
  'api_req_failed',              // Échec API, retry?
  'resume_task',                 // Confirmation de reprise
  'resume_completed_task',       // Reprise tâche complétée
  'mistake_limit_reached',       // Trop d'erreurs
  'browser_action_launch',       // Permission navigateur
  'use_mcp_server',              // Permission MCP
  'auto_approval_max_req_reached' // Limite auto-approval
]);

// Type "say" - 30 variantes supportées (doc ligne 150-176)
export const clineSaySchema = z.enum([
  'error',                       // Erreur générale
  'api_req_started',             // 🔴 Requête API initiée (CRITIQUE pour extraction)
  'api_req_finished',            // Requête API terminée
  'api_req_retried',             // Retry requête API
  'api_req_retry_delayed',       // Retry retardé
  'api_req_deleted',             // Requête annulée
  'text',                        // Texte simple
  'reasoning',                   // Raisonnement interne
  'completion_result',           // Résultat final
  'user_feedback',               // Feedback utilisateur
  'user_feedback_diff',          // Diff de feedback
  'command_output',              // Output de commande
  'shell_integration_warning',   // Avertissement shell
  'browser_action',              // Action navigateur
  'browser_action_result',       // Résultat action navigateur
  'mcp_server_request_started',  // Requête MCP initiée
  'mcp_server_response',         // Réponse MCP
  'subtask_result',              // Résultat sous-tâche
  'checkpoint_saved',            // Checkpoint sauvegardé
  'rooignore_error',             // Erreur .rooignore
  'diff_error',                  // Erreur diff
  'condense_context',            // Condensation contexte
  'condense_context_error',      // Erreur condensation
  'codebase_search_result',      // Résultats recherche
  'user_edit_todos'              // Édition todos utilisateur
]);

/**
 * Structure principale ClineMessage
 * Basé sur roo-code documentation lignes 22-38
 */
export const uiMessageSchema = z.object({
  ts: z.number(),                                      // Timestamp
  type: z.union([z.literal('ask'), z.literal('say')]), // Type de message
  ask: clineAskSchema.optional(),                      // Type de question
  say: clineSaySchema.optional(),                      // Type de déclaration
  text: z.string().optional(),                         // Contenu textuel ou JSON stringifié
  images: z.array(z.string()).optional(),              // Images encodées
  partial: z.boolean().optional(),                     // Message en cours de streaming
  reasoning: z.string().optional(),                    // Raisonnement interne
  conversationHistoryIndex: z.number().optional(),     // Index dans l'historique
});

/**
 * Type inféré pour UIMessage
 */
export type UIMessage = z.infer<typeof uiMessageSchema>;

/**
 * Type pour ClineAsk
 */
export type ClineAsk = z.infer<typeof clineAskSchema>;

/**
 * Type pour ClineSay
 */
export type ClineSay = z.infer<typeof clineSaySchema>;

/**
 * Types pour extraction d'informations structurées
 * Documentation: docs/roo-code lignes 290-332
 */

/**
 * Structure d'un tool call parsé depuis ask:tool
 * Doc ligne 339-344
 */
export interface ToolCallInfo {
  tool: string;
  mode?: string;
  message?: string;
  content?: string;  // Alias pour message (compatibilité)
  timestamp: number;
}

/**
 * Structure d'une nouvelle tâche extraite depuis tool:newTask
 * Doc ligne 494-510
 */
export interface NewTaskInfo {
  mode: string;
  message: string;
  timestamp: number;
}

/**
 * Structure d'une API request parsée depuis say:api_req_started
 * Doc ligne 180-195
 */
export interface ApiReqInfo {
  request?: string;              // Contenu de la requête
  cost?: number;                 // Coût estimé
  cancelReason?: string | null;  // Raison d'annulation
  streamingFailedMessage?: string; // Message d'erreur streaming
}

/**
 * Structure d'un message tool parsé (JSON imbriqué dans text)
 */
export interface ToolMessage {
  tool: string;
  mode?: string;
  message?: string;
  content?: string;
}

/**
 * Structure d'un message followup parsé
 */
export interface FollowupMessage {
  question: string;
  follow_up?: string[];
}