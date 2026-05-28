/**
 * #2352: Task-space partitioning for Qdrant indexing.
 *
 * Hash-based consistent partition: each machine in the fleet is responsible
 * for only its shard of the task-space, eliminating N× embedding redundancy.
 *
 * The fleet roster is configured via the `ROO_FLEET_ROSTER` env var
 * (comma-separated, sorted alphabetically). Each machine must have the same
 * roster value — mismatch means some tasks fall through the cracks.
 *
 * ## Roster change migration
 *
 * Changing `ROO_FLEET_ROSTER` (adding/removing machines) shifts ALL hash
 * buckets: previously-owned tasks become unowned and vice-versa. After a
 * roster change, each machine MUST perform a full reindex:
 * 1. Update ROO_FLEET_ROSTER on ALL machines simultaneously
 * 2. Restart all MCP instances (new roster takes effect at startup)
 * 3. Run `roosync_indexing(action: "rebuild")` on each machine — this will
 *    index the new shard and skip the old one automatically
 */

/**
 * FNV-1a 32-bit hash — fast, deterministic, good distribution for short strings.
 * Returns an unsigned 32-bit integer.
 */
export function fnv1a32(input: string): number {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime
	}
	return hash >>> 0; // unsigned
}

/**
 * Parse the fleet roster from the `ROO_FLEET_ROSTER` env var.
 * Returns a sorted array of machine IDs, or `null` if not configured
 * (in which case partition is disabled and every machine indexes everything).
 */
export function parseFleetRoster(envValue: string | undefined): string[] | null {
	if (!envValue || envValue.trim() === '') return null;
	const machines = envValue
		.split(',')
		.map(s => s.trim().toLowerCase())
		.filter(s => s.length > 0);
	if (machines.length === 0) return null;
	return [...new Set(machines)].sort();
}

/**
 * Determine which machine in the roster "owns" a given task.
 * Returns the machine ID from the roster, or `null` if no roster.
 */
export function getTaskOwner(taskId: string, roster: string[] | null): string | null {
	if (!roster || roster.length === 0) return null;
	const hash = fnv1a32(taskId);
	return roster[hash % roster.length];
}

/**
 * Check whether the current machine should index a given task.
 * Returns `true` if:
 *  - no roster is configured (partition disabled — all machines index everything)
 *  - this machine owns the task's hash bucket
 */
export function shouldIndexTask(
	taskId: string,
	currentMachineId: string,
	roster: string[] | null,
): boolean {
	if (!roster || roster.length === 0) return true;
	return getTaskOwner(taskId, roster) === currentMachineId;
}
