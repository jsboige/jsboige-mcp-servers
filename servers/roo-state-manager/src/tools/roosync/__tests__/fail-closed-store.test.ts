/**
 * #3459 — Contrôle positif (fail-closed) : magasin RooSync ABSENT.
 *
 * Quand ROOSYNC_SHARED_PATH pointe vers un chemin inexistant (lecteur G: non
 * monté, magasin déconnecté), CHAQUE lecture d'outil doit échouer avec une
 * erreur explicite nommant ROOSYNC_SHARED_PATH et son état — jamais rendre une
 * collection vide indiscernable d'un magasin réellement vide.
 *
 * Ce test doit ROUGIR sur le code antérieur à #3459 : l'ancien code retournait
 * `success:true` + `dashboards: []` (list), « Dashboard introuvable » (read),
 * « Aucun message » (inbox), « Message introuvable » (get_message),
 * « Aucune pièce jointe » (attachments).
 *
 * @module tests/roosync/fail-closed-store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { roosyncDashboard } from '../dashboard.js';
import { roosyncRead } from '../read.js';
import { getMessage } from '../get_message.js';
import { roosyncListAttachments } from '../roosync-attachments.tool.js';
import { MessageManager } from '../../../services/MessageManager.js';
import { registerMachineId } from '../../../config/roosync-config.js';
import { Logger } from '../../../utils/logger.js';

// #858 / #864: these modules import a chat client for LLM condensation; keep it
// inert so a read/list failing on the guard never needs (and never touches) it.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

// A path guaranteed to be absent on disk — whatever the machine / mount state.
// A unique per-run suffix means no previous run (or leftover state) can have
// created it: `existsSync` is `false`, so the fail-closed guard is exercised.
const MISSING_STORE = path.join(
  path.resolve(os.tmpdir(), `roosync-failclosed-test-${Date.now()}-${process.pid}`),
  'shared-state'
);

describe('roosync fail-closed when store is absent (#3459)', () => {
  beforeEach(() => {
    process.env.ROOSYNC_SHARED_PATH = MISSING_STORE;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_API_BASE_URL;
  });

  afterEach(() => {
    delete process.env.ROOSYNC_SHARED_PATH;
    delete process.env.ROOSYNC_MACHINE_ID;
    delete process.env.ROOSYNC_WORKSPACE_ID;
  });

  it('dashboard list fails (not an empty dashboards array)', async () => {
    const result = await roosyncDashboard({ action: 'list' });
    expect(result.success).toBe(false);
    expect(String((result as any).message)).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect((result as any).dashboards).toEqual([]);
  });

  it('dashboard read fails (not "Dashboard introuvable / utilisez createIfNotExists")', async () => {
    const result = await roosyncDashboard({ action: 'read', type: 'global' });
    expect(result.success).toBe(false);
    expect(String((result as any).message)).toContain('ROOSYNC_SHARED_PATH inaccessible');
    // The trap: the old message recommended createIfNotExists — which would have
    // written a phantom dashboard over the absent mount.
    expect(String((result as any).message)).not.toContain('createIfNotExists');
  });

  it('dashboard read_overview fails (not "0/3 dashboards")', async () => {
    const result = await roosyncDashboard({ action: 'read_overview' });
    expect(result.success).toBe(false);
    expect(String((result as any).message)).toContain('ROOSYNC_SHARED_PATH inaccessible');
  });

  it('inbox read fails (not "Aucun message / votre inbox est vide")', async () => {
    const result = await roosyncRead({ mode: 'inbox' });
    const text = result.content[0].text;
    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('votre inbox est vide');
  });

  it('message read fails (not "Message introuvable")', async () => {
    const result = await getMessage({ message_id: 'does-not-exist' });
    const text = result.content[0].text;
    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('Message introuvable');
  });

  it('attachments list fails (not "Aucune pièce jointe trouvée")', async () => {
    const result = await roosyncListAttachments({ message_id: 'does-not-exist' });
    const text = result.content[0].text;
    expect(text).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect(text).not.toContain('Aucune pièce jointe trouvée');
  });

  it('read_archive fails AND does not recreate the store root (mkdir disarming)', async () => {
    // #1103 blocking point: handleReadArchive's first instruction is a recursive
    // mkdir on <sharedStatePath>/dashboards/archive — which ALSO creates the
    // store root, flipping existsSync(sharedPath) to true forever after and
    // silently disarming every other #3459 guard. The call must fail closed
    // AND the absent path must still be absent afterwards — the second member
    // is the one that actually guards against regression.
    const result = await roosyncDashboard({ action: 'read_archive', type: 'workspace' });
    expect(result.success).toBe(false);
    expect(String((result as any).message)).toContain('ROOSYNC_SHARED_PATH inaccessible');
    expect((result as any).archives).toEqual([]);
    expect(existsSync(MISSING_STORE)).toBe(false);
  });

  it('MessageManager bootstrap skips AND does not recreate the store root (bootstrap disarming)', async () => {
    // Same disarming class as read_archive above, at bootstrap level: the
    // constructor's ensureDirectories ran a recursive mkdir under the absent
    // root, recreating it before any tool guard could fire (#3459).
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const mm = new MessageManager(MISSING_STORE);
    expect(mm.bootstrapStatus).toBe('skipped-store-absent');
    expect(existsSync(MISSING_STORE)).toBe(false);
    expect(existsSync(path.join(MISSING_STORE, 'messages'))).toBe(false);
    // The WARN must carry the RESOLVED path (GO #3459): the logical name
    // alone fixes nothing at 3 a.m.
    const warned = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warned).toContain(MISSING_STORE);
    warnSpy.mockRestore();
  });

  it('registerMachineId skips AND does not persist a decoy registry', async () => {
    // writeFile cannot create the parent, so the root-creation property is
    // carried by the MessageManager guard above; the discriminating member
    // HERE is the WARN — a neutralized guard degrades to a generic write
    // error with no readable cause, and the mutation counter-check relies
    // on this assertion to go red.
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const ok = await registerMachineId('probe-machine', MISSING_STORE, 'unit-test');
    expect(ok).toBe(false);
    expect(existsSync(MISSING_STORE)).toBe(false);
    expect(existsSync(path.join(MISSING_STORE, '.machine-registry.json'))).toBe(false);
    const warned = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warned).toContain(MISSING_STORE);
    warnSpy.mockRestore();
  });
});
