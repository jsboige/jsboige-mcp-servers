/**
 * #4352 crit.4 — `describeIndexOutcome` must NAME why a pass wrote nothing.
 *
 * Measured need (ai-01, 28/10 ~13:50Z): a live `--index` answered
 * « **Chunks indexés:** 0 » and the crit.4 probe read it as an indexing FAILURE,
 * exiting 2 with nothing measured. The answer could not distinguish four very
 * different situations, and the probe had no way to tell "already indexed for
 * this task" (a success, ms#1557) from "nothing extracted" (a real content gap).
 *
 * These cases are the contract of that discrimination.
 */

import { describe, test, expect } from 'vitest';
import { describeIndexOutcome, type IndexTaskStats } from '../VectorIndexer.js';

function stats(over: Partial<IndexTaskStats> = {}): IndexTaskStats {
	return {
		chunksExtracted: 0,
		subChunksBuilt: 0,
		dedupSkipped: 0,
		pointsIndexed: 0,
		missingVectors: 0,
		...over
	};
}

describe('describeIndexOutcome (#4352 crit.4)', () => {
	test('points written: reports the count, no apology', () => {
		expect(describeIndexOutcome(stats({ chunksExtracted: 3, subChunksBuilt: 9, pointsIndexed: 7 })))
			.toBe('7 point(s) écrit(s)');
	});

	test('everything deduplicated: says it was ALREADY indexed for this task', () => {
		// The ms#1557 case that made a live re-index answer 0 on ai-01.
		const msg = describeIndexOutcome(stats({ chunksExtracted: 12, subChunksBuilt: 30, dedupSkipped: 30 }));
		expect(msg).toContain('déjà indexé');
		expect(msg).toContain('30/30');
	});

	test('nothing extracted: names the extraction gap, not a dedup', () => {
		const msg = describeIndexOutcome(stats());
		expect(msg).toContain('aucun chunk extrait');
		expect(msg).not.toContain('déjà indexé');
	});

	test('chunks extracted but none usable: a THIRD case, distinct from empty', () => {
		const msg = describeIndexOutcome(stats({ chunksExtracted: 4, subChunksBuilt: 0 }));
		expect(msg).toContain('4 chunk(s) extrait(s)');
		expect(msg).toContain('aucun contenu non vide');
	});

	test('embedding holes: reports the failure, and it wins over the dedup wording', () => {
		const msg = describeIndexOutcome(stats({
			chunksExtracted: 5, subChunksBuilt: 5, dedupSkipped: 0, missingVectors: 5
		}));
		expect(msg).toContain('sans vecteur');
		expect(msg).toContain('5');
	});

	test('partial dedup with nothing written does not claim "already indexed" wholesale', () => {
		const msg = describeIndexOutcome(stats({ chunksExtracted: 2, subChunksBuilt: 10, dedupSkipped: 4 }));
		expect(msg).toContain('4/10');
		expect(msg).not.toContain('tout était déjà indexé');
	});
});
