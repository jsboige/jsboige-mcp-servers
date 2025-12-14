/**
 * Production Logger for RooSync v2 - Windows Task Scheduler Compatible
 * 
 * Features:
 * - Double output: Console + File (visible in Task Scheduler)
 * - Automatic log rotation (max 10MB per file, 7 days retention)
 * - ISO 8601 timestamps
 * - Source tracking for debugging
 * 
 * @see docs/roosync/convergence-v1-v2-analysis-20251022.md Phase 1.1
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LoggerOptions {
    /** Base directory for logs (default: .shared-state/logs) */
    logDir?: string;
    /** Log file prefix (default: roosync) */
    filePrefix?: string;
    /** Max file size in bytes before rotation (default: 10MB) */
    maxFileSize?: number;
    /** Log retention in days (default: 7) */
    retentionDays?: number;
    /** Source identifier for log entries (e.g., 'InventoryCollector') */
    source?: string;
    /** Minimum log level to output (default: INFO) */
    minLevel?: LogLevel;
}

const LOG_LEVELS: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

export class Logger {
    private logDir: string;
    private filePrefix: string;
    private maxFileSize: number;
    private retentionDays: number;
    private source: string;
    private minLevel: LogLevel;
    private currentLogFile: string;

    constructor(options: LoggerOptions = {}) {
        // Determine default log directory
        // FIX: Use temp dir instead of cwd to avoid polluting project root when env var is missing
        const defaultLogDir = process.env.ROOSYNC_SHARED_PATH
            ? join(process.env.ROOSYNC_SHARED_PATH, 'logs')
            : join(tmpdir(), 'roo-state-manager-logs');

        this.logDir = options.logDir || defaultLogDir;
        this.filePrefix = options.filePrefix || 'roosync';
        this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
        this.retentionDays = options.retentionDays || 7;
        this.source = options.source || 'RooSync';
        this.minLevel = options.minLevel || 'INFO';

        // Ensure log directory exists
        this.ensureLogDirectory();

        // Initialize current log file
        this.currentLogFile = this.getLogFilePath();

        // Perform initial cleanup of old logs
        this.cleanupOldLogs();
    }

    /**
     * Log a DEBUG message
     */
    public debug(message: string, metadata?: Record<string, any>): void {
        this.log('DEBUG', message, metadata);
    }

    /**
     * Log an INFO message
     */
    public info(message: string, metadata?: Record<string, any>): void {
        this.log('INFO', message, metadata);
    }

    /**
     * Log a WARN message
     */
    public warn(message: string, metadata?: Record<string, any>): void {
        this.log('WARN', message, metadata);
    }

    /**
     * Log an ERROR message
     */
    public error(message: string, error?: Error | unknown, metadata?: Record<string, any>): void {
        let enhancedMetadata = metadata || {};
        
        if (error) {
            if (error instanceof Error) {
                enhancedMetadata = {
                    ...enhancedMetadata,
                    errorName: error.name,
                    errorMessage: error.message,
                    errorStack: error.stack
                };
            } else {
                enhancedMetadata = {
                    ...enhancedMetadata,
                    error: String(error)
                };
            }
        }

        this.log('ERROR', message, enhancedMetadata);
    }

    /**
     * Core logging method
     */
    private log(level: LogLevel, message: string, metadata?: Record<string, any>): void {
        // Check if level meets minimum threshold
        if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) {
            return;
        }

        const timestamp = new Date().toISOString();
        const metadataStr = metadata ? ` | ${JSON.stringify(metadata)}` : '';
        const logEntry = `[${timestamp}] [${level}] [${this.source}] ${message}${metadataStr}`;

        // Output to console (critical for Task Scheduler Windows visibility)
        this.logToConsole(level, logEntry);

        // Output to file (production persistence)
        this.logToFile(logEntry);

