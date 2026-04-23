/**
 * Tests unitaires pour roosync_dashboard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  roosyncDashboard,
  DashboardArgsSchema,
  type DashboardArgs,
  type DashboardResult
} from '../../../../src/tools/roosync/dashboard.js';
import { AuthorSchema, IntercomMessageSchema, UserIdSchema } from '../../../../src/tools/roosync/dashboard-schemas.js';

// Mock des dépendances
vi.mock('fs/promises');
vi.mock('fs');
vi.mock('js-yaml');
vi.mock('../../../../src/utils/shared-state-path.js');
vi.mock('../../../../src/utils/message-helpers.js');
vi.mock('../../../../src/utils/logger.js');
vi.mock('../../../../src/services/openai.ts');
vi.mock('../../../../src/utils/dashboard-helpers.js');

const { readFileSync, writeFileSync, existsSync } = vi.mocked(require('fs'));
const { readFile, writeFile, mkdir } = vi.mocked(require('fs/promises'));
const yaml = vi.mocked(require('js-yaml'));
const { getSharedStatePath } = vi.mocked(require('../../../../src/utils/shared-state-path.ts'));
const { getLocalMachineId, getLocalWorkspaceId } = vi.mocked(require('../../../../src/utils/message-helpers.ts'));
const { createLogger } = vi.mocked(require('../../../../src/utils/logger.ts'));
const { getChatOpenAIClient, getLLMModelId } = vi.mocked(require('../../../../src/services/openai.ts'));
const {
  sendMentionNotificationsAsync,
  sendStructuredMentionNotificationsAsync,
  resolveMentionTarget
} = vi.mocked(require('../../../../src/utils/dashboard-helpers.ts'));

describe('DashboardArgsSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Validation des actions valides', () => {
    it('devrait valider action="read"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'read',
        type: 'workspace',
        workspace: 'roo-extensions'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('read');
        expect(result.data.type).toBe('workspace');
        expect(result.data.workspace).toBe('roo-extensions');
      }
    });

    it('devrait valider action="write"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'write',
        type: 'machine',
        machine: 'myia-po-2023',
        content: 'Contenu du dashboard',
        author: {
          machineId: 'myia-po-2023',
          workspace: 'roo-extensions'
        }
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('write');
        expect(result.data.content).toBe('Contenu du dashboard');
        expect(result.data.author).toBeDefined();
      }
    });

    it('devrait valider action="append"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'append',
        type: 'global',
        content: 'Nouveau message intercom',
        tags: ['INFO'],
        author: {
          machineId: 'myia-po-2024',
          workspace: 'roo-extensions'
        },
        mentions: [
          {
            userId: {
              machineId: 'myia-ai-01',
              workspace: 'roo-extensions'
            }
          }
        ]
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('append');
        expect(result.data.tags).toEqual(['INFO']);
        expect(result.data.mentions).toHaveLength(1);
      }
    });

    it('devrait valider action="condense"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'condense',
        type: 'workspace',
        workspace: 'roo-extensions',
        keepMessages: 20
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('condense');
        expect(result.data.keepMessages).toBe(20);
      }
    });

    it('devrait valider action="list"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'list'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('list');
      }
    });

    it('devrait valider action="delete"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'delete',
        type: 'workspace',
        workspace: 'old-workspace'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('delete');
      }
    });

    it('devrait valider action="read_archive"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'read_archive',
        type: 'machine',
        machine: 'myia-po-2023',
        archiveFile: 'archive-2026-04-20.md'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('read_archive');
        expect(result.data.archiveFile).toBe('archive-2026-04-20.md');
      }
    });

    it('devrait valider action="read_overview"', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'read_overview'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('read_overview');
      }
    });
  });

  describe('Rejection des actions invalides', () => {
    it('devrait rejeter action inconnue', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'unknown' as any
      });
      expect(result.success).toBe(false);
    });

    it('devrait rejeter type invalide', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'read',
        type: 'invalid' as any
      });
      expect(result.success).toBe(false);
    });

    it('devrait rejeter author invalide', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'write',
        type: 'workspace',
        content: 'test',
        author: {
          machineId: '',
          workspace: 'roo-extensions'
        }
      });
      expect(result.success).toBe(false);
    });

    it('devrait rejeter mention invalide', () => {
      const result = DashboardArgsSchema.safeParse({
        action: 'append',
        type: 'global',
        content: 'test',
        author: {
          machineId: 'test',
          workspace: 'test'
        },
        mentions: [
          {
            userId: {
              machineId: '',
              workspace: 'test'
            }
          }
        ]
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Validation des schémas imbriqués', () => {
    describe('AuthorSchema', () => {
      it('devrait valider un author complet', () => {
        const author = {
          machineId: 'myia-po-2023',
          workspace: 'roo-extensions',
          worktree: '/path/to/worktree'
        };
        const result = AuthorSchema.safeParse(author);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.machineId).toBe('myia-po-2023');
          expect(result.data.workspace).toBe('roo-extensions');
        }
      });

      it('devrait rejeter author sans machineId', () => {
        const result = AuthorSchema.safeParse({
          workspace: 'roo-extensions'
        });
        expect(result.success).toBe(false);
      });
    });

    describe('IntercomMessageSchema', () => {
      it('devrait valider un message intercom complet', () => {
        const message = {
          content: 'Message de test',
          tags: ['INFO'],
          author: {
            machineId: 'test',
            workspace: 'test'
          },
          timestamp: '2026-04-23T08:00:00Z'
        };
        const result = IntercomMessageSchema.safeParse(message);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.content).toBe('Message de test');
          expect(result.data.tags).toEqual(['INFO']);
        }
      });

      it('devrait valider un message sans tags', () => {
        const message = {
          content: 'Message simple',
          author: {
            machineId: 'test',
            workspace: 'test'
          }
        };
        const result = IntercomMessageSchema.safeParse(message);
        expect(result.success).toBe(true);
      });
    });

    describe('UserIdSchema', () => {
      it('devrait valider un userId complet', () => {
        const userId = {
          machineId: 'myia-ai-01',
          workspace: 'roo-extensions'
        };
        const result = UserIdSchema.safeParse(userId);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.machineId).toBe('myia-ai-01');
        }
      });

      it('devrait rejeter userId sans machineId', () => {
        const result = UserIdSchema.safeParse({
          workspace: 'roo-extensions'
        });
        expect(result.success).toBe(false);
      });
    });
  });
});

describe('roosyncDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSharedStatePath.mockReturnValue('/tmp/shared-state');
    createLogger.mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    });
  });

  describe('Action "read"', () => {
    it('devrait lire un dashboard existant', async () => {
      const mockDashboardContent = `---
type: workspace
lastModified: 2026-04-23T08:00:00Z
lastModifiedBy:
  machineId: test
  workspace: test
---

## Status
Dashboard de test
`;

      readFile.mockResolvedValueOnce(mockDashboardContent);
      existsSync.mockReturnValueOnce(true);

      const result = await roosyncDashboard({
        action: 'read',
        type: 'workspace',
        workspace: 'roo-extensions'
      });

      expect(readFile).toHaveBeenCalledWith('/tmp/shared-state/dashboards/workspace-roo-extensions.md', 'utf-8');
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('devrait gérer le cas où le fichier n\'existe pas', async () => {
      readFile.mockRejectedValueOnce(new Error('File not found'));
      existsSync.mockReturnValueOnce(false);

      const result = await roosyncDashboard({
        action: 'read',
        type: 'workspace',
        workspace: 'roo-extensions'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });
  });

  describe('Action "write"', () => {
    it('devrait écrire un dashboard complet', async () => {
      const mockFrontmatter = {
        type: 'workspace',
        lastModified: '2026-04-23T08:00:00Z',
        lastModifiedBy: {
          machineId: 'test-machine',
          workspace: 'test-workspace'
        }
      };

      const mockContent = `---
type: workspace
lastModified: 2026-04-23T08:00:00Z
lastModifiedBy:
  machineId: test-machine
  workspace: test-workspace
---

## Status
Nouveau contenu du dashboard
`;

      yaml.dump.mockReturnValueOnce('---\ntype: workspace\n---');
      mkdir.mockResolvedValueOnce(undefined);
      writeFile.mockResolvedValueOnce(undefined);

      const result = await roosyncDashboard({
        action: 'write',
        type: 'workspace',
        workspace: 'roo-extensions',
        content: 'Nouveau contenu du dashboard',
        author: {
          machineId: 'test-machine',
          workspace: 'test-workspace'
        }
      });

      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/shared-state/dashboards/workspace-roo-extensions.md',
        mockContent,
        'utf-8'
      );
      expect(result.success).toBe(true);
    });
  });

  describe('Action "append"', () => {
    it('devrait ajouter un message intercom à un dashboard', async () => {
      const existingContent = `---
type: workspace
lastModified: 2026-04-23T08:00:00Z
lastModifiedBy:
  machineId: test
  workspace: test
---

## Status
Contenu existant
`;

      const expectedNewContent = `---
type: workspace
lastModified: 2026-04-23T08:00:00Z
lastModifiedBy:
  machineId: test
  workspace: test
---

## Status
Contenu existant

## Intercom
- [INFO] 2026-04-23T08:00:00Z - test: Nouveau message
`;

      readFile.mockResolvedValueOnce(existingContent);
      yaml.dump.mockReturnValue('---\ntype: workspace\n---');
      writeFile.mockResolvedValueOnce(undefined);

      const result = await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        workspace: 'roo-extensions',
        content: 'Nouveau message',
        tags: ['INFO'],
        author: {
          machineId: 'test',
          workspace: 'test'
        }
      });

      expect(writeFile).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('devrait gérer les mentions structurées', async () => {
      readFile.mockResolvedValueOnce(`---
type: workspace
---
## Status
Dashboard
`);
      yaml.dump.mockReturnValue('---\ntype: workspace\n---');
      writeFile.mockResolvedValueOnce(undefined);
      sendStructuredMentionNotificationsAsync.mockResolvedValueOnce(undefined);

      await roosyncDashboard({
        action: 'append',
        type: 'workspace',
        workspace: 'roo-extensions',
        content: 'Message avec mention',
        author: {
          machineId: 'sender',
          workspace: 'roo-extensions'
        },
        mentions: [
          {
            userId: {
              machineId: 'recipient',
              workspace: 'roo-extensions'
            },
            note: 'Urgent!'
          }
        ]
      });

      expect(sendStructuredMentionNotificationsAsync).toHaveBeenCalled();
    });
  });

  describe('Action "condense"', () => {
    it('devrait condenser un dashboard trop volumineux', async () => {
      const largeContent = '# '.repeat(1000) + '\n' + 'Contenu très long...';

      readFile.mockResolvedValueOnce(largeContent);
      yaml.dump.mockReturnValue('---\ntype: workspace\n---');
      writeFile.mockResolvedValueOnce(undefined);

      const result = await roosyncDashboard({
        action: 'condense',
        type: 'workspace',
        workspace: 'roo-extensions',
        keepMessages: 10
      });

      expect(writeFile).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('Action "list"', () => {
    it('devrait lister tous les dashboards', async () => {
      existsSync.mockReturnValue(true);

      const result = await roosyncDashboard({
        action: 'list'
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('dashboards');
    });
  });

  describe('Action "read_overview"', () => {
    it('devrait retourner une vue d\'ensemble des 3 types', async () => {
      readFile.mockImplementation((path: string) => {
        if (path.includes('global.md')) {
          return Promise.resolve('---\ntype: global\n---\nGlobal content');
        } else if (path.includes('machine')) {
          return Promise.resolve('---\ntype: machine\n---\nMachine content');
        } else if (path.includes('workspace')) {
          return Promise.resolve('---\ntype: workspace\n---\nWorkspace content');
        }
        return Promise.resolve('');
      });

      const result = await roosyncDashboard({
        action: 'read_overview'
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('global');
      expect(result.data).toHaveProperty('machine');
      expect(result.data).toHaveProperty('workspace');
    });
  });

  describe('Gestion des erreurs', () => {
    it('devrait gérer les erreurs de lecture de fichier', async () => {
      readFile.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await roosyncDashboard({
        action: 'read',
        type: 'workspace',
        workspace: 'roo-extensions'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('devrait gérer les erreurs d\'écriture de fichier', async () => {
      readFile.mockResolvedValueOnce('---\ntype: workspace\n---\n');
      yaml.dump.mockReturnValue('---\ntype: workspace\n---');
      writeFile.mockRejectedValueOnce(new Error('Disk full'));

      const result = await roosyncDashboard({
        action: 'write',
        type: 'workspace',
        workspace: 'roo-extensions',
        content: 'test',
        author: {
          machineId: 'test',
          workspace: 'test'
        }
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Disk full');
    });
  });

  describe('Validation des contraintes', () => {
    it('devrait valider que le type est obligatoire pour certaines actions', async () => {
      await expect(roosyncDashboard({
        action: 'read' as any,
        type: undefined
      })).rejects.toThrow();
    });

    it('devrait valider que le workspace est obligatoire pour type workspace', async () => {
      await expect(roosyncDashboard({
        action: 'read',
        type: 'workspace' as any,
        workspace: undefined
      })).rejects.toThrow();
    });
  });
});