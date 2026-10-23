/**
 * #4090 — intercomMessageFingerprint: the parse-stable identity of id-less
 * messages. External watchdog scripts (embedding/vllm_watchdog.ps1) append
 * `### [ts] machine|workspace` blocks straight into the dashboard file with
 * NO `[msg:]` line; parseDashboardMarkdown synthesizes a fresh id for them
 * on every parse. The fingerprint must be stable across parses of the same
 * block (that is its whole job) and discriminate distinct messages.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDashboardMarkdown,
  intercomMessageFingerprint,
} from '../dashboard-markdown.js';

const FILE = (block: string) => `---
type: global
key: global
lastModified: '2026-10-06T09:40:00.000Z'
lastModifiedBy:
  machineId: test
  workspace: test
totalMessages: 1
---

## Status

s

## Intercom

${block}
`;

const WATCHDOG_BLOCK = `### [2026-10-06T09:40:21.509Z] myia-ai-01|qdrant-watchdog

**[ERROR][WATCHDOG] Backend embeddings DOWN — chemin semantique fleet coupe. Qdrant: UP**
`;

describe('intercomMessageFingerprint (#4090)', () => {
  it('is stable across parses of the same id-less block while the synthesized id is not', () => {
    const d1 = parseDashboardMarkdown(FILE(WATCHDOG_BLOCK), 'global');
    const d2 = parseDashboardMarkdown(FILE(WATCHDOG_BLOCK), 'global');
    expect(d1.intercom.messages).toHaveLength(1);
    expect(d2.intercom.messages).toHaveLength(1);
    const [m1] = d1.intercom.messages;
    const [m2] = d2.intercom.messages;
    expect(m1.id).not.toBe(m2.id); // the defect: id churns per parse
    expect(intercomMessageFingerprint(m1)).toBe(intercomMessageFingerprint(m2));
  });

  it('discriminates timestamp, author and content', () => {
    const base = {
      timestamp: '2026-10-06T09:40:21.509Z',
      author: { machineId: 'myia-ai-01', workspace: 'qdrant-watchdog' },
      content: 'DOWN',
    };
    const fp = intercomMessageFingerprint(base);
    expect(intercomMessageFingerprint({ ...base, timestamp: '2026-10-06T09:40:21.510Z' })).not.toBe(fp);
    expect(intercomMessageFingerprint({ ...base, author: { machineId: 'myia-ai-01', workspace: 'vllm-watchdog' } })).not.toBe(fp);
    expect(intercomMessageFingerprint({ ...base, content: 'DOWN2' })).not.toBe(fp);
  });
});
