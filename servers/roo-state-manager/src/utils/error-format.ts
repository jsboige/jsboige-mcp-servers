/**
 * Centralized error formatting for MCP tool responses.
 *
 * By default, stack traces are excluded from responses (security).
 * Set MCP_INCLUDE_STACKS=1 to include them for debugging.
 *
 * @module utils/error-format
 */

/**
 * Format an error for inclusion in an MCP tool response.
 *
 * When MCP_INCLUDE_STACKS is not set (default), returns only the error message.
 * When MCP_INCLUDE_STACKS=1, appends the stack trace for debugging.
 */
export function formatErrorForResponse(error: unknown): string {
	const msg = error instanceof Error ? error.message : String(error);

	if (process.env.MCP_INCLUDE_STACKS === '1' && error instanceof Error && error.stack) {
		return `${msg}\n\nStack:\n${error.stack}`;
	}

	return msg;
}

/**
 * Format an error for internal logging.
 *
 * Always includes the stack trace (truncated to first 3 lines) since
 * this is for developer diagnostics, not MCP responses.
 */
export function formatErrorForLog(error: unknown): {
	message: string;
	stack: string | undefined;
} {
	return {
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error
			? error.stack?.split('\n').slice(0, 3).join(' | ')
			: undefined,
	};
}

/**
 * Render a thrown value as a READABLE string for the journal (#4131).
 *
 * `String(error)` renders "[object Object]" for anything that is not an
 * Error/string/number — measured in the RSM journal (2026-11-02,
 * "sauvegarde PG impossible { "error": "[object Object]" }"): the cause
 * became unreadable exactly when it was needed. Message + code + name
 * first, then JSON.stringify as a last resort.
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) {
		const parts: string[] = [error.message];
		const code = (error as NodeJS.ErrnoException).code;
		if (code) parts.push(`code=${code}`);
		if (error.name && error.name !== 'Error') parts.push(`name=${error.name}`);
		return parts.join(' ');
	}
	if (typeof error === 'string') return error;
	if (error !== null && typeof error === 'object') {
		const e = error as { message?: unknown; code?: unknown; name?: unknown };
		if (e.message !== undefined || e.code !== undefined || e.name !== undefined) {
			const parts: string[] = [];
			if (typeof e.message === 'string') parts.push(e.message);
			if (e.code !== undefined) parts.push(`code=${String(e.code)}`);
			if (e.name !== undefined) parts.push(`name=${String(e.name)}`);
			return parts.join(' ');
		}
		try {
			return JSON.stringify(error) ?? String(error);
		} catch {
			return String(error);
		}
	}
	return String(error);
}
