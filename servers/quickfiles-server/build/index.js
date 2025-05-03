#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
/**
 * Valide les arguments de la méthode read_multiple_files
 *
 * @function isValidReadMultipleFilesArgs
 * @param {any} args - Arguments à valider
 * @returns {boolean} - true si les arguments sont valides, false sinon
 */
const isValidReadMultipleFilesArgs = (args) => {
    if (typeof args !== 'object' || args === null)
        return false;
    // Vérification du tableau paths
    if (!Array.isArray(args.paths))
        return false;
    // Vérification de chaque élément du tableau paths
    for (const item of args.paths) {
        if (typeof item === 'string') {
            // Format simple: chemin de fichier
            continue;
        }
        else if (typeof item === 'object' && item !== null) {
            // Format avancé: objet avec path et excerpts
            if (typeof item.path !== 'string')
                return false;
            // Vérification des excerpts si présents
            if (item.excerpts !== undefined) {
                if (!Array.isArray(item.excerpts))
                    return false;
                for (const excerpt of item.excerpts) {
                    if (typeof excerpt !== 'object' || excerpt === null)
                        return false;
                    if (typeof excerpt.start !== 'number' || typeof excerpt.end !== 'number')
                        return false;
                    if (excerpt.start < 1 || excerpt.end < excerpt.start)
                        return false;
                }
            }
        }
        else {
            return false;
        }
    }
    // Vérification des autres paramètres
    if (args.show_line_numbers !== undefined && typeof args.show_line_numbers !== 'boolean')
        return false;
    if (args.max_lines_per_file !== undefined && typeof args.max_lines_per_file !== 'number')
        return false;
    if (args.max_total_lines !== undefined && typeof args.max_total_lines !== 'number')
        return false;
    return true;
};
/**
 * Valide les arguments de la méthode list_directory_contents
 *
 * @function isValidListDirectoryContentsArgs
 * @param {any} args - Arguments à valider
 * @returns {boolean} - true si les arguments sont valides, false sinon
 */
const isValidListDirectoryContentsArgs = (args) => {
    if (typeof args !== 'object' || args === null)
        return false;
    // Vérification du tableau paths
    if (!Array.isArray(args.paths))
        return false;
    // Vérification de chaque élément du tableau paths
    for (const item of args.paths) {
        if (typeof item === 'string') {
            // Format simple: chemin de répertoire
            continue;
        }
        else if (typeof item === 'object' && item !== null) {
            // Format avancé: objet avec path et recursive
            if (typeof item.path !== 'string')
                return false;
            if (item.recursive !== undefined && typeof item.recursive !== 'boolean')
                return false;
        }
        else {
            return false;
        }
    }
    // Vérification du paramètre max_lines
    if (args.max_lines !== undefined && typeof args.max_lines !== 'number')
        return false;
    return true;
};
/**
 * Valide les arguments de la méthode delete_files
 *
 * @function isValidDeleteFilesArgs
 * @param {any} args - Arguments à valider
 * @returns {boolean} - true si les arguments sont valides, false sinon
 */
const isValidDeleteFilesArgs = (args) => {
    if (typeof args !== 'object' || args === null)
        return false;
    // Vérification du tableau paths
    if (!Array.isArray(args.paths))
        return false;
    // Vérification que chaque élément est une chaîne
    for (const path of args.paths) {
        if (typeof path !== 'string')
            return false;
    }
    return true;
};
/**
 * Valide les arguments de la méthode edit_multiple_files
 *
 * @function isValidEditMultipleFilesArgs
 * @param {any} args - Arguments à valider
 * @returns {boolean} - true si les arguments sont valides, false sinon
 */
