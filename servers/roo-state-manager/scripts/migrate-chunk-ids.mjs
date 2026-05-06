#!/usr/bin/env node
/**
 * #2018 Phase 1bis: Migrate Qdrant chunk IDs from random UUIDs to deterministic UUIDs
 *
 * Scrolls all points in the collection with vectors, recomputes deterministic IDs
 * using the computeChunkId algorithm, upserts new points, and deletes old ones.
 *
 * ZERO embedding API calls — vectors are preserved as-is.
 * Idempotent — skips points where new_id == old_id.
 * Resumable — saves progress to migration-state.json after each batch.
 *
 * Usage:
 *   node scripts/migrate-chunk-ids.mjs [--dry-run] [--batch-size N] [--source-filter VALUE]
 *                                      [--max-points N] [--max-minutes N] [--resume] [--pause-ms N]
 *
 * Requires: QDRANT_URL and QDRANT_API_KEY in .env or environment
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import { v5 as uuidv5 } from 'uuid';

// Load .env from roo-state-manager root
config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });

const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const STATE_FILE = new URL('./migration-chunk-ids-state.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = getArg('--collection') || process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = getArg('--batch-size') ? parseInt(getArg('--batch-size')) : 100;
const SOURCE_FILTER = getArg('--source-filter') || null;
const MAX_POINTS = getArg('--max-points') ? parseInt(getArg('--max-points')) : Infinity;
const MAX_MINUTES = getArg('--max-minutes') ? parseInt(getArg('--max-minutes')) : Infinity;
const RESUME = process.argv.includes('--resume');
const PAUSE_MS = getArg('--pause-ms') ? parseInt(getArg('--pause-ms')) : 100;

if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.error('Missing QDRANT_URL or QDRANT_API_KEY. Set them in .env or environment.');
    process.exit(1);
}

console.log('=== Qdrant Chunk ID Migration (Phase 1bis) ===');
console.log(`Collection: ${COLLECTION}`);
console.log(`Qdrant URL: ${QDRANT_URL}`);
console.log(`Batch size: ${BATCH_SIZE}`);
console.log(`Source filter: ${SOURCE_FILTER || 'none'}`);
console.log(`Max points: ${MAX_POINTS === Infinity ? 'unlimited' : MAX_POINTS}`);
console.log(`Max minutes: ${MAX_MINUTES === Infinity ? 'unlimited' : MAX_MINUTES}`);
console.log(`Pause between batches: ${PAUSE_MS}ms`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
console.log(`Resume: ${RESUME}`);
console.log('');

const client = new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
    port: 443,
    timeout: 300000, // 5 min timeout for large vector batches
});

function getArg(name) {
    const idx = process.argv.indexOf(name);
    if (idx === -1 || idx + 1 >= process.argv.length) return null;
    return process.argv[idx + 1];
}

function computeDeterministicId(taskId, chunkType, sequenceOrder, content) {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const seed = `${taskId}|${chunkType}|seq:${sequenceOrder}|${contentHash}`;
    return uuidv5(seed, UUID_NAMESPACE);
}

function loadState() {
    if (!RESUME) return null;
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch (err) {
        console.warn(`Could not load state file: ${err.message}`);
    }
    return null;
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function migrate() {
    const startTime = Date.now();
    const savedState = loadState();

    // Get collection info
    const info = await client.getCollection(COLLECTION);
    console.log(`Collection points: ${info.points_count.toLocaleString()}`);
    console.log(`Collection status: ${info.status}`);
    console.log('');

    let offset = savedState?.last_offset || null;
    let totalScanned = savedState?.scanned || 0;
    let totalSkipped = savedState?.skipped || 0;
    let totalMigrated = savedState?.migrated || 0;
    let totalErrors = savedState?.errors || 0;
    let batchNum = savedState?.batch_num || 0;

    if (savedState) {
        console.log(`Resuming from batch ${batchNum}, offset: ${offset || 'start'}`);
        console.log(`Previous progress: scanned=${totalScanned.toLocaleString()}, migrated=${totalMigrated.toLocaleString()}, skipped=${totalSkipped.toLocaleString()}, errors=${totalErrors}`);
        console.log('');
    }

    const scrollFilter = SOURCE_FILTER
        ? { must: [{ key: 'source', match: { value: SOURCE_FILTER } }] }
        : undefined;

    while (true) {
        const elapsed = (Date.now() - startTime) / 60000;
        if (elapsed >= MAX_MINUTES) {
            console.log(`\nTime limit reached (${MAX_MINUTES} min). Saving state for resume.`);
            break;
        }
        if (totalScanned >= MAX_POINTS) {
            console.log(`\nPoint limit reached (${MAX_POINTS}). Saving state for resume.`);
            break;
        }

        batchNum++;
        let scrollResult;

        // Scroll with retry
        for (let retry = 0; retry < 3; retry++) {
            try {
                scrollResult = await client.scroll(COLLECTION, {
                    limit: BATCH_SIZE,
                    offset: offset || undefined,
                    with_payload: true,
                    with_vector: true,
                    filter: scrollFilter,
                });
                break;
            } catch (err) {
                console.error(`  Scroll error batch ${batchNum} (attempt ${retry + 1}/3): ${err.message}`);
                if (retry === 2) throw err;
                await new Promise(r => setTimeout(r, 10000 * (retry + 1)));
            }
        }

        const points = scrollResult.points;
        if (!points || points.length === 0) {
            console.log('\nNo more points to process.');
            break;
        }

        const upserts = [];
        const deletes = [];

        for (const point of points) {
            totalScanned++;
            const payload = point.payload || {};

            // Skip points missing required fields for ID computation
            if (!payload.task_id || payload.sequence_order == null || !payload.chunk_type || !payload.content) {
                totalSkipped++;
                continue;
            }

            // Compute deterministic ID
            const newId = computeDeterministicId(
                payload.task_id,
                payload.chunk_type,
                payload.sequence_order,
                payload.content
            );

            // Skip if already migrated
            if (newId === point.id) {
                totalSkipped++;
                continue;
            }

            // Build new payload with contentHash if missing
            const contentHash = crypto.createHash('sha256').update(payload.content).digest('hex').slice(0, 16);
            const newPayload = { ...payload, contentHash };

            upserts.push({
                id: newId,
                vector: point.vector,
                payload: newPayload,
            });
            deletes.push(point.id);
        }

        // Apply batch
        if (upserts.length > 0 && !DRY_RUN) {
            try {
                // Upsert new points first
                await client.upsert(COLLECTION, {
                    points: upserts,
                    wait: false, // Async for performance
                });

                // Then delete old points
                await client.delete(COLLECTION, {
                    points: deletes,
                    wait: false,
                });

                totalMigrated += upserts.length;
            } catch (err) {
                totalErrors += upserts.length;
                console.error(`  Batch ${batchNum} error: ${err.message}`);
            }
        } else if (upserts.length > 0 && DRY_RUN) {
            totalMigrated += upserts.length;
        }

        // Save state after each batch
        const state = {
            last_offset: scrollResult.next_page_offset,
            scanned: totalScanned,
            skipped: totalSkipped,
            migrated: totalMigrated,
            errors: totalErrors,
            batch_num: batchNum,
            last_updated: new Date().toISOString(),
        };
        saveState(state);

        // Progress log every 10 batches
        if (batchNum % 10 === 0) {
            const rate = totalScanned / ((Date.now() - startTime) / 1000);
            console.log(`  Batch ${batchNum}: scanned=${totalScanned.toLocaleString()}, migrated=${totalMigrated.toLocaleString()}, skipped=${totalSkipped.toLocaleString()}, errors=${totalErrors}, rate=${rate.toFixed(1)}/s`);
        }

        offset = scrollResult.next_page_offset;
        if (!offset) {
            console.log('\nReached end of collection.');
            break;
        }

        // Pause between batches
        if (PAUSE_MS > 0) {
            await new Promise(r => setTimeout(r, PAUSE_MS));
        }
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    console.log('=== Migration Summary ===');
    console.log(`Total scanned: ${totalScanned.toLocaleString()}`);
    console.log(`Migrated (new ID): ${totalMigrated.toLocaleString()}`);
    console.log(`Skipped (already OK or missing fields): ${totalSkipped.toLocaleString()}`);
    console.log(`Errors: ${totalErrors}`);
    console.log(`Batches processed: ${batchNum}`);
    console.log(`Elapsed: ${totalElapsed}s`);
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

    if (DRY_RUN && totalMigrated > 0) {
        console.log('\nThis was a dry run. To apply changes, run without --dry-run.');
    }

    if (offset) {
        console.log(`\nState saved. Resume with --resume to continue from batch ${batchNum}.`);
    } else {
        // Clean up state file on completion
        try { fs.unlinkSync(STATE_FILE); } catch {}
        console.log('\nMigration complete. State file cleaned up.');
    }
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
