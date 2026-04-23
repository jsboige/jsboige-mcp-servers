/**
 * Server Capabilities — Degraded mode tracking for MCP server resilience.
 *
 * #1635: Instead of crashing when env vars are missing, the server tracks
 * which capabilities are degraded and tools return meaningful errors.
 *
 * ZERO imports (avoids ESM cycles, safe to import from index.ts at startup).
 */

export type Capability = 'sharedPath' | 'qdrant' | 'embeddings';

interface DegradedEntry {
	capability: Capability;
	reason: string;
	since: Date;
}

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

/** Convenience singleton accessor. */
export function getServerCapabilities(): ServerCapabilities {
	return ServerCapabilities.getInstance();
}

export { ServerCapabilities };
