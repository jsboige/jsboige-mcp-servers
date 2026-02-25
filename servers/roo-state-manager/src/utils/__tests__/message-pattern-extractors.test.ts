/**
 * Tests pour message-pattern-extractors.ts
 * Issue #492 - Couverture des utilitaires non testés
 *
 * @module utils/__tests__/message-pattern-extractors
 */

import { describe, test, expect } from 'vitest';
import { cleanMode, createInstruction, extractTimestamp } from '../message-pattern-extractors.js';

describe('message-pattern-extractors', () => {
	// ============================================================
	// cleanMode
	// ============================================================

	describe('cleanMode', () => {
		test('returns lowercase cleaned mode', () => {
			expect(cleanMode('Code')).toBe('code');
		});

		test('removes non-alphanumeric characters', () => {
			expect(cleanMode('code-simple')).toBe('codesimple');
		});

		test('removes special characters', () => {
			expect(cleanMode('debug!@#$%complex')).toBe('debugcomplex');
		});

		test('trims whitespace', () => {
			expect(cleanMode('  code  ')).toBe('code');
		});

		test('returns "task" for empty string', () => {
			expect(cleanMode('')).toBe('task');
		});

		test('returns "task" for null/undefined', () => {
			expect(cleanMode(null as any)).toBe('task');
			expect(cleanMode(undefined as any)).toBe('task');
		});

		test('preserves underscores and spaces', () => {
			expect(cleanMode('code_complex')).toBe('code_complex');
		});

		test('handles numeric modes', () => {
			expect(cleanMode('mode123')).toBe('mode123');
		});
	});

	// ============================================================
	// createInstruction
	// ============================================================

	describe('createInstruction', () => {
		const timestamp = Date.now();

		test('creates instruction with valid input', () => {
			const message = 'This is a valid instruction message that is long enough';
			const result = createInstruction(timestamp, 'code', message);
			expect(result).not.toBeNull();
			expect(result!.timestamp).toBe(timestamp);
			expect(result!.mode).toBe('code');
			expect(result!.message).toBe(message);
		});

		test('returns null for empty message', () => {
			expect(createInstruction(timestamp, 'code', '')).toBeNull();
		});

		test('returns null for message shorter than minLength', () => {
			expect(createInstruction(timestamp, 'code', 'short')).toBeNull();
		});

		test('returns null for non-string message', () => {
			expect(createInstruction(timestamp, 'code', 123 as any)).toBeNull();
			expect(createInstruction(timestamp, 'code', null as any)).toBeNull();
		});

		test('trims message whitespace', () => {
			const message = '   This is a long enough message with spaces   ';
			const result = createInstruction(timestamp, 'code', message);
			expect(result).not.toBeNull();
			expect(result!.message).toBe(message.trim());
		});

		test('truncates message exceeding maxLength', () => {
			const longMessage = 'A'.repeat(300);
			const result = createInstruction(timestamp, 'code', longMessage);
			expect(result).not.toBeNull();
			expect(result!.message.length).toBe(200);
			expect(result!.message.endsWith('...')).toBe(true);
		});

		test('respects custom minLength', () => {
			const result = createInstruction(timestamp, 'code', 'short msg', 5);
			expect(result).not.toBeNull();
		});

		test('respects custom maxLength', () => {
			const message = 'This is a message that should be truncated at 50';
			const result = createInstruction(timestamp, 'code', message, 5, 30);
			expect(result).not.toBeNull();
			expect(result!.message.length).toBe(30);
			expect(result!.message.endsWith('...')).toBe(true);
		});

		test('does not truncate when maxLength is 0', () => {
			const longMessage = 'A'.repeat(500);
			const result = createInstruction(timestamp, 'code', longMessage, 20, 0);
			expect(result).not.toBeNull();
			expect(result!.message.length).toBe(500);
		});

		test('cleans mode via cleanMode', () => {
			const result = createInstruction(timestamp, 'Code-Simple', 'Long enough instruction text');
			expect(result).not.toBeNull();
			expect(result!.mode).toBe('codesimple');
		});

		test('defaults mode to "task" when empty after cleaning', () => {
			const result = createInstruction(timestamp, '!@#$%', 'Long enough instruction text');
			expect(result).not.toBeNull();
			expect(result!.mode).toBe('task');
		});
	});

	// ============================================================
	// extractTimestamp
	// ============================================================

	describe('extractTimestamp', () => {
		test('extracts timestamp from "timestamp" field', () => {
			const msg = { timestamp: '2026-02-22T10:00:00Z' };
			const ts = extractTimestamp(msg);
			expect(ts).toBe(new Date('2026-02-22T10:00:00Z').getTime());
		});

		test('extracts timestamp from "ts" field as fallback', () => {
			const msg = { ts: '2026-02-22T12:00:00Z' };
			const ts = extractTimestamp(msg);
			expect(ts).toBe(new Date('2026-02-22T12:00:00Z').getTime());
		});

		test('prefers "timestamp" over "ts"', () => {
			const msg = {
				timestamp: '2026-02-22T10:00:00Z',
				ts: '2026-02-22T12:00:00Z'
			};
			const ts = extractTimestamp(msg);
			expect(ts).toBe(new Date('2026-02-22T10:00:00Z').getTime());
		});

		test('returns 0 for missing timestamp fields', () => {
			const msg = {};
			const ts = extractTimestamp(msg);
			expect(ts).toBe(new Date(0).getTime());
		});

		test('handles numeric timestamps', () => {
			const now = Date.now();
			const msg = { timestamp: now };
			const ts = extractTimestamp(msg);
			expect(ts).toBe(now);
		});
	});
});
