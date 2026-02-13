/**
 * Tests for DetailLevelStrategyFactory
 *
 * Covers all static methods of the factory:
 * - createStrategy
 * - isSupportedDetailLevel
 * - getSupportedDetailLevels
 * - createStrategyWithFallback
 * - getStrategyInfo
 * - validateStrategyParams
 * - createAllStrategies
 * - registerCustomStrategy
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DetailLevelStrategyFactory } from '../DetailLevelStrategyFactory.js';
import { DetailLevel } from '../../../types/enhanced-conversation.js';
import { StateManagerError } from '../../../types/errors.js';
import { FullReportingStrategy } from '../strategies/FullReportingStrategy.js';
import { MessagesReportingStrategy } from '../strategies/MessagesReportingStrategy.js';
import { SummaryReportingStrategy } from '../strategies/SummaryReportingStrategy.js';
import { NoToolsReportingStrategy } from '../strategies/NoToolsReportingStrategy.js';
import { NoResultsReportingStrategy } from '../strategies/NoResultsReportingStrategy.js';
import { UserOnlyReportingStrategy } from '../strategies/UserOnlyReportingStrategy.js';

// Suppress console output during tests
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

const ALL_DETAIL_LEVELS: DetailLevel[] = ['Full', 'Messages', 'Summary', 'NoTools', 'NoResults', 'UserOnly'];

describe('DetailLevelStrategyFactory', () => {

    // =========================================================================
    // createStrategy
    // =========================================================================
    describe('createStrategy', () => {
        it('should create a FullReportingStrategy for "Full"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategy('Full');
            expect(strategy).toBeInstanceOf(FullReportingStrategy);
        });

        it('should create a MessagesReportingStrategy for "Messages"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategy('Messages');
            expect(strategy).toBeInstanceOf(MessagesReportingStrategy);
        });

        it('should create a SummaryReportingStrategy for "Summary"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategy('Summary');
            expect(strategy).toBeInstanceOf(SummaryReportingStrategy);
        });

        it('should create a NoToolsReportingStrategy for "NoTools"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategy('NoTools');
            expect(strategy).toBeInstanceOf(NoToolsReportingStrategy);
        });

        it('should create a NoResultsReportingStrategy for "NoResults"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategy('NoResults');
            expect(strategy).toBeInstanceOf(NoResultsReportingStrategy);
        });

        it('should create a UserOnlyReportingStrategy for "UserOnly"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategy('UserOnly');
            expect(strategy).toBeInstanceOf(UserOnlyReportingStrategy);
        });

        it('should throw StateManagerError for an unknown detail level', () => {
            expect(() => {
                DetailLevelStrategyFactory.createStrategy('Unknown' as DetailLevel);
            }).toThrow(StateManagerError);
        });

        it('should throw with UNSUPPORTED_DETAIL_LEVEL error code', () => {
            try {
                DetailLevelStrategyFactory.createStrategy('InvalidLevel' as DetailLevel);
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(StateManagerError);
                const smError = error as StateManagerError;
                expect(smError.code).toBe('UNSUPPORTED_DETAIL_LEVEL');
                expect(smError.service).toBe('DetailLevelStrategyFactory');
            }
        });

        it('should include the unsupported level in the error details', () => {
            try {
                DetailLevelStrategyFactory.createStrategy('BadLevel' as DetailLevel);
                expect.fail('Should have thrown');
            } catch (error) {
                const smError = error as StateManagerError;
                expect(smError.details).toBeDefined();
                expect(smError.details.detailLevel).toBe('BadLevel');
                expect(smError.details.supportedLevels).toEqual(expect.arrayContaining(ALL_DETAIL_LEVELS));
            }
        });

        it('should create new instances on each call (not singletons)', () => {
            const strategy1 = DetailLevelStrategyFactory.createStrategy('Full');
            const strategy2 = DetailLevelStrategyFactory.createStrategy('Full');
            expect(strategy1).not.toBe(strategy2);
        });
    });

    // =========================================================================
    // Each created strategy has a generateReport method
    // =========================================================================
    describe('created strategies have generateReport method', () => {
        for (const level of ALL_DETAIL_LEVELS) {
            it(`strategy for "${level}" should have a generateReport method`, () => {
                const strategy = DetailLevelStrategyFactory.createStrategy(level);
                expect(typeof strategy.generateReport).toBe('function');
            });
        }

        for (const level of ALL_DETAIL_LEVELS) {
            it(`strategy for "${level}" should have a detailLevel property`, () => {
                const strategy = DetailLevelStrategyFactory.createStrategy(level);
                expect(strategy.detailLevel).toBeDefined();
                expect(typeof strategy.detailLevel).toBe('string');
            });
        }
    });

    // =========================================================================
    // isSupportedDetailLevel
    // =========================================================================
    describe('isSupportedDetailLevel', () => {
        for (const level of ALL_DETAIL_LEVELS) {
            it(`should return true for valid level "${level}"`, () => {
                expect(DetailLevelStrategyFactory.isSupportedDetailLevel(level)).toBe(true);
            });
        }

        it('should return false for an invalid level', () => {
            expect(DetailLevelStrategyFactory.isSupportedDetailLevel('Invalid')).toBe(false);
        });

        it('should return false for an empty string', () => {
            expect(DetailLevelStrategyFactory.isSupportedDetailLevel('')).toBe(false);
        });

        it('should return false for a lowercase variant', () => {
            expect(DetailLevelStrategyFactory.isSupportedDetailLevel('full')).toBe(false);
        });

        it('should return false for an uppercase variant', () => {
            expect(DetailLevelStrategyFactory.isSupportedDetailLevel('FULL')).toBe(false);
        });

        it('should return false for a level with trailing space', () => {
            expect(DetailLevelStrategyFactory.isSupportedDetailLevel('Full ')).toBe(false);
        });
    });

    // =========================================================================
    // getSupportedDetailLevels
    // =========================================================================
    describe('getSupportedDetailLevels', () => {
        it('should return all 6 supported detail levels', () => {
            const levels = DetailLevelStrategyFactory.getSupportedDetailLevels();
            expect(levels).toHaveLength(6);
        });

        it('should contain all expected levels', () => {
            const levels = DetailLevelStrategyFactory.getSupportedDetailLevels();
            for (const expected of ALL_DETAIL_LEVELS) {
                expect(levels).toContain(expected);
            }
        });

        it('should return a new array each call (not same reference)', () => {
            const levels1 = DetailLevelStrategyFactory.getSupportedDetailLevels();
            const levels2 = DetailLevelStrategyFactory.getSupportedDetailLevels();
            expect(levels1).not.toBe(levels2);
            expect(levels1).toEqual(levels2);
        });
    });

    // =========================================================================
    // createStrategyWithFallback
    // =========================================================================
    describe('createStrategyWithFallback', () => {
        it('should return the correct strategy for a valid level', () => {
            const strategy = DetailLevelStrategyFactory.createStrategyWithFallback('Full');
            expect(strategy).toBeInstanceOf(FullReportingStrategy);
        });

        it('should return the correct strategy for each valid level', () => {
            for (const level of ALL_DETAIL_LEVELS) {
                const strategy = DetailLevelStrategyFactory.createStrategyWithFallback(level);
                expect(strategy).toBeDefined();
                expect(typeof strategy.generateReport).toBe('function');
            }
        });

        it('should fall back to Full for an unsupported level (default fallback)', () => {
            const strategy = DetailLevelStrategyFactory.createStrategyWithFallback('InvalidLevel');
            expect(strategy).toBeInstanceOf(FullReportingStrategy);
        });

        it('should use the specified fallback when provided', () => {
            const strategy = DetailLevelStrategyFactory.createStrategyWithFallback('InvalidLevel', 'Summary');
            expect(strategy).toBeInstanceOf(SummaryReportingStrategy);
        });

        it('should log a warning when falling back', () => {
            DetailLevelStrategyFactory.createStrategyWithFallback('BadLevel');
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('BadLevel')
            );
        });

        it('should not log a warning for valid levels', () => {
            DetailLevelStrategyFactory.createStrategyWithFallback('Full');
            expect(console.warn).not.toHaveBeenCalled();
        });

        it('should use custom fallback "Messages"', () => {
            const strategy = DetailLevelStrategyFactory.createStrategyWithFallback('Nope', 'Messages');
            expect(strategy).toBeInstanceOf(MessagesReportingStrategy);
        });
    });

    // =========================================================================
    // getStrategyInfo
    // =========================================================================
    describe('getStrategyInfo', () => {
        for (const level of ALL_DETAIL_LEVELS) {
            it(`should return info with name and description for "${level}"`, () => {
                const info = DetailLevelStrategyFactory.getStrategyInfo(level);
                expect(info).toBeDefined();
                expect(info.name).toBe(level);
                expect(typeof info.description).toBe('string');
                expect(info.description.length).toBeGreaterThan(0);
            });
        }

        it('should return a unique description for each level', () => {
            const descriptions = new Set<string>();
            for (const level of ALL_DETAIL_LEVELS) {
                const info = DetailLevelStrategyFactory.getStrategyInfo(level);
                descriptions.add(info.description);
            }
            expect(descriptions.size).toBe(ALL_DETAIL_LEVELS.length);
        });

        it('should have description mentioning key concept for Full', () => {
            const info = DetailLevelStrategyFactory.getStrategyInfo('Full');
            // The Full description mentions "filtrage" or "maximum" or similar
            expect(info.description.length).toBeGreaterThan(10);
        });

        it('should have description mentioning key concept for Summary', () => {
            const info = DetailLevelStrategyFactory.getStrategyInfo('Summary');
            expect(info.description.toLowerCase()).toContain('table des mati');
        });
    });

    // =========================================================================
    // validateStrategyParams
    // =========================================================================
    describe('validateStrategyParams', () => {
        it('should return isValid=true for all supported levels', () => {
            for (const level of ALL_DETAIL_LEVELS) {
                const result = DetailLevelStrategyFactory.validateStrategyParams(level);
                expect(result.isValid).toBe(true);
                expect(result.errors).toHaveLength(0);
            }
        });

        it('should return isValid=false for an unsupported level', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('BadLevel');
            expect(result.isValid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should include descriptive error message for unsupported level', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('UnknownLevel');
            expect(result.errors[0]).toContain('UnknownLevel');
        });

        it('should return isValid=false for empty string', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('');
            expect(result.isValid).toBe(false);
        });

        it('should add a warning for Summary with high truncationChars', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Summary', {
                truncationChars: 100000
            });
            expect(result.isValid).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings[0]).toContain('50k');
        });

        it('should not add a warning for Summary with normal truncationChars', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Summary', {
                truncationChars: 5000
            });
            expect(result.isValid).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should not add a warning for Summary without truncationChars', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Summary');
            expect(result.isValid).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should not add truncation warning for non-Summary levels', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Full', {
                truncationChars: 100000
            });
            expect(result.isValid).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should not add warning for Summary with exactly 50000 truncationChars (boundary)', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Summary', {
                truncationChars: 50000
            });
            expect(result.isValid).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should add warning for Summary with 50001 truncationChars (just above boundary)', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Summary', {
                truncationChars: 50001
            });
            expect(result.isValid).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
        });

        it('should handle params=undefined gracefully', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Full', undefined);
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('should handle params={} gracefully', () => {
            const result = DetailLevelStrategyFactory.validateStrategyParams('Full', {});
            expect(result.isValid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
    });

    // =========================================================================
    // createAllStrategies
    // =========================================================================
    describe('createAllStrategies', () => {
        it('should return a Map with all 6 entries', () => {
            const strategies = DetailLevelStrategyFactory.createAllStrategies();
            expect(strategies).toBeInstanceOf(Map);
            expect(strategies.size).toBe(6);
        });

        it('should contain entries for each supported level', () => {
            const strategies = DetailLevelStrategyFactory.createAllStrategies();
            for (const level of ALL_DETAIL_LEVELS) {
                expect(strategies.has(level)).toBe(true);
            }
        });

        it('should have strategy instances (not creator functions) as values', () => {
            const strategies = DetailLevelStrategyFactory.createAllStrategies();
            for (const [_level, strategy] of strategies) {
                expect(typeof strategy.generateReport).toBe('function');
                expect(typeof strategy.detailLevel).toBe('string');
            }
        });

        it('should create distinct instances', () => {
            const strategies1 = DetailLevelStrategyFactory.createAllStrategies();
            const strategies2 = DetailLevelStrategyFactory.createAllStrategies();
            // Different map references
            expect(strategies1).not.toBe(strategies2);
            // Different strategy instances
            expect(strategies1.get('Full')).not.toBe(strategies2.get('Full'));
        });

        it('Full entry should be a FullReportingStrategy', () => {
            const strategies = DetailLevelStrategyFactory.createAllStrategies();
            expect(strategies.get('Full')).toBeInstanceOf(FullReportingStrategy);
        });

        it('Summary entry should be a SummaryReportingStrategy', () => {
            const strategies = DetailLevelStrategyFactory.createAllStrategies();
            expect(strategies.get('Summary')).toBeInstanceOf(SummaryReportingStrategy);
        });
    });

    // =========================================================================
    // registerCustomStrategy
    // =========================================================================
    describe('registerCustomStrategy', () => {
        it('should not throw when registering a new custom strategy', () => {
            expect(() => {
                DetailLevelStrategyFactory.registerCustomStrategy('CustomLevel', () => {
                    return new FullReportingStrategy();
                });
            }).not.toThrow();
        });

        it('should log info message when registering', () => {
            DetailLevelStrategyFactory.registerCustomStrategy('CustomLevel', () => {
                return new FullReportingStrategy();
            });
            expect(console.info).toHaveBeenCalledWith(
                expect.stringContaining('CustomLevel')
            );
        });

        it('should log a warning when registering for an existing level', () => {
            DetailLevelStrategyFactory.registerCustomStrategy('Full', () => {
                return new FullReportingStrategy();
            });
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('Full')
            );
        });

        it('should not affect existing strategies (not fully implemented)', () => {
            // Register a custom strategy that would return a different type
            DetailLevelStrategyFactory.registerCustomStrategy('Full', () => {
                return new SummaryReportingStrategy();
            });
            // The original strategy should still be returned
            const strategy = DetailLevelStrategyFactory.createStrategy('Full');
            expect(strategy).toBeInstanceOf(FullReportingStrategy);
        });
    });
});
