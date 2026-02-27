/**
 * Script de test pour le pipeline config-sync
 *
 * Usage: node run-config-sync.js
 *
 * Ce script exécute:
 * 1. roosync_config(action: "collect", targets: ["mcp"])
 * 2. roosync_config(action: "publish", version: "2.7.1", description: "...")
 * 3. roosync_compare_config(granularity: "mcp")
 */

// Charger les variables d'environnement depuis .env
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '../../.env') });

import { getRooSyncService } from '../../build/services/RooSyncService.js';
import { roosyncConfig } from '../../build/tools/roosync/config.js';
import { roosyncCompareConfig } from '../../build/tools/roosync/compare-config.js';

// Couleurs console
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(emoji, color, message) {
  console.log(`${emoji} ${color}${message}${colors.reset}`);
}

function logSection(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${colors.cyan}${title}${colors.reset}`);
  console.log('='.repeat(70));
}

async function runConfigSyncPipeline() {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${colors.cyan}CONFIG-SYNC PIPELINE${colors.reset}`);
  console.log('═'.repeat(70));

  const version = '2.7.1';
  const description = 'Fix jupyter-mcp enablement on web1';

  try {
    // Step 1: Collect configuration
    logSection('Step 1: Collecting MCP configuration');

    const collectResult = await roosyncConfig({
      action: 'collect',
      targets: ['mcp']
    });

    if (collectResult.status === 'success') {
      log('✓', colors.green, `Configuration collected: ${collectResult.filesCount} files`);
      log('ℹ', colors.gray, `  Package path: ${collectResult.packagePath}`);
      log('ℹ', colors.gray, `  Total size: ${collectResult.totalSize} bytes`);
    } else {
      throw new Error('Collect failed');
    }

    // Step 2: Publish configuration
    logSection('Step 2: Publishing configuration');

    const publishResult = await roosyncConfig({
      action: 'publish',
      version: version,
      description: description,
      targets: ['mcp']
    });

    if (publishResult.status === 'success') {
      log('✓', colors.green, `Configuration published as version ${publishResult.version}`);
      log('ℹ', colors.gray, `  Machine: ${publishResult.machineId}`);
      log('ℹ', colors.gray, `  Path: ${publishResult.targetPath}`);
    } else {
      throw new Error('Publish failed');
    }

    // Step 3: Compare configuration
    logSection('Step 3: Comparing MCP configuration');

    const compareResult = await roosyncCompareConfig({
      granularity: 'mcp',
      filter: 'jupyter'  // Filter to see jupyter-mcp changes
    });

    log('ℹ', colors.blue, `Source: ${compareResult.source}`);
    log('ℹ', colors.blue, `Target: ${compareResult.target}`);
    log('ℹ', colors.blue, `Total differences: ${compareResult.summary.total}`);

    if (compareResult.differences.length > 0) {
      log('', colors.yellow, '\nDifferences found:');
      for (const diff of compareResult.differences) {
        const severityColor = diff.severity === 'CRITICAL' ? colors.red :
                             diff.severity === 'IMPORTANT' ? colors.yellow :
                             diff.severity === 'WARNING' ? colors.yellow : colors.gray;
        log(`  [${diff.severity}]`, severityColor, diff.path);
        log(`    ${colors.gray}${diff.description}${colors.reset}`);
        if (diff.action) {
          log(`    ${colors.cyan}Action: ${diff.action}${colors.reset}`);
        }
      }
    } else {
      log('✓', colors.green, 'No differences found - configurations are in sync');
    }

    // Summary
    logSection('Pipeline Summary');
    log('✓', colors.green, 'All steps completed successfully');
    log('ℹ', colors.cyan, `\nNext steps:`);
    log('  1.', colors.white, `Configuration ${version} has been published to GDrive`);
    log('  2.', colors.white, `web1 can now apply this config with:`);
    log('     ', colors.gray, `roosync_config(action: "apply", version: "${version}")`);

    return true;
  } catch (error) {
    log('✗', colors.red, `Pipeline failed: ${error.message}`);
    console.error(error);
    return false;
  }
}

// Run the pipeline
runConfigSyncPipeline()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
