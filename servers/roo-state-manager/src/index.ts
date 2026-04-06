/**
 * Point d'entrée du serveur MCP roo-state-manager
 *
 * Ce fichier orchestre l'initialisation et le démarrage du serveur.
 * Toute la logique métier est dans src/tools/, src/services/, src/config/
 *
 * ARCHITECTURE STARTUP (#1140):
 * 1. Load dotenv + validate env vars (sync, fast)
 * 2. Import ONLY: server-config, registry, logger (minimal deps)
 * 3. Create server + register handlers + connect transport ASAP
 * 4. Heavy imports (StateManager, Notifications, Background) load in background
 */
// FIX #373: TLS bypass now opt-in via QDRANT_SKIP_TLS_VERIFY env var
if (process.env.QDRANT_SKIP_TLS_VERIFY === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'module';

// Obtenir le répertoire du fichier actuel
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement AVANT tout autre import
const envPath = path.join(__dirname, '..', '.env');
// #1140: quiet: true prevents dotenv v17 from writing to stdout,
// which would corrupt the MCP JSON-RPC stdio transport.
const envResult = dotenv.config({ path: envPath, override: true, quiet: true });
if (envResult.error) {
  console.error('🔧 [DEBUG] dotenv.config error:', envResult.error);
}

// VALIDATION STRICTE DES CONFIGURATIONS CRITIQUES AU STARTUP
const REQUIRED_ENV_VARS = [
    'QDRANT_URL',
    'QDRANT_API_KEY',
    'QDRANT_COLLECTION_NAME',
    'ROOSYNC_SHARED_PATH'
];
const hasEmbeddingKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
if (!hasEmbeddingKey) {
    console.error('🚨 ERREUR: Aucune clé d\'embedding configurée. Définir EMBEDDING_API_KEY (préféré) ou OPENAI_API_KEY.');
}
const missingVars = REQUIRED_ENV_VARS.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('🚨 ERREUR CRITIQUE: Variables d\'environnement manquantes:');
    missingVars.forEach(varName => console.error(`   ❌ ${varName}`));
    console.error('📄 Vérifiez le fichier .env à la racine du projet roo-state-manager');
    console.error('🔥 ARRÊT IMMÉDIAT DU SERVEUR POUR ÉVITER TOUTE PERTE DE TEMPS');
    process.exit(1);
}
console.error('✅ Variables d\'environnement critiques présentes');

// #1140: ONLY import what's needed for server creation + handler registration.
// Everything else loads lazily on first use.
import { createMcpServer, SERVER_CONFIG } from './config/server-config.js';
import { registerListToolsHandler, registerCallToolHandler } from './tools/registry.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('RooStateManagerServer');
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

// #1140: Lazy imports — loaded on first use, not at startup
// These modules pull in heavy dependency chains (RooSyncService, MessageManager, etc.)
let _stateManagerModule: typeof import('./services/state-manager.service.js') | null = null;
let _serverHelpersModule: typeof import('./utils/server-helpers.js') | null = null;
let _backgroundServicesModule: typeof import('./services/background-services.js') | null = null;
let _rooStorageModule: typeof import('./utils/roo-storage-detector.js') | null = null;
let _claudeStorageModule: typeof import('./utils/claude-storage-detector.js') | null = null;

async function getStateManager() {
    if (!_stateManagerModule) _stateManagerModule = await import('./services/state-manager.service.js');
    return _stateManagerModule;
}
async function getServerHelpers() {
    if (!_serverHelpersModule) _serverHelpersModule = await import('./utils/server-helpers.js');
    return _serverHelpersModule;
}
async function getBackgroundServices() {
    if (!_backgroundServicesModule) _backgroundServicesModule = await import('./services/background-services.js');
    return _backgroundServicesModule;
}

/**
 * Classe principale du serveur MCP
 */
class RooStateManagerServer {
    private server: ReturnType<typeof createMcpServer>;
    private stateManager: import('./services/state-manager.service.js').StateManager | null = null;
    private toolInterceptor: import('./notifications/ToolUsageInterceptor.js').ToolUsageInterceptor | null = null;
    // #883: Throttle cache freshness checks to avoid repeated I/O scans
    private lastCacheCheckAt: number = 0;
    private static readonly CACHE_CHECK_THROTTLE_MS = 60_000; // 1 minute minimum between checks
    private _initPromise: Promise<void>;

