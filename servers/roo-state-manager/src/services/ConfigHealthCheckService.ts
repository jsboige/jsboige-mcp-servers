/**
 * ConfigHealthCheckService - Vérification de santé des configurations appliquées
 *
 * #537 Phase 2: Health check post-apply pour valider que la config fonctionne
 *
 * Checks disponibles:
 * - json_valid: Syntaxe JSON valide
 * - required_fields: Champs requis présents
 * - mcp_loadable: Serveurs MCP chargeables (validation basique)
 * - file_readable: Fichier lisible
 */

import { readFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { Logger } from '../utils/logger.js';

export type HealthCheckType = 'json_valid' | 'required_fields' | 'mcp_loadable' | 'file_readable';
export type ConfigType = 'mcp_config' | 'mode_definition' | 'profile_settings' | 'roomodes_config' | 'model_config' | 'rules_config' | 'settings_config';

export interface HealthCheckResult {
  healthy: boolean;
  checks: Array<{
    name: HealthCheckType;
    passed: boolean;
    message?: string;
    details?: Record<string, any>;
  }>;
  warnings: string[];
  errors: string[];
  timestamp: Date;
  filePath: string;
  configType: ConfigType;
}

export interface HealthCheckOptions {
  checks?: HealthCheckType[];  // Checks à exécuter (défaut: tous)
  requiredFields?: string[];   // Champs requis pour le check 'required_fields'
  timeout?: number;            // Timeout en ms (défaut: 5000)
}

// Champs requis par type de config
const REQUIRED_FIELDS_BY_TYPE: Record<ConfigType, string[]> = {
  mcp_config: ['mcpServers'],
  mode_definition: ['slug', 'name', 'roleDefinition'],
  profile_settings: ['profiles', 'apiConfigs'],
  roomodes_config: ['customModes'],
  model_config: ['profiles', 'apiConfigs'],
  rules_config: [],  // Pas de champs obligatoires
  settings_config: [] // Variable selon le contexte
};

export class ConfigHealthCheckService {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Exécute un health check complet sur un fichier de configuration
   */
  public async checkHealth(
    filePath: string,
    configType: ConfigType,
    options: HealthCheckOptions = {}
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const checks: HealthCheckResult['checks'] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    const checksToRun = options.checks || [
      'file_readable',
      'json_valid',
      'required_fields'
    ];

    this.logger.info(`Health check démarré: ${filePath}`, { configType, checks: checksToRun });

    // Check 1: file_readable
    if (checksToRun.includes('file_readable')) {
      const check = await this.checkFileReadable(filePath);
      checks.push(check);
      if (!check.passed) {
        errors.push(check.message || 'Fichier non lisible');
      }
    }

    // Si le fichier n'est pas lisible, pas la peine de continuer
    if (checks.some(c => c.name === 'file_readable' && !c.passed)) {
      return {
        healthy: false,
        checks,
        warnings,
        errors,
        timestamp: new Date(),
        filePath,
        configType
      };
    }

    // Charger le contenu pour les checks suivants
    let content: string;
    let parsedContent: any;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err: any) {
      errors.push(`Impossible de lire le fichier: ${err.message}`);
      return {
        healthy: false,
        checks,
        warnings,
        errors,
        timestamp: new Date(),
        filePath,
        configType
      };
    }

    // Check 2: json_valid
    if (checksToRun.includes('json_valid')) {
      const check = this.checkJsonValid(content);
      checks.push(check);
      if (check.passed) {
        parsedContent = check.details?.parsed;
      } else {
        errors.push(check.message || 'JSON invalide');
      }
    }

    // Check 3: required_fields
    if (checksToRun.includes('required_fields') && parsedContent) {
      const requiredFields = options.requiredFields || REQUIRED_FIELDS_BY_TYPE[configType] || [];
      const check = this.checkRequiredFields(parsedContent, requiredFields);
      checks.push(check);
      if (!check.passed) {
        warnings.push(check.message || 'Champs requis manquants');
      }
    }

    // Check 4: mcp_loadable (validation basique de structure MCP)
    if (checksToRun.includes('mcp_loadable') && parsedContent && configType === 'mcp_config') {
      const check = this.checkMcpLoadable(parsedContent);
      checks.push(check);
      if (!check.passed) {
        warnings.push(check.message || 'Configuration MCP potentiellement problématique');
      }
    }

    const healthy = errors.length === 0;
    const duration = Date.now() - startTime;

    this.logger.info(
      `Health check terminé: ${healthy ? 'OK' : 'ÉCHEC'}`,
      { filePath, duration, checksPassed: checks.filter(c => c.passed).length, errors: errors.length }
    );

    return {
      healthy,
      checks,
      warnings,
      errors,
      timestamp: new Date(),
      filePath,
      configType
    };
  }

  /**
   * Health check rapide (fichier lisible + JSON valide)
   */
  public async quickCheck(filePath: string): Promise<boolean> {
    try {
      const content = await readFile(filePath, 'utf-8');
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Health check batch sur plusieurs fichiers
   */
  public async checkBatch(
    files: Array<{ path: string; type: ConfigType }>,
    options: HealthCheckOptions = {}
  ): Promise<{
    healthy: boolean;
    results: Map<string, HealthCheckResult>;
    summary: { passed: number; failed: number; warnings: number };
  }> {
    const results = new Map<string, HealthCheckResult>();
    let passed = 0;
    let failed = 0;
    let warnings = 0;

    for (const file of files) {
      const result = await this.checkHealth(file.path, file.type, options);
      results.set(file.path, result);

      if (result.healthy) {
        passed++;
      } else {
        failed++;
      }
      warnings += result.warnings.length;
    }

    return {
      healthy: failed === 0,
      results,
      summary: { passed, failed, warnings }
    };
  }

  // === Checks privés ===

  private async checkFileReadable(filePath: string): Promise<HealthCheckResult['checks'][0]> {
    try {
      await access(filePath);
      return {
        name: 'file_readable',
        passed: true,
        message: 'Fichier accessible'
      };
    } catch (err: any) {
      return {
        name: 'file_readable',
        passed: false,
        message: `Fichier non accessible: ${err.message}`
      };
    }
  }

  private checkJsonValid(content: string): HealthCheckResult['checks'][0] {
    try {
      // Strip BOM si présent
      const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
      const parsed = JSON.parse(cleanContent);
      return {
        name: 'json_valid',
        passed: true,
        message: 'JSON valide',
        details: { parsed }
      };
    } catch (err: any) {
      return {
        name: 'json_valid',
        passed: false,
        message: `JSON invalide: ${err.message}`
      };
    }
  }

  private checkRequiredFields(content: any, requiredFields: string[]): HealthCheckResult['checks'][0] {
    if (requiredFields.length === 0) {
      return {
        name: 'required_fields',
        passed: true,
        message: 'Aucun champ requis défini pour ce type'
      };
    }

    const missing = requiredFields.filter(field => !(field in content));

    if (missing.length === 0) {
      return {
        name: 'required_fields',
        passed: true,
        message: `Tous les champs requis présents (${requiredFields.length})`
      };
    }

    return {
      name: 'required_fields',
      passed: false,
      message: `Champs manquants: ${missing.join(', ')}`,
      details: { missing, required: requiredFields }
    };
  }

  private checkMcpLoadable(content: any): HealthCheckResult['checks'][0] {
    const issues: string[] = [];

    if (!content.mcpServers || typeof content.mcpServers !== 'object') {
      return {
        name: 'mcp_loadable',
        passed: true, // Pas bloquant, la structure est différente
        message: 'Pas de mcpServers défini'
      };
    }

    // Vérifier chaque serveur MCP
    for (const [name, server] of Object.entries(content.mcpServers)) {
      const s = server as any;

      // Vérifier que disabled est un boolean si présent
      if (s.disabled !== undefined && typeof s.disabled !== 'boolean') {
        issues.push(`${name}: 'disabled' doit être un boolean`);
      }

      // Vérifier que command est présent si pas disabled
      if (!s.disabled && !s.command) {
        issues.push(`${name}: 'command' manquant`);
      }

      // Vérifier que args est un tableau si présent
      if (s.args !== undefined && !Array.isArray(s.args)) {
        issues.push(`${name}: 'args' doit être un tableau`);
      }
    }

    if (issues.length === 0) {
      return {
        name: 'mcp_loadable',
        passed: true,
        message: `${Object.keys(content.mcpServers).length} serveurs MCP valides`
      };
    }

    return {
      name: 'mcp_loadable',
      passed: false,
      message: `Problèmes détectés: ${issues.join('; ')}`,
      details: { issues }
    };
  }
}
