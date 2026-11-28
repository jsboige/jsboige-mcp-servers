/**
 * Seat adapter for `@vibesync/core/utils/shared-state-path` (#4886 S2 grain 4).
 *
 * The trunk resolves ROOSYNC_SHARED_PATH from the environment, and owns the
 * fail-closed error and the one sanctioned store-subdirectory writer. What
 * stays here is the #1628 fallback: when the variable is absent from the
 * environment, re-read this server's own `.env`. Its location — two levels
 * above this file — is seat knowledge, so it moves with neither the trunk nor
 * its tests. The reader is registered at import time, which keeps it ahead of
 * every caller without touching a single import site.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerDotenvFallback } from '@vibesync/core/utils/shared-state-path';

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
        // Silently ignore — the trunk throws its standard error below
    }
    return null;
}

registerDotenvFallback(readFromDotenv);

export * from '@vibesync/core/utils/shared-state-path';
