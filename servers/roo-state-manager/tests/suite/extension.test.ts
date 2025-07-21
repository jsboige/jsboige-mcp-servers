import * as assert from 'assert';
import * as vscode from 'vscode';
import { RooStateManagerServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

suite('Roo State Manager E2E Test Suite', () => {
  let client: Client;
  let serverProcess: any;

  suiteSetup(async () => {
    serverProcess = spawn('node', ['./build/index.js'], { stdio: 'pipe' });
    const transport = new StdioClientTransport(serverProcess);
    client = new Client({
      name: 'test-client',
      version: '1.0.0',
      transport,
    });
  });

  suiteTeardown(() => {
    serverProcess.kill();
  });

  test('should detect roo storage and list conversations', async () => {
    const result = await client.callTool({ name: 'detect_roo_storage', arguments: {} }) as { content: { text: string }[] };
    assert.ok(result.content[0].text);
    const detection = JSON.parse(result.content[0].text);
    assert.strictEqual(detection.detected, true, 'Roo storage should be detected');
    assert.ok(detection.conversations.length > 0, 'Should find at least one conversation');
  });
});