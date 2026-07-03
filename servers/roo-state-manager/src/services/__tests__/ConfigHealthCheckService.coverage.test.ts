/**
 * #833 Sprint C3 — ConfigHealthCheckService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `ConfigHealthCheckService.test.ts` (36 tests, real-tmpdir fs) is very
 * thorough: it covers all 7 config types, the 4 check kinds, quickCheck,
 * checkBatch, and the mcp_loadable edge cases (command-missing, disabled,
 * disabled-not-boolean, args-not-array, multi-issues, server count, non-mcp
 * skip, mcpServers-string). It leaves a cluster of genuine branches cold:
 *
 * - checkHealth **readFile catch** (L106-119): the path where `access` succeeds
 *   (file_readable passes) but the subsequent `readFile` throws. Base tests fail
 *   at `access` (non-existent) → early-return at L91 before readFile; no test
 *   reaches L106-119. Triggered here with a directory path (access succeeds on a
 *   dir, readFile throws EISDIR).
 * - checkRequiredFields **empty-requiredFields arm** (L258-264): rules_config /
 *   settings_config have `[]` required fields; base exercises it but never
 *   asserts the specific "Aucun champ requis défini" message + passed=true.
 * - checkMcpLoadable **empty mcpServers `{}`** (L315-320): base never runs the
 *   mcp_loadable check against an empty servers map → "0 serveurs MCP valides"
 *   message is cold.
 * - checkHealth **mcp_loadable skip when parsedContent undefined** (L143): base
 *   "skip required_fields when json_valid fails" covers the L133 guard, not the
 *   L143 `&& parsedContent` arm for mcp_loadable specifically.
 * - checkRequiredFields **missing-fields details + join** (L276-281): base
 *   checks the warning includes a field name but not the `details.missing` array
 *   nor the `', '` join format. Also pins the all-present count message (L268-273).
 * - checkHealth **early-return structure on file_readable fail** (L92-100):
 *   base "non-existent file" asserts healthy=false + errors>0 but not the exact
 *   structure (warnings empty, only file_readable in checks, no downstream checks).
 * - checkMcpLoadable **no-mcpServers-defined exact message** (L291): base
 *   mcpServers-string test exercises the branch but asserts healthy only, not
 *   the "Pas de mcpServers défini" message.
 *
 * A regression in any of these branches would pass the nominal suite silently.
 * This add-only file pins them, each assertion anchored on a source line of
 * `ConfigHealthCheckService.ts`. Uses the established real-tmpdir pattern.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { ConfigHealthCheckService } from '../ConfigHealthCheckService.js';
import type { Logger } from '../../utils/logger.js';

describe('ConfigHealthCheckService — branch coverage (#833 C3, source-grounded)', () => {
  let healthCheck: ConfigHealthCheckService;
  let mockLogger: Logger;
  let tempDir: string;

  beforeEach(async () => {
    mockLogger = {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as any;
    healthCheck = new ConfigHealthCheckService(mockLogger);
    tempDir = await mkdtemp(join(tmpdir(), 'healthcheck-cov-'));
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // checkHealth — readFile catch (L106-119) via directory path
  // ============================================================
  describe('checkHealth — readFile catch (access OK, readFile EISDIR) L106-119', () => {
    test('a directory path: file_readable passes (access OK) but readFile throws → healthy=false + read error', async () => {
      // mkdir returns undefined on this Node — construct the path explicitly.
      const dirPath = join(tempDir, 'a-directory');
      await mkdir(dirPath);
      // access() succeeds on a directory → file_readable passes (L222-227).
      // readFile() on a directory throws EISDIR → L108 catch (L109-118).
      const result = await healthCheck.checkHealth(dirPath, 'mcp_config');

      expect(result.healthy).toBe(false);
      // file_readable check passed (access succeeded on the dir).
      const readable = result.checks.find(c => c.name === 'file_readable');
      expect(readable?.passed).toBe(true);
      // The readFile failure surfaces as an error mentioning the read failure.
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('Impossible de lire le fichier'))).toBe(true);
      // Downstream checks (json_valid/required_fields) never ran — readFile aborted.
      expect(result.checks.some(c => c.name === 'json_valid')).toBe(false);
      expect(result.checks.some(c => c.name === 'required_fields')).toBe(false);
    });

    test('readFile catch path returns the canonical result shape (L110-118)', async () => {
      const dirPath = join(tempDir, 'dir-shape');
      await mkdir(dirPath);
      const result = await healthCheck.checkHealth(dirPath, 'mode_definition');

      expect(result).toMatchObject({
        healthy: false,
        filePath: dirPath,
        configType: 'mode_definition',
      });
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  // ============================================================
  // checkHealth — early-return structure on file_readable fail (L92-100)
  // ============================================================
  describe('checkHealth — early-return structure when file not readable (L92-100)', () => {
    test('non-readable file: only file_readable ran, warnings empty, errors carry the message', async () => {
      const result = await healthCheck.checkHealth('/nonexistent/missing.json', 'mcp_config');

      expect(result.healthy).toBe(false);
      // Only the file_readable check ran (early-return at L92-100).
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].name).toBe('file_readable');
      expect(result.checks[0].passed).toBe(false);
      // Warnings stay empty (no required_fields/mcp_loadable reached).
      expect(result.warnings).toHaveLength(0);
      // The error echoes the file_readable failure message (L86, L91-99).
      expect(result.errors.some(e => e.includes('Fichier non lisible') || e.includes('non accessible'))).toBe(true);
    });
  });

  // ============================================================
  // checkRequiredFields — empty-requiredFields message (L258-264)
  // ============================================================
  describe('checkRequiredFields — empty requiredFields arm (L258-264)', () => {
    test('rules_config with [] required fields yields the "Aucun champ requis défini" message', async () => {
      const filePath = join(tempDir, 'rules.json');
      await writeFile(filePath, JSON.stringify({ anything: 'goes' }));

      const result = await healthCheck.checkHealth(filePath, 'rules_config', {
        checks: ['json_valid', 'required_fields'],
      });

      const reqCheck = result.checks.find(c => c.name === 'required_fields');
      // L258-264: empty requiredFields → passed:true + the specific message.
      expect(reqCheck?.passed).toBe(true);
      expect(reqCheck?.message).toContain('Aucun champ requis défini');
    });

    test('settings_config empty-requiredFields also passes with the message', async () => {
      const filePath = join(tempDir, 'settings.json');
      await writeFile(filePath, JSON.stringify({ foo: 'bar' }));

      const result = await healthCheck.checkHealth(filePath, 'settings_config', {
        checks: ['json_valid', 'required_fields'],
      });

      const reqCheck = result.checks.find(c => c.name === 'required_fields');
      expect(reqCheck?.passed).toBe(true);
      expect(reqCheck?.message).toContain('Aucun champ requis défini');
    });
  });

  // ============================================================
  // checkRequiredFields — missing details + join, all-present count (L266-281)
  // ============================================================
  describe('checkRequiredFields — details + join + all-present count (L266-281)', () => {
    test('missing fields report details.missing + details.required + comma-join (L276-281)', async () => {
      const filePath = join(tempDir, 'mode.json');
      // mode_definition requires ['slug','name','roleDefinition'] — provide only slug.
      await writeFile(filePath, JSON.stringify({ slug: 'x' }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition', {
        checks: ['json_valid', 'required_fields'],
      });

      const reqCheck = result.checks.find(c => c.name === 'required_fields');
      expect(reqCheck?.passed).toBe(false);
      // details.missing lists the two absent fields; details.required lists all three.
      expect(reqCheck?.details?.missing).toEqual(expect.arrayContaining(['name', 'roleDefinition']));
      expect(reqCheck?.details?.required).toEqual(['slug', 'name', 'roleDefinition']);
      // Message uses ', ' join of the missing names (L279).
      expect(reqCheck?.message).toContain('Champs manquants:');
      expect(reqCheck?.message).toContain(', ');
    });

    test('all required fields present → passed:true with the count message (L268-273)', async () => {
      const filePath = join(tempDir, 'mode.json');
      await writeFile(filePath, JSON.stringify({
        slug: 'x', name: 'X', roleDefinition: 'role',
      }));

      const result = await healthCheck.checkHealth(filePath, 'mode_definition', {
        checks: ['json_valid', 'required_fields'],
      });

      const reqCheck = result.checks.find(c => c.name === 'required_fields');
      expect(reqCheck?.passed).toBe(true);
      // "(3)" — the requiredFields.length count (L272).
      expect(reqCheck?.message).toContain('Tous les champs requis présents');
      expect(reqCheck?.message).toContain('(3)');
    });
  });

  // ============================================================
  // checkMcpLoadable — empty mcpServers {} → "0 serveurs MCP valides" (L315-320)
  // ============================================================
  describe('checkMcpLoadable — empty mcpServers map (L315-320)', () => {
    test('mcp_config with mcpServers={} and mcp_loadable check → "0 serveurs MCP valides"', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({ mcpServers: {} }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable'],
      });

      const loadable = result.checks.find(c => c.name === 'mcp_loadable');
      // Empty servers → loop body never runs → issues=[] → L315-320 valid branch.
      expect(loadable?.passed).toBe(true);
      expect(loadable?.message).toContain('0 serveurs MCP valides');
      expect(result.healthy).toBe(true);
    });

    test('mcpServers undefined → "Pas de mcpServers défini" exact message (L287-293)', async () => {
      const filePath = join(tempDir, 'mcp.json');
      // No mcpServers key at all → L287 truthy check fails → L288-292 message branch.
      await writeFile(filePath, JSON.stringify({ other: true }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable'],
      });

      const loadable = result.checks.find(c => c.name === 'mcp_loadable');
      expect(loadable?.passed).toBe(true);
      expect(loadable?.message).toBe('Pas de mcpServers défini');
    });
  });

  // ============================================================
  // checkHealth — mcp_loadable skip when parsedContent undefined (L143)
  // ============================================================
  describe('checkHealth — mcp_loadable skipped on invalid JSON (L143 && parsedContent)', () => {
    test('invalid JSON + mcp_loadable requested: mcp_loadable never runs (parsedContent undefined)', async () => {
      const filePath = join(tempDir, 'broken.json');
      await writeFile(filePath, '{ not valid }');

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable'],
      });

      // json_valid failed → parsedContent stays undefined → L143 guard skips mcp_loadable.
      expect(result.checks.some(c => c.name === 'mcp_loadable')).toBe(false);
      expect(result.healthy).toBe(false);
      // The only error is the json_valid failure (no mcp_loadable warning).
      expect(result.errors.some(e => e.includes('JSON invalide'))).toBe(true);
    });
  });

  // ============================================================
  // checkMcpLoadable — command-missing only when NOT disabled (L305)
  // ============================================================
  describe('checkMcpLoadable — command guard honors disabled (L300-307)', () => {
    test('enabled server without command flags the issue; disabled server without command does not', async () => {
      const filePath = join(tempDir, 'mcp.json');
      await writeFile(filePath, JSON.stringify({
        mcpServers: {
          'enabled-no-cmd': { /* no command, not disabled */ },
          'disabled-no-cmd': { disabled: true /* no command needed */ },
        },
      }));

      const result = await healthCheck.checkHealth(filePath, 'mcp_config', {
        checks: ['json_valid', 'mcp_loadable'],
      });

      const loadable = result.checks.find(c => c.name === 'mcp_loadable');
      expect(loadable?.passed).toBe(false);
      // Only enabled-no-cmd is flagged; disabled-no-cmd is exempted by !s.disabled (L305).
      expect(loadable?.message).toContain("enabled-no-cmd: 'command' manquant");
      expect(loadable?.message).not.toContain("disabled-no-cmd: 'command' manquant");
    });
  });
});
