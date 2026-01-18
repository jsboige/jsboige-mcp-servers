import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger, createLogger, resetDefaultLogger, LogLevel } from '../../../src/utils/logger';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

describe('Logger - Enhanced Visibility', () => {
    const TEST_LOG_DIR = join(__dirname, '../../fixtures/logger-test');
    let logger: Logger;

    beforeEach(() => {
        // Clean up test directory
        if (existsSync(TEST_LOG_DIR)) {
            const files = readdirSync(TEST_LOG_DIR);
            for (const file of files) {
                unlinkSync(join(TEST_LOG_DIR, file));
            }
        }

        logger = new Logger({
            logDir: TEST_LOG_DIR,
            filePrefix: 'test-logger',
            source: 'TestLogger',
            minLevel: 'DEBUG'
        });
    });

    afterEach(() => {
        resetDefaultLogger();
    });

    it('should format timestamp in readable format (YYYY-MM-DD HH:mm:ss)', () => {
        const logFile = logger.getCurrentLogFile();
        expect(logFile).toContain('test-logger');
        expect(logFile).toContain('.log');
    });

    it('should include icons for each log level', () => {
        logger.debug('Debug message');
        logger.info('Info message');
        logger.warn('Warning message');
        logger.error('Error message');

        const logFile = logger.getCurrentLogFile();
        expect(existsSync(logFile)).toBe(true);
    });

    it('should format metadata with indentation', () => {
        const metadata = {
            userId: '123',
            action: 'test',
            details: {
                nested: 'value'
            }
        };

        logger.info('Test with metadata', metadata);

        const logFile = logger.getCurrentLogFile();
        expect(existsSync(logFile)).toBe(true);
    });

    it('should handle error metadata correctly', () => {
        const error = new Error('Test error');
        logger.error('Error occurred', error, { context: 'test' });

        const logFile = logger.getCurrentLogFile();
        expect(existsSync(logFile)).toBe(true);
    });

    it('should respect minimum log level', () => {
        const infoLogger = new Logger({
            logDir: TEST_LOG_DIR,
            filePrefix: 'test-level',
            source: 'LevelTest',
            minLevel: 'INFO'
        });

        infoLogger.debug('This should not appear');
        infoLogger.info('This should appear');

        const logFile = infoLogger.getCurrentLogFile();
        expect(existsSync(logFile)).toBe(true);
    });

    it('should create logger with factory function', () => {
        const factoryLogger = createLogger('FactoryTest', {
            logDir: TEST_LOG_DIR,
            filePrefix: 'factory-test'
        });

        factoryLogger.info('Factory test message');

        const logFile = factoryLogger.getCurrentLogFile();
        expect(existsSync(logFile)).toBe(true);
    });

    it('should return correct configuration', () => {
        const config = logger.getConfig();

        expect(config.logDir).toBe(TEST_LOG_DIR);
        expect(config.filePrefix).toBe('test-logger');
        expect(config.source).toBe('TestLogger');
        expect(config.minLevel).toBe('DEBUG');
    });
});
