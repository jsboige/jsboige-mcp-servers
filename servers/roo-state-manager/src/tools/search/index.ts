/**
 * Exports pour les outils de recherche
 */

export { searchTasksByContentTool } from './search-semantic.tool.js';
export { handleSearchTasksSemanticFallback } from './search-fallback.tool.js';
export type { SearchTasksByContentArgs } from './search-semantic.tool.js';
export type { SearchFallbackArgs } from './search-fallback.tool.js';

// CONS-11: Outil unifié consolidé
export { roosyncSearchTool, handleRooSyncSearch } from './roosync-search.tool.js';
export type { RooSyncSearchArgs } from './roosync-search.tool.js';