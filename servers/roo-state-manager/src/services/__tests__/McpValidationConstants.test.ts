/**
 * Tests for McpValidationConstants — #1656 Phase A3
 *
 * Coverage: validateMcpConfig() with valid/invalid configs for Claude and Roo agents.
 */

import { describe, it, expect } from 'vitest';
import {
  validateMcpConfig,
  RETIRED_MCP_NAMES,
  CLAUDE_CRITICAL_MCPS,
  ROO_CRITICAL_MCPS,
  WINCLI_CANONICAL,
  type McpServerEntry,
} from '../McpValidationConstants.js';

describe('McpValidationConstants', () => {
  describe('exports', () => {
    it('RETIRED_MCP_NAMES should list desktop-commander, github-projects-mcp, quickfiles', () => {
      expect(RETIRED_MCP_NAMES).toContain('desktop-commander');
      expect(RETIRED_MCP_NAMES).toContain('github-projects-mcp');
      expect(RETIRED_MCP_NAMES).toContain('quickfiles');
    });

    it('CLAUDE_CRITICAL_MCPS should require roo-state-manager', () => {
      expect(CLAUDE_CRITICAL_MCPS).toContain('roo-state-manager');
    });

    it('ROO_CRITICAL_MCPS should require win-cli and roo-state-manager', () => {
      expect(ROO_CRITICAL_MCPS).toContain('win-cli');
      expect(ROO_CRITICAL_MCPS).toContain('roo-state-manager');
    });

    it('WINCLI_CANONICAL should define node command with local fork pattern', () => {
      expect(WINCLI_CANONICAL.command).toBe('node');
      expect(WINCLI_CANONICAL.argsPattern.test('mcps/external/win-cli/server/dist/index.js')).toBe(true);
      expect(WINCLI_CANONICAL.argsPattern.test('mcps\\external\\win-cli\\server\\dist\\index.js')).toBe(true);
    });

    it('WINCLI_CANONICAL should forbid @simonb97 and @anthropic packages', () => {
      expect(WINCLI_CANONICAL.forbiddenPatterns.length).toBeGreaterThanOrEqual(2);
      expect(WINCLI_CANONICAL.forbiddenPatterns[0].test('@simonb97/server-win-cli')).toBe(true);
    });
  });

  describe('validateMcpConfig — Claude agent', () => {
    it('should pass for valid Claude config', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node', transportType: 'stdio' },
        playwright: { command: 'npx', args: ['@anthropic/playwright'] },
      };

      const result = validateMcpConfig(servers, 'claude');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when roo-state-manager is missing', () => {
      const servers: Record<string, McpServerEntry> = {
        playwright: { command: 'npx', args: ['@anthropic/playwright'] },
      };

      const result = validateMcpConfig(servers, 'claude');
      expect(result.passed).toBe(false);
      expect(result.violations).toContain("CRITICAL MCP 'roo-state-manager' missing");
      expect(result.checks.criticalMissing).toContain('roo-state-manager');
    });

    it('should fail when roo-state-manager is disabled', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node', disabled: true },
      };

      const result = validateMcpConfig(servers, 'claude');
      expect(result.passed).toBe(false);
      expect(result.violations).toContain("CRITICAL MCP 'roo-state-manager' is disabled");
    });

    it('should fail when retired MCP is present', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node' },
        'desktop-commander': { command: 'npx', args: ['desktop-commander'] },
      };

      const result = validateMcpConfig(servers, 'claude');
      expect(result.passed).toBe(false);
      expect(result.violations[0]).toContain("RETIRED MCP 'desktop-commander'");
      expect(result.checks.retired).toContain('desktop-commander');
    });

    it('should not check win-cli for Claude agent', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node' },
      };

      const result = validateMcpConfig(servers, 'claude');
      expect(result.checks.winCliDrift).toHaveLength(0);
    });
  });

  describe('validateMcpConfig — Roo agent', () => {
    const validRooServers: Record<string, McpServerEntry> = {
      'roo-state-manager': { command: 'node', transportType: 'stdio' },
      'win-cli': {
        command: 'node',
        args: ['mcps/external/win-cli/server/dist/index.js'],
        transportType: 'stdio',
      },
    };

    it('should pass for valid Roo config', () => {
      const result = validateMcpConfig(validRooServers, 'roo');
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should fail when win-cli is missing', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node' },
      };

      const result = validateMcpConfig(servers, 'roo');
      expect(result.passed).toBe(false);
      expect(result.checks.winCliDrift).toContain('win-cli missing from Roo mcpServers');
    });

    it('should fail when win-cli has wrong command', () => {
      const servers: { [k: string]: McpServerEntry } = {
        'roo-state-manager': { command: 'node' },
        'win-cli': {
          command: 'npx',
          args: ['mcps/external/win-cli/server/dist/index.js'],
        },
      };

      const result = validateMcpConfig(servers, 'roo');
      expect(result.passed).toBe(false);
      expect(result.violations).toContain("Roo win-cli drift: command='npx'");
    });

    it('should fail when win-cli args point to npm package', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node' },
        'win-cli': {
          command: 'node',
          args: ['@simonb97/server-win-cli'],
        },
      };

      const result = validateMcpConfig(servers, 'roo');
      expect(result.passed).toBe(false);
      expect(result.checks.winCliDrift.some(d => d.includes('BROKEN npm reference'))).toBe(true);
    });

    it('should fail when win-cli args do not match local fork pattern', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node' },
        'win-cli': {
          command: 'node',
          args: ['/some/other/path/index.js'],
        },
      };

      const result = validateMcpConfig(servers, 'roo');
      expect(result.passed).toBe(false);
      expect(result.checks.winCliDrift.some(d => d.includes('does not point to local fork'))).toBe(true);
    });

    it('should fail when win-cli is disabled', () => {
      const servers: Record<string, McpServerEntry> = {
        'roo-state-manager': { command: 'node' },
        'win-cli': {
          command: 'node',
          args: ['mcps/external/win-cli/server/dist/index.js'],
          disabled: true,
        },
      };

      const result = validateMcpConfig(servers, 'roo');
      expect(result.passed).toBe(false);
      expect(result.checks.winCliDrift).toContain('win-cli is disabled');
    });

    it('should report multiple violations simultaneously', () => {
      const servers: Record<string, McpServerEntry> = {
        'desktop-commander': { command: 'npx' },
        'win-cli': { command: 'python' },
      };

      const result = validateMcpConfig(servers, 'roo');
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(3);
      expect(result.checks.retired).toContain('desktop-commander');
      expect(result.checks.criticalMissing).toContain('roo-state-manager');
      expect(result.checks.winCliDrift.length).toBeGreaterThan(0);
    });

    it('should handle empty server config', () => {
      const result = validateMcpConfig({}, 'roo');
      expect(result.passed).toBe(false);
      expect(result.checks.criticalMissing).toContain('roo-state-manager');
      expect(result.checks.criticalMissing).toContain('win-cli');
    });
  });
});
