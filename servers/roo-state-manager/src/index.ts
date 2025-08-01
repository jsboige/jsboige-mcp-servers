import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { TaskNavigator } from './services/task-navigator.js';
import { ConversationSkeleton } from './types/conversation.js';

const MAX_OUTPUT_LENGTH = 10000; // 10k characters limit
const SKELETON_CACHE_DIR_NAME = '.skeletons';

class RooStateManagerServer {
    private server: Server;
    private conversationCache: Map<string, ConversationSkeleton> = new Map();

    constructor() {
        this.server = new Server(
            {
                name: 'roo-state-manager', // Restoring original name
                version: '0.1.0-new-features',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );
        
        this._loadSkeletonsFromDisk().catch(error => {
            console.error("Error during initial skeleton load:", error);
        });

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'minimal_test_tool',
                        description: 'This is a minimal tool to check if the MCP is reloading.',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    {
                        name: 'detect_roo_storage',
                        description: 'Détecte automatiquement les emplacements de stockage Roo et scanne les conversations existantes',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                   {
                       name: 'get_storage_stats',
                       description: 'Calcule des statistiques sur le stockage (nombre de conversations, taille totale).',
                       inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    {
                        name: 'list_conversations',
                        description: 'Liste toutes les conversations avec filtres et tri.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                limit: { type: 'number' },
                                sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'] },
                                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                                hasApiHistory: { type: 'boolean' },
                                hasUiMessages: { type: 'boolean' },
                            },
                        },
                    },
                    {
                        name: 'touch_mcp_settings',
                        description: 'Touche le fichier de paramètres pour forcer le rechargement des MCPs Roo.',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    {
                        name: 'build_skeleton_cache',
                        description: 'Force la reconstruction complète du cache de squelettes sur le disque. Opération potentiellement longue.',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    // New features being re-introduced
                    {
                        name: 'get_task_tree',
                        description: 'Récupère une vue arborescente et hiérarchique des tâches.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                conversation_id: { type: 'string', description: 'ID de la conversation pour laquelle récupérer l\'arbre des tâches.' },
                                max_depth: { type: 'number', description: 'Profondeur maximale de l\'arbre à retourner.' },
                            },
                            required: ['conversation_id'],
                        },
                    },
                    {
                        name: 'search_tasks_semantic',
                        description: 'Recherche des tâches de manière sémantique dans une conversation.',
                         inputSchema: {
                            type: 'object',
                            properties: {
                                conversation_id: { type: 'string', description: 'ID de la conversation à fouiller.' },
                                search_query: { type: 'string', description: 'La requête de recherche sémantique.' },
                                 max_results: { type: 'number', description: 'Nombre maximum de résultats à retourner.' },
                            },
                            required: ['conversation_id', 'search_query'],
                        },
                    },
                   {
                       name: 'debug_analyze_conversation',
                       description: 'Debug tool to analyze a single conversation and return raw data.',
                       inputSchema: {
                           type: 'object',
                           properties: {
                               taskId: { type: 'string', description: 'The ID of the task to analyze.' }
                           },
                           required: ['taskId']
                       }
                   },
                    {
                        name: 'view_conversation_tree',
                        description: 'Fournit une vue arborescente et condensée des conversations pour une analyse rapide.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                task_id: { type: 'string', description: 'L\'ID de la tâche de départ. Si non fourni, utilise la tâche la plus récente.' },
                                view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], default: 'chain', description: 'Le mode d\'affichage.' },
                                truncate: { type: 'number', default: 5, description: 'Nombre de lignes à conserver au début et à la fin de chaque message. 0 pour désactiver.' },
                            },
                        },
                    }
                ] as any[],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
            const { name, arguments: args } = request.params;

            let result: CallToolResult;

            switch (name) {
                case 'minimal_test_tool':
                    result = { content: [{ type: 'text', text: 'Minimal tool executed successfully! Version 2' }] };
                    break;
               case 'detect_roo_storage':
                   result = await this.handleDetectRooStorage();
                   break;
              case 'get_storage_stats':
                    result = await this.handleGetStorageStats();
                    break;
                case 'list_conversations':
                    result = await this.handleListConversations(args as any);
                    break;
                case 'touch_mcp_settings':
                    result = await this.handleTouchMcpSettings();
                    break;
                case 'build_skeleton_cache':
                    result = await this.handleBuildSkeletonCache();
                    break;
                case 'get_task_tree':
                    result = this.handleGetTaskTree(args as any);
                    break;
                case 'view_conversation_tree':
                    result = this.handleViewConversationTree(args as any);
                    break;
                case 'search_tasks_semantic':
                    result = await this.handleSearchTasksSemantic(args as any);
                    break;
               case 'debug_analyze_conversation':
                   result = await this.handleDebugAnalyzeConversation(args as any);
                   break;
                default:
                    throw new Error(`Tool not found: ${name}`);
            }

            return this._truncateResult(result);
        });
    }

    private _truncateResult(result: CallToolResult): CallToolResult {
        for (const item of result.content) {
            if (item.type === 'text' && item.text.length > MAX_OUTPUT_LENGTH) {
                item.text = item.text.substring(0, MAX_OUTPUT_LENGTH) + `\n\n[...]\n\n--- OUTPUT TRUNCATED AT ${MAX_OUTPUT_LENGTH} CHARACTERS ---`;
            }
        }
        return result;
    }

    async handleDetectRooStorage(): Promise<CallToolResult> {
        const locations = await RooStorageDetector.detectStorageLocations();
        return { content: [{ type: 'text', text: JSON.stringify({ locations }) }] };
    }

    async handleGetStorageStats(): Promise<CallToolResult> {
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            const stats = { conversationCount: 0, totalSize: 0 };
            return { content: [{ type: 'text', text: JSON.stringify({ stats }) }] };
        }
        let totalSize = 0;
        let conversationCount = 0;
        for (const loc of locations) {
            const files = await fs.readdir(loc);
            conversationCount += files.length;
            for (const file of files) {
                const filePath = path.join(loc, file);
                const stats = await fs.stat(filePath);
                totalSize += stats.size;
            }
        }
        const stats = { conversationCount, totalSize };
        return { content: [{ type: 'text', text: JSON.stringify({ stats }) }] };
    }

    async handleListConversations(args: { limit?: number, sortBy?: 'lastActivity' | 'messageCount' | 'totalSize', sortOrder?: 'asc' | 'desc' }): Promise<CallToolResult> {
        
        interface SkeletonNode extends ConversationSkeleton {
            children: SkeletonNode[];
        }

        const allSkeletons = Array.from(this.conversationCache.values());

        // Tri
        allSkeletons.sort((a, b) => {
            let comparison = 0;
            const sortBy = args.sortBy || 'lastActivity';
            switch (sortBy) {
                case 'lastActivity':
                    comparison = new Date(b.metadata.lastActivity).getTime() - new Date(a.metadata.lastActivity).getTime();
                    break;
                case 'messageCount':
                    comparison = b.metadata.messageCount - a.metadata.messageCount;
                    break;
                case 'totalSize':
                    comparison = b.metadata.totalSize - a.metadata.totalSize;
                    break;
            }
            return (args.sortOrder === 'asc') ? -comparison : comparison;
        });
        
        const skeletonMap = new Map<string, SkeletonNode>(allSkeletons.map(s => [s.taskId, { ...s, children: [] }]));
        const forest: SkeletonNode[] = [];

        skeletonMap.forEach(node => {
            if (node.parentTaskId && skeletonMap.has(node.parentTaskId)) {
                skeletonMap.get(node.parentTaskId)!.children.push(node);
            } else {
                forest.push(node);
            }
        });

        // Appliquer la limite à la forêt de premier niveau
        const limitedForest = args.limit ? forest.slice(0, args.limit) : forest;
        
        // La sérialisation est correcte, le problème n'était pas là.
        // La logique de construction de l'arbre est maintenue.
        const result = JSON.stringify(limitedForest, null, 2);

        return { content: [{ type: 'text', text: result }] };
    }

    async handleTouchMcpSettings(): Promise<CallToolResult> {
        const settingsPath = "c:/Users/jsboi/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json";
        const command = `(Get-Item "${settingsPath}").LastWriteTime = Get-Date`;
        
        return new Promise((resolve, reject) => {
            exec(`powershell.exe -Command "${command}"`, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(error.message));
                } else if (stderr) {
                    reject(new Error(stderr));
                } else {
                    const result = { success: true, message: stdout.trim() };
                    resolve({ content: [{ type: 'text', text: JSON.stringify(result) }] });
                }
            });
        });
    }

    async handleBuildSkeletonCache(): Promise<CallToolResult> {
        this.conversationCache.clear();
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            return { content: [{ type: 'text', text: 'Storage not found. Cache not built.' }] };
        }

        let skeletonsBuilt = 0;
        let skeletonsSkipped = 0;

        for (const loc of locations) {
            const skeletonDir = path.join(loc, SKELETON_CACHE_DIR_NAME);
            await fs.mkdir(skeletonDir, { recursive: true });

            const conversationDirs = await fs.readdir(loc, { withFileTypes: true });
            for (const convDir of conversationDirs) {
                if (convDir.isDirectory() && convDir.name !== SKELETON_CACHE_DIR_NAME) {
                    const conversationId = convDir.name;
                    const taskPath = path.join(loc, conversationId);
                    const metadataPath = path.join(taskPath, 'task_metadata.json');
                    const skeletonPath = path.join(skeletonDir, `${conversationId}.json`);

                    try {
                        const metadataStat = await fs.stat(metadataPath);
                        try {
                            const skeletonStat = await fs.stat(skeletonPath);
                            if (skeletonStat.mtime >= metadataStat.mtime) {
                                skeletonsSkipped++;
                                continue; // Le squelette est à jour
                            }
                        } catch (e) {
                            // Le squelette n'existe pas, il faut le créer
                        }
                        
                        const skeleton = await RooStorageDetector.analyzeConversation(conversationId, taskPath);
                        if (skeleton) {
                            await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                            this.conversationCache.set(conversationId, skeleton);
                            skeletonsBuilt++;
                        }
                    } catch (error) {
                         console.error(`Could not process task ${conversationId}:`, error);
                    }
                }
            }
        }
        await this._loadSkeletonsFromDisk(); // Recharger le cache complet après la construction
        return { content: [{ type: 'text', text: `Skeleton cache build complete. Built: ${skeletonsBuilt}, Skipped: ${skeletonsSkipped}.` }] };
    }

    private async _loadSkeletonsFromDisk(): Promise<void> {
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            console.error("No storage locations found, cannot load skeleton cache.");
            return;
        }

        this.conversationCache.clear();
        let loadedCount = 0;
        let errorCount = 0;

        for (const loc of locations) {
            const skeletonDir = path.join(loc, SKELETON_CACHE_DIR_NAME);
            try {
                await fs.access(skeletonDir);
                const skeletonFiles = await fs.readdir(skeletonDir);
                for (const file of skeletonFiles) {
                    if (file.endsWith('.json')) {
                        const filePath = path.join(skeletonDir, file);
                        try {
                            const fileContent = await fs.readFile(filePath, 'utf-8');
                            const skeleton: ConversationSkeleton = JSON.parse(fileContent);
                            if (skeleton && skeleton.taskId) { // Simple validation
                                this.conversationCache.set(skeleton.taskId, skeleton);
                                loadedCount++;
                            } else {
                                console.error(`Invalid skeleton file (missing taskId): ${filePath}`);
                                errorCount++;
                            }
                        } catch (parseError) {
                            console.error(`Corrupted skeleton file, skipping: ${filePath}`, parseError);
                            errorCount++;
                        }
                    }
                }
            } catch (dirError) {
                console.error(`Could not access skeleton directory ${skeletonDir}. This may be normal on first run.`);
            }
        }
        if (loadedCount > 0 || errorCount > 0) {
             console.error(`Skeleton loading complete. Loaded: ${loadedCount}, Errored: ${errorCount}.`);
        }
    }

    handleGetTaskTree(args: { conversation_id: string, max_depth?: number }): CallToolResult {
        const { conversation_id, max_depth = Infinity } = args;

        const skeletons = Array.from(this.conversationCache.values());
        const childrenMap = new Map<string, string[]>();
        skeletons.forEach(s => {
            if (s.parentTaskId) {
                if (!childrenMap.has(s.parentTaskId)) {
                    childrenMap.set(s.parentTaskId, []);
                }
                childrenMap.get(s.parentTaskId)!.push(s.taskId);
            }
        });

        const buildTree = (taskId: string, depth: number): any => {
            if (depth > max_depth) {
                return null;
            }
            const skeleton = skeletons.find(s => s.taskId === taskId);
            if (!skeleton) {
                return null;
            }

            const childrenIds = childrenMap.get(taskId) || [];
            const children = childrenIds
                .map(childId => buildTree(childId, depth + 1))
                .filter(child => child !== null);
            
            return {
                taskId: skeleton.taskId,
                title: skeleton.metadata?.title,
                children: children.length > 0 ? children : undefined,
            };
        };
        
        const tree = buildTree(conversation_id, 1);

        if (!tree) {
            throw new Error(`Could not build tree for conversation ID '${conversation_id}'. Is the cache populated and the task ID valid?`);
        }

        return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
    }

   async handleDebugAnalyzeConversation(args: { taskId: string }): Promise<CallToolResult> {
       const { taskId } = args;
       const locations = await RooStorageDetector.detectStorageLocations();
       for (const loc of locations) {
           const taskPath = path.join(loc, taskId);
           try {
               await fs.access(taskPath);
               const summary = await RooStorageDetector.analyzeConversation(taskId, taskPath);
               return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
           } catch (e) {
               // Not found in this location
           }
       }
       throw new Error(`Task with ID '${taskId}' not found in any storage location.`);
   }

    private truncateMessage(message: string, truncate: number): string {
        if (truncate === 0) {
            return message;
        }
        const lines = message.split('\n');
        if (lines.length <= truncate * 2) {
            return message;
        }
        const start = lines.slice(0, truncate).join('\n');
        const end = lines.slice(-truncate).join('\n');
        return `${start}\n[...]\n${end}`;
    }

    private findLatestTask(): ConversationSkeleton | undefined {
        if (this.conversationCache.size === 0) {
            return undefined;
        }
        const validTasks = Array.from(this.conversationCache.values()).filter(
            s => s.metadata && s.metadata.lastActivity
        );
        if (validTasks.length === 0) {
            return undefined;
        }
        return validTasks.reduce((latest, current) => {
            return new Date(latest.metadata.lastActivity) > new Date(current.metadata.lastActivity) ? latest : current;
        });
    }

    handleViewConversationTree(args: { task_id?: string, view_mode?: 'single' | 'chain' | 'cluster', truncate?: number }): CallToolResult {
        const { view_mode = 'chain', truncate = 5 } = args;
        let { task_id } = args;

        if (!task_id) {
            const latestTask = this.findLatestTask();
            if (!latestTask) {
                throw new Error("Cache is empty and no task_id was provided. Cannot determine the latest task.");
            }
            task_id = latestTask.taskId;
        }

        const skeletons = Array.from(this.conversationCache.values());
        const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));

        const getTaskChain = (startTaskId: string): ConversationSkeleton[] => {
            const chain: ConversationSkeleton[] = [];
            let currentId: string | undefined = startTaskId;
            while (currentId) {
                const skeleton = skeletonMap.get(currentId);
                if (skeleton) {
                    chain.unshift(skeleton);
                    currentId = skeleton.parentTaskId;
                } else {
                    break;
                }
            }
            return chain;
        };

        const formatTask = (skeleton: ConversationSkeleton, indent: string): string => {
            let output = `${indent}▶️ Task: ${skeleton.metadata.title || skeleton.taskId} (ID: ${skeleton.taskId})\n`;
            output += `${indent}  Parent: ${skeleton.parentTaskId || 'None'}\n`;
            output += `${indent}  Messages: ${skeleton.metadata.messageCount}\n`;
            skeleton.sequence.forEach(item => {
                if ('role' in item) { // C'est un message
                    const role = item.role === 'user' ? '👤 User' : '🤖 Assistant';
                    const message = this.truncateMessage(item.content, truncate);
                    output += `${indent}  [${role}]:\n${message.split('\n').map(l => `${indent}    | ${l}`).join('\n')}\n`;
                } else { // C'est une action
                    const icon = item.type === 'command' ? '⚙️' : '🛠️';
                    output += `${indent}  [${icon} ${item.name} (${item.status})]`;
                    const details = [];
                    if (item.file_path) {
                        details.push(`path: ${item.file_path}`);
                    }
                    if (item.line_count) {
                        details.push(`lines: ${item.line_count}`);
                    }
                    if (item.content_size) {
                        details.push(`size: ${item.content_size}b`);
                    }
                    if (details.length > 0) {
                        output += ` { ${details.join(', ')} }`;
                    }
                    output += `\n`;
                }
            });
            return output;
        };

        let tasksToDisplay: ConversationSkeleton[] = [];
        const mainTask = skeletonMap.get(task_id);
        if (!mainTask) {
            throw new Error(`Task with ID '${task_id}' not found in cache.`);
        }

        switch (view_mode) {
            case 'single':
                tasksToDisplay.push(mainTask);
                break;
            case 'chain':
                tasksToDisplay = getTaskChain(task_id);
                break;
            case 'cluster':
                const chain = getTaskChain(task_id);
                if (chain.length > 0) {
                    const directParentId = chain[chain.length - 1].parentTaskId;
                    if (directParentId) {
                        const siblings = skeletons.filter(s => s.parentTaskId === directParentId);
                        // Display parent, then all its children (siblings of the target + target itself)
                        const parentTask = skeletonMap.get(directParentId);
                        if(parentTask) tasksToDisplay.push(parentTask);
                        tasksToDisplay.push(...siblings);
                    } else {
                         tasksToDisplay = chain; // It's a root task, show its chain
                    }
                } else {
                     tasksToDisplay.push(mainTask);
                }
                break;
        }
        
        let formattedOutput = `Conversation Tree (Mode: ${view_mode})\n======================================\n`;
        tasksToDisplay.forEach((task, index) => {
            const indent = '  '.repeat(index);
            formattedOutput += formatTask(task, indent);
        });

        return { content: [{ type: 'text', text: formattedOutput }] };
    }

    async handleSearchTasksSemantic(args: { conversation_id: string, search_query: string, max_results?: number }): Promise<CallToolResult> {
        const { conversation_id, search_query, max_results = 10 } = args;
        const skeleton = this.conversationCache.get(conversation_id);

        if (!skeleton) {
            throw new Error(`Conversation with ID '${conversation_id}' not found in cache.`);
        }

        const query = search_query.toLowerCase();
        const results: any[] = [];

        for (const item of skeleton.sequence) {
            if (results.length >= max_results) {
                break;
            }
            // Check only message content for this basic implementation
            if ('content' in item && typeof item.content === 'string' && item.content.toLowerCase().includes(query)) {
                results.push({
                    taskId: skeleton.taskId,
                    // Simple score based on presence. A real implementation would be more complex.
                    score: 1.0,
                    match: `Found in role '${item.role}': ${this.truncateMessage(item.content, 2)}`
                });
            }
        }

        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }


    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Roo State Manager Server started (new features re-added).');
    }
}

try {
    const server = new RooStateManagerServer();
    server.run().catch((error) => {
        console.error('Fatal error during server execution:', error);
        process.exit(1);
    });
} catch (error) {
    console.error('Fatal error during server initialization:', error);
    process.exit(1);
}

export { RooStateManagerServer };