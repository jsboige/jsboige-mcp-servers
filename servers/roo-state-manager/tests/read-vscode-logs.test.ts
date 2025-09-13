import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import mock from 'mock-fs';
import { readVscodeLogs } from '../src/tools/read-vscode-logs.js';
import path from 'path';

describe('read_vscode_logs Tool', () => {
  const APPDATA = process.platform === 'win32' ? 'C:\\Users\\test\\AppData\\Roaming' : '/home/test/.config';
  const LOGS_PATH = path.join(APPDATA, 'Code', 'logs');

  beforeEach(() => {
    process.env.APPDATA = APPDATA;
    const latestSessionPath = path.join(LOGS_PATH, '20250102T120000');
    // Renommer pour que le tri alphabétique fonctionne
    const latestWindowPath = path.join(latestSessionPath, 'window2');
    const exthostPath = path.join(latestWindowPath, 'exthost');
    const outputPath = path.join(exthostPath, 'output_logging_20250102T120000');

    mock({
      [path.join(LOGS_PATH, '20250101T120000', 'window1', 'renderer.log')]: 'old log content',
      [path.join(latestWindowPath, 'renderer.log')]: 'some renderer line 1\nsome renderer line 2',
      [path.join(exthostPath, 'exthost.log')]: 'exthost line 1\nroo line 2\nexthost line 3',
      [path.join(outputPath, '1-Roo-Code.log')]: 'roo log line 1\nroo log line 2',
      [path.join(latestSessionPath, 'window1', 'renderer.log')]: 'should not be read', // Ancien window
      [path.join(LOGS_PATH, '20250103T120000')]: {}, // empty session dir
    });
  });

  afterEach(() => {
    mock.restore();
    delete process.env.APPDATA;
  });

  it('should read the latest logs from all relevant files', async () => {
    const result = await readVscodeLogs.handler({});
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

    expect(textContent).toContain('--- LOG: renderer ---');
    expect(textContent).toContain('some renderer line 1\nsome renderer line 2');
    expect(textContent).toContain('--- LOG: exthost ---');
    expect(textContent).toContain('exthost line 1\nroo line 2\nexthost line 3');
    expect(textContent).toContain('--- LOG: Roo-Code Output ---');
    expect(textContent).toContain('roo log line 1\nroo log line 2');
    expect(textContent).not.toContain('old log content');
  });

  it('should read a specific number of lines', async () => {
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
    const result = await readVscodeLogs.handler({ filter: 'roo' });
    const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

    expect(textContent).not.toContain('some renderer line 1');
    expect(textContent).toContain('roo line 2');
    expect(textContent).toContain('roo log line 1\nroo log line 2');
  });

  it('should return a message if no session directory is found', async () => {
    mock.restore();
    mock({ [LOGS_PATH]: {} });
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
});