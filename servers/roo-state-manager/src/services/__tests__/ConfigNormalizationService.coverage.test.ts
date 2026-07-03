/**
 * #833 Sprint C3 — ConfigNormalizationService branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `ConfigNormalizationService.test.ts` (15 tests) exercises the public
 * normalize/denormalize API thoroughly for the happy paths (Windows + Linux path
 * substitution, secret masking, `${env:}` preservation, regex #537 guard, #759
 * secret restore). It leaves a cluster of genuine conditional branches cold:
 *
 * - `processObject` top-level non-object (L55-57): null/number/boolean/string
 *   passed directly to normalize/denormalize — every base test passes an object.
 * - `processObject` top-level array (L59-61): the Array.isArray.map path at the
 *   entry point — base tests nest values but never a bare array argument.
 * - `processObject` denormalize sensitive non-placeholder value (L91-93): a
 *   sensitive key carrying a plain (non-{{SECRET:}}) string during denormalize
 *   — the else-branch passthrough is never asserted.
 * - denormalize secret restore, UPPER arm (L83): `secretKey.toUpperCase()` match
 *   — base #759 only hits the exact-match arm (L82).
 * - denormalize secret restore, camelCase→UPPER_SNAKE arm (L84): the
 *   `.replace(/([A-Z])/g, '_$1').toUpperCase()` transform (apiKey → API_KEY).
 * - `isSensitiveKey` 'auth'/'secret' members + case-insensitivity (L19, L205-207):
 *   base covers apiKey/token/password only.
 * - `denormalizePath` no-placeholder-but-looksLikePath (L180-182 + L196-200): a
 *   raw path (no placeholder) reaching the OS-separator adaptation — base
 *   denormalize tests always carry placeholders.
 * - `getCurrentContext` real-machine substitution (L45-52): base "default
 *   context" test passes `{ simple: 'value' }` (a non-path) so the real homedir
 *   substitution is never observed.
 * - `looksLikePath` parent-relative `../` (L165): base only tests `./`.
 *
 * A regression in any of these branches would pass the nominal suite silently.
 * This add-only file pins them, each assertion anchored on a source line of
 * `ConfigNormalizationService.ts`.
 */

import { describe, test, expect } from 'vitest';
import { homedir } from 'os';
import { ConfigNormalizationService, MachineContext } from '../ConfigNormalizationService.js';

const windowsContext: MachineContext = {
  os: 'windows',
  homeDir: 'C:\\Users\\TestUser',
  rooRoot: 'D:\\Dev\\roo-extensions',
  envVars: {},
};

const linuxContext: MachineContext = {
  os: 'linux',
  homeDir: '/home/testuser',
  rooRoot: '/opt/roo-extensions',
  envVars: {},
};

