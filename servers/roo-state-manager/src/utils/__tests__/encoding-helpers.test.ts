/**
 * Tests pour encoding-helpers.ts
 * Coverage improvement for UTF-8 BOM handling utilities
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
	stripBOM,
	readFileWithoutBOM,
	readFileSyncWithoutBOM,
	parseJSONWithoutBOM,
	readJSONFileWithoutBOM,
	readJSONFileSyncWithoutBOM
} from '../encoding-helpers.js';
import fs from 'fs/promises';
import fsSync from 'fs';

describe('encoding-helpers', () => {
	const testContent = '{"test": "data", "number": 42}';
	const testContentWithBOM = '\uFEFF' + testContent;

	beforeEach(() => {
		// Clean up any test files
	});

	describe('stripBOM', () => {
		test('removes UTF-8 BOM from start of string', () => {
			const result = stripBOM(testContentWithBOM);
			expect(result).toBe(testContent);
		});

		test('leaves string unchanged if no BOM present', () => {
			const result = stripBOM(testContent);
			expect(result).toBe(testContent);
		});

		test('handles empty string', () => {
			expect(stripBOM('')).toBe('');
		});

		test('removes FEFF even if it might not be a true BOM', () => {
			const result = stripBOM('\uFEFFnot a bom');
			expect(result).toBe('not a bom');
		});
	});

	describe('parseJSONWithoutBOM', () => {
		test('parses JSON with BOM', () => {
			const result = parseJSONWithoutBOM(testContentWithBOM);
			expect(result).toEqual({ test: 'data', number: 42 });
		});

		test('parses JSON without BOM', () => {
			const result = parseJSONWithoutBOM(testContent);
			expect(result).toEqual({ test: 'data', number: 42 });
		});

		test('throws error for invalid JSON', () => {
			expect(() => parseJSONWithoutBOM('invalid json')).toThrow();
		});

		test('throws error for empty string', () => {
			expect(() => parseJSONWithoutBOM('')).toThrow();
		});
	});

	describe('readFileSyncWithoutBOM', () => {
		test('reads file without BOM using sync method', () => {
			const filePath = './test-file-sync.tmp';
			fsSync.writeFileSync(filePath, testContent);

			const result = readFileSyncWithoutBOM(filePath);
			expect(result).toBe(testContent);

			fsSync.unlinkSync(filePath);
		});

		test('reads file with BOM using sync method', () => {
			const filePath = './test-file-sync-bom.tmp';
			fsSync.writeFileSync(filePath, testContentWithBOM);

			const result = readFileSyncWithoutBOM(filePath);
			expect(result).toBe(testContent);

			fsSync.unlinkSync(filePath);
		});

		test('throws error for non-existent file', () => {
			expect(() => readFileSyncWithoutBOM('./non-existent.tmp')).toThrow();
		});
	});

	describe('readJSONFileSyncWithoutBOM', () => {
		test('reads and parses JSON file without BOM', () => {
			const filePath = './test-json-sync.tmp';
			fsSync.writeFileSync(filePath, testContent);

			const result = readJSONFileSyncWithoutBOM(filePath);
			expect(result).toEqual({ test: 'data', number: 42 });

			fsSync.unlinkSync(filePath);
		});

		test('reads and parses JSON file with BOM', () => {
			const filePath = './test-json-sync-bom.tmp';
			fsSync.writeFileSync(filePath, testContentWithBOM);

			const result = readJSONFileSyncWithoutBOM(filePath);
			expect(result).toEqual({ test: 'data', number: 42 });

			fsSync.unlinkSync(filePath);
		});

		test('throws error for non-existent file', () => {
			expect(() => readJSONFileSyncWithoutBOM('./non-existent.json')).toThrow();
		});

		test('throws error for invalid JSON file', () => {
			const filePath = './test-json-invalid.tmp';
			fsSync.writeFileSync(filePath, 'invalid json');

			expect(() => readJSONFileSyncWithoutBOM(filePath)).toThrow();

			fsSync.unlinkSync(filePath);
		});
	});

	describe('readFileWithoutBOM', () => {
		test('reads file without BOM using async method', async () => {
			const filePath = './test-file-async.tmp';
			fsSync.writeFileSync(filePath, testContent);

			const result = await readFileWithoutBOM(filePath);
			expect(result).toBe(testContent);

			fsSync.unlinkSync(filePath);
		});

		test('reads file with BOM using async method', async () => {
			const filePath = './test-file-async-bom.tmp';
			fsSync.writeFileSync(filePath, testContentWithBOM);

			const result = await readFileWithoutBOM(filePath);
			expect(result).toBe(testContent);

			fsSync.unlinkSync(filePath);
		});

		test('throws error for non-existent file (async)', async () => {
			await expect(readFileWithoutBOM('./non-existent-async.tmp')).rejects.toThrow();
		});

		test('respects custom encoding parameter (async)', async () => {
			const filePath = './test-file-encoding.tmp';
			fsSync.writeFileSync(filePath, testContent);

			const result = await readFileWithoutBOM(filePath, 'utf-8');
			expect(result).toBe(testContent);

			fsSync.unlinkSync(filePath);
		});
	});

	describe('readJSONFileWithoutBOM', () => {
		test('reads and parses JSON file without BOM (async)', async () => {
			const filePath = './test-json-async.tmp';
			fsSync.writeFileSync(filePath, testContent);

			const result = await readJSONFileWithoutBOM(filePath);
			expect(result).toEqual({ test: 'data', number: 42 });

			fsSync.unlinkSync(filePath);
		});

		test('reads and parses JSON file with BOM (async)', async () => {
			const filePath = './test-json-async-bom.tmp';
			fsSync.writeFileSync(filePath, testContentWithBOM);

			const result = await readJSONFileWithoutBOM(filePath);
			expect(result).toEqual({ test: 'data', number: 42 });

			fsSync.unlinkSync(filePath);
		});

		test('throws error for non-existent file (async)', async () => {
			await expect(readJSONFileWithoutBOM('./non-existent-async.json')).rejects.toThrow();
		});

		test('throws error for invalid JSON file (async)', async () => {
			const filePath = './test-json-async-invalid.tmp';
			fsSync.writeFileSync(filePath, 'invalid json');

			await expect(readJSONFileWithoutBOM(filePath)).rejects.toThrow();

			fsSync.unlinkSync(filePath);
		});

		test('supports generic type parameter (async)', async () => {
			const filePath = './test-json-generic.tmp';
			fsSync.writeFileSync(filePath, testContent);

			type TestData = { test: string; number: number };
			const result = await readJSONFileWithoutBOM<TestData>(filePath);
			expect(result.test).toBe('data');
			expect(result.number).toBe(42);

			fsSync.unlinkSync(filePath);
		});
	});
});
