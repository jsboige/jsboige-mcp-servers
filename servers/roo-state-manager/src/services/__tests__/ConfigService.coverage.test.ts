/**
 * Coverage complement for ConfigService.ts — Issue #833 Sprint C3
 *
 * Add-only. The existing suite (ConfigService.test.ts, Fix #634) drives the
 * REAL implementation against a real temp filesystem, so it never reaches the
 * three catch blocks' *defensive* arms — the ones that only fire when a
 * dependency throws a **non-`Error`** value (fs / readJSONFileWithoutBOM always
 * reject with `Error` instances in practice), nor the `SyntaxError`-instance
 * path of getConfigVersion (readJSONFileWithoutBOM's raw `JSON.parse` throws a
 * SyntaxError, but no existing test feeds getConfigVersion malformed JSON), nor
 * the falsy arms of findConfigPath's env-derived path candidates.
 *
 * Strategy (tests-only, zero source / existing-test change):
 *   - mock ../../utils/encoding-helpers.js  → control loadConfig (L77) and
 *     getConfigVersion (L135) read outcomes. NB the mock path depth matches the
 *     module the SUT resolves ('../utils/encoding-helpers.js' from src/services)
 *     — a shallower/deeper path would silently no-op.
 *   - mock 'fs' keeping every export real except a controllable promises.writeFile
 *     wrapper → drive saveConfig (L106) into its catch with a non-Error reject.
 *   - vi.stubEnv for findConfigPath's USERPROFILE/ROO_ROOT candidates (L164/L167).
 *
 * Targets these uncovered branch arms (source line). For each `instanceof Error`
 * ternary BOTH sides are exercised — a non-Error reject (String(error)/undefined
 * cause) AND a generic non-SyntaxError Error reject (error.message/error cause):
 *   L91  loadConfig       `error instanceof Error ? error.message : String(error)`
 *   L94  loadConfig       `error instanceof Error ? error : undefined`
 *   L112 saveConfig       `... error.message : String(error)`
 *   L115 saveConfig       `... error : undefined`
 *   L147 getConfigVersion `error instanceof SyntaxError` (true arm)
 *   L150 getConfigVersion `... error.message : String(error)`
 *   L153 getConfigVersion `... error : undefined`
 *   L164 findConfigPath   `process.env.USERPROFILE || ''` (falsy `''` arm)
 *   L167 findConfigPath   `process.env.ROO_ROOT ? ... : ...` (falsy alternate arm)
 *   L193 findSharedStatePath `if (process.env.ROOSYNC_SHARED_PATH)` (falsy arm)
 *        + L196/L197 the cwd/roo-config fallback return
 *
 * Intentionally left uncovered (skip-with-evidence, NOT a test gap):
 *   L175 findConfigPath  `} catch { continue; }` — existsSync only throws on
 *        exotic path errors; forcing it needs mocking a Node fs internal for a
 *        purely defensive continue. Marginal value, high blast radius.
 *   L181 findConfigPath  default `return join(possiblePaths[1], ...)` — in-repo
 *        UNREACHABLE: possiblePaths[2] = join(cwd, '../../../../roo-config')
 *        resolves to the repository's own roo-config/ (which exists), so the
 *        loop always returns at L173 before exhausting. A source change would be
 *        required to exercise it; out of scope for a tests-only C3 pass.
 *
 * @module services/__tests__/ConfigService.coverage
 */

import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

// Control the JSON read used by loadConfig (L77) and getConfigVersion (L135).
// Path depth `../../utils` from this __tests__ dir === the SUT's `../utils`
// (both -> src/utils/encoding-helpers.js). Same module = the mock actually binds.
vi.mock('../../utils/encoding-helpers.js', () => ({
	readJSONFileWithoutBOM: vi.fn(),
}));