    constructor() {
        // Create MCP server IMMEDIATELY — no heavy imports yet
        this.server = createMcpServer(SERVER_CONFIG);

        // Register handlers with lazy dependencies
        this.registerHandlers();

        // Start heavy initialization in background (non-blocking)
        this._initPromise = this.initializeAsync().catch((error: Error) => {
            logger.error("Error during async initialization:", { error });
        });
    }

    /**
     * Heavy initialization — runs in background after transport connects
     */
    private async initializeAsync(): Promise<void> {
        const { StateManager } = await getStateManager();
        this.stateManager = new StateManager();

        // #883: Log workspace detection
        const wsPath = process.env.WORKSPACE_PATH;
        const cwd = process.cwd();
        logger.info(`[Workspace] WORKSPACE_PATH env: ${wsPath || '(not set)'}`);
        logger.info(`[Workspace] process.cwd(): ${cwd}`);
        logger.info(`[Workspace] DEFAULT_WORKSPACE resolves to: ${wsPath || cwd}`);
        if (!wsPath) {
            logger.warn(`[Workspace] ⚠️ WORKSPACE_PATH not set — falling back to process.cwd()`);
        }

        // Initialize notification system (deferred — pulls in MessageManager 3.8s)
        await this.initializeNotificationSystem();

        // Initialize background services (skeleton cache, etc.)
        const { initializeBackgroundServices } = await getBackgroundServices();
        const state = this.stateManager.getState();
        await initializeBackgroundServices(state);
    }

    /**
     * Ensures stateManager is ready. Called by handlers that need state.
     */
    private async ensureInitialized(): Promise<import('./services/state-manager.service.js').StateManager> {
        if (!this.stateManager) {
            await this._initPromise;
        }
        if (!this.stateManager) {
            // If still null after init, create one
            const { StateManager } = await getStateManager();
            this.stateManager = new StateManager();
        }
        return this.stateManager;
    }

    /**
     * Initialise le système de notifications push (lazy)
     */
    private async initializeNotificationSystem(): Promise<void> {
        try {
            const notificationsEnabled = process.env.NOTIFICATIONS_ENABLED !== 'false';
            if (!notificationsEnabled) {
                logger.info('📴 [Notifications] Système désactivé via NOTIFICATIONS_ENABLED=false');
                return;
            }
            const sharedStatePath = process.env.ROOSYNC_SHARED_PATH;
            if (!sharedStatePath) {
                logger.warn('⚠️ [Notifications] ROOSYNC_SHARED_PATH non défini, notifications push désactivées');
                return;
            }

            // Dynamic imports — these pull in heavy chains
            const { NotificationService } = await import('./notifications/NotificationService.js');
            const { ToolUsageInterceptor } = await import('./notifications/ToolUsageInterceptor.js');
            const { getMessageManager } = await import('./services/MessageManager.js');

            const notificationService = new NotificationService();
            const messageManager = getMessageManager();
            const minPriority = process.env.NOTIFICATIONS_MIN_PRIORITY || 'MEDIUM';
            notificationService.loadFilterRules([
                {
                    id: 'min-priority-filter',
                    eventType: 'new_message',
                    condition: {
                        priority: minPriority === 'URGENT' ? ['URGENT']
                                : minPriority === 'HIGH' ? ['URGENT', 'HIGH']
                                : minPriority === 'MEDIUM' ? ['URGENT', 'HIGH', 'MEDIUM']
                                : ['URGENT', 'HIGH', 'MEDIUM', 'LOW']
                    },
                    action: 'allow',
                    notifyUser: true
                }
            ]);

            const sm = await this.ensureInitialized();
            const state = sm.getState();
            const machineId = process.env.ROOSYNC_MACHINE_ID || 'local_machine';
            this.toolInterceptor = new ToolUsageInterceptor(
                notificationService,
                messageManager,
                state.conversationCache,
                {
                    enabled: true,
                    checkInbox: process.env.NOTIFICATIONS_CHECK_INBOX !== 'false',
                    refreshCache: true,
                    machineId
                }
            );
            logger.info('✅ [Notifications] Système initialisé avec succès');
        } catch (error) {
            logger.error('❌ [Notifications] Erreur lors de l\'initialisation:', { error });
            logger.warn('⚠️ [Notifications] Le serveur continuera sans notifications push');
        }
    }

