/**
 * #4131 B17 — applyReadTracking, extracted from MessageManager.
 *
 * WHY here: the scheduled workers must mark a served [TASK] read for THEIR OWN
 * reader identity (a bare machine id, no workspace) through the same PG
 * per-reader path the MCP `mark_read` uses. That path lives in
 * roosync-channel-read.ts, which cannot import MessageManager (cycle:
 * MessageManager → unified-store → MessageManager). The tracking semantics
 * move to this leaf module — imported by BOTH — so the MCP tool and the CLI
 * cannot diverge. MessageManager.applyReadTracking stays as a delegating
 * wrapper; its behaviour is unchanged, byte-for-byte the same logic.
 *
 * This is the WRITE-side twin of perReaderStatus (message-helpers.ts): that
 * function decides how a reader SEES a message, this one records that the
 * reader has seen it.
 */

import { createLogger, Logger } from './logger.js';
import {
  parseMachineWorkspace,
  matchesRecipient,
  normalizeWorkspaceId,
  canonicalizeFullId,
  isMachineWideTarget,
} from './message-helpers.js';

const logger: Logger = createLogger('ReadTracking');

/**
 * Track a read by one reader on an in-memory message (#629 per-machine,
 * #3960 per-workspace, #2287 guards), mutating `message` in place.
 *
 * Semantics (unchanged from MessageManager.applyReadTracking):
 *   - reader with workspace, message targeted at another workspace → REJECTED
 *   - reader who is neither the recipient nor a destruct-authorized reader → REJECTED
 *   - broadcast ("all")            → `read_by` += reader machine
 *   - machine-wide ("machine" alone) → `read_by` += machine, AND
 *     `read_by_workspace` += machine:workspace when the reader has one
 *   - anything else (targeted at this reader) → global `status` flip
 * A workspace-less reader on a machine-wide target falls back to the global
 * flip: per-workspace tracking cannot represent them, and the message must
 * still be able to clear.
 *
 * @param message Message to mutate (read_by / read_by_workspace / status)
 * @param readerId Reader identity — bare machine or machine:workspace
 * @returns true when the tracking was applied, false when a guard rejected it
 */
export function applyReadTracking(
  message: { to: string; status?: string; read_by?: string[]; read_by_workspace?: string[]; id?: string; destruct_after_read_by?: string[]; acknowledged_at?: Record<string, string> },
  readerId?: string
): boolean {
  if (readerId) {
    // #2287: Workspace guard — reject if reader's workspace doesn't match message target
    const readerParsed = parseMachineWorkspace(readerId);
    const isBroadcast = message.to === 'all' || message.to === 'All';
    if (!isBroadcast && readerParsed.workspaceId) {
      const msgTo = message.to;
      // Only check workspace when message targets a specific workspace
      const targetParsed = parseMachineWorkspace(msgTo);
      if (targetParsed.workspaceId) {
        if (normalizeWorkspaceId(readerParsed.workspaceId) !== normalizeWorkspaceId(targetParsed.workspaceId)) {
          logger.warn(`Workspace mismatch: reader ${readerId} tried to mark message for ${msgTo} — rejected`);
          return false;
        }
      }
    }

    const readerMachineId = readerParsed.machineId;
    const readerWorkspaceId = readerParsed.workspaceId;

    // #2287: Verify the caller has access to this message before marking read.
    // Allow if: matches recipient OR is in destruct_after_read_by (auto-destruct authorized reader)
    const isRecipient = matchesRecipient(message.to, readerMachineId, readerWorkspaceId);
    const isAuthorizedReader = message.destruct_after_read_by?.includes(readerMachineId) ?? false;
    if (!isRecipient && !isAuthorizedReader) {
      logger.warn(`markAsRead denied: message ${message.id} targets ${message.to}, reader is ${readerId}`);
      return false;
    }

    if (!message.read_by) {
      message.read_by = [];
    }
    if (!message.read_by.includes(readerMachineId)) {
      message.read_by.push(readerMachineId);
    }
    if (!message.acknowledged_at) {
      message.acknowledged_at = {};
    }
    if (!message.acknowledged_at[readerMachineId]) {
      message.acknowledged_at[readerMachineId] = new Date().toISOString();
    }
    logger.info(`Reader ${readerMachineId} tracked in read_by (${message.read_by.length} readers)`);

    // Machine-wide target: also track the READER'S WORKSPACE, so the other
    // workspaces of the same machine keep seeing the message as unread.
    if (isMachineWideTarget(message.to) && readerWorkspaceId) {
      if (!message.read_by_workspace) {
        message.read_by_workspace = [];
      }
      const fullReader = canonicalizeFullId(readerMachineId + ':' + readerWorkspaceId);
      if (!message.read_by_workspace.includes(fullReader)) {
        message.read_by_workspace.push(fullReader);
      }
    }
  }

  // For workspace-targeted messages, set global status to 'read'.
  // Two classes keep status as-is because their readers are tracked individually:
  //   - broadcasts ("all"/"All")     -> read_by, per machine (#629)
  //   - machine-wide ("myia-ai-01")  -> read_by_workspace, per workspace
  // A global flip on either would hide the message from readers who never saw it.
  const isBroadcast = message.to === 'all' || message.to === 'All';
  const machineWide = isMachineWideTarget(message.to);
  // A reader without a workspace cannot be tracked per workspace: fall back to
  // the global flip so the message can still be cleared at all.
  const trackedPerWorkspace =
    machineWide && !!parseMachineWorkspace(readerId ?? '').workspaceId;
  if (!isBroadcast && !trackedPerWorkspace) {
    message.status = 'read';
  }
  return true;
}
