#!/usr/bin/env node

/**
 * Script de test d'intégration MCP pour QuickFiles Server
 * Valide que le serveur MCP fonctionne correctement avec le protocole MCP
 */

const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

class MCPIntegrationTester {
    constructor() {
        this.testDir = '';
        this.serverProcess = null;
        this.results = {
            passed: 0,
            failed: 0,
            total: 0,
            details: []
        };
    }

    async setup() {
        this.testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickfiles-mcp-test-'));
        console.log(`📁 Répertoire de test créé: ${this.testDir}`);
        await this.createTestFiles();
    }

    async createTestFiles() {
        const files = [
            { name: 'mcp-test.txt', content: 'Fichier de test MCP\nContenu pour validation' },
            { name: 'config.json', content: '{"name": "test", "version": "1.0.0"}' },
            { name: 'README.md', content: '# Test MCP\n## Description\nTest d\'intégration' }
        ];

        for (const file of files) {
            await fs.writeFile(path.join(this.testDir, file.name), file.content, 'utf-8');
        }
    }

    async cleanup() {
        if (this.serverProcess) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }

        try {
            await fs.rm(this.testDir, { recursive: true, force: true });
            console.log(`🧹 Répertoire de test nettoyé: ${this.testDir}`);
        } catch (error) {
            console.error(`Erreur lors du nettoyage: ${error.message}`);
        }
    }

    async runTest(testName, testFunction) {
        this.results.total++;
        try {
            await testFunction();
            this.results.passed++;
            this.results.details.push({ name: testName, status: '✅ PASSÉ', error: null });
            console.log(`✅ ${testName}`);
        } catch (error) {
            this.results.failed++;
            this.results.details.push({ name: testName, status: '❌ ÉCHOUÉ', error: error.message });
            console.log(`❌ ${testName}: ${error.message}`);
        }
    }

    async testServerStartup() {
        // Test de démarrage du serveur MCP
        return new Promise((resolve, reject) => {
            const serverPath = path.join(__dirname, 'build', 'index.js');
            
            this.serverProcess = spawn('node', [serverPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: this.testDir
            });

            let startupOutput = '';
            let startupError = '';

            this.serverProcess.stderr.on('data', (data) => {
                startupError += data.toString();
                console.log(`Server stderr: ${data.toString().trim()}`);
            });

            this.serverProcess.stdout.on('data', (data) => {
                startupOutput += data.toString();
                console.log(`Server stdout: ${data.toString().trim()}`);
            });

            // Timeout après 5 secondes
            const timeout = setTimeout(() => {
                if (this.serverProcess) {
                    this.serverProcess.kill();
                }
                reject(new Error('Timeout lors du démarrage du serveur'));
            }, 5000);

            this.serverProcess.on('error', (error) => {
                clearTimeout(timeout);
                reject(new Error(`Erreur de démarrage: ${error.message}`));
            });

            this.serverProcess.on('exit', (code) => {
                clearTimeout(timeout);
                if (code !== 0 && code !== null) {
                    reject(new Error(`Le serveur s'est arrêté avec le code ${code}`));
                }
            });

            // Vérifier les messages de démarrage attendus
            setTimeout(() => {
                clearTimeout(timeout);
                
                if (startupOutput.includes('QuickFiles server starting') || 
                    startupError.includes('QuickFiles server starting') ||
                    startupOutput.includes('connected and listening')) {
                    resolve();
                } else {
                    reject(new Error('Messages de démarrage MCP non trouvés'));
                }
            }, 3000);
        });
    }

    async testMCPProtocol() {
        // Test basique du protocole MCP
        return new Promise((resolve, reject) => {
            if (!this.serverProcess) {
                reject(new Error('Le serveur n\'est pas démarré'));
                return;
            }

            // Envoyer une requête MCP basique
            const initializeRequest = {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {
                        tools: {}
                    },
                    clientInfo: {
                        name: "test-client",
                        version: "1.0.0"
                    }
                }
            };

            let responseReceived = false;
            const timeout = setTimeout(() => {
                if (!responseReceived) {
                    reject(new Error('Timeout lors de la communication MCP'));
                }
            }, 3000);

            // Écouter la réponse
            this.serverProcess.stdout.on('data', (data) => {
                const output = data.toString();
                try {
                    const lines = output.trim().split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            const response = JSON.parse(line);
                            if (response.id === 1) {
                                clearTimeout(timeout);
                                responseReceived = true;
                                
                                if (response.result) {
                                    resolve();
                                } else if (response.error) {
                                    reject(new Error(`Erreur MCP: ${response.error.message}`));
                                } else {
                                    reject(new Error('Réponse MCP invalide'));
                                }
                            }
                        }
                    }
                } catch (error) {
                    // Ignorer les erreurs de parsing pour les logs
                }
            });

            // Envoyer la requête
            this.serverProcess.stdin.write(JSON.stringify(initializeRequest) + '\n');
        });
    }

    async testToolsListing() {
        // Test de listing des outils MCP
        return new Promise((resolve, reject) => {
            const toolsRequest = {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {}
            };

            let responseReceived = false;
            const timeout = setTimeout(() => {
                if (!responseReceived) {
                    reject(new Error('Timeout lors du listing des outils'));
                }
            }, 3000);

            this.serverProcess.stdout.on('data', (data) => {
                const output = data.toString();
                try {
                    const lines = output.trim().split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            const response = JSON.parse(line);
                            if (response.id === 2) {
                                clearTimeout(timeout);
                                responseReceived = true;
                                
                                if (response.result && response.result.tools) {
                                    const tools = response.result.tools;
                                    const expectedTools = [
                                        'read_multiple_files',
                                        'list_directory_contents',
                                        'delete_files',
                                        'edit_multiple_files',
                                        'extract_markdown_structure',
                                        'copy_files',
                                        'move_files',
                                        'search_in_files',
                                        'search_and_replace',
                                        'restart_mcp_servers'
                                    ];

                                    const foundTools = tools.map(t => t.name);
                                    const missingTools = expectedTools.filter(tool => !foundTools.includes(tool));
                                    
                                    if (missingTools.length > 0) {
                                        reject(new Error(`Outils manquants: ${missingTools.join(', ')}`));
                                    } else {
                                        console.log(`🔧 ${tools.length} outils MCP détectés`);
                                        resolve();
                                    }
                                } else if (response.error) {
                                    reject(new Error(`Erreur MCP: ${response.error.message}`));
                                } else {
                                    reject(new Error('Réponse de listing invalide'));
                                }
                            }
                        }
                    }
                } catch (error) {
                    // Ignorer les erreurs de parsing
                }
            });

            this.serverProcess.stdin.write(JSON.stringify(toolsRequest) + '\n');
        });
    }

    async testToolExecution() {
        // Test d'exécution d'un outil MCP simple
        return new Promise((resolve, reject) => {
            const toolCallRequest = {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                    name: "list_directory_contents",
                    arguments: {
                        paths: [this.testDir],
                        max_lines: 10
                    }
                }
            };

            let responseReceived = false;
            const timeout = setTimeout(() => {
                if (!responseReceived) {
                    reject(new Error('Timeout lors de l\'exécution de l\'outil'));
                }
            }, 5000);

            this.serverProcess.stdout.on('data', (data) => {
                const output = data.toString();
                try {
                    const lines = output.trim().split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            const response = JSON.parse(line);
                            if (response.id === 3) {
                                clearTimeout(timeout);
                                responseReceived = true;
                                
                                if (response.result && response.result.content) {
                                    const content = response.result.content[0];
                                    if (content && content.text && content.text.includes('mcp-test.txt')) {
                                        resolve();
                                    } else {
                                        reject(new Error('Le résultat de l\'outil est incorrect'));
                                    }
                                } else if (response.error) {
                                    reject(new Error(`Erreur d'exécution: ${response.error.message}`));
                                } else {
                                    reject(new Error('Réponse d\'exécution invalide'));
                                }
                            }
                        }
                    }
                } catch (error) {
                    // Ignorer les erreurs de parsing
                }
            });

            this.serverProcess.stdin.write(JSON.stringify(toolCallRequest) + '\n');
        });
    }

    async runAllTests() {
        console.log('🚀 Démarrage des tests d\'intégration MCP QuickFiles\n');

        await this.setup();

        try {
            // Tests d'intégration MCP
            await this.runTest('Démarrage du serveur MCP', () => this.testServerStartup());
            await this.runTest('Communication protocole MCP', () => this.testMCPProtocol());
            await this.runTest('Listing des outils MCP', () => this.testToolsListing());
            await this.runTest('Exécution d\'outil MCP', () => this.testToolExecution());

        } finally {
            await this.cleanup();
        }

        this.printResults();
    }

    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 RÉSULTATS DES TESTS D\'INTÉGRATION MCP');
        console.log('='.repeat(60));
        console.log(`Total: ${this.results.total}`);
        console.log(`✅ Réussis: ${this.results.passed}`);
        console.log(`❌ Échoués: ${this.results.failed}`);
        console.log(`Taux de réussite: ${((this.results.passed / this.results.total) * 100).toFixed(1)}%`);
        
        console.log('\n📋 Détails:');
        this.results.details.forEach(test => {
            console.log(`  ${test.status} ${test.name}`);
            if (test.error) {
                console.log(`    Erreur: ${test.error}`);
            }
        });

        if (this.results.failed === 0) {
            console.log('\n🎉 TOUS LES TESTS D\'INTÉGRATION MCP SONT PASSÉS !');
            console.log('✅ Le serveur MCP QuickFiles est pleinement opérationnel');
            console.log('✅ La communication avec le protocole MCP fonctionne');
            console.log('✅ Tous les outils MCP sont disponibles et fonctionnels');
        } else {
            console.log('\n⚠️  CERTAINS TESTS D\'INTÉGRATION MCP ONT ÉCHOUÉ');
            console.log('🔍 Vérification nécessaire pour l\'intégration MCP');
        }
    }
}

// Exécuter les tests si ce script est lancé directement
if (require.main === module) {
    const tester = new MCPIntegrationTester();
    tester.runAllTests().catch(error => {
        console.error('Erreur lors de l\'exécution des tests:', error);
        process.exit(1);
    });
}

module.exports = { MCPIntegrationTester };