const isValidEditMultipleFilesArgs = (args) => {
    if (typeof args !== 'object' || args === null)
        return false;
    // Vérification du tableau files
    if (!Array.isArray(args.files))
        return false;
    // Vérification de chaque élément du tableau files
    for (const file of args.files) {
        if (typeof file !== 'object' || file === null)
            return false;
        if (typeof file.path !== 'string')
            return false;
        // Vérification du tableau diffs
        if (!Array.isArray(file.diffs))
            return false;
        // Vérification de chaque élément du tableau diffs
        for (const diff of file.diffs) {
            if (typeof diff !== 'object' || diff === null)
                return false;
            if (typeof diff.search !== 'string')
                return false;
            if (typeof diff.replace !== 'string')
                return false;
            if (diff.start_line !== undefined && typeof diff.start_line !== 'number')
                return false;
        }
    }
    return true;
};
/**
 * Classe principale du serveur QuickFiles
 *
 * Cette classe implémente un serveur MCP qui fournit des méthodes pour lire rapidement
 * le contenu de répertoires et fichiers multiples, ainsi que pour supprimer et éditer des fichiers.
 *
 * @class QuickFilesServer
 */
class QuickFilesServer {
    /**
     * Crée une instance du serveur QuickFiles
     *
     * @constructor
     */
    constructor() {
        this.server = new Server({
            name: 'quickfiles-server',
            version: '0.1.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
        // Gestion des erreurs
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    /**
     * Configure les gestionnaires d'outils MCP
     *
     * @private
     * @method setupToolHandlers
     */
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'read_multiple_files',
                    description: 'Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            paths: {
                                oneOf: [
                                    {
                                        type: 'array',
                                        items: {
                                            type: 'string'
                                        },
                                        description: 'Tableau des chemins de fichiers à lire',
                                    },
                                    {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                path: {
                                                    type: 'string',
                                                    description: 'Chemin du fichier à lire',
                                                },
                                                excerpts: {
                                                    type: 'array',
                                                    items: {
                                                        type: 'object',
                                                        properties: {
                                                            start: {
                                                                type: 'number',
                                                                description: 'Numéro de la première ligne de l\'extrait (commençant à 1)',
                                                            },
                                                            end: {
                                                                type: 'number',
                                                                description: 'Numéro de la dernière ligne de l\'extrait (incluse)',
                                                            },
                                                        },
                                                        required: ['start', 'end'],
                                                    },
                                                    description: 'Liste des extraits à lire dans le fichier',
                                                },
                                            },
                                            required: ['path'],
                                        },
                                        description: 'Tableau des fichiers avec extraits à lire',
                                    },
                                ],
                                description: 'Chemins des fichiers à lire (format simple ou avec extraits)',
                            },
                            show_line_numbers: {
                                type: 'boolean',
                                description: 'Afficher les numéros de ligne',
                                default: false,
                            },
                            max_lines_per_file: {
                                type: 'number',
                                description: 'Nombre maximum de lignes à afficher par fichier',
                                default: 2000,
                            },
                            max_total_lines: {
                                type: 'number',
                                description: 'Nombre maximum total de lignes à afficher pour tous les fichiers',
                                default: 5000,
                            },
                        },
                        required: ['paths'],
                    },
                },
                {
                    name: 'list_directory_contents',
                    description: 'Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            paths: {
                                oneOf: [
                                    {
                                        type: 'array',
                                        items: {
                                            type: 'string'
                                        },
                                        description: 'Tableau des chemins de répertoires à lister',
                                    },
                                    {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                path: {
                                                    type: 'string',
                                                    description: 'Chemin du répertoire à lister',
                                                },
                                                recursive: {
                                                    type: 'boolean',
                                                    description: 'Lister récursivement les sous-répertoires',
                                                    default: true,
                                                },
                                            },
                                            required: ['path'],
                                        },
                                        description: 'Tableau des répertoires à lister avec options',
                                    },
                                ],
                                description: 'Chemins des répertoires à lister (format simple ou avec options)',
                            },
                            max_lines: {
                                type: 'number',
                                description: 'Nombre maximum de lignes à afficher dans la sortie',
                                default: 2000,
                            },
                        },
                        required: ['paths'],
                    },
                },
                {
                    name: 'delete_files',
                    description: 'Supprime une liste de fichiers en une seule opération',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            paths: {
                                type: 'array',
                                items: {
                                    type: 'string'
                                },
                                description: 'Tableau des chemins de fichiers à supprimer',
                            },
                        },
                        required: ['paths'],
                    },
                },
                {
                    name: 'edit_multiple_files',
                    description: 'Édite plusieurs fichiers en une seule opération en appliquant des diffs',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            files: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        path: {
                                            type: 'string',
                                            description: 'Chemin du fichier à éditer',
                                        },
                                        diffs: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    search: {
                                                        type: 'string',
                                                        description: 'Texte à rechercher',
                                                    },
                                                    replace: {
                                                        type: 'string',
                                                        description: 'Texte de remplacement',
                                                    },
                                                    start_line: {
                                                        type: 'number',
                                                        description: 'Numéro de ligne où commencer la recherche (optionnel)',
                                                    },
                                                },
                                                required: ['search', 'replace'],
                                            },
                                            description: 'Liste des diffs à appliquer au fichier',
                                        },
                                    },
                                    required: ['path', 'diffs'],
                                },
                                description: 'Tableau des fichiers à éditer avec leurs diffs',
                            },
                        },
                        required: ['files'],
                    },
                },
            ],
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name === 'read_multiple_files') {
                return this.handleReadMultipleFiles(request);
            }
            else if (request.params.name === 'list_directory_contents') {
                return this.handleListDirectoryContents(request);
            }
            else if (request.params.name === 'delete_files') {
                return this.handleDeleteFiles(request);
            }
            else if (request.params.name === 'edit_multiple_files') {
                return this.handleEditMultipleFiles(request);
            }
            else {
                throw new McpError(ErrorCode.MethodNotFound, `Outil inconnu: ${request.params.name}`);
            }
        });
    }
    /**
     * Gère les requêtes pour l'outil read_multiple_files
     *
     * @private
     * @method handleReadMultipleFiles
     * @param {any} request - Requête MCP
     * @returns {Promise<any>} - Réponse formatée avec le contenu des fichiers
     * @throws {McpError} - Erreur si les paramètres sont invalides
     */
    async handleReadMultipleFiles(request) {
        if (!isValidReadMultipleFilesArgs(request.params.arguments)) {
            throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour read_multiple_files');
        }
        const { paths, show_line_numbers = false, max_lines_per_file = 2000, max_total_lines = 5000 } = request.params.arguments;
        try {
            const results = await Promise.all(paths.map(async (item) => {
                // Déterminer le chemin du fichier et les extraits
                const filePath = typeof item === 'string' ? item : item.path;
                const excerpts = typeof item === 'object' && item.excerpts ? item.excerpts : undefined;
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    let lines = content.split('\n');
                    // Appliquer les extraits si spécifiés
                    if (excerpts && excerpts.length > 0) {
                        const extractedLines = [];
                        for (const excerpt of excerpts) {
                            // Ajuster les indices pour correspondre au tableau 0-indexé
                            const startIdx = Math.max(0, excerpt.start - 1);
                            const endIdx = Math.min(lines.length - 1, excerpt.end - 1);
                            if (extractedLines.length > 0) {
                                extractedLines.push('...');
                            }
                            extractedLines.push(...lines.slice(startIdx, endIdx + 1).map((line, idx) => {
                                return show_line_numbers ? `${startIdx + idx + 1} | ${line}` : line;
                            }));
                        }
                        lines = extractedLines;
                    }
                    else {
                        // Appliquer la limite de lignes si spécifiée
                        if (max_lines_per_file && lines.length > max_lines_per_file) {
                            lines = lines.slice(0, max_lines_per_file);
                            lines.push(`... (${lines.length - max_lines_per_file} lignes supplémentaires non affichées)`);
                        }
                        // Appliquer la numérotation de lignes si demandée
                        if (show_line_numbers) {
                            lines = lines.map((line, idx) => `${idx + 1} | ${line}`);
                        }
                    }
                    return {
                        path: filePath,
                        exists: true,
                        content: lines.join('\n'),
                        error: null,
                    };
                }
                catch (error) {
                    return {
                        path: filePath,
                        exists: false,
                        content: null,
                        error: `Erreur lors de la lecture du fichier: ${error.message}`,
                    };
                }
            }));
            // Compter le nombre total de lignes dans tous les fichiers
            let totalLines = 0;
            const processedResults = results.map(result => {
                if (result.exists) {
                    const lineCount = result.content.split('\n').length;
                    totalLines += lineCount;
                    return {
                        ...result,
                        lineCount
                    };
                }
                return result;
            });
            // Limiter le nombre total de lignes si nécessaire
            let totalLinesExceeded = false;
            if (totalLines > max_total_lines) {
                totalLinesExceeded = true;
                let remainingLines = max_total_lines;
                for (let i = 0; i < processedResults.length; i++) {
                    const result = processedResults[i];
                    if (!result.exists)
                        continue;
                    const lines = result.content.split('\n');
                    const linesToKeep = Math.min(lines.length, remainingLines);
                    if (linesToKeep < lines.length) {
                        lines.splice(linesToKeep);
                        lines.push(`... (${result.lineCount - linesToKeep} lignes supplémentaires non affichées)`);
                        result.content = lines.join('\n');
                    }
                    remainingLines -= linesToKeep;
                    if (remainingLines <= 0)
                        break;
                }
            }
            // Formatage de la réponse pour une meilleure lisibilité
            const formattedResponse = processedResults.map(result => {
                if (result.exists) {
                    return `## Fichier: ${result.path}\n\`\`\`\n${result.content}\n\`\`\`\n`;
                }
                else {
                    return `## Fichier: ${result.path}\n**ERREUR**: ${result.error}\n`;
                }
            }).join('\n') + (totalLinesExceeded ? `\n\n**Note**: Certains fichiers ont été tronqués car le nombre total de lignes dépasse la limite de ${max_total_lines}.` : '');
            return {
                content: [
                    {
                        type: 'text',
                        text: formattedResponse,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Erreur lors de la lecture des fichiers: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    }
    /**
     * Gère les requêtes pour l'outil list_directory_contents
     *
     * @private
     * @method handleListDirectoryContents
     * @param {any} request - Requête MCP
     * @returns {Promise<any>} - Réponse formatée avec le contenu des répertoires
     * @throws {McpError} - Erreur si les paramètres sont invalides
     */
    async handleListDirectoryContents(request) {
        if (!isValidListDirectoryContentsArgs(request.params.arguments)) {
            throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour list_directory_contents');
        }
        const { paths, max_lines = 2000 } = request.params.arguments;
        try {
            const results = await Promise.all(paths.map(async (item) => {
                // Déterminer le chemin du répertoire et l'option recursive
                const dirPath = typeof item === 'string' ? item : item.path;
                const recursive = typeof item === 'object' && item.recursive !== undefined ? item.recursive : true;
                try {
                    // Vérifier que le chemin existe et est un répertoire
                    const stats = await fs.stat(dirPath);
                    if (!stats.isDirectory()) {
                        return {
                            path: dirPath,
                            exists: false,
                            error: `Le chemin spécifié n'est pas un répertoire: ${dirPath}`,
                        };
                    }
                    // Lister le contenu du répertoire
                    const contents = await this.listDirectoryContentsRecursive(dirPath, recursive);
                    return {
                        path: dirPath,
                        exists: true,
                        contents,
                        error: null,
                    };
                }
                catch (error) {
                    return {
                        path: dirPath,
                        exists: false,
                        contents: null,
                        error: `Erreur lors du listage du répertoire: ${error.message}`,
                    };
                }
            }));
            // Formatage de la réponse pour une meilleure lisibilité
            let formattedResponse = results.map(result => {
                if (result.exists) {
                    return this.formatDirectoryContents(result.path, result.contents);
                }
                else {
                    return `## Répertoire: ${result.path}\n**ERREUR**: ${result.error}\n`;
                }
            }).join('\n');
            // Limiter le nombre de lignes dans la sortie
            const lines = formattedResponse.split('\n');
            if (lines.length > max_lines) {
                formattedResponse = lines.slice(0, max_lines).join('\n') +
                    `\n\n... (${lines.length - max_lines} lignes supplémentaires non affichées)`;
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: formattedResponse,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Erreur lors du listage des répertoires: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    }
    /**
     * Formate le contenu d'un répertoire pour l'affichage
     *
     * @private
     * @method formatDirectoryContents
     * @param {string} dirPath - Chemin du répertoire
     * @param {any[]} contents - Contenu du répertoire
     * @returns {string} - Contenu formaté
     */
    formatDirectoryContents(dirPath, contents) {
        let result = `## Répertoire: ${dirPath}\n`;
        // Fonction récursive pour formater le contenu
        const formatContents = (items, indent = '') => {
            let output = '';
            for (const item of items) {
                if (item.type === 'directory') {
                    output += `${indent}📁 ${item.name}/\n`;
                    if (item.children && item.children.length > 0) {
                        output += formatContents(item.children, indent + '  ');
                    }
                }
                else {
                    const sizeStr = this.formatFileSize(item.size);
                    const lineCountStr = item.lineCount ? ` (${item.lineCount} lignes)` : '';
                    output += `${indent}📄 ${item.name} - ${sizeStr}${lineCountStr}\n`;
                }
            }
            return output;
        };
        result += formatContents(contents);
        return result;
    }
    /**
     * Formate la taille d'un fichier en unités lisibles (B, KB, MB, GB)
     *
     * @private
     * @method formatFileSize
     * @param {number} bytes - Taille en octets
     * @returns {string} - Taille formatée
     */
    formatFileSize(bytes) {
        if (bytes < 1024)
            return `${bytes} B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024)
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    /**
     * Liste récursivement le contenu d'un répertoire
     *
     * @private
     * @method listDirectoryContentsRecursive
     * @param {string} dirPath - Chemin du répertoire
     * @param {boolean} recursive - Lister récursivement les sous-répertoires
     * @returns {Promise<any[]>} - Contenu du répertoire
     */
    async listDirectoryContentsRecursive(dirPath, recursive) {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            const stats = await fs.stat(entryPath);
            if (entry.isDirectory()) {
                const item = {
                    name: entry.name,
                    path: entryPath,
                    type: 'directory',
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                    children: recursive ? await this.listDirectoryContentsRecursive(entryPath, recursive) : [],
                };
                result.push(item);
            }
            else {
                // Compter le nombre de lignes pour les fichiers texte
                let lineCount = undefined;
                try {
                    // Vérifier si c'est probablement un fichier texte par l'extension
                    const textFileExtensions = ['.txt', '.md', '.js', '.ts', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.sh', '.bat', '.ps1'];
                    const ext = path.extname(entry.name).toLowerCase();
                    if (textFileExtensions.includes(ext) && stats.size < 10 * 1024 * 1024) { // Limiter à 10 Mo
                        const content = await fs.readFile(entryPath, 'utf-8');
                        lineCount = content.split('\n').length;
                    }
                }
                catch (error) {
                    // Ignorer les erreurs de lecture de fichier
                }
                const item = {
                    name: entry.name,
                    path: entryPath,
                    type: 'file',
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                    lineCount,
                };
                result.push(item);
            }
        }
        return result;
    }
    /**
     * Gère les requêtes pour l'outil delete_files
     *
     * @private
     * @method handleDeleteFiles
     * @param {any} request - Requête MCP
     * @returns {Promise<any>} - Réponse formatée avec le résultat de la suppression
     * @throws {McpError} - Erreur si les paramètres sont invalides
     */
    async handleDeleteFiles(request) {
        if (!isValidDeleteFilesArgs(request.params.arguments)) {
            throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour delete_files');
        }
        const { paths } = request.params.arguments;
        try {
            const results = await Promise.all(paths.map(async (filePath) => {
                try {
                    // Vérifier que le fichier existe avant de le supprimer
                    await fs.access(filePath);
                    await fs.unlink(filePath);
                    return {
                        path: filePath,
                        success: true,
                        error: null,
                    };
                }
                catch (error) {
                    return {
                        path: filePath,
                        success: false,
                        error: `Erreur lors de la suppression du fichier: ${error.message}`,
                    };
                }
            }));
            // Formatage de la réponse pour une meilleure lisibilité
            const formattedResponse = results.map(result => {
                if (result.success) {
                    return `✅ Fichier supprimé: ${result.path}`;
                }
                else {
                    return `❌ Échec de suppression: ${result.path} - ${result.error}`;
                }
            }).join('\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: formattedResponse,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Erreur lors de la suppression des fichiers: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    }
    /**
     * Gère les requêtes pour l'outil edit_multiple_files
     *
     * @private
     * @method handleEditMultipleFiles
     * @param {any} request - Requête MCP
     * @returns {Promise<any>} - Réponse formatée avec le résultat de l'édition
     * @throws {McpError} - Erreur si les paramètres sont invalides
     */
    async handleEditMultipleFiles(request) {
        if (!isValidEditMultipleFilesArgs(request.params.arguments)) {
            throw new McpError(ErrorCode.InvalidParams, 'Paramètres invalides pour edit_multiple_files');
        }
        const { files } = request.params.arguments;
        try {
            const results = await Promise.all(files.map(async (file) => {
                try {
                    // Lire le contenu du fichier
                    const content = await fs.readFile(file.path, 'utf-8');
                    let modifiedContent = content;
                    let hasChanges = false;
                    // Appliquer chaque diff
                    for (const diff of file.diffs) {
                        // Si start_line est spécifié, limiter la recherche à partir de cette ligne
                        if (diff.start_line !== undefined) {
                            const lines = modifiedContent.split('\n');
                            const startIdx = Math.max(0, diff.start_line - 1);
                            if (startIdx >= lines.length) {
                                continue; // Ignorer ce diff si start_line est hors limites
                            }
                            const beforeLines = lines.slice(0, startIdx).join('\n');
                            const searchArea = lines.slice(startIdx).join('\n');
                            // Appliquer le remplacement uniquement dans la zone de recherche
                            const modifiedSearchArea = searchArea.replace(diff.search, diff.replace);
                            if (searchArea !== modifiedSearchArea) {
                                modifiedContent = beforeLines + (beforeLines ? '\n' : '') + modifiedSearchArea;
                                hasChanges = true;
                            }
                        }
                        else {
                            // Appliquer le remplacement sur tout le contenu
                            const newContent = modifiedContent.replace(diff.search, diff.replace);
                            if (newContent !== modifiedContent) {
                                modifiedContent = newContent;
                                hasChanges = true;
                            }
                        }
                    }
                    // Écrire le contenu modifié si des changements ont été effectués
                    if (hasChanges) {
                        await fs.writeFile(file.path, modifiedContent, 'utf-8');
                    }
                    return {
                        path: file.path,
                        success: true,
                        modified: hasChanges,
                        error: null,
                    };
                }
                catch (error) {
                    return {
                        path: file.path,
                        success: false,
                        modified: false,
                        error: `Erreur lors de l'édition du fichier: ${error.message}`,
                    };
                }
            }));
            // Formatage de la réponse pour une meilleure lisibilité
            const formattedResponse = results.map(result => {
                if (result.success) {
                    return result.modified
                        ? `✅ Fichier modifié: ${result.path}`
                        : `ℹ️ Aucune modification: ${result.path}`;
                }
                else {
                    return `❌ Échec d'édition: ${result.path} - ${result.error}`;
                }
            }).join('\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: formattedResponse,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Erreur lors de l'édition des fichiers: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    }
    /**
     * Démarre le serveur MCP sur stdio
     *
     * @method run
     * @returns {Promise<void>}
     */
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('QuickFiles MCP server running on stdio');
    }
}
const server = new QuickFilesServer();
server.run().catch(console.error);
//# sourceMappingURL=index.js.map