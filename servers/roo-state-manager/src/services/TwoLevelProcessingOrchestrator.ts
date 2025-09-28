/**
 * Two-Level Processing Orchestrator - Cœur de l'architecture 2-niveaux découverte
 * 
 * Architecture consolidée selon SDDD :
 * - Processing immédiat <5s pour interactions utilisateur
 * - Background processing pour opérations lourdes (exports, analyses, maintenance)
 * - Queue management avec priorités selon les catégories d'outils
 * - Monitoring temps réel avec métriques de performance
 * - Intégration Cache Anti-Fuite 220GB
 * 
 * Patterns identifiés dans l'audit des 32 outils :
 * - Display (4 outils) : Majoritairement immédiat (navigation)
 * - Search (2 outils) : Immédiat avec cache intelligent
 * - Summary (3 outils) : Background (synthèses lourdes)
 * - Export (7 outils) : Background (6 stratégies)
 * - Utility (16 outils) : Mixte selon la complexité
 * 
 * @version 1.0.0
 * @since 2025-09-27 (Phase orchestration 2-niveaux)
 */

import { 
  ProcessingLevel,
  ToolCategory,
  ExecutionContext,
  CacheAntiLeakConfig,
  DisplayPreset
} from '../interfaces/UnifiedToolInterface.js';
import { CacheAntiLeakManager } from './CacheAntiLeakManager.js';

/**
 * Tâche de processing avec métadonnées
 */
interface ProcessingTask {
  id: string;
  category: ToolCategory;
  preset?: DisplayPreset;
  toolName: string;
  methodName: string;
  args: any[];
  context: ExecutionContext;
  priority: TaskPriority;
  processingLevel: ProcessingLevel;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  timeoutMs: number;
  retryCount: number;
  maxRetries: number;
}

/**
 * Priorités des tâches selon l'audit
 */
enum TaskPriority {
  CRITICAL = 1,   // Navigation utilisateur immédiate
  HIGH = 2,       // Recherche sémantique
  NORMAL = 3,     // Exports et synthèses
  LOW = 4         // Maintenance et diagnostics
}

/**
 * Résultat de processing unifié
 */
interface ProcessingResult<T = any> {
  taskId: string;
  success: boolean;
  data?: T;
  error?: string;
  processingLevel: ProcessingLevel;
  executionTime: number;
  cached: boolean;
  metadata?: any;
}

/**
 * Métriques de l'orchestrateur en temps réel
 */
interface OrchestratorMetrics {
  // Compteurs globaux
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  
  // Répartition par niveau
  immediateTasks: number;
  backgroundTasks: number;
  mixedTasks: number;
  
  // Performance
  averageImmediateTime: number;
  averageBackgroundTime: number;
  timeoutCount: number;
  retryCount: number;
  
  // Queues
  immediateQueueSize: number;
  backgroundQueueSize: number;
  
  // Cache Anti-Fuite
  cacheHitRate: number;
  cacheEvictions: number;
  
  // Par catégorie (audit 32 outils)
  categoryBreakdown: Map<ToolCategory, {
    total: number;
    immediate: number;
    background: number;
    avgTime: number;
  }>;
}

/**
 * Orchestrateur 2-niveaux pour l'architecture consolidée
 * Implémente les patterns de performance découverts dans l'audit
 */
export class TwoLevelProcessingOrchestrator {
  
  private readonly immediateQueue: ProcessingTask[] = [];
  private readonly backgroundQueue: ProcessingTask[] = [];
  private readonly activeTasks = new Map<string, ProcessingTask>();
  private readonly completedTasks = new Map<string, ProcessingResult>();
  private readonly cacheManager: CacheAntiLeakManager;
  private readonly metrics: OrchestratorMetrics;
  
  private readonly config: {
    immediateTimeoutMs: number;
    backgroundTimeoutMs: number;
    maxConcurrentImmediate: number;
    maxConcurrentBackground: number;
    retryDelayMs: number;
    cacheEnabled: boolean;
  };

  private immediateWorkers = 0;
  private backgroundWorkers = 0;
  private processingTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;

