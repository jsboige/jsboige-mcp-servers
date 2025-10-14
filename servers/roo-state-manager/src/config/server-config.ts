/**
 * Configuration du serveur MCP roo-state-manager
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Lecture du package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

// Constantes de configuration
export const MAX_OUTPUT_LENGTH = 300000; // Smart Truncation Engine
export const SKELETON_CACHE_DIR_NAME = '.skeletons';

/**
 * Configuration du serveur MCP
 */
export const SERVER_CONFIG = {
    name: 'roo-state-manager',
    version: packageJson.version,
};

/**
 * Configuration des capabilities MCP
 */
export const SERVER_CAPABILITIES = {
    capabilities: {
        tools: {},
    },
};

/**
 * Variables d'environnement requises
 */
export const REQUIRED_ENV_VARS = [
    'QDRANT_URL',
    'QDRANT_API_KEY',
    'QDRANT_COLLECTION_NAME',
    'OPENAI_API_KEY'
];

/**
 * Configuration LLM par défaut
 */
export const DEFAULT_LLM_OPTIONS = {
    models: [{
        modelId: 'gpt-4',
        displayName: 'GPT-4',
        provider: 'openai' as const,
        modelName: 'gpt-4',
        maxTokens: 8192,
        costPerInputToken: 0.00003,
        costPerOutputToken: 0.00006,
        parameters: { temperature: 0.7 }
    }],
    defaultModelId: 'gpt-4',
    defaultTimeout: 30000,
    maxRetries: 3,
    retryDelay: 1000,
    enableCaching: true
};

/**
 * Configuration contexte par défaut
 */
export const DEFAULT_CONTEXT_OPTIONS = {
    synthesisBaseDir: './synthesis',
    condensedBatchesDir: './synthesis/batches',
    maxContextSizeBeforeCondensation: 100000,
    defaultMaxDepth: 5
};

/**
 * Configuration orchestrateur par défaut
 */
export const DEFAULT_ORCHESTRATOR_OPTIONS = {
    synthesisOutputDir: './synthesis/output',
    maxContextSize: 150000,
    maxConcurrency: 3,
    defaultLlmModel: 'gpt-4'
};

/**
 * Configuration cache et indexation
 */
export const CACHE_CONFIG = {
    CONSISTENCY_CHECK_INTERVAL: 24 * 60 * 60 * 1000, // 24h
    MIN_REINDEX_INTERVAL: 4 * 60 * 60 * 1000, // 4h
    MAX_BACKGROUND_INTERVAL: 5 * 60 * 1000, // 5min
};