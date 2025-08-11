#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'assert';
import fs from 'fs/promises';

// IMPORTANT: Ajustez ce chemin si la structure de votre projet est différente.
// Ce chemin pointe vers la racine du SDK MCP pour accéder au client.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { McpClient, StdioClientTransport } from '@modelcontextprotocol/sdk';

// Couleurs pour une sortie console plus lisible
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

// =================================================================
// Fonctions de test pour chaque outil
// =================================================================

async function testReadMultipleFiles(client) {
  console.log(`\n${COLORS.cyan}--- Démarrage du test: read_multiple_files ---${COLORS.reset}`);
  const testDir = await fs.mkdtemp(path.join(__dirname, 'test-read-'));
  let testPassed = false;
  try {
    // Préparation
    const file1Path = path.join(testDir, 'file1.txt');
    const file2Path = path.join(testDir, 'file2.txt');
    const nonExistentPath = path.join(testDir, 'non-existent.txt');
    await fs.writeFile(file1Path, 'Contenu du fichier 1');
    await fs.writeFile(file2Path, 'Contenu du fichier 2');

    // Exécution
    const response = await client.tools.read_multiple_files({
        paths: [file1Path, file2Path, nonExistentPath],
        show_line_numbers: true
    });

    // Validation
    assert(response.content, 'La réponse doit contenir du contenu');
    const results = JSON.parse(response.content[0].text);
    const file1Result = results.find(r => r.path === file1Path);
    const file2Result = results.find(r => r.path === file2Path);
    const nonExistentResult = results.find(r => r.path === nonExistentPath);

    assert(file1Result && file1Result.content.includes('1 | Contenu du fichier 1'), 'Le contenu de file1.txt est incorrect');
    assert(file2Result && file2Result.content.includes('1 | Contenu du fichier 2'), 'Le contenu de file2.txt est incorrect');
    assert(nonExistentResult && nonExistentResult.error, 'La gestion des fichiers inexistants a échoué');
    
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
        // Préparation
        const subDir = path.join(testDir, 'subdir');
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(path.join(testDir, 'file1.txt'), 'a');
        await fs.writeFile(path.join(subDir, 'file2.txt'), 'b');

        // Exécution (non-récursif)
        const responseNonRecursive = await client.tools.list_directory_contents({ paths: [testDir] });
        
        // Validation (non-récursif)
        const textNonRecursive = responseNonRecursive.content[0].text;
        assert(textNonRecursive.includes('file1.txt'), 'La liste non-récursive doit contenir file1.txt');
        assert(textNonRecursive.includes('subdir'), 'La liste non-récursive doit contenir subdir');
        assert(!textNonRecursive.includes('file2.txt'), 'La liste non-récursive ne doit pas contenir file2.txt');

        // Exécution (récursif)
        const responseRecursive = await client.tools.list_directory_contents({ paths: [{ path: testDir, recursive: true }] });

        // Validation (récursif)
        const textRecursive = responseRecursive.content[0].text;
        assert(textRecursive.includes('file1.txt'), 'La liste récursive doit contenir file1.txt');
        assert(textRecursive.includes('file2.txt'), 'La liste récursive doit contenir file2.txt');

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

async function testDeleteFiles(client) {
    console.log(`\n${COLORS.cyan}--- Démarrage du test: delete_files ---${COLORS.reset}`);
    const testDir = await fs.mkdtemp(path.join(__dirname, 'test-delete-'));
    let testPassed = false;
    try {
        // Préparation
        const fileToDelete = path.join(testDir, 'delete-me.txt');
        await fs.writeFile(fileToDelete, 'contenu');

        // Exécution
        const response = await client.tools.delete_files({ paths: [fileToDelete] });

        // Validation
        const result = JSON.parse(response.content[0].text);
        assert(result[0].success === true, 'La suppression du fichier aurait dû réussir');
        
        // Vérification de la suppression
        await assert.rejects(
            fs.access(fileToDelete),
            { code: 'ENOENT' },
            'Le fichier aurait dû être supprimé'
        );

        console.log(`${COLORS.green}✓ Test delete_files réussi!${COLORS.reset}`);
        testPassed = true;
    } finally {
        await fs.rm(testDir, { recursive: true, force: true });
        console.log(`${COLORS.yellow}Nettoyage du répertoire de test: ${testDir}${COLORS.reset}`);
        if (!testPassed) {
            console.error(`${COLORS.red}✗ Le test delete_files a échoué lors du nettoyage.${COLORS.reset}`);
        }
    }
}

async function testEditMultipleFiles(client) {
    console.log(`\n${COLORS.cyan}--- Démarrage du test: edit_multiple_files ---${COLORS.reset}`);
    const testDir = await fs.mkdtemp(path.join(__dirname, 'test-edit-'));
    let testPassed = false;
    try {
        // Préparation
        const fileToEdit = path.join(testDir, 'edit-me.txt');
        const originalContent = 'Ligne 1\nLigne 2 à modifier\nLigne 3';
        await fs.writeFile(fileToEdit, originalContent);

        // Exécution
        const response = await client.tools.edit_multiple_files({
            files: [{
                path: fileToEdit,
                diffs: [{
                    search: 'Ligne 2 à modifier',
                    replace: 'Ligne 2 a été modifiée'
                }]
            }]
        });

        // Validation
        const editResult = JSON.parse(response.content[0].text);
        assert(editResult[0].success === true, 'L\'édition du fichier aurait dû réussir.');
        
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

async function runTestHarness() {
  console.log(`${COLORS.cyan}=== Démarrage du harnais de test pour le serveur MCP quickfiles ===${COLORS.reset}`);
  
  let client;

  // 1. Lancer le serveur
  try {
    const serverScriptPath = path.resolve(__dirname, 'build/index.js');
    console.log(`${COLORS.yellow}CHEMIN DU SERVEUR: ${serverScriptPath}${COLORS.reset}`);

    // 2. Connecter le client
    console.log(`${COLORS.yellow}Connexion du client MCP...${COLORS.reset}`);
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverScriptPath],
    });
    client = McpClient.create({
        transport: transport,
        clientInfo: {
            name: 'quickfiles-test-harness',
            version: '1.0.0',
        }
    });

    await client.connect(transport);
    console.log(`${COLORS.green}✓ Client connecté avec succès au serveur!${COLORS.reset}`);

    // 3. Exécuter les tests (Test de fumée)
    console.log(`${COLORS.yellow}Exécution du test de fumée: list_tools...${COLORS.reset}`);
    const toolsResponse = await client.listTools();
    
    assert(toolsResponse.tools, 'La réponse doit contenir une liste d\'outils');
    assert(Array.isArray(toolsResponse.tools), 'La liste des outils doit être un tableau');
    assert(toolsResponse.tools.length > 0, 'La liste des outils ne doit pas être vide');
    
    const toolNames = toolsResponse.tools.map(t => t.name);
    console.log(`${COLORS.green}✓ Outils disponibles: ${toolNames.join(', ')}${COLORS.reset}`);
    assert(toolNames.includes('list_directory_contents'), 'L\'outil "list_directory_contents" doit être présent');

    console.log(`${COLORS.green}✓ Test de fumée réussi!${COLORS.reset}`);

    // 4. Exécuter les tests fonctionnels
    try { await testReadMultipleFiles(client); } catch (e) { console.error('--- ERREUR dans testReadMultipleFiles ---', e); }
    try { await testListDirectory(client); } catch (e) { console.error('--- ERREUR dans testListDirectory ---', e); }
    try { await testDeleteFiles(client); } catch (e) { console.error('--- ERREUR dans testDeleteFiles ---', e); }
    try { await testEditMultipleFiles(client); } catch (e) { console.error('--- ERREUR dans testEditMultipleFiles ---', e); }

   } catch (error) {
    console.error(`${COLORS.red}✗ Un test a échoué: ${error.message}${COLORS.reset}`);
    console.error(error.stack);
    process.exitCode = 1; // Indiquer une sortie avec erreur
  } finally {
        if (client) {
            await client.close();
        }
  }
  
  console.log(`${COLORS.cyan}=== Harnais de test terminé ===${COLORS.reset}`);
}

runTestHarness();