  constructor(
    cacheManager: CacheAntiLeakManager,
    config: Partial<typeof TwoLevelProcessingOrchestrator.prototype.config> = {}
  ) {
    this.cacheManager = cacheManager;
    
    this.config = {
      immediateTimeoutMs: 5000,      // 5s pour processing immédiat
      backgroundTimeoutMs: 300000,   // 5min pour background  
      maxConcurrentImmediate: 10,    // Limite workers immédiats
      maxConcurrentBackground: 3,    // Limite workers background
      retryDelayMs: 1000,            // Délai entre retries
      cacheEnabled: true,
      ...config
    };

    this.metrics = this.initializeMetrics();
    this.startProcessingLoop();
    this.startMetricsCollection();
  }

  /**
   * Initialisation des métriques selon l'audit
   */
  private initializeMetrics(): OrchestratorMetrics {
    return {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      pendingTasks: 0,
      immediateTasks: 0,
      backgroundTasks: 0,
      mixedTasks: 0,
      averageImmediateTime: 0,
      averageBackgroundTime: 0,
      timeoutCount: 0,
      retryCount: 0,
      immediateQueueSize: 0,
      backgroundQueueSize: 0,
      cacheHitRate: 0,
      cacheEvictions: 0,
      categoryBreakdown: new Map([
        [ToolCategory.DISPLAY, { total: 0, immediate: 0, background: 0, avgTime: 0 }],
        [ToolCategory.SEARCH, { total: 0, immediate: 0, background: 0, avgTime: 0 }],
        [ToolCategory.SUMMARY, { total: 0, immediate: 0, background: 0, avgTime: 0 }],
        [ToolCategory.EXPORT, { total: 0, immediate: 0, background: 0, avgTime: 0 }],
        [ToolCategory.UTILITY, { total: 0, immediate: 0, background: 0, avgTime: 0 }]
      ])
    };
  }

  /**
   * Soumission de tâche avec orchestration intelligente
   */
  async submitTask<T>(
    category: ToolCategory,
    toolName: string,
    methodName: string,
    args: any[] = [],
    context: ExecutionContext,
    preset?: DisplayPreset
  ): Promise<ProcessingResult<T>> {
    
    // Détermination du niveau de processing selon l'audit
    const processingLevel = this.determineProcessingLevel(category, toolName, preset);
    const priority = this.determinePriority(category, processingLevel);
    
    const task: ProcessingTask = {
      id: this.generateTaskId(),
      category,
      preset,
      toolName,
      methodName,
      args,
      context,
      priority,
      processingLevel,
      createdAt: new Date(),
      timeoutMs: processingLevel === ProcessingLevel.IMMEDIATE ? 
        this.config.immediateTimeoutMs : this.config.backgroundTimeoutMs,
      retryCount: 0,
      maxRetries: processingLevel === ProcessingLevel.IMMEDIATE ? 1 : 3
    };

    this.metrics.totalTasks++;
    this.updateCategoryMetrics(category, processingLevel);
    
    // Vérification cache si activé
    if (this.config.cacheEnabled) {
      const cacheKey = this.generateCacheKey(task);
      const cachedResult = await this.cacheManager.get<T>(cacheKey);
      
      if (cachedResult?.hit) {
        this.metrics.cacheHitRate = this.calculateCacheHitRate(true);
        return {
          taskId: task.id,
          success: true,
          data: cachedResult.data,
          processingLevel,
          executionTime: 0,
          cached: true,
          metadata: { fromCache: true, cacheTimestamp: cachedResult.timestamp }
        };
      }
    }

    // Orchestration selon le niveau
    switch (processingLevel) {
      case ProcessingLevel.IMMEDIATE:
        return this.scheduleImmediate(task);
        
      case ProcessingLevel.BACKGROUND:
        return this.scheduleBackground(task);
        
      case ProcessingLevel.MIXED:
        // Tentative immédiate avec fallback background
        try {
          return await this.scheduleImmediate(task, true); // allowFallback
        } catch (error) {
          this.logInfo(`Mixed task ${task.id} falling back to background processing`);
          return this.scheduleBackground(task);
        }
        
      default:
        throw new Error(`Unknown processing level: ${processingLevel}`);
    }
  }

