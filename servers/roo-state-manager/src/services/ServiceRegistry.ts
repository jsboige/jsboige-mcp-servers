/**
 * Service Registry - Dependency Injection consolidé pour l'architecture 2-niveaux
 * 
 * Architecture consolidée selon SDDD :
 * - Dependency Injection pour les 5 services consolidés
 * - Support Architecture 2-niveaux : Processing <5s + Background pour opérations lourdes
 * - Cache Anti-Fuite intégré avec monitoring 220GB
 * - Backward Compatibility pour migration progressive des 32 outils
 * 
 * Consolidation des services selon l'audit :
 * - ConsolidatedDisplayService (4 outils) : Navigation et affichage
 * - ConsolidatedSearchService (2 outils) : Recherche sémantique
 * - ConsolidatedSummaryService (3 outils) : Synthèse et résumés
 * - ConsolidatedExportService (7 outils) : 6 stratégies d'export
 * - ConsolidatedUtilityService (16 outils) : Maintenance et diagnostics
 * 
 * @version 1.0.0
 * @since 2025-09-27 (Phase services consolidés)
 */

import {
  UnifiedServices,
  IStorageService,
  ICacheAntiLeakService,
  ISearchService,
  IExportService,
  ISummaryService,
  IDisplayService,
  IUtilityService,
  ProcessingLevel,
  CacheAntiLeakConfig,
  ExecutionContext
} from '../interfaces/UnifiedToolInterface.js';
import { StateManagerError } from '../types/errors.js';

/**
 * Configuration du registre de services
 */
interface ServiceRegistryConfig {
  /** Configuration Cache Anti-Fuite */
  cacheConfig: CacheAntiLeakConfig;
  
  /** Mode debug pour monitoring */
  debugMode: boolean;
  
  /** Services externes optionnels (pour injection) */
  externalServices?: Partial<UnifiedServices>;
  
  /** Monitoring des performances actif */
  enablePerformanceMonitoring: boolean;
}

/**
 * Métriques de performance par service
 */
interface ServiceMetrics {
  serviceName: string;
  callCount: number;
  averageExecutionTime: number;
  immediateCallsCount: number;
  backgroundCallsCount: number;
  cacheHitRate: number;
  lastCall: Date;
  errorCount: number;
}

/**
 * Interface pour les services avec monitoring intégré
 */
interface ManagedService {
  serviceName: string;
  instance: any;
  metrics: ServiceMetrics;
  processingLevel: ProcessingLevel;
  cacheEnabled: boolean;
}

/**
 * Registry des services consolidés avec Dependency Injection
 * Implémente l'architecture modulaire découverte dans l'audit
 */
export class ServiceRegistry {
  
  private readonly services = new Map<string, ManagedService>();
  private readonly config: ServiceRegistryConfig;
  private readonly startTime: Date;

  constructor(config: Partial<ServiceRegistryConfig> = {}) {
    this.startTime = new Date();
    this.config = {
      cacheConfig: {
        maxTrafficGB: 220,
        consistencyCheckHours: 24,
        minReindexIntervalHours: 4,
        enabled: true,
        alerts: {
          memoryThresholdGB: 200,
          processingTimeoutMs: 30000
        }
      },
      debugMode: false,
      enablePerformanceMonitoring: true,
      ...config
    };

    this.initializeServices();
  }

  /**
   * Initialisation des services consolidés
   */
  private initializeServices(): void {
    // Enregistrement des services consolidés (seront implémentés progressivement)
    this.registerService('display', null, ProcessingLevel.IMMEDIATE);
    this.registerService('search', null, ProcessingLevel.IMMEDIATE);
    this.registerService('summary', null, ProcessingLevel.BACKGROUND);
    this.registerService('export', null, ProcessingLevel.BACKGROUND);
    this.registerService('utility', null, ProcessingLevel.MIXED);
    this.registerService('storage', null, ProcessingLevel.IMMEDIATE);
    this.registerService('cache', null, ProcessingLevel.IMMEDIATE);

    this.logInfo('Service Registry initialized with 7 consolidated services');
  }

