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

	it('prose: a cut landing on a fence line is accepted (complete line, 27/10 live datum)', () => {
		// Verbatim shape of the V3 cadence passage: prose, then a completed
		// fenced block, then the truncation marker. The last character is a
		// backtick, so the sentence-end predicate alone read FAIL even though
		// the cut respected a complete line.
		const snippet =
			"Cadence 12h (job session-only, auto-expire 7j) : pas de tir groupe aux heures communes.\n```\nCronCreate(cron: \"23 */12 * * *\", prompt: \"/coordinate\", recurring: true)\n```...";
		expect(classifySnippetShape(snippet)).toBe('prose');
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('prose');
		expect(g.ok).toBe(true);
	});

	it('prose: an embedded fenced block does NOT rescue a mid-sentence cut', () => {
		// The fence relaxation is about WHERE the cut lands, never a pass-partout.
		const snippet =
			"La cadence retenue est de 12 heures.\n```\nCronCreate(cron: \"23 */12 * * *\")\n```\nPuis le coordinateur reprend la main sur les lanes et déc...";
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('prose');
		expect(g.ok).toBe(false);
	});

	it('prose: a dangling OPENING fence is a mid-passage cut, not a boundary (ai-01 review ms#1538)', () => {
		// The block the fence opens was cut away: the passage ends on "```" with
		// nothing after. A complete line, but the start of a block, not its end.
		const snippet =
			"Cadence 12h (job session-only, auto-expire 7j), et voici la commande qui arme le cron du coordinateur :\n```\n...";
		const g = gradeSnippetBoundary(snippet);
		expect(g.kind).toBe('prose');
		expect(g.ok).toBe(false);
	});

	it('prose: a language-tagged block closed by its fence is accepted; a dangling tagged opener is not', () => {
		const closed =
			"Cadence 12h (job session-only, auto-expire 7j) : pas de tir groupe aux heures communes.\n```ts\nCronCreate({ cron: \"23 */12 * * *\" })\n```...";
		expect(classifySnippetShape(closed)).toBe('prose');
		expect(gradeSnippetBoundary(closed)).toEqual({ ok: true, kind: 'prose' });

		const dangling =
			"Cadence 12h (job session-only, auto-expire 7j), et voici la commande qui arme le cron du coordinateur :\n```ts...";
		expect(gradeSnippetBoundary(dangling)).toEqual({ ok: false, kind: 'prose' });
	});

	it('prose: the live window that STARTS inside a block and ends on its closing fence is accepted (27/10 eval datum)', () => {
		// Verbatim from the live V3 eval run: the opener lies before the snippet
		// window, so the window holds ONE fence — the closer. Odd parity alone
		// cannot tell it from a dangling opener; the block-shaped lines can.
		const snippet =
			"teur — cadence 12h (job session-only, auto-expire 7j) :\n# minute 23 : hors :00/:30, et hors du :41 des executeurs — pas de tir groupe aux heures communes.\nCronCreate(cron: \"23 */12 * * *\", prompt: \"/coordinate\", recurring: true)\n# NE PAS re-armer un ScheduleWakeup par-dessus (cron-driven).\n```...";
		expect(snippet.length).toBe(297);
		expect(gradeSnippetBoundary(snippet)).toEqual({ ok: true, kind: 'prose' });
	});

	it('prose: a lone opener after a closed block is still a dangling cut (odd parity, prose lead-in)', () => {
		const snippet =
			"La cadence retenue est de 12 heures.\n```\nCronCreate(cron: \"23 */12 * * *\")\n```\nEt voici la seconde commande, celle qui arme le cron des executeurs :\n```...";
		expect(gradeSnippetBoundary(snippet)).toEqual({ ok: false, kind: 'prose' });
	});

	it('prose: heading-led prose followed by a lone opener is a dangling cut (ai-01 re-review ms#1538)', () => {
		// `# Title` has the shape of a shell comment. Without a code line, the
		// segment cannot be read as block content, so the lone fence is an opener.
		const snippet =
			"et la suite du guide de déploiement explique la cadence :\n# Cadence du coordinateur\n# Cadence des executeurs\nLe coordinateur tire toutes les douze heures, les executeurs toutes les quatre.\n```...";
		expect(gradeSnippetBoundary(snippet)).toEqual({ ok: false, kind: 'prose' });

		const headingsOnly = "et voici les deux sections du guide, dans l'ordre du deploiement :\n# Cadence du coordinateur\n# Cadence des executeurs\n```...";
		expect(gradeSnippetBoundary(headingsOnly)).toEqual({ ok: false, kind: 'prose' });
	});

	it('prose: a block closed by a ```` or ~~~ fence is accepted; mismatched or shorter closers are not', () => {
		const lead = 'Cadence 12h (job session-only, auto-expire 7j) : pas de tir groupe aux heures communes.\n';
		const call = 'CronCreate(cron: "23 */12 * * *", prompt: "/coordinate", recurring: true)\n';
		expect(gradeSnippetBoundary(`${lead}~~~\n${call}~~~...`)).toEqual({ ok: true, kind: 'prose' });
		expect(gradeSnippetBoundary(`${lead}\`\`\`\`\n${call}\`\`\`\`...`)).toEqual({ ok: true, kind: 'prose' });
		// A ``` cannot close a ```` block (CommonMark: the closer is at least as long).
		expect(gradeSnippetBoundary(`${lead}\`\`\`\`\n${call}\`\`\`...`)).toEqual({ ok: false, kind: 'prose' });
		// ~~~ does not pair with ```: the trailing ~~~ is a lone opener after prose.
		expect(gradeSnippetBoundary(`${lead}\`\`\`\n${call}\`\`\`\nEt la suite du guide, qui reprend la cadence des executeurs :\n~~~...`)).toEqual({ ok: false, kind: 'prose' });
	});

	it('not-truncated snippets are exempt (unchanged behavior)', () => {
		const g = gradeSnippetBoundary('Un passage complet, sans troncature, qui se termine proprement.');
		expect(g.kind).toBe('not-truncated');
		expect(g.ok).toBe(true);
	});
});
