/**
 * Diagnostic de l'index sémantique Qdrant
 *
 * #1244 — Extended diagnostics:
 *  - Embedding dimension match (collection vs vLLM live test)
 *  - Payload sample (detect missing fields)
 *  - Source distribution (roo / claude-code / unknown)
 *  - Workspace distribution (top N workspace_name)
 *  - Payload field coverage on a sampled slice
 *
 * Backward compatible: callers passing only `conversationCache` get the same
 * baseline diagnostics as before. Deep diagnostics opt-in via `options.deep`.
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getQdrantClient } from '../../services/qdrant.js';
import getOpenAIClient, { getEmbeddingModel } from '../../services/openai.js';

// #1275: Cache embedding connectivity check to avoid consuming API credits on every diagnose call.
// TTL: 5 minutes (same as circuit breaker pattern).
let lastConnectivityCheck = { time: 0, dimension: undefined as number | undefined, status: '' as string, errorType: undefined as string | undefined };
const CONNECTIVITY_CACHE_TTL_MS = parseInt(process.env.DIAGNOSE_CONNECTIVITY_TTL_MS || '300000');

/**
 * Reset the connectivity cache state (for testing).
 * @internal
 */
export function _resetConnectivityCache(): void {
    lastConnectivityCheck = { time: 0, dimension: undefined, status: '', errorType: undefined };
}

/**
 * #2766 — Classify an embedding-backend error into a TYPED status.
 *
 * Previously diagnose-index collapsed EVERY embedding error to a blanket `failed`,
 * which fed a false-positive key-rotation loop (coordinator could not tell
 * auth_401 from network_timeout/service_503/conn_refused). This classifier keeps
 * the raw error in `diagnostics.errors` (unchanged) AND emits a typed
 * `openai_error_type` so consumers can branch on the root cause.
 *
 * Typed statuses: `auth_401` | `network_timeout` | `service_503` | `conn_refused` | `unknown`.
 *
 * Strategy: STRICT phases by descending signal reliability (Hermes/po-2026 review):
 *   Phase A — structural HTTP `.status` (most reliable; OpenAI SDK v4 APIError).
 *   Phase B — structural error `.code` / `.cause.code` (Node network errno).
 *   Phase C — message-substring LAST RESORT (text keywords only — no bare numbers).
 *
 * Why separate phases (not one mixed OR): a 503 with "unauthorized" in its body must
 * classify as service_503 (the status is authoritative), not auth_401. Mixing the
 * structural status check with substring keywords in one `if` (v1) let the substring
 * short-circuit before the service branch — fixed by checking ALL structural signals
 * before ANY substring. Bare numeric substrings ('401'/'503') are excluded (v1 false
 * positive: "request took 4014ms" → auth_401); only specific text keywords remain.
 *
 * @internal — exported only for unit tests.
 */
export function _classifyOpenAIError(err: any): 'auth_401' | 'network_timeout' | 'service_503' | 'conn_refused' | 'unknown' {
    const status = err?.status;
    const code = err?.code ?? err?.cause?.code;
    const msg = String(err?.message ?? '').toLowerCase();

    // Phase A — structural HTTP status (authoritative; checked before any substring).
    if (status === 401 || status === 403) {
        return 'auth_401';
    }
    if (typeof status === 'number' && status >= 500) {
        return 'service_503';
    }

    // Phase B — structural error code (Node network errno / SDK code).
    if (code === 'invalid_api_key') {
        return 'auth_401';
    }
    if (code === 'ECONNREFUSED') {
        return 'conn_refused';
    }
    if (code === 'ETIMEDOUT') {
        return 'network_timeout';
    }

    // Phase C — message-substring fallback (last resort, text keywords only — no bare numbers).
    // Justified: HTTP/network errors where the message is frequently all a client has
    // (NOT PowerShell-wrapped exceptions, where InnerException typing is the reliable signal).
    if (msg.includes('incorrect api key') ||
        msg.includes('invalid api key') ||
        msg.includes('unauthorized') ||
        msg.includes('authentication failed') ||
        msg.includes('authentication error')) {
        return 'auth_401';
    }
    if (msg.includes('service unavailable')) {
        return 'service_503';
    }
    if (msg.includes('econnrefused') ||
        msg.includes('connection refused')) {
        return 'conn_refused';
    }
    if (msg.includes('etimedout') ||
        msg.includes('timed out') ||
        msg.includes('timeout') ||
        msg.includes('exit code 28')) {
        return 'network_timeout';
    }
    return 'unknown';
}

/**
 * Options for the diagnose tool. All optional — preserves backward compatibility.
 */
