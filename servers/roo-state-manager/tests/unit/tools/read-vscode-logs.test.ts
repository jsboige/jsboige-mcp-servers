import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

// Mock fs/promises with hoisted variables
const { mockReaddir, mockReadFile, mockAccess, mockStat } = vi.hoisted(() => {
  const mockReaddir = vi.fn();
  const mockReadFile = vi.fn();
  const mockAccess = vi.fn();
  const mockStat = vi.fn();
  return { mockReaddir, mockReadFile, mockAccess, mockStat };
});

vi.mock('fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  access: mockAccess,
  stat: mockStat
}));

// Import after mocking
import { readVscodeLogs } from '../../../src/tools/read-vscode-logs.js';

describe('read_vscode_logs Tool', () => {
  const APPDATA = process.platform === 'win32' ? 'C:\\Users\\test\\AppData\\Roaming' : '/home/test/.config';
  const LOGS_PATH = path.join(APPDATA, 'Code', 'logs');

  beforeEach(() => {
    process.env.APPDATA = APPDATA;

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.APPDATA;
  });

  it('should read latest logs from all relevant files', async () => {
    // Create mock Dirent-like objects
    const createMockDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false
    });

    // Mock session directories
    mockReaddir.mockImplementation((dirPath: any, options: any) => {
      const dirStr = String(dirPath);
      if (dirStr === LOGS_PATH) {
        return Promise.resolve([
          createMockDirent('20250101T120000', true),
          createMockDirent('20250102T120000', true),
          createMockDirent('20250103T120000', true)
        ] as any);
      }
      if (dirStr.includes('20250102T120000') && !dirStr.includes('exthost')) {
        return Promise.resolve([
          createMockDirent('window1', true),
          createMockDirent('window2', true)
        ] as any);
      }
      if (dirStr.includes('window2') && dirStr.includes('exthost') && !dirStr.includes('output_logging')) {
        return Promise.resolve([
          createMockDirent('output_logging_20250102T120000', true)
        ] as any);
      }
      if (dirStr.includes('output_logging_20250102T120000')) {
        return Promise.resolve([
          createMockDirent('1-Roo-Code.log', false)
        ] as any);
      }
      return Promise.resolve([]);
    });

    // Mock file access - all files exist
    mockAccess.mockResolvedValue(undefined as any);

    // Mock file reading
    mockReadFile.mockImplementation((filePath: any) => {
      const pathStr = String(filePath);
      if (pathStr.includes('renderer.log')) {
        return Promise.resolve('some renderer line 1\nsome renderer line 2');
      }
      if (pathStr.includes('exthost.log')) {
        return Promise.resolve('exthost line 1\nroo line 2\nexthost line 3');
      }
      if (pathStr.includes('Roo-Code.log')) {
        return Promise.resolve('roo log line 1\nroo log line 2');
      }
      return Promise.resolve('');
    });

    // Mock file stats
    mockStat.mockResolvedValue({ mtime: new Date() } as any);

    const result = await readVscodeLogs.handler({});
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

    expect(textContent).toContain('--- LOG: renderer ---');
    expect(textContent).toContain('some renderer line 1\nsome renderer line 2');
    expect(textContent).toContain('--- LOG: exthost ---');
    expect(textContent).toContain('exthost line 1\nroo line 2\nexthost line 3');
    expect(textContent).toContain('--- LOG: Roo-Code Output ---');
    expect(textContent).toContain('roo log line 1\nroo log line 2');
  });

  it('should read a specific number of lines', async () => {
    const createMockDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false
    });

    mockReaddir.mockImplementation((dirPath: any, options: any) => {
      const dirStr = String(dirPath);
      if (dirStr === LOGS_PATH) {
        return Promise.resolve([
          createMockDirent('20250102T120000', true)
        ] as any);
      }
      if (dirStr.includes('20250102T120000') && !dirStr.includes('exthost')) {
        return Promise.resolve([
          createMockDirent('window2', true)
        ] as any);
      }
      if (dirStr.includes('window2') && dirStr.includes('exthost') && !dirStr.includes('output_logging')) {
        return Promise.resolve([
          createMockDirent('output_logging_20250102T120000', true)
        ] as any);
      }
      if (dirStr.includes('output_logging_20250102T120000')) {
        return Promise.resolve([
          createMockDirent('1-Roo-Code.log', false)
        ] as any);
      }
      return Promise.resolve([]);
    });

    mockAccess.mockResolvedValue(undefined as any);
    mockStat.mockResolvedValue({ mtime: new Date() } as any);

    mockReadFile.mockImplementation((filePath: any) => {
      const pathStr = String(filePath);
      if (pathStr.includes('renderer.log')) {
        return Promise.resolve('some renderer line 1\nsome renderer line 2');
      }
      if (pathStr.includes('exthost.log')) {
        return Promise.resolve('exthost line 1\nroo line 2\nexthost line 3');
      }
      if (pathStr.includes('Roo-Code.log')) {
        return Promise.resolve('roo log line 1\nroo log line 2');
      }
      return Promise.resolve('');
    });

    const result = await readVscodeLogs.handler({ lines: 1 });
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

    expect(textContent).toContain('some renderer line 2');
    expect(textContent).not.toContain('some renderer line 1');
    expect(textContent).toContain('exthost line 3');
    expect(textContent).not.toContain('exthost line 1');
    expect(textContent).toContain('roo log line 2');
    expect(textContent).not.toContain('roo log line 1');
  });

  it('should filter logs by a keyword', async () => {
    const createMockDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false
    });

    mockReaddir.mockImplementation((dirPath: any, options: any) => {
      const dirStr = String(dirPath);
      if (dirStr === LOGS_PATH) {
        return Promise.resolve([
          createMockDirent('20250102T120000', true)
        ] as any);
      }
      if (dirStr.includes('20250102T120000') && !dirStr.includes('exthost')) {
        return Promise.resolve([
          createMockDirent('window2', true)
        ] as any);
      }
      if (dirStr.includes('window2') && dirStr.includes('exthost') && !dirStr.includes('output_logging')) {
        return Promise.resolve([
          createMockDirent('output_logging_20250102T120000', true)
        ] as any);
      }
      if (dirStr.includes('output_logging_20250102T120000')) {
        return Promise.resolve([
          createMockDirent('1-Roo-Code.log', false)
        ] as any);
      }
      return Promise.resolve([]);
    });

    mockAccess.mockResolvedValue(undefined as any);
    mockStat.mockResolvedValue({ mtime: new Date() } as any);

    mockReadFile.mockImplementation((filePath: any) => {
      const pathStr = String(filePath);
      if (pathStr.includes('renderer.log')) {
        return Promise.resolve('some renderer line 1\nsome renderer line 2');
      }
      if (pathStr.includes('exthost.log')) {
        return Promise.resolve('exthost line 1\nroo line 2\nexthost line 3');
      }
      if (pathStr.includes('Roo-Code.log')) {
        return Promise.resolve('roo log line 1\nroo log line 2');
      }
      return Promise.resolve('');
    });

    const result = await readVscodeLogs.handler({ filter: 'roo' });
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

    expect(textContent).not.toContain('some renderer line 1');
    expect(textContent).toContain('roo line 2');
    expect(textContent).toContain('roo log line 1\nroo log line 2');
  });

  it('should return a message if no session directory is found', async () => {
    mockReaddir.mockResolvedValue([]);

    const result = await readVscodeLogs.handler({});
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(textContent).toContain('No session log directory found');
  });

  it('should return a message if APPDATA is not set', async () => {
    delete process.env.APPDATA;
    const result = await readVscodeLogs.handler({});
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(textContent).toContain('APPDATA environment variable not set');
  });

  it('should handle undefined args gracefully', async () => {
    // Setup mocks similar to the first test to ensure logs are found
    const createMockDirent = (name: string, isDir: boolean) => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false
    });

    mockReaddir.mockImplementation((dirPath: any, options: any) => {
      const dirStr = String(dirPath);
      if (dirStr === LOGS_PATH) {
        return Promise.resolve([
          createMockDirent('20250101T120000', true)
        ] as any);
      }
      if (dirStr.includes('20250101T120000') && !dirStr.includes('exthost')) {
        return Promise.resolve([
          createMockDirent('window1', true)
        ] as any);
      }
      return Promise.resolve([]);
    });

    mockAccess.mockResolvedValue(undefined as any);
    mockStat.mockResolvedValue({ mtime: new Date() } as any);

    mockReadFile.mockImplementation((filePath: any) => {
      const pathStr = String(filePath);
      if (pathStr.includes('renderer.log')) {
        return Promise.resolve('some renderer line 1');
      }
      return Promise.resolve('');
    });

    // @ts-ignore - Testing runtime robustness
    const result = await readVscodeLogs.handler(undefined);
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(textContent).toContain('--- LOG: renderer ---');
  });
});