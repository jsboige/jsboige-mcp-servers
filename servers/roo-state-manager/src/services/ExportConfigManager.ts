import fs from 'fs/promises';
import path from 'path';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';

/**
 * Configuration par défaut pour les exports XML
 */
export interface ExportConfig {
    defaults: {
        prettyPrint: boolean;
        includeContent: boolean;
        compression: 'none' | 'zip';
    };
    templates: Record<string, {
        format: string;
        fields: string[];
    }>;
    filters: Record<string, {
        startDate?: string;
        endDate?: string;
        mode?: string;
    }>;
}

/**
 * Configuration par défaut
 */
const DEFAULT_CONFIG: ExportConfig = {
    defaults: {
        prettyPrint: true,
        includeContent: false,
        compression: 'none'
    },
    templates: {
        jira_export: {
            format: 'simplified',
            fields: ['taskId', 'title', 'user_messages_only']
        },
        full_export: {
            format: 'complete',
            fields: ['taskId', 'title', 'metadata', 'sequence']
        }
    },
    filters: {
        last_week: {
            startDate: 'now-7d',
            endDate: 'now'
        },
        debug_tasks: {
            mode: 'debug-complex'
        }
    }
};

/**
 * Service de gestion de la configuration des exports XML
 */
export class ExportConfigManager {
    private static readonly CONFIG_FILE_NAME = 'xml_export_config.json';
    private configCache: ExportConfig | null = null;
    private configPath: string | null = null;

    constructor() {
        this.initializeConfigPath();
    }

    /**
     * Initialise le chemin du fichier de configuration
     */
    private async initializeConfigPath(): Promise<void> {
        try {
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            if (storageLocations.length > 0) {
                // Utilise le premier emplacement de stockage trouvé
                const firstLocation = storageLocations[0];
                const storageDir = path.dirname(firstLocation); // Remonte d'un niveau depuis tasks/
                this.configPath = path.join(storageDir, ExportConfigManager.CONFIG_FILE_NAME);
            }
        } catch (error) {
            console.error('Erreur lors de l\'initialisation du chemin de configuration:', error);
        }
    }

    /**
     * Obtient le chemin de configuration ou le calcule si nécessaire
     */
    private async getConfigPath(): Promise<string> {
        if (!this.configPath) {
            await this.initializeConfigPath();
        }

        if (!this.configPath) {
            throw new Error('Impossible de déterminer l\'emplacement du fichier de configuration. Aucun stockage Roo détecté.');
        }

        return this.configPath;
    }

    /**
     * Charge la configuration depuis le fichier ou retourne la configuration par défaut
     */
    async getConfig(): Promise<ExportConfig> {
        if (this.configCache) {
            return this.configCache;
        }

        try {
            const configPath = await this.getConfigPath();
            
            try {
                await fs.access(configPath);
                const content = await fs.readFile(configPath, 'utf-8');
                
                // Nettoyer le BOM si présent
                const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
                const config = JSON.parse(cleanContent) as ExportConfig;
                
                // Valider et fusionner avec les valeurs par défaut
                this.configCache = this.mergeWithDefaults(config);
                return this.configCache;
                
            } catch (fileError) {
                // Le fichier n'existe pas ou est corrompu, utiliser la configuration par défaut
                console.warn('Fichier de configuration non trouvé ou corrompu, utilisation de la configuration par défaut');
                this.configCache = { ...DEFAULT_CONFIG };
                
                // Créer le fichier avec la configuration par défaut
                await this.saveConfig(this.configCache);
                return this.configCache;
            }
            
        } catch (error) {
            console.error('Erreur lors du chargement de la configuration:', error);
            // Retourner la configuration par défaut en cas d'erreur
            return { ...DEFAULT_CONFIG };
        }
    }

