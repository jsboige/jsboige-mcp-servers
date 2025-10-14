#!/usr/bin/env node
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { Client as McpClient } from '@modelcontextprotocol/sdk';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

async function testReadMultipleFiles(client) {
    console.log(`\n${COLORS.cyan}--- Démarrage du test: read_multiple_files ---${COLORS.reset}`);
    const testDir = await fs.mkdtemp(path.join(__dirname, 'test-read-'));
    let testPassed = false;
    try {
        const file1Path = path.join(testDir, 'file1.txt');
        const file2Path = path.join(testDir, 'file2.txt');
        const nonExistentPath = path.join(testDir, 'non-existent.txt');
        await fs.writeFile(file1Path, 'Contenu du fichier 1');
        await fs.writeFile(file2Path, 'Contenu du fichier 2');

        const response = await client.tools.read_multiple_files({
            paths: [file1Path, file2Path, nonExistentPath],
            show_line_numbers: true
        });

        assert(response.content, 'La réponse doit contenir du contenu');
        const responseText = response.content[0].text;
        
        assert(responseText.includes('--- ' + file1Path), 'Le résultat pour file1.txt est manquant');
        assert(responseText.includes('--- ' + file2Path), 'Le résultat pour file2.txt est manquant');
        assert(responseText.includes('--- ' + nonExistentPath), 'Le résultat pour le fichier inexistant est manquant');

        assert(responseText.includes('1 | Contenu du fichier 1'), 'Le contenu de file1.txt est incorrect');
        assert(responseText.includes('1 | Contenu du fichier 2'), 'Le contenu de file2.txt est incorrect');
        assert(responseText.includes('ERROR: ENOENT: no such file or directory'), 'Le message d\'erreur pour le fichier inexistant est incorrect');
        
        console.log(`${COLORS.green}✓ Test read_multiple_files réussi!${COLORS.reset}`);
        testPassed = true;
    } finally {
        await fs.rm(testDir, { recursive: true, force: true });
        console.log(`${COLORS.yellow}Nettoyage du répertoire de test: ${testDir}${COLORS.reset}`);
        if (!testPassed) {
            console.error(`${COLORS.red}✗ Le test read_multiple_files a échoué lors du nettoyage.${COLORS.reset}`);
        }
    }
}

async function testListDirectory(client) {
    console.log(`\n${COLORS.cyan}--- Démarrage du test: list_directory_contents ---${COLORS.reset}`);
    const testDir = await fs.mkdtemp(path.join(__dirname, 'test-list-'));
    let testPassed = false;
    try {
        const subDir = path.join(testDir, 'subdir');
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(path.join(testDir, 'file1.txt'), 'a');
        await fs.writeFile(path.join(subDir, 'file2.txt'), 'b');

        const response = await client.tools.list_directory_contents({ paths: [testDir] });

        const text = response.content[0].text;
        assert(text.includes('file1.txt'), 'La liste doit contenir file1.txt');
        assert(text.includes('subdir'), 'La liste doit contenir subdir');

        console.log(`${COLORS.green}✓ Test list_directory_contents réussi!${COLORS.reset}`);
        testPassed = true;
    } finally {
        await fs.rm(testDir, { recursive: true, force: true });
        console.log(`${COLORS.yellow}Nettoyage du répertoire de test: ${testDir}${COLORS.reset}`);
        if (!testPassed) {
            console.error(`${COLORS.red}✗ Le test list_directory_contents a échoué lors du nettoyage.${COLORS.reset}`);
        }
    }
}

