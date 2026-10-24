/**
 * #4335 (grain 1) — deterministic-prune unit tests.
 *
 * The contract under test: pruning extracts closed fenced code blocks >= the
 * byte threshold into a side-store and replaces them with pointer lines;
 * restoration is byte-exact; anything not extracted is passed through
 * untouched. A pointer without a side-store entry fails LOUD.
 */
import { describe, expect, it } from 'vitest';

import {
  deterministicPrune,
  restoreFromSideStore,
  type PruneableMessage,
} from '../deterministic-prune.js';

/** Build a fenced block whose body pads it to exactly `totalBytes`. */
const fenceOfBytes = (totalBytes: number, lang = 'bash'): string => {
  const markers = '```' + lang + '\n' + '```';
  const bodyLen = Math.max(0, totalBytes - markers.length - 1);
  return '```' + lang + '\n' + 'x'.repeat(bodyLen) + '\n```';
};

const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('deterministicPrune — extraction', () => {
  it('extracts a block at/above the threshold and replaces it with one pointer line', () => {
    const block = fenceOfBytes(300);
    const content = `avant\n${block}\naprès`;
    const res = deterministicPrune([{ id: 'm1', content }], { minBlockBytes: 200 });

    expect(res.stats.extractedCount).toBe(1);
    expect(res.prunedMessages[0].content.split('\n')).toEqual([
      'avant',
      expect.stringMatching(/^\[pruned:dp-[0-9a-f]{8} 300o code-block side-store#4335\]$/),
      'après',
    ]);
    expect(res.sideStore[0].original).toBe(block);
    expect(res.sideStore[0].bytes).toBe(300);
  });

  it('keeps a below-threshold block verbatim (boundary: 199 stays, 200 goes)', () => {
    // '```\n' + body + '\n```' — fixed overhead 8 bytes, body length exact.
    const mkExact = (n: number): string => '```\n' + 'y'.repeat(n - 8) + '\n```';
    const small = mkExact(199);
    const atThreshold = mkExact(200);
    expect(byteLen(small)).toBe(199);
    expect(byteLen(atThreshold)).toBe(200);

    const res = deterministicPrune(
      [{ id: 'm', content: `${small}\n---\n${atThreshold}` }],
      { minBlockBytes: 200 }
    );
    // The 199-byte block and the separator survive verbatim; the 200-byte one is pruned.
    expect(res.prunedMessages[0].content).toContain(small);
    expect(res.prunedMessages[0].content).not.toContain(atThreshold);
    expect(res.stats.extractedCount).toBe(1);
  });

  it('does NOT extract an unclosed fence (malformed markdown is never lost)', () => {
    const content = 'text\n```bash\nnever closed ' + 'z'.repeat(500);
    const res = deterministicPrune([{ id: 'm', content }], { minBlockBytes: 200 });
    expect(res.stats.extractedCount).toBe(0);
    expect(res.prunedMessages[0].content).toBe(content);
  });

  it('handles adjacent fences with nothing but a newline between them', () => {
    const a = fenceOfBytes(220);
    const b = fenceOfBytes(240);
    const res = deterministicPrune([{ id: 'm', content: `${a}\n${b}` }], { minBlockBytes: 200 });
    expect(res.stats.extractedCount).toBe(2);
    // Two distinct contents -> two distinct pointer ids.
    expect(new Set(res.sideStore.map((e) => e.pointerId)).size).toBe(2);
  });

  it('deduplicates identical blocks into one side-store entry referenced twice', () => {
    const block = fenceOfBytes(400);
    const res = deterministicPrune(
      [
        { id: 'a', content: block },
        { id: 'b', content: `lead\n${block}` },
      ],
      { minBlockBytes: 200 }
    );
    expect(res.stats.extractedCount).toBe(1); // one ENTRY
    const pointerLines = res.prunedMessages.flatMap((m) =>
      m.content.split('\n').filter((l) => l.startsWith('[pruned:dp-'))
    );
    expect(pointerLines).toHaveLength(2); // two POINTERS
  });

  it('never grows content: pointer replaces the block only when strictly smaller', () => {
    // A 200-byte block: pointer (~50 bytes) is smaller -> pruned. The guard
    // `bytes <= pointerLine.length` is exercised via the threshold test above;
    // here we assert the invariant outputBytes < inputBytes whenever anything
    // was extracted, and stats arithmetic is internally consistent.
    const res = deterministicPrune(
      [{ id: 'm', content: `x\n${fenceOfBytes(500)}\ny` }],
      { minBlockBytes: 200 }
    );
    expect(res.stats.outputBytes).toBeLessThan(res.stats.inputBytes);
    expect(res.stats.reductionBytes).toBe(res.stats.inputBytes - res.stats.outputBytes);
    expect(res.stats.sideStoreBytes).toBe(500);
    expect(res.stats.reductionPct).toBeGreaterThan(0);
  });
});

describe('deterministicPrune — purity and idempotence', () => {
  it('does not mutate its input', () => {
    const content = `a\n${fenceOfBytes(300)}\nb`;
    const input: PruneableMessage[] = [{ id: 'm', content }];
    const copy = JSON.parse(JSON.stringify(input));
    deterministicPrune(input, { minBlockBytes: 200 });
    expect(input).toEqual(copy);
  });

  it('is idempotent: pruning pruned content changes nothing', () => {
    const once = deterministicPrune([{ id: 'm', content: `a\n${fenceOfBytes(300)}\nb` }], {
      minBlockBytes: 200,
    });
    const twice = deterministicPrune(once.prunedMessages, { minBlockBytes: 200 });
    expect(twice.prunedMessages).toEqual(once.prunedMessages);
    expect(twice.sideStore).toEqual([]);
    expect(twice.stats.reductionBytes).toBe(0);
  });

  it('leaves fence-free content byte-identical', () => {
    const content = 'plain coordination prose\nno fences at all\n';
    const res = deterministicPrune([{ id: 'm', content }]);
    expect(res.prunedMessages[0].content).toBe(content);
    expect(res.stats).toMatchObject({ extractedCount: 0, reductionBytes: 0, reductionPct: 0 });
  });
});

describe('restoreFromSideStore — lossless round-trip', () => {
  const cases: Record<string, string> = {
    'no fences': 'just prose\nand more prose',
    'below threshold': fenceOfBytes(50),
    'above threshold': `intro\n${fenceOfBytes(350)}\noutro`,
    'unclosed fence': `open\n\`\`\`js\n${'u'.repeat(600)}`,
    'crlf line endings': `line1\r\n\`\`\`bash\r\n${'c'.repeat(400)}\r\n\`\`\`\r\nline2`,
    'fence with lang and blank lines': '```\n\n\n' + 'k'.repeat(260) + '\n\n```',
    'indented fence': '  ```\n  ' + 'i'.repeat(280) + '\n  ```',
    'empty content': '',
    'only a fence': fenceOfBytes(210),
    'multi-byte utf8 body': '```json\n{"clé": "' + 'é'.repeat(150) + '"}\n```',
  };

  for (const [name, content] of Object.entries(cases)) {
    it(`round-trips byte-exactly: ${name}`, () => {
      const res = deterministicPrune([{ id: 'm1', content }], { minBlockBytes: 200 });
      const restored = restoreFromSideStore(res.prunedMessages, res.sideStore);
      expect(restored[0].content).toBe(content);
      expect(restored[0].id).toBe('m1');
    });
  }

  it('round-trips a realistic multi-message intercom slice', () => {
    const messages: PruneableMessage[] = [
      { id: 'i1', content: '[DONE] cycle done, PR merged `8e665b7e`' },
      {
        id: 'i2',
        content: `probe output:\n\`\`\`\n${'P'.repeat(900)}\n\`\`\`\nconclusion after`,
      },
      { id: 'i3', content: '```short\nx\n```' },
      {
        id: 'i4',
        content: `\`\`\`json\n{"a": "${'v'.repeat(600)}"}\n\`\`\`\n\`\`\`\n${'w'.repeat(310)}\n\`\`\``,
      },
    ];
    const res = deterministicPrune(messages, { minBlockBytes: 200 });
    expect(res.stats.extractedCount).toBeGreaterThanOrEqual(2);
    const restored = restoreFromSideStore(res.prunedMessages, res.sideStore);
    expect(restored).toEqual(messages);
  });

  it('THROWS on a pointer whose side-store entry is missing', () => {
    const res = deterministicPrune([{ id: 'm', content: fenceOfBytes(300) }], {
      minBlockBytes: 200,
    });
    expect(() => restoreFromSideStore(res.prunedMessages, [])).toThrow(/not recoverable/);
  });
});