        // Check if rotation needed
        this.checkRotation();
    }

    /**
     * Output to console with appropriate method
     */
    private logToConsole(level: LogLevel, logEntry: string): void {
        switch (level) {
            case 'ERROR':
                console.error(logEntry);
                break;
            case 'WARN':
                console.warn(logEntry);
                break;
            case 'DEBUG':
                console.debug(logEntry);
                break;
            default:
                console.log(logEntry);
        }
    }

    /**
     * Append to log file
     */
    private logToFile(logEntry: string): void {
        try {
            appendFileSync(this.currentLogFile, logEntry + '\n', 'utf-8');
        } catch (error) {
            // Silently fail in test environments - logs are optional
            if (this.logDir.includes('fixtures') || this.logDir.includes('test')) {
                return;
            }
            // Fallback: only console if file write fails
            console.error(`[Logger] Failed to write to log file: ${error}`);
        }
    }

    /**
     * Ensure log directory exists
     */
    private ensureLogDirectory(): void {
        if (!existsSync(this.logDir)) {
            try {
                mkdirSync(this.logDir, { recursive: true });
            } catch (error) {
                // Silently fail in test environments - logs are optional
                if (this.logDir.includes('fixtures') || this.logDir.includes('test')) {
                    return;
                }
                console.error(`[Logger] Failed to create log directory ${this.logDir}:`, error);
            }
        }
    }

    /**
     * Get current log file path (format: roosync-YYYYMMDD.log)
     */
    private getLogFilePath(): string {
        const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
        return join(this.logDir, `${this.filePrefix}-${dateStr}.log`);
    }

    /**
     * Check if rotation needed and rotate if necessary
     */
    private checkRotation(): void {
        try {
            if (!existsSync(this.currentLogFile)) {
                return;
            }

            const stats = statSync(this.currentLogFile);
            if (stats.size >= this.maxFileSize) {
                this.rotateLog();
            }
        } catch (error) {
            console.error('[Logger] Error checking log rotation:', error);
        }
    }

    /**
     * Rotate current log file
     */
    private rotateLog(): void {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rotatedPath = this.currentLogFile.replace('.log', `-${timestamp}.log`);

        try {
            // Note: On Windows, we can't rename a file that's being written to
            // So we just start a new file with incremented suffix
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const basePattern = `${this.filePrefix}-${dateStr}`;
            
            // Find next available number
            const existingFiles = readdirSync(this.logDir).filter(f => f.startsWith(basePattern));
            const nextNum = existingFiles.length + 1;
            
            this.currentLogFile = join(this.logDir, `${basePattern}-${nextNum}.log`);
            
            console.log(`[Logger] Log rotated to: ${this.currentLogFile}`);
        } catch (error) {
            console.error('[Logger] Failed to rotate log:', error);
        }
    }

    /**
     * Clean up old log files beyond retention period
     */
    private cleanupOldLogs(): void {
        try {
            if (!existsSync(this.logDir)) {
                return;
            }

            const now = Date.now();
            const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;

            const files = readdirSync(this.logDir);
            for (const file of files) {
                if (!file.startsWith(this.filePrefix) || !file.endsWith('.log')) {
                    continue;
                }

                const filePath = join(this.logDir, file);
                const stats = statSync(filePath);
                const age = now - stats.mtimeMs;

                if (age > retentionMs) {
                    unlinkSync(filePath);
                    console.log(`[Logger] Cleaned up old log file: ${file}`);
                }
            }
        } catch (error) {
            console.error('[Logger] Error during log cleanup:', error);
        }
    }

    /**
     * Get current log file path (for testing/debugging)
     */
    public getCurrentLogFile(): string {
        return this.currentLogFile;
    }

    /**
     * Get logger configuration (for testing/debugging)
     */
    public getConfig(): LoggerOptions {
        return {
            logDir: this.logDir,
            filePrefix: this.filePrefix,
            maxFileSize: this.maxFileSize,
            retentionDays: this.retentionDays,
            source: this.source,
            minLevel: this.minLevel
        };
    }
}

/**
 * Create a logger instance with default settings
 */
export function createLogger(source: string, options?: Partial<LoggerOptions>): Logger {
    return new Logger({
        source,
        ...options
    });
}

/**
 * Singleton logger for shared usage
 */
let defaultLogger: Logger | null = null;

export function getDefaultLogger(): Logger {
    if (!defaultLogger) {
        defaultLogger = new Logger({ source: 'RooSync' });
    }
    return defaultLogger;
}

/**
 * Reset default logger (for testing)
 */
export function resetDefaultLogger(): void {
    defaultLogger = null;
}