  /**
   * Détermination du niveau de processing selon l'audit des 32 outils
   */
  private determineProcessingLevel(
    category: ToolCategory, 
    toolName: string, 
    preset?: DisplayPreset
  ): ProcessingLevel {
    
    // Règles basées sur l'audit exhaustif
    switch (category) {
      case ToolCategory.DISPLAY:
        // 4 outils display : majoritairement immédiat
        if (toolName.includes('details') || toolName.includes('analyze')) {
          return ProcessingLevel.BACKGROUND; // Analyse détaillée
        }
        return ProcessingLevel.IMMEDIATE; // Navigation
        
      case ToolCategory.SEARCH:
        // 2 outils search : immédiat avec cache
        return ProcessingLevel.IMMEDIATE;
        
      case ToolCategory.SUMMARY:
        // 3 outils summary : toujours background (synthèses lourdes)
        return ProcessingLevel.BACKGROUND;
        
      case ToolCategory.EXPORT:
        // 7 outils export : toujours background (6 stratégies)
        return ProcessingLevel.BACKGROUND;
        
      case ToolCategory.UTILITY:
        // 16 outils utility : mixte selon complexité
        if (toolName.includes('build') || toolName.includes('rebuild') || 
            toolName.includes('repair') || toolName.includes('diagnose')) {
          return ProcessingLevel.BACKGROUND; // Opérations lourdes
        }
        if (toolName.includes('get') || toolName.includes('read') || 
            toolName.includes('detect')) {
          return ProcessingLevel.IMMEDIATE; // Lecture rapide
        }
        return ProcessingLevel.MIXED; // Autres cas
        
      default:
        return ProcessingLevel.IMMEDIATE;
    }
  }

  /**
   * Détermination de la priorité selon l'audit
   */
  private determinePriority(category: ToolCategory, level: ProcessingLevel): TaskPriority {
    if (level === ProcessingLevel.IMMEDIATE) {
      switch (category) {
        case ToolCategory.DISPLAY:
          return TaskPriority.CRITICAL; // Navigation utilisateur
        case ToolCategory.SEARCH:
          return TaskPriority.HIGH;      // Recherche interactive
        default:
          return TaskPriority.NORMAL;
      }
    }
    
    // Background tasks
    switch (category) {
      case ToolCategory.SUMMARY:
      case ToolCategory.EXPORT:
        return TaskPriority.NORMAL;   // Synthèses et exports
      case ToolCategory.UTILITY:
        return TaskPriority.LOW;      // Maintenance
      default:
        return TaskPriority.NORMAL;
    }
  }

  /**
   * Planification de tâche immédiate
   */
  private async scheduleImmediate<T>(
    task: ProcessingTask, 
    allowFallback: boolean = false
  ): Promise<ProcessingResult<T>> {
    
    this.metrics.immediateTasks++;
    
    if (this.immediateWorkers >= this.config.maxConcurrentImmediate) {
      if (allowFallback) {
        throw new Error('Immediate processing at capacity, fallback to background');
      }
      // Ajout à la queue avec tri par priorité
      this.immediateQueue.push(task);
      this.immediateQueue.sort((a, b) => a.priority - b.priority);
      this.metrics.immediateQueueSize = this.immediateQueue.length;
      
      return this.waitForTaskCompletion<T>(task.id);
    }
    
    return this.executeImmediate<T>(task);
  }

  /**
   * Planification de tâche background
   */
  private scheduleBackground<T>(task: ProcessingTask): ProcessingResult<T> {
    this.metrics.backgroundTasks++;
    
    // Ajout à la queue background avec tri par priorité
    this.backgroundQueue.push(task);
    this.backgroundQueue.sort((a, b) => a.priority - b.priority);
    this.metrics.backgroundQueueSize = this.backgroundQueue.length;
    
    // Retour immédiat avec job ID
    return {
      taskId: task.id,
      success: true,
      data: {
        jobId: task.id,
        status: 'queued',
        queuePosition: this.backgroundQueue.length,
        estimatedStartTime: new Date(Date.now() + (this.backgroundQueue.length * 5000))
      } as T,
      processingLevel: ProcessingLevel.BACKGROUND,
      executionTime: 0,
      cached: false,
      metadata: { queued: true, backgroundProcessing: true }
    };
  }

