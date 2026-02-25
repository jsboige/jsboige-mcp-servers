/**
 * Tests pour MessageHandler
 * Issue #492 - Couverture des services RooSync non testés
 *
 * @module services/roosync/__tests__/MessageHandler
 */

import { describe, test, expect } from 'vitest';
import { MessageHandler } from '../MessageHandler.js';

// Minimal config mock
const mockConfig = {
	machineId: 'myia-ai-01',
	sharedPath: '/mock/shared',
	gdrivePath: '/mock/gdrive'
} as any;

describe('MessageHandler', () => {
	// ============================================================
	// Constructor
	// ============================================================

	describe('constructor', () => {
		test('creates instance with config', () => {
			const handler = new MessageHandler(mockConfig);
			expect(handler).toBeInstanceOf(MessageHandler);
		});
	});

	// ============================================================
	// parseLogs
	// ============================================================

	describe('parseLogs', () => {
		test('splits output by newlines', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseLogs('line1\nline2\nline3');
			expect(result).toEqual(['line1', 'line2', 'line3']);
		});

		test('trims whitespace from lines', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseLogs('  line1  \n  line2  ');
			expect(result).toEqual(['line1', 'line2']);
		});

		test('filters out empty lines', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseLogs('line1\n\n\nline2\n\n');
			expect(result).toEqual(['line1', 'line2']);
		});

		test('returns empty array for empty input', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseLogs('');
			expect(result).toEqual([]);
		});

		test('handles single line', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseLogs('single line');
			expect(result).toEqual(['single line']);
		});

		test('handles Windows line endings', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseLogs('line1\r\nline2\r\n');
			// \r gets trimmed by .trim()
			expect(result).toEqual(['line1', 'line2']);
		});
	});

	// ============================================================
	// parseChanges
	// ============================================================

	describe('parseChanges', () => {
		test('returns empty changes for unrelated output', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseChanges('some random output');
			expect(result.filesModified).toHaveLength(0);
			expect(result.filesCreated).toHaveLength(0);
			expect(result.filesDeleted).toHaveLength(0);
		});

		test('detects sync-config.ref.json modification', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseChanges(
				'Configuration de référence mise à jour avec succès'
			);
			expect(result.filesModified).toContain('sync-config.ref.json');
		});

		test('does not detect modification without exact message', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseChanges('Configuration partielle');
			expect(result.filesModified).toHaveLength(0);
		});

		test('returns correct shape even for empty output', () => {
			const handler = new MessageHandler(mockConfig);
			const result = handler.parseChanges('');
			expect(result).toEqual({
				filesModified: [],
				filesCreated: [],
				filesDeleted: []
			});
		});
	});
});