// Keep the whole 'fs' module real (existsSync, mkdir, rm, readFile used by the
// tests' own setup), except wrap promises.writeFile so saveConfig can be driven
// into its catch. The wrapper defaults to the real writeFile so setup still works.
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		promises: {
			...actual.promises,
			writeFile: vi.fn((...args: unknown[]) =>
				(actual.promises.writeFile as (...a: unknown[]) => Promise<void>)(...args),
			),
		},
	};
});

// Fix #634 idiom: guarantee the real ConfigService (not a global auto-mock).
vi.unmock('../../services/ConfigService.js');

import { ConfigService } from '../../services/ConfigService.js';
import { readJSONFileWithoutBOM } from '../../utils/encoding-helpers.js';
import { promises as fs, existsSync } from 'fs';
import { ConfigServiceErrorCode } from '../../types/errors.js';

const readMock = vi.mocked(readJSONFileWithoutBOM);
const writeMock = vi.mocked(fs.writeFile);

const testRoot = join(tmpdir(), 'configservice-coverage-833');

beforeAll(async () => {
	await fs.mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	readMock.mockReset();
	writeMock.mockClear(); // clear calls but KEEP the real-writeFile wrapper impl
});

describe('ConfigService — error-path & fallback branches (coverage #833)', () => {
	describe('loadConfig catch — non-Error rejection (source L90-95)', () => {
		test('non-Error reject → CONFIG_LOAD_FAILED, String(error) message, undefined cause', async () => {
			const cfgPath = join(testRoot, 'load-nonerror.json');
			await fs.writeFile(cfgPath, '{}', 'utf-8'); // real file → existsSync guard (L72) passes
			readMock.mockRejectedValue('plain-string-load-failure'); // non-Error, non-SyntaxError

			const svc = new ConfigService(cfgPath);
			let err: any;
			try {
				await svc.loadConfig();
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.code).toBe(ConfigServiceErrorCode.CONFIG_LOAD_FAILED);
			expect(err.message).toContain('plain-string-load-failure'); // L91 String(error) arm
			expect(err.cause).toBeUndefined(); // L94 `: undefined` arm
		});

		test('generic Error reject → error.message + cause arms (L91/L94 truthy sides)', async () => {
			const cfgPath = join(testRoot, 'load-generic-error.json');
			await fs.writeFile(cfgPath, '{}', 'utf-8');
			const genErr = new Error('generic-load-error'); // Error but NOT SyntaxError → generic catch
			readMock.mockRejectedValue(genErr);

			const svc = new ConfigService(cfgPath);
			let err: any;
			try {
				await svc.loadConfig();
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.code).toBe(ConfigServiceErrorCode.CONFIG_LOAD_FAILED);
			expect(err.message).toContain('generic-load-error'); // L91 `error.message` arm
			expect(err.cause).toBe(genErr); // L94 `error instanceof Error ? error` arm
		});
	});

	describe('saveConfig catch — non-Error rejection (source L108-117)', () => {
		test('non-Error writeFile reject → CONFIG_SAVE_FAILED, String(error) message, undefined cause', async () => {
			const cfgPath = join(testRoot, 'save-nonerror.json');
			const svc = new ConfigService(cfgPath);
			writeMock.mockRejectedValueOnce('plain-string-save-failure'); // only this write throws

			let err: any;
			try {
				await svc.saveConfig({ any: 'value' });
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.code).toBe(ConfigServiceErrorCode.CONFIG_SAVE_FAILED);
			expect(err.message).toContain('plain-string-save-failure'); // L112 String(error) arm
			expect(err.cause).toBeUndefined(); // L115 `: undefined` arm
		});
	});

	describe('getConfigVersion catch — SyntaxError vs non-Error (source L137-155)', () => {
		async function makeSvcWithSharedConfig(dirName: string): Promise<ConfigService> {
			const sharedDir = join(testRoot, dirName);
			await fs.mkdir(sharedDir, { recursive: true });
			await fs.writeFile(join(sharedDir, 'sync-config.json'), '{}', 'utf-8'); // existsSync (L130) passes
			vi.stubEnv('ROOSYNC_SHARED_PATH', sharedDir); // findSharedStatePath reads it in ctor
			return new ConfigService(join(testRoot, 'unused-cfg.json'));
		}

		test('SyntaxError reject → CONFIG_INVALID, message carries error.message, cause is the SyntaxError', async () => {
			const svc = await makeSvcWithSharedConfig('gcv-syntax');
			const synErr = new SyntaxError('Unexpected token } in JSON');
			readMock.mockRejectedValue(synErr);

			let err: any;
			try {
				await svc.getConfigVersion();
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.code).toBe(ConfigServiceErrorCode.CONFIG_INVALID); // L143 (L147 instanceof-true arm)
			expect(err.message).toContain('Unexpected token } in JSON'); // L142 error.message
			expect(err.cause).toBe(synErr); // L145 cause = error
		});

		test('non-Error reject → CONFIG_VERSION_READ_FAILED, String(error) message, undefined cause', async () => {
			const svc = await makeSvcWithSharedConfig('gcv-nonerror');
			readMock.mockRejectedValue('plain-string-version-failure');

			let err: any;
			try {
				await svc.getConfigVersion();
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.code).toBe(ConfigServiceErrorCode.CONFIG_VERSION_READ_FAILED); // L151
			expect(err.message).toContain('plain-string-version-failure'); // L150 String(error) arm
			expect(err.cause).toBeUndefined(); // L153 `: undefined` arm
		});

		test('generic Error reject → error.message + cause arms (L150/L153 truthy sides)', async () => {
			const svc = await makeSvcWithSharedConfig('gcv-generic');
			const genErr = new Error('generic-version-error'); // Error but NOT SyntaxError
			readMock.mockRejectedValue(genErr);

			let err: any;
			try {
				await svc.getConfigVersion();
			} catch (e) {
				err = e;
			}
			expect(err).toBeDefined();
			expect(err.code).toBe(ConfigServiceErrorCode.CONFIG_VERSION_READ_FAILED);
			expect(err.message).toContain('generic-version-error'); // L150 `error.message` arm
			expect(err.cause).toBe(genErr); // L153 `error instanceof Error ? error` arm
		});
	});

	describe('findConfigPath — env-candidate falsy arms (source L163-168)', () => {
		test('USERPROFILE="" and ROO_ROOT="" exercise both falsy arms; ctor still yields a settings.json path', () => {
			// Both env vars falsy → L164 `|| ''` right arm AND L167 alternate arm are
			// evaluated during possiblePaths construction (independent of which
			// candidate the loop ultimately matches).
			vi.stubEnv('USERPROFILE', '');
			vi.stubEnv('ROO_ROOT', '');
			vi.stubEnv('ROOSYNC_SHARED_PATH', testRoot); // keep findSharedStatePath deterministic

			const svc = new ConfigService(); // no explicit path → findConfigPath() runs
			const resolved = (svc as unknown as { configPath: string }).configPath;
			expect(typeof resolved).toBe('string');
			expect(resolved.endsWith('settings.json')).toBe(true);
			// The in-repo roo-config/ (via possiblePaths[2]) exists, so existsSync
			// returns a real path at L173 — proving the loop body's happy arm too.
			expect(existsSync(resolved.replace(/settings\.json$/, ''))).toBe(true);
		});
	});

	describe('findSharedStatePath — cwd fallback when ROOSYNC_SHARED_PATH unset (source L191-197)', () => {
		test('falsy ROOSYNC_SHARED_PATH → default cwd/roo-config path', () => {
			vi.stubEnv('ROOSYNC_SHARED_PATH', ''); // falsy → L192 guard false, falls to L196/L197
			const svc = new ConfigService(join(testRoot, 'unused.json'));
			const shared = svc.getSharedStatePath();
			expect(shared.endsWith('roo-config')).toBe(true); // L196 join(cwd,'roo-config') → L197 return
		});
	});
});
