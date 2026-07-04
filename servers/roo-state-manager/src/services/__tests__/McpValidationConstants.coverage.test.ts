/**
 * #833 Sprint C3 — McpValidationConstants branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `McpValidationConstants.test.ts` (16 tests) covers exports + the happy paths
 * and most drift categories for both agents. It leaves a cluster of branches cold:
 *
 * - **`winCli.args?.[0] ?? ''` (L100)**: the base ALWAYS supplies `args` (array) on the
 *   win-cli entry. The `?.` optional-chain + `?? ''` fallback when args is ABSENT is
 *   never exercised. A win-cli entry with `command:'node'` but NO `args` would crash on
 *   a direct access if this guard regressed.
 * - **`winCli.args ?? []` (L107)**: same absence, in the forbiddenPatterns loop.
 * - **Critical-disabled arm for win-cli (L82-85)**: win-cli is in ROO_CRITICAL_MCPS (L20),
 *   so a disabled win-cli triggers TWO checks — L83 `criticalMissing.push('win-cli (disabled)')`
 *   AND L116 `winCliDrift.push('win-cli is disabled')`. The base "win-cli disabled" test
 *   asserts winCliDrift only, never criticalMissing → the L82-85 arm for win-cli is cold.
 * - **Multiple RETIRED MCPs simultaneously (L69-74)**: base tests exactly one retired
 *   (desktop-commander). The loop accumulating 2-3 is never exercised.
 * - **forbiddenPatterns[1] `@anthropic/win-cli` (L30)**: base tests forbiddenPatterns[0]
 *   (`@simonb97`). The second pattern is never matched.
 * - **agent non-canonical value (L77, L89)**: TS restricts to 'claude'|'roo', but runtime
 *   tolerates any string. `agent === 'claude' ? ... : ROO_CRITICAL` means a bogus agent
 *   gets Roo criticals, while `agent === 'roo'` (L89) is false → win-cli check SKIPPED.
 *   Surprising behavior pinned via `as any`.
 * - **WINCLI_CANONICAL.disabled + transportType exports (L26-27)**: base asserts command,
 *   argsPattern, forbiddenPatterns — never the disabled/transportType constants.
 * - **L96 winCliDrift message format** `command='${x}' (expected 'node')`: base asserts
 *   the violation string, never the winCliDrift-array format.
 *
 * No mocks, pure-function module. No production code touched (#1936 anti-churn).
 */

import { describe, it, expect } from 'vitest';
import {
    validateMcpConfig,
    RETIRED_MCP_NAMES,
    CLAUDE_CRITICAL_MCPS,
    ROO_CRITICAL_MCPS,
    WINCLI_CANONICAL,
    SK_AGENT_MUST_BE_GLOBAL,
    type McpServerEntry,
} from '../McpValidationConstants.js';

