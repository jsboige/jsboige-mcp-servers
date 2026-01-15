/**
 * Tests pour T3.7 - Classification des erreurs (Script vs Système)
 *
 * Ce fichier teste la fonctionnalité de classification des erreurs PowerShell
 * pour distinguer les problèmes de script (bugs dans le code) des problèmes
 * système (fichier, réseau, permissions).
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCategory,
  StateManagerError,
  detectPowerShellErrorType,
  suggestErrorCategory,
  PowerShellExecutionResult,
  PowerShellExecutorError,
  PowerShellExecutorErrorCode,
  InventoryCollectorError,
  InventoryCollectorErrorCode,
  GenericError,
  GenericErrorCode
} from '../../../src/types/errors.js';

describe('T3.7 - ErrorCategory Enum', () => {
  it('devrait définir les trois catégories d\'erreur', () => {
    expect(ErrorCategory.SCRIPT).toBe('SCRIPT');
    expect(ErrorCategory.SYSTEM).toBe('SYSTEM');
    expect(ErrorCategory.UNKNOWN).toBe('UNKNOWN');
  });
});

describe('T3.7 - StateManagerError avec category', () => {
  it('devrait créer une erreur avec une catégorie explicite', () => {
    const error = new StateManagerError(
      'Test error',
      'TEST_CODE',
      'TestService',
      ErrorCategory.SCRIPT
    );

    expect(error.category).toBe(ErrorCategory.SCRIPT);
    expect(error.code).toBe('TEST_CODE');
    expect(error.service).toBe('TestService');
  });

  it('devrait utiliser UNKNOWN comme catégorie par défaut', () => {
    const error = new StateManagerError(
      'Test error',
      'TEST_CODE',
      'TestService'
    );

    expect(error.category).toBe(ErrorCategory.UNKNOWN);
  });

  it('devrait inclure la catégorie dans la représentation JSON', () => {
    const error = new StateManagerError(
      'Test error',
      'TEST_CODE',
      'TestService',
      ErrorCategory.SYSTEM
    );

    const json = error.toJSON();
    expect(json.category).toBe('SYSTEM');
  });
});

describe('T3.7 - Détection d\'erreurs script', () => {
  const scriptErrors = [
    { message: 'Syntax error: unexpected token', expected: ErrorCategory.SCRIPT },
    { message: 'Unexpected token \'}\' in expression', expected: ErrorCategory.SCRIPT },
    { message: 'Variable \'$test\' cannot be retrieved', expected: ErrorCategory.SCRIPT },
    { message: 'Invalid operation: Cannot convert value', expected: ErrorCategory.SCRIPT },
    { message: 'Term \'Get-Item\' not recognized', expected: ErrorCategory.SCRIPT },
    { message: 'Missing closing \'}\'', expected: ErrorCategory.SCRIPT },
    { message: 'Unexpected end of file', expected: ErrorCategory.SCRIPT },
    { message: 'Cannot convert value "abc" to type "System.Int32"', expected: ErrorCategory.SCRIPT },
    { message: 'Cannot index into a null array', expected: ErrorCategory.SCRIPT },
    { message: 'Property \'Name\' cannot be found on this object', expected: ErrorCategory.SCRIPT }
  ];

  scriptErrors.forEach(({ message, expected }) => {
    it(`devrait détecter "${message}" comme erreur script`, () => {
      const category = detectPowerShellErrorType(message);
      expect(category).toBe(expected);
    });
  });

  it('devrait détecter erreur script depuis PowerShellExecutionResult', () => {
    const result: PowerShellExecutionResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'Syntax error: unexpected token'
    };

    const category = detectPowerShellErrorType(result);
    expect(category).toBe(ErrorCategory.SCRIPT);
  });

  it('devrait détecter erreur script depuis Error object', () => {
    const error = new Error('Syntax error: unexpected token');
    const category = detectPowerShellErrorType(error);
    expect(category).toBe(ErrorCategory.SCRIPT);
  });
});

describe('T3.7 - Détection d\'erreurs système', () => {
  const systemErrors = [
    { message: 'Cannot find path \'C:\\test.ps1\'', expected: ErrorCategory.SYSTEM },
    { message: 'Access to the path is denied', expected: ErrorCategory.SYSTEM },
    { message: 'The operation has timed out', expected: ErrorCategory.SYSTEM },
    { message: 'Network path not found', expected: ErrorCategory.SYSTEM },
    { message: 'The system cannot find the file specified', expected: ErrorCategory.SYSTEM },
    { message: 'Permission denied', expected: ErrorCategory.SYSTEM },
    { message: 'Disk full', expected: ErrorCategory.SYSTEM },
    { message: 'Network unreachable', expected: ErrorCategory.SYSTEM },
    { message: 'Connection refused', expected: ErrorCategory.SYSTEM },
    { message: 'File not found', expected: ErrorCategory.SYSTEM },
    { message: 'Directory not found', expected: ErrorCategory.SYSTEM }
  ];

  systemErrors.forEach(({ message, expected }) => {
    it(`devrait détecter "${message}" comme erreur système`, () => {
      const category = detectPowerShellErrorType(message);
      expect(category).toBe(expected);
    });
  });

  it('devrait détecter erreur système depuis PowerShellExecutionResult', () => {
    const result: PowerShellExecutionResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot find path \'C:\\test.ps1\''
    };

    const category = detectPowerShellErrorType(result);
    expect(category).toBe(ErrorCategory.SYSTEM);
  });
});

describe('T3.7 - Cas UNKNOWN', () => {
  const unknownErrors = [
    'An unknown error occurred',
    'Something went wrong',
    'Error in script execution',
    'Failed to complete operation'
  ];

  unknownErrors.forEach(message => {
    it(`devrait retourner UNKNOWN pour "${message}"`, () => {
      const category = detectPowerShellErrorType(message);
      expect(category).toBe(ErrorCategory.UNKNOWN);
    });
  });
});

describe('T3.7 - Suggestion de catégorie par code d\'erreur', () => {
  describe('PowerShellExecutor', () => {
    it('devrait suggérer SCRIPT pour NO_JSON_FOUND', () => {
      const category = suggestErrorCategory('PowerShellExecutor', 'NO_JSON_FOUND');
      expect(category).toBe(ErrorCategory.SCRIPT);
    });

    it('devrait suggérer SYSTEM pour EXECUTION_FAILED', () => {
      const category = suggestErrorCategory('PowerShellExecutor', 'EXECUTION_FAILED');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM pour TIMEOUT', () => {
      const category = suggestErrorCategory('PowerShellExecutor', 'TIMEOUT');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM pour SCRIPT_NOT_FOUND', () => {
      const category = suggestErrorCategory('PowerShellExecutor', 'SCRIPT_NOT_FOUND');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SCRIPT pour PARSE_FAILED', () => {
      const category = suggestErrorCategory('PowerShellExecutor', 'PARSE_FAILED');
      expect(category).toBe(ErrorCategory.SCRIPT);
    });
  });

  describe('InventoryCollector', () => {
    it('devrait suggérer SYSTEM pour SCRIPT_NOT_FOUND', () => {
      const category = suggestErrorCategory('InventoryCollector', 'SCRIPT_NOT_FOUND');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SCRIPT pour SCRIPT_EXECUTION_FAILED', () => {
      const category = suggestErrorCategory('InventoryCollector', 'SCRIPT_EXECUTION_FAILED');
      expect(category).toBe(ErrorCategory.SCRIPT);
    });

    it('devrait suggérer SCRIPT pour INVENTORY_PARSE_FAILED', () => {
      const category = suggestErrorCategory('InventoryCollector', 'INVENTORY_PARSE_FAILED');
      expect(category).toBe(ErrorCategory.SCRIPT);
    });

    it('devrait suggérer SYSTEM pour INVENTORY_SAVE_FAILED', () => {
      const category = suggestErrorCategory('InventoryCollector', 'INVENTORY_SAVE_FAILED');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM pour REMOTE_MACHINE_NOT_FOUND', () => {
      const category = suggestErrorCategory('InventoryCollector', 'REMOTE_MACHINE_NOT_FOUND');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM pour SHARED_STATE_NOT_ACCESSIBLE', () => {
      const category = suggestErrorCategory('InventoryCollector', 'SHARED_STATE_NOT_ACCESSIBLE');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });
  });

  describe('Generic', () => {
    it('devrait suggérer SYSTEM pour FILE_SYSTEM_ERROR', () => {
      const category = suggestErrorCategory('Generic', 'FILE_SYSTEM_ERROR');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM pour NETWORK_ERROR', () => {
      const category = suggestErrorCategory('Generic', 'NETWORK_ERROR');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM for PERMISSION_DENIED', () => {
      const category = suggestErrorCategory('Generic', 'PERMISSION_DENIED');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SYSTEM pour TIMEOUT', () => {
      const category = suggestErrorCategory('Generic', 'TIMEOUT');
      expect(category).toBe(ErrorCategory.SYSTEM);
    });

    it('devrait suggérer SCRIPT pour INVALID_ARGUMENT', () => {
      const category = suggestErrorCategory('Generic', 'INVALID_ARGUMENT');
      expect(category).toBe(ErrorCategory.SCRIPT);
    });
  });

  it('devrait retourner UNKNOWN pour service/code inconnu', () => {
    const category = suggestErrorCategory('UnknownService', 'UNKNOWN_CODE');
    expect(category).toBe(ErrorCategory.UNKNOWN);
  });
});

describe('T3.7 - Scénarios d\'intégration', () => {
  it('devrait créer une erreur PowerShellExecutor avec catégorie détectée', () => {
    const result: PowerShellExecutionResult = {
      exitCode:1,
      stdout: '',
      stderr: 'Syntax error: unexpected token'
    };

    const category = detectPowerShellErrorType(result);
    const error = new PowerShellExecutorError(
      'Script failed',
      PowerShellExecutorErrorCode.EXECUTION_FAILED,
      category
    );

    expect(error.category).toBe(ErrorCategory.SCRIPT);
  });

  it('devrait créer une erreur InventoryCollector avec catégorie suggérée', () => {
    const category = suggestErrorCategory('InventoryCollector', 'INVENTORY_PARSE_FAILED');
    const error = new InventoryCollectorError(
      'Inventory parse failed',
      InventoryCollectorErrorCode.INVENTORY_PARSE_FAILED,
      category
    );

    expect(error.category).toBe(ErrorCategory.SCRIPT);
  });

  it('devrait créer une erreur Generic avec catégorie explicite', () => {
    const error = new GenericError(
      'File system error',
      GenericErrorCode.FILE_SYSTEM_ERROR,
      ErrorCategory.SYSTEM
    );

    expect(error.category).toBe(ErrorCategory.SYSTEM);
  });

  it('devrait sérialiser correctement une erreur avec catégorie', () => {
    const error = new StateManagerError(
      'Test error',
      'TEST_CODE',
      'TestService',
      ErrorCategory.SCRIPT,
      { detail: 'test' }
    );

    const json = error.toJSON();
    expect(json).toEqual({
      name: 'StateManagerError',
      message: 'Test error',
      code: 'TEST_CODE',
      service: 'TestService',
      category: 'SCRIPT',
      details: { detail: 'test' },
      cause: undefined
    });
  });
});

describe('T3.7 - Flexibilité des types d\'entrée', () => {
  it('devrait accepter une chaîne de caractères', () => {
    const category = detectPowerShellErrorType('Syntax error: unexpected token');
    expect(category).toBe(ErrorCategory.SCRIPT);
  });

  it('devrait accepter un objet Error standard', () => {
    const error = new Error('Cannot find path');
    const category = detectPowerShellErrorType(error);
    expect(category).toBe(ErrorCategory.SYSTEM);
  });

  it('devrait accepter un PowerShellExecutionResult', () => {
    const result: PowerShellExecutionResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'Access denied'
    };

    const category = detectPowerShellErrorType(result);
    expect(category).toBe(ErrorCategory.SYSTEM);
  });

  it('devrait gérer stdout si stderr est vide', () => {
    const result: PowerShellExecutionResult = {
      exitCode: 1,
      stdout: 'Syntax error: unexpected token',
      stderr: ''
    };

    const category = detectPowerShellErrorType(result);
    expect(category).toBe(ErrorCategory.SCRIPT);
  });
});
