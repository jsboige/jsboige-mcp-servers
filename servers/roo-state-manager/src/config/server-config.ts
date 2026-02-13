/**
 * Configuration du serveur MCP roo-state-manager
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

export interface ServerConfig {
    name: string;
    version: string;
    capabilities: {
        tools: Record<string, boolean>;
        resources?: Record<string, boolean>;
    };
}

export const SERVER_CONFIG: ServerConfig = {
    name: 'roo-state-manager',
    version: packageJson.version,
    capabilities: {
        tools: {},
    },
};

// Constantes de configuration
export const CACHE_CONFIG = {
    MAX_CACHE_SIZE: 1000,
    CACHE_TTL_MS: 3600000, // 1 heure
    DEFAULT_WORKSPACE: process.env.WORKSPACE_PATH || process.cwd(),
};

export const INDEXING_CONFIG = {
    BATCH_SIZE: parseInt(process.env.INDEXING_BATCH_SIZE || '50', 10) || 50,
    MAX_CONCURRENT_REQUESTS: 5,
    get EMBEDDING_MODEL() { return process.env.EMBEDDING_MODEL || 'text-embedding-3-small'; },
};

export const OUTPUT_CONFIG = {
    MAX_OUTPUT_LENGTH: 300000, // Smart Truncation Engine
    SKELETON_CACHE_DIR_NAME: '.skeletons',
};

// Constantes pour la protection anti-fuite
export const ANTI_LEAK_CONFIG = {
    CONSISTENCY_CHECK_INTERVAL: 24 * 60 * 60 * 1000, // 24h
    MIN_REINDEX_INTERVAL: 4 * 60 * 60 * 1000, // 4h minimum entre indexations
    MAX_BACKGROUND_INTERVAL: 5 * 60 * 1000, // 5min au lieu de 30s
};

/**
 * Crée une instance du serveur MCP
 */
export function createMcpServer(config: ServerConfig): Server {
    return new Server(
        {
            name: config.name,
            version: config.version,
        },
        {
            capabilities: config.capabilities,
        }
    );
}