export interface DiagnoseIndexOptions {
    /** Enable deep diagnostics (scroll sample, source/workspace distribution). Default: false. */
    deep?: boolean;
    /** Sample size for scroll-based stats. Default: 1000 points. */
    sample_size?: number;
    /** Number of top workspace_name values to report. Default: 20. */
    top_n_workspaces?: number;
}

interface PayloadSample {
    id: string | number;
    payload_keys: string[];
    workspace_name?: string;
    source?: string;
    chunk_type?: string;
    timestamp?: string;
}

/**
 * Diagnostique l'état de l'index sémantique
 *
 * @param conversationCache Cache des squelettes (passé pour cohérence avec les autres handlers)
 * @param options Options de diagnostic. Si `deep: true`, exécute scroll + agrégations.
 */
export async function handleDiagnoseSemanticIndex(
    conversationCache: Map<string, ConversationSkeleton>,
    options: DiagnoseIndexOptions = {}
): Promise<CallToolResult> {
    const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
    const deep = options.deep === true;
    const sampleSize = Math.max(1, Math.min(options.sample_size ?? 1000, 5000));
    const topNWorkspaces = Math.max(1, Math.min(options.top_n_workspaces ?? 20, 100));

    const diagnostics: any = {
        timestamp: new Date().toISOString(),
        collection_name: collectionName,
        status: 'unknown',
        errors: [],
        details: {},
    };

    let collectionDimension: number | undefined;

    try {
        // Test de connectivité à Qdrant
        const qdrant = getQdrantClient();
        diagnostics.details.qdrant_connection = 'success';

        // Vérifier si la collection existe en listant toutes les collections
        let collections;
        let getCollectionsSucceeded = false;
        try {
            collections = await qdrant.getCollections();
            getCollectionsSucceeded = true;
        } catch (listError: any) {
            // getCollections a échoué → problème de connexion
            diagnostics.status = 'connection_failed';
            diagnostics.details.qdrant_connection = 'failed';
            diagnostics.errors.push(`Impossible de se connecter à Qdrant: ${listError.message}`);
            // Continue to collect OpenAI and environment info despite Qdrant failure
            collections = null; // Mark as failed but don't return early
        }

        const collection = collections?.collections?.find(c => c.name === collectionName);

        // Debug: log collection search results
        console.log('[DEBUG] collectionName:', collectionName);
        console.log('[DEBUG] collections:', collections);
        console.log('[DEBUG] found collection:', collection);

        if (collection) {
            diagnostics.details.collection_exists = true;

            // Obtenir des informations sur la collection
            try {
                const collectionInfo = await qdrant.getCollection(collectionName);
                const dimVal = (collectionInfo.config?.params?.vectors as any)?.size;
                collectionDimension = typeof dimVal === 'number' ? dimVal : undefined;

                diagnostics.details.collection_info = {
                    vectors_count: (collectionInfo as any).vectors_count,
                    indexed_vectors_count: collectionInfo.indexed_vectors_count || 0,
                    points_count: collectionInfo.points_count,
                    config: {
                        distance: (collectionInfo.config?.params?.vectors as any)?.distance || 'unknown',
                        size: dimVal ?? 'unknown',
                    },
                };

                if (collectionInfo.points_count === 0) {
                    diagnostics.status = 'empty_collection';
                    diagnostics.errors.push('La collection existe mais ne contient aucun point indexé');
                } else {
                    diagnostics.status = 'healthy';
                }
            } catch (collectionInfoError: any) {
                diagnostics.errors.push(`Erreur lors de l'accès à la collection: ${collectionInfoError.message}`);
                // #3217 — getCollection() triggers an exhaustive point count that can
                // exceed the client timeout on large collections ("This operation was
                // aborted"), reporting collection_error for a collection a real search
                // traverses in under a second. Ground truth before declaring error:
                // probe with a bounded read (scroll limit 1 — no vector, so no
                // dependency on the embedding backend).
                try {
                    await qdrant.scroll(collectionName, { limit: 1, with_payload: false, with_vector: false });
                    diagnostics.status = 'degraded';
                    diagnostics.details.collection_probe = 'readable';
                    diagnostics.errors.push(
                        'Statut rétrogradé collection_error→degraded : lecture de test réussie — ' +
                        "seul l'appel de métadonnées (comptage exhaustif) a échoué, la collection reste accessible."
                    );
                } catch (probeError: any) {
                    diagnostics.status = 'collection_error';
                    diagnostics.details.collection_probe = 'unreadable';
                    diagnostics.errors.push(`Lecture de test échouée: ${probeError.message}`);
                }
            }
        } else if (getCollectionsSucceeded) {
            // Only set missing_collection if getCollections succeeded but collection wasn't found
            diagnostics.details.collection_exists = false;
            diagnostics.status = 'missing_collection';
            diagnostics.errors.push(`La collection '${collectionName}' n'existe pas dans Qdrant`);
        }

    } catch (connectionError: any) {
        diagnostics.status = 'connection_failed';
        diagnostics.details.qdrant_connection = 'failed';
        diagnostics.errors.push(`Impossible de se connecter à Qdrant: ${connectionError.message}`);
    }

    // Test de connectivité à OpenAI/vLLM (always run, even if Qdrant fails)
    // #1244: capture the actual returned dimension to compare with collection dimension
    let embeddingLiveDimension: number | undefined;
    const now = Date.now();
    if (lastConnectivityCheck.time && (now - lastConnectivityCheck.time) < CONNECTIVITY_CACHE_TTL_MS) {
        // Use cached result
        embeddingLiveDimension = lastConnectivityCheck.dimension;
        diagnostics.details.openai_connection = lastConnectivityCheck.status;
        diagnostics.details.embedding_live_dimension = embeddingLiveDimension;
        diagnostics.details.openai_connectivity_cached = true;
        // #2766: replay the cached typed error so a cached failure still carries its root cause.
        if (lastConnectivityCheck.errorType) {
            diagnostics.details.openai_error_type = lastConnectivityCheck.errorType;
        }
    } else {
        try {
            const openai = getOpenAIClient();
            const testEmbedding = await openai.embeddings.create({
                model: getEmbeddingModel(),
                input: 'test connectivity',
            });
            const embeddingLength = testEmbedding.data[0].embedding.length;
            embeddingLiveDimension = embeddingLength;
            const status = embeddingLength > 0 ? 'success' : 'failed';
            diagnostics.details.openai_connection = status;
            diagnostics.details.embedding_live_dimension = embeddingLength;
            // Cache the result
            lastConnectivityCheck = { time: now, dimension: embeddingLength, status, errorType: undefined };
        } catch (openaiError: any) {
            // #2766: classify the root cause instead of collapsing every error to a blanket 'failed'.
            // Raw error stays in diagnostics.errors (unchanged); the typed root cause is added below.
            const errorType = _classifyOpenAIError(openaiError);
            diagnostics.errors.push(`Erreur OpenAI: ${openaiError.message}`);
            diagnostics.details.openai_connection = 'failed';
            diagnostics.details.openai_error_type = errorType;
            lastConnectivityCheck = { time: now, dimension: undefined, status: 'failed', errorType };
        }
    }

    // #1244: Dimension mismatch detection (Hypothesis A from plan)
    const expectedDimensionEnv = process.env.EMBEDDING_DIMENSIONS
        ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
        : undefined;
    if (collectionDimension !== undefined) {
        diagnostics.details.dimension_check = {
            collection_dimension: collectionDimension,
            embedding_env_dimension: expectedDimensionEnv,
            embedding_live_dimension: embeddingLiveDimension,
            collection_matches_env: expectedDimensionEnv !== undefined
                ? collectionDimension === expectedDimensionEnv
                : null,
            collection_matches_live: embeddingLiveDimension !== undefined
                ? collectionDimension === embeddingLiveDimension
                : null,
        };

        if (embeddingLiveDimension !== undefined && collectionDimension !== embeddingLiveDimension) {
            diagnostics.errors.push(
                `Dimension mismatch: collection=${collectionDimension}, embedding live=${embeddingLiveDimension}. ` +
                `Searches will return 0 results until the index is rebuilt with matching dimensions.`
            );
        }
        if (expectedDimensionEnv !== undefined && collectionDimension !== expectedDimensionEnv) {
            diagnostics.errors.push(
                `Dimension drift: collection=${collectionDimension}, EMBEDDING_DIMENSIONS env=${expectedDimensionEnv}. ` +
                `One of the two is stale.`
            );
        }
    }

    // Vérifier les variables d'environnement nécessaires (always run, even if Qdrant fails)
    const envVars = {
        QDRANT_URL: !!process.env.QDRANT_URL,
        QDRANT_API_KEY: !!process.env.QDRANT_API_KEY,
        QDRANT_COLLECTION_NAME: !!process.env.QDRANT_COLLECTION_NAME,
        EMBEDDING_API_KEY: !!process.env.EMBEDDING_API_KEY,
        EMBEDDING_API_BASE_URL: !!process.env.EMBEDDING_API_BASE_URL,
        EMBEDDING_MODEL: !!process.env.EMBEDDING_MODEL,
        EMBEDDING_DIMENSIONS: !!process.env.EMBEDDING_DIMENSIONS,
    };
    diagnostics.details.environment_variables = envVars;

    const missingEnvVars = Object.entries(envVars)
        .filter(([, exists]) => !exists)
        .map(([varName]) => varName);

    if (missingEnvVars.length > 0) {
        diagnostics.errors.push(`Variables d'environnement manquantes: ${missingEnvVars.join(', ')}`);
    }

    // #1244: Deep diagnostics — scroll a sample, aggregate by source/workspace_name, detect field coverage
    if (deep && diagnostics.status === 'healthy') {
        try {
            const qdrant = getQdrantClient();

            const scrollResult: any = await qdrant.scroll(collectionName, {
                limit: sampleSize,
                with_payload: true,
                with_vector: false,
            });

            const points: any[] = Array.isArray(scrollResult)
                ? scrollResult
                : (scrollResult?.points || scrollResult?.result?.points || []);

            const sourceCounts: Record<string, number> = {};
            const workspaceCounts: Record<string, number> = {};
            const fieldPresence: Record<string, number> = {};
            const samples: PayloadSample[] = [];

            for (const point of points) {
                const payload = point?.payload || {};

                // source distribution
                const src = (payload.source ?? '__unknown__') as string;
                sourceCounts[src] = (sourceCounts[src] || 0) + 1;

                // workspace_name distribution
                const ws = payload.workspace_name;
                if (typeof ws === 'string' && ws.length > 0) {
                    workspaceCounts[ws] = (workspaceCounts[ws] || 0) + 1;
                } else {
                    workspaceCounts['__missing__'] = (workspaceCounts['__missing__'] || 0) + 1;
                }

                // field coverage — count payloads where each essential field is populated
                for (const f of ['task_id', 'workspace', 'workspace_name', 'source', 'timestamp', 'chunk_type', 'role', 'host_os', 'task_title', 'model']) {
                    if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') {
                        fieldPresence[f] = (fieldPresence[f] || 0) + 1;
                    }
                }

                // sample first 5
                if (samples.length < 5) {
                    samples.push({
                        id: point.id,
                        payload_keys: Object.keys(payload).sort(),
                        workspace_name: payload.workspace_name,
                        source: payload.source,
                        chunk_type: payload.chunk_type,
                        timestamp: payload.timestamp,
                    });
                }
            }

            const sampledCount = points.length;
            const sortedWorkspaces = Object.entries(workspaceCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, topNWorkspaces)
                .map(([name, count]) => ({ name, count, pct: sampledCount > 0 ? +(count / sampledCount * 100).toFixed(1) : 0 }));

            const fieldCoveragePct: Record<string, number> = {};
            for (const [f, count] of Object.entries(fieldPresence)) {
                fieldCoveragePct[f] = sampledCount > 0 ? +(count / sampledCount * 100).toFixed(1) : 0;
            }

            diagnostics.details.deep_diagnostics = {
                sample_size_requested: sampleSize,
                sample_size_actual: sampledCount,
                source_distribution: sourceCounts,
                workspace_distribution_top: sortedWorkspaces,
                workspace_distribution_distinct: Object.keys(workspaceCounts).filter(k => k !== '__missing__').length,
                field_coverage_pct: fieldCoveragePct,
                payload_samples: samples,
            };

            // #1244: Hypothesis B / D — detect critical field gaps
            if ((fieldCoveragePct.workspace_name ?? 0) < 50) {
                diagnostics.errors.push(
                    `workspace_name populated in only ${fieldCoveragePct.workspace_name ?? 0}% of sampled points. ` +
                    `Filter by workspace_name will return few/no results.`
                );
            }
            if ((fieldCoveragePct.timestamp ?? 0) < 50) {
                diagnostics.errors.push(
                    `timestamp populated in only ${fieldCoveragePct.timestamp ?? 0}% of sampled points. ` +
                    `Date range filters will be unreliable.`
                );
            }
        } catch (deepError: any) {
            diagnostics.errors.push(`Deep diagnostics failed: ${deepError.message}`);
            diagnostics.details.deep_diagnostics = { error: deepError.message };
        }
    }

    // #2547: Downgrade status if embedding backend is unreachable.
    // Previously, status could be "healthy" (Qdrant OK) while openai_connection was "failed",
    // masking a complete indexing/search outage from health checkers.
    if (diagnostics.status === 'healthy' && diagnostics.details.openai_connection === 'failed') {
        diagnostics.status = 'degraded';
        diagnostics.errors.push(
            'Embedding backend unreachable — status downgraded from healthy to degraded. ' +
            'Indexing and semantic search will fail until embedding service is restored.'
        );
    }

    // Recommandations basées sur le diagnostic
    const recommendations: string[] = [];
    if (diagnostics.status === 'missing_collection') {
        recommendations.push('Utilisez l\'outil rebuild_task_index pour créer et peupler la collection');
    }
    if (diagnostics.status === 'empty_collection') {
        recommendations.push('La collection existe mais est vide. Lancez rebuild_task_index pour l\'indexer');
    }
    if (diagnostics.status === 'collection_error') {
        recommendations.push(
            'La collection est réellement inaccessible (lecture de test échouée). ' +
            "Vérifiez l'état du service Qdrant (logs, redémarrage) ; si la collection est corrompue, " +
            'roosync_indexing action=reset puis rebuild_task_index.'
        );
    }
    if (diagnostics.details.collection_probe === 'readable') {
        recommendations.push(
            "L'appel de métadonnées (comptage exhaustif des points) a échoué, mais une lecture réelle " +
            'réussit — la recherche sémantique reste opérationnelle, aucune action requise sur la collection.'
        );
    }
    if (diagnostics.details.openai_connection === 'failed') {
        // #2766: route the recommendation by root cause to kill the false-positive
        // key-rotation loop. A typed status that nothing consumes is cosmetic — this
        // routing is what stops an agent from rotating the key on a network/service failure.
        const errorType = diagnostics.details.openai_error_type as string | undefined;
        if (errorType === 'network_timeout') {
            recommendations.push(
                'Timeout atteint vers le backend d\'embedding (ETIMEDOUT / exit 28). ' +
                'Vérifiez EMBEDDING_API_BASE_URL, la latence réseau et la disponibilité du service vLLM. ' +
                'NE PAS faire de rotation de la clé (cause réseau, pas auth).'
            );
        } else if (errorType === 'service_503') {
            recommendations.push(
                'Backend d\'embedding indisponible (HTTP 503). ' +
                'Vérifiez le service vLLM/proxy (redémarrage, charge, health endpoint). ' +
                'NE PAS faire de rotation de la clé (cause service, pas auth).'
            );
        } else if (errorType === 'conn_refused') {
            recommendations.push(
                'Connexion refusée (ECONNREFUSED) vers le backend d\'embedding. ' +
                'Vérifiez que le service écoute sur EMBEDDING_API_BASE_URL (hôte/port). ' +
                'NE PAS faire de rotation de la clé (cause port fermé, pas auth).'
            );
        } else {
            // auth_401 (genuine credential issue) OR unknown — check the key (pre-fix behaviour).
            recommendations.push('Vérifiez EMBEDDING_API_KEY et EMBEDDING_API_BASE_URL dans .env (self-hosted vLLM)');
        }
    }
    if (diagnostics.details.qdrant_connection === 'failed') {
        recommendations.push('Vérifiez la configuration Qdrant (URL, clé API, connectivité réseau)');
    }
    if (diagnostics.details.dimension_check?.collection_matches_live === false) {
        recommendations.push(
            'Dimension mismatch détectée. Reset la collection Qdrant ' +
            '(roosync_indexing action=reset) puis rebuild avec rebuild_task_index.'
        );
    }
    if (deep && diagnostics.details.deep_diagnostics && !diagnostics.details.deep_diagnostics.error) {
        const dd = diagnostics.details.deep_diagnostics;
        if ((dd.field_coverage_pct?.workspace_name ?? 0) < 50) {
            recommendations.push(
                'workspace_name peu populé. Vérifiez ChunkExtractor.ts ' +
                '(populate workspace_name = path.basename(workspace) systématiquement).'
            );
        }
        if (dd.source_distribution && (dd.source_distribution['__unknown__'] ?? 0) > sampleSize * 0.5) {
            recommendations.push(
                'Beaucoup de points sans champ `source`. Le ChunkExtractor Roo ne le fixe pas — ' +
                'à corriger pour permettre le filtrage source=roo vs source=claude-code.'
            );
        }
    }
    diagnostics.recommendations = recommendations;

    // Discoverability hint (not a recommendation — kept separate to preserve "healthy = 0 recommendations" contract)
    if (!deep && diagnostics.status === 'healthy') {
        diagnostics.info = [
            'Pour un diagnostic approfondi (sample payloads, distribution source/workspace), passez deep=true.'
        ];
    }

    return {
        content: [{
            type: 'text',
            text: JSON.stringify(diagnostics, null, 2)
        }]
    };
}
