/**
 * Script de validation manuelle des handlers migrés (Batches 1-5)
 * 
 * Ce script teste que tous les handlers extraits sont bien présents,
 * exportés correctement et que leur structure de base est intacte.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration des handlers à valider par batch
const HANDLERS_BY_BATCH = {
    'Batch 1 - Storage': {
        handlers: ['detect_roo_storage', 'get_storage_stats'],
        modules: [
            'build/src/tools/storage/detect-storage.tool.js',
            'build/src/tools/storage/get-stats.tool.js'
        ]
    },
    'Batch 2 - Conversations': {
        handlers: ['list_conversations', 'read_conversation', 'view_conversation_tree', 'search_conversations'],
        modules: [
            'build/src/tools/conversation/list-conversations.tool.js',
            'build/src/tools/conversation/get-raw.tool.js',
            'build/src/tools/view-conversation-tree.js',
            'build/src/tools/conversation/view-details.tool.js'
        ]
    },
    'Batch 3 - Tasks': {
        handlers: ['get_task_tree', 'debug_task_parsing', 'export_task_tree_markdown'],
        modules: [
            'build/src/tools/task/get-tree.tool.js',
            'build/src/tools/task/debug-parsing.tool.js',
            'build/src/tools/task/export-tree-md.tool.js'
        ]
    },
    'Batch 4 - Search & Indexing': {
        handlers: ['search_tasks_semantic', 'search_tasks_semantic_fallback', 'index_task_semantic', 'diagnose_semantic_index', 'reset_qdrant_collection'],
        modules: [
            'build/src/tools/search/search-semantic.tool.js',
            'build/src/tools/search/search-fallback.tool.js',
            'build/src/tools/indexing/index-task.tool.js',
            'build/src/tools/indexing/diagnose-index.tool.js',
            'build/src/tools/indexing/reset-collection.tool.js'
        ]
    },
    'Batch 5 - Export XML': {
        handlers: ['export_tasks_xml', 'export_conversation_xml', 'export_project_xml', 'configure_xml_export'],
        modules: [
            'build/src/tools/export/export-tasks-xml.js',
            'build/src/tools/export/export-conversation-xml.js',
            'build/src/tools/export/export-project-xml.js',
            'build/src/tools/export/configure-xml-export.js'
        ]
    }
};

// Couleurs pour la sortie console
const COLORS = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

function log(color, ...args) {
    console.log(COLORS[color], ...args, COLORS.reset);
}

/**
 * Valide qu'un module peut être importé et expose un tool valide
 */
async function validateModule(modulePath) {
    try {
        const fullPath = join(__dirname, '../../', modulePath);
        // Convertir en URL file:// pour Windows ESM
        const fileURL = pathToFileURL(fullPath).href;
        const module = await import(fileURL);
        
        // Vérifier qu'il y a au moins un export
        const exports = Object.keys(module);
        if (exports.length === 0) {
            return { success: false, error: 'No exports found' };
        }

        // Chercher un tool dans les exports
        const toolExport = exports.find(key => {
            const value = module[key];
            return value && typeof value === 'object' &&
                   (value.name || value.handler || value.tool);
        });

        if (!toolExport) {
            return { success: false, error: 'No tool structure found in exports' };
        }

        const tool = module[toolExport];
        
        // Vérifier si le handler est dans l'objet tool OU exporté séparément
        let hasHandler = tool.handler && typeof tool.handler === 'function';
        
        if (!hasHandler) {
            // Chercher un handler exporté séparément (ex: handleGetTaskTree, handleExportTasksXml)
            const handlerExport = exports.find(key =>
                key.startsWith('handle') && typeof module[key] === 'function'
            );
            hasHandler = !!handlerExport;
        }
        
        if (!hasHandler) {
            return { success: false, error: 'Missing or invalid handler function (not in tool object nor as separate export)' };
        }

        return { 
            success: true, 
            toolName: tool.name || toolExport,
            exports: exports.length,
            hasInputSchema: !!tool.inputSchema
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Valide tous les handlers d'un batch
 */
async function validateBatch(batchName, config) {
    log('blue', `\n${'='.repeat(60)}`);
    log('blue', `Validation: ${batchName}`);
    log('blue', '='.repeat(60));
    
    console.log(`Handlers attendus: ${config.handlers.join(', ')}`);
    console.log(`Modules à valider: ${config.modules.length}\n`);

    let passed = 0;
    let failed = 0;
    const results = [];

    for (let i = 0; i < config.modules.length; i++) {
        const modulePath = config.modules[i];
        const expectedHandler = config.handlers[i] || `Handler ${i + 1}`;
        
        process.stdout.write(`  Testing ${expectedHandler}... `);
        
        const result = await validateModule(modulePath);
        
        if (result.success) {
            log('green', '✓ PASS');
            console.log(`    → Tool: ${result.toolName}`);
            console.log(`    → Exports: ${result.exports}`);
            console.log(`    → Input Schema: ${result.hasInputSchema ? 'Yes' : 'No'}`);
            passed++;
        } else {
            log('red', '✗ FAIL');
            console.log(`    → Error: ${result.error}`);
            console.log(`    → Module: ${modulePath}`);
            failed++;
        }
        
        results.push({
            handler: expectedHandler,
            module: modulePath,
            ...result
        });
    }

    return { passed, failed, results };
}

/**
 * Fonction principale
 */
async function main() {
    console.log('\n');
    log('blue', '╔═══════════════════════════════════════════════════════════╗');
    log('blue', '║     Validation Tests - Batches 1-5 (18 handlers)        ║');
    log('blue', '╚═══════════════════════════════════════════════════════════╝');
    
    let totalPassed = 0;
    let totalFailed = 0;
    const batchResults = {};

    // Valider chaque batch
    for (const [batchName, config] of Object.entries(HANDLERS_BY_BATCH)) {
        const result = await validateBatch(batchName, config);
        batchResults[batchName] = result;
        totalPassed += result.passed;
        totalFailed += result.failed;
    }

    // Résumé final
    console.log('\n');
    log('blue', '═'.repeat(60));
    log('blue', 'RÉSUMÉ DE VALIDATION');
    log('blue', '═'.repeat(60));
    
    for (const [batchName, result] of Object.entries(batchResults)) {
        const status = result.failed === 0 ? '✓' : '✗';
        const color = result.failed === 0 ? 'green' : 'red';
        log(color, `${status} ${batchName}: ${result.passed}/${result.passed + result.failed} tests passés`);
    }

    console.log('\n');
    log('blue', 'TOTAL:');
    const overallStatus = totalFailed === 0 ? '✓ TOUS LES TESTS PASSENT' : `✗ ${totalFailed} TESTS ÉCHOUÉS`;
    const overallColor = totalFailed === 0 ? 'green' : 'red';
    log(overallColor, `  ${overallStatus} (${totalPassed}/${totalPassed + totalFailed})`);
    
    console.log('\n');

    // Code de sortie
    process.exit(totalFailed > 0 ? 1 : 0);
}

// Exécution
main().catch(error => {
    log('red', '\n✗ ERREUR CRITIQUE:');
    console.error(error);
    process.exit(1);
});