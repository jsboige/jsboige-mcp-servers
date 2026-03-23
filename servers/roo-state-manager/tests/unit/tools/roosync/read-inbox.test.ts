/**
 * Tests pour roosync_read_inbox
 *
 * Vérifie le comportement de base et la gestion des erreurs
 * pour l'outil de lecture de la boîte de réception RooSync.
 *
 * @module roosync/read_inbox.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Désactiver le mock global de fs
vi.unmock('fs');

describe('roosync_read_inbox - Validation', () => {
  let readInbox: typeof import('../../../../src/tools/roosync/read_inbox.js').readInbox;

  const mockMessages = [
    {
      id: 'msg-20260115T100000-abc123',
      from: 'myia-ai-01',
      to: 'test-machine',
      subject: 'Test Message 1',
      body: 'Body content 1',
      preview: 'Body content 1...',
      priority: 'HIGH',
      timestamp: '2026-01-15T10:00:00.000Z',
      status: 'unread',
      tags: ['important']
    },
    {
      id: 'msg-20260115T090000-def456',
      from: 'myia-po-2023',
      to: 'test-machine',
      subject: 'Test Message 2',
      body: 'Body content 2',
      preview: 'Body content 2...',
      priority: 'MEDIUM',
      timestamp: '2026-01-15T09:00:00.000Z',
      status: 'read',
      tags: []
    }
  ];

  beforeEach(async () => {
    vi.resetModules();

    // Mock des dépendances
    vi.doMock('../../../../src/services/MessageManager.js', () => {
      const mockInstance = {
        readInbox: vi.fn().mockImplementation(
          (machineId: string, status?: string, limit?: number) => {
            let filtered = [...mockMessages];
            if (status && status !== 'all') {
              filtered = filtered.filter(m => m.status === status);
            }
            if (limit && limit > 0) {
              filtered = filtered.slice(0, limit);
            }
            return Promise.resolve(filtered);
          }
        )
      };
      return {
        MessageManager: vi.fn().mockImplementation(() => mockInstance),
        getMessageManager: vi.fn().mockReturnValue(mockInstance),
      };
    });

    vi.doMock('../../../../src/utils/server-helpers.js', () => ({
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared-state')
    }));

    // Importer le module après les mocks
    const module = await import('../../../../src/tools/roosync/read_inbox.js');
    readInbox = module.readInbox;
  });

  describe('lecture de base', () => {
    it('devrait retourner une structure de réponse valide', async () => {
      const result = await readInbox({});

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });

    it('devrait fonctionner sans arguments', async () => {
      const result = await readInbox();

      expect(result.content[0].text).toBeDefined();
      expect(typeof result.content[0].text).toBe('string');
    });
  });

  describe('paramètres optionnels', () => {
    it('devrait accepter le paramètre status', async () => {
      const result = await readInbox({ status: 'unread' });

      expect(result.content[0].text).toBeDefined();
    });

    it('devrait accepter le paramètre limit', async () => {
      const result = await readInbox({ limit: 5 });

      expect(result.content[0].text).toBeDefined();
    });

    it('devrait accepter status et limit combinés', async () => {
      const result = await readInbox({ status: 'read', limit: 10 });

      expect(result.content[0].text).toBeDefined();
    });
  });
});

describe('roosync_read_inbox - Interface', () => {
  it('devrait exporter la fonction readInbox', async () => {
    const module = await import('../../../../src/tools/roosync/read_inbox.js');

    expect(module.readInbox).toBeDefined();
    expect(typeof module.readInbox).toBe('function');
  });
});

describe('roosync_read_inbox - Inbox vide', () => {
  let readInbox: typeof import('../../../../src/tools/roosync/read_inbox.js').readInbox;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../../../../src/services/MessageManager.js', () => {
      const mockInstance = {
        readInbox: vi.fn().mockResolvedValue([])
      };
      return {
        MessageManager: vi.fn().mockImplementation(() => mockInstance),
        getMessageManager: vi.fn().mockReturnValue(mockInstance),
      };
    });

    vi.doMock('../../../../src/utils/server-helpers.js', () => ({
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared-state')
    }));

    // Inclure 'default' car read_inbox.ts utilise 'import os from "os"' (default import)
    const osMock = { hostname: vi.fn().mockReturnValue('test-machine'), tmpdir: vi.fn().mockReturnValue('/tmp') };
    vi.doMock('os', () => ({ default: osMock, ...osMock }));

    const module = await import('../../../../src/tools/roosync/read_inbox.js');
    readInbox = module.readInbox;
  });

  it('devrait indiquer que l\'inbox est vide sans filtre', async () => {
    const result = await readInbox({});
    expect(result.content[0].text).toContain('Aucun message');
  });

  it('devrait mentionner le filtre actif quand inbox vide avec status', async () => {
    const result = await readInbox({ status: 'unread' });
    expect(result.content[0].text).toContain('unread');
  });
});

describe('roosync_read_inbox - Couverture icônes et troncature', () => {
  let readInbox: typeof import('../../../../src/tools/roosync/read_inbox.js').readInbox;

  const messagesWithAllVariants = [
    {
      id: 'msg-1', from: 'machine-1', to: 'test-machine',
      subject: 'Ce sujet est très long et devrait être tronqué car il dépasse 25 caractères',
      body: 'Body 1', preview: 'Preview 1', priority: 'URGENT',
      timestamp: '2026-01-15T10:00:00.000Z', status: 'unread', tags: []
    },
    {
      id: 'msg-2', from: 'machine-2', to: 'test-machine',
      subject: 'Short', body: 'Body 2', preview: 'Preview 2', priority: 'LOW',
      timestamp: '2026-01-15T09:00:00.000Z', status: 'archived', tags: []
    },
    {
      id: 'msg-3', from: 'machine-3', to: 'test-machine',
      subject: 'Unknown prio', body: 'Body 3', preview: 'Preview 3', priority: 'UNKNOWN_PRIO',
      timestamp: '2026-01-15T08:00:00.000Z', status: 'unknown_status', tags: []
    }
  ];

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../../../../src/services/MessageManager.js', () => {
      const mockInstance = {
        readInbox: vi.fn().mockResolvedValue([...messagesWithAllVariants])
      };
      return {
        MessageManager: vi.fn().mockImplementation(() => mockInstance),
        getMessageManager: vi.fn().mockReturnValue(mockInstance),
      };
    });

    vi.doMock('../../../../src/utils/server-helpers.js', () => ({
      getSharedStatePath: vi.fn().mockReturnValue('/mock/shared-state')
    }));

    // Inclure 'default' car read_inbox.ts utilise 'import os from "os"' (default import)
    const osMock = { hostname: vi.fn().mockReturnValue('test-machine'), tmpdir: vi.fn().mockReturnValue('/tmp') };
    vi.doMock('os', () => ({ default: osMock, ...osMock }));

    const module = await import('../../../../src/tools/roosync/read_inbox.js');
    readInbox = module.readInbox;
  });

  it('devrait afficher l\'icône 🔥 pour URGENT', async () => {
    const result = await readInbox({});
    expect(result.content[0].text).toContain('🔥');
  });

  it('devrait afficher l\'icône 📋 pour LOW', async () => {
    const result = await readInbox({});
    expect(result.content[0].text).toContain('📋');
  });

  it('devrait afficher l\'icône 📦 pour archived', async () => {
    const result = await readInbox({});
    expect(result.content[0].text).toContain('📦');
  });

  it('devrait tronquer les sujets longs', async () => {
    const result = await readInbox({});
    expect(result.content[0].text).toContain('...');
  });

  it('devrait utiliser le pluriel pour plusieurs messages', async () => {
    const result = await readInbox({});
    expect(result.content[0].text).toContain('messages');
  });
});
