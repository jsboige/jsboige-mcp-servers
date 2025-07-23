import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll
} from '@jest/globals';
import {
    fileURLToPath
} from 'url';
import {
    resolve,
    dirname,
    join
} from 'path';
import fs from 'fs-extra';
import {
    Client
} from '@modelcontextprotocol/sdk/client/index.js';
import {
    StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
    v4 as uuidv4
} from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ToolResult {
    content: [{
        text: string;
    }];
}

describe('Roo State Manager E2E Test Suite for Large Data', () => {
    let client: Client;
    let testStoragePath: string;
    const originalStoragePath = 'C:/Users/jsboi/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks';

    beforeAll(async () => {
        // Create a temporary directory for our test storage
        testStoragePath = join(__dirname, 'temp-storage', uuidv4());
        fs.mkdirSync(testStoragePath, {
            recursive: true
        });

        // Dynamically find the first task directory to use for copying files
        const taskDirs = fs.readdirSync(originalStoragePath);
        if (taskDirs.length > 0) {
            const firstTaskDir = taskDirs[0];
            console.log(`Using task directory for test data: ${firstTaskDir}`);

            const largeFilesToCopy = [
                `${firstTaskDir}/api_conversation_history.index.json`,
                `${firstTaskDir}/api_conversation_history.json`,
                `${firstTaskDir}/ui_messages.index.json`,
                `${firstTaskDir}/ui_messages.json`
            ];

            for (const file of largeFilesToCopy) {
                const sourcePath = join(originalStoragePath, file);
                const destPath = join(testStoragePath, 'tasks', file);
                console.log(`Copying from ${sourcePath} to ${destPath}`);
                if (fs.existsSync(sourcePath)) {
                    fs.copySync(sourcePath, destPath);
                } else {
                    console.warn(`Warning: Source file not found at ${sourcePath}`);
                    if (file.endsWith('.index.json')) {
                        fs.ensureDirSync(dirname(destPath));
                        fs.writeJsonSync(destPath, {
                            some: 'data'
                        });
                    }
                }
            }
        } else {
            console.warn(`Warning: No task directories found in ${originalStoragePath}`);
        }

        const serverPath = resolve(__dirname, '../../build/index.js');
        const transport = new StdioClientTransport({
            command: 'node',
            args: [serverPath],
            env: {
                ...process.env,
                ROO_STORAGE_PATH: testStoragePath,
                DEBUG: '*'
            }
        });
        client = new Client({
            transport,
            name: 'roo-state-manager-large-data-test',
            version: '1.0.0'
        });
    });

    afterAll(async () => {
        if (client) {
            await client.close();
        }
        // Clean up the temporary storage directory
        if (fs.existsSync(testStoragePath)) {
            fs.rmSync(testStoragePath, {
                recursive: true,
                force: true
            });
        }
    });

    it('should detect roo storage without crashing and return lightweight metadata', async () => {
        // Wait for 2 seconds to give the server time to start
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = (await client.callTool({
            name: 'detect_roo_storage',
            arguments: {}
        })) as unknown as ToolResult;

        // Assertion 1: The process should not have crashed (reaching this point is a pass)
        expect(result).toBeDefined();

        // Assertion 2: The tool call should be successful
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);

        const jsonString = result.content[0].text;

        // Assertion 3: The response should be a small JSON string (e.g., less than 5KB)
        const responseSizeInKB = Buffer.byteLength(jsonString, 'utf8') / 1024;
        expect(responseSizeInKB).toBeLessThan(5);

        // Assertion 4: The parsed response should contain metadata, not full content
        const detection = JSON.parse(jsonString);
        expect(Array.isArray(detection.conversations)).toBe(true);
        if (detection.conversations.length > 0) {
            const conversation = detection.conversations[0];
            expect(conversation).toHaveProperty('id');
            expect(conversation).toHaveProperty('title');
            expect(conversation).toHaveProperty('size');
            expect(conversation).not.toHaveProperty('content');
            expect(conversation).not.toHaveProperty('messages');
            expect(conversation).not.toHaveProperty('apiHistory');
        }
    });
});