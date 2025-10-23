/**
 * Git Helpers for RooSync v2 - Production Safety
 * 
 * Provides robust Git operations with verification and rollback capabilities.
 * Addresses critical gaps identified in convergence v1→v2 analysis.
 * 
 * @module utils/git-helpers
 * @version 1.0.0
 * @see docs/roosync/convergence-v1-v2-analysis-20251022.md Phase 1.2 & 1.3
 */

import { promisify } from 'util';
import { exec } from 'child_process';
import { createLogger, Logger } from './logger.js';

const execAsync = promisify(exec);

/**
 * Result of a Git command execution
 */
export interface GitCommandResult {
  success: boolean;
  output: string;
  exitCode: number;
  error?: string;
}

/**
 * Git availability check result
 */
export interface GitAvailabilityResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/**
 * Options for Git command execution
 */
export interface GitExecutionOptions {
  cwd?: string;
  timeout?: number;
  logSHA?: boolean; // Log SHA before/after for critical operations
}

/**
 * Git Helpers class with production-grade safety
 */
export class GitHelpers {
  private logger: Logger;
  private gitAvailable: boolean | null = null;
  private gitVersion: string | null = null;

  constructor() {
    this.logger = createLogger('GitHelpers');
  }

  /**
   * AMÉLIORATION 2: Verify Git is available on the system
   * 
   * Critical for avoiding silent failures in production.
   * 
   * @returns Git availability status with version info
   */
  public async verifyGitAvailable(): Promise<GitAvailabilityResult> {
    // Check cache first
    if (this.gitAvailable !== null) {
      return {
        available: this.gitAvailable,
        version: this.gitVersion || undefined
      };
    }

    try {
      const { stdout } = await execAsync('git --version', { timeout: 5000 });
      const version = stdout.trim();
      
      this.gitAvailable = true;
      this.gitVersion = version;
      
      this.logger.info(`✅ Git trouvé: ${version}`);
      
      return {
        available: true,
        version
      };
    } catch (error) {
      this.gitAvailable = false;
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('❌ Git NON TROUVÉ dans PATH', error);
      this.logger.info('📥 Téléchargez Git: https://git-scm.com/downloads');
      
      return {
        available: false,
        error: errorMessage
      };
    }
  }

  /**
   * AMÉLIORATION 3: Execute Git command with robust error handling and SHA tracking
   * 
   * Provides:
   * - Automatic exit code verification
   * - SHA logging before/after critical operations
   * - Clear error messages
   * - Automatic rollback capability (caller responsibility)
   * 
   * @param command - Git command to execute (e.g., 'git status')
   * @param description - Human-readable description for logging
   * @param options - Execution options
   * @returns Execution result with success flag and output
   */
  public async execGitCommand(
    command: string,
    description: string,
    options: GitExecutionOptions = {}
  ): Promise<GitCommandResult> {
    // Verify Git is available first
    const gitCheck = await this.verifyGitAvailable();
    if (!gitCheck.available) {
      return {
        success: false,
        output: '',
        exitCode: -1,
        error: 'Git not available on system'
      };
    }

    const { cwd, timeout = 30000, logSHA = false } = options;

    try {
      // Log SHA before operation if requested (for critical operations)
      let shaBefore: string | null = null;
      if (logSHA && cwd) {
        try {
          const { stdout } = await execAsync('git rev-parse HEAD', { cwd, timeout: 5000 });
          shaBefore = stdout.trim();
          this.logger.debug(`📍 SHA avant ${description}: ${shaBefore}`);
        } catch {
          // Non-critical if SHA retrieval fails
          this.logger.warn(`⚠️ Impossible de récupérer SHA avant ${description}`);
        }
      }

      // Execute the actual Git command
      this.logger.info(`⏳ Exécution: ${description}`);
      this.logger.debug(`🔧 Commande: ${command}`);
      
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd,
        encoding: 'utf-8'
      });

      // Log SHA after operation if requested
      if (logSHA && cwd && shaBefore) {
        try {
          const { stdout: stdoutAfter } = await execAsync('git rev-parse HEAD', { cwd, timeout: 5000 });
          const shaAfter = stdoutAfter.trim();
          
          if (shaBefore !== shaAfter) {
            this.logger.info(`📍 SHA après ${description}: ${shaAfter} (changé)`);
          } else {
            this.logger.debug(`📍 SHA après ${description}: ${shaAfter} (inchangé)`);
          }
        } catch {
          this.logger.warn(`⚠️ Impossible de récupérer SHA après ${description}`);
        }
      }

      // Success
      if (stderr && stderr.trim()) {
        this.logger.warn(`⚠️ stderr (non-fatal): ${stderr.trim()}`);
      }
      
      this.logger.info(`✅ Succès: ${description}`);
      
