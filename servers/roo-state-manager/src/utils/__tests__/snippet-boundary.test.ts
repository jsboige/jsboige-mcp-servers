/**
 * Unit pin of the snippet boundary classifier (Epic #2609 rubric (a), #4105).
 *
 * CI-included on purpose: the eval-harness suites that consume the classifier
 * never run in CI (vitest.config.ci.ts excludes tests/eval-harness/**), and
 * the green CI was therefore not evidence for it — the prose anti-vacuity
 * bypass (ai-01 review finding 1 on ms#1404) is exactly what this gate now
 * catches.
 *
 * Pins, so the structured/code relaxation can never degenerate into "any
 * truncated snippet passes":
 *   - prose cut mid-sentence FAILs — unconditionally, including prose that
 *     merely embeds a JSON-ish member (finding 1);
 *   - structured cut in the middle of a member FAILs;
 *   - code cut mid-line FAILs, code cut on a clean line boundary passes
 *     (finding 2);
 *   - not-truncated snippets are exempt.
 */

import { describe, it, expect } from 'vitest';
import { classifySnippetShape, gradeSnippetBoundary } from '../snippet-boundary.js';

const memberLines =
	'"search_timestamp": "2026-09-29T22:51:16.389Z",\n"query": "coordinator cron cadence decision 3h deep dispatch",\n';

describe('snippet boundary classifier (rubric (a) anti-vacuity, pure unit)', () => {
	it('structured: JSON member-line cut is accepted (the ai-01 daily-run datum)', () => {
		const snippet = '[tool_result] ' + memberLines.repeat(2) + '...';
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('structured');
		expect(g.ok).toBe(true);
	});

	it('structured: cut in the MIDDLE of a member still fails (not a pass-partout)', () => {
		const snippet = '[tool_result] ' + memberLines + '"search_timestamp": "2026-09-29T22:51:16.3...';
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('structured');
		expect(g.ok).toBe(false);
	});

	it('prose: mid-sentence cut still FAILS (anti-vacuity — the original contract)', () => {
		const base =
			"La cadence du coordinateur a été mesurée sur trois semaines complètes avant arbitrage final et validation par l'utilisateur. ";
		const snippet =
			base.repeat(2) +
			'Les résultats montrent une économie de tokens significative sans perte de couverture des lanes, ce qui a conduit à la déc...';
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('prose');
		expect(g.ok).toBe(false);
	});

	it('prose: sentence-end cut passes', () => {
		const base =
			"La cadence du coordinateur a été mesurée sur trois semaines complètes avant arbitrage final et validation par l'utilisateur. ";
		const snippet = base.repeat(3).trimEnd() + '...';
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('prose');
		expect(g.ok).toBe(true);
	});

	it('prose: an embedded JSON-ish member does NOT reclassify the snippet (ai-01 review finding 1)', () => {
		// Verbatim shape of the review's probe: prose that merely contains
		// a JSON-ish member — previously matched the "at least one JSON
		// member" predicate, was classified structured, and a mid-sentence
		// cut after a comma read PASS. Shape-based classification keeps it
		// prose, so the cut must FAIL.
		const snippet =
			'La décision de cadence a été arbitrée après mesure complète du coût par cycle, par exemple {"a": 1} dans le relevé, puis validée par les sept lanes concernées avant application, sauf...';
		expect(classifySnippetShape(snippet)).toBe('prose');
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('prose');
		expect(g.ok).toBe(false);
	});

	it('code: clean line-boundary cut is accepted (ai-01 review finding 2)', () => {
		// TS without quoted keys — previously classified prose, so a cut on a
		// clean line terminator read FAIL.
		const snippet =
			'export function resolveCollection(path: string): string {\n  const hash = sha256(path).slice(0, 12);\n  const variant = wsPrefix + hash;\n...';
		expect(classifySnippetShape(snippet)).toBe('code');
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('code');
		expect(g.ok).toBe(true);
	});

	it('code: mid-line cut still FAILS', () => {
		const snippet =
			'export function resolveCollection(path: string): string {\n  const hash = sha256(path).slice(0, 12);\n  const variant = wsPrefix + ha...';
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('code');
		expect(g.ok).toBe(false);
	});

	it('not-truncated snippets are exempt (unchanged behavior)', () => {
		const g = gradeSnippetBoundary('Un passage complet, sans troncature, qui se termine proprement.');
		expect(g.kind).toBe('not-truncated');
		expect(g.ok).toBe(true);
	});
});
