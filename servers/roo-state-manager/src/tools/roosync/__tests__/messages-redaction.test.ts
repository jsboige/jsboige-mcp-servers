/**
 * End-to-end tests for #3584 — secret redaction at the RooSync messages publication boundary.
 *
 * Validates that `roosyncSend` (action send / reply / amend) traverses `redactMessageForPublication`
 * in `tools/roosync/send.ts` BEFORE invoking `MessageManager.sendMessage` or `amendMessage`.
 *
 * Three angles tested:
 *   1. Form auto-descriptive (`sk-`, `ghp_`, `Bearer …`) → masked at the boundary.
 *   2. Bare value matching `process.env` (FORM_LAYER_MARKER misses; createKnownValueMasker catches) → masked.
 *   3. Benign content → unchanged (cost = 0 on the common path; no false positives).
 *
 * Companion to `dashboard-secret-redaction.test.ts` for the dashboard side and
 * `utils/__tests__/secret-redaction.test.ts` for the unit-level redactor semantics.
 *
 * Harness mirrors `send.smoke.test.ts`: store pointed at a tempdir, MessageManager mocked
 * at the module boundary so we can intercept `sendMessage` and read the actual payload.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Captured payloads from each call to MessageManager.sendMessage / amendMessage. */
const sendCalls: Array<{ from: string; to: string; subject: string; body: string }> = [];
const amendCalls: Array<{ messageId: string; newContent: string }> = [];

vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => ({
      // For action='send' / 'reply' (full signature of MessageManager.sendMessage)
      sendMessage: vi.fn(async (from: string, to: string, subject: string, body: string) => {
        sendCalls.push({ from, to, subject, body });
        return {
          id: 'mock-msg-id',
          from, to, subject,
          body,
          priority: 'MEDIUM',
          timestamp: new Date().toISOString(),
          tags: []
        };
      }),
      // For action='amend' — note: real signature has fewer params but we only check new_content
      amendMessage: vi.fn(async (messageId: string, senderId: string, newContent: string) => {
        amendCalls.push({ messageId, newContent });
        return {
          message_id: messageId,
          amended_at: new Date().toISOString(),
          reason: 'mock',
          original_content_preserved: true
        };
      }),
      // Other methods called by send.ts / replyToMessage — stubs to keep the router alive
      getMessage: vi.fn(async () => null),
      updateMessageAttachments: vi.fn(async () => true),
    }),
  };
});

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
}));

vi.mock('../../../utils/dashboard-helpers.js', () => ({
  updateDashboardActivityAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../services/lazy-roosync.js', () => ({
  getRooSyncService: vi.fn(async () => ({
    getHeartbeatService: () => ({
      registerHeartbeat: vi.fn().mockResolvedValue(undefined)
    })
  }))
}));

import { roosyncSend } from '../send.js';