    /**
     * Enregistre tous les handlers du serveur.
     * Handlers use lazy imports internally — no heavy deps at registration time.
     */
    private registerHandlers(): void {
        // Register ListTools handler (already has lazy getToolExports() from PR #54)
        registerListToolsHandler(this.server);

        // Register CallTool handler with lazy state access
        // We pass a proxy that lazily initializes state
        const getState = async () => {
            const sm = await this.ensureInitialized();
            return sm.getState();
        };

        // Create a lazy state proxy for registerCallToolHandler
        // The handler needs state synchronously for the cache, but actual tool calls are async
        const lazyState = new Proxy({} as any, {
            get: (_target, prop) => {
                if (prop === 'conversationCache') {
                    // Return the actual cache if stateManager is ready, empty map otherwise
                    return this.stateManager?.getState().conversationCache ?? new Map();
                }
                // For other properties, delegate to stateManager if available
                return (this.stateManager?.getState() as any)?.[prop as string];
            }
        });

        registerCallToolHandler(
            this.server,
            lazyState,
            // Lazy handleTouchMcpSettings
            async (...args: any[]) => {
                const helpers = await getServerHelpers();
                return (helpers.handleTouchMcpSettings as any)(...args);
            },
            this.ensureSkeletonCacheIsFresh.bind(this),
            // Lazy saveSkeletonToDisk
            async (...args: any[]) => {
                const bg = await getBackgroundServices();
                return (bg.saveSkeletonToDisk as any)(...args);
            }
        );

        // Wrapper pour tronquer les résultats ET activer l'intercepteur de notifications
        const originalCallTool = this.server['_requestHandlers'].get('tools/call');
        if (originalCallTool) {
            this.server['_requestHandlers'].set('tools/call', async (request: any) => {
                // Ensure state is initialized before first tool call
                await this.ensureInitialized();

                const helpers = await getServerHelpers();

                if (this.toolInterceptor) {
                    const wrappedResult = await this.toolInterceptor.interceptToolCall(
                        request.params.name,
                        request.params.arguments,
                        async () => await originalCallTool(request)
                    );
                    return helpers.truncateResult(wrappedResult);
                } else {
                    const result = await originalCallTool(request);
                    return helpers.truncateResult(result);
                }
            });
        }
    }

    /**
     * FAILSAFE: Ensure skeleton cache is fresh and up-to-date
     */
    private async ensureSkeletonCacheIsFresh(args?: { workspace?: string }): Promise<boolean> {
        try {
            // #883: Throttle to avoid repeated I/O scans
            const checkTime = Date.now();
            if (this.lastCacheCheckAt > 0 && (checkTime - this.lastCacheCheckAt) < RooStateManagerServer.CACHE_CHECK_THROTTLE_MS) {
                return false;
            }
            this.lastCacheCheckAt = checkTime;

            const sm = await this.ensureInitialized();
            const state = sm.getState();

            if (state.conversationCache.size === 0) {
                logger.info('[FAILSAFE] Cache empty, triggering differential rebuild...');
                const { handleBuildSkeletonCache } = await import('./tools/index.js');
                await handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                }, state.conversationCache as any);
                return true;
            }

            // Check for new tasks
            if (!_rooStorageModule) _rooStorageModule = await import('./utils/roo-storage-detector.js');
            const storageLocations = await _rooStorageModule.RooStorageDetector.detectStorageLocations();
            if (storageLocations.length === 0) {
                return false;
            }

            let needsUpdate = false;
            const now = Date.now();
            const CACHE_VALIDITY_MS = 60 * 60 * 1000; // 1 hour

            const { promises: fs } = await import('fs');

