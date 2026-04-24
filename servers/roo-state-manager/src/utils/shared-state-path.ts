/**
 * Shared state path utility — Extracted to break ESM circular dependency cycles.
 *
 * Previously in server-helpers.ts, which caused 19+ cycles:
 *   server-helpers → tools/index barrel → roosync/* → server-helpers
 *
 * #1110 FIX: Isolated to its own module with ZERO project imports.
 * This breaks ALL cycles through the roosync/* → server-helpers edge.
 * #1628 FIX: Added .env file fallback for resilience when env var is missing
 * (e.g., Roo MCP config doesn't pass ROOSYNC_SHARED_PATH in its env section).
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Try to read ROOSYNC_SHARED_PATH from .env file as fallback (#1628) */
function readFromDotenv(): string | null {
    const envPath = join(__dirname, '..', '..', '.env');
    try {
        if (!existsSync(envPath)) return null;
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed) continue;
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;
            const key = trimmed.slice(0, eqIndex).trim();
            if (key !== 'ROOSYNC_SHARED_PATH') continue;
            let value = trimmed.slice(eqIndex + 1).trim();
            // Strip surrounding quotes
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            return value || null;
        }
    } catch {
        // Silently ignore — will throw the standard error below
    }
    return null;
}

/**
 * Get the RooSync shared state directory path from environment.
 *
 * Resolution order:
 * 1. process.env.ROOSYNC_SHARED_PATH (set by config or dotenv)
 * 2. .env file fallback (#1628)
 *
 * @throws {Error} If ROOSYNC_SHARED_PATH cannot be resolved
 * @returns {string} The path to the shared-state directory
 */
export function getSharedStatePath(): string {
    if (process.env.ROOSYNC_SHARED_PATH) {
        return process.env.ROOSYNC_SHARED_PATH;
    }

    // #1628: Fallback to .env file when env var is not set
    const fromDotenv = readFromDotenv();
    if (fromDotenv) {
        process.env.ROOSYNC_SHARED_PATH = fromDotenv;
        return fromDotenv;
    }

    throw new Error(
        'ROOSYNC_SHARED_PATH environment variable is not set. ' +
        'This variable is required to prevent file pollution in the repository. ' +
        'Please set ROOSYNC_SHARED_PATH to your Google Drive shared state path.'
    );
}
