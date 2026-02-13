/**
 * Exports pour les outils de gestion du storage
 */

// CONS-13: Nouvel outil consolidé
export { storageInfoTool, handleStorageInfo } from './storage-info.js';
export type { StorageInfoArgs, StorageInfoAction } from './storage-info.js';

// [DEPRECATED] Anciens outils conservés pour backward compatibility
export { detectStorageTool } from './detect-storage.tool.js';
export { getStorageStatsTool } from './get-stats.tool.js';