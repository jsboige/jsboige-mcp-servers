/**
 * Tests for roosync_config tool
 *
 * Covers: collect, publish, apply actions
 * Validation: Zod schema, error handling, edge cases
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigArgsSchema, roosyncConfig, ConfigArgs } from '../config.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../../../types/errors.js';

// Mock RooSyncService
const mockCollectConfig = vi.fn();
const mockPublishConfig = vi.fn();
const mockApplyConfig = vi.fn();
const mockApplyProfile = vi.fn();
const mockGetConfigVersion = vi.fn();

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: () => ({
    getConfigSharingService: () => ({
      collectConfig: mockCollectConfig,
      publishConfig: mockPublishConfig,
      applyConfig: mockApplyConfig,
      applyProfile: mockApplyProfile
    }),
    getConfigService: () => ({
      getConfigVersion: mockGetConfigVersion
    })
  })
}));

describe('ConfigArgsSchema', () => {
  describe('action validation', () => {
    test('should accept valid actions', () => {
      expect(() => ConfigArgsSchema.parse({ action: 'collect' })).not.toThrow();
      expect(() => ConfigArgsSchema.parse({ action: 'publish', version: '1.0.0', description: 'test', packagePath: '/tmp/test' })).not.toThrow();
      expect(() => ConfigArgsSchema.parse({ action: 'apply' })).not.toThrow();
    });

    test('should reject invalid action', () => {
      expect(() => ConfigArgsSchema.parse({ action: 'invalid' })).toThrow();
    });
  });

  describe('targets validation', () => {
    test('should accept valid targets', () => {
      const result = ConfigArgsSchema.parse({
        action: 'collect',
        targets: ['modes', 'mcp', 'profiles', 'roomodes', 'model-configs', 'rules']
      });
      expect(result.targets).toEqual(['modes', 'mcp', 'profiles', 'roomodes', 'model-configs', 'rules']);
    });

    test('should accept mcp:<serverName> targets', () => {
      const result = ConfigArgsSchema.parse({
        action: 'collect',
        targets: ['mcp:roo-state-manager', 'mcp:sk-agent']
      });
      expect(result.targets).toEqual(['mcp:roo-state-manager', 'mcp:sk-agent']);
    });

    test('should reject empty mcp: target', () => {
      expect(() => ConfigArgsSchema.parse({
        action: 'collect',
        targets: ['mcp:']
      })).toThrow();
    });

    test('should reject invalid target', () => {
      expect(() => ConfigArgsSchema.parse({
        action: 'collect',
        targets: ['invalid-target']
      })).toThrow();
    });
  });

  describe('publish validation', () => {
    test('should require version and description for publish', () => {
      // Missing both version and description
      expect(() => ConfigArgsSchema.parse({
        action: 'publish',
        packagePath: '/tmp/test'
      })).toThrow();

      // Missing description
      expect(() => ConfigArgsSchema.parse({
        action: 'publish',
        version: '1.0.0',
        packagePath: '/tmp/test'
      })).toThrow();

      // Missing version
      expect(() => ConfigArgsSchema.parse({
        action: 'publish',
        description: 'test',
        packagePath: '/tmp/test'
      })).toThrow();
    });

    test('should require packagePath OR targets for publish', () => {
      // Valid with packagePath
      expect(() => ConfigArgsSchema.parse({
        action: 'publish',
        version: '1.0.0',
        description: 'test',
        packagePath: '/tmp/test'
      })).not.toThrow();

      // Valid with targets (atomic collect+publish)
      expect(() => ConfigArgsSchema.parse({
        action: 'publish',
        version: '1.0.0',
        description: 'test',
        targets: ['modes']
      })).not.toThrow();

      // Invalid without either
      expect(() => ConfigArgsSchema.parse({
        action: 'publish',
        version: '1.0.0',
        description: 'test'
      })).toThrow();
    });
  });
});

describe('roosyncConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfigVersion.mockResolvedValue('2.3.0');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('action: collect', () => {
    test('should collect configuration with default targets', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-test-machine',
        filesCount: 5,
        totalSize: 1024,
        manifest: { files: [] }
      });

      const args: ConfigArgs = {
        action: 'collect'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(result.packagePath).toBe('/tmp/config-test-machine');
      expect(result.totalSize).toBe(1024);
      expect(mockCollectConfig).toHaveBeenCalledWith({
        targets: ['modes', 'mcp'],
        dryRun: false
      });
    });

    test('should collect configuration with custom targets', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-test-machine',
        filesCount: 3,
        totalSize: 512,
        manifest: { files: [] }
      });

      const args: ConfigArgs = {
        action: 'collect',
        targets: ['modes', 'profiles']
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(mockCollectConfig).toHaveBeenCalledWith({
        targets: ['modes', 'profiles'],
        dryRun: false
      });
    });

    test('should support dryRun mode', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-dryrun',
        filesCount: 0,
        totalSize: 0,
        manifest: { files: [] }
      });

      const args: ConfigArgs = {
        action: 'collect',
        dryRun: true
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(mockCollectConfig).toHaveBeenCalledWith({
        targets: ['modes', 'mcp'],
        dryRun: true
      });
    });
  });

  describe('action: publish', () => {
    test('should publish configuration with packagePath', async () => {
      mockPublishConfig.mockResolvedValue({
        machineId: 'test-machine',
        version: '1.0.0',
        path: '/shared/configs/test-machine/1.0.0'
      });

      const args: ConfigArgs = {
        action: 'publish',
        version: '1.0.0',
        description: 'Test publish',
        packagePath: '/tmp/config-test'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(result.version).toBe('1.0.0');
      expect(result.targetPath).toBe('/shared/configs/test-machine/1.0.0');
    });

    test('should do atomic collect+publish when targets provided', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-auto',
        filesCount: 2,
        totalSize: 256,
        manifest: { files: [] }
      });

      mockPublishConfig.mockResolvedValue({
        machineId: 'test-machine',
        version: '2.0.0',
        path: '/shared/configs/test-machine/2.0.0'
      });

      const args: ConfigArgs = {
        action: 'publish',
        version: '2.0.0',
        description: 'Atomic publish',
        targets: ['modes']
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(result.version).toBe('2.0.0');
      expect(mockCollectConfig).toHaveBeenCalled();
      expect(mockPublishConfig).toHaveBeenCalled();
    });

    test('should throw if packagePath missing without targets', async () => {
      const args = {
        action: 'publish' as const,
        version: '1.0.0',
        description: 'Test'
      };

      // Schema should reject this
      await expect(async () => {
        const parsed = ConfigArgsSchema.parse(args);
        await roosyncConfig(parsed);
      }).rejects.toThrow();
    });
  });

  describe('action: apply', () => {
    test('should apply configuration with defaults', async () => {
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: ['modes.json', 'mcp.json'],
        backupPath: '/tmp/backup-20260221',
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(result.filesApplied).toHaveLength(2);
      expect(result.backupPath).toBeDefined();
    });

    test('should apply specific targets', async () => {
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: ['modes.json'],
        backupPath: '/tmp/backup-20260221',
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply',
        targets: ['modes']
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(mockApplyConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: ['modes']
        })
      );
    });

    test('should apply specific version', async () => {
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: ['modes.json'],
        backupPath: null,
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply',
        version: '2.0.0'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(mockApplyConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '2.0.0'
        })
      );
    });

    test('should skip backup when backup=false', async () => {
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: ['modes.json'],
        backupPath: null,
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply',
        backup: false
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(mockApplyConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          backup: false
        })
      );
    });

    test('should handle apply failure', async () => {
      mockApplyConfig.mockResolvedValue({
        success: false,
        filesApplied: [],
        backupPath: null,
        errors: ['File not found']
      });

      const args: ConfigArgs = {
        action: 'apply'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('error');
      expect(result.errors).toContain('File not found');
    });

    test('should throw on major version mismatch', async () => {
      mockGetConfigVersion.mockResolvedValue('2.3.0');

      const args: ConfigArgs = {
        action: 'apply',
        version: '3.0.0'  // Different major version
      };

      await expect(roosyncConfig(args)).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should allow same major version', async () => {
      mockGetConfigVersion.mockResolvedValue('2.3.0');
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: ['modes.json'],
        backupPath: null,
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply',
        version: '2.5.0'  // Same major version
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
    });

    test('should allow version=latest', async () => {
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: ['modes.json'],
        backupPath: null,
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply',
        version: 'latest'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
    });
  });

  describe('error handling', () => {
    test('should propagate ConfigSharingServiceError', async () => {
      mockCollectConfig.mockRejectedValue(
        new ConfigSharingServiceError(
          'Collection failed',
          ConfigSharingServiceErrorCode.COLLECTION_FAILED
        )
      );

      const args: ConfigArgs = {
        action: 'collect'
      };

      await expect(roosyncConfig(args)).rejects.toThrow(ConfigSharingServiceError);
    });

    test('should wrap generic errors', async () => {
      mockCollectConfig.mockRejectedValue(new Error('Generic error'));

      const args: ConfigArgs = {
        action: 'collect'
      };

      await expect(roosyncConfig(args)).rejects.toThrow('Erreur lors de l\'opération collect');
    });
  });

  // Issue #601: Claude Code scope support
  describe('Claude Code scope (Issue #601)', () => {
    test('should accept valid scope values', () => {
      expect(() => ConfigArgsSchema.parse({
        action: 'collect',
        scope: 'user'
      })).not.toThrow();

      expect(() => ConfigArgsSchema.parse({
        action: 'collect',
        scope: 'project'
      })).not.toThrow();

      expect(() => ConfigArgsSchema.parse({
        action: 'collect',
        scope: 'settings'
      })).not.toThrow();
    });

    test('should reject invalid scope value', () => {
      expect(() => ConfigArgsSchema.parse({
        action: 'collect',
        scope: 'invalid'
      })).toThrow();
    });

    test('should pass scope to collectConfig for user scope', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-user',
        filesCount: 1,
        totalSize: 512,
        manifest: { files: [] }
      });

      const args: ConfigArgs = {
        action: 'collect',
        targets: ['mcp'],
        scope: 'user'
      };

      await roosyncConfig(args);

      expect(mockCollectConfig).toHaveBeenCalledWith({
        targets: ['mcp'],
        dryRun: false,
        scope: 'user'
      });
    });

    test('should pass scope to collectConfig for project scope', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-project',
        filesCount: 1,
        totalSize: 256,
        manifest: { files: [] }
      });

      const args: ConfigArgs = {
        action: 'collect',
        targets: ['mcp'],
        scope: 'project'
      };

      await roosyncConfig(args);

      expect(mockCollectConfig).toHaveBeenCalledWith({
        targets: ['mcp'],
        dryRun: false,
        scope: 'project'
      });
    });

    test('should pass scope to collectConfig for settings scope', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-settings',
        filesCount: 0,
        totalSize: 0,
        manifest: { files: [] }
      });

      const args: ConfigArgs = {
        action: 'collect',
        targets: ['mcp'],
        scope: 'settings'
      };

      await roosyncConfig(args);

      expect(mockCollectConfig).toHaveBeenCalledWith({
        targets: ['mcp'],
        dryRun: false,
        scope: 'settings'
      });
    });

    test('should pass scope to applyConfig', async () => {
      mockApplyConfig.mockResolvedValue({
        success: true,
        filesApplied: 1,
        backupPath: '/tmp/backup',
        errors: []
      });

      const args: ConfigArgs = {
        action: 'apply',
        targets: ['mcp'],
        scope: 'user'
      };

      await roosyncConfig(args);

      expect(mockApplyConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'user'
        })
      );
    });

    test('should support scope in atomic publish (collect+publish)', async () => {
      mockCollectConfig.mockResolvedValue({
        packagePath: '/tmp/config-auto',
        filesCount: 1,
        totalSize: 256,
        manifest: { files: [] }
      });

      mockPublishConfig.mockResolvedValue({
        machineId: 'test-machine',
        version: '1.0.0',
        path: '/shared/configs/1.0.0'
      });

      const args: ConfigArgs = {
        action: 'publish',
        version: '1.0.0',
        description: 'Test with scope',
        targets: ['mcp'],
        scope: 'project'
      };

      await roosyncConfig(args);

      expect(mockCollectConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'project'
        })
      );
      expect(mockPublishConfig).toHaveBeenCalled();
    });
  });

  // Tests for apply_profile action
  describe('action: apply_profile', () => {
    test('should apply profile with default parameters', async () => {
      mockApplyProfile.mockResolvedValue({
        success: true,
        profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)',
        modesConfigured: 5,
        apiConfigsCount: 3,
        backupPath: '/tmp/backup-profile',
        roomodesGenerated: true,
        changes: ['modes.json', 'mcp.json']
      });

      const args: ConfigArgs = {
        action: 'apply_profile',
        profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(result.message).toContain("Profil 'Production (Qwen 3.5 local + GLM-5 cloud)' appliqué avec succès");
      expect(result.message).toContain('5 modes');
      expect(result.message).toContain('3 configs API');
      expect(result.message).toContain('.roomodes régénéré');
      expect(result.profileName).toBe('Production (Qwen 3.5 local + GLM-5 cloud)');
      expect(result.modesConfigured).toBe(5);
      expect(result.apiConfigsCount).toBe(3);
      expect(result.backupPath).toBe('/tmp/backup-profile');
      expect(result.roomodesGenerated).toBe(true);
      expect(mockApplyProfile).toHaveBeenCalledWith({
        profileName: 'Production (Qwen 3.5 local + GLM-5 cloud)',
        sourceMachineId: undefined,
        backup: true,
        dryRun: false
      });
    });

    test('should throw when profileName is missing', async () => {
      const args: ConfigArgs = {
        action: 'apply_profile'
      };

      await expect(roosyncConfig(args)).rejects.toThrow(ConfigSharingServiceError);
      await expect(roosyncConfig(args)).rejects.toThrow('profileName est requis pour action=apply_profile');
    });

    test('should handle roomodes generation failure in message', async () => {
      mockApplyProfile.mockResolvedValue({
        success: true,
        profileName: 'Development Profile',
        modesConfigured: 3,
        apiConfigsCount: 2,
        backupPath: null,
        roomodesGenerated: false,
        changes: ['modes.json'],
        errors: ['Erreur lors de la génération du fichier .roomodes']
      });

      const args: ConfigArgs = {
        action: 'apply_profile',
        profileName: 'Development Profile'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('success');
      expect(result.message).toContain('.roomodes non régénéré');
      expect(result.roomodesGenerated).toBe(false);
    });

    test('should support optional sourceMachineId parameter', async () => {
      mockApplyProfile.mockResolvedValue({
        success: true,
        profileName: 'Shared Profile',
        modesConfigured: 4,
        apiConfigsCount: 2,
        backupPath: '/tmp/backup',
        roomodesGenerated: true,
        changes: ['modes.json']
      });

      const args: ConfigArgs = {
        action: 'apply_profile',
        profileName: 'Shared Profile',
        sourceMachineId: 'myia-ai-01'
      };

      await roosyncConfig(args);

      expect(mockApplyProfile).toHaveBeenCalledWith({
        profileName: 'Shared Profile',
        sourceMachineId: 'myia-ai-01',
        backup: true,
        dryRun: false
      });
    });

    test('should support backup=false parameter', async () => {
      mockApplyProfile.mockResolvedValue({
        success: true,
        profileName: 'Quick Profile',
        modesConfigured: 2,
        apiConfigsCount: 1,
        backupPath: null,
        roomodesGenerated: true,
        changes: ['mcp.json']
      });

      const args: ConfigArgs = {
        action: 'apply_profile',
        profileName: 'Quick Profile',
        backup: false
      };

      await roosyncConfig(args);

      expect(mockApplyProfile).toHaveBeenCalledWith({
        profileName: 'Quick Profile',
        sourceMachineId: undefined,
        backup: false,
        dryRun: false
      });
    });

    test('should handle apply_profile failure', async () => {
      mockApplyProfile.mockResolvedValue({
        success: false,
        profileName: 'Invalid Profile',
        modesConfigured: 0,
        apiConfigsCount: 0,
        backupPath: null,
        roomodesGenerated: false,
        changes: [],
        errors: ['Profile not found', 'Invalid configuration']
      });

      const args: ConfigArgs = {
        action: 'apply_profile',
        profileName: 'Invalid Profile'
      };

      const result = await roosyncConfig(args);

      expect(result.status).toBe('error');
      expect(result.message).toContain("Échec de l'application du profil 'Invalid Profile'");
      expect(result.errors).toContain('Profile not found');
      expect(result.errors).toContain('Invalid configuration');
    });
  });
});
