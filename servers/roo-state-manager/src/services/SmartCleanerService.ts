/**
 * SmartCleanerService - Service de nettoyage intelligent du contenu
 * 
 * Nettoie le contenu en supprimant les métadonnées redondantes, environment_details,
 * et autres éléments non pertinents pour l'export final
 * Selon l'architecture définie dans docs/sddd/markdown_export_architecture.md
 */

import { ClassifiedContent } from '../types/enhanced-conversation.js';

/**
 * Configuration pour le nettoyage intelligent
 */
export interface CleaningConfig {
    removeEnvironmentDetails: boolean;
    removeRedundantMetadata: boolean;
    removeDebugInfo: boolean;
    removeTimestamps: boolean;
    removeCostInfo: boolean;
    removeFileInfo: boolean;
    minimizeWhitespace: boolean;
    removeEmptyLines: boolean;
    maxConsecutiveEmptyLines: number;
}

/**
 * Résultat du nettoyage
 */
export interface CleaningResult {
    originalSize: number;
    cleanedSize: number;
    compressionRatio: number;
    removedElements: {
        environmentDetails: number;
        redundantMetadata: number;
        debugInfo: number;
        timestamps: number;
        costInfo: number;
        fileInfo: number;
        emptyLines: number;
    };
}

export class SmartCleanerService {
    private defaultConfig: CleaningConfig = {
        removeEnvironmentDetails: true,
        removeRedundantMetadata: true,
        removeDebugInfo: true,
        removeTimestamps: false, // Garder par défaut pour traçabilité
        removeCostInfo: true,
        removeFileInfo: false, // Garder par défaut pour contexte
        minimizeWhitespace: true,
        removeEmptyLines: true,
        maxConsecutiveEmptyLines: 1
    };

    constructor(private config: Partial<CleaningConfig> = {}) {
        this.config = { ...this.defaultConfig, ...this.config };
    }

    /**
     * Nettoie une liste de contenus classifiés
     */
    cleanContent(content: ClassifiedContent[], config?: Partial<CleaningConfig>): {
        cleanedContent: ClassifiedContent[];
        result: CleaningResult;
    } {
        const effectiveConfig: CleaningConfig = { ...this.defaultConfig, ...this.config, ...config };
        const result: CleaningResult = {
            originalSize: 0,
            cleanedSize: 0,
            compressionRatio: 0,
            removedElements: {
                environmentDetails: 0,
                redundantMetadata: 0,
                debugInfo: 0,
                timestamps: 0,
                costInfo: 0,
                fileInfo: 0,
                emptyLines: 0
            }
        };

        // Calculer la taille originale
        result.originalSize = content.reduce((sum, item) => sum + item.contentSize, 0);

        const cleanedContent = content.map(item => {
            const cleaned = this.cleanSingleContent(item, effectiveConfig, result);
            return cleaned;
        }).filter(item => item.content.length > 0); // Supprimer les éléments vides

        // Calculer les métriques finales
        result.cleanedSize = cleanedContent.reduce((sum, item) => sum + item.contentSize, 0);
        result.compressionRatio = result.originalSize > 0 
            ? (result.originalSize - result.cleanedSize) / result.originalSize 
            : 0;

        return { cleanedContent, result };
    }

