import { describe, it, expect } from 'vitest';
import {
  RETIRED_MCP_NAMES,
  CLAUDE_CRITICAL_MCPS,
  ROO_CRITICAL_MCPS,
  WINCLI_CANONICAL,
  validateMcpConfig,
  type McpServerEntry,
} from '../services/McpValidationConstants.js';

describe('McpValidationConstants', () => {
  describe('RETIRED_MCP_NAMES', () => {
    it('should list all retired MCPs', () => {
      expect(RETIRED_MCP_NAMES).toContain('desktop-commander');
      expect(RETIRED_MCP_NAMES).toContain('github-projects-mcp');
      expect(RETIRED_MCP_NAMES).toContain('quickfiles');
      expect(RETIRED_MCP_NAMES.length).toBe(3);
    });
  });

  describe('CLAUDE_CRITICAL_MCPS', () => {
    it('should require roo-state-manager', () => {
      expect(CLAUDE_CRITICAL_MCPS).toContain('roo-state-manager');
    });
  });

  describe('ROO_CRITICAL_MCPS', () => {
    it('should require win-cli and roo-state-manager', () => {
      expect(ROO_CRITICAL_MCPS).toContain('win-cli');
      expect(ROO_CRITICAL_MCPS).toContain('roo-state-manager');
    });
  });

  describe('WINCLI_CANONICAL', () => {
    it('should match local fork path', () => {
      expect(WINCLI_CANONICAL.argsPattern.test('mcps/external/win-cli/server/dist/index.js')).toBe(true);
      expect(WINCLI_CANONICAL.argsPattern.test('mcps\\external\\win-cli\\server\\dist\\index.js')).toBe(true);
    });

    it('should reject npm references', () => {
      expect(WINCLI_CANONICAL.argsPattern.test('@simonb97/server-win-cli@0.2.1')).toBe(false);
      expect(WINCLI_CANONICAL.argsPattern.test('npx @simonb97/server-win-cli@0.2.1')).toBe(false);
    });

    it('should have forbidden patterns for broken npm refs', () => {
      expect(WINCLI_CANONICAL.forbiddenPatterns.length).toBeGreaterThanOrEqual(2);
      for (const p of WINCLI_CANONICAL.forbiddenPatterns) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });
  });
});

describe('validateMcpConfig', () => {
  const makeRsm = (overrides: Partial<McpServerEntry> = {}): McpServerEntry => ({
    command: 'node',
    args: ['build/index.js'],
    transportType: 'stdio',
    disabled: false,
    ...overrides,
  });

  const makeWinCli = (overrides: Partial<McpServerEntry> = {}): McpServerEntry => ({
    command: 'node',
    args: ['d:/roo-extensions/mcps/external/win-cli/server/dist/index.js'],
    transportType: 'stdio',
    disabled: false,
    ...overrides,
  });

  it('should pass for valid Claude config', () => {
    const servers = { 'roo-state-manager': makeRsm(), 'sk-agent': makeRsm() };
    const result = validateMcpConfig(servers, 'claude');
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.checks.retired).toHaveLength(0);
    expect(result.checks.criticalMissing).toHaveLength(0);
  });

  it('should pass for valid Roo config', () => {
    const servers = {
      'win-cli': makeWinCli(),
      'roo-state-manager': makeRsm(),
    };
    const result = validateMcpConfig(servers, 'roo');
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should detect retired MCPs', () => {
    const servers = {
      'roo-state-manager': makeRsm(),
      'desktop-commander': makeRsm(),
      'quickfiles': makeRsm(),
    };
    const result = validateMcpConfig(servers, 'claude');
    expect(result.passed).toBe(false);
    expect(result.checks.retired).toContain('desktop-commander');
    expect(result.checks.retired).toContain('quickfiles');
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect missing critical MCPs', () => {
    const servers = { 'sk-agent': makeRsm() };
    const result = validateMcpConfig(servers, 'claude');
    expect(result.passed).toBe(false);
    expect(result.checks.criticalMissing).toContain('roo-state-manager');
  });

  it('should detect disabled critical MCPs', () => {
    const servers = { 'roo-state-manager': makeRsm({ disabled: true }) };
    const result = validateMcpConfig(servers, 'claude');
    expect(result.passed).toBe(false);
    expect(result.checks.criticalMissing).toContain('roo-state-manager (disabled)');
  });

  it('should detect win-cli drift: broken npm reference', () => {
    const servers = {
      'win-cli': makeWinCli({ args: ['@simonb97/server-win-cli@0.2.1'] }),
      'roo-state-manager': makeRsm(),
    };
    const result = validateMcpConfig(servers, 'roo');
    expect(result.passed).toBe(false);
    expect(result.checks.winCliDrift.length).toBeGreaterThan(0);
    expect(result.checks.winCliDrift.some(d => d.includes('BROKEN npm reference'))).toBe(true);
  });

  it('should detect win-cli drift: wrong command', () => {
    const servers = {
      'win-cli': makeWinCli({ command: 'npx' }),
      'roo-state-manager': makeRsm(),
    };
    const result = validateMcpConfig(servers, 'roo');
    expect(result.passed).toBe(false);
    expect(result.checks.winCliDrift.some(d => d.includes("command='npx'"))).toBe(true);
  });

  it('should detect win-cli drift: args not pointing to local fork', () => {
    const servers = {
      'win-cli': makeWinCli({ args: ['some/random/path.js'] }),
      'roo-state-manager': makeRsm(),
    };
    const result = validateMcpConfig(servers, 'roo');
    expect(result.passed).toBe(false);
    expect(result.checks.winCliDrift.some(d => d.includes('does not point to local fork'))).toBe(true);
  });

  it('should detect win-cli missing from Roo config', () => {
    const servers = { 'roo-state-manager': makeRsm() };
    const result = validateMcpConfig(servers, 'roo');
    expect(result.passed).toBe(false);
    expect(result.checks.winCliDrift).toContain('win-cli missing from Roo mcpServers');
  });

  it('should NOT check win-cli for Claude config', () => {
    const servers = { 'roo-state-manager': makeRsm() };
    const result = validateMcpConfig(servers, 'claude');
    // No win-cli checks for Claude
    expect(result.checks.winCliDrift).toHaveLength(0);
  });

  it('should detect multiple violations simultaneously', () => {
    const servers = {
      'desktop-commander': makeRsm(),
      'win-cli': makeWinCli({ command: 'npx', args: ['@simonb97/server-win-cli@0.2.1'] }),
    };
    const result = validateMcpConfig(servers, 'roo');
    expect(result.passed).toBe(false);
    expect(result.checks.retired).toContain('desktop-commander');
    expect(result.checks.criticalMissing).toContain('roo-state-manager');
    expect(result.checks.winCliDrift.length).toBeGreaterThanOrEqual(2);
  });
});