            for (const location of storageLocations) {
                try {
                    const tasksDir = path.join(location, 'tasks');
                    const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
                    for (const convDir of conversationDirs) {
                        if (convDir.isDirectory() && convDir.name !== '.skeletons') {
                            const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
                            try {
                                const metadataStat = await fs.stat(metadataPath);
                                const ageMs = now - metadataStat.mtime.getTime();
                                if (ageMs < CACHE_VALIDITY_MS && !state.conversationCache.has(convDir.name)) {
                                    needsUpdate = true;
                                    break;
                                }
                            } catch { /* ignore stat errors */ }
                        }
                    }
                    if (needsUpdate) break;
                } catch (readdirError) {
                    logger.warn(`[FAILSAFE] Could not read directory ${location}:`, { error: readdirError });
                }
            }

            // Check Claude Code sessions
            if (!needsUpdate) {
                try {
                    if (!_claudeStorageModule) _claudeStorageModule = await import('./utils/claude-storage-detector.js');
                    const claudeLocations = await _claudeStorageModule.ClaudeStorageDetector.detectStorageLocations();
                    const seenProjects = new Set<string>();

                    for (const location of claudeLocations) {
                        if (seenProjects.has(location.projectPath)) continue;
                        seenProjects.add(location.projectPath);

                        try {
                            const files = (await fs.readdir(location.projectPath)).filter((f: string) => f.endsWith('.jsonl'));
                            for (const file of files) {
                                try {
                                    const taskId = `claude-${file.replace('.jsonl', '')}`;
                                    const filePath = path.join(location.projectPath, file);
                                    const fileStat = await fs.stat(filePath);
                                    if ((now - fileStat.mtime.getTime()) < CACHE_VALIDITY_MS && !state.conversationCache.has(taskId)) {
                                        needsUpdate = true;
                                        break;
                                    }
                                } catch { /* skip */ }
                            }
                            if (needsUpdate) break;
                        } catch { /* skip */ }
                    }
                } catch (claudeError) {
                    logger.warn('[FAILSAFE] Error checking Claude sessions:', { error: claudeError });
                }
            }

            if (needsUpdate) {
                logger.info('[FAILSAFE] Cache outdated, triggering differential rebuild...');
                const { handleBuildSkeletonCache: rebuildCache } = await import('./tools/index.js');
                await rebuildCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                }, state.conversationCache as any);
                return true;
            }

            return false;
        } catch (error) {
            logger.error('[FAILSAFE] Error checking skeleton cache freshness:', { error });
            return false;
        }
    }

    /**
     * Démarre le serveur — connects transport IMMEDIATELY
     */
    async run(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        logger.info(`Roo State Manager Server started - v${packageJson.version}`);
    }

    /**
     * Arrête le serveur
     */
    async stop(): Promise<void> {
        if (this.stateManager) {
            const state = this.stateManager.getState();
            if (state.qdrantIndexInterval) {
                clearInterval(state.qdrantIndexInterval);
                state.qdrantIndexInterval = null;
            }
        }
        if (this.server && (this.server as any).transport) {
            (this.server as any).transport.close();
        }
    }
}

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', { error });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', { promise, reason });
    process.exit(1);
});

// T3.6: Graceful shutdown avec timeout
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);
let isShuttingDown = false;
let serverInstance: RooStateManagerServer | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        logger.warn(`Shutdown already in progress, ignoring ${signal}`);
        return;
    }
    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)...`);

    const forceExitTimeout = setTimeout(() => {
        logger.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
        if (serverInstance) {
            logger.info('Stopping MCP server...');
            await serverInstance.stop();
            logger.info('MCP server stopped');
        }

        const { getServiceRegistry } = await import('./services/ServiceRegistry.js');
        const registry = getServiceRegistry();
        if (registry) {
            logger.info('Shutting down ServiceRegistry...');
            await registry.shutdown();
            logger.info('ServiceRegistry shutdown complete');
        }

        clearTimeout(forceExitTimeout);
        logger.info(`Graceful shutdown completed successfully after ${signal}`);
        process.exit(0);
    } catch (error) {
        clearTimeout(forceExitTimeout);
        logger.error('Error during graceful shutdown:', { error });
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Démarrage du serveur — connect transport ASAP, heavy init in background
(async () => {
    try {
        serverInstance = new RooStateManagerServer();
        serverInstance.run().catch((error) => {
            logger.error('Fatal error during server execution:', { error });
            process.exit(1);
        });
    } catch (error) {
        logger.error('Fatal error during server initialization:', { error });
        process.exit(1);
    }
})();

export { RooStateManagerServer };
