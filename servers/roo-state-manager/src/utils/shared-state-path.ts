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
 * #1918 FIX: Added tryGetSharedStatePath() for runtime callers that should
 * degrade gracefully instead of crashing when GDrive disconnects.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createLogger } from './logger.js';

// Lazily created: `createLogger` probes its log directory at construction
// (logger.ts ensureLogDirectory → existsSync), which must not fire at module
// import — the shared-state-path coverage test mocks existsSync to throw and
// only exercises the accessor functions. Instantiating here would EACCES.
let subdirLogger: ReturnType<typeof createLogger> | undefined;
function getSubdirLogger() {
    if (!subdirLogger) subdirLogger = createLogger('ensureStoreSubdir');
    return subdirLogger;
}

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

/**
 * #1918: Safe variant that returns null instead of throwing.
 * Use in runtime code paths (heartbeat intervals, background services)
 * where a missing/offline path should degrade rather than crash.
 */
export function tryGetSharedStatePath(): string | null {
    try {
        return getSharedStatePath();
    } catch {
        return null;
    }
}

/**
 * #1918: Check if the shared path is currently accessible (GDrive online).
 * Lightweight probe — just tests directory existence, no writes.
 */
export function isSharedPathAccessible(): boolean {
    const sharedPath = tryGetSharedStatePath();
    if (!sharedPath) return false;
    try {
        return existsSync(sharedPath);
    } catch {
        return false;
    }
}

/**
 * #4293 follow-up (po-2028 + po-2023, 30/10) — WHICH half actually failed.
 *
 * The fail-closed error used to assert, in every case, that the shared store
 * was "absent du système de fichiers" and to send the reader after the DriveFS
 * mount. Two of its raise sites never checked the store at all: the PG-primary
 * route (the PG half did not answer) and the host scan-lock contention (a
 * neighbour process holds the G: scan lock). Measured 30/10 on po-2027: the
 * store was readable and writable (`roosync_diagnose(env)` →
 * `sharedState: {exists: true, writable: true}`) while the inbox read failed
 * closed with that message — two lanes on two seats nearly "repaired" a
 * healthy directory because of it.
 *
 * The cause is the truth the message is built from:
 *   - `store-absent`         — the G: root really is unreadable (checked);
 *   - `pg-unavailable`       — PostgreSQL did not answer, and under
 *                               CHANNEL_PG_PRIMARY the G: fallback is forbidden
 *                               (#4131 B16). The store is NOT the cause;
 *   - `scan-lock-contended`  — a neighbouring RSM process holds the host G:
 *                               scan lock and this seat has no warm cache.
 */
export type SharedStoreInaccessibleCause =
    | 'store-absent'
    | 'pg-unavailable'
    | 'scan-lock-contended'
    | 'store-unresponsive';

/**
 * Render the fail-closed message from the cause. Kept out of the constructor
 * so the wording of each cause is testable on its own.
 */
function renderSharedStoreInaccessibleMessage(
    storePath: string | null,
    pgReadFailed: boolean,
    cause: SharedStoreInaccessibleCause
): string {
    const pathLabel = storePath ? ` (${storePath})` : ' (variable non définie)';

    // #4293 follow-up (reviews 30/10): the message asserts only what the probe
    // established — the store ROOT EXISTS (existsSync) — never that the volume
    // is responsive; and every rendering ends with a machine-readable
    // `(cause=…)` token so the discriminator crosses the MCP boundary without
    // any agent having to parse French prose.
    if (cause === 'pg-unavailable') {
        return (
            `ROOSYNC_SHARED_PATH${pathLabel} : la moitié PostgreSQL n'a pas répondu et, sous CHANNEL_PG_PRIMARY, ` +
            `le repli Google Drive est interdit (#4131 B16). La racine du store G: a été trouvée présente ` +
            `(existence vérifiée à l'instant — sa réactivité n'a pas été mesurée) ; cette lecture ne l'a pas consultée. ` +
            `Toute lecture est interrompue (fail-closed). (cause=pg-unavailable)`
        );
    }

    if (cause === 'scan-lock-contended') {
        return (
            `ROOSYNC_SHARED_PATH${pathLabel} : un autre processus RSM de ce poste tient le verrou de scan G: (inbox-pool) ` +
            `et ce siège n'a pas de cache chaud. Le store G: n'est PAS en cause — ne cherchez pas le montage du lecteur. ` +
            `Toute lecture est interrompue (fail-closed). (cause=scan-lock-contended)`
        );
    }

    if (cause === 'store-unresponsive') {
        return (
            `ROOSYNC_SHARED_PATH${pathLabel} : le store G: n'a pas répondu dans le délai imparti (volume muet) — ` +
            `il n'est pas forcément absent, et son absence n'est pas établie. ` +
            `Toute lecture est interrompue (fail-closed). (cause=store-unresponsive)`
        );
    }

    return (
        `ROOSYNC_SHARED_PATH inaccessible${pathLabel} : le magasin partagé RooSync est absent du système de fichiers. ` +
        `Toute lecture est interrompue (fail-closed) — vérifiez le montage du lecteur.` +
        (pgReadFailed
            // #4293: the store was already absent, and the PG half did not
            // serve the read either — both halves are down, so the caller
            // must not read the result as "nothing to show".
            ? ` La lecture PostgreSQL de secours n'a rien rendu non plus : aucune des deux moitiés du magasin ne peut servir cette lecture.`
            : '') +
        ` (cause=store-absent)`
    );
}

