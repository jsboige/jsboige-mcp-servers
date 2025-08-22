#!/usr/bin/env node
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PROCESS_PATH = path.join(__dirname, 'test-mcp-server.js');

class McpClient {
  constructor(serverProcess) {
    this.serverProcess = serverProcess;
    this.requestId = 1;
    this.pendingRequests = new Map();

    this.serverProcess.stdout.on('data', (data) => {
      const rawData = data.toString();
      const messages = rawData.split('\n').filter(Boolean);
      for (const message of messages) {
        try {
          const response = JSON.parse(message);
          if (response.id && this.pendingRequests.has(response.id)) {
            const { resolve, reject } = this.pendingRequests.get(response.id);
            this.pendingRequests.delete(response.id);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result);
            }
          }
        } catch (error) {
          console.error(`Error parsing response: ${error.message}`);
        }
      }
    });

    this.serverProcess.stderr.on('data', (data) => {
      console.error(`[Server stderr]: ${data.toString()}`);
    });

    this.serverProcess.on('close', (code) => {
      console.log(`Server process exited with code ${code}`);
    });
  }

  async sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };
      this.pendingRequests.set(id, { resolve, reject });
      this.serverProcess.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async listTools() {
    return this.sendRequest('tools/list', {});
  }

  async callTool(name, args) {
    return this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
  }

  close() {
    this.serverProcess.stdin.end();
  }
}

async function runTests() {
  const serverProcess = spawn('node', [SERVER_PROCESS_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const client = new McpClient(serverProcess);

  try {
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('Test: Listing tools');
    const tools = await client.listTools();
    console.log('Tools:', tools);

    console.log('Test: Calling echo tool');
    const result = await client.callTool('echo', { message: 'Hello, world!' });
    console.log('Result:', result);
  } catch (error) {
    console.error(`Error during tests: ${error.message}`);
  } finally {
    client.close();
  }
}

runTests();