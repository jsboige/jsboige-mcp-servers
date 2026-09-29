/**
 * Workspace matching strategies (#1244 Couche 2.2).
 *
 * Extracted from list-conversations.tool.ts (#1394) so the unified header
 * pipeline and the legacy tool share ONE definition of each strategy.
 *
 * - 'exact'      : comparaison stricte après normalisation de chemin.
 * - 'normalized' : match basename tolerant cross-machine (défaut).
 * - 'substring'  : test includes lowercasé, pour recherches exploratoires.
 */

import { normalizePath } from './path-normalizer.js';
import { normalizeWorkspaceId } from './message-helpers.js';

export function matchesWorkspace(
    skeletonWorkspace: string | undefined,
    queryWorkspace: string,
    strategy: 'exact' | 'normalized' | 'substring' = 'normalized'
): boolean {
    if (!skeletonWorkspace) return false;
    if (strategy === 'exact') {
        return normalizePath(skeletonWorkspace) === normalizePath(queryWorkspace);
    }
    if (strategy === 'substring') {
        return skeletonWorkspace.toLowerCase().includes(queryWorkspace.toLowerCase());
    }
    // 'normalized' (default)
    return normalizeWorkspaceId(skeletonWorkspace) === normalizeWorkspaceId(queryWorkspace);
}
