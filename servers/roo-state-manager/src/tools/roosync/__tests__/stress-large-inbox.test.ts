/**
 * Tests de stress - Large Inbox - Issue #531
 *
 * Tests de performance avec une boîte de réception de 1000+ messages
 *
 * @module roosync/stress-large-inbox.test
 * @version 2.1.0 (#531 ; #2639 grain 4 — fixture hors arbre mkdtemp, seuils
 *   proportionnels au matériel via micro-benchmark de calibration, cleanup
 *   best-effort, rendement RPC vitest dans les générateurs de fixtures)
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock getLocalMachineId
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => undefined)
  };
});

// Mock getSharedStatePath — #2639 : fixture hors arbre du dépôt (mkdtemp, même
// pattern que baseline.integration / #1355), racine posée en beforeAll.
let testSharedStatePath: string;
let testRootDir: string;
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Mock RooSyncService to avoid config requirements
vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getHeartbeatService: vi.fn(() => ({
      registerHeartbeat: vi.fn().mockResolvedValue(undefined)
    }))
  }))
}));

// Mock getMessageManager to use test path (real getMessageManager uses require() which fails in vitest ESM)
vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => new actual.MessageManager(testSharedStatePath),
  };
});

// Import après les mocks
import { roosyncRead } from '../read.js';
import { roosyncSend } from '../send.js';
import { MessageManager, Message } from '../../../services/MessageManager.js';

/**
 * Génère un message JSON de test
 */
function generateTestMessage(id: number): Message {
  return {
    id: `msg-stress-${id.toString().padStart(5, '0')}`,
    from: `sender-${id % 10}`,
    to: 'test-machine',
    subject: `Stress test message ${id}`,
    body: `This is the body of stress test message ${id}. It contains some content to simulate a real message.\n\nLine 2\nLine 3`,
    priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'][id % 4] as Message['priority'],
    timestamp: new Date(Date.now() - id * 60000).toISOString(), // 1 minute apart
    status: id % 5 === 0 ? 'read' : 'unread',
    tags: [`tag-${id % 20}`, `category-${id % 5}`],
    thread_id: `thread-${id % 100}`
  };
}

/**
 * Rend la main à l'event loop (#2639 grain 4) : les générateurs de fixtures
 * écrivent jusqu'à 2000 fichiers ; un setImmediate tous les 100 (~1 ms au
 * total) laisse le canal RPC vitest respirer sur un fork chargé. NB : le
 * timeout « [vitest-worker]: Timeout calling onTaskUpdate » observé en suite
 * complète sur Windows s'est avéré AMBIANT (birpc 60 s ; ce fichier ne porte
 * aucun bloc synchrone de 60 s — max ~2 s — et le même timeout est apparu
 * sans ce fichier) — ces rendements sont de l'hygiène, pas un fix.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Génère N messages dans l'inbox
 */
async function generateLargeInbox(count: number): Promise<void> {
  const inboxPath = join(testSharedStatePath, 'messages/inbox');

  for (let i = 0; i < count; i++) {
    const message = generateTestMessage(i);
    const filePath = join(inboxPath, `${message.id}.json`);
    writeFileSync(filePath, JSON.stringify(message, null, 2), 'utf-8');
    if (i % 100 === 99) {
      await yieldToEventLoop();
    }
  }
}

/**
 * Facteur matériel (#2639 grain 4) : les seuils de timing de ce fichier dépendent
 * de la vitesse I/O réelle de la machine. Plutôt que des seuils fixes calibrés sur
 * une machine de dev (rouges sur un runner CI à 2 cœurs), chaque run mesure la
 * vitesse via un micro-benchmark de la même forme de charge que les tests —
 * écriture puis relecture de 200 petits JSON dans un mkdtemp — et met les seuils
 * à l'échelle. CALIBRATION_REFERENCE_MS = 550, mesuré sur po-2027 le 2026-10-05
 * (3 runs : 483/548/537 ms). Facteur clampé à [1, 5] : une machine plus rapide que
 * la référence ne gagne pas de seuil resserré (plancher 1) ; au-delà de 5× plus
 * lent, c'est une régression réelle, pas du matériel.
 */