describe('ConfigNormalizationService — branch coverage (#833 C3, source-grounded)', () => {

  // ============================================================
  // processObject — top-level non-object entry (L55-57)
  // ============================================================
  describe('processObject — top-level non-object (L55-57)', () => {
    test('normalize a bare string path routes through processValue (L55-56)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      // Top-level string → processObject L55 (typeof !== 'object') → processValue → normalizePath.
      const out = await service.normalize('C:\\Users\\TestUser\\file.txt', 'mode_definition');
      expect(out).toBe('%USERPROFILE%/file.txt');
    });

    test('normalize null/number/boolean passthrough unchanged (processValue L104-106)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      expect(await service.normalize(null, 'mode_definition')).toBe(null);
      expect(await service.normalize(42, 'mode_definition')).toBe(42);
      expect(await service.normalize(true, 'mode_definition')).toBe(true);
    });

    test('denormalize a bare string path adapts separators (L55-56 → denormalizePath)', async () => {
      const service = new ConfigNormalizationService();
      // Top-level string '/a/b/c' on windows → looksLikePath → backslash adaptation.
      const out = await service.denormalize('/a/b/c', 'mode_definition', windowsContext);
      expect(out).toBe('\\a\\b\\c');
    });
  });

  // ============================================================
  // processObject — top-level array (L59-61)
  // ============================================================
  describe('processObject — top-level array (L59-61)', () => {
    test('normalize maps over a top-level array (L59-60)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const out = await service.normalize(
        ['C:\\Users\\TestUser\\a', { nested: 'D:\\Dev\\roo-extensions\\b' }],
        'mode_definition'
      );
      expect(Array.isArray(out)).toBe(true);
      expect(out[0]).toBe('%USERPROFILE%/a');
      expect(out[1].nested).toBe('%ROO_ROOT%/b');
    });

    test('denormalize maps over a top-level array (L59-60)', async () => {
      const service = new ConfigNormalizationService();
      const out = await service.denormalize(
        ['%USERPROFILE%/a', '%ROO_ROOT%/b'],
        'mode_definition',
        windowsContext
      );
      expect(Array.isArray(out)).toBe(true);
      expect(out[0]).toBe('C:\\Users\\TestUser\\a');
      expect(out[1]).toBe('D:\\Dev\\roo-extensions\\b');
    });
  });

  // ============================================================
  // processObject — denormalize secret restore arms (L82-84, L87-89)
  // ============================================================
  describe('processObject — denormalize secret restore arms (L82-89)', () => {
    test('exact-match arm restores {{SECRET:apiKey}} from envVars[apiKey] (L82)', async () => {
      const service = new ConfigNormalizationService();
      const ctx = { ...windowsContext, envVars: { apiKey: 'sk-exact' } };
      const out = await service.denormalize({ apiKey: '{{SECRET:apiKey}}' }, 'mcp_config', ctx);
      expect(out.apiKey).toBe('sk-exact');
    });

    test('UPPER arm restores via secretKey.toUpperCase() = APIKEY (L83)', async () => {
      const service = new ConfigNormalizationService();
      // secretKey='apiKey'; envVars lacks 'apiKey' but has 'APIKEY' (upper match, L83).
      const ctx = { ...windowsContext, envVars: { APIKEY: 'sk-upper' } };
      const out = await service.denormalize({ apiKey: '{{SECRET:apiKey}}' }, 'mcp_config', ctx);
      expect(out.apiKey).toBe('sk-upper');
    });

    test('camelCase→UPPER_SNAKE arm restores apiKey→API_KEY (L84)', async () => {
      const service = new ConfigNormalizationService();
      // 'apiKey'.replace(/([A-Z])/g, '_$1').toUpperCase() === 'API_KEY' (L84).
      const ctx = { ...windowsContext, envVars: { API_KEY: 'sk-snake' } };
      const out = await service.denormalize({ apiKey: '{{SECRET:apiKey}}' }, 'mcp_config', ctx);
      expect(out.apiKey).toBe('sk-snake');
    });

    test('falls back to the placeholder when no env var matches any arm (L87-89)', async () => {
      const service = new ConfigNormalizationService();
      const ctx = { ...windowsContext, envVars: { UNRELATED: 'x' } };
      const out = await service.denormalize({ apiKey: '{{SECRET:apiKey}}' }, 'mcp_config', ctx);
      expect(out.apiKey).toBe('{{SECRET:apiKey}}');
    });
  });

  // ============================================================
  // processObject — denormalize sensitive non-placeholder value (L91-93)
  // ============================================================
  describe('processObject — denormalize sensitive non-placeholder (L91-93)', () => {
    test('a sensitive key with a plain (non-placeholder) string passes through (L91-92)', async () => {
      const service = new ConfigNormalizationService();
      // Value is a real secret string, NOT a {{SECRET:}} placeholder → else-branch passthrough.
      const out = await service.denormalize({ apiKey: 'sk-plain-value' }, 'mcp_config', windowsContext);
      expect(out.apiKey).toBe('sk-plain-value');
    });

    test('a sensitive key with a non-string value passes through unchanged (L79 guard, L91-92)', async () => {
      const service = new ConfigNormalizationService();
      const out = await service.denormalize({ apiKey: 12345 }, 'mcp_config', windowsContext);
      expect(out.apiKey).toBe(12345);
    });
  });

  // ============================================================
  // isSensitiveKey — coverage of SENSITIVE_KEYS members + case-insensitivity (L19, L205-207)
  // ============================================================
  describe('isSensitiveKey — SENSITIVE_KEYS members + case-insensitivity (L205-207)', () => {
    test('masks "authorization" via the "auth" member (L19, L205-207)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const out = await service.normalize({ authorization: 'Bearer xyz' }, 'mcp_config');
      expect(out.authorization).toBe('{{SECRET:authorization}}');
    });

    test('masks "secret" and "clientSecret" keys (L205-207)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const out = await service.normalize({ clientSecret: 'abc', secret: 'xyz' }, 'mcp_config');
      expect(out.clientSecret).toBe('{{SECRET:clientSecret}}');
      expect(out.secret).toBe('{{SECRET:secret}}');
    });

    test('is case-insensitive: upper-case AUTH_TOKEN is sensitive (L206 toLowerCase)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const out = await service.normalize({ AUTH_TOKEN: 'tok' }, 'mcp_config');
      expect(out.AUTH_TOKEN).toBe('{{SECRET:AUTH_TOKEN}}');
    });

    test('does NOT mask keys containing no sensitive substring (username/endpoint)', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      const out = await service.normalize({ username: 'bob', endpoint: 'url' }, 'mcp_config');
      expect(out.username).toBe('bob');
      expect(out.endpoint).toBe('url');
    });
  });

  // ============================================================
  // denormalizePath — no-placeholder raw path, OS-separator adaptation (L180-200)
  // ============================================================
  describe('denormalizePath — no-placeholder raw path, OS-separator adaptation (L180-200)', () => {
    test('a raw unix path denormalized to windows context gets backslashes (L196-197)', async () => {
      const service = new ConfigNormalizationService();
      const out = await service.denormalize({ log: '/var/log/app.log' }, 'mode_definition', windowsContext);
      expect(out.log).toBe('\\var\\log\\app.log');
    });

    test('a raw backslash path denormalized to linux context gets forward slashes (L198-199)', async () => {
      const service = new ConfigNormalizationService();
      // 'C:\\a\\b' looksLikePath (windows abs) → no placeholder → separator flip to '/'.
      const out = await service.denormalize({ p: 'C:\\a\\b' }, 'mode_definition', linuxContext);
      expect(out.p).toBe('C:/a/b');
    });
  });

  // ============================================================
  // getCurrentContext — real-machine substitution (L41, L45-52)
  // ============================================================
  describe('getCurrentContext — real-machine substitution (L45-52)', () => {
    test('denormalize with no context uses os.homedir() for %USERPROFILE% (L41, L45, L185-188)', async () => {
      const service = new ConfigNormalizationService();
      // No contextOverride, no denormalize context → getCurrentContext() (L41, L45-52).
      const out = await service.denormalize({ p: '%USERPROFILE%/x' }, 'mode_definition');
      // The result adapts separators to the current OS; normalize back to forward-slash
      // to compare against the forward-slashed homedir robustly across platforms.
      const fwd = String(out.p).replace(/\\/g, '/');
      expect(fwd.startsWith(homedir().replace(/\\/g, '/'))).toBe(true);
      expect(fwd.endsWith('/x')).toBe(true);
    });
  });

  // ============================================================
  // looksLikePath — parent-relative ../ (L165)
  // ============================================================
  describe('looksLikePath — parent-relative ../ (L165)', () => {
    test('normalizes a parent-relative "..\\sibling\\file" path (L165 arm of ^\\.{1,2}[/\\])', async () => {
      const service = new ConfigNormalizationService(windowsContext);
      // '../' matches ^\.\.?[/\\] → looksLikePath true; no home/rooRoot match → forward-slashed only.
      const out = await service.normalize({ ref: '..\\sibling\\file.txt' }, 'mode_definition');
      expect(out.ref).toBe('../sibling/file.txt');
    });
  });
});
