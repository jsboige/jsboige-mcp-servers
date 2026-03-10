/**
 * Exports pour les outils de gestion du storage
 */

// CONS-13: Nouvel outil consolidé
export { storageInfoTool, handleStorageInfo } from './storage-info.js';
export type { StorageInfoArgs, StorageInfoAction } from './storage-info.js';

// [DEPRECATED] Anciens outils conservés pour backward compatibility
export { detectStorageTool } from './detect-storage.tool.js';
// #519: get_storage_stats retiré (remplacé par roosync_storage_management action='stats')