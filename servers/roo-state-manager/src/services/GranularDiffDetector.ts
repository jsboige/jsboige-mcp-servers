import {
  DetectedDifference,
  ComparisonReport,
  ComparisonSummary
} from './DiffDetector.js';
import { BaselineDifference } from '../types/baseline.js';

/**
 * Types pour le diff granulaire
 */
export type GranularDiffType = 'added' | 'removed' | 'modified' | 'moved' | 'copied' | 'unchanged';
export type GranularDiffSeverity = 'CRITICAL' | 'IMPORTANT' | 'WARNING' | 'INFO';
export type GranularDiffCategory = 'roo_config' | 'hardware' | 'software' | 'system' | 'nested' | 'array' | 'semantic';

export interface GranularDiffResult {
  id: string;
  path: string;
  type: GranularDiffType;
  severity: GranularDiffSeverity;
  category: GranularDiffCategory;
  description: string;
  oldValue?: any;
  newValue?: any;
  oldPath?: string;
  newPath?: string;
  metadata?: {
    arrayIndex?: number;
    objectKey?: string;
    valueType?: string;
    changePercent?: number;
    semanticChange?: string;
  };
  children?: GranularDiffResult[];
}

export interface GranularDiffOptions {
  includeUnchanged?: boolean;
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
  arrayDiffMode?: 'position' | 'identity';
  semanticAnalysis?: boolean;
  maxDepth?: number;
  customRules?: GranularDiffRule[];
}

export interface GranularDiffRule {
  name: string;
  path: string | RegExp;
  severity: GranularDiffSeverity;
  category: GranularDiffCategory;
  handler?: (oldValue: any, newValue: any, path: string) => GranularDiffResult | null;
}

export interface GranularDiffReport {
  reportId: string;
  timestamp: string;
  sourceLabel: string;
  targetLabel: string;
  options: GranularDiffOptions;
  summary: {
    total: number;
    byType: Record<GranularDiffType, number>;
    bySeverity: Record<GranularDiffSeverity, number>;
    byCategory: Record<GranularDiffCategory, number>;
  };
  diffs: GranularDiffResult[];
  performance: {
    executionTime: number;
    nodesCompared: number;
    memoryUsage?: number;
  };
}

/**
 * Service de détection de diff granulaire avancé
 */
export class GranularDiffDetector {
  private customRules: GranularDiffRule[] = [];
  private performanceMetrics = {
    nodesCompared: 0,
    startTime: 0,
    endTime: 0
  };

  constructor() {
    this.initializeDefaultRules();
  }

  /**
   * Initialise les règles de diff par défaut
   */
  private initializeDefaultRules(): void {
    this.customRules = [
      {
        name: 'Critical config changes',
        path: /^(config\.(mcp|server|critical))/,
        severity: 'CRITICAL',
        category: 'roo_config'
      },
      {
        name: 'Hardware changes',
        path: /^(hardware\.)/,
        severity: 'IMPORTANT',
        category: 'hardware'
      },
      {
        name: 'Software version changes',
        path: /^(software\..*\.version)/,
        severity: 'IMPORTANT',
        category: 'software'
      },
      {
        name: 'System changes',
        path: /^(system\.)/,
        severity: 'CRITICAL',
        category: 'system'
      }
    ];
  }

