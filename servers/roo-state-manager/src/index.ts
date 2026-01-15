/**
 * Point d'entrée du serveur MCP roo-state-manager
 *
 * Ce fichier orchestre l'initialisation et le démarrage du serveur.
 * Toute la logique métier est dans src/tools/, src/services/, src/config/
 */
// FIX: Ignorer les erreurs SSL pour Qdrant (certificat auto-signé ou invalide)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Obtenir le répertoire du fichier actuel
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Charger les variables d'environnement AVANT tout autre import
const envPath = path.join(__dirname, '..', '.env');
// Note: console.log utilisé ici car le logger n'est pas encore initialisé
console.log('🔧 [DEBUG] Chargement .env depuis:', envPath);
console.log('🔧 [DEBUG] __dirname:', __dirname);
const envResult = dotenv.config({ path: envPath, override: true });
console.log('🔧 [DEBUG] dotenv.config result:', envResult.error ? 'ERROR' : 'SUCCESS');
if (envResult.error) {
  console.error('🔧 [DEBUG] dotenv.config error:', envResult.error);
}
// VALIDATION STRICTE DES CONFIGURATIONS CRITIQUES AU STARTUP
const REQUIRED_ENV_VARS = [
    'QDRANT_URL',
    'QDRANT_API_KEY',
    'QDRANT_COLLECTION_NAME',
    'OPENAI_API_KEY',
    'ROOSYNC_SHARED_PATH'
];
const missingVars = REQUIRED_ENV_VARS.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('🚨 ERREUR CRITIQUE: Variables d\'environnement manquantes:');
    missingVars.forEach(varName => console.error(`   ❌ ${varName}`));
    console.error('📄 Vérifiez le fichier .env à la racine du projet roo-state-manager');
    console.error('🔥 ARRÊT IMMÉDIAT DU SERVEUR POUR ÉVITER TOUTE PERTE DE TEMPS');
    process.exit(1);
}

console.log('✅ Toutes les variables d\'environnement critiques sont présentes');
console.log('🔧 [DEBUG] ROOSYNC_SHARED_PATH =', process.env.ROOSYNC_SHARED_PATH);

// NOTE: Système de vérification des conflits d'identité (T2.5) SUPPRIMÉ
// Raison: Fonctionnalité non demandée par l'utilisateur, bloquait le multi-agent
// (Claude Code + Roo Code sur même machine). Supprimé le 2026-01-14.

// Imports des modules après validation des env vars
import { createMcpServer, SERVER_CONFIG } from './config/server-config.js';
import { StateManager } from './services/state-manager.service.js';
import { registerListToolsHandler, registerCallToolHandler } from './tools/registry.js';
import { truncateResult, handleTouchMcpSettings, handleExportConversationJson, handleExportConversationCsv } from './utils/server-helpers.js';
import { initializeBackgroundServices, saveSkeletonToDisk } from './services/background-services.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { handleBuildSkeletonCache } from './tools/index.js';
import { NotificationService } from './notifications/NotificationService.js';
import { ToolUsageInterceptor } from './notifications/ToolUsageInterceptor.js';
import { MessageManager } from './services/MessageManager.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('RooStateManagerServer');

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

/**
 * Classe principale du serveur MCP
 */
class RooStateManagerServer {
    private server: ReturnType<typeof createMcpServer>;
    private stateManager: StateManager;
    private notificationService: NotificationService;
    private toolInterceptor: ToolUsageInterceptor | null = null;

    constructor() {
        // Initialisation de l'état global via StateManager
        this.stateManager = new StateManager();
        // Création du serveur MCP
        this.server = createMcpServer(SERVER_CONFIG);
        // Initialiser le système de notifications
        this.notificationService = new NotificationService();
        this.initializeNotificationSystem();
        // Enregistrement des handlers
        this.registerHandlers();
        // Initialisation des services background
        this.initializeBackgroundServices().catch((error: Error) => {
            logger.error("Error during background services initialization:", { error });
        });
    }

