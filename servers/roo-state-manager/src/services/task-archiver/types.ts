/**
 * Types pour l'archivage cross-machine des taches sur GDrive
 * Format agnostique Roo/Claude pour partage inter-machines
 *
 * Format versions
 * ---------------
 * v1 (deprecated — still readable):
 *   - Messages tronques a 10KB chacun ("MAX_CONTENT_LENGTH" + "[... truncated ...]")
 *   - Perte des tool results volumineux
 *   - Introduit par commit 8af5dc6f (2026-03-12) sans demande utilisateur
 *
 * v2 (current — writers only produce this):
 *   - Messages complets, aucune troncature
 *   - Les tool results volumineux sont preserves integralement
 *   - La taille sur GDrive peut etre significativement plus grande, mais l'utilisateur
 *     a explicitement confirme ne pas avoir de contrainte d'espace sur GDrive.
 *
 * Soft transition
 * ---------------
 * Les readers tolerent v1 et v2 transparents. Les writers produisent toujours v2.
 * Le code de skip-if-exists est remplace par upgrade-if-v1 : quand on re-archive une
 * tache, si le fichier existant est v1, il est ecrase par v2. Si v2, il est conserve.
 * Une migration batch (voir TaskArchiver.migrateV1Archives) permet de forcer la mise
 * a niveau au rythme choisi par l'utilisateur.
 */

export type ArchiveFormatVersion = 1 | 2;
export const ARCHIVE_CURRENT_VERSION: ArchiveFormatVersion = 2;

export interface ArchivedTaskMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}

export interface ArchivedTaskMetadata {
    title: string;
    workspace?: string;
    mode?: string;
    createdAt?: string;
    lastActivity?: string;
    messageCount: number;
    isCompleted: boolean;
    parentTaskId?: string;
    /**
     * Source de la tâche: "roo" pour tâches Roo, "claude-code" pour sessions Claude Code
     */
    source?: 'roo' | 'claude-code';
}

export interface ArchivedTask {
    version: ArchiveFormatVersion;
    taskId: string;
    machineId: string;
    hostIdentifier: string;
    archivedAt: string;
    metadata: ArchivedTaskMetadata;
    messages: ArchivedTaskMessage[];
}
