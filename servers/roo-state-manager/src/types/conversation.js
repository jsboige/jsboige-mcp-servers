/**
 * Types pour la gestion des conversations et du stockage Roo
 * Basés sur les découvertes du stockage Roo existant
 */
// Types d'erreur spécifiques
export class RooStorageError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'RooStorageError';
    }
}
export class ConversationNotFoundError extends RooStorageError {
    constructor(taskId) {
        super(`Conversation with taskId ${taskId} not found`, 'CONVERSATION_NOT_FOUND');
    }
}
export class InvalidStoragePathError extends RooStorageError {
    constructor(path) {
        super(`Invalid storage path: ${path}`, 'INVALID_STORAGE_PATH');
    }
}
//# sourceMappingURL=conversation.js.map