/**
 * Boundary-aware pattern matching, shared by the indexing error classifier
 * (`services/background-services.ts`) and the garbage scanner
 * (`tools/indexing/garbage-scanner.ts`).
 *
 * A bare status code ('401', '503', '502'…) must stand alone: indexing messages
 * quote the task id, and a UUID segment such as `e4d401c6` or `-401fe026` would
 * match '401' as a substring. #4352: three indexing timeouts and one IIS 502
 * were dead-lettered as `auth_failed` because of exactly that. Textual patterns
 * keep the plain substring match.
 *
 * Extracted verbatim from `background-services.ts` (#4352 g2) so that the
 * scanner and the classifier cannot drift apart — the scanner used to call
 * `content.includes('502')` directly, which is the same trap.
 */
export function matchesPattern(message: string, pattern: string): boolean {
    if (/^\d+$/.test(pattern)) {
        return new RegExp(`(?<![0-9a-z])${pattern}(?![0-9a-z])`).test(message);
    }
    return message.includes(pattern);
}
