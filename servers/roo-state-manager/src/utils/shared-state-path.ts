/**
 * Shared state path utility — Extracted to break ESM circular dependency cycles.
 *
 * Previously in server-helpers.ts, which caused 19+ cycles:
 *   server-helpers → tools/index barrel → roosync/* → server-helpers
 *
 * #1110 FIX: Isolated to its own module with ZERO imports.
 * This breaks ALL cycles through the roosync/* → server-helpers edge.
 */

/**
 * Get the RooSync shared state directory path from environment.
 *
 * @throws {Error} If ROOSYNC_SHARED_PATH is not set
 * @returns {string} The path to the shared-state directory
 */
export function getSharedStatePath(): string {
    if (!process.env.ROOSYNC_SHARED_PATH) {
        throw new Error(
            'ROOSYNC_SHARED_PATH environment variable is not set. ' +
            'This variable is required to prevent file pollution in the repository. ' +
            'Please set ROOSYNC_SHARED_PATH to your Google Drive shared state path.'
        );
    }
    return process.env.ROOSYNC_SHARED_PATH;
}