      return {
        success: true,
        output: stdout.trim(),
        exitCode: 0
      };

    } catch (error: any) {
      // Failure - log detailed error
      this.logger.error(`❌ Échec: ${description}`, error);
      
      const errorMessage = error.message || String(error);
      const exitCode = error.code || -1;
      const stderr = error.stderr || '';
      
      if (stderr) {
        this.logger.error(`Git stderr: ${stderr}`);
      }
      
      return {
        success: false,
        output: '',
        exitCode,
        error: errorMessage
      };
    }
  }

  /**
   * Get current HEAD SHA (helper for rollback scenarios)
   * 
   * @param cwd - Working directory
   * @returns SHA string or null if error
   */
  public async getHeadSHA(cwd: string): Promise<string | null> {
    const result = await this.execGitCommand(
      'git rev-parse HEAD',
      'Récupération SHA HEAD',
      { cwd, timeout: 5000 }
    );

    return result.success ? result.output : null;
  }

  /**
   * Verify SHA HEAD is valid and repository is healthy
   * 
   * @param cwd - Working directory
   * @returns true if HEAD is valid
   */
  public async verifyHeadValid(cwd: string): Promise<boolean> {
    const sha = await this.getHeadSHA(cwd);
    
    if (!sha) {
      this.logger.error('❌ Impossible de récupérer HEAD SHA - repository corrompu?');
      return false;
    }

    // Verify SHA format (40 hex characters)
    const shaRegex = /^[0-9a-f]{40}$/;
    if (!shaRegex.test(sha)) {
      this.logger.error(`❌ SHA HEAD invalide: ${sha}`);
      return false;
    }

    this.logger.debug(`✅ HEAD SHA valide: ${sha}`);
    return true;
  }

  /**
   * Safe Git pull with SHA verification
   * 
   * @param cwd - Working directory
   * @param remote - Remote name (default: origin)
   * @param branch - Branch name (default: current)
   * @returns Execution result
   */
  public async safePull(
    cwd: string,
    remote: string = 'origin',
    branch?: string
  ): Promise<GitCommandResult> {
    // Verify HEAD before pull
    const headValid = await this.verifyHeadValid(cwd);
    if (!headValid) {
      return {
        success: false,
        output: '',
        exitCode: -1,
        error: 'HEAD SHA invalid before pull'
      };
    }

    const command = branch
      ? `git pull ${remote} ${branch}`
      : `git pull ${remote}`;

    const result = await this.execGitCommand(
      command,
      `Pull depuis ${remote}${branch ? `/${branch}` : ''}`,
      { cwd, logSHA: true }
    );

    // Verify HEAD after pull
    if (result.success) {
      const headValidAfter = await this.verifyHeadValid(cwd);
      if (!headValidAfter) {
        this.logger.error('❌ HEAD SHA corrompu après pull - ROLLBACK REQUIS');
        return {
          success: false,
          output: result.output,
          exitCode: -1,
          error: 'HEAD SHA corrupted after pull'
        };
      }
    }

    return result;
  }

  /**
   * Safe Git checkout with SHA verification
   * 
   * @param cwd - Working directory
   * @param branch - Branch name
   * @returns Execution result
   */
  public async safeCheckout(cwd: string, branch: string): Promise<GitCommandResult> {
    const headBefore = await this.getHeadSHA(cwd);
    
    if (!headBefore) {
      return {
        success: false,
        output: '',
        exitCode: -1,
        error: 'Cannot get HEAD SHA before checkout'
      };
    }

    const result = await this.execGitCommand(
      `git checkout ${branch}`,
      `Checkout vers ${branch}`,
      { cwd, logSHA: true }
    );

    // Verify HEAD changed (or stayed same if already on branch)
    if (result.success) {
      const headAfter = await this.getHeadSHA(cwd);
      if (!headAfter) {
        this.logger.error('❌ HEAD SHA invalide après checkout');
        // Attempt rollback
        await this.execGitCommand(
          `git checkout ${headBefore}`,
          `Rollback checkout vers ${headBefore.substring(0, 7)}`,
          { cwd }
        );
        return {
          success: false,
          output: result.output,
          exitCode: -1,
          error: 'HEAD SHA invalid after checkout, rolled back'
        };
      }
    }

    return result;
  }

  /**
   * Reset Git availability cache (for testing)
   */
  public resetCache(): void {
    this.gitAvailable = null;
    this.gitVersion = null;
    this.logger.debug('🗑️ Git cache réinitialisé');
  }
}

/**
 * Singleton instance for shared usage
 */
let gitHelpersInstance: GitHelpers | null = null;

/**
 * Get shared GitHelpers instance
 */
export function getGitHelpers(): GitHelpers {
  if (!gitHelpersInstance) {
    gitHelpersInstance = new GitHelpers();
  }
  return gitHelpersInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetGitHelpers(): void {
  gitHelpersInstance = null;
}