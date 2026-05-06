/**
 * Tests for error classes in conversation.ts
 * Covers RooStorageError, ConversationNotFoundError, InvalidStoragePathError
 */

import { describe, test, expect } from 'vitest';
import {
	RooStorageError,
	ConversationNotFoundError,
	InvalidStoragePathError,
} from '../../types/conversation.js';

describe('RooStorageError', () => {
	test('sets name to RooStorageError', () => {
		const error = new RooStorageError('test message', 'TEST_CODE');
		expect(error.name).toBe('RooStorageError');
	});

	test('sets message and code properties', () => {
		const error = new RooStorageError('something went wrong', 'ERR_001');
		expect(error.message).toBe('something went wrong');
		expect(error.code).toBe('ERR_001');
	});

	test('is instance of Error', () => {
		const error = new RooStorageError('msg', 'CODE');
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(RooStorageError);
	});

	test('can be caught with instanceof', () => {
		const throwIt = () => {
			throw new RooStorageError('disk full', 'DISK_FULL');
		};
		expect(throwIt).toThrow(RooStorageError);
		expect(throwIt).toThrow('disk full');
	});
});

describe('ConversationNotFoundError', () => {
	test('sets correct error code', () => {
		const error = new ConversationNotFoundError('task-123');
		expect(error.code).toBe('CONVERSATION_NOT_FOUND');
	});

	test('includes taskId in message', () => {
		const error = new ConversationNotFoundError('abc-def-ghi');
		expect(error.message).toContain('abc-def-ghi');
	});

	test('is instance of RooStorageError and Error', () => {
		const error = new ConversationNotFoundError('task-xyz');
		expect(error).toBeInstanceOf(RooStorageError);
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(ConversationNotFoundError);
	});

	test('name is RooStorageError (inherited)', () => {
		const error = new ConversationNotFoundError('task-1');
		expect(error.name).toBe('RooStorageError');
	});
});

describe('InvalidStoragePathError', () => {
	test('sets correct error code', () => {
		const error = new InvalidStoragePathError('/bad/path');
		expect(error.code).toBe('INVALID_STORAGE_PATH');
	});

	test('includes path in message', () => {
		const error = new InvalidStoragePathError('C:\\invalid\\path');
		expect(error.message).toContain('C:\\invalid\\path');
	});

	test('is instance of RooStorageError and Error', () => {
		const error = new InvalidStoragePathError('/tmp/nope');
		expect(error).toBeInstanceOf(RooStorageError);
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(InvalidStoragePathError);
	});
});