  /**
   * Enregistrement d'un service avec monitoring
   */
  registerService(
    serviceName: keyof UnifiedServices,
    instance: any,
    processingLevel: ProcessingLevel = ProcessingLevel.IMMEDIATE,
    cacheEnabled: boolean = true
  ): void {
    
    const metrics: ServiceMetrics = {
      serviceName,
      callCount: 0,
      averageExecutionTime: 0,
      immediateCallsCount: 0,
      backgroundCallsCount: 0,
      cacheHitRate: 0,
      lastCall: new Date(),
      errorCount: 0
    };

    const managedService: ManagedService = {
      serviceName,
      instance: instance || this.createServiceStub(serviceName),
      metrics,
      processingLevel,
      cacheEnabled
    };

    this.services.set(serviceName, managedService);
    this.logInfo(`Service '${serviceName}' registered with ${processingLevel} processing`);
  }

  /**
   * Récupération d'un service avec monitoring
   */
  getService<T>(serviceName: keyof UnifiedServices): T {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new StateManagerError(
        `Service '${serviceName}' not found in registry`,
        'SERVICE_NOT_FOUND',
        'ServiceRegistry',
        { serviceName, availableServices: Array.from(this.services.keys()) }
      );
    }

    // Mise à jour des métriques d'accès
    service.metrics.callCount++;
    service.metrics.lastCall = new Date();

