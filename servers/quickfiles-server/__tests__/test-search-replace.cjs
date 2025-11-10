#!/usr/bin/env node

/**
 * Script de test pour les nouvelles fonctionnalités de search_and_replace
 * Teste les patterns de chemins et le fonctionnement sans fichier spécifique
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

// Configuration
const SERVER_PATH = path.join(__dirname, 'src', 'index.ts');
const TEST_DIR = path.join(__dirname, 'test-files');

// Créer des fichiers de test
async function setupTestFiles() {
    console.log('📁 Création des fichiers de test...');
    
    try {
        await fs.mkdir(TEST_DIR, { recursive: true });
        await fs.mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
        
        // Fichiers de test
        await fs.writeFile(path.join(TEST_DIR, 'test1.txt'), 'Hello World\nThis is a test\nHello again');
        await fs.writeFile(path.join(TEST_DIR, 'test2.js'), 'console.log("Hello World");\nfunction test() { return "Hello"; }');
        await fs.writeFile(path.join(TEST_DIR, 'src', 'component.ts'), 'class HelloComponent { hello() { return "Hello"; } }');
        await fs.writeFile(path.join(TEST_DIR, 'README.md'), '# Hello Project\n\nThis is a hello world example.');
        
        console.log('✅ Fichiers de test créés');
    } catch (error) {
        console.error('❌ Erreur lors de la création des fichiers:', error.message);
    }
}

// Fonction pour appeler l'outil search_and_replace
async function callSearchReplace(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', ['-e', `
            const { spawn } = require('child_process');
            const server = spawn('npx', ['ts-node', '${SERVER_PATH}'], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            // Envoyer la requête MCP
            const request = {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'search_and_replace',
                    arguments: ${JSON.stringify(args)}
                }
            };
            
            server.stdin.write(JSON.stringify(request) + '\\n');
            
            let response = '';
            server.stdout.on('data', (data) => {
                response += data.toString();
                try {
                    const lines = response.split('\\n').filter(line => line.trim());
                    for (const line of lines) {
                        if (line.startsWith('{') && line.endsWith('}')) {
                            const parsed = JSON.parse(line);
                            if (parsed.id === 1) {
                                server.kill();
                                resolve(parsed);
                                return;
                            }
                        }
                    }
                } catch (e) {
                    // Ignorer les erreurs de parsing partiel
                }
            });
            
            server.stderr.on('data', (data) => {
                console.error('STDERR:', data.toString());
            });
            
            server.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(\`Server exited with code \${code}\`));
                }
            });
            
            setTimeout(() => {
                server.kill();
                reject(new Error('Timeout'));
            }, 10000);
        `], {
            cwd: TEST_DIR,
            stdio: 'pipe'
        });
        
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
    });
}

// Tests
async function runTests() {
    console.log('🧪 Démarrage des tests de search_and_replace\n');
    
    await setupTestFiles();
    
    const tests = [
        {
            name: 'Test 1: Global sur workspace (sans paths/files)',
            args: {
                search: 'Hello',
                replace: 'Bonjour',
                preview: true,
                file_pattern: '*.txt'
            }
        },
        {
            name: 'Test 2: Pattern de chemins avec glob',
            args: {
                paths: ['src/**/*.ts'],
                search: 'Hello',
                replace: 'Bonjour',
                preview: true
            }
        },
        {
            name: 'Test 3: Fichiers spécifiques (rétrocompatibilité)',
            args: {
                files: [
                    { path: 'test1.txt', search: 'Hello', replace: 'Bonjour' }
                ],
                preview: true
            }
        },
        {
            name: 'Test 4: Pattern qui ne correspond à rien',
            args: {
                paths: ['**/*.py'],
                search: 'Hello',
                replace: 'Bonjour',
                preview: true
            }
        }
    ];
    
    for (const test of tests) {
        console.log(`\n🔍 ${test.name}`);
        console.log(`Args:`, JSON.stringify(test.args, null, 2));
        
        try {
            const result = await callSearchReplace(test.args);
            if (result.error) {
                console.log('❌ Erreur:', result.error.message);
            } else if (result.result && result.result.content && result.result.content[0]) {
                console.log('✅ Résultat:');
                console.log(result.result.content[0].text);
            } else {
                console.log('⚠️ Résultat inattendu:', result);
            }
        } catch (error) {
            console.log('❌ Erreur de test:', error.message);
        }
    }
    
    console.log('\n🧹 Nettoyage des fichiers de test...');
    try {
        await fs.rmdir(TEST_DIR, { recursive: true });
        console.log('✅ Nettoyage terminé');
    } catch (error) {
        console.error('❌ Erreur lors du nettoyage:', error.message);
    }
}

// Exécuter les tests
if (require.main === module) {
    runTests().catch(console.error);
}

module.exports = { setupTestFiles, callSearchReplace, runTests };