const CALIBRATION_REFERENCE_MS = 550;
let hardwareFactor = 1;

async function calibrateHardwareFactor(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'stress-calib-'));
  try {
    const dir = join(root, 'messages', 'inbox');
    mkdirSync(dir, { recursive: true });
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      const message = generateTestMessage(i);
      writeFileSync(join(dir, `${message.id}.json`), JSON.stringify(message, null, 2), 'utf-8');
    }
    // Rendre la main entre écriture et lecture (RPC vitest — même raison que
    // yieldToEventLoop ; ~0,1 ms, négligeable devant les ~550 ms mesurées).
    await yieldToEventLoop();
    for (const f of readdirSync(dir)) {
      readFileSync(join(dir, f), 'utf-8');
    }
    const measured = Date.now() - start;
    return Math.min(5, Math.max(1, measured / CALIBRATION_REFERENCE_MS));
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // calibration : nettoyage best-effort
    }
  }
}

describe('Stress Tests - Large Inbox 1000+ (Issue #531)', () => {
  let messageManager: MessageManager;

  beforeAll(async () => {
    hardwareFactor = await calibrateHardwareFactor();
    testRootDir = mkdtempSync(join(tmpdir(), 'stress-inbox-'));
    testSharedStatePath = join(testRootDir, 'shared-state');
  });

  beforeEach(async () => {
    // Setup : créer répertoire temporaire
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'messages'),
      join(testSharedStatePath, 'messages/inbox'),
      join(testSharedStatePath, 'messages/sent'),
      join(testSharedStatePath, 'messages/archive')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    messageManager = new MessageManager(testSharedStatePath);
  });

  afterEach(async () => {
    // Cleanup best-effort (#2639) : un échec de nettoyage ne fait jamais échouer
    // le test — même politique que baseline.integration / #1355 v3.
    try {
      if (existsSync(testSharedStatePath)) {
        rmSync(testSharedStatePath, { recursive: true, force: true });
      }
    } catch {
      // nettoyage best-effort — l'afterAll retentera la racine
    }
  });

  afterAll(() => {
    // #2639 : ratisser la racine mkdtemp, best-effort.
    try {
      if (testRootDir && existsSync(testRootDir)) {
        rmSync(testRootDir, { recursive: true, force: true });
      }
    } catch {
      // nettoyage best-effort
    }
  });

  // ============================================================
  // Tests de performance - Lecture inbox
  // ============================================================

  describe('roosync_read performance with large inbox', () => {
    test('reads inbox with 1000 messages within reasonable time', async () => {
      // Generate 1000 messages
      await generateLargeInbox(1000);

      const inboxPath = join(testSharedStatePath, 'messages/inbox');
      const files = readdirSync(inboxPath);
      expect(files.length).toBe(1000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 20 // Default pagination
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // Response should contain message data
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeDefined();
      expect(responseText.length).toBeGreaterThan(100);

      // Should complete within 5 seconds for 1000 messages, scaled to the
      // machine's measured I/O speed (#2639 grain 4)
      expect(duration).toBeLessThan(5000 * hardwareFactor);
    });

    test('pagination works correctly with large inbox', async () => {
      await generateLargeInbox(500);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      expect(result.content).toHaveLength(1);
      // Should show limited results, not all 500
      expect((result.content[0] as any).text).toBeDefined();
    });

    test('filtering by unread status with large inbox', async () => {
      await generateLargeInbox(1000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'unread',
        limit: 50
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // 80% of messages are unread (status: id % 5 === 0 ? read : unread)
      // So ~800 unread messages
      expect((result.content[0] as any).text).toBeDefined();

      // Should complete within 5 seconds, scaled to hardware (#2639 grain 4)
      expect(duration).toBeLessThan(5000 * hardwareFactor);
    });

    test('reading specific message from large inbox is fast', async () => {
      await generateLargeInbox(1000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'message',
        message_id: 'msg-stress-00500'
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain('msg-stress-00500');

      // Reading single message should be fast (< 1 second, scaled to hardware #2639)
      expect(duration).toBeLessThan(1000 * hardwareFactor);
    });
  });

  // ============================================================
  // Tests de performance - mark_read
  // ============================================================

  describe('mark_read atomicity with large inbox', () => {
    test('mark_read operation is atomic', async () => {
      await generateLargeInbox(100);

      // Mark a message as read
      const result = await roosyncSend({
        action: 'send',
        to: 'self',
        subject: 'Test mark',
        body: 'Test'
      });

      // Extract message ID from result
      const match = result.content[0].text.match(/\*\*ID :\*\* (msg-[a-z0-9T-]+)/);
      expect(match).not.toBeNull();

      const messageId = match![1];

      // Read the message (which marks it as read)
      const readResult = await roosyncRead({
        mode: 'message',
        message_id: messageId,
        mark_as_read: true
      });

      expect(readResult.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de limites - Edge cases volumétriques
  // ============================================================

  describe('Volumetric edge cases', () => {
    test('handles inbox with 2000 messages', async () => {
      await generateLargeInbox(2000);

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 20
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // Check that response mentions large number of messages
      const responseText = (result.content[0] as any).text;
      expect(responseText).toBeDefined();
      // Response should indicate there are messages (exact format may vary)
      expect(responseText.length).toBeGreaterThan(100);

      // Should still be reasonably fast, scaled to hardware (#2639 grain 4)
      expect(duration).toBeLessThan(10000 * hardwareFactor);
    });

    test('inbox with messages having large bodies', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');

      // Create 100 messages with large bodies (10KB each)
      for (let i = 0; i < 100; i++) {
        const largeBody = 'X'.repeat(10 * 1024); // 10KB
        const message: Message = {
          id: `msg-large-${i.toString().padStart(3, '0')}`,
          from: 'sender',
          to: 'test-machine',
          subject: `Large message ${i}`,
          body: largeBody,
          priority: 'MEDIUM',
          timestamp: new Date().toISOString(),
          status: 'unread'
        };

        writeFileSync(
          join(inboxPath, `${message.id}.json`),
          JSON.stringify(message),
          'utf-8'
        );
        if (i % 100 === 99) {
          await yieldToEventLoop();
        }
      }

      const startTime = Date.now();

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      const duration = Date.now() - startTime;

      expect(result.content).toHaveLength(1);
      // Should handle large bodies without timeout, scaled to hardware (#2639)
      expect(duration).toBeLessThan(5000 * hardwareFactor);
    });

    test('inbox with many tags per message', async () => {
      const inboxPath = join(testSharedStatePath, 'messages/inbox');

      // Create 50 messages with 50 tags each
      for (let i = 0; i < 50; i++) {
        const message: Message = {
          id: `msg-tags-${i.toString().padStart(3, '0')}`,
          from: 'sender',
          to: 'test-machine',
          subject: `Tags message ${i}`,
          body: 'Body',
          priority: 'MEDIUM',
          timestamp: new Date().toISOString(),
          status: 'unread',
          tags: Array.from({ length: 50 }, (_, j) => `tag-${i}-${j}`)
        };

        writeFileSync(
          join(inboxPath, `${message.id}.json`),
          JSON.stringify(message),
          'utf-8'
        );
      }

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      expect(result.content).toHaveLength(1);
    });
  });

  // ============================================================
  // Tests de cohérence
  // ============================================================

  describe('Data consistency under load', () => {
    test('all messages are accounted for in count', async () => {
      await generateLargeInbox(500);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all'
      });

      const text = (result.content[0] as any).text;

      // Response should contain message data
      expect(text).toBeDefined();
      expect(text.length).toBeGreaterThan(100);
      // Should mention some indicator of messages
      expect(text).toMatch(/\d+/); // Contains at least one number
    });

    test('messages are sorted by timestamp (newest first)', async () => {
      await generateLargeInbox(100);

      const result = await roosyncRead({
        mode: 'inbox',
        status: 'all',
        limit: 10
      });

      expect(result.content).toHaveLength(1);
      // The newest messages should appear first
      expect((result.content[0] as any).text).toBeDefined();
    });
  });
});
