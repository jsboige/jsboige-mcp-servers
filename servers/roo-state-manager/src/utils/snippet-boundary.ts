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
	return { ok: /[.!?]["')]?\s*$/.test(body.trim()), kind: 'prose' };
}