async function testEditMultipleFiles(client) {
    console.log(`\n${COLORS.cyan}--- Démarrage du test: edit_multiple_files ---${COLORS.reset}`);
    const testDir = await fs.mkdtemp(path.join(__dirname, 'test-edit-'));
    let testPassed = false;
    try {
        const fileToEdit = path.join(testDir, 'edit-me.txt');
        const originalContent = 'Ligne 1\nLigne 2 à modifier\nLigne 3';
        await fs.writeFile(fileToEdit, originalContent);

        const response = await client.tools.edit_multiple_files({
            files: [{
                path: fileToEdit,
                diffs: [{
                    search: 'Ligne 2 à modifier',
                    replace: 'Ligne 2 a été modifiée'
                }]
            }]
        });

        const textResponse = response.content[0].text;
        assert(textResponse.includes('modification(s) appliquée(s)'), 'L\'édition du fichier aurait dû réussir.');
        
        const newContent = await fs.readFile(fileToEdit, 'utf-8');
        assert.strictEqual(newContent, 'Ligne 1\nLigne 2 a été modifiée\nLigne 3', 'Le contenu du fichier n\'a pas été modifié correctement');

        console.log(`${COLORS.green}✓ Test edit_multiple_files réussi!${COLORS.reset}`);
        testPassed = true;
    } finally {
        await fs.rm(testDir, { recursive: true, force: true });
        console.log(`${COLORS.yellow}Nettoyage du répertoire de test: ${testDir}${COLORS.reset}`);
        if (!testPassed) {
            console.error(`${COLORS.red}✗ Le test edit_multiple_files a échoué lors du nettoyage.${COLORS.reset}`);
        }
    }
}

async function testRestartMcpServers(client) {
    console.log(`\n${COLORS.cyan}--- Démarrage du test: restart_mcp_servers ---${COLORS.reset}`);
    // This test is more complex as it involves manipulating global state.
    // For this simple test, we'll just call it and check for a success-like response.
    try {
        const response = await client.tools.restart_mcp_servers({
            servers: ['non_existent_server']
        });
        const result = JSON.parse(response.content[0].text);
        assert(result[0].success === false, 'Le redémarrage aurait dû échouer pour un serveur inexistant.');
        console.log(`${COLORS.green}✓ Test restart_mcp_servers réussi!${COLORS.reset}`);
    } catch (error) {
         console.error(`${COLORS.red}✗ Le test restart_mcp_servers a échoué: ${error.message}${COLORS.reset}`);
    }
}
 
async function runTestHarness() {
  console.log(`${COLORS.cyan}=== Démarrage du harnais de test pour le serveur MCP quickfiles ===${COLORS.reset}`);
  
  let client;
 
  try {
    const serverScriptPath = path.resolve(__dirname, 'build/index.js');
    console.log(`${COLORS.yellow}CHEMIN DU SERVEUR: ${serverScriptPath}${COLORS.reset}`);

    console.log(`${COLORS.yellow}Connexion du client MCP...${COLORS.reset}`);
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverScriptPath],
    });
    
    client = McpClient.create({
      transport,
      clientInfo: { name: 'quickfiles-test-harness' }
    });

    await client.connect();
    console.log(`${COLORS.green}✓ Client connecté avec succès au serveur!${COLORS.reset}`);

    console.log(`${COLORS.yellow}Exécution du test de fumée: list_tools...${COLORS.reset}`);
    const toolsResponse = await client.tools.list();
    
    assert(toolsResponse.tools, 'La réponse doit contenir une liste d\'outils');
    const toolNames = toolsResponse.tools.map(t => t.name);
    console.log(`${COLORS.green}✓ Outils disponibles: ${toolNames.join(', ')}${COLORS.reset}`);
    assert(toolNames.includes('read_multiple_files'), 'L\'outil "read_multiple_files" doit être présent');
    assert(toolNames.includes('edit_multiple_files'), 'L\'outil "edit_multiple_files" doit être présent');

    console.log(`${COLORS.green}✓ Test de fumée réussi!${COLORS.reset}`);

    await testReadMultipleFiles(client);
    await testListDirectory(client);
    await testEditMultipleFiles(client);
    await testRestartMcpServers(client);

   } catch (error) {
     console.error(`${COLORS.red}✗ Un test a échoué: ${error.message}${COLORS.reset}`);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
        if (client) {
            await client.close();
        }
        console.log(`${COLORS.cyan}=== Tests terminés ===${COLORS.reset}`);
  }
}

runTestHarness();