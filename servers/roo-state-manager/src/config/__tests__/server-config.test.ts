/**
 * Tests for server-config.ts
 * Issue #492 - Coverage for configuration module
 *
 * @module config/__tests__/server-config
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockServer } = vi.hoisted(() => ({
	mockServer: vi.fn()
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
	Server: mockServer
}));

import {
	SERVER_CONFIG,
	CACHE_CONFIG,
	INDEXING_CONFIG,
	OUTPUT_CONFIG,
	ANTI_LEAK_CONFIG,
	createMcpServer
} from '../server-config.js';

describe('server-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// SERVER_CONFIG
	// ============================================================

	describe('SERVER_CONFIG', () => {
		test('has name roo-state-manager', () => {
			expect(SERVER_CONFIG.name).toBe('roo-state-manager');
		});

		test('has a version string', () => {
			expect(typeof SERVER_CONFIG.version).toBe('string');
			expect(SERVER_CONFIG.version.length).toBeGreaterThan(0);
		});

		test('has capabilities with tools', () => {
			expect(SERVER_CONFIG.capabilities).toBeDefined();
			expect(SERVER_CONFIG.capabilities.tools).toBeDefined();
		});
	});

	// ============================================================
	// CACHE_CONFIG
	// ============================================================

	describe('CACHE_CONFIG', () => {
		test('has MAX_CACHE_SIZE of 1000', () => {
			expect(CACHE_CONFIG.MAX_CACHE_SIZE).toBe(1000);
		});

		test('has CACHE_TTL_MS of 1 hour', () => {
			expect(CACHE_CONFIG.CACHE_TTL_MS).toBe(3600000);
		});

		test('has DEFAULT_WORKSPACE', () => {
			expect(typeof CACHE_CONFIG.DEFAULT_WORKSPACE).toBe('string');
		});
	});

	// ============================================================
	// INDEXING_CONFIG
	// ============================================================

	describe('INDEXING_CONFIG', () => {
		test('has BATCH_SIZE defaulting to 50', () => {
			expect(INDEXING_CONFIG.BATCH_SIZE).toBe(50);
		});

		test('has MAX_CONCURRENT_REQUESTS of 5', () => {
			expect(INDEXING_CONFIG.MAX_CONCURRENT_REQUESTS).toBe(5);
		});

		test('EMBEDDING_MODEL reads from env or defaults', () => {
			const model = INDEXING_CONFIG.EMBEDDING_MODEL;
			expect(typeof model).toBe('string');
			expect(model.length).toBeGreaterThan(0);
		});
	});

	// ============================================================
	// OUTPUT_CONFIG
	// ============================================================

	describe('OUTPUT_CONFIG', () => {
		test('has MAX_OUTPUT_LENGTH of 300000', () => {
			expect(OUTPUT_CONFIG.MAX_OUTPUT_LENGTH).toBe(300000);
		});

		test('has SKELETON_CACHE_DIR_NAME', () => {
			expect(OUTPUT_CONFIG.SKELETON_CACHE_DIR_NAME).toBe('.skeletons');
		});
	});

	// ============================================================
	// ANTI_LEAK_CONFIG
	// ============================================================

	describe('ANTI_LEAK_CONFIG', () => {
		test('CONSISTENCY_CHECK_INTERVAL is 24h', () => {
			expect(ANTI_LEAK_CONFIG.CONSISTENCY_CHECK_INTERVAL).toBe(24 * 60 * 60 * 1000);
		});

		test('MIN_REINDEX_INTERVAL is 4h', () => {
			expect(ANTI_LEAK_CONFIG.MIN_REINDEX_INTERVAL).toBe(4 * 60 * 60 * 1000);
		});

		test('MAX_BACKGROUND_INTERVAL is 5min', () => {
			expect(ANTI_LEAK_CONFIG.MAX_BACKGROUND_INTERVAL).toBe(5 * 60 * 1000);
		});
	});

	// ============================================================
	// createMcpServer
	// ============================================================

	describe('createMcpServer', () => {
		test('creates Server with name and version', () => {
			mockServer.mockImplementation(() => ({}));

			createMcpServer(SERVER_CONFIG);

			expect(mockServer).toHaveBeenCalledWith(
				{ name: SERVER_CONFIG.name, version: SERVER_CONFIG.version },
				{ capabilities: SERVER_CONFIG.capabilities }
			);
		});

		test('returns server instance', () => {
			const fakeServer = { start: vi.fn() };
			mockServer.mockImplementation(() => fakeServer);

			const server = createMcpServer(SERVER_CONFIG);

			expect(server).toBe(fakeServer);
		});
	});
});