describe('MESSAGES-REDACTION (#3584 — canal DM RooSync)', () => {
  const testMessagesPath = mkdtempSync(path.join(os.tmpdir(), 'messages-redaction-'));
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    sendCalls.length = 0;
    amendCalls.length = 0;
    originalEnv = { ...process.env };
    process.env.ROOSYNC_SHARED_PATH = testMessagesPath;
    process.env.ROOSYNC_MACHINE_ID = 'redaction-test-sender';
    process.env.ROOSYNC_WORKSPACE_ID = 'redaction-test-ws';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    rmSync(testMessagesPath, { recursive: true, force: true });
  });

  // ---------- Form auto-descriptive (FORM_LAYER_MARKER) ----------

  it('masque une clé `sk-…` dans le body d\'un send', async () => {
    await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: 'Test',
      body: 'Here is the key: sk-proj-abcdef1234567890XYZABCDEF1234567890XYZABC'
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body).not.toContain('sk-proj-abcdef');
    expect(sendCalls[0].body).toMatch(/<redacted[^>]*>/);
  });

  it('masque un token `ghp_…` dans le subject', async () => {
    // Pattern exige ≥ 36 chars alphanum après `ghp_` — on respecte le seuil.
    const token = 'ghp_' + 'a'.repeat(40);
    await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: `Rotation: ${token}`,
      body: 'Some benign body without secrets.'
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].subject).not.toContain(token);
    expect(sendCalls[0].subject).toMatch(/<redacted[^>]*>/);
  });

  it('masque un header `Bearer …` dans le body', async () => {
    await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: 'Test',
      body: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature'
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body).not.toContain('eyJhbGciOiJIUzI1NiI');
    expect(sendCalls[0].body).toMatch(/<redacted[^>]*>/);
  });

  it('masque `API_KEY=<value>` dans le body', async () => {
    await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: 'Test',
      body: 'API_KEY=ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789'
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body).not.toContain('ABCDEF0123456789');
    expect(sendCalls[0].body).toMatch(/<redacted[^>]*>/);
  });

  // ---------- Valeur connue du process (createKnownValueMasker) ----------

  it('masque une valeur présente dans process.env même sans contexte syntaxique', async () => {
    // Simulate a secret that lives in the process env — bare 64-hex, no `sk-` / `Bearer` / etc.
    const knownSecret = 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567';
    process.env.EMBEDDINGS_API_KEY = knownSecret;

    await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: 'Test',
      body: `Consumer still uses ${knownSecret} — needs migration.`
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body).not.toContain(knownSecret);
    expect(sendCalls[0].body).toMatch(/<redacted[^>]*>/);
  });

  // ---------- amend ----------

  it('masque une clé `sk-…` dans le new_content d\'un amend', async () => {
    // reply flow needs an existing message; we mock getMessage to return one so that amend
    // can proceed past the lookup. amend path does NOT call getMessage (separate route).
    await roosyncSend({
      action: 'amend',
      message_id: 'mock-original-msg',
      new_content: 'Corrected value: sk-proj-fixedABCDEF0123456789XYZ',
      reason: 'typo fix'
    });

    expect(amendCalls).toHaveLength(1);
    expect(amendCalls[0].newContent).not.toContain('sk-proj-fixed');
    expect(amendCalls[0].newContent).toMatch(/<redacted[^>]*>/);
  });

  // ---------- Faux positifs : pas de masquage inutile ----------

  it('NE masque PAS un body sans secret (coût = 0 sur le chemin commun)', async () => {
    const benignBody = 'Coordination entre po-2025 et po-2026 sur la tâche #3584.\nProchaine étape : PR vers main.';
    const result = await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: '[INFO] PR #3584',
      body: benignBody
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body).toBe(benignBody);
    // Should NOT contain any redaction marker
    expect(sendCalls[0].body).not.toMatch(/<redacted/i);
  });

  it('NE masque PAS un hex court (32 chars) hors du FORM_LAYER_MARKER et hors process.env', async () => {
    // 32 hex chars — too short to trigger the form pattern (sk-/ghp-/Bearer) and not in env
    const shortHex = 'abcdef0123456789abcdef0123456789';
    expect(shortHex).not.toContain('sk-');
    expect(shortHex).not.toContain('ghp_');

    const result = await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: 'Test',
      body: `Hash observed: ${shortHex}`
    });

    expect(sendCalls).toHaveLength(1);
    // Either unchanged (no known value, no form pattern) — what we expect here
    expect(sendCalls[0].body).toBe(`Hash observed: ${shortHex}`);
  });

  // ---------- Idempotence : le call ne se trompe pas de champs ----------

  it('masque UNIQUEMENT le body quand seul le body contient un secret', async () => {
    const benignSubject = '[INFO] Coordination';
    const secretBody = 'API_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    await roosyncSend({
      action: 'send',
      to: 'myia-po-2026',
      subject: benignSubject,
      body: secretBody
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].subject).toBe(benignSubject); // sujet intact
    expect(sendCalls[0].body).not.toContain('0123456789abcdef0123456789abcdef');
  });
});