    /**
     * Nettoie un seul élément de contenu
     */
    private cleanSingleContent(
        item: ClassifiedContent, 
        config: CleaningConfig, 
        result: CleaningResult
    ): ClassifiedContent {
        let content = item.content;
        let changes = 0;

        // 1. Supprimer environment_details
        if (config.removeEnvironmentDetails) {
            const beforeSize = content.length;
            content = this.removeEnvironmentDetails(content);
            if (content.length < beforeSize) {
                result.removedElements.environmentDetails++;
                changes++;
            }
        }

        // 2. Supprimer les métadonnées redondantes
        if (config.removeRedundantMetadata) {
            const beforeSize = content.length;
            content = this.removeRedundantMetadata(content);
            if (content.length < beforeSize) {
                result.removedElements.redundantMetadata++;
                changes++;
            }
        }

        // 3. Supprimer les informations de debug
        if (config.removeDebugInfo) {
            const beforeSize = content.length;
            content = this.removeDebugInfo(content);
            if (content.length < beforeSize) {
                result.removedElements.debugInfo++;
                changes++;
            }
        }

        // 4. Supprimer les timestamps (optionnel)
        if (config.removeTimestamps) {
            const beforeSize = content.length;
            content = this.removeTimestamps(content);
            if (content.length < beforeSize) {
                result.removedElements.timestamps++;
                changes++;
            }
        }

        // 5. Supprimer les informations de coût
        if (config.removeCostInfo) {
            const beforeSize = content.length;
            content = this.removeCostInfo(content);
            if (content.length < beforeSize) {
                result.removedElements.costInfo++;
                changes++;
            }
        }

        // 6. Supprimer les informations de fichiers (optionnel)
        if (config.removeFileInfo) {
            const beforeSize = content.length;
            content = this.removeFileInfo(content);
            if (content.length < beforeSize) {
                result.removedElements.fileInfo++;
                changes++;
            }
        }

        // 7. Minimiser les espaces blancs
        if (config.minimizeWhitespace) {
            content = this.minimizeWhitespace(content);
        }

        // 8. Supprimer les lignes vides excessives
        if (config.removeEmptyLines) {
            const beforeLines = content.split('\n').length;
            content = this.removeExcessiveEmptyLines(content, config.maxConsecutiveEmptyLines);
            const afterLines = content.split('\n').length;
            result.removedElements.emptyLines += (beforeLines - afterLines);
        }

        return {
            ...item,
            content: content,
            contentSize: content.length
        };
    }

    /**
     * Supprime les blocs environment_details
     */
    private removeEnvironmentDetails(content: string): string {
        // Pattern pour détecter les blocs environment_details complets
        const patterns = [
            /<environment_details>[\s\S]*?<\/environment_details>/g,
            /# VSCode Visible Files[\s\S]*?(?=\n# |$)/g,
            /# VSCode Open Tabs[\s\S]*?(?=\n# |$)/g,
            /# Current Time[\s\S]*?(?=\n# |$)/g,
            /# Current Cost[\s\S]*?(?=\n# |$)/g,
            /# Current Mode[\s\S]*?(?=\n# |$)/g,
            /# Recently Modified Files[\s\S]*?(?=\n# |$)/g,
            /# Current Workspace Directory[\s\S]*?(?=\n# |$)/g
        ];

        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        return cleaned;
    }

    /**
     * Supprime les métadonnées redondantes
     */
    private removeRedundantMetadata(content: string): string {
        const patterns = [
            /\[read_file for '.*?'\] Result:/g,
            /\[write_to_file for '.*?'\] Result:/g,
            /\[apply_diff for '.*?'\] Result:/g,
            /\[execute_command for '.*?'\] Result:/g,
            /<file_write_result>[\s\S]*?<\/file_write_result>/g,
            /<operation>.*?<\/operation>/g,
            /<problems>[\s\S]*?<\/problems>/g,
            /<notice>[\s\S]*?<\/notice>/g
        ];

        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        return cleaned;
    }

    /**
     * Supprime les informations de debug
     */
    private removeDebugInfo(content: string): string {
        const patterns = [
            /Debug Info:[\s\S]*?(?=\n[A-Z]|\n\n|$)/g,
            /Similarity Score:.*?\n/g,
            /Required Threshold:.*?\n/g,
            /Search Range:.*?\n/g,
            /Best Match Found:[\s\S]*?(?=\n[A-Z]|\n\n|$)/g,
            /Original Content:[\s\S]*?(?=\n[A-Z]|\n\n|$)/g
        ];

        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        return cleaned;
    }

