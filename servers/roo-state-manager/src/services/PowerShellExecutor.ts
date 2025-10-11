/**
 * PowerShellExecutor - Wrapper Node.js pour l'exécution de scripts PowerShell
 * 
 * Permet l'exécution sécurisée et contrôlée de scripts PowerShell depuis Node.js
 * avec gestion du timeout, des erreurs, et parsing de la sortie JSON.
 * 
 * @module PowerShellExecutor
 * @version 1.0.0
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';

/**
 * Résultat d'une exécution PowerShell
 */
export interface PowerShellExecutionResult {
  /** Succès de l'exécution (exit code === 0) */
  success: boolean;
  
  /** Sortie standard (stdout) */
  stdout: string;
  
  /** Sortie d'erreur (stderr) */
  stderr: string;
  
  /** Code de sortie du processus */
  exitCode: number;
  
  /** Temps d'exécution en millisecondes */
  executionTime: number;
}

/**
 * Options d'exécution PowerShell
 */
export interface PowerShellExecutionOptions {
  /** Timeout en millisecondes (défaut: 30000 = 30s) */
  timeout?: number;
  
  /** Répertoire de travail (défaut: ROOSYNC_BASE_PATH) */
  cwd?: string;
  
  /** Variables d'environnement additionnelles */
  env?: Record<string, string>;
}

/**
 * Configuration du PowerShellExecutor
 */
export interface PowerShellExecutorConfig {
  /** Chemin vers l'exécutable PowerShell (défaut: pwsh.exe) */
  powershellPath?: string;
  
  /** Chemin de base RooSync (défaut: d:/roo-extensions/RooSync) */
  roosyncBasePath?: string;
  
  /** Timeout par défaut en millisecondes */
  defaultTimeout?: number;
}

/**
 * Classe PowerShellExecutor pour exécuter des scripts PowerShell depuis Node.js
 */
export class PowerShellExecutor {
  private static readonly DEFAULT_POWERSHELL_PATH = 'pwsh.exe';
  private static readonly DEFAULT_ROOSYNC_BASE_PATH = path.join(
    process.env.ROO_HOME || 'd:/roo-extensions',
    'RooSync'
  );
  private static readonly DEFAULT_TIMEOUT = 30000; // 30 secondes

  private readonly powershellPath: string;
  private readonly roosyncBasePath: string;
  private readonly defaultTimeout: number;

  /**
   * Constructeur
   * @param config Configuration optionnelle
   */
  constructor(config?: PowerShellExecutorConfig) {
    this.powershellPath = config?.powershellPath || PowerShellExecutor.DEFAULT_POWERSHELL_PATH;
    this.roosyncBasePath = config?.roosyncBasePath || PowerShellExecutor.DEFAULT_ROOSYNC_BASE_PATH;
    this.defaultTimeout = config?.defaultTimeout || PowerShellExecutor.DEFAULT_TIMEOUT;
  }

  /**
   * Exécute un script PowerShell et retourne le résultat
   * 
   * @param scriptPath Chemin relatif du script depuis RooSync/ (ex: "src/sync-manager.ps1")
   * @param args Arguments à passer au script
   * @param options Options d'exécution
   * @returns Résultat de l'exécution
   * 
   * @example
   * ```typescript
   * const executor = new PowerShellExecutor();
   * const result = await executor.executeScript(
   *   'src/sync-manager.ps1',
   *   ['-Action', 'Status'],
   *   { timeout: 60000 }
   * );
   * ```
   */
  public async executeScript(
    scriptPath: string,
    args: string[] = [],
    options?: PowerShellExecutionOptions
  ): Promise<PowerShellExecutionResult> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? this.defaultTimeout;
    const cwd = options?.cwd ?? this.roosyncBasePath;
    
