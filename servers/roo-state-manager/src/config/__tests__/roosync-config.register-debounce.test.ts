/**
 * Tests #2121(b) — registerMachineId debounce
 *
 * Spec (issue #2121, tranche b): stamp `lastSeen` in-memory, write the
 * registry on state-change, not on every MCP cold start.
 *
 * MOCKING STRATEGY: same as roosync-config.test.ts — vi.hoisted() stable mock
 * references + local vi.mock('fs') wrapping the real module (registerMachineId
 * resolves 'fs' dynamically, which lands on the same mocked singleton).
 * Each test configures its mocks fully (restoreMocks resets implementations).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { stableMocks } = vi.hoisted(() => {
	const stableMocks = {
		existsSync: null as any,
		readFileSync: null as any,
		writeFile: null as any,
	};
	return { stableMocks };
});

vi.mock('fs', async (importOriginal) => {
	const realFs: any = await importOriginal();

	stableMocks.existsSync = vi.fn((...args: any[]) => realFs.existsSync(...args));
	stableMocks.readFileSync = vi.fn((...args: any[]) => realFs.readFileSync(...args));
	stableMocks.writeFile = vi.fn((...args: any[]) => realFs.promises.writeFile(...args));

	return {
		...realFs,
		default: {
			...realFs,
			existsSync: stableMocks.existsSync,
			readFileSync: stableMocks.readFileSync,
			promises: {
				...realFs.promises,
				writeFile: stableMocks.writeFile,
			},
		},
		existsSync: stableMocks.existsSync,
		readFileSync: stableMocks.readFileSync,
		promises: {
			...realFs.promises,
			writeFile: stableMocks.writeFile,
		},
	};
});

import { registerMachineId, getLastSeenStamp } from '../roosync-config.js';

const T0 = new Date('2026-09-23T00:00:00.000Z');
const T4H = new Date('2026-09-23T04:00:00.000Z');

/** Racine présente ; le fichier registre existe (contenu fourni). */
function seedRegistry(registry: unknown) {
	stableMocks.existsSync.mockReturnValue(true);
	stableMocks.readFileSync.mockReturnValue(JSON.stringify(registry));
	stableMocks.writeFile.mockResolvedValue(undefined);
}

/** Racine présente, fichier registre ABSENT (première inscription). */
function noRegistryYet() {
	stableMocks.existsSync.mockImplementation((p: any) => !String(p).endsWith('.machine-registry.json'));
	stableMocks.writeFile.mockResolvedValue(undefined);
}

describe('registerMachineId #2121(b) debounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('cold start sur entrée identique (même source, online) → AUCUNE écriture, stamp mémoire rafraîchi', async () => {
		seedRegistry({
			machines: {
				'debounce-stable': {
					machineId: 'debounce-stable',
					firstSeen: '2026-01-01T00:00:00.000Z',
					lastSeen: '2026-09-22T00:00:00.000Z',
					source: 'service',
					status: 'online',
				},
			},
			lastUpdated: '2026-09-22T00:00:00.000Z',
		});

		const result = await registerMachineId('debounce-stable', '/tmp/test-shared', 'service');

		expect(result).toBe(true);
		expect(stableMocks.writeFile).not.toHaveBeenCalled();
		expect(getLastSeenStamp('debounce-stable')).toBe(T0.toISOString());

		// Second cold start 4h plus tard : toujours aucune écriture, stamp avancé
		vi.setSystemTime(T4H);
		const result2 = await registerMachineId('debounce-stable', '/tmp/test-shared', 'service');

		expect(result2).toBe(true);
		expect(stableMocks.writeFile).not.toHaveBeenCalled();
		expect(getLastSeenStamp('debounce-stable')).toBe(T4H.toISOString());
	});

	test('première inscription (machine absente) → écriture, firstSeen = lastSeen = now, stamp posé', async () => {
		noRegistryYet();

		const result = await registerMachineId('debounce-new', '/tmp/test-shared', 'service');

		expect(result).toBe(true);
		expect(stableMocks.writeFile).toHaveBeenCalledTimes(1);

		const written = JSON.parse(String(stableMocks.writeFile.mock.calls[0][1]));
		expect(written.machines['debounce-new'].firstSeen).toBe(T0.toISOString());
		expect(written.machines['debounce-new'].lastSeen).toBe(T0.toISOString());
		expect(written.machines['debounce-new'].source).toBe('service');
		expect(written.machines['debounce-new'].status).toBe('online');
		expect(written.lastUpdated).toBe(T0.toISOString());
		expect(getLastSeenStamp('debounce-new')).toBe(T0.toISOString());
	});

	test('changement de source → écriture, firstSeen préservé', async () => {
		seedRegistry({
			machines: {
				'debounce-src': {
					machineId: 'debounce-src',
					firstSeen: '2026-01-01T00:00:00.000Z',
					lastSeen: '2026-09-22T00:00:00.000Z',
					source: 'config',
					status: 'online',
				},
			},
		});

		const result = await registerMachineId('debounce-src', '/tmp/test-shared', 'service');

		expect(result).toBe(true);
		expect(stableMocks.writeFile).toHaveBeenCalledTimes(1);

		const written = JSON.parse(String(stableMocks.writeFile.mock.calls[0][1]));
		expect(written.machines['debounce-src'].firstSeen).toBe('2026-01-01T00:00:00.000Z');
		expect(written.machines['debounce-src'].source).toBe('service');
		expect(written.machines['debounce-src'].lastSeen).toBe(T0.toISOString());
	});

	test("status offline posé ailleurs → cold start ré-écrit (auto-guérison vers online)", async () => {
		seedRegistry({
			machines: {
				'debounce-offline': {
					machineId: 'debounce-offline',
					firstSeen: '2026-01-01T00:00:00.000Z',
					lastSeen: '2026-09-22T00:00:00.000Z',
					source: 'service',
					status: 'offline',
				},
			},
		});

		const result = await registerMachineId('debounce-offline', '/tmp/test-shared', 'service');

		expect(result).toBe(true);
		expect(stableMocks.writeFile).toHaveBeenCalledTimes(1);

		const written = JSON.parse(String(stableMocks.writeFile.mock.calls[0][1]));
		expect(written.machines['debounce-offline'].status).toBe('online');
		expect(written.machines['debounce-offline'].firstSeen).toBe('2026-01-01T00:00:00.000Z');
	});

	test('machine inconnue du process → stamp mémoire undefined', () => {
		expect(getLastSeenStamp('never-registered-anywhere')).toBeUndefined();
	});
});