    /**
     * Supprime les timestamps ISO
     */
    private removeTimestamps(content: string): string {
        const patterns = [
            /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
            /"timestamp":\s*"[^"]*"/g,
            /timestamp:\s*[^,\n}]*/g
        ];

        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        return cleaned;
    }

    /**
     * Supprime les informations de coût
     */
    private removeCostInfo(content: string): string {
        const patterns = [
            /# Current Cost[\s\S]*?\n/g,
            /\$\d+\.\d{2}/g,
            /"cost":\s*\d+\.?\d*/g,
            /cost:\s*\d+\.?\d*/g,
            /"tokensIn":\s*\d+/g,
            /"tokensOut":\s*\d+/g,
            /"cacheWrites":\s*\d+/g,
            /"cacheReads":\s*\d+/g
        ];

        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        return cleaned;
    }

    /**
     * Supprime les informations de fichiers sensibles
     */
    private removeFileInfo(content: string): string {
        const patterns = [
            /# VSCode Visible Files[\s\S]*?(?=\n# |$)/g,
            /# VSCode Open Tabs[\s\S]*?(?=\n# |$)/g,
            /# Recently Modified Files[\s\S]*?(?=\n# |$)/g
        ];

        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }

        return cleaned;
    }

    /**
     * Minimise les espaces blancs
     */
    private minimizeWhitespace(content: string): string {
        return content
            // Supprimer les espaces en fin de ligne
            .replace(/[ \t]+$/gm, '')
            // Remplacer plusieurs espaces consécutifs par un seul (sauf en début de ligne pour indentation)
            .replace(/(?<!^[ \t]*)([ \t]){2,}/gm, ' ')
            // Supprimer les tabulations mélangées avec des espaces
            .replace(/[ \t]*\t[ \t]*/g, '\t');
    }

    /**
     * Supprime les lignes vides excessives
     */
    private removeExcessiveEmptyLines(content: string, maxConsecutive: number): string {
        const lines = content.split('\n');
        const result: string[] = [];
        let consecutiveEmpty = 0;

        for (const line of lines) {
            if (line.trim() === '') {
                consecutiveEmpty++;
                if (consecutiveEmpty <= maxConsecutive) {
                    result.push(line);
                }
            } else {
                consecutiveEmpty = 0;
                result.push(line);
            }
        }

        return result.join('\n');
    }

    /**
     * Analyse le contenu pour détecter les éléments à nettoyer sans les supprimer
     */
    analyzeContent(content: ClassifiedContent[]): {
        environmentDetailsCount: number;
        redundantMetadataCount: number;
        debugInfoCount: number;
        timestampCount: number;
        costInfoCount: number;
        fileInfoCount: number;
        estimatedSavings: number;
    } {
        let stats = {
            environmentDetailsCount: 0,
            redundantMetadataCount: 0,
            debugInfoCount: 0,
            timestampCount: 0,
            costInfoCount: 0,
            fileInfoCount: 0,
            estimatedSavings: 0
        };

        for (const item of content) {
            const content_text = item.content;
            
            // Compter les éléments détectables
            if (content_text.includes('<environment_details>') || content_text.includes('# VSCode')) {
                stats.environmentDetailsCount++;
            }
            if (content_text.includes('[read_file for') || content_text.includes('<file_write_result>')) {
                stats.redundantMetadataCount++;
            }
            if (content_text.includes('Debug Info:') || content_text.includes('Similarity Score:')) {
                stats.debugInfoCount++;
            }
            if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(content_text)) {
                stats.timestampCount++;
            }
            if (/\$\d+\.\d{2}/.test(content_text) || content_text.includes('"cost":')) {
                stats.costInfoCount++;
            }
            if (content_text.includes('# VSCode Visible Files') || content_text.includes('# VSCode Open Tabs')) {
                stats.fileInfoCount++;
            }
        }

        // Estimation approximative des économies (30-50% en moyenne)
        const totalSize = content.reduce((sum, item) => sum + item.contentSize, 0);
        stats.estimatedSavings = Math.floor(totalSize * 0.4);

        return stats;
    }
}