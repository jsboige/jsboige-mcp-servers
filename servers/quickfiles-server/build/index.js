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
    if (args.max_chars_per_file !== undefined && typeof args.max_chars_per_file !== 'number')
        return false;
    if (args.max_total_chars !== undefined && typeof args.max_total_chars !== 'number')
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
            // Format avancé: objet avec path et options
            if (typeof item.path !== 'string')
                return false;
            if (item.recursive !== undefined && typeof item.recursive !== 'boolean')
                return false;
            if (item.file_pattern !== undefined && typeof item.file_pattern !== 'string')
                return false;
            if (item.sort_by !== undefined && !['name', 'size', 'modified', 'type'].includes(item.sort_by))
                return false;
            if (item.sort_order !== undefined && !['asc', 'desc'].includes(item.sort_order))
                return false;
        }
        else {
            return false;
        }
    }
    // Vérification des paramètres globaux
    if (args.max_lines !== undefined && typeof args.max_lines !== 'number')
        return false;
    if (args.file_pattern !== undefined && typeof args.file_pattern !== 'string')
        return false;
    if (args.sort_by !== undefined && !['name', 'size', 'modified', 'type'].includes(args.sort_by))
        return false;
    if (args.sort_order !== undefined && !['asc', 'desc'].includes(args.sort_order))
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
                    description: 'Lit plusieurs fichiers en une seule requête avec numérotation de lignes optionnelle et extraits de fichiers. Tronque automatiquement les contenus volumineux pour éviter les problèmes de mémoire et de performance.',
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
                            max_chars_per_file: {
                                type: 'number',
                                description: 'Nombre maximum de caractères à afficher par fichier (évite les problèmes de mémoire avec les gros fichiers)',
                                default: 160000,
                            },
                            max_total_chars: {
                                type: 'number',
                                description: 'Nombre maximum total de caractères à afficher pour tous les fichiers',
                                default: 400000,
                            },
                        },
                        required: ['paths'],
                    },
                },
                {
                    name: 'list_directory_contents',
                    description: 'Liste tous les fichiers et répertoires sous un chemin donné, avec la taille des fichiers et le nombre de lignes. Tronque automatiquement les résultats volumineux pour éviter les problèmes de performance.',
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
                                                file_pattern: {
                                                    type: 'string',
                                                    description: 'Motif glob pour filtrer les fichiers (ex: *.js, *.{js,ts})',
                                                },
                                                sort_by: {
                                                    type: 'string',
                                                    enum: ['name', 'size', 'modified', 'type'],
                                                    description: 'Critère de tri des fichiers et répertoires',
                                                    default: 'name',
                                                },
                                                sort_order: {
                                                    type: 'string',
                                                    enum: ['asc', 'desc'],
                                                    description: 'Ordre de tri (ascendant ou descendant)',
                                                    default: 'asc',
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
                            file_pattern: {
                                type: 'string',
                                description: 'Motif glob global pour filtrer les fichiers (ex: *.js, *.{js,ts})',
                            },
                            sort_by: {
                                type: 'string',
                                enum: ['name', 'size', 'modified', 'type'],
                                description: 'Critère de tri global des fichiers et répertoires',
                                default: 'name',
                            },
                            sort_order: {
                                type: 'string',
                                enum: ['asc', 'desc'],
                                description: 'Ordre de tri global (ascendant ou descendant)',
                                default: 'asc',
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
        const { paths, show_line_numbers = false, max_lines_per_file = 2000, max_total_lines = 5000, max_chars_per_file = 160000, // ~80 caractères par ligne * 2000 lignes
        max_total_chars = 400000 // ~80 caractères par ligne * 5000 lignes
         } = request.params.arguments;
        try {
            const results = await Promise.all(paths.map(async (item) => {
                // Déterminer le chemin du fichier et les extraits
                const filePath = typeof item === 'string' ? item : item.path;
                const excerpts = typeof item === 'object' && item.excerpts ? item.excerpts : undefined;
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    let lines = content.split('\n');
                    let totalChars = content.length;
                    let charsTruncated = false;
                    // Appliquer les extraits si spécifiés
                    if (excerpts && excerpts.length > 0) {
                        const extractedLines = [];
                        let extractedChars = 0;
                        for (const excerpt of excerpts) {
                            // Ajuster les indices pour correspondre au tableau 0-indexé
                            const startIdx = Math.max(0, excerpt.start - 1);
                            const endIdx = Math.min(lines.length - 1, excerpt.end - 1);
                            if (extractedLines.length > 0) {
                                extractedLines.push('...');
                                extractedChars += 3;
                            }
                            const excerptLines = lines.slice(startIdx, endIdx + 1).map((line, idx) => {
                                return show_line_numbers ? `${startIdx + idx + 1} | ${line}` : line;
                            });
                            // Calculer le nombre de caractères dans cet extrait
                            const excerptChars = excerptLines.reduce((sum, line) => sum + line.length + 1, 0); // +1 pour le \n
                            // Vérifier si l'ajout de cet extrait dépasserait la limite de caractères
                            if (max_chars_per_file && extractedChars + excerptChars > max_chars_per_file) {
                                // Ajouter autant de lignes que possible sans dépasser la limite
                                let charsAdded = 0;
                                for (const line of excerptLines) {
                                    if (extractedChars + charsAdded + line.length + 1 <= max_chars_per_file) {
                                        extractedLines.push(line);
                                        charsAdded += line.length + 1;
                                    }
                                    else {
                                        charsTruncated = true;
                                        break;
                                    }
                                }
                                if (charsTruncated) {
                                    extractedLines.push(`... (contenu tronqué: limite de ${max_chars_per_file} caractères atteinte)`);
                                    break; // Sortir de la boucle des extraits
                                }
                            }
                            else {
                                extractedLines.push(...excerptLines);
                                extractedChars += excerptChars;
                            }
                        }
                        lines = extractedLines;
                    }
                    else {
                        // Appliquer la limite de caractères si spécifiée
                        if (max_chars_per_file && totalChars > max_chars_per_file) {
                            // Trouver combien de lignes on peut inclure sans dépasser la limite de caractères
                            let charsCount = 0;
                            let i = 0;
                            for (; i < lines.length; i++) {
                                charsCount += lines[i].length + 1; // +1 pour le \n
                                if (charsCount > max_chars_per_file) {
                                    break;
                                }
                            }
                            lines = lines.slice(0, i);
                            lines.push(`... (contenu tronqué: ${totalChars - charsCount} caractères supplémentaires non affichés, taille totale: ${this.formatFileSize(totalChars)})`);
                            charsTruncated = true;
                        }
                        // Appliquer la limite de lignes si spécifiée et si la limite de caractères n'a pas déjà tronqué le contenu
                        if (!charsTruncated && max_lines_per_file && lines.length > max_lines_per_file) {
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
            // Compter le nombre total de lignes et de caractères dans tous les fichiers
            let totalLines = 0;
            let totalChars = 0;
            const processedResults = results.map(result => {
                if (result.exists) {
                    const lineCount = result.content.split('\n').length;
                    const charCount = result.content.length;
                    totalLines += lineCount;
                    totalChars += charCount;
                    return {
                        ...result,
                        lineCount,
                        charCount
                    };
                }
                return result;
            });
            // Variables pour suivre si les limites sont dépassées
            let totalLinesExceeded = false;
            let totalCharsExceeded = false;
            // Limiter le nombre total de caractères si nécessaire
            if (totalChars > max_total_chars) {
                totalCharsExceeded = true;
                let remainingChars = max_total_chars;
                for (let i = 0; i < processedResults.length; i++) {
                    const result = processedResults[i];
                    if (!result.exists)
                        continue;
                    const charCount = result.charCount;
                    const charsToKeep = Math.min(charCount, remainingChars);
                    if (charsToKeep < charCount) {
                        // Tronquer le contenu pour respecter la limite de caractères
                        const content = result.content;
                        result.content = content.substring(0, charsToKeep) +
                            `\n\n... (contenu tronqué: ${charCount - charsToKeep} caractères supplémentaires non affichés, taille totale: ${this.formatFileSize(charCount)})`;
                        // Recalculer le nombre de lignes après troncature
                        result.lineCount = result.content.split('\n').length;
                    }
                    remainingChars -= charsToKeep;
                    if (remainingChars <= 0)
                        break;
                }
            }
            // Limiter le nombre total de lignes si nécessaire (seulement si la limite de caractères n'a pas déjà été appliquée)
            else if (totalLines > max_total_lines) {
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
                        // Mettre à jour le nombre de caractères après troncature
                        result.charCount = result.content.length;
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
            }).join('\n') +
                (totalCharsExceeded ? `\n\n**Note**: Certains fichiers ont été tronqués car le nombre total de caractères dépasse la limite de ${max_total_chars} (${this.formatFileSize(max_total_chars)}).` :
                    totalLinesExceeded ? `\n\n**Note**: Certains fichiers ont été tronqués car le nombre total de lignes dépasse la limite de ${max_total_lines}.` : '');
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
    /**
     * Gère les requêtes pour l'outil list_directory_contents
     *
     * @private
     * @method handleListDirectoryContents
     * @param {any} request - Requête MCP
     * @returns {Promise<any>} - Réponse formatée avec le contenu des répertoires
     * @throws {McpError} - Erreur si les paramètres sont invalides
     */
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
        const { paths, max_lines = 2000, file_pattern: globalFilePattern, sort_by: globalSortBy = 'name', sort_order: globalSortOrder = 'asc' } = request.params.arguments;
        try {
            // Journalisation détaillée des options de tri pour le débogage
            console.error(`[DEBUG] Options de tri globales: critère=${globalSortBy}, ordre=${globalSortOrder}, filtre=${globalFilePattern || 'aucun'}`);
            console.error(`[DEBUG] Nombre de chemins à traiter: ${paths.length}`);
            const results = await Promise.all(paths.map(async (item, index) => {
                // Déterminer le chemin du répertoire et les options
                const dirPath = typeof item === 'string' ? item : item.path;
                const recursive = typeof item === 'object' && item.recursive !== undefined ? item.recursive : true;
                // Utiliser les options spécifiques à ce répertoire ou les options globales
                const filePattern = typeof item === 'object' && item.file_pattern !== undefined
                    ? item.file_pattern
                    : globalFilePattern;
                const sortBy = typeof item === 'object' && item.sort_by !== undefined
                    ? item.sort_by
                    : globalSortBy;
                const sortOrder = typeof item === 'object' && item.sort_order !== undefined
                    ? item.sort_order
                    : globalSortOrder;
                // Journalisation détaillée des options de tri spécifiques pour le débogage
                console.error(`[DEBUG] Répertoire #${index + 1}: ${dirPath}`);
                console.error(`[DEBUG] Options: recursive=${recursive}, critère=${sortBy}, ordre=${sortOrder}, filtre=${filePattern || 'aucun'}`);
                try {
                    // Vérifier que le chemin existe et est un répertoire
                    const stats = await fs.stat(dirPath);
                    if (!stats.isDirectory()) {
                        console.error(`[ERROR] Le chemin n'est pas un répertoire: ${dirPath}`);
                        return {
                            path: dirPath,
                            exists: false,
                            error: `Le chemin spécifié n'est pas un répertoire: ${dirPath}`,
                        };
                    }
                    console.error(`[DEBUG] Début du listage récursif pour ${dirPath}`);
                    // Lister le contenu du répertoire avec les options de filtrage et de tri
                    const contents = await this.listDirectoryContentsRecursive(dirPath, recursive, filePattern, sortBy, sortOrder);
                    console.error(`[DEBUG] Fin du listage récursif pour ${dirPath}, ${contents.length} éléments trouvés`);
                    return {
                        path: dirPath,
                        exists: true,
                        contents,
                        error: null,
                        // Stocker les options de tri utilisées pour référence
                        sortOptions: { sortBy, sortOrder }
                    };
                }
                catch (error) {
                    console.error(`[ERROR] Erreur lors du listage du répertoire ${dirPath}: ${error.message}`);
                    return {
                        path: dirPath,
                        exists: false,
                        contents: null,
                        error: `Erreur lors du listage du répertoire: ${error.message}`,
                    };
                }
            }));
            console.error(`[DEBUG] Tous les répertoires ont été traités, formatage de la réponse`);
            // Formatage de la réponse pour une meilleure lisibilité
            let formattedResponse = results.map((result, index) => {
                if (result.exists) {
                    console.error(`[DEBUG] Formatage du répertoire #${index + 1}: ${result.path} (${result.contents.length} éléments)`);
                    // Utiliser les contenus déjà triés
                    return this.formatDirectoryContents(result.path, result.contents);
                }
                else {
                    console.error(`[DEBUG] Erreur pour le répertoire #${index + 1}: ${result.path}`);
                    return `## Répertoire: ${result.path}\n**ERREUR**: ${result.error}\n`;
                }
            }).join('\n');
            // Limiter le nombre de lignes dans la sortie
            const lines = formattedResponse.split('\n');
            console.error(`[DEBUG] Nombre total de lignes dans la réponse: ${lines.length}`);
            if (lines.length > max_lines) {
                console.error(`[DEBUG] Troncature de la réponse à ${max_lines} lignes`);
                formattedResponse = lines.slice(0, max_lines).join('\n') +
                    `\n\n... (${lines.length - max_lines} lignes supplémentaires non affichées)`;
            }
            console.error(`[DEBUG] Réponse formatée avec succès`);
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
            console.error(`[ERROR] Erreur globale: ${error.message}`);
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
    /**
     * Formate le contenu d'un répertoire pour l'affichage
     *
     * @private
     * @method formatDirectoryContents
     * @param {string} dirPath - Chemin du répertoire
     * @param {any[]} contents - Contenu du répertoire (déjà trié)
     * @returns {string} - Contenu formaté
     */
    /**
     * Formate le contenu d'un répertoire pour l'affichage
     *
     * @private
     * @method formatDirectoryContents
     * @param {string} dirPath - Chemin du répertoire
     * @param {any[]} contents - Contenu du répertoire (déjà trié)
     * @returns {string} - Contenu formaté
     */
    formatDirectoryContents(dirPath, contents) {
        console.error(`[DEBUG] Formatage du répertoire: ${dirPath} avec ${contents.length} éléments`);
        // Compter les fichiers et répertoires pour le résumé
        const dirCount = contents.filter(item => item.type === 'directory').length;
        const fileCount = contents.filter(item => item.type === 'file').length;
        // Créer l'en-tête avec des informations sur le contenu
        let result = `## Répertoire: ${dirPath}\n`;
        result += `> Contenu: ${contents.length} éléments (${dirCount} répertoires, ${fileCount} fichiers)\n\n`;
        // Fonction récursive pour formater le contenu
        const formatContents = (items, indent = '', depth = 0) => {
            let output = '';
            // Journaliser le nombre d'éléments à ce niveau
            console.error(`[DEBUG] Formatage de ${items.length} éléments au niveau ${depth}`);
            // Utiliser directement les items triés sans les retrier
            for (const item of items) {
                if (item.type === 'directory') {
                    // Formater les répertoires
                    output += `${indent}📁 ${item.name}/\n`;
                    if (item.children && item.children.length > 0) {
                        // Journaliser le nombre d'enfants
                        console.error(`[DEBUG] Répertoire ${item.name} contient ${item.children.length} enfants`);
                        output += formatContents(item.children, indent + '  ', depth + 1);
                    }
                }
                else {
                    // Formater les fichiers
                    const sizeStr = this.formatFileSize(item.size);
                    const modifiedStr = new Date(item.modified).toLocaleString();
                    const lineCountStr = item.lineCount ? ` (${item.lineCount} lignes)` : '';
                    output += `${indent}📄 ${item.name} - ${sizeStr}${lineCountStr} - Modifié: ${modifiedStr}\n`;
                }
            }
            return output;
        };
        // Ajouter le contenu formaté au résultat
        result += formatContents(contents);
        console.error(`[DEBUG] Formatage terminé pour ${dirPath}`);
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
    /**
     * Formate la taille d'un fichier en unités lisibles (B, KB, MB, GB, TB)
     * avec une précision adaptée à la taille
     *
     * @private
     * @method formatFileSize
     * @param {number} bytes - Taille en octets
     * @returns {string} - Taille formatée
     */
    formatFileSize(bytes) {
        // Constantes pour les conversions
        const KB = 1024;
        const MB = KB * 1024;
        const GB = MB * 1024;
        const TB = GB * 1024;
        // Journaliser la taille pour le débogage
        console.error(`[DEBUG] Formatage de la taille: ${bytes} octets`);
        // Formater avec une précision adaptée à la taille
        if (bytes === 0)
            return '0 B';
        if (bytes < KB)
            return `${bytes} B`;
        if (bytes < MB) {
            // Pour les KB, utiliser 1 décimale
            const kb = bytes / KB;
            return `${kb.toFixed(1)} KB`;
        }
        if (bytes < GB) {
            // Pour les MB, utiliser 2 décimales
            const mb = bytes / MB;
            return `${mb.toFixed(2)} MB`;
        }
        if (bytes < TB) {
            // Pour les GB, utiliser 2 décimales
            const gb = bytes / GB;
            return `${gb.toFixed(2)} GB`;
        }
        // Pour les TB, utiliser 3 décimales
        const tb = bytes / TB;
        return `${tb.toFixed(3)} TB`;
    }
    /**
     * Liste récursivement le contenu d'un répertoire avec options de filtrage et de tri
     *
     * @private
     * @method listDirectoryContentsRecursive
     * @param {string} dirPath - Chemin du répertoire à lister
     * @param {boolean} recursive - Lister récursivement les sous-répertoires
     * @param {string} [filePattern] - Motif glob pour filtrer les fichiers (ex: *.js, *.{js,ts})
     * @param {string} [sortBy='name'] - Critère de tri:
     *   - 'name': tri alphabétique par nom (insensible à la casse)
     *   - 'size': tri par taille (en octets)
     *   - 'modified': tri par date de modification
     *   - 'type': tri par type (répertoires d'abord, puis fichiers)
     * @param {string} [sortOrder='asc'] - Ordre de tri:
     *   - 'asc': ordre ascendant (A à Z, du plus petit au plus grand, du plus ancien au plus récent)
     *   - 'desc': ordre descendant (Z à A, du plus grand au plus petit, du plus récent au plus ancien)
     * @returns {Promise<any[]>} - Contenu du répertoire filtré et trié
     */
    async listDirectoryContentsRecursive(dirPath, recursive, filePattern, sortBy = 'name', sortOrder = 'asc') {
        // Journalisation détaillée pour le débogage
        console.error(`[DEBUG] Listage du répertoire: ${dirPath}`);
        console.error(`[DEBUG] Options: recursive=${recursive}, filePattern=${filePattern || 'none'}, sortBy=${sortBy}, sortOrder=${sortOrder}`);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        console.error(`[DEBUG] Nombre d'entrées trouvées: ${entries.length}`);
        const result = [];
        // Fonction pour vérifier si un fichier correspond au motif glob
        // Supporte les motifs suivants:
        // - * : correspond à n'importe quelle séquence de caractères
        // - ? : correspond à un seul caractère
        // - {a,b,c} : correspond à l'un des motifs a, b ou c
        // Exemples: "*.js", "*.{js,ts}", "data?.json"
        const matchesPattern = (filename, pattern) => {
            if (!pattern)
                return true; // Pas de filtrage si pas de motif
            // Convertir le motif glob en regex
            const regexPattern = pattern
                .replace(/\./g, '\\.') // Échapper les points
                .replace(/\*/g, '.*') // * devient .* (n'importe quelle séquence)
                .replace(/\?/g, '.') // ? devient . (n'importe quel caractère)
                .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(',').join('|')})`); // {a,b} devient (a|b)
            const regex = new RegExp(`^${regexPattern}$`, 'i'); // Insensible à la casse
            return regex.test(filename);
        };
        // Calculer la taille totale d'un répertoire (somme des tailles des fichiers)
        const calculateDirectorySize = async (dirPath) => {
            try {
                let totalSize = 0;
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dirPath, entry.name);
                    const stats = await fs.stat(entryPath);
                    if (entry.isDirectory()) {
                        // Ajouter récursivement la taille des sous-répertoires
                        totalSize += await calculateDirectorySize(entryPath);
                    }
                    else {
                        // Ajouter la taille du fichier
                        totalSize += stats.size;
                    }
                }
                return totalSize;
            }
            catch (error) {
                console.error(`[ERROR] Erreur lors du calcul de la taille du répertoire ${dirPath}: ${error.message}`);
                return 0; // En cas d'erreur, retourner 0
            }
        };
        // Collecter toutes les entrées (fichiers et répertoires)
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            const stats = await fs.stat(entryPath);
            if (entry.isDirectory()) {
                // Traitement des répertoires
                let directorySize = stats.size;
                // Récupérer les enfants si récursif
                const children = recursive ? await this.listDirectoryContentsRecursive(entryPath, recursive, filePattern, sortBy, sortOrder) : [];
                // Pour le tri par taille, calculer la taille totale du répertoire
                if (sortBy === 'size') {
                    directorySize = await calculateDirectorySize(entryPath);
                    console.error(`[DEBUG] Taille calculée pour le répertoire ${entry.name}: ${directorySize} octets`);
                }
                const item = {
                    name: entry.name,
                    path: entryPath,
                    type: 'directory',
                    size: directorySize, // Utiliser la taille calculée pour les répertoires
                    modified: stats.mtime.toISOString(),
                    children
                };
                result.push(item);
            }
            else {
                // Traitement des fichiers
                // Filtrer les fichiers selon le motif glob si spécifié
                if (filePattern && !matchesPattern(entry.name, filePattern)) {
                    console.error(`[DEBUG] Fichier ignoré (ne correspond pas au motif): ${entry.name}`);
                    continue; // Ignorer ce fichier s'il ne correspond pas au motif
                }
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
                    console.error(`[DEBUG] Erreur lors du comptage des lignes pour ${entry.name}: ${error.message}`);
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
        // Journaliser les éléments avant le tri
        console.error(`[DEBUG] Éléments avant tri (${result.length}):`);
        result.forEach((item, index) => {
            console.error(`[DEBUG]   ${index}. ${item.type === 'directory' ? 'DIR' : 'FILE'} ${item.name} (taille: ${item.size}, modifié: ${item.modified})`);
        });
        // Fonction de comparaison pour le tri des éléments (fichiers et répertoires)
        const compareItems = (a, b) => {
            // Variable pour stocker le résultat de la comparaison
            let comparison = 0;
            // Appliquer le critère de tri principal
            switch (sortBy) {
                case 'name':
                    // Tri alphabétique par nom (insensible à la casse)
                    // Utilise localeCompare pour un tri correct des caractères accentués et spéciaux
                    comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { sensitivity: 'base' });
                    break;
                case 'size':
                    // Tri par taille en octets
                    // Utilisation de la soustraction pour éviter les problèmes avec les grands nombres
                    // Pour les répertoires, la taille est calculée comme la somme des tailles des fichiers contenus
                    comparison = a.size - b.size;
                    break;
                case 'modified':
                    // Tri par date de modification
                    // Convertit les dates ISO en timestamps pour la comparaison
                    const timeA = new Date(a.modified).getTime();
                    const timeB = new Date(b.modified).getTime();
                    comparison = timeA - timeB;
                    break;
                case 'type':
                    // Tri par type: répertoires d'abord, puis fichiers
                    if (a.type !== b.type) {
                        comparison = a.type === 'directory' ? -1 : 1; // Répertoires avant fichiers
                    }
                    else {
                        // Si même type, trier par nom comme critère secondaire
                        comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { sensitivity: 'base' });
                    }
                    break;
            }
            // Si le critère principal donne une égalité et que ce n'est pas déjà un tri par nom,
            // utiliser le nom comme critère secondaire pour un tri stable et prévisible
            if (comparison === 0 && sortBy !== 'name') {
                comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { sensitivity: 'base' });
            }
            // Inverser l'ordre si descendant est demandé
            return sortOrder === 'desc' ? -comparison : comparison;
        };
        // Trier les résultats selon le critère et l'ordre spécifiés
        if (sortBy === 'type') {
            // Pour le tri par type, on utilise directement la fonction de comparaison
            result.sort(compareItems);
        }
        else {
            // Pour les autres critères, on trie d'abord par type (répertoires avant fichiers)
            // puis on applique le critère de tri à l'intérieur de chaque groupe
            const directories = result.filter(item => item.type === 'directory').sort(compareItems);
            const files = result.filter(item => item.type === 'file').sort(compareItems);
            // Réinitialiser le tableau result avec les éléments triés
            result.length = 0;
            result.push(...directories, ...files);
        }
        // Journaliser les éléments après le tri
        console.error(`[DEBUG] Éléments après tri (${result.length}):`);
        result.forEach((item, index) => {
            console.error(`[DEBUG]   ${index}. ${item.type === 'directory' ? 'DIR' : 'FILE'} ${item.name} (taille: ${item.size}, modifié: ${item.modified})`);
        });
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