import { MCPClient, StdioClientTransport } from '@modelcontextprotocol/sdk';
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

async function runTest() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const serverPath = path.resolve(__dirname, '../build/index.js');

  console.log('Starting QuickFiles server for test...');
  const serverProcess = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server stderr: ${data}`);
  });

  const transport = new StdioClientTransport(serverProcess);
  const client = new MCPClient();

  try {
    console.log('Connecting to server...');
    await client.connect(transport);
    console.log('Connection successful.');

    console.log('Listing tools...');
    const tools = await client.listTools();
    console.log('Available tools:', tools);

    const filePath = 'mcps/internal/servers/quickfiles-server/docs/CONFIGURATION.md';
    console.log(`\nAttempting to read file: ${filePath}`);

    const result = await client.callTool('quickfiles-server', 'read_multiple_files', {
      paths: [filePath]
    });

    console.log('\n--- Test Result ---');
    if (result.isError) {
      console.error('Test FAILED with error:');
    } else {
      console.log('Test PASSED. File content:');
    }
    console.log(result.content[0].text);
    console.log('-------------------\n');

  } catch (error) {
    console.error('An unexpected error occurred during the test:', error);
  } finally {
    console.log('Closing client and terminating server...');
    await client.close();
    serverProcess.kill();
    console.log('Test finished.');
  }
}

runTest();