import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import mock from 'mock-fs';

// Mock fs/promises to use fs.promises implementation which mock-fs patches
vi.mock('fs/promises', async () => {
  const actualFs = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actualFs.promises,
    default: actualFs.promises,
  };
});

// Import after mocking
import { readVscodeLogs } from '../../../src/tools/read-vscode-logs.js';

describe('read_vscode_logs Tool', () => {
  const APPDATA = process.platform === 'win32' ? 'C:\\Users\\test\\AppData\\Roaming' : '/home/test/.config';
  const LOGS_PATH = path.join(APPDATA, 'Code', 'logs');

  beforeEach(() => {
    process.env.APPDATA = APPDATA;
    vi.clearAllMocks();
  });

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
    delete process.env.APPDATA;
  });

  it('should read latest logs from all relevant files', async () => {
    // mock-fs ne gère pas bien les dates de modification par défaut, ce qui affecte le tri
    // On doit s'assurer que les dossiers sont créés de manière à ce que le tri fonctionne
    // ou mocker fs.stat pour retourner des dates correctes si nécessaire.
    // Ici, le tri est alphabétique inverse sur le nom (20250102T120000 > 20250101T120000), donc ça devrait aller.

    mock({
      [LOGS_PATH]: {
        '20250101T120000': {},
        '20250102T120000': {
          'window2': {
            'renderer.log': 'some renderer line 1\nsome renderer line 2',
            'exthost': {
              'exthost.log': 'exthost line 1\nroo line 2\nexthost line 3',
              'output_logging_20250102T120000': {
                '1-Roo-Code.log': mock.file({
                    content: 'roo log line 1\nroo log line 2',
                    mtime: new Date('2025-01-02T12:00:00Z')
                })
              }
            }
          }
        },
        '20250103T120000': {}
      }
    });

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
    mock({
      [LOGS_PATH]: {
        '20250102T120000': {
          'window2': {
            'renderer.log': 'some renderer line 1\nsome renderer line 2',
            'exthost': {
              'exthost.log': 'exthost line 1\nroo line 2\nexthost line 3',
              'output_logging_20250102T120000': {
                '1-Roo-Code.log': mock.file({
                    content: 'roo log line 1\nroo log line 2',
                    mtime: new Date('2025-01-02T12:00:00Z')
                })
              }
            }
          }
        }
      }
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
    mock({
      [LOGS_PATH]: {
        '20250102T120000': {
          'window2': {
            'renderer.log': 'some renderer line 1\nsome renderer line 2',
            'exthost': {
              'exthost.log': 'exthost line 1\nroo line 2\nexthost line 3',
              'output_logging_20250102T120000': {
                '1-Roo-Code.log': mock.file({
                    content: 'roo log line 1\nroo log line 2',
                    mtime: new Date('2025-01-02T12:00:00Z')
                })
              }
            }
          }
        }
      }
    });

    const result = await readVscodeLogs.handler({ filter: 'roo' });
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

    expect(textContent).not.toContain('some renderer line 1');
    expect(textContent).toContain('roo line 2');
    expect(textContent).toContain('roo log line 1\nroo log line 2');
  });

  it('should return a message if no session directory is found', async () => {
    mock({
      [LOGS_PATH]: {}
    });

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
    // Setup mocks to simulate NO logs found (empty directory structure)
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

    // Mock empty logs directory - no session directories found
    const mockReaddir = vi.mocked(fs.promises.readdir);
    mockReaddir.mockResolvedValue([] as any);

    // @ts-ignore - Testing runtime robustness
    const result = await readVscodeLogs.handler(undefined);
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(textContent).toContain('No session log directory found');
  });
});