    /**
     * Met à jour la configuration (fusion partielle)
     */
    async updateConfig(partialConfig: Partial<ExportConfig>): Promise<void> {
        const currentConfig = await this.getConfig();
        
        // Fusion profonde des configurations
        const updatedConfig: ExportConfig = {
            defaults: { ...currentConfig.defaults, ...partialConfig.defaults },
            templates: { ...currentConfig.templates, ...partialConfig.templates },
            filters: { ...currentConfig.filters, ...partialConfig.filters }
        };

        await this.saveConfig(updatedConfig);
        this.configCache = updatedConfig;
    }

    /**
     * Remet la configuration à zéro (valeurs par défaut)
     */
    async resetConfig(): Promise<void> {
        const defaultConfig = { ...DEFAULT_CONFIG };
        await this.saveConfig(defaultConfig);
        this.configCache = defaultConfig;
    }

    /**
     * Sauvegarde la configuration dans le fichier
     */
    private async saveConfig(config: ExportConfig): Promise<void> {
        try {
            const configPath = await this.getConfigPath();
            const configDir = path.dirname(configPath);
            
            // Créer le répertoire si nécessaire
            await fs.mkdir(configDir, { recursive: true });
            
            // Sauvegarder la configuration
            const content = JSON.stringify(config, null, 2);
            await fs.writeFile(configPath, content, 'utf-8');
            
        } catch (error) {
            throw new Error(`Impossible de sauvegarder la configuration: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Fusionne une configuration partielle avec les valeurs par défaut
     */
    private mergeWithDefaults(config: Partial<ExportConfig>): ExportConfig {
        return {
            defaults: { ...DEFAULT_CONFIG.defaults, ...config.defaults },
            templates: { ...DEFAULT_CONFIG.templates, ...config.templates },
            filters: { ...DEFAULT_CONFIG.filters, ...config.filters }
        };
    }

    /**
     * Valide une configuration
     */
    private validateConfig(config: any): boolean {
        try {
            // Vérifications basiques de la structure
            if (typeof config !== 'object' || config === null) {
                return false;
            }

            // Vérifier la section defaults
            if (!config.defaults || typeof config.defaults !== 'object') {
                return false;
            }

            const { defaults } = config;
            if (typeof defaults.prettyPrint !== 'boolean' ||
                typeof defaults.includeContent !== 'boolean' ||
                !['none', 'zip'].includes(defaults.compression)) {
                return false;
            }

            // Vérifier les sections templates et filters (structure de base)
            if (!config.templates || typeof config.templates !== 'object' ||
                !config.filters || typeof config.filters !== 'object') {
                return false;
            }

            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Obtient le chemin du fichier de configuration (pour debug)
     */
    async getConfigFilePath(): Promise<string | null> {
        return this.configPath || (await this.getConfigPath());
    }

    /**
     * Invalide le cache (force le rechargement au prochain accès)
     */
    invalidateCache(): void {
        this.configCache = null;
    }

    /**
     * Ajoute un nouveau template de configuration
     */
    async addTemplate(name: string, template: { format: string; fields: string[] }): Promise<void> {
        const config = await this.getConfig();
        config.templates[name] = template;
        await this.saveConfig(config);
        this.configCache = config;
    }

    /**
     * Supprime un template de configuration
     */
    async removeTemplate(name: string): Promise<boolean> {
        const config = await this.getConfig();
        if (config.templates[name]) {
            delete config.templates[name];
            await this.saveConfig(config);
            this.configCache = config;
            return true;
        }
        return false;
    }

    /**
     * Ajoute un nouveau filtre
     */
    async addFilter(name: string, filter: { startDate?: string; endDate?: string; mode?: string }): Promise<void> {
        const config = await this.getConfig();
        config.filters[name] = filter;
        await this.saveConfig(config);
        this.configCache = config;
    }

    /**
     * Supprime un filtre
     */
    async removeFilter(name: string): Promise<boolean> {
        const config = await this.getConfig();
        if (config.filters[name]) {
            delete config.filters[name];
            await this.saveConfig(config);
            this.configCache = config;
            return true;
        }
        return false;
    }
}