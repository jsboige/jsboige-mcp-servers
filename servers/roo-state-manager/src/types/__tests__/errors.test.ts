/**
 * Tests for types/errors.ts
 * Coverage target: 90%+
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCategory,
  StateManagerError,
  ConfigServiceError,
  ConfigServiceErrorCode,
  IdentityManagerError,
  IdentityManagerErrorCode,
  BaselineLoaderError,
  BaselineLoaderErrorCode,
  BaselineServiceError,
  BaselineServiceErrorCode,
  GenericError,
  GenericErrorCode,
  SynthesisServiceError,
  SynthesisServiceErrorCode,
  TraceSummaryServiceError,
  TraceSummaryServiceErrorCode,
  PowerShellExecutorError,
  PowerShellExecutorErrorCode,
  MessageManagerError,
  MessageManagerErrorCode,
  CacheManagerError,
  CacheManagerErrorCode,
  InventoryCollectorError,
  InventoryCollectorErrorCode,
  RooStorageDetectorError,
  RooStorageDetectorErrorCode,
  ExportConfigManagerError,
  ExportConfigManagerErrorCode,
  ConfigSharingServiceError,
  ConfigSharingServiceErrorCode,
  createErrorFromStandardError,
  isErrorCode,
  isServiceError,
  detectPowerShellErrorType,
  suggestErrorCategory
} from '../errors.js';

describe('ErrorCategory enum', () => {
  it('should have SCRIPT category', () => {
    expect(ErrorCategory.SCRIPT).toBe('SCRIPT');
  });

  it('should have SYSTEM category', () => {
    expect(ErrorCategory.SYSTEM).toBe('SYSTEM');
  });

  it('should have UNKNOWN category', () => {
    expect(ErrorCategory.UNKNOWN).toBe('UNKNOWN');
  });

  it('should have exactly 3 categories', () => {
    expect(Object.keys(ErrorCategory)).toHaveLength(3);
  });
});

describe('StateManagerError', () => {
  it('should create error with required fields', () => {
    const error = new StateManagerError('Test error', 'TEST_CODE', 'TestService');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StateManagerError');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.service).toBe('TestService');
    expect(error.category).toBe(ErrorCategory.UNKNOWN);
  });

  it('should include optional details', () => {
    const details = { key: 'value', count: 42 };
    const error = new StateManagerError('Error', 'CODE', 'Service', details);

    expect(error.details).toEqual(details);
  });

  it('should include cause error', () => {
    const cause = new Error('Cause error');
    const error = new StateManagerError('Error', 'CODE', 'Service', undefined, cause);

    expect(error.cause).toBe(cause);
  });

  it('should include category', () => {
    const error = new StateManagerError(
      'Error', 'CODE', 'Service', undefined, undefined, ErrorCategory.SYSTEM
    );

    expect(error.category).toBe(ErrorCategory.SYSTEM);
  });

  it('should have stack trace', () => {
    const error = new StateManagerError('Error', 'CODE', 'Service');

    expect(error.stack).toBeDefined();
  });

  it('should convert to JSON', () => {
    const cause = new Error('Cause');
    const error = new StateManagerError('Test', 'CODE', 'Service', { key: 'val' }, cause);
    const json = error.toJSON();

    expect(json.name).toBe('StateManagerError');
    expect(json.message).toBe('Test');
    expect(json.code).toBe('CODE');
    expect(json.service).toBe('Service');
    expect(json.details).toEqual({ key: 'val' });
    expect(json.cause).toEqual({ name: 'Error', message: 'Cause' });
  });

  it('should handle undefined cause in toJSON', () => {
    const error = new StateManagerError('Test', 'CODE', 'Service');
    const json = error.toJSON();

    expect(json.cause).toBeUndefined();
  });
});

describe('ConfigServiceError', () => {
  it('should create error with correct properties', () => {
    const error = new ConfigServiceError(
      'Config failed',
      ConfigServiceErrorCode.CONFIG_NOT_FOUND,
      { path: '/test/config.json' }
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('ConfigServiceError');
    expect(error.service).toBe('ConfigService');
    expect(error.code).toBe(ConfigServiceErrorCode.CONFIG_NOT_FOUND);
  });
});

describe('ConfigServiceErrorCode enum', () => {
  it('should have all expected codes', () => {
    expect(ConfigServiceErrorCode.CONFIG_NOT_FOUND).toBe('CONFIG_NOT_FOUND');
    expect(ConfigServiceErrorCode.CONFIG_LOAD_FAILED).toBe('CONFIG_LOAD_FAILED');
    expect(ConfigServiceErrorCode.CONFIG_SAVE_FAILED).toBe('CONFIG_SAVE_FAILED');
    expect(ConfigServiceErrorCode.CONFIG_INVALID).toBe('CONFIG_INVALID');
    expect(ConfigServiceErrorCode.CONFIG_VERSION_READ_FAILED).toBe('CONFIG_VERSION_READ_FAILED');
    expect(ConfigServiceErrorCode.CONFIG_PATH_NOT_FOUND).toBe('CONFIG_PATH_NOT_FOUND');
    expect(ConfigServiceErrorCode.SHARED_STATE_PATH_NOT_FOUND).toBe('SHARED_STATE_PATH_NOT_FOUND');
  });
});

describe('IdentityManagerError', () => {
  it('should create error with correct properties', () => {
    const error = new IdentityManagerError(
      'Identity failed',
      IdentityManagerErrorCode.IDENTITY_CONFLICT
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('IdentityManagerError');
    expect(error.service).toBe('IdentityManager');
  });
});

describe('BaselineLoaderError', () => {
  it('should create error with correct properties', () => {
    const error = new BaselineLoaderError(
      'Load failed',
      BaselineLoaderErrorCode.BASELINE_LOAD_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('BaselineLoaderError');
    expect(error.service).toBe('BaselineLoader');
  });
});

describe('BaselineServiceError', () => {
  it('should create error with correct properties', () => {
    const error = new BaselineServiceError(
      'Service failed',
      BaselineServiceErrorCode.COMPARISON_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('BaselineServiceError');
    expect(error.service).toBe('BaselineService');
  });
});

describe('GenericError', () => {
  it('should create error with correct properties', () => {
    const error = new GenericError('Generic error', GenericErrorCode.NETWORK_ERROR);

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('GenericError');
    expect(error.service).toBe('Generic');
  });
});

describe('SynthesisServiceError', () => {
  it('should create error with correct properties', () => {
    const error = new SynthesisServiceError(
      'Synthesis failed',
      SynthesisServiceErrorCode.NO_MODEL_CONFIGURED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('SynthesisServiceError');
    expect(error.service).toBe('SynthesisService');
  });
});

describe('TraceSummaryServiceError', () => {
  it('should create error with correct properties', () => {
    const error = new TraceSummaryServiceError(
      'Summary failed',
      TraceSummaryServiceErrorCode.SUMMARY_GENERATION_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('TraceSummaryServiceError');
    expect(error.service).toBe('TraceSummaryService');
  });
});

describe('PowerShellExecutorError', () => {
  it('should create error with correct properties', () => {
    const error = new PowerShellExecutorError(
      'Execution failed',
      PowerShellExecutorErrorCode.EXECUTION_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('PowerShellExecutorError');
    expect(error.service).toBe('PowerShellExecutor');
  });
});

describe('MessageManagerError', () => {
  it('should create error with correct properties', () => {
    const error = new MessageManagerError(
      'Message failed',
      MessageManagerErrorCode.MESSAGE_SEND_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('MessageManagerError');
    expect(error.service).toBe('MessageManager');
  });
});

describe('CacheManagerError', () => {
  it('should create error with correct properties', () => {
    const error = new CacheManagerError(
      'Cache failed',
      CacheManagerErrorCode.CACHE_READ_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('CacheManagerError');
    expect(error.service).toBe('CacheManager');
  });
});

describe('InventoryCollectorError', () => {
  it('should create error with correct properties', () => {
    const error = new InventoryCollectorError(
      'Inventory failed',
      InventoryCollectorErrorCode.INVENTORY_PARSE_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('InventoryCollectorError');
    expect(error.service).toBe('InventoryCollector');
  });
});

describe('RooStorageDetectorError', () => {
  it('should create error with correct properties', () => {
    const error = new RooStorageDetectorError(
      'Detection failed',
      RooStorageDetectorErrorCode.NO_STORAGE_FOUND
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('RooStorageDetectorError');
    expect(error.service).toBe('RooStorageDetector');
  });
});

describe('ExportConfigManagerError', () => {
  it('should create error with correct properties', () => {
    const error = new ExportConfigManagerError(
      'Export failed',
      ExportConfigManagerErrorCode.CONFIG_LOAD_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('ExportConfigManagerError');
    expect(error.service).toBe('ExportConfigManager');
  });
});

describe('ConfigSharingServiceError', () => {
  it('should create error with correct properties', () => {
    const error = new ConfigSharingServiceError(
      'Sharing failed',
      ConfigSharingServiceErrorCode.COLLECTION_FAILED
    );

    expect(error).toBeInstanceOf(StateManagerError);
    expect(error.name).toBe('ConfigSharingServiceError');
    expect(error.service).toBe('ConfigSharingService');
  });
});

describe('createErrorFromStandardError', () => {
  it('should return StateManagerError as-is', () => {
    const original = new StateManagerError('Original', 'CODE', 'Service');
    const result = createErrorFromStandardError(original, 'NEW_CODE', 'NewService');

    expect(result).toBe(original);
  });

  it('should wrap Error in StateManagerError', () => {
    const error = new Error('Standard error');
    const result = createErrorFromStandardError(error, 'CODE', 'Service', 'Default message');

    expect(result).toBeInstanceOf(StateManagerError);
    expect(result.code).toBe('CODE');
    expect(result.service).toBe('Service');
    expect(result.cause).toBe(error);
  });

  it('should use error message if no default provided', () => {
    const error = new Error('Error message');
    const result = createErrorFromStandardError(error, 'CODE', 'Service');

    expect(result.message).toBe('Error message');
  });

  it('should handle non-Error values', () => {
    const result = createErrorFromStandardError('string error', 'CODE', 'Service', 'Default');

    expect(result).toBeInstanceOf(StateManagerError);
    expect(result.message).toBe('Default');
    expect(result.details).toEqual({ originalValue: 'string error' });
  });

  it('should convert non-Error value to string if no default', () => {
    const result = createErrorFromStandardError({ obj: true }, 'CODE', 'Service');

    expect(result.message).toBe('[object Object]');
  });
});

describe('isErrorCode', () => {
  it('should return true for matching error code', () => {
    const error = new StateManagerError('Error', 'CODE', 'Service');
    expect(isErrorCode(error, 'CODE')).toBe(true);
  });

  it('should return false for non-matching error code', () => {
    const error = new StateManagerError('Error', 'CODE', 'Service');
    expect(isErrorCode(error, 'OTHER_CODE')).toBe(false);
  });

  it('should return false for non-StateManagerError', () => {
    const error = new Error('Standard error');
    expect(isErrorCode(error, 'CODE')).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isErrorCode(null, 'CODE')).toBe(false);
    expect(isErrorCode(undefined, 'CODE')).toBe(false);
  });
});

describe('isServiceError', () => {
  it('should return true for matching service', () => {
    const error = new StateManagerError('Error', 'CODE', 'TestService');
    expect(isServiceError(error, 'TestService')).toBe(true);
  });

  it('should return false for non-matching service', () => {
    const error = new StateManagerError('Error', 'CODE', 'TestService');
    expect(isServiceError(error, 'OtherService')).toBe(false);
  });

  it('should return false for non-StateManagerError', () => {
    const error = new Error('Standard error');
    expect(isServiceError(error, 'Service')).toBe(false);
  });
});

describe('detectPowerShellErrorType', () => {
  describe('script errors', () => {
    it('should detect syntax error as SCRIPT', () => {
      expect(detectPowerShellErrorType('syntax error at line 5')).toBe(ErrorCategory.SCRIPT);
    });

    it('should detect unexpected token as SCRIPT', () => {
      expect(detectPowerShellErrorType('unexpected token found')).toBe(ErrorCategory.SCRIPT);
    });

    it('should detect variable not found as SCRIPT', () => {
      expect(detectPowerShellErrorType('variable $foo cannot be retrieved')).toBe(ErrorCategory.SCRIPT);
    });

    it('should detect term not recognized as SCRIPT', () => {
      expect(detectPowerShellErrorType("term 'foo' is not recognized")).toBe(ErrorCategory.SCRIPT);
    });

    it('should detect null-valued expression as SCRIPT', () => {
      expect(detectPowerShellErrorType('null-valued expression')).toBe(ErrorCategory.SCRIPT);
    });
  });

  describe('system errors', () => {
    it('should detect file not found as SYSTEM', () => {
      expect(detectPowerShellErrorType('cannot find path C:\\test')).toBe(ErrorCategory.SYSTEM);
    });

    it('should detect access denied as SYSTEM', () => {
      expect(detectPowerShellErrorType('access denied')).toBe(ErrorCategory.SYSTEM);
    });

    it('should detect timeout as SYSTEM', () => {
      expect(detectPowerShellErrorType('operation timed out')).toBe(ErrorCategory.SYSTEM);
    });

    it('should detect network error as SYSTEM', () => {
      expect(detectPowerShellErrorType('network path not found')).toBe(ErrorCategory.SYSTEM);
    });

    it('should detect disk full as SYSTEM', () => {
      expect(detectPowerShellErrorType('not enough disk space')).toBe(ErrorCategory.SYSTEM);
    });

    it('should detect file locked as SYSTEM', () => {
      expect(detectPowerShellErrorType('being used by another process')).toBe(ErrorCategory.SYSTEM);
    });
  });

  describe('unknown errors', () => {
    it('should return UNKNOWN for unrecognized patterns', () => {
      expect(detectPowerShellErrorType('some random error message')).toBe(ErrorCategory.UNKNOWN);
    });

    it('should return UNKNOWN for empty string', () => {
      expect(detectPowerShellErrorType('')).toBe(ErrorCategory.UNKNOWN);
    });
  });

  describe('input types', () => {
    it('should handle Error object', () => {
      const error = new Error('syntax error in script');
      expect(detectPowerShellErrorType(error)).toBe(ErrorCategory.SCRIPT);
    });

    it('should handle PowerShellExecutionResult with stderr', () => {
      const result = { stderr: 'cannot find path' };
      expect(detectPowerShellErrorType(result)).toBe(ErrorCategory.SYSTEM);
    });

    it('should handle PowerShellExecutionResult with stdout', () => {
      const result = { stdout: 'access denied' };
      expect(detectPowerShellErrorType(result)).toBe(ErrorCategory.SYSTEM);
    });

    it('should handle PowerShellExecutionResult with error', () => {
      const result = { error: new Error('timeout') };
      expect(detectPowerShellErrorType(result)).toBe(ErrorCategory.SYSTEM);
    });

    it('should handle empty result object', () => {
      expect(detectPowerShellErrorType({})).toBe(ErrorCategory.UNKNOWN);
    });
  });
});

describe('suggestErrorCategory', () => {
  it('should suggest SCRIPT for parse errors', () => {
    expect(suggestErrorCategory('Service', 'INVENTORY_PARSE_FAILED')).toBe(ErrorCategory.SCRIPT);
    expect(suggestErrorCategory('Service', 'PARSE_FAILED')).toBe(ErrorCategory.SCRIPT);
    expect(suggestErrorCategory('Service', 'VALIDATION_FAILED')).toBe(ErrorCategory.SCRIPT);
  });

  it('should suggest SYSTEM for file/network errors', () => {
    expect(suggestErrorCategory('Service', 'SCRIPT_NOT_FOUND')).toBe(ErrorCategory.SYSTEM);
    expect(suggestErrorCategory('Service', 'NETWORK_ERROR')).toBe(ErrorCategory.SYSTEM);
    expect(suggestErrorCategory('Service', 'TIMEOUT')).toBe(ErrorCategory.SYSTEM);
    expect(suggestErrorCategory('Service', 'PERMISSION_DENIED')).toBe(ErrorCategory.SYSTEM);
  });

  it('should suggest UNKNOWN for unrecognized codes', () => {
    expect(suggestErrorCategory('Service', 'UNKNOWN_CODE')).toBe(ErrorCategory.UNKNOWN);
  });
});
