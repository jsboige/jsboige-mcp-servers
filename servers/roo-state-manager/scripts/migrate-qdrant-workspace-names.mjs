#!/usr/bin/env node
/**
 * #883: Populate workspace_name field in Qdrant from existing workspace paths
 *
 * Adds workspace_name (basename) to all points that have workspace (full path).
 * Does NOT modify the workspace field — both are kept.
 *
 * Before: { workspace: "d:/roo-extensions" }
 * After:  { workspace: "d:/roo-extensions", workspace_name: "roo-extensions" }
 *
 * Usage:
 *   node scripts/migrate-qdrant-workspace-names.mjs [--dry-run] [--collection NAME] [--batch-size N]
 *
 * Requires: QDRANT_URL and QDRANT_API_KEY in .env or environment
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import path from 'path';
import { config } from 'dotenv';

// Load .env from roo-state-manager root
config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = process.argv.includes('--collection')
    ? process.argv[process.argv.indexOf('--collection') + 1]
    : process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = process.argv.includes('--batch-size')
    ? parseInt(process.argv[process.argv.indexOf('--batch-size') + 1])
    : 100;

if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.error('Missing QDRANT_URL or QDRANT_API_KEY. Set them in .env or environment.');
    process.exit(1);
}

console.log(`=== Qdrant Workspace Migration ===`);
console.log(`Collection: ${COLLECTION}`);
console.log(`Qdrant URL: ${QDRANT_URL}`);
console.log(`Batch size: ${BATCH_SIZE}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
console.log('');

const client = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
    port: 443,
    timeout: 120000, // 2 min timeout for large collection scroll
});

/**
 * Check if a point needs workspace_name population
 * (has workspace but no workspace_name, or workspace_name differs from basename)
 */
function needsMigration(point) {
    const ws = point.payload?.workspace;
    const wsName = point.payload?.workspace_name;
    if (!ws) return false; // No workspace at all
    const expected = path.basename(ws);
    return wsName !== expected; // Missing or incorrect workspace_name
}

async function migrate() {
    // Get collection info
    const info = await client.getCollection(COLLECTION);
    console.log(`Collection points: ${info.points_count}`);
    console.log('');

    // First, get distinct workspace values to understand the data
    console.log('--- Scanning for workspace values that need migration ---');

    let offset = null;
    let totalScanned = 0;
    let totalToMigrate = 0;
    let totalMigrated = 0;
    let totalSkipped = 0;
    const workspaceMap = new Map(); // fullPath -> basename

    while (true) {
        let scrollResult;
        for (let retry = 0; retry < 3; retry++) {
            try {
                scrollResult = await client.scroll(COLLECTION, {
                    limit: BATCH_SIZE,
                    offset: offset,
                    with_payload: { include: ['workspace', 'workspace_name'] },
                    with_vector: false,
                });
                break;
            } catch (err) {
                console.error(`  Scroll error (attempt ${retry + 1}/3): ${err.message}`);
                if (retry === 2) throw err;
                await new Promise(r => setTimeout(r, 5000 * (retry + 1)));
            }
        }

        const points = scrollResult.points;
        if (!points || points.length === 0) break;

        const toUpdate = [];

        for (const point of points) {
            totalScanned++;

            if (needsMigration(point)) {
                const ws = point.payload.workspace;
                const basename = path.basename(ws);
                toUpdate.push({ id: point.id, workspace: ws, workspace_name: basename });

                if (!workspaceMap.has(ws)) {
                    workspaceMap.set(ws, basename);
                }
                totalToMigrate++;
            } else {
                totalSkipped++;
            }
        }

        // Apply updates for this batch — ADD workspace_name, keep workspace unchanged
        if (toUpdate.length > 0 && !DRY_RUN) {
            // Group by workspace_name for batch setPayload
            const byName = new Map();
            for (const p of toUpdate) {
                if (!byName.has(p.workspace_name)) {
                    byName.set(p.workspace_name, []);
                }
                byName.get(p.workspace_name).push(p.id);
            }

            for (const [wsName, ids] of byName) {
                await client.setPayload(COLLECTION, {
                    payload: { workspace_name: wsName },
                    points: ids,
                });
                totalMigrated += ids.length;
            }
        } else if (toUpdate.length > 0 && DRY_RUN) {
            totalMigrated += toUpdate.length;
        }

        // Progress
        if (totalScanned % (BATCH_SIZE * 10) === 0) {
            console.log(`  Scanned: ${totalScanned}, to migrate: ${totalToMigrate}, migrated: ${totalMigrated}`);
        }

        offset = scrollResult.next_page_offset;
        if (!offset) break;
    }

    console.log('');
    console.log('=== Migration Summary ===');
    console.log(`Total scanned: ${totalScanned}`);
    console.log(`Already basename: ${totalSkipped}`);
    console.log(`Needed migration: ${totalToMigrate}`);
    console.log(`${DRY_RUN ? 'Would migrate' : 'Migrated'}: ${totalMigrated}`);
    console.log('');
    console.log('Workspace mappings (workspace → workspace_name):');
    for (const [fullPath, basename] of workspaceMap) {
        console.log(`  "${fullPath}" → "${basename}"`);
    }

    if (DRY_RUN && totalToMigrate > 0) {
        console.log('');
        console.log('This was a dry run. To apply changes, run without --dry-run');
    }
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