    /**
     * Initialise le système de notifications push
     */
    private initializeNotificationSystem(): void {
        try {
            // Vérifier si les notifications sont activées
            const notificationsEnabled = process.env.NOTIFICATIONS_ENABLED !== 'false';
            if (!notificationsEnabled) {
                logger.info('📴 [Notifications] Système désactivé via NOTIFICATIONS_ENABLED=false');
                return;
            }
            // Initialiser le MessageManager
            const sharedStatePath = process.env.ROOSYNC_SHARED_PATH;
            if (!sharedStatePath) {
                logger.warn('⚠️ [Notifications] ROOSYNC_SHARED_PATH non défini, notifications push désactivées');
                return;
            }
            const messageManager = new MessageManager(sharedStatePath);
            // Charger les règles de filtrage
            const minPriority = process.env.NOTIFICATIONS_MIN_PRIORITY || 'MEDIUM';
            this.notificationService.loadFilterRules([
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
            // Créer l'intercepteur d'outils
            const state = this.stateManager.getState();
            const machineId = process.env.ROOSYNC_MACHINE_ID || 'local_machine';
            this.toolInterceptor = new ToolUsageInterceptor(
                this.notificationService,
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
     * Enregistre tous les handlers du serveur
     */
    private registerHandlers(): void {
        const state = this.stateManager.getState();
        // Enregistrer le handler ListTools
        registerListToolsHandler(this.server);
        // Enregistrer le handler CallTool avec toutes les dépendances
        registerCallToolHandler(
            this.server,
            state,
            handleTouchMcpSettings,
            (args) => handleExportConversationJson(args, state.conversationCache),
            (args) => handleExportConversationCsv(args, state.conversationCache),
            this.ensureSkeletonCacheIsFresh.bind(this),
            saveSkeletonToDisk
        );
        // Wrapper pour tronquer les résultats ET activer l'intercepteur de notifications
        const originalCallTool = this.server['_requestHandlers'].get('tools/call');
        if (originalCallTool) {
            this.server['_requestHandlers'].set('tools/call', async (request: any) => {
                // Si l'intercepteur est activé, l'utiliser
                if (this.toolInterceptor) {
                    const wrappedResult = await this.toolInterceptor.interceptToolCall(
                        request.params.name,
                        request.params.arguments,
                        async () => await originalCallTool(request)
                    );
                    return truncateResult(wrappedResult);
                } else {
                    // Sinon, exécution normale
                    const result = await originalCallTool(request);
                    return truncateResult(result);
                }
            });
        }
    }

    /**
     * Initialise les services de background
     */
    private async initializeBackgroundServices(): Promise<void> {
        const state = this.stateManager.getState();
        await initializeBackgroundServices(state);
    }

    /**
     * FAILSAFE: Ensure skeleton cache is fresh and up-to-date
     */
    private async ensureSkeletonCacheIsFresh(args?: { workspace?: string }): Promise<boolean> {
        try {
            logger.debug('[FAILSAFE] Checking skeleton cache freshness...');

            const state = this.stateManager.getState();

            // Vérifier si le cache est vide - reconstruction nécessaire
            if (state.conversationCache.size === 0) {
                logger.info('[FAILSAFE] Cache empty, triggering differential rebuild...');
                await handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                }, state.conversationCache);
                return true;
            }

            // Vérifier si des nouvelles conversations existent depuis la dernière mise à jour
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            if (storageLocations.length === 0) {
                logger.warn('[FAILSAFE] No storage locations found');
                return false;
            }

            let needsUpdate = false;
            const now = Date.now();
            const CACHE_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes

            // Vérifier les modifications récentes dans chaque emplacement
            for (const location of storageLocations) {
                try {
                    const conversationDirs = await fs.readdir(location, { withFileTypes: true });
                    for (const convDir of conversationDirs) { // Traitement de toutes les conversations
                        if (convDir.isDirectory() && convDir.name !== '.skeletons') {
                            const taskPath = path.join(location, convDir.name);
                            const metadataPath = path.join(taskPath, 'task_metadata.json');
                            try {
                                const metadataStat = await fs.stat(metadataPath);
                                const ageMs = now - metadataStat.mtime.getTime();
                                // Si metadata récent ET pas dans le cache
                                if (ageMs < CACHE_VALIDITY_MS && !state.conversationCache.has(convDir.name)) {
                                    logger.debug(`[FAILSAFE] New task detected: ${convDir.name}, age: ${Math.round(ageMs/1000)}s`);
                                    needsUpdate = true;
                                    break;
                                }
                            } catch (statError) {
                                // Ignorer les erreurs de stat
                            }
                        }
                    }
                    if (needsUpdate) break;
                } catch (readdirError) {
                    logger.warn(`[FAILSAFE] Could not read directory ${location}:`, { error: readdirError });
                }
            }

            // Déclencher reconstruction différentielle si nécessaire
            if (needsUpdate) {
                logger.info('[FAILSAFE] Cache outdated, triggering differential rebuild...');
                await handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                }, state.conversationCache);
                return true;
            }

            logger.debug('[FAILSAFE] Skeleton cache is fresh');
            return false;

        } catch (error) {
            logger.error('[FAILSAFE] Error checking skeleton cache freshness:', { error });
            return false;
        }
    }

    /**
     * Démarre le serveur
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
        const state = this.stateManager.getState();
        // Arrêter le service d'indexation Qdrant
        if (state.qdrantIndexInterval) {
            clearInterval(state.qdrantIndexInterval);
            state.qdrantIndexInterval = null;
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

/**
 * Graceful shutdown handler avec timeout
 * T3.6 - Implémenter graceful shutdown timeout
 */
async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        logger.warn(`Shutdown already in progress, ignoring ${signal}`);
        return;
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)...`);

    // Timeout de sécurité
    const forceExitTimeout = setTimeout(() => {
        logger.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
        // 1. Arrêter le serveur MCP
        if (serverInstance) {
            logger.info('Stopping MCP server...');
            await serverInstance.stop();
            logger.info('MCP server stopped');
        }

        // 2. Arrêter le ServiceRegistry (cleanup de tous les services)
        const { getServiceRegistry } = await import('./services/ServiceRegistry.js');
        const registry = getServiceRegistry();
        if (registry) {
            logger.info('Shutting down ServiceRegistry...');
            await registry.shutdown();
            logger.info('ServiceRegistry shutdown complete');
        }

        // 3. Cleanup réussi
        clearTimeout(forceExitTimeout);
        logger.info(`Graceful shutdown completed successfully after ${signal}`);
        process.exit(0);

    } catch (error) {
        clearTimeout(forceExitTimeout);
        logger.error('Error during graceful shutdown:', { error });
        process.exit(1);
    }
}

// Enregistrement des handlers de signaux
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Démarrage du serveur
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
