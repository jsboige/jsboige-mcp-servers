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
