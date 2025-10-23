/**
 * Deployment Helpers - Wrappers spécifiques pour scripts deployment PowerShell
 * 
 * Fournit des fonctions TypeScript typées pour exécuter les scripts deployment
 * PowerShell via PowerShellExecutor existant.
 * 
 * @module deployment-helpers
 * @version 1.0.0
 */

import { PowerShellExecutor, type PowerShellExecutionResult } from '../services/PowerShellExecutor.js';
import { createLogger, type Logger } from './logger.js';
import { join } from 'path';

/**
 * Résultat d'un déploiement
 */
export interface DeploymentResult {
  /** Succès du déploiement */
  success: boolean;
  
  /** Script exécuté */
  scriptName: string;
  
  /** Temps d'exécution en ms */
  duration: number;
  
  /** Code de sortie */
  exitCode: number;
  
  /** Logs stdout */
  stdout: string;
  
  /** Logs stderr */
  stderr: string;
  
  /** Message d'erreur si échec */
  error?: string;
}

/**
 * Options pour les déploiements
 */
export interface DeploymentOptions {
  /** Timeout en ms (défaut: 300000 = 5 minutes) */
  timeout?: number;
  
  /** Activer mode simulation (dry-run) */
  dryRun?: boolean;
  
  /** Logger personnalisé */
  logger?: Logger;
  
  /** Variables d'environnement supplémentaires */
  env?: Record<string, string>;
}

/**
 * Classe DeploymentHelpers pour orchestrer les déploiements PowerShell
 */
export class DeploymentHelpers {
  private executor: PowerShellExecutor;
  private logger: Logger;
  private readonly scriptsBasePath: string;
  
  /**
   * Constructeur
   * @param scriptsBasePath Chemin de base vers scripts/deployment
   */
  constructor(scriptsBasePath?: string) {
    const rooHome = process.env.ROO_HOME || 'd:/roo-extensions';
    this.scriptsBasePath = scriptsBasePath || join(rooHome, 'scripts', 'deployment');
    this.executor = new PowerShellExecutor();
    this.logger = createLogger('DeploymentHelpers');
    
    this.logger.info(`Deployment helpers initialized`, { scriptsBasePath: this.scriptsBasePath });
  }
  
  /**
   * Exécuter un script deployment générique
   * 
   * @param scriptName Nom du script (ex: 'deploy-modes.ps1')
   * @param args Arguments PowerShell optionnels
   * @param options Options de déploiement
   * @returns Résultat du déploiement
   */
  async executeDeploymentScript(
    scriptName: string,
    args: string[] = [],
    options: DeploymentOptions = {}
  ): Promise<DeploymentResult> {
    const startTime = Date.now();
    const scriptPath = join(this.scriptsBasePath, scriptName);
    const timeout = options.timeout ?? 300000; // 5 minutes par défaut
    
    this.logger.info(`Executing deployment script`, { 
      scriptName, 
      args, 
      timeout,
      dryRun: options.dryRun 
    });
    
    try {
      // Ajouter flag dry-run si demandé
      const finalArgs = options.dryRun ? [...args, '-WhatIf'] : args;
      
      const result = await this.executor.executeScript(scriptPath, finalArgs, {
        timeout,
        env: options.env
      });
      
      const duration = Date.now() - startTime;
      
      const deployResult: DeploymentResult = {
        success: result.success,
        scriptName,
        duration,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      };
      
      if (!result.success) {
        deployResult.error = `Script failed with exit code ${result.exitCode}`;
        this.logger.error(`Deployment script failed`, undefined, deployResult);
      } else {
        this.logger.info(`Deployment script succeeded`, deployResult);
      }
      
      return deployResult;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.logger.error(`Deployment script exception`, error);
      
      return {
        success: false,
        scriptName,
        duration,
        exitCode: -1,
        stdout: '',
        stderr: errorMessage,
        error: `Exception: ${errorMessage}`
      };
    }
  }
  
  /**
   * Déployer la configuration des modes Roo
   * 
   * @param options Options de déploiement
   * @returns Résultat du déploiement
   */
  async deployModes(options: DeploymentOptions = {}): Promise<DeploymentResult> {
    this.logger.info('Deploying Roo modes configuration');
    return this.executeDeploymentScript('deploy-modes.ps1', [], options);
  }
  
  /**
   * Déployer les MCPs
   * 
   * @param options Options de déploiement
   * @returns Résultat du déploiement
   */
  async deployMCPs(options: DeploymentOptions = {}): Promise<DeploymentResult> {
    this.logger.info('Deploying MCPs');
    return this.executeDeploymentScript('install-mcps.ps1', [], options);
  }
  
  /**
   * Créer un profil Roo
   * 
   * @param profileName Nom du profil à créer
   * @param options Options de déploiement
   * @returns Résultat du déploiement
   */
  async createProfile(profileName: string, options: DeploymentOptions = {}): Promise<DeploymentResult> {
    this.logger.info('Creating Roo profile', { profileName });
    return this.executeDeploymentScript(
      'create-profile.ps1', 
      ['-ProfileName', profileName], 
      options
    );
  }
  
  /**
   * Créer des modes propres (nettoyage)
   * 
   * @param options Options de déploiement
   * @returns Résultat du déploiement
   */
  async createCleanModes(options: DeploymentOptions = {}): Promise<DeploymentResult> {
    this.logger.info('Creating clean modes');
    return this.executeDeploymentScript('create-clean-modes.ps1', [], options);
  }
  
  /**
   * Déployer avec correction d'encodage forcée
   * 
   * @param options Options de déploiement
   * @returns Résultat du déploiement
   */
  async forceDeployWithEncodingFix(options: DeploymentOptions = {}): Promise<DeploymentResult> {
    this.logger.info('Force deploying with encoding fix');
    return this.executeDeploymentScript('force-deploy-with-encoding-fix.ps1', [], options);
  }
}

/**
 * Instance singleton de DeploymentHelpers
 */
let deploymentHelpersInstance: DeploymentHelpers | null = null;

/**
 * Obtenir l'instance singleton de DeploymentHelpers
 * 
 * @param scriptsBasePath Chemin de base optionnel vers scripts/deployment
 * @returns Instance DeploymentHelpers
 */
export function getDeploymentHelpers(scriptsBasePath?: string): DeploymentHelpers {
  if (!deploymentHelpersInstance) {
    deploymentHelpersInstance = new DeploymentHelpers(scriptsBasePath);
  }
  return deploymentHelpersInstance;
}

/**
 * Réinitialiser l'instance singleton (utile pour tests)
 */
export function resetDeploymentHelpers(): void {
  deploymentHelpersInstance = null;
}