/**
 * Archive → ConversationSkeleton conversion helper.
 *
 * Issue #1244 - Couche 1.1: Multi-tier skeleton cache
 *
 * Converts an `ArchivedTask` (cross-machine archive format on GDrive) into a
 * `ConversationSkeleton` so it can be merged into the standard skeleton cache.
 *
 * The archive format is intentionally minimal (metadata + plain messages) and
 * loses tool/action structure. We surface that by marking each message as
 * `isTruncated: false` (the archive content is what we have) and producing zero
 * action metadata. The `dataSource: 'archive'` marker on the metadata lets
 * downstream tools know this skeleton came from a cold-tier source.
 */

import { ConversationSkeleton, MessageSkeleton } from '../types/conversation.js';
import { ArchivedTask } from './task-archiver/types.js';

/**
 * Convert an `ArchivedTask` (cross-machine GDrive archive) into a `ConversationSkeleton`.
 *
 * Notes:
 * - Messages keep their role/content/timestamp from the archive.
 * - `metadata.dataSource = 'archive'` flags this skeleton as cold-tier.
 * - `metadata.machineId` is preserved from the archive (cross-machine attribution).
 * - `actionCount` and `totalSize` are 0 because the archive does not contain
 *   tool/action metadata or original byte sizes.
 */
export function archiveToSkeleton(archive: ArchivedTask): ConversationSkeleton {
    const sequence: MessageSkeleton[] = (archive.messages || []).map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || archive.archivedAt,
        isTruncated: false,
    }));

    const fallbackTimestamp = archive.archivedAt;

    return {
        taskId: archive.taskId,
        parentTaskId: archive.metadata?.parentTaskId,
        isCompleted: archive.metadata?.isCompleted ?? false,
        metadata: {
            title: archive.metadata?.title,
            workspace: archive.metadata?.workspace,
            mode: archive.metadata?.mode,
            createdAt: archive.metadata?.createdAt ?? fallbackTimestamp,
            lastActivity: archive.metadata?.lastActivity ?? fallbackTimestamp,
            messageCount: archive.metadata?.messageCount ?? sequence.length,
            actionCount: 0,
            totalSize: 0,
            machineId: archive.machineId,
            source: archive.metadata?.source ?? 'roo',
            parentTaskId: archive.metadata?.parentTaskId,
            dataSource: 'archive',
        },
        sequence,
    };
}

/**
 * #3661 — Variante stub du Tier 3 : metadata seule, AUCUNE construction de
 * sequence (le mapping des messages est la partie chère — c'est elle qu'on
 * ne paie pas au cold load). Le corps se charge à la demande via
 * `SkeletonCacheService.ensureConversationHydrated()`, ou se lit en
 * différé borné via `metadata.archiveFilePath` (recherche par contenu).
 */
export function archiveToStub(archive: ArchivedTask, filePath: string): ConversationSkeleton {
    const fallbackTimestamp = archive.archivedAt;

    return {
        taskId: archive.taskId,
        parentTaskId: archive.metadata?.parentTaskId,
        isCompleted: archive.metadata?.isCompleted ?? false,
        metadata: {
            title: archive.metadata?.title,
            workspace: archive.metadata?.workspace,
            mode: archive.metadata?.mode,
            createdAt: archive.metadata?.createdAt ?? fallbackTimestamp,
            lastActivity: archive.metadata?.lastActivity ?? fallbackTimestamp,
            messageCount: archive.metadata?.messageCount ?? (archive.messages?.length ?? 0),
            actionCount: 0,
            totalSize: 0,
            machineId: archive.machineId,
            source: archive.metadata?.source ?? 'roo',
            parentTaskId: archive.metadata?.parentTaskId,
            dataSource: 'gdrive-archive',
            hydrated: false,
            archiveFilePath: filePath,
        },
        sequence: [],
    };
}