  /**
   * Exécution immédiate avec timeout
   */
  private async executeImmediate<T>(task: ProcessingTask): Promise<ProcessingResult<T>> {
    this.immediateWorkers++;
    this.activeTasks.set(task.id, task);
    task.startedAt = new Date();
    
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Immediate processing timeout')), task.timeoutMs);
      });
      
      const executionPromise = this.executeTask<T>(task);
      const result = await Promise.race([executionPromise, timeoutPromise]);
      
      task.completedAt = new Date();
      const executionTime = task.completedAt.getTime() - task.startedAt!.getTime();
      
      const processResult: ProcessingResult<T> = {
        taskId: task.id,
        success: true,
        data: result,
        processingLevel: task.processingLevel,
        executionTime,
        cached: false
      };
      
      this.completedTasks.set(task.id, processResult);
      this.updateMetricsAfterCompletion(task, executionTime, true);
      
      // Cache du résultat si activé
      if (this.config.cacheEnabled) {
        await this.cacheResult(task, result);
      }
      
      return processResult;
      
    } catch (error) {
      return this.handleTaskError<T>(task, error);
    } finally {
      this.immediateWorkers--;
      this.activeTasks.delete(task.id);
    }
  }

  /**
   * Exécution d'une tâche (stub pour intégration future)
   */
  private async executeTask<T>(task: ProcessingTask): Promise<T> {
    // Simulation d'exécution - sera remplacé par l'appel réel aux services
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
    
    return {
      taskId: task.id,
      toolName: task.toolName,
      methodName: task.methodName,
      category: task.category,
      result: 'stubbed_execution',
      args: task.args,
      timestamp: new Date().toISOString()
    } as T;
  }

  /**
   * Gestion des erreurs avec retry logic
   */
  private async handleTaskError<T>(task: ProcessingTask, error: any): Promise<ProcessingResult<T>> {
    task.retryCount++;
    this.metrics.retryCount++;
    
    if (task.retryCount <= task.maxRetries) {
      // Retry avec délai exponentiel
      const delay = this.config.retryDelayMs * Math.pow(2, task.retryCount - 1);
      setTimeout(() => {
        if (task.processingLevel === ProcessingLevel.IMMEDIATE) {
          this.immediateQueue.unshift(task); // Priorité haute pour retry
        } else {
          this.backgroundQueue.unshift(task);
        }
      }, delay);
      
      return this.waitForTaskCompletion<T>(task.id);
    }
    
    // Échec définitif
    this.metrics.failedTasks++;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return {
      taskId: task.id,
      success: false,
      error: errorMessage,
      processingLevel: task.processingLevel,
      executionTime: task.startedAt ? Date.now() - task.startedAt.getTime() : 0,
      cached: false,
      metadata: { retryCount: task.retryCount, finalFailure: true }
    };
  }

  /**
   * Attente de completion de tâche
   */
  private async waitForTaskCompletion<T>(taskId: string): Promise<ProcessingResult<T>> {
    return new Promise((resolve) => {
      const checkCompletion = () => {
        const result = this.completedTasks.get(taskId);
        if (result) {
          resolve(result as ProcessingResult<T>);
        } else {
          setTimeout(checkCompletion, 100);
        }
      };
      checkCompletion();
    });
  }

  /**
   * Boucle de processing principal
   */
  private startProcessingLoop(): void {
    this.processingTimer = setInterval(() => {
      this.processImmediateQueue();
      this.processBackgroundQueue();
    }, 100);
  }

  /**
   * Processing de la queue immédiate
   */
  private async processImmediateQueue(): Promise<void> {
    while (this.immediateQueue.length > 0 && 
           this.immediateWorkers < this.config.maxConcurrentImmediate) {
      const task = this.immediateQueue.shift()!;
      this.metrics.immediateQueueSize = this.immediateQueue.length;
      
      // Exécution asynchrone
      this.executeImmediate(task).catch(error => {
        this.logError(`Immediate task ${task.id} failed`, error);
      });
    }
  }

  /**
   * Processing de la queue background
   */
  private async processBackgroundQueue(): Promise<void> {
    while (this.backgroundQueue.length > 0 && 
           this.backgroundWorkers < this.config.maxConcurrentBackground) {
      const task = this.backgroundQueue.shift()!;
      this.metrics.backgroundQueueSize = this.backgroundQueue.length;
      
      // Exécution background asynchrone
      this.executeBackground(task).catch(error => {
        this.logError(`Background task ${task.id} failed`, error);
      });
    }
  }

  /**
   * Exécution background (sans timeout strict)
   */
  private async executeBackground(task: ProcessingTask): Promise<void> {
    this.backgroundWorkers++;
    this.activeTasks.set(task.id, task);
    task.startedAt = new Date();
    
    try {
      const result = await this.executeTask(task);
      task.completedAt = new Date();
      const executionTime = task.completedAt.getTime() - task.startedAt.getTime();
      
      const processResult: ProcessingResult = {
        taskId: task.id,
        success: true,
        data: result,
        processingLevel: task.processingLevel,
        executionTime,
        cached: false
      };
      
      this.completedTasks.set(task.id, processResult);
      this.updateMetricsAfterCompletion(task, executionTime, true);
      
      // Cache du résultat
      if (this.config.cacheEnabled) {
        await this.cacheResult(task, result);
      }
      
    } catch (error) {
      await this.handleTaskError(task, error);
    } finally {
      this.backgroundWorkers--;
      this.activeTasks.delete(task.id);
    }
  }

  /**
   * Génération de clé de cache
   */
  private generateCacheKey(task: ProcessingTask): string {
    const argsHash = JSON.stringify(task.args).substring(0, 50);
    return `${task.category}:${task.toolName}:${task.methodName}:${argsHash}`;
  }

  /**
   * Cache du résultat
   */
  private async cacheResult(task: ProcessingTask, result: any): Promise<void> {
    const cacheKey = this.generateCacheKey(task);
    const ttl = task.processingLevel === ProcessingLevel.IMMEDIATE ? 
      1000 * 60 * 5 : // 5 min pour immediate
      1000 * 60 * 60; // 1h pour background
    
    await this.cacheManager.store(cacheKey, result, {
      strategy: task.processingLevel === ProcessingLevel.IMMEDIATE ? 'moderate' : 'conservative',
      ttl
    });
  }

  /**
   * Mise à jour métriques après completion
   */
  private updateMetricsAfterCompletion(task: ProcessingTask, executionTime: number, success: boolean): void {
    if (success) {
      this.metrics.completedTasks++;
    } else {
      this.metrics.failedTasks++;
    }
    
    // Mise à jour moyennes par niveau
    if (task.processingLevel === ProcessingLevel.IMMEDIATE) {
      const currentAvg = this.metrics.averageImmediateTime;
      const count = this.metrics.immediateTasks;
      this.metrics.averageImmediateTime = (currentAvg * (count - 1) + executionTime) / count;
    } else {
      const currentAvg = this.metrics.averageBackgroundTime;
      const count = this.metrics.backgroundTasks;
      this.metrics.averageBackgroundTime = (currentAvg * (count - 1) + executionTime) / count;
    }
    
    // Mise à jour breakdown par catégorie
    const categoryStats = this.metrics.categoryBreakdown.get(task.category);
    if (categoryStats) {
      categoryStats.total++;
      if (task.processingLevel === ProcessingLevel.IMMEDIATE) {
        categoryStats.immediate++;
      } else {
        categoryStats.background++;
      }
      const currentAvg = categoryStats.avgTime;
      categoryStats.avgTime = (currentAvg * (categoryStats.total - 1) + executionTime) / categoryStats.total;
    }
  }

  /**
   * Mise à jour métriques par catégorie
   */
  private updateCategoryMetrics(category: ToolCategory, level: ProcessingLevel): void {
    // Implémentation simplifiée - sera étoffée selon les besoins
  }

  /**
   * Calcul du taux de hit cache
   */
  private calculateCacheHitRate(hit: boolean): number {
    // Simulation - sera intégré avec CacheAntiLeakManager
    return hit ? this.metrics.cacheHitRate + 0.1 : this.metrics.cacheHitRate;
  }

  /**
   * Collection périodique des métriques
   */
  private startMetricsCollection(): void {
    this.metricsTimer = setInterval(() => {
      this.collectMetrics();
    }, 30000); // Toutes les 30s
  }

  /**
   * Collection des métriques en temps réel
   */
  private collectMetrics(): void {
    this.metrics.pendingTasks = this.immediateQueue.length + this.backgroundQueue.length;
    this.metrics.immediateQueueSize = this.immediateQueue.length;
    this.metrics.backgroundQueueSize = this.backgroundQueue.length;
    
    // Intégration avec CacheAntiLeakManager
    const cacheStats = this.cacheManager.getStats();
    this.metrics.cacheHitRate = cacheStats.hitRate;
    this.metrics.cacheEvictions = cacheStats.evictionCount;
  }

  /**
   * APIs publiques
   */

  /**
   * Récupération du statut d'une tâche
   */
  getTaskStatus(taskId: string): 'pending' | 'running' | 'completed' | 'failed' | 'not_found' {
    if (this.completedTasks.has(taskId)) {
      const result = this.completedTasks.get(taskId)!;
      return result.success ? 'completed' : 'failed';
    }
    
    if (this.activeTasks.has(taskId)) {
      return 'running';
    }
    
    if (this.immediateQueue.some(t => t.id === taskId) || 
        this.backgroundQueue.some(t => t.id === taskId)) {
      return 'pending';
    }
    
    return 'not_found';
  }

  /**
   * Récupération du résultat d'une tâche
   */
  getTaskResult<T>(taskId: string): ProcessingResult<T> | null {
    return this.completedTasks.get(taskId) as ProcessingResult<T> || null;
  }

  /**
   * Métriques en temps réel
   */
  getMetrics(): OrchestratorMetrics {
    this.collectMetrics();
    return { ...this.metrics };
  }

  /**
   * Health check de l'orchestrateur
   */
  healthCheck(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    issues: string[];
    metrics: OrchestratorMetrics;
  } {
    const issues: string[] = [];
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    // Vérification des queues
    if (this.metrics.immediateQueueSize > 50) {
      issues.push(`Large immediate queue: ${this.metrics.immediateQueueSize} tasks`);
      status = 'degraded';
    }
    
    if (this.metrics.backgroundQueueSize > 200) {
      issues.push(`Large background queue: ${this.metrics.backgroundQueueSize} tasks`);
      if (status === 'healthy') status = 'degraded';
    }
    
    // Vérification des timeouts
    if (this.metrics.timeoutCount > this.metrics.totalTasks * 0.1) {
      issues.push(`High timeout rate: ${this.metrics.timeoutCount}/${this.metrics.totalTasks}`);
      status = 'unhealthy';
    }
    
    // Vérification temps de réponse
    if (this.metrics.averageImmediateTime > this.config.immediateTimeoutMs * 0.8) {
      issues.push(`High immediate processing time: ${this.metrics.averageImmediateTime}ms`);
      if (status !== 'unhealthy') status = 'degraded';
    }
    
    return {
      status,
      issues,
      metrics: this.getMetrics()
    };
  }

  /**
   * Arrêt propre de l'orchestrateur
   */
  async shutdown(): Promise<void> {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    // Attendre la completion des tâches actives (timeout 30s)
    const shutdownTimeout = setTimeout(() => {
      this.logWarning('Shutdown timeout - forcing stop with active tasks');
    }, 30000);
    
    while (this.activeTasks.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    clearTimeout(shutdownTimeout);
    this.logInfo('Two-Level Processing Orchestrator shutdown complete');
  }

  // Méthodes utilitaires
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private logInfo(message: string): void {
    console.log(`[TwoLevelOrchestrator] INFO: ${message}`);
  }

  private logWarning(message: string): void {
    console.warn(`[TwoLevelOrchestrator] WARN: ${message}`);
  }

  private logError(message: string, error?: any): void {
    console.error(`[TwoLevelOrchestrator] ERROR: ${message}`, error);
  }
}

/**
 * Factory pour création de l'orchestrateur
 */
export function createTwoLevelProcessingOrchestrator(
  cacheManager: CacheAntiLeakManager,
  config?: any
): TwoLevelProcessingOrchestrator {
  return new TwoLevelProcessingOrchestrator(cacheManager, config);
}

/**
 * Export des types pour utilisation externe
 */
export type { 
  ProcessingTask, 
  ProcessingResult, 
  OrchestratorMetrics, 
  TaskPriority 
};