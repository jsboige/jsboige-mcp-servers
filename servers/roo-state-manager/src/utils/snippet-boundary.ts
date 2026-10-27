/**
 * Snippet boundary grading for the eval-harness passage rubrics (Epic #2609,
 * #4105). Pure functions, no engine dependency — pinned by the unit tests in
 * src/utils/__tests__/snippet-boundary.test.ts (CI-included), because the
 * eval-harness suites themselves never run in CI (vitest.config.ci.ts
 * excludes tests/eval-harness/**): a green CI alone was not evidence for
 * this classifier (ai-01 review on ms#1404, 2026-10-08).
 *
 * Design (ai-01 review findings 1+2 on ms#1404):
 *   - classification is SHAPE-BASED on the whole snippet: a serialized
 *     payload header ([tool_result], or a leading { / [) or a majority of
 *     key-lines → structured; a majority of code-shaped lines (line ends
 *     ; { } ) or common code tokens) → code. A prose snippet that merely
 *     EMBEDS one JSON-ish member stays prose — the mid-sentence
 *     anti-vacuity case must FAIL unconditionally.
 *   - boundary contract: end-of-SENTENCE for prose (the original V3
 *     contract, unchanged); end-of-LINE for structured and code content
 *     (snapToSentence legitimately lands line boundaries for serialized
 *     content — search-semantic.tool.ts l.266/280). No runtime change:
 *     this grades what the runtime already produces.
 */

export type SnippetKind = 'not-truncated' | 'prose' | 'structured' | 'code';

/** JSON/YAML-ish member line: `"<key>":` / `key:` / `- key:`, line-anchored. */
const KEY_LINE_RE = /^\s*(-\s+)?("[^"\n]+"|[A-Za-z_][\w.]*)\s*:/;

/**
 * Code-shaped line: statement terminators (`;` `{` `}` at end of line — also
 * covers `} catch (e) {` / `try {`), common TS/JS/Py declaration keywords, or
 * operators that do not occur in prose. A bare `)` line-end is NOT here (a
 * mid-sentence prose parenthesis must not tip the vote); it is accepted at
 * boundary time once the snippet has already been classified code.
 */
const CODE_LINE_RE =
	/[;{}]\s*$|\b(?:const|let|var|function|return|import|export|class|interface|enum|def|self|public|private|static|async|await)\b|=>|===|!==/;

/**
 * Classify a snippet's content kind from its whole shape, never from the
 * presence of one embedded member (ai-01 review finding 1: prose embedding
 * `{"a": 1}` was previously misclassified structured, making the mid-sentence
 * anti-vacuity case pass).
 */
export function classifySnippetShape(snippet: string): 'structured' | 'code' | 'prose' {
	// Serialized payload: [tool_result] header or a leading { / [ — the whole
	// snippet IS a serialized document.
	if (/^\s*(\[tool_result\]|[{[])/.test(snippet)) return 'structured';
	const nonEmpty = snippet.split('\n').filter((l) => l.trim().length > 0);
	if (nonEmpty.length === 0) return 'prose';
	// Majority of key-lines → structured payload (JSON/YAML members).
	if (nonEmpty.filter((l) => KEY_LINE_RE.test(l)).length * 2 >= nonEmpty.length) return 'structured';
	// Majority of code-shaped lines → code (TS/JS without quoted keys —
	// ai-01 review finding 2: previously fell through to prose and a clean
	// line-boundary cut read FAIL).
	if (nonEmpty.filter((l) => CODE_LINE_RE.test(l)).length * 2 >= nonEmpty.length) return 'code';
	return 'prose';
}

/**
 * Grade whether a (possibly truncated) passage snippet lands on a
 * content-appropriate boundary. Truncation marker is the trailing `...`
 * produced by the passage renderer; untruncated/short snippets are exempt.
 */
export function gradeSnippetBoundary(snippet: string): { ok: boolean; kind: SnippetKind } {
	if (!snippet.endsWith('...') || snippet.length < 100) {
		return { ok: true, kind: 'not-truncated' };
	}
	const body = snippet.slice(0, -3);
	const shape = classifySnippetShape(snippet);
	if (shape === 'structured' || shape === 'code') {
		// End-of-line boundary: the cut respects complete lines/members —
		// right after a newline, or on a line/member terminator (, ; } ] )).
		// A cut in the middle of a line/member fails even for structured and
		// code content (not a pass-partout).
		const ok = /\n\s*$/.test(body) || /[,;}\])]\s*$/.test(body);
		return { ok, kind: shape };
	}
	const trimmed = body.trim();
	// A fence line is a COMPLETE line: a passage that ends there was not cut
	// mid-sentence, even though its last character is a backtick and not a full
	// stop (measured 27/10 on the cadence passage: "…(cron-driven).\n```").
	// Prose that merely EMBEDS a fenced block still has to end on the fence —
	// the anti-vacuity case (prose cut mid-sentence) is unaffected.
	if (endsOnClosingFence(trimmed)) return { ok: true, kind: 'prose' };
	return { ok: /[.!?]["')]?\s*$/.test(trimmed), kind: 'prose' };
}

/** A backtick fence line; an opening fence may carry an info string (```ts). */
const FENCE_LINE_RE = /^\s*```[^`\n]*$/;

/**
 * Line shaped like fenced-block content rather than prose: a code line
 * (CODE_LINE_RE), a `#` / `//` comment, or a bare call `Name(...)`.
 */
const BLOCK_LINE_RE = /^\s*(#|\/\/)|^\s*[\w.$]+\(.*\)\s*;?\s*$/;

/**
 * True only when the text ends on the fence that CLOSES a block (ai-01 review
 * on ms#1538): a dangling OPENING fence ("…\n```" with the block cut away)
 * is a cut in the middle of the passage, not a complete line.
 *   - A closing fence carries no info string (CommonMark), so a trailing
 *     ```ts is always an opener.
 *   - Even fence count: the trailing bare ``` pairs with an earlier opener.
 *   - Odd fence count: the snippet window may START inside a block whose
 *     opener lies before the cut — the 27/10 live datum is exactly that
 *     ("teur — cadence 12h…:\n# minute 23…\nCronCreate(…)\n# NE PAS…\n```").
 *     The trailing fence is then read as a closer only when most lines since
 *     the previous fence (or the snippet start) are block-shaped; prose
 *     followed by a lone fence is the dangling-opener shape and fails.
 */
function endsOnClosingFence(text: string): boolean {
	const lines = text.split('\n');
	if (!/^\s*```\s*$/.test(lines[lines.length - 1])) return false;
	const fenceIdx = lines.flatMap((l, i) => (FENCE_LINE_RE.test(l) ? [i] : []));
	if (fenceIdx.length % 2 === 0) return true;
	const prevFence = fenceIdx.length > 1 ? fenceIdx[fenceIdx.length - 2] : -1;
	const segment = lines.slice(prevFence + 1, -1).filter((l) => l.trim().length > 0);
	if (segment.length === 0) return false;
	const blockShaped = segment.filter((l) => BLOCK_LINE_RE.test(l) || CODE_LINE_RE.test(l)).length;
	return blockShaped * 2 > segment.length;
}
