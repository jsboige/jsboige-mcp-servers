/**
 * #3591 (review #1154) — le gate ROOSYNC_TRUSTED_CALLER_IDS doit couvrir le
 * chemin HÉRITÉ du registre : roosync_send / roosync_read / roosync_manage
 * sont joignables directement (registry.ts cases, `args as any`, zéro zod)
 * et contournaient le dispatcher roosync_messages où vivait le gate.
 *
 * Le gate vit désormais dans resolveCallerIdentity (message-helpers) —
 * l'étranglement unique. Ces tests exercent le VRAI handler
 * CallToolRequestSchema avec le VRAI send.ts : seuls MessageManager /
 * lazy-roosync / dashboard-helpers / server-capabilities sont mockés, pour
 * asserter à la fois le refus ET la non-invocation de la fonction d'envoi.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerCallToolHandler } from '../registry.js';
import { TRUSTED_CALLER_IDS_ENV } from '../../utils/message-helpers.js';

const mockSendMessage = vi.hoisted(() => vi.fn());

vi.mock('../../services/MessageManager.js', () => ({
  getMessageManager: () => ({
    sendMessage: mockSendMessage,
  }),
}));

vi.mock('../../services/lazy-roosync.js', () => ({
  getRooSyncService: async () => ({
    getHeartbeatService: () => ({ registerHeartbeat: async () => undefined }),
  }),
}));

vi.mock('../../utils/dashboard-helpers.js', () => ({
  updateDashboardActivityAsync: async () => undefined,
}));

// roosync_send exige la capability 'sharedPath' (TOOL_CAPABILITIES) — sans
// ce mock le capability guard bloquerait l'outil avant le switch en env de
// test, et le test ne mesurerait pas le gate.
vi.mock('../../utils/server-capabilities.js', () => ({
  getServerCapabilities: () => ({
    isAvailable: () => true,
    getDegradedReason: () => '',
  }),
}));

describe('legacy registry path — `as` gate (#3591, review #1154)', () => {
  const ENV = TRUSTED_CALLER_IDS_ENV;
  let savedEnv: string | undefined;
  let handler: (request: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  beforeEach(() => {
    savedEnv = process.env[ENV];
    process.env[ENV] = 'myia-po-2023';
    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue({
      id: 'msg-gate-test-1',
      from: 'myia-po-2023:roo-extensions',
      to: 'myia-ai-01',
      subject: 'S',
      priority: 'MEDIUM',
      timestamp: new Date().toISOString(),
    });
    const mockServer = { setRequestHandler: vi.fn() };
    const mockState = {
      conversationCache: new Map(),
      qdrantIndexQueue: new Set(),
      isQdrantIndexingEnabled: false,
      xmlExporterService: {},
      exportConfigManager: {},
    } as any;
    registerCallToolHandler(
      mockServer as any,
      mockState,
      vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Settings touched' }] }),
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue(undefined)
    );
    handler = mockServer.setRequestHandler.mock.calls[0][1];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  test('roosync_send DIRECT + `as` non listé → refus ET envoi jamais invoqué', async () => {
    // NB : roosyncSend a un catch global qui rend l'erreur en TEXTE
    // (❌ Erreur..., sans isError:true) — le refus se lit dans le corps,
    // la garantie de sécurité est la non-invocation de sendMessage.
    const result = await handler({
      params: {
        name: 'roosync_send',
        arguments: { action: 'send', to: 'myia-ai-01', subject: 'S', body: 'B', as: 'myia-po-999:evil-seat' },
      },
    });
    expect(result.content[0].text).toContain('refusé');
    expect(result.content[0].text).toContain(ENV);
    expect(result.content[0].text).toContain('myia-po-999');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('roosync_send DIRECT sans trust env → refus (jamais de gate silencieux absent)', async () => {
    delete process.env[ENV];
    const result = await handler({
      params: {
        name: 'roosync_send',
        arguments: { action: 'send', to: 'myia-ai-01', subject: 'S', body: 'B', as: 'myia-po-2023:roo-extensions' },
      },
    });
    expect(result.content[0].text).toContain('refusé');
    expect(result.content[0].text).toContain(ENV);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('roosync_send DIRECT + `as` listé → envoyé sous l\'identité assertée', async () => {
    const result = await handler({
      params: {
        name: 'roosync_send',
        arguments: { action: 'send', to: 'myia-ai-01', subject: 'S', body: 'B', as: 'myia-po-2023:roo-extensions' },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toBe('myia-po-2023:roo-extensions');
    expect(result.content[0].text).toContain('envoyé');
  });
});
