/**
 * Tests for types/baseline.ts
 * Focus on BaselineServiceError class and enum
 */

import { describe, it, expect } from 'vitest';
import {
  BaselineServiceError,
  BaselineServiceErrorCode
} from '../baseline.js';

describe('BaselineServiceError', () => {
  it('should create error with message and code', () => {
    const error = new BaselineServiceError('Test error', 'TEST_CODE');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BaselineServiceError);
    expect(error.name).toBe('BaselineServiceError');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
  });

  it('should include optional details', () => {
    const details = { key: 'value', count: 42 };
    const error = new BaselineServiceError('Error with details', 'CODE', details);

    expect(error.details).toEqual(details);
  });

  it('should work without details', () => {
    const error = new BaselineServiceError('Simple error', 'SIMPLE');

    expect(error.details).toBeUndefined();
  });

  it('should capture stack trace', () => {
    const error = new BaselineServiceError('Stack test', 'STACK');

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('BaselineServiceError');
  });
});

describe('BaselineServiceErrorCode', () => {
  it('should have BASELINE_NOT_FOUND code', () => {
    expect(BaselineServiceErrorCode.BASELINE_NOT_FOUND).toBe('BASELINE_NOT_FOUND');
  });

  it('should have BASELINE_INVALID code', () => {
    expect(BaselineServiceErrorCode.BASELINE_INVALID).toBe('BASELINE_INVALID');
  });

  it('should have COMPARISON_FAILED code', () => {
    expect(BaselineServiceErrorCode.COMPARISON_FAILED).toBe('COMPARISON_FAILED');
  });

  it('should have DECISION_NOT_FOUND code', () => {
    expect(BaselineServiceErrorCode.DECISION_NOT_FOUND).toBe('DECISION_NOT_FOUND');
  });

  it('should have DECISION_INVALID_STATUS code', () => {
    expect(BaselineServiceErrorCode.DECISION_INVALID_STATUS).toBe('DECISION_INVALID_STATUS');
  });

  it('should have APPLICATION_FAILED code', () => {
    expect(BaselineServiceErrorCode.APPLICATION_FAILED).toBe('APPLICATION_FAILED');
  });

  it('should have INVENTORY_COLLECTION_FAILED code', () => {
    expect(BaselineServiceErrorCode.INVENTORY_COLLECTION_FAILED).toBe('INVENTORY_COLLECTION_FAILED');
  });

  it('should have ROADMAP_UPDATE_FAILED code', () => {
    expect(BaselineServiceErrorCode.ROADMAP_UPDATE_FAILED).toBe('ROADMAP_UPDATE_FAILED');
  });

  it('should have exactly 8 error codes', () => {
    const codes = Object.values(BaselineServiceErrorCode);
    expect(codes).toHaveLength(8);
  });
});