describe('McpValidationConstants — branch coverage (#833 C3, source-grounded)', () => {

    // ============================================================
    // Exports — WINCLI_CANONICAL.disabled + transportType (L26-27) + SK_AGENT constant
    // ============================================================
    describe('exports — uncovered WINCLI_CANONICAL fields + SK_AGENT (L26-27, L35)', () => {
        it('WINCLI_CANONICAL.disabled is false (canonical win-cli is enabled, L27)', () => {
            expect(WINCLI_CANONICAL.disabled).toBe(false);
        });

        it('WINCLI_CANONICAL.transportType is stdio (L26)', () => {
            expect(WINCLI_CANONICAL.transportType).toBe('stdio');
        });

        it('SK_AGENT_MUST_BE_GLOBAL is true (L35 — sk-agent belongs in ~/.claude.json not .mcp.json)', () => {
            expect(SK_AGENT_MUST_BE_GLOBAL).toBe(true);
        });

        it('RETIRED_MCP_NAMES is frozen exactly to 3 entries (L12-16 — pin the set)', () => {
            expect([...RETIRED_MCP_NAMES]).toEqual([
                'desktop-commander',
                'github-projects-mcp',
                'quickfiles',
            ]);
        });

        it('CLAUDE_CRITICAL_MCPS is exactly roo-state-manager (L19 — no drift to single source)', () => {
            expect([...CLAUDE_CRITICAL_MCPS]).toEqual(['roo-state-manager']);
        });

        it('ROO_CRITICAL_MCPS is exactly win-cli + roo-state-manager (L20)', () => {
            expect([...ROO_CRITICAL_MCPS]).toEqual(['win-cli', 'roo-state-manager']);
        });
    });

    // ============================================================
    // L100 — winCli.args absent → ?. + ?? '' fallback
    // ============================================================
    describe('win-cli args absent — optional-chain + nullish fallback (L100, L107)', () => {
        it('args entirely absent: firstArg defaults to "" via args?.[0] ?? "" (L100)', () => {
            // No `args` field on the win-cli entry. L100 must not crash on undefined.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'win-cli': { command: 'node' }, // no args
            };

            const result = validateMcpConfig(servers, 'roo');

            // L100 → '' → argsPattern.test('') === false → L101 drift fires.
            expect(result.passed).toBe(false);
            expect(result.checks.winCliDrift.some((d) => d.includes("does not point to local fork: ''"))).toBe(true);
        });

        it('args absent: the forbiddenPatterns loop iterates [] via (winCli.args ?? []) (L107)', () => {
            // No args → the inner forbidden-loop must not throw. Combined with command='node'
            // (correct), the only drift is the args[0] one. No "BROKEN npm reference" fires
            // because the loop iterates an empty array.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'win-cli': { command: 'node' }, // no args → no forbidden match
            };

            const result = validateMcpConfig(servers, 'roo');

            expect(result.checks.winCliDrift.some((d) => d.includes('BROKEN npm reference'))).toBe(false);
        });

        it('args is an empty array []: firstArg "" via args?.[0] ?? "" (L100 — args present but empty)', () => {
            // Distinct from absent: args=[] (present, empty). args?.[0] is undefined → ?? '' → ''.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'win-cli': { command: 'node', args: [] },
            };

            const result = validateMcpConfig(servers, 'roo');

            expect(result.passed).toBe(false);
            expect(result.checks.winCliDrift.some((d) => d.includes("does not point to local fork: ''"))).toBe(true);
        });
    });

    // ============================================================
    // L82-85 — critical-disabled arm for win-cli (Roo) — TWO violations
    // ============================================================
    describe('win-cli disabled as CRITICAL MCP — dual violation (L82-85 + L115-118)', () => {
        it('a disabled win-cli is reported in BOTH criticalMissing and winCliDrift (L83 + L116)', () => {
            // win-cli is in ROO_CRITICAL_MCPS. disabled → L82-85 fires (criticalMissing).
            // AND the win-cli-specific L115-118 fires (winCliDrift). The base only asserts winCliDrift.
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
            // L83: criticalMissing gets 'win-cli (disabled)'.
            expect(result.checks.criticalMissing).toContain('win-cli (disabled)');
            // L84: violation string for the critical-disabled arm.
            expect(result.violations).toContain("CRITICAL MCP 'win-cli' is disabled");
            // L116: winCliDrift also gets 'win-cli is disabled'.
            expect(result.checks.winCliDrift).toContain('win-cli is disabled');
        });

        it('a disabled roo-state-manager (Roo) is in criticalMissing but winCliDrift is unaffected (L82-85 only)', () => {
            // roo-state-manager disabled: L82-85 fires, but no win-cli section applies (it's not win-cli).
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node', disabled: true },
                'win-cli': {
                    command: 'node',
                    args: ['mcps/external/win-cli/server/dist/index.js'],
                },
            };

            const result = validateMcpConfig(servers, 'roo');

            expect(result.checks.criticalMissing).toContain('roo-state-manager (disabled)');
            // The win-cli drift section is independent.
            expect(result.checks.winCliDrift).toHaveLength(0);
        });
    });

    // ============================================================
    // L69-74 — multiple RETIRED MCPs simultaneously
    // ============================================================
    describe('multiple RETIRED MCPs accumulate (L69-74 loop)', () => {
        it('all 3 retired MCPs present → 3 retired + 3 violations (L69-74)', () => {
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'desktop-commander': { command: 'npx' },
                'github-projects-mcp': { command: 'npx' },
                'quickfiles': { command: 'npx' },
            };

            const result = validateMcpConfig(servers, 'claude');

            expect(result.checks.retired).toHaveLength(3);
            expect(result.checks.retired).toEqual(
                expect.arrayContaining(['desktop-commander', 'github-projects-mcp', 'quickfiles']),
            );
            // L72: one violation per retired name.
            const retiredViolations = result.violations.filter((v) => v.startsWith('RETIRED MCP'));
            expect(retiredViolations).toHaveLength(3);
        });

        it('retired violation string format is exact: "RETIRED MCP \'<name>\' found — must be removed" (L72)', () => {
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'quickfiles': { command: 'npx' },
            };

            const result = validateMcpConfig(servers, 'claude');

            expect(result.violations).toContain("RETIRED MCP 'quickfiles' found — must be removed");
        });
    });

    // ============================================================
    // L106-113 — forbiddenPatterns[1] @anthropic/win-cli
    // ============================================================
    describe('forbiddenPatterns[1] @anthropic/win-cli (L30, L106-113)', () => {
        it('args pointing to @anthropic/win-cli triggers the BROKEN npm reference (L30 pattern[1])', () => {
            // The base tests forbiddenPatterns[0] (@simonb97). Pattern[1] (@anthropic) is cold.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'win-cli': {
                    command: 'node',
                    args: ['@anthropic/win-cli'],
                },
            };

            const result = validateMcpConfig(servers, 'roo');

            expect(result.passed).toBe(false);
            expect(result.checks.winCliDrift).toContain("BROKEN npm reference: '@anthropic/win-cli'");
            expect(result.violations).toContain("Roo win-cli drift: broken npm ref '@anthropic/win-cli'");
        });

        it('multiple forbidden args each produce their own BROKEN reference (L107 inner loop, L106 outer)', () => {
            // Both forbidden patterns matched across multiple args → 2 winCliDrift entries.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'win-cli': {
                    command: 'node',
                    args: ['@simonb97/server-win-cli', '@anthropic/win-cli'],
                },
            };

            const result = validateMcpConfig(servers, 'roo');

            const broken = result.checks.winCliDrift.filter((d) => d.startsWith('BROKEN npm reference'));
            expect(broken).toHaveLength(2);
        });
    });

    // ============================================================
    // L77 + L89 — agent non-canonical value (runtime-tolerated, surprising)
    // ============================================================
    describe('agent non-canonical value — runtime tolerance (L77, L89)', () => {
        it('agent="other" gets Roo criticals (else branch L77) but SKIPS win-cli check (L89 false)', () => {
            // TS restricts to 'claude'|'roo', but runtime accepts anything. A bogus agent:
            //   L77: agent === 'claude' is false → required = ROO_CRITICAL_MCPS (win-cli + rsm)
            //   L89: agent === 'roo' is false → win-cli section SKIPPED
            // Net: win-cli is REQUIRED (critical) but its drift is never checked. Surprising.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                // win-cli missing
            };

            const result = validateMcpConfig(servers, 'other' as any);

            expect(result.passed).toBe(false);
            // L77 else branch: ROO_CRITICAL_MCPS → win-cli flagged missing.
            expect(result.checks.criticalMissing).toContain('win-cli');
            // L89 false → win-cli drift section skipped despite win-cli being absent.
            expect(result.checks.winCliDrift).toHaveLength(0);
            expect(result.checks.winCliDrift).not.toContain('win-cli missing from Roo mcpServers');
        });
    });

    // ============================================================
    // L96 — winCliDrift message format for wrong command
    // ============================================================
    describe('winCliDrift message format — wrong command (L96)', () => {
        it('winCliDrift carries "command=\'<actual>\' (expected \'node\')" (L96 exact format)', () => {
            // The base asserts the violation string; the winCliDrift-array format is cold.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
                'win-cli': {
                    command: 'python',
                    args: ['mcps/external/win-cli/server/dist/index.js'],
                },
            };

            const result = validateMcpConfig(servers, 'roo');

            expect(result.checks.winCliDrift).toContain("command='python' (expected 'node')");
        });
    });

    // ============================================================
    // Coherence — passed flag tracks violations.length exactly (L123)
    // ============================================================
    describe('passed flag coherence (L123)', () => {
        it('passed is true iff violations.length === 0 (L123)', () => {
            const clean: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
            };
            expect(validateMcpConfig(clean, 'claude').passed).toBe(true);

            const dirty: Record<string, McpServerEntry> = {
                'desktop-commander': { command: 'npx' },
            };
            const r = validateMcpConfig(dirty, 'claude');
            expect(r.passed).toBe(false);
            expect(r.violations.length).toBeGreaterThan(0);
        });

        it('skAgentMisplaced is always false in the returned checks (L66, L129 — feature not implemented in this function)', () => {
            // skAgentMisplaced is initialized false (L66) and never mutated in validateMcpConfig.
            // The sk-agent-global check is enforced elsewhere (SK_AGENT_MUST_BE_GLOBAL constant).
            // Pin this so a future implementation that sets it is a deliberate change.
            const servers: Record<string, McpServerEntry> = {
                'roo-state-manager': { command: 'node' },
            };
            expect(validateMcpConfig(servers, 'claude').checks.skAgentMisplaced).toBe(false);
            expect(validateMcpConfig(servers, 'roo').checks.skAgentMisplaced).toBe(false);
        });
    });
});