    return new Promise((resolve, reject) => {
      // Construire le chemin complet du script
      const fullScriptPath = path.join(this.roosyncBasePath, scriptPath);
      
      // Arguments PowerShell : -NoProfile, -ExecutionPolicy Bypass, -File <script>, ...args
      const pwshArgs = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', fullScriptPath,
        ...args
      ];
      
      // Variables d'environnement
      const env = {
        ...process.env,
        ...options?.env
      };
      
      // Lancer le processus PowerShell
      let proc: ChildProcess;
      try {
        proc = spawn(this.powershellPath, pwshArgs, {
          cwd,
          env,
          windowsHide: true, // Masquer la fenêtre PowerShell sur Windows
        });
      } catch (error) {
        reject(new Error(`Failed to spawn PowerShell process: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | null = null;
      let isTimedOut = false;

      // Gestion du timeout
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          isTimedOut = true;
          proc.kill('SIGTERM');
          
          // Force kill après 5s si SIGTERM ne suffit pas
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGKILL');
            }
          }, 5000);
        }, timeout);
      }

      // Collecter stdout
      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
      }

      // Collecter stderr
      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      // Gestion de la fermeture du processus
      proc.on('close', (exitCode: number | null) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const executionTime = Date.now() - startTime;

        if (isTimedOut) {
          resolve({
            success: false,
            stdout,
            stderr: stderr + '\nProcess timed out and was killed',
            exitCode: -1,
            executionTime
          });
          return;
        }

        resolve({
          success: exitCode === 0,
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          executionTime
        });
      });

      // Gestion des erreurs du processus
      proc.on('error', (error: Error) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        if (isTimedOut) {
          // Erreur déjà gérée par le timeout
          return;
        }

        reject(new Error(`PowerShell execution failed: ${error.message}`));
      });
    });
  }

  /**
   * Parse la sortie JSON d'un script PowerShell
   * 
   * Nettoie automatiquement la sortie en enlevant les logs/warnings non-JSON
   * qui peuvent précéder ou suivre le JSON.
   * 
   * @param stdout Sortie standard du script PowerShell
   * @returns Objet parsé
   * @throws Error si le parsing JSON échoue
   * 
   * @example
   * ```typescript
   * const result = await executor.executeScript('script.ps1');
   * const data = PowerShellExecutor.parseJsonOutput<MyType>(result.stdout);
   * ```
   */
  public static parseJsonOutput<T>(stdout: string): T {
    try {
      // Nettoyer la sortie : trouver le premier { et le dernier }
      const jsonStart = stdout.indexOf('{');
      const jsonEnd = stdout.lastIndexOf('}');
      
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        throw new Error('No valid JSON object found in PowerShell output');
      }
      
      const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
      return JSON.parse(jsonStr) as T;
    } catch (error) {
      throw new Error(
        `Failed to parse PowerShell JSON output: ${error instanceof Error ? error.message : String(error)}\n` +
        `Output: ${stdout.substring(0, 500)}...` // Premier 500 caractères pour debug
      );
    }
  }

  /**
   * Vérifie si PowerShell est disponible sur le système
   * 
   * @param powershellPath Chemin vers PowerShell (défaut: pwsh.exe)
   * @returns true si PowerShell est disponible
   */
  public static async isPowerShellAvailable(powershellPath?: string): Promise<boolean> {
    const executor = new PowerShellExecutor({ powershellPath });
    
    try {
      // Exécuter une commande simple pour tester
      const result = await executor.executeScript(
        '',
        ['-Command', 'Write-Output "test"'],
        { timeout: 5000 }
      );
      
      return result.success && result.stdout.trim() === 'test';
    } catch {
      return false;
    }
  }

  /**
   * Obtenir la version de PowerShell installée
   * 
   * @param powershellPath Chemin vers PowerShell (défaut: pwsh.exe)
   * @returns Version de PowerShell ou null si non disponible
   */
  public static async getPowerShellVersion(powershellPath?: string): Promise<string | null> {
    const executor = new PowerShellExecutor({ powershellPath });
    
    try {
      const result = await executor.executeScript(
        '',
        ['-Command', '$PSVersionTable.PSVersion.ToString()'],
        { timeout: 5000 }
      );
      
      if (result.success) {
        return result.stdout.trim();
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Instance singleton par défaut du PowerShellExecutor
 */
let defaultExecutor: PowerShellExecutor | null = null;

/**
 * Obtenir l'instance par défaut du PowerShellExecutor
 * 
 * @param config Configuration (utilisée seulement lors de la première création)
 * @returns Instance du PowerShellExecutor
 */
export function getDefaultExecutor(config?: PowerShellExecutorConfig): PowerShellExecutor {
  if (!defaultExecutor) {
    defaultExecutor = new PowerShellExecutor(config);
  }
  return defaultExecutor;
}

/**
 * Réinitialiser l'instance par défaut (utile pour les tests)
 */
export function resetDefaultExecutor(): void {
  defaultExecutor = null;
}