    return service.instance as T;
  }

  /**
   * Exécution d'une méthode de service avec monitoring intégré
   */
  async executeServiceMethod<T>(
    serviceName: keyof UnifiedServices,
    methodName: string,
    args: any[] = [],
    context?: ExecutionContext
  ): Promise<T> {
    
    const startTime = Date.now();
    const service = this.services.get(serviceName);
    
    if (!service) {
      throw new StateManagerError(
        `Service '${serviceName}' not found`,
        'SERVICE_NOT_FOUND',
        'ServiceRegistry',
        { serviceName, methodName }
      );
    }

    try {
      // Vérification Cache Anti-Fuite
      await this.checkCacheAntiLeak();
      
      // Exécution selon le niveau de processing
      let result: T;
      
      switch (service.processingLevel) {
        case ProcessingLevel.IMMEDIATE:
          service.metrics.immediateCallsCount++;
          result = await this.executeImmediate(service, methodName, args);
          break;
          
        case ProcessingLevel.BACKGROUND:
          service.metrics.backgroundCallsCount++;
          result = await this.executeBackground(service, methodName, args);
          break;
          
        case ProcessingLevel.MIXED:
          // Tentative immédiate avec fallback background
          service.metrics.immediateCallsCount++;
          try {
            result = await Promise.race([
              this.executeImmediate(service, methodName, args),
              this.createTimeoutPromise(5000)
            ]) as T;
          } catch (timeoutError) {
            service.metrics.backgroundCallsCount++;
            result = await this.executeBackground(service, methodName, args);
          }
          break;
          
        default:
          throw new StateManagerError(
            `Unknown processing level: ${service.processingLevel}`,
            'INVALID_PROCESSING_LEVEL',
            'ServiceRegistry',
            { serviceName, processingLevel: service.processingLevel }
          );
      }
      
      // Mise à jour métriques de succès
      this.updateSuccessMetrics(service, Date.now() - startTime);
      
      return result;
      
    } catch (error) {
      // Mise à jour métriques d'erreur
      service.metrics.errorCount++;
      this.logError(`Service ${serviceName}.${methodName} failed`, error);
      throw error;
    }
  }

  /**
   * Exécution immédiate avec timeout <5s
   */
  private async executeImmediate<T>(
    service: ManagedService,
    methodName: string,
    args: any[]
  ): Promise<T> {
    
    if (!service.instance || !service.instance[methodName]) {
      return this.executeServiceStub(service.serviceName, methodName, args) as T;
    }

    return await service.instance[methodName](...args);
  }

  /**
   * Exécution en arrière-plan (sans timeout strict)
   */
  private async executeBackground<T>(
    service: ManagedService,
    methodName: string, 
    args: any[]
  ): Promise<T> {
    
    if (!service.instance || !service.instance[methodName]) {
      // Pour background, retour immédiat avec promesse de traitement
      return {
        jobId: `bg_${service.serviceName}_${Date.now()}`,
        status: 'processing',
        message: `Background processing started for ${service.serviceName}.${methodName}`,
        estimatedCompletion: new Date(Date.now() + 30000)
      } as T;
    }

    return await service.instance[methodName](...args);
  }

  /**
   * Promise de timeout pour processing mixed
   */
  private createTimeoutPromise(timeout: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Processing timeout')), timeout);
    });
  }

  /**
   * Stub par défaut pour services non encore implémentés
   */
  private createServiceStub(serviceName: string): any {
    const stubMethods: Record<string, any> = {};
    
    // Méthodes communes selon l'audit des 32 outils
    const commonMethods = [
      'execute', 'process', 'handle', 'get', 'set', 'list', 'create', 
      'update', 'delete', 'search', 'export', 'import', 'validate'
    ];

    commonMethods.forEach(method => {
      stubMethods[method] = async (...args: any[]) => {
        return this.executeServiceStub(serviceName, method, args);
      };
    });

    return stubMethods;
  }

  /**
   * Exécution de stub avec logging pour développement
   */
  private executeServiceStub(serviceName: string, methodName: string, args: any[]): any {
    this.logInfo(`STUB: ${serviceName}.${methodName} called with args:`, args);
    
    return {
      service: serviceName,
      method: methodName,
      status: 'stubbed',
      args,
      timestamp: new Date().toISOString(),
      note: 'Service implementation pending - using stub'
    };
  }

  /**
   * Mise à jour des métriques de succès
   */
  private updateSuccessMetrics(service: ManagedService, executionTime: number): void {
    const currentAvg = service.metrics.averageExecutionTime;
    const count = service.metrics.callCount;
    
    service.metrics.averageExecutionTime = (currentAvg * (count - 1) + executionTime) / count;
  }

  /**
   * Vérification Cache Anti-Fuite selon seuils 220GB
   */
  private async checkCacheAntiLeak(): Promise<void> {
    if (!this.config.cacheConfig.enabled) return;
    
    // Simulation vérification mémoire globale
    const memoryUsage = process.memoryUsage();
    const memoryUsageGB = memoryUsage.heapUsed / (1024 * 1024 * 1024);
    
    if (memoryUsageGB > this.config.cacheConfig.alerts.memoryThresholdGB) {
      this.logWarning(`Cache Anti-Leak Alert: Memory usage ${memoryUsageGB.toFixed(2)}GB exceeds threshold`);
      
      // Déclenchement cleanup sur le service cache
      const cacheService = this.services.get('cache');
      if (cacheService?.instance?.cleanup) {
        await cacheService.instance.cleanup();
      }
    }
  }

  /**
   * Récupération des services unifiés pour injection
   */
  getUnifiedServices(): UnifiedServices {
    return {
      storage: this.getService<IStorageService>('storage'),
      cache: this.getService<ICacheAntiLeakService>('cache'),
      search: this.getService<ISearchService>('search'),
      export: this.getService<IExportService>('export'),
      summary: this.getService<ISummaryService>('summary'),
      display: this.getService<IDisplayService>('display'),
      utility: this.getService<IUtilityService>('utility')
    };
  }

  /**
   * Injection de services externes (pour migration progressive)
   */
  injectExternalService(serviceName: keyof UnifiedServices, instance: any): void {
    const existingService = this.services.get(serviceName);
    if (existingService) {
      existingService.instance = instance;
      this.logInfo(`External service injected for '${serviceName}'`);
    } else {
      this.registerService(serviceName, instance);
    }
  }

  /**
   * Métriques globales du registre
   */
  getRegistryMetrics(): {
    totalServices: number;
    totalCalls: number;
    averageResponseTime: number;
    cacheHitRate: number;
    errorRate: number;
    uptime: number;
    serviceBreakdown: ServiceMetrics[];
  } {
    
    const metrics = Array.from(this.services.values()).map(s => s.metrics);
    
    const totalCalls = metrics.reduce((sum, m) => sum + m.callCount, 0);
    const totalErrors = metrics.reduce((sum, m) => sum + m.errorCount, 0);
    const avgResponseTime = totalCalls > 0 ? 
      metrics.reduce((sum, m) => sum + m.averageExecutionTime * m.callCount, 0) / totalCalls : 0;

    return {
      totalServices: this.services.size,
      totalCalls,
      averageResponseTime: avgResponseTime,
      cacheHitRate: 0, // À implémenter avec les services cache
      errorRate: totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0,
      uptime: Date.now() - this.startTime.getTime(),
      serviceBreakdown: metrics
    };
  }

  /**
   * Health check du registre complet
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: Record<string, 'healthy' | 'degraded' | 'error'>;
    metrics: {
      totalServices: number;
      totalCalls: number;
      averageResponseTime: number;
      cacheHitRate: number;
      errorRate: number;
      uptime: number;
      serviceBreakdown: ServiceMetrics[];
    };
  }> {
    
    const serviceStatuses: Record<string, 'healthy' | 'degraded' | 'error'> = {};
    
    // Vérification de chaque service
    for (const [name, service] of this.services) {
      const errorRate = service.metrics.callCount > 0 ? 
        (service.metrics.errorCount / service.metrics.callCount) * 100 : 0;
        
      if (errorRate > 50) {
        serviceStatuses[name] = 'error';
      } else if (errorRate > 10 || service.metrics.averageExecutionTime > 10000) {
        serviceStatuses[name] = 'degraded';
      } else {
        serviceStatuses[name] = 'healthy';
      }
    }
    
    // Status global
    const errorServices = Object.values(serviceStatuses).filter(s => s === 'error').length;
    const degradedServices = Object.values(serviceStatuses).filter(s => s === 'degraded').length;
    
    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (errorServices > 2) {
      status = 'unhealthy';
    } else if (errorServices > 0 || degradedServices > 3) {
      status = 'degraded';  
    } else {
      status = 'healthy';
    }

    return {
      status,
      services: serviceStatuses,
      metrics: this.getRegistryMetrics()
    };
  }

  /**
   * Arrêt propre du registre
   */
  async shutdown(): Promise<void> {
    this.logInfo('Shutting down Service Registry...');
    
    // Arrêt des services avec cleanup
    for (const [name, service] of this.services) {
      try {
        if (service.instance?.shutdown) {
          await service.instance.shutdown();
        }
        this.logInfo(`Service '${name}' shut down successfully`);
      } catch (error) {
        this.logError(`Error shutting down service '${name}'`, error);
      }
    }
    
    this.services.clear();
    this.logInfo('Service Registry shutdown complete');
  }

  // Méthodes utilitaires de logging
  private logInfo(message: string, ...args: any[]): void {
    if (this.config.debugMode) {
      console.log(`[ServiceRegistry] INFO: ${message}`, ...args);
    }
  }

  private logWarning(message: string): void {
    console.warn(`[ServiceRegistry] WARN: ${message}`);
  }

  private logError(message: string, error?: any): void {
    console.error(`[ServiceRegistry] ERROR: ${message}`, error);
  }
}

/**
 * Instance singleton du registre (optionnel)
 */
let globalRegistry: ServiceRegistry | null = null;

/**
 * Factory pour création/récupération du registre global
 */
export function getServiceRegistry(config?: Partial<ServiceRegistryConfig>): ServiceRegistry {
  if (!globalRegistry) {
    globalRegistry = new ServiceRegistry(config);
  }
  return globalRegistry;
}

/**
 * Factory pour création d'un nouveau registre  
 */
export function createServiceRegistry(config?: Partial<ServiceRegistryConfig>): ServiceRegistry {
  return new ServiceRegistry(config);
}

/**
 * Export du type pour injection externe
 */
export type { ServiceRegistryConfig, ServiceMetrics, ManagedService };