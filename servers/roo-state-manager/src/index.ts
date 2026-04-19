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

// #1551: Enhanced env validation — distinguish empty from missing, show .env path and fix hints
const REQUIRED_ENV_VARS: Array<{ name: string; hint: string }> = [
    { name: 'QDRANT_URL', hint: 'Ex: https://qdrant.myia.io (remote) ou http://localhost:6333 (local)' },
    { name: 'QDRANT_API_KEY', hint: 'Clé API Qdrant. Ne PAS laisser vide. Ex: 4f89edd5-...' },
    { name: 'QDRANT_COLLECTION_NAME', hint: 'Ex: roo_tasks_semantic_index' },
    { name: 'ROOSYNC_SHARED_PATH', hint: 'Ex: G:/Mon Drive/Synchronisation/RooSync/.shared-state' },
];
const hasEmbeddingKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
if (!hasEmbeddingKey) {
    console.error('⚠️ WARNING: Aucune clé d\'embedding configurée. Recherche sémantique indisponible.');
    console.error('   Définir EMBEDDING_API_KEY (préféré) ou OPENAI_API_KEY dans le .env.');
}

const problems: Array<{ name: string; issue: string; hint: string }> = [];
for (const { name, hint } of REQUIRED_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined || value === '') {
        const issue = value === undefined ? 'ABSENTE (non définie)' : 'VIDE (définie mais vide)';
        problems.push({ name, issue, hint });
    }
}

