/**
 * Server Capabilities — Degraded mode tracking for MCP server resilience.
 *
 * #1635: Instead of crashing when env vars are missing, the server tracks
 * which capabilities are degraded and tools return meaningful errors.
 * #1918: Runtime degradation for GDrive disconnects — markDegraded/recover
 * can be called at any time, not just at startup.
 *
 * ZERO imports (avoids ESM cycles, safe to import from index.ts at startup).
 */

export type Capability = 'sharedPath' | 'qdrant' | 'embeddings';

interface DegradedEntry {
    capability: Capability;
    reason: string;
    since: Date;
}

/** I/O error codes that indicate shared filesystem (GDrive) is unavailable. */
const SHARED_PATH_IO_CODES = new Set([
    'EIO', 'ENODEV', 'ENOTCONN', 'ESHAREDDIRNOTFOUND',
    'ECONNREFUSED', 'ENOSHARE', 'ENOTEMPTY',
]);

class ServerCapabilities {
    private static instance: ServerCapabilities | null = null;
    private degraded: Map<Capability, DegradedEntry> = new Map();

    private constructor() {}

    static getInstance(): ServerCapabilities {
        if (!ServerCapabilities.instance) {
            ServerCapabilities.instance = new ServerCapabilities();
        }
        return ServerCapabilities.instance;
    }

    /** Mark a capability as degraded with a human-readable reason. */
    markDegraded(capability: Capability, reason: string): void {
        this.degraded.set(capability, {
            capability,
            reason,
            since: new Date(),
        });
    }

    /**
     * #1918: Recover a previously degraded capability (e.g., GDrive reconnects).
     * Returns true if the capability was actually degraded.
     */
    recover(capability: Capability): boolean {
        return this.degraded.delete(capability);
    }

    /** Check if a capability is available (not degraded). */
    isAvailable(capability: Capability): boolean {
        return !this.degraded.has(capability);
    }

    /** Get the degradation reason for a capability, or null if available. */
    getDegradedReason(capability: Capability): string | null {
        return this.degraded.get(capability)?.reason ?? null;
    }

    /** Get all degraded capabilities. */
    getAllDegraded(): DegradedEntry[] {
        return Array.from(this.degraded.values());
    }

    /** Check if the server is running in any degraded mode. */
    isDegraded(): boolean {
        return this.degraded.size > 0;
    }

    /** Generate a human-readable report of degraded capabilities. */
    getReport(): string {
        if (this.degraded.size === 0) {
            return 'All capabilities available';
        }
        const lines = Array.from(this.degraded.values()).map(
            (e) => `  - ${e.capability}: ${e.reason}`
        );
        return `Degraded capabilities (${this.degraded.size}):\n${lines.join('\n')}`;
    }

    /** Reset for testing. */
    reset(): void {
        this.degraded.clear();
    }
}

/**
 * #1918: Check if an error is a shared-path I/O error (GDrive offline).
 * Used by the uncaughtException handler to avoid killing the process
 * when GDrive disconnects.
 */
export function isSharedPathError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeJS.ErrnoException;
    if (err.code && SHARED_PATH_IO_CODES.has(err.code)) return true;
    const msg = err.message || '';
    if (msg.includes('ROOSYNC_SHARED_PATH')) return true;
    if (msg.includes('EIO') || msg.includes('ENODEV') || msg.includes('GDrive')) return true;
    return false;
}

/** Convenience singleton accessor. */
export function getServerCapabilities(): ServerCapabilities {
    return ServerCapabilities.getInstance();
}

export { ServerCapabilities };
