import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock sqlite3 before importing the service
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockDbClose = vi.fn();

const mockDatabaseInstance = {
  get: mockDbGet,
  run: mockDbRun,
  close: mockDbClose,
};

vi.mock('sqlite3', () => {
  const Database = vi.fn((_path: string, _mode: number, callback: (err: Error | null) => void) => {
    setTimeout(() => callback(null), 0);
    return mockDatabaseInstance;
  });
  return {
    default: {
      Database,
      OPEN_READONLY: 1,
      OPEN_READWRITE: 2,
    },
  };
});

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    copyFileSync: vi.fn(),
    promises: {
      ...actual.promises,
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { existsSync } from 'fs';

describe('RooSettingsService Simple Tests', () => {
  let service: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);

    // Mock simple database response
    mockDbGet.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null, row?: { value: string }) => void) => {
      callback(null, { value: '{}' });
    });

    mockDbClose.mockImplementation((callback: (err: Error | null) => void) => {
      callback(null);
    });

    mockDbRun.mockImplementation((_sql: string, _params: unknown[], callback: (err: Error | null) => void) => {
      callback(null);
    });

    // Import here after mocking
    const { RooSettingsService } = await import('../RooSettingsService');
    service = new RooSettingsService();
  });

  it('should exist', () => {
    expect(service).toBeDefined();
  });

  it('should have getStateDbPath method', () => {
    expect(service.getStateDbPath).toBeDefined();
    expect(typeof service.getStateDbPath).toBe('function');
  });

  it('should have isAvailable method', () => {
    expect(service.isAvailable).toBeDefined();
    expect(typeof service.isAvailable).toBe('function');
  });
});