if (problems.length > 0) {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('🚨 ERREUR CRITIQUE: Configuration .env invalide');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error(`📄 Fichier .env: ${envPath}`);
    console.error('');
    for (const { name, issue, hint } of problems) {
        console.error(`   ❌ ${name} — ${issue}`);
        console.error(`      → ${hint}`);
    }
    console.error('');
    console.error('🔧 ACTION: Vérifiez le fichier .env ci-dessus. Chaque variable');
    console.error('   doit avoir une valeur non-vide. Ne JAMAIS vider une clé existante.');
    console.error('═══════════════════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
}
console.error(`✅ Configuration .env validée (${envPath})`);

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
// #1244: _rooStorageModule and _claudeStorageModule removed — the synchronous
// failsafe that loaded them is gone. Worker A in background-services handles
// all freshness via 2-min incremental mtime scans.

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
    private _initError: Error | null = null;
    private _resolveInit!: () => void;
    private _rejectInit!: (error: Error) => void;

    constructor() {
        // Create MCP server IMMEDIATELY — no heavy imports yet
        this.server = createMcpServer(SERVER_CONFIG);

        // Register handlers with lazy dependencies
        this.registerHandlers();

        // #1110: Do NOT start initializeAsync() here.
        // Dynamic import() blocks the event loop during module evaluation (7s on fast machines, 45s+ on slow).
        // If started in constructor, run() can't connect transport until imports finish → MCP timeout.
        // Instead, startBackgroundInit() is called AFTER run() connects the transport.
        this._initPromise = new Promise((resolve, reject) => {
            this._resolveInit = resolve;
            this._rejectInit = reject;
        });
    }

    /**
     * Start heavy initialization in background AFTER transport is connected.
     * Uses setImmediate to yield the event loop first, so the MCP handshake
     * (initialize request) can be processed before imports block the event loop.
     */
    startBackgroundInit(): void {
        setImmediate(() => {
            this.initializeAsync()
                .then(() => this._resolveInit())
                .catch((error: Error) => {
                    logger.error("Error during async initialization:", { error });
                    this._initError = error;
                    this._rejectInit(error);
                });
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

        // #1495: Preload RooSyncService so dashboard/heartbeat are ready on first call.
        // Without this, getRooSyncService() only loads on first tool call → "Not connected".
        const { getRooSyncService: preloadRooSync } = await import('./services/lazy-roosync.js');
        await preloadRooSync();
        logger.info('✅ [ColdStart] RooSyncService preloaded — dashboard/heartbeat ready');
    }

    /**
     * Ensures stateManager is ready. Called by handlers that need state.
     */
    private async ensureInitialized(): Promise<import('./services/state-manager.service.js').StateManager> {
        if (!this.stateManager) {
            await this._initPromise;
        }
        if (this._initError) {
            throw new Error(`MCP server initialization failed: ${this._initError.message}`);
        }
        if (!this.stateManager) {
            throw new Error('StateManager not available after initialization');
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

        // Wrapper pour tronquer les résultats, mesurer la durée d'exécution,
        // et activer l'intercepteur de notifications
        const originalCallTool = this.server['_requestHandlers'].get('tools/call');
        if (originalCallTool) {
            this.server['_requestHandlers'].set('tools/call', async (request: any) => {
                // #1245: Measure wall-clock duration of every tool call (visible in output)
                const startMs = Date.now();
                const toolName: string | undefined = request?.params?.name;

                // Ensure state is initialized before first tool call
                await this.ensureInitialized();

                const helpers = await getServerHelpers();

                let result;
                if (this.toolInterceptor) {
                    result = await this.toolInterceptor.interceptToolCall(
                        request.params.name,
                        request.params.arguments,
                        async () => await originalCallTool(request)
                    );
                } else {
                    result = await originalCallTool(request);
                }

                const durationMs = Date.now() - startMs;
                // Inject duration AFTER truncation so the footer is never cut off.
                return helpers.injectDuration(helpers.truncateResult(result), durationMs, toolName);
            });
        }
    }

    /**
     * #1244: Fast freshness check (formerly synchronous failsafe).
     *
     * The actual heavy work — scanning task directories for modified files,
     * rebuilding skeletons, regenerating the index — is done by Worker A
     * (`startSkeletonRefreshWorker` in `services/background-services.ts`) on a
     * 2-minute interval. Worker A is started at MCP startup via
     * `initializeBackgroundServices()` and uses `state.lastSkeletonRefreshAt`
     * as a checkpoint for incremental mtime-based scans (only files newer than
     * the last tick are read).
     *
     * This method is now a fast no-op safety net:
     *   - Throttled to once per minute.
     *   - If state is not initialized yet, return immediately. The CallTool
     *     wrapper already awaits `ensureInitialized()` before any tool runs.
     *   - If the cache is empty (rare edge case: first run, index missing,
     *     background load not finished), schedule a background populate via
     *     `setImmediate`. NEVER await it.
     *   - Otherwise, return immediately (< 5ms total).
     *
     * Foreground tools must NOT depend on this method to provide freshness.
     * Freshness is guaranteed by Worker A's 2-minute periodic refresh.
     */
    private async ensureSkeletonCacheIsFresh(args?: { workspace?: string }): Promise<boolean> {
        try {
            // #883: Throttle to avoid burning cycles on repeated checks
            const checkTime = Date.now();
            if (this.lastCacheCheckAt > 0 && (checkTime - this.lastCacheCheckAt) < RooStateManagerServer.CACHE_CHECK_THROTTLE_MS) {
                return false;
            }
            this.lastCacheCheckAt = checkTime;

            // Do NOT await ensureInitialized() here — that's the caller's job
            // (the CallTool wrapper already does it). We work with whatever
            // state is currently ready, no blocking I/O on the foreground path.
            const sm = this.stateManager;
            if (!sm) return false;

            const state = sm.getState();

            // Happy path: Worker A is keeping the cache fresh. Nothing to do.
            if (state.conversationCache.size > 0) {
                return false;
            }

            // Edge case: cache empty — first run, missing index, or background
            // load still in progress. Schedule a background populate so the next
            // tool call has data. NEVER await it.
            logger.info('[FAILSAFE] Cache empty — scheduling background populate (non-blocking)');
            setImmediate(() => {
                (async () => {
                    try {
                        const { handleBuildSkeletonCache } = await import('./tools/index.js');
                        await handleBuildSkeletonCache({
                            force_rebuild: false,
                            workspace_filter: args?.workspace
                        }, state.conversationCache as any);
                        logger.info('[FAILSAFE] Background populate complete');
                    } catch (error) {
                        logger.warn('[FAILSAFE] Background populate failed (non-blocking):', { error });
                    }
                })();
            });

            return false;
        } catch (error) {
            logger.error('[FAILSAFE] Error in fast freshness check:', { error });
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

        // #1110: Start heavy initialization AFTER transport is connected.
        // setImmediate inside startBackgroundInit() yields the event loop,
        // allowing the MCP initialize handshake to complete before
        // dynamic import() blocks the event loop during module evaluation.
        this.startBackgroundInit();
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