  /**
   * Compare deux objets de manière granulaire
   */
  public async compareGranular(
    source: any,
    target: any,
    sourceLabel: string = 'source',
    targetLabel: string = 'target',
    options: GranularDiffOptions = {}
  ): Promise<GranularDiffReport> {
    this.performanceMetrics.startTime = Date.now();
    this.performanceMetrics.nodesCompared = 0;

    const reportId = `granular-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Fusionner les options par défaut
    const mergedOptions: GranularDiffOptions = {
      includeUnchanged: false,
      ignoreWhitespace: true,
      ignoreCase: false,
      arrayDiffMode: 'identity',
      semanticAnalysis: false,
      maxDepth: 50,
      customRules: [],
      ...options
    };

    // Effectuer la comparaison granulaire
    const diffs = await this.performGranularComparison(
      source,
      target,
      '',
      mergedOptions
    );

    // Calculer le résumé
    const summary = this.calculateGranularSummary(diffs);

    this.performanceMetrics.endTime = Date.now();

    return {
      reportId,
      timestamp: new Date().toISOString(),
      sourceLabel,
      targetLabel,
      options: mergedOptions,
      summary,
      diffs,
      performance: {
        executionTime: this.performanceMetrics.endTime - this.performanceMetrics.startTime,
        nodesCompared: this.performanceMetrics.nodesCompared
      }
    };
  }

  /**
   * Effectue la comparaison granulaire récursive
   */
  private async performGranularComparison(
    source: any,
    target: any,
    currentPath: string,
    options: GranularDiffOptions,
    depth: number = 0
  ): Promise<GranularDiffResult[]> {
    if (depth > (options.maxDepth || 50)) {
      return [];
    }

    this.performanceMetrics.nodesCompared++;
    const diffs: GranularDiffResult[] = [];

    // Gérer les valeurs nulles/undefined
    if (source === null || source === undefined) {
      if (target !== null && target !== undefined) {
        diffs.push(this.createDiffResult(
          currentPath,
          'added',
          this.determineSeverity(currentPath, 'added'),
          this.determineCategory(currentPath, target),
          `Propriété ajoutée: ${currentPath}`,
          undefined,
          target
        ));
      }
      return diffs;
    }

    if (target === null || target === undefined) {
      if (source !== null && source !== undefined) {
        diffs.push(this.createDiffResult(
          currentPath,
          'removed',
          this.determineSeverity(currentPath, 'removed'),
          this.determineCategory(currentPath, source),
          `Propriété supprimée: ${currentPath}`,
          source,
          undefined
        ));
      }
      return diffs;
    }

    // Comparaison basée sur les types
    const sourceType = typeof source;
    const targetType = typeof target;

    if (sourceType !== targetType) {
      diffs.push(this.createDiffResult(
        currentPath,
        'modified',
        this.determineSeverity(currentPath, 'modified'),
        this.determineCategory(currentPath, target),
        `Type changé: ${sourceType} → ${targetType}`,
        source,
        target
      ));
      return diffs;
    }

    // Traitement selon le type
    switch (sourceType) {
      case 'object':
        if (Array.isArray(source) && Array.isArray(target)) {
          diffs.push(...await this.compareArrays(
            source,
            target,
            currentPath,
            options,
            depth
          ));
        } else if (this.isPlainObject(source) && this.isPlainObject(target)) {
          diffs.push(...await this.compareObjects(
            source,
            target,
            currentPath,
            options,
            depth
          ));
        } else {
          // Objets complexes (dates, etc.)
          if (!this.deepEqual(source, target, options)) {
            diffs.push(this.createDiffResult(
              currentPath,
              'modified',
              this.determineSeverity(currentPath, 'modified'),
              this.determineCategory(currentPath, target),
              `Objet modifié: ${currentPath}`,
              source,
              target
            ));
          }
        }
        break;

      case 'string':
      case 'number':
      case 'boolean':
        if (!this.deepEqual(source, target, options)) {
          diffs.push(this.createDiffResult(
            currentPath,
            'modified',
            this.determineSeverity(currentPath, 'modified'),
            this.determineCategory(currentPath, target),
            `Valeur modifiée: ${currentPath}`,
            source,
            target,
            this.calculateChangePercent(source, target)
          ));
        }
        break;

      default:
        // Autres types (fonctions, symboles, etc.)
        if (source !== target) {
          diffs.push(this.createDiffResult(
            currentPath,
            'modified',
            this.determineSeverity(currentPath, 'modified'),
            this.determineCategory(currentPath, target),
            `Valeur modifiée: ${currentPath}`,
            source,
            target
          ));
        }
    }

    // Inclure les éléments non modifiés si demandé
    if (options.includeUnchanged && diffs.length === 0) {
      diffs.push(this.createDiffResult(
        currentPath,
        'unchanged',
        'INFO',
        this.determineCategory(currentPath, target),
        `Valeur inchangée: ${currentPath}`,
        source,
        target
      ));
    }

    return diffs;
  }

  /**
   * Compare deux objets de manière granulaire
   */
  private async compareObjects(
    source: Record<string, any>,
    target: Record<string, any>,
    currentPath: string,
    options: GranularDiffOptions,
    depth: number
  ): Promise<GranularDiffResult[]> {
    const diffs: GranularDiffResult[] = [];
    const allKeys = new Set([...Object.keys(source), ...Object.keys(target)]);

    for (const key of allKeys) {
      const keyPath = currentPath ? `${currentPath}.${key}` : key;
      const sourceValue = source[key];
      const targetValue = target[key];

      // Appliquer les règles personnalisées
      const customDiff = this.applyCustomRules(keyPath, sourceValue, targetValue);
      if (customDiff) {
        diffs.push(customDiff);
        continue;
      }

      // Comparaison récursive
      const childDiffs = await this.performGranularComparison(
        sourceValue,
        targetValue,
        keyPath,
        options,
        depth + 1
      );
      diffs.push(...childDiffs);
    }

    return diffs;
  }

  /**
   * Compare deux tableaux de manière granulaire
   */
  private async compareArrays(
    source: any[],
    target: any[],
    currentPath: string,
    options: GranularDiffOptions,
    depth: number
  ): Promise<GranularDiffResult[]> {
    const diffs: GranularDiffResult[] = [];
    const arrayMode = options.arrayDiffMode || 'identity';

    if (arrayMode === 'position') {
      // Comparaison par position
      const maxLength = Math.max(source.length, target.length);
      
      for (let i = 0; i < maxLength; i++) {
        const elementPath = `${currentPath}[${i}]`;
        const sourceValue = source[i];
        const targetValue = target[i];

        const childDiffs = await this.performGranularComparison(
          sourceValue,
          targetValue,
          elementPath,
          options,
          depth + 1
        );
        diffs.push(...childDiffs);
      }
    } else {
      // Comparaison par identité (plus intelligente)
      const sourceMap = new Map();
      const targetMap = new Map();
      
      // Créer des cartes d'identité
      for (let i = 0; i < source.length; i++) {
        const identity = this.createIdentity(source[i]);
        if (!sourceMap.has(identity)) {
          sourceMap.set(identity, []);
        }
        sourceMap.get(identity).push({ index: i, value: source[i] });
      }
      
      for (let i = 0; i < target.length; i++) {
        const identity = this.createIdentity(target[i]);
        if (!targetMap.has(identity)) {
          targetMap.set(identity, []);
        }
        targetMap.get(identity).push({ index: i, value: target[i] });
      }

      // Détecter les ajouts
      for (const [identity, targetItems] of targetMap) {
        if (!sourceMap.has(identity)) {
          for (const item of targetItems) {
            const elementPath = `${currentPath}[${item.index}]`;
            diffs.push(this.createDiffResult(
              elementPath,
              'added',
              'INFO',
              'array',
              `Élément ajouté à l'index ${item.index}`,
              undefined,
              item.value,
              undefined,
              undefined,
              JSON.stringify({ arrayIndex: item.index.toString() })
            ));
          }
        }
      }

      // Détecter les suppressions
      for (const [identity, sourceItems] of sourceMap) {
        if (!targetMap.has(identity)) {
          for (const item of sourceItems) {
            const elementPath = `${currentPath}[${item.index}]`;
            diffs.push(this.createDiffResult(
              elementPath,
              'removed',
              'WARNING',
              'array',
              `Élément supprimé à l'index ${item.index}`,
              item.value,
              undefined,
              undefined,
              undefined,
              JSON.stringify({ arrayIndex: item.index.toString() })
            ));
          }
        }
      }

      // Détecter les déplacements et modifications
      for (const [identity, sourceItems] of sourceMap) {
        if (targetMap.has(identity)) {
          const targetItems = targetMap.get(identity);
          
          // Si le nombre d'occurrences est différent
          if (sourceItems.length !== targetItems.length) {
            const elementPath = `${currentPath}[${sourceItems[0].index}]`;
            diffs.push(this.createDiffResult(
              elementPath,
              'modified',
              'WARNING',
              'array',
              `Nombre d'occurrences modifié pour l'élément: ${sourceItems.length} → ${targetItems.length}`,
              sourceItems.length,
              targetItems.length
            ));
          }
        }
      }
    }

    return diffs;
  }

  /**
   * Crée une identité unique pour un élément de tableau
   */
  private createIdentity(value: any): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    
    if (typeof value === 'object') {
      // Pour les objets, utiliser une combinaison de clés et valeurs
      const keys = Object.keys(value).sort();
      const keyValues = keys.map(key => `${key}:${JSON.stringify(value[key])}`);
      return `object:${keyValues.join('|')}`;
    }
    
    return `${typeof value}:${value.toString()}`;
  }

  /**
   * Applique les règles personnalisées
   */
  private applyCustomRules(
    path: string,
    oldValue: any,
    newValue: any
  ): GranularDiffResult | null {
    for (const rule of [...this.customRules]) {
      let matches = false;
      
      if (typeof rule.path === 'string') {
        matches = path === rule.path || path.startsWith(rule.path);
      } else if (rule.path instanceof RegExp) {
        matches = rule.path.test(path);
      }
      
      if (matches && rule.handler) {
        const customDiff = rule.handler(oldValue, newValue, path);
        if (customDiff) {
          return customDiff;
        }
      }
    }
    
    return null;
  }

  /**
   * Crée un résultat de diff
   */
  private createDiffResult(
    path: string,
    type: GranularDiffType,
    severity: GranularDiffSeverity,
    category: GranularDiffCategory,
    description: string,
    oldValue?: any,
    newValue?: any,
    changePercent?: number,
    oldPath?: string,
    newPath?: string,
    metadata?: any
  ): GranularDiffResult {
    return {
      id: `diff-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      path,
      type,
      severity,
      category,
      description,
      oldValue,
      newValue,
      oldPath,
      newPath,
      metadata: {
        ...metadata,
        valueType: oldValue !== undefined ? typeof oldValue : typeof newValue,
        changePercent
      }
    };
  }

  /**
   * Détermine la sévérité d'un diff
   */
  private determineSeverity(
    path: string,
    type: GranularDiffType
  ): GranularDiffSeverity {
    // Appliquer les règles personnalisées d'abord
    for (const rule of this.customRules) {
      let matches = false;
      
      if (typeof rule.path === 'string') {
        matches = path === rule.path || path.startsWith(rule.path);
      } else if (rule.path instanceof RegExp) {
        matches = rule.path.test(path);
      }
      
      if (matches) {
        return rule.severity;
      }
    }
    
    // Règles par défaut
    if (path.startsWith('system.')) {
      return 'CRITICAL';
    }
    
    if (path.startsWith('config.mcp.') || path.startsWith('config.server.')) {
      return 'CRITICAL';
    }
    
    if (path.startsWith('hardware.')) {
      return 'IMPORTANT';
    }
    
    if (type === 'removed') {
      return 'WARNING';
    }
    
    if (type === 'added') {
      return 'INFO';
    }
    
    return 'IMPORTANT';
  }

  /**
   * Détermine la catégorie d'un diff
   */
  private determineCategory(path: string, value: any): GranularDiffCategory {
    if (path.startsWith('config.')) {
      return 'roo_config';
    }
    
    if (path.startsWith('hardware.')) {
      return 'hardware';
    }
    
    if (path.startsWith('software.')) {
      return 'software';
    }
    
    if (path.startsWith('system.')) {
      return 'system';
    }
    
    if (path.includes('[') && path.includes(']')) {
      return 'array';
    }
    
    if (path.includes('.')) {
      return 'nested';
    }
    
    return 'roo_config';
  }

  /**
   * Calcule le pourcentage de changement
   */
  private calculateChangePercent(oldValue: any, newValue: any): number | undefined {
    if (typeof oldValue === 'number' && typeof newValue === 'number') {
      if (oldValue === 0) {
        return newValue === 0 ? 0 : 100;
      }
      return Math.abs((newValue - oldValue) / oldValue * 100);
    }
    
    if (typeof oldValue === 'string' && typeof newValue === 'string') {
      const maxLength = Math.max(oldValue.length, newValue.length);
      if (maxLength === 0) return 0;
      
      // Calcul simple de différence de caractères
      let differences = 0;
      const minLength = Math.min(oldValue.length, newValue.length);
      
      for (let i = 0; i < minLength; i++) {
        if (oldValue[i] !== newValue[i]) {
          differences++;
        }
      }
      
      differences += Math.abs(oldValue.length - newValue.length);
      return (differences / maxLength) * 100;
    }
    
    return undefined;
  }

  /**
   * Calcule le résumé granulaire
   */
  private calculateGranularSummary(diffs: GranularDiffResult[]): GranularDiffReport['summary'] {
    const summary: GranularDiffReport['summary'] = {
      total: diffs.length,
      byType: {
        added: 0,
        removed: 0,
        modified: 0,
        moved: 0,
        copied: 0,
        unchanged: 0
      },
      bySeverity: {
        CRITICAL: 0,
        IMPORTANT: 0,
        WARNING: 0,
        INFO: 0
      },
      byCategory: {
        roo_config: 0,
        hardware: 0,
        software: 0,
        system: 0,
        nested: 0,
        array: 0,
        semantic: 0
      }
    };

    for (const diff of diffs) {
      summary.byType[diff.type]++;
      summary.bySeverity[diff.severity]++;
      summary.byCategory[diff.category]++;
    }

    return summary;
  }

  /**
   * Vérifie si deux valeurs sont égales en profondeur
   */
  private deepEqual(a: any, b: any, options: GranularDiffOptions): boolean {
    if (a === b) return true;
    
    if (a == null || b == null) return a === b;
    
    if (typeof a !== typeof b) return false;
    
    if (typeof a === 'string') {
      if (options.ignoreWhitespace) {
        a = a.replace(/\s+/g, ' ').trim();
        b = b.replace(/\s+/g, ' ').trim();
      }
      
      if (options.ignoreCase) {
        a = a.toLowerCase();
        b = b.toLowerCase();
      }
    }
    
    if (typeof a !== 'object') return a === b;
    
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.deepEqual(a[i], b[i], options)) return false;
      }
      return true;
    }
    
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    
    if (keysA.length !== keysB.length) return false;
    
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!this.deepEqual(a[key], b[key], options)) return false;
    }
    
    return true;
  }

  /**
   * Vérifie si un objet est un objet plain
   */
  private isPlainObject(obj: any): boolean {
    return obj !== null && 
           typeof obj === 'object' && 
           !Array.isArray(obj) && 
           !(obj instanceof Date) && 
           !(obj instanceof RegExp) &&
           Object.prototype.toString.call(obj) === '[object Object]';
  }

  /**
   * Ajoute une règle personnalisée
   */
  public addCustomRule(rule: GranularDiffRule): void {
    this.customRules.push(rule);
  }

  /**
   * Supprime une règle personnalisée
   */
  public removeCustomRule(name: string): boolean {
    const index = this.customRules.findIndex(rule => rule.name === name);
    if (index !== -1) {
      this.customRules.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Obtient les règles personnalisées
   */
  public getCustomRules(): GranularDiffRule[] {
    return [...this.customRules];
  }

  /**
   * Exporte les résultats de diff vers différents formats
   */
  public async exportDiff(
    report: GranularDiffReport,
    format: 'json' | 'csv' | 'html' = 'json'
  ): Promise<string> {
    switch (format) {
      case 'json':
        return JSON.stringify(report, null, 2);
      
      case 'csv':
        return this.exportToCSV(report);
      
      case 'html':
        return this.exportToHTML(report);
      
      default:
        throw new Error(`Format non supporté: ${format}`);
    }
  }

  /**
   * Exporte vers CSV
   */
  private exportToCSV(report: GranularDiffReport): string {
    const headers = [
      'ID', 'Path', 'Type', 'Severity', 'Category', 'Description',
      'Old Value', 'New Value', 'Change Percent', 'Array Index'
    ];
    
    const rows = report.diffs.map(diff => [
      diff.id,
      diff.path,
      diff.type,
      diff.severity,
      diff.category,
      diff.description,
      diff.oldValue !== undefined ? JSON.stringify(diff.oldValue) : '',
      diff.newValue !== undefined ? JSON.stringify(diff.newValue) : '',
      diff.metadata?.changePercent || '',
      diff.metadata?.arrayIndex || ''
    ]);
    
    return [headers, ...rows]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n');
  }

  /**
   * Exporte vers HTML
   */
  private exportToHTML(report: GranularDiffReport): string {
    const { diffs, summary, performance } = report;
    
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Granular Diff Report - ${report.reportId}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .diff-item { margin: 10px 0; padding: 10px; border-left: 4px solid #ccc; }
        .diff-critical { border-left-color: #d32f2f; }
        .diff-important { border-left-color: #f57c00; }
        .diff-warning { border-left-color: #fbc02d; }
        .diff-info { border-left-color: #1976d2; }
        .diff-path { font-family: monospace; background: #f0f0f0; padding: 2px 5px; }
        .diff-values { margin-top: 5px; }
        .old-value { background: #ffebee; }
        .new-value { background: #e8f5e8; }
        .performance { margin-top: 20px; font-size: 0.9em; color: #666; }
    </style>
</head>
<body>
    <h1>Granular Diff Report</h1>
    <div class="summary">
        <h2>Summary</h2>
        <p><strong>Total differences:</strong> ${summary.total}</p>
        <p><strong>Execution time:</strong> ${performance.executionTime}ms</p>
        <p><strong>Nodes compared:</strong> ${performance.nodesCompared}</p>
        
        <h3>By Type</h3>
        <ul>
            ${Object.entries(summary.byType).map(([type, count]) => 
              `<li>${type}: ${count}</li>`
            ).join('')}
        </ul>
        
        <h3>By Severity</h3>
        <ul>
            ${Object.entries(summary.bySeverity).map(([severity, count]) => 
              `<li>${severity}: ${count}</li>`
            ).join('')}
        </ul>
    </div>
    
    <h2>Differences</h2>
    ${diffs.map(diff => `
        <div class="diff-item diff-${diff.severity.toLowerCase()}">
            <div class="diff-path">${diff.path}</div>
            <div><strong>Type:</strong> ${diff.type} | <strong>Severity:</strong> ${diff.severity}</div>
            <div><strong>Description:</strong> ${diff.description}</div>
            ${diff.oldValue !== undefined ? `<div class="diff-values old-value">Old: ${JSON.stringify(diff.oldValue)}</div>` : ''}
            ${diff.newValue !== undefined ? `<div class="diff-values new-value">New: ${JSON.stringify(diff.newValue)}</div>` : ''}
        </div>
    `).join('')}
    
    <div class="performance">
        <p>Generated on ${report.timestamp}</p>
        <p>Source: ${report.sourceLabel} | Target: ${report.targetLabel}</p>
    </div>
</body>
</html>`;
  }
}