/**
 * #3459: Signals that the RooSync shared store cannot be reached, so every
 * read must fail-closed instead of rendering an indistinguishable "empty".
 *
 * `path` is null when ROOSYNC_SHARED_PATH could not be resolved at all
 * (env var unset and no .env fallback); otherwise it is the raw path string
 * that pointed at a non-existent directory (e.g. `G:\...` when G: is down).
 */
export class SharedStoreInaccessibleError extends Error {
    readonly code = 'ROOSYNC_STORE_INACCESSIBLE';
    constructor(
        readonly storePath: string | null,
        readonly pgReadFailed = false,
        readonly cause: SharedStoreInaccessibleCause = 'store-absent'
    ) {
        super(renderSharedStoreInaccessibleMessage(storePath, pgReadFailed, cause));
        this.name = 'SharedStoreInaccessibleError';
    }
}

/**
 * #3459: Throws {@link SharedStoreInaccessibleError} when the RooSync shared
 * store root is not readable (unset, or the directory does not exist on disk).
 *
 * This is the fail-closed guard placed at the entry of every read tool and of
 * the create-when-missing paths. It must be called in preference to letting a
 * `readFile`/`readdir` catch render a phony "empty" collection.
 *
 * @returns The resolved shared path, when the store is reachable.
 */
export function assertSharedStoreAccessible(): string {
    const sharedPath = tryGetSharedStatePath();
    if (!sharedPath) {
        throw new SharedStoreInaccessibleError(null);
    }
    try {
        if (!existsSync(sharedPath)) {
            throw new SharedStoreInaccessibleError(sharedPath);
        }
    } catch (err) {
        if (err instanceof SharedStoreInaccessibleError) throw err;
        throw new SharedStoreInaccessibleError(sharedPath);
    }
    return sharedPath;
}

/**
 * #3459: Outcome of a store-subdirectory bootstrap. A literal union on
 * purpose — "skipped-store-absent" must stay unreadable as success by the
 * first `if` that consumes it (same reserve as MessageManager.bootstrapStatus).
 */
export type StoreSubdirStatus = 'ensured' | 'skipped-store-absent';

/**
 * #3459 (arbitrage ai-01, option b): the ONLY sanctioned way to create a
 * directory under the RooSync shared store root. Every direct
 * `mkdirSync/mkdir(join(<store root>, …))` outside this helper can recreate
 * the root on a fresh process and silently disarm all the
 * `assertSharedStoreAccessible` tool guards — the exact hole #1103/#1112
 * closed for the bootstrap writers. A structural test
 * (`fail-closed-store-structural.test.ts`) fails the build if a raw mkdir
 * taking a store-root-derived path appears outside this module.
 *
 * Never throws for an absent root: skip + WARN carrying the RESOLVED path
 * (fail-closed lane — the tool-level guards own the throwing). mkdir errors
 * on a present root propagate as they would have at the call site.
 */
export function ensureStoreSubdir(root: string, ...segments: string[]): StoreSubdirStatus {
    const target = segments.length > 0 ? join(root, ...segments) : root;
    if (!existsSync(root)) {
        getSubdirLogger().warn(
            `[ensureStoreSubdir] Racine du magasin RooSync ABSENTE — création IGNORÉE (fail-closed #3459). ` +
            `Aucun répertoire créé sous : ${target}. ` +
            `Vérifiez le montage du lecteur ou créez la racine avant toute écriture.`
        );
        return 'skipped-store-absent';
    }
    mkdirSync(target, { recursive: true });
    return 'ensured';
}
