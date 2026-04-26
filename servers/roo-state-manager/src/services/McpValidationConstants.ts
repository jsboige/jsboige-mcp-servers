/**
 * MCP Validation Constants — Canonical configuration rules
 *
 * #1656 Phase A3: Single source of truth for MCP validation.
 * Used by:
 * - scripts/validation/validate-mcp-config-cross-machine.ps1 (PowerShell runner)
 * - roosync_mcp_management tool (MCP server)
 * - Tests in src/__tests__/mcp-validation.test.ts
 */

// MCP servers that must NOT be present in any config
export const RETIRED_MCP_NAMES = [
  'desktop-commander',
  'github-projects-mcp',
  'quickfiles',
] as const;

// Critical MCPs per agent
export const CLAUDE_CRITICAL_MCPS = ['roo-state-manager'] as const;
export const ROO_CRITICAL_MCPS = ['win-cli', 'roo-state-manager'] as const;

// Win-cli canonical config (from .claude/rules/tool-availability.md, #1666 Phase A3)
export const WINCLI_CANONICAL = {
  command: 'node',
  argsPattern: /mcps[\/\\]external[\/\\]win-cli[\/\\]server[\/\\]dist[\/\\]index\.js$/,
  transportType: 'stdio',
  disabled: false,
  forbiddenPatterns: [
    /@simonb97\/server-win-cli/,
    /@anthropic\/win-cli/,
  ],
} as const;

// Sk-agent must be in global config (~/.claude.json), NOT in project .mcp.json
export const SK_AGENT_MUST_BE_GLOBAL = true;

export interface McpServerEntry {
  command?: string;
  args?: string[];
  transportType?: string;
  disabled?: boolean;
}

export interface ValidationResult {
  passed: boolean;
  violations: string[];
  checks: {
    retired: string[];
    criticalMissing: string[];
    winCliDrift: string[];
    skAgentMisplaced: boolean;
  };
}

/**
 * Validate MCP server configs against canonical rules
 */
export function validateMcpConfig(
  servers: Record<string, McpServerEntry>,
  agent: 'claude' | 'roo',
): ValidationResult {
  const violations: string[] = [];
  const retired: string[] = [];
  const criticalMissing: string[] = [];
  const winCliDrift: string[] = [];
  let skAgentMisplaced = false;

  // Check retired MCPs
  for (const name of RETIRED_MCP_NAMES) {
    if (servers[name]) {
      retired.push(name);
      violations.push(`RETIRED MCP '${name}' found — must be removed`);
    }
  }

  // Check critical MCPs
  const required = agent === 'claude' ? CLAUDE_CRITICAL_MCPS : ROO_CRITICAL_MCPS;
  for (const name of required) {
    if (!servers[name]) {
      criticalMissing.push(name);
      violations.push(`CRITICAL MCP '${name}' missing`);
    } else if (servers[name].disabled) {
      criticalMissing.push(`${name} (disabled)`);
      violations.push(`CRITICAL MCP '${name}' is disabled`);
    }
  }

  // Check win-cli config (Roo only)
  if (agent === 'roo') {
    const winCli = servers['win-cli'];
    if (!winCli) {
      winCliDrift.push('win-cli missing from Roo mcpServers');
      violations.push('win-cli missing from Roo mcpServers');
    } else {
      if (winCli.command !== WINCLI_CANONICAL.command) {
        winCliDrift.push(`command='${winCli.command}' (expected 'node')`);
        violations.push(`Roo win-cli drift: command='${winCli.command}'`);
      }

      const firstArg = winCli.args?.[0] ?? '';
      if (!WINCLI_CANONICAL.argsPattern.test(firstArg)) {
        winCliDrift.push(`args[0] does not point to local fork: '${firstArg}'`);
        violations.push(`Roo win-cli drift: args[0]='${firstArg}'`);
      }

      for (const pattern of WINCLI_CANONICAL.forbiddenPatterns) {
        for (const arg of (winCli.args ?? [])) {
          if (pattern.test(arg)) {
            winCliDrift.push(`BROKEN npm reference: '${arg}'`);
            violations.push(`Roo win-cli drift: broken npm ref '${arg}'`);
          }
        }
      }

      if (winCli.disabled) {
        winCliDrift.push('win-cli is disabled');
        violations.push('Roo win-cli drift: disabled');
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    checks: {
      retired,
      criticalMissing,
      winCliDrift,
      skAgentMisplaced,
    },
  };
}
