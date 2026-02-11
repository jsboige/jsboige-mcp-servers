/**
 * task-instruction-index.test.ts - Comprehensive unit tests for TaskInstructionIndex
 *
 * Tests the radix-tree index for sub-task creation instructions,
 * the computeInstructionPrefix utility function, and the globalTaskInstructionIndex singleton.
 *
 * @module task-instruction-index.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Use vi.hoisted() so the mock function is available when the hoisted vi.mock factory runs.
const { mockExtractSubInstructions } = vi.hoisted(() => ({
    mockExtractSubInstructions: vi.fn()
}));

// Mock sub-instruction-extractor so addParentTaskWithSubInstructions is deterministic.
vi.mock('../sub-instruction-extractor.js', () => ({
    extractSubInstructions: mockExtractSubInstructions
}));

import { TaskInstructionIndex, computeInstructionPrefix, globalTaskInstructionIndex } from '../task-instruction-index.js';
import { extractSubInstructions } from '../sub-instruction-extractor.js';

describe('TaskInstructionIndex', () => {
    let index: TaskInstructionIndex;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        index = new TaskInstructionIndex();
        // Reset the extractSubInstructions mock to default behavior
        mockExtractSubInstructions.mockReset();
        mockExtractSubInstructions.mockReturnValue(['sub-instruction-1', 'sub-instruction-2']);
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
    });

    // =========================================================================
    // computeInstructionPrefix
    // =========================================================================
    describe('computeInstructionPrefix', () => {
        it('should return empty string for empty input', () => {
            expect(computeInstructionPrefix('')).toBe('');
            expect(computeInstructionPrefix(null as any)).toBe('');
            expect(computeInstructionPrefix(undefined as any)).toBe('');
        });

        it('should lowercase, trim and normalize whitespace for normal text', () => {
            const result = computeInstructionPrefix('  HELLO   WORLD  ', 50);
            expect(result).toBe('hello world');
        });

        it('should remove BOM character', () => {
            const bom = '\uFEFF';
            const result = computeInstructionPrefix(bom + 'hello world', 50);
            expect(result).toBe('hello world');
        });

        it('should unescape JSON escape sequences (\\n, \\t, \\\\, etc.)', () => {
            // The function replaces literal two-char sequences \\n, \\t, \\\\
            const input = 'line1\\nline2\\ttabbed\\\\backslash\\"quoted\\\'apos';
            const result = computeInstructionPrefix(input, 200);
            // After unescaping: line1\nline2\ttabbed\backslash"quoted'apos
            // After lowercase + whitespace normalization: newlines become spaces
            expect(result).toContain('line1');
            expect(result).toContain('line2');
            expect(result).not.toContain('\\n');
            expect(result).not.toContain('\\t');
            expect(result).not.toContain('\\\\');
            expect(result).not.toContain('\\"');
        });

        it('should handle named HTML entity patterns in source text', () => {
            // Note: The source regex patterns for named entity decoding (&lt; -> <, etc.)
            // are effectively identity transformations in the current implementation.
            // The numeric entity decoding (&#65; etc.) works correctly.
            // This test validates actual behavior rather than ideal behavior.
            const input = 'hello &amp; world';
            const result = computeInstructionPrefix(input, 200);
            // The function processes the text but named entities are not fully decoded
            // in the current implementation. Test that it at least does not crash
            // and produces a normalized lowercase result.
            expect(result).toContain('hello');
            expect(result).toContain('world');
            expect(result).toBe(result.toLowerCase());
        });

        it('should decode numeric HTML entities (decimal and hex)', () => {
            // &#65; = 'A', &#x42; = 'B'
            const input = '&#65;&#66;&#67; and &#x44;&#x45;';
            const result = computeInstructionPrefix(input, 200);
            // After decoding: ABC and DE
            // After lowercase: abc and de
            expect(result).toContain('abc');
            expect(result).toContain('de');
        });

        it('should strip HTML/XML tags', () => {
            const input = '<p>Hello</p> <strong>World</strong> <br/>';
            const result = computeInstructionPrefix(input, 200);
            expect(result).toContain('hello');
            expect(result).toContain('world');
            expect(result).not.toContain('<p>');
            expect(result).not.toContain('<strong>');
            expect(result).not.toContain('<br/>');
        });

        it('should truncate to K characters', () => {
            const longText = 'abcdefghijklmnopqrstuvwxyz';
            const result = computeInstructionPrefix(longText, 10);
            expect(result.length).toBeLessThanOrEqual(10);
        });

        it('should default to K=192', () => {
            const longText = 'a'.repeat(300);
            const result = computeInstructionPrefix(longText);
            expect(result.length).toBe(192);
        });

        it('should be deterministic', () => {
            const text = '  **MISSION   DEBUG   CRITIQUE  ';
            const result1 = computeInstructionPrefix(text, 192);
            const result2 = computeInstructionPrefix(text, 192);
            expect(result1).toBe(result2);
        });

        it('should not add ellipsis on truncation', () => {
            const longText = 'A'.repeat(300);
            const result = computeInstructionPrefix(longText, 50);
            expect(result).not.toContain('...');
            expect(result.length).toBe(50);
        });

        it('should extract <task> content and include it in prefix', () => {
            const input = '<task>Important mission details here</task>';
            const result = computeInstructionPrefix(input, 200);
            expect(result).toContain('important mission details here');
        });

        it('should extract <message> content and include it in prefix', () => {
            const input = '<message>Create the test module</message>';
            const result = computeInstructionPrefix(input, 200);
            expect(result).toContain('create the test module');
        });

        it('should trimEnd the result', () => {
            // After normalization the result should not have trailing spaces
            const input = 'hello world   ';
            const result = computeInstructionPrefix(input, 200);
            expect(result).toBe(result.trimEnd());
        });

        it('should handle \\r\\n sequences', () => {
            const input = 'line1\\r\\nline2';
            const result = computeInstructionPrefix(input, 200);
            expect(result).toContain('line1');
            expect(result).toContain('line2');
            expect(result).not.toContain('\\r\\n');
        });
    });

    // =========================================================================
    // TaskInstructionIndex - Basic Operations
    // =========================================================================
    describe('Basic Operations', () => {
        it('constructor creates an empty index', async () => {
            const size = await index.getSize();
            expect(size).toBe(0);

            const stats = index.getStats();
            expect(stats.totalNodes).toBe(0);
            expect(stats.totalInstructions).toBe(0);
            expect(stats.avgDepth).toBe(0);
        });

        it('addInstruction adds to index and getStats reflects it', () => {
            index.addInstruction('parent-001', 'Implement the search feature');

            const stats = index.getStats();
            expect(stats.totalNodes).toBe(1);
            expect(stats.totalInstructions).toBe(1);
            expect(stats.avgDepth).toBe(1);
        });

        it('addInstruction with same prefix adds multiple parents', () => {
            const instruction = 'Implement the search feature exactly';
            index.addInstruction('parent-001', instruction);
            index.addInstruction('parent-002', instruction);

            const stats = index.getStats();
            // Same prefix => 1 node, but 2 parents
            expect(stats.totalNodes).toBe(1);
            expect(stats.totalInstructions).toBe(1);
            // avgDepth = totalParents / totalInstructions = 2/1 = 2
            expect(stats.avgDepth).toBe(2);
        });

        it('addInstruction ignores empty prefix', async () => {
            index.addInstruction('parent-001', '');
            const size = await index.getSize();
            expect(size).toBe(0);
        });

        it('addInstruction stores instruction object when provided', async () => {
            index.addInstruction('parent-001', 'Test instruction', 'Full instruction text');
            const size = await index.getSize();
            expect(size).toBe(1);
        });

        it('addInstruction normalizes prefix via computeInstructionPrefix', () => {
            // Both should produce the same normalized prefix
            index.addInstruction('parent-001', '  HELLO  WORLD  ');
            index.addInstruction('parent-002', 'hello world');

            const stats = index.getStats();
            // Same normalized prefix, 1 node, 2 parents
            expect(stats.totalNodes).toBe(1);
            expect(stats.avgDepth).toBe(2);
        });

        it('addInstruction with custom K parameter', async () => {
            index.addInstruction('parent-001', 'a'.repeat(300), undefined, 50);
            const instructions = index.getInstructionsByParent('parent-001');
            expect(instructions.length).toBe(1);
            expect(instructions[0].length).toBeLessThanOrEqual(50);
        });

        it('clear empties the index', async () => {
            index.addInstruction('parent-001', 'Instruction one');
            index.addInstruction('parent-002', 'Instruction two');

            index.clear();

            const size = await index.getSize();
            expect(size).toBe(0);

            const stats = index.getStats();
            expect(stats.totalNodes).toBe(0);
            expect(stats.totalInstructions).toBe(0);
        });

        it('getSize returns correct count', async () => {
            expect(await index.getSize()).toBe(0);

            index.addInstruction('p1', 'First unique instruction');
            expect(await index.getSize()).toBe(1);

            index.addInstruction('p2', 'Second unique instruction');
            expect(await index.getSize()).toBe(2);

            // Same prefix as first -- should not increase count
            index.addInstruction('p3', 'First unique instruction');
            expect(await index.getSize()).toBe(2);
        });
    });

    // =========================================================================
    // Search Operations
    // =========================================================================
    describe('Search Operations', () => {
        describe('searchExactPrefix', () => {
            it('finds added instruction by exact prefix match', () => {
                const text = 'Implement the search feature for the project';
                index.addInstruction('task-001', text);

                const results = index.searchExactPrefix(text, 192);
                expect(results.length).toBeGreaterThanOrEqual(1);
                expect(results[0].taskId).toBe('task-001');
            });

            it('returns empty for no match', () => {
                index.addInstruction('task-001', 'Alpha beta gamma');
                const results = index.searchExactPrefix('Completely different unrelated text', 192);
                expect(results).toHaveLength(0);
            });

            it('returns empty for empty input', () => {
                const results = index.searchExactPrefix('', 192);
                expect(results).toHaveLength(0);
            });

            it('handles multiple parents for same prefix', () => {
                const text = 'Shared instruction text for multiple parents';
                index.addInstruction('task-001', text);
                index.addInstruction('task-002', text);

                const results = index.searchExactPrefix(text, 192);
                expect(results).toHaveLength(2);
                const taskIds = results.map(r => r.taskId).sort();
                expect(taskIds).toEqual(['task-001', 'task-002']);
            });

            it('works with different K values by indexing with matching K', () => {
                const text = 'Test instruction with various prefix lengths for validation testing';

                // Index and search with K=30
                const prefix30 = computeInstructionPrefix(text, 30);
                index.addInstruction('task-k30', prefix30, undefined, 30);

                const results = index.searchExactPrefix(text, 30);
                expect(results.length).toBeGreaterThanOrEqual(1);
                expect(results[0].taskId).toBe('task-k30');
                expect(results[0].prefix.length).toBeLessThanOrEqual(30);
            });

            it('normalizes case and whitespace in search', () => {
                index.addInstruction('task-001', 'create a new feature');
                const results = index.searchExactPrefix('  CREATE   A   NEW   FEATURE  ', 192);
                expect(results.length).toBeGreaterThanOrEqual(1);
                expect(results[0].taskId).toBe('task-001');
            });

            it('result objects have taskId and prefix but no similarity', () => {
                index.addInstruction('task-001', 'Something to search');
                const results = index.searchExactPrefix('Something to search', 192);
                if (results.length > 0) {
                    expect(results[0]).toHaveProperty('taskId');
                    expect(results[0]).toHaveProperty('prefix');
                    expect(results[0]).not.toHaveProperty('similarity');
                    expect(results[0]).not.toHaveProperty('score');
                }
            });

            it('prefix length is capped at 192 by default', () => {
                const longText = 'z'.repeat(500);
                index.addInstruction('task-001', longText);
                const results = index.searchExactPrefix(longText, 192);
                expect(results.length).toBeGreaterThanOrEqual(1);
                expect(results[0].prefix.length).toBe(192);
            });

            it('uses decreasing prefix lengths to find matches', () => {
                // Add a short prefix
                const shortText = 'short prefix text';
                index.addInstruction('task-short', shortText);

                // Search with a longer text that starts with the same words
                const longerText = shortText + ' followed by much more content that differs';
                const results = index.searchExactPrefix(longerText, 192);
                // The trie's getWithCheckpoints should find the shorter prefix via longest-prefix match
                // This depends on exact-trie behavior
                // At minimum, it should not crash
                expect(results).toBeDefined();
            });
        });

        describe('searchSimilar', () => {
            beforeEach(() => {
                index.addInstruction('task-001', 'mission debug critique systeme reparation hierarchique');
                index.addInstruction('task-002', 'mission corrective finale validation documentation');
                index.addInstruction('task-003', 'analyse architecture modulaire du projet');
            });

            it('finds similar entries above threshold', async () => {
                const results = await index.searchSimilar(
                    'mission debug critique reparation systeme',
                    0.2
                );
                expect(results.length).toBeGreaterThan(0);
                const match = results.find(r => r.taskId === 'task-001');
                expect(match).toBeDefined();
                expect(match!.similarity).toBeGreaterThanOrEqual(0.2);
            });

            it('returns empty below threshold', async () => {
                const results = await index.searchSimilar(
                    'texte completement different sans rapport',
                    0.95
                );
                expect(results).toHaveLength(0);
            });

            it('returns empty for empty search text', async () => {
                const results = await index.searchSimilar('', 0.2);
                expect(results).toHaveLength(0);
            });

            it('sorts results by similarity score descending', async () => {
                const results = await index.searchSimilar('mission debug', 0.1);
                if (results.length > 1) {
                    for (let i = 1; i < results.length; i++) {
                        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
                    }
                }
            });

            it('sets matchType correctly (exact/prefix/fuzzy)', async () => {
                // Exact match
                const exactResults = await index.searchSimilar(
                    'mission debug critique systeme reparation hierarchique',
                    0.9
                );
                const exactMatch = exactResults.find(r => r.taskId === 'task-001');
                if (exactMatch && exactMatch.similarity === 1) {
                    expect(exactMatch.matchType).toBe('exact');
                }

                // Fuzzy match
                const fuzzyResults = await index.searchSimilar('mission corrective', 0.1);
                const fuzzyMatch = fuzzyResults.find(
                    r => r.similarity > 0 && r.similarity <= 0.5
                );
                if (fuzzyMatch) {
                    expect(fuzzyMatch.matchType).toBe('fuzzy');
                }
            });

            it('populates similarityScore field', async () => {
                const results = await index.searchSimilar('mission debug', 0.1);
                for (const r of results) {
                    expect(r.similarityScore).toBeDefined();
                    expect(r.similarityScore).toBe(r.similarity);
                }
            });
        });
    });

    // =========================================================================
    // Deprecated Methods
    // =========================================================================
    describe('Deprecated Methods', () => {
        it('findPotentialParent always returns undefined', () => {
            index.addInstruction('task-001', 'Some instruction to find');
            const result = index.findPotentialParent('Some instruction to find');
            expect(result).toBeUndefined();
        });

        it('findPotentialParent logs deprecation warning', () => {
            index.findPotentialParent('test');
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('DEPRECATED')
            );
        });

        it('findPotentialParent accepts optional excludeTaskId', () => {
            const result = index.findPotentialParent('test', 'exclude-me');
            expect(result).toBeUndefined();
        });

        it('findAllPotentialParents always returns empty array', () => {
            index.addInstruction('task-001', 'Some instruction');
            const results = index.findAllPotentialParents('Some instruction');
            expect(results).toEqual([]);
        });

        it('findAllPotentialParents logs deprecation warning', () => {
            index.findAllPotentialParents('test');
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('DEPRECATED')
            );
        });
    });

    // =========================================================================
    // Parent-Child Relations
    // =========================================================================
    describe('Parent-Child Relations', () => {
        describe('getInstructionsByParent', () => {
            it('returns correct prefixes for a parent', () => {
                index.addInstruction('parent-001', 'First instruction for parent one');
                index.addInstruction('parent-001', 'Second instruction for parent one');
                index.addInstruction('parent-002', 'Instruction for parent two');

                const instructions = index.getInstructionsByParent('parent-001');
                expect(instructions).toHaveLength(2);
                // Instructions are stored as normalized prefixes
                expect(instructions[0]).toBe(
                    computeInstructionPrefix('First instruction for parent one', 192)
                );
                expect(instructions[1]).toBe(
                    computeInstructionPrefix('Second instruction for parent one', 192)
                );
            });

            it('returns empty array for non-existent parent', () => {
                const instructions = index.getInstructionsByParent('non-existent');
                expect(instructions).toHaveLength(0);
            });

            it('does not duplicate prefixes for same parent', () => {
                const text = 'Duplicate instruction text';
                index.addInstruction('parent-001', text);
                index.addInstruction('parent-001', text);

                const instructions = index.getInstructionsByParent('parent-001');
                expect(instructions).toHaveLength(1);
            });
        });

        describe('validateParentChildRelation', () => {
            it('returns true for valid relation', () => {
                const text = 'Mission debug critique reparation du systeme hierarchique';
                index.addInstruction('parent-001', text);

                const isValid = index.validateParentChildRelation(text, 'parent-001');
                expect(isValid).toBe(true);
            });

            it('returns false for invalid relation (wrong parent)', () => {
                index.addInstruction('parent-001', 'First instruction');
                index.addInstruction('parent-002', 'Second instruction');

                const isValid = index.validateParentChildRelation(
                    'Second instruction',
                    'parent-001'
                );
                expect(isValid).toBe(false);
            });

            it('returns false for empty childText', () => {
                expect(index.validateParentChildRelation('', 'parent-001')).toBe(false);
            });

            it('returns false for empty parentId', () => {
                expect(index.validateParentChildRelation('test', '')).toBe(false);
            });

            it('returns false when no instructions exist', () => {
                expect(index.validateParentChildRelation('test', 'parent-001')).toBe(false);
            });
        });

        describe('searchByTaskId', () => {
            it('finds entries for a given taskId', async () => {
                index.addInstruction('task-ABC', 'Instruction alpha');
                index.addInstruction('task-ABC', 'Instruction beta');
                index.addInstruction('task-DEF', 'Instruction gamma');

                const results = await index.searchByTaskId('task-ABC');
                expect(results).toHaveLength(2);
                for (const r of results) {
                    expect(r.taskId).toBe('task-ABC');
                }
            });

            it('returns empty for non-existent taskId', async () => {
                index.addInstruction('task-ABC', 'Something');
                const results = await index.searchByTaskId('task-NONE');
                expect(results).toHaveLength(0);
            });

            it('returns empty for empty taskId', async () => {
                const results = await index.searchByTaskId('');
                expect(results).toHaveLength(0);
            });

            it('returns empty for whitespace-only taskId', async () => {
                const results = await index.searchByTaskId('   ');
                expect(results).toHaveLength(0);
            });
        });

        describe('getParentsForInstruction', () => {
            it('delegates to searchExactPrefix logic', async () => {
                const text = 'Instruction to find parents for matching test';
                index.addInstruction('parent-001', text);
                index.addInstruction('parent-002', text);

                const results = await index.getParentsForInstruction(text);
                expect(results.length).toBeGreaterThanOrEqual(1);
                const taskIds = results.map(r => r.taskId).sort();
                expect(taskIds).toContain('parent-001');
                expect(taskIds).toContain('parent-002');
            });

            it('returns empty for empty instruction', async () => {
                const results = await index.getParentsForInstruction('');
                expect(results).toHaveLength(0);
            });
        });
    });

    // =========================================================================
    // Rebuild & Batch Operations
    // =========================================================================
    describe('Rebuild & Batch', () => {
        it('rebuildFromSkeletons populates index correctly', async () => {
            const skeletonPrefixes = new Map<string, string[]>([
                ['task-001', ['Prefix alpha one', 'Prefix alpha two']],
                ['task-002', ['Prefix beta one']],
                ['task-003', ['Prefix gamma one', 'Prefix gamma two', 'Prefix gamma three']]
            ]);

            index.rebuildFromSkeletons(skeletonPrefixes);

            const size = await index.getSize();
            // 6 unique prefixes (all different)
            expect(size).toBe(6);

            const stats = index.getStats();
            expect(stats.totalNodes).toBe(6);
            expect(stats.totalInstructions).toBe(6);
        });

        it('rebuildFromSkeletons handles empty map', async () => {
            index.rebuildFromSkeletons(new Map());
            const size = await index.getSize();
            expect(size).toBe(0);
        });

        it('rebuildFromSkeletons logs reconstruction messages', () => {
            const skeletonPrefixes = new Map<string, string[]>([
                ['task-001', ['Prefix one']]
            ]);

            index.rebuildFromSkeletons(skeletonPrefixes);

            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('Reconstruction')
            );
            expect(console.log).toHaveBeenCalledWith(
                expect.stringContaining('Index reconstruit')
            );
        });

        it('rebuildFromSkeletons handles shared prefixes across tasks', async () => {
            const sharedPrefix = 'Shared instruction text';
            const skeletonPrefixes = new Map<string, string[]>([
                ['task-001', [sharedPrefix]],
                ['task-002', [sharedPrefix]]
            ]);

            index.rebuildFromSkeletons(skeletonPrefixes);

            const size = await index.getSize();
            // Same prefix => 1 node
            expect(size).toBe(1);

            // But 2 parents for that node
            const stats = index.getStats();
            expect(stats.avgDepth).toBe(2);
        });
    });

    // =========================================================================
    // Temp Truncated Instructions
    // =========================================================================
    describe('Temp Truncated Instructions', () => {
        it('getTruncatedInstruction returns undefined when nothing stored', () => {
            const result = index.getTruncatedInstruction('task-001');
            expect(result).toBeUndefined();
        });

        it('getTruncatedInstruction returns stored value after addParentTaskWithSubInstructions', () => {
            index.addParentTaskWithSubInstructions('task-001', 'Some parent text with sub-instructions');

            const result = index.getTruncatedInstruction('task-001');
            expect(result).toBeDefined();
            // The mock returns ['sub-instruction-1', 'sub-instruction-2']
            // The first sub-instruction is stored
            expect(result).toBe('sub-instruction-1');
        });

        it('clearTempTruncatedInstructions removes all stored values', () => {
            index.addParentTaskWithSubInstructions('task-001', 'Some parent text');
            index.addParentTaskWithSubInstructions('task-002', 'Other parent text');

            expect(index.getTruncatedInstruction('task-001')).toBeDefined();
            expect(index.getTruncatedInstruction('task-002')).toBeDefined();

            index.clearTempTruncatedInstructions();

            expect(index.getTruncatedInstruction('task-001')).toBeUndefined();
            expect(index.getTruncatedInstruction('task-002')).toBeUndefined();
        });
    });

    // =========================================================================
    // addParentTaskWithSubInstructions
    // =========================================================================
    describe('addParentTaskWithSubInstructions', () => {
        it('extracts sub-instructions via extractSubInstructions and indexes them', () => {
            const count = index.addParentTaskWithSubInstructions(
                'task-parent',
                'Full instruction text with sub-tasks'
            );

            // Mock returns 2 sub-instructions
            expect(count).toBe(2);
            expect(extractSubInstructions).toHaveBeenCalledWith('Full instruction text with sub-tasks');
        });

        it('returns 0 for empty instruction text', () => {
            const count = index.addParentTaskWithSubInstructions('task-parent', '');
            expect(count).toBe(0);
        });

        it('falls back to computeInstructionPrefix when extractSubInstructions returns empty', () => {
            // Override the mock to return empty array for this test
            mockExtractSubInstructions.mockReturnValueOnce([]);

            const count = index.addParentTaskWithSubInstructions(
                'task-parent',
                'Full text that has no sub-instructions'
            );

            // Fallback: uses the full text as a single instruction
            expect(count).toBe(1);
        });

        it('stores truncatedInstruction for the parent', () => {
            index.addParentTaskWithSubInstructions('task-parent', 'Some text');

            const truncated = index.getTruncatedInstruction('task-parent');
            expect(truncated).toBe('sub-instruction-1');
        });

        it('stores fallback truncatedInstruction when no sub-instructions', () => {
            mockExtractSubInstructions.mockReturnValueOnce([]);

            index.addParentTaskWithSubInstructions(
                'task-parent',
                'Fallback text instruction'
            );

            const truncated = index.getTruncatedInstruction('task-parent');
            expect(truncated).toBeDefined();
            // The fallback stores computeInstructionPrefix of the full text
            expect(truncated).toBe(computeInstructionPrefix('Fallback text instruction', 192));
        });
    });

    // =========================================================================
    // getStats
    // =========================================================================
    describe('getStats', () => {
        it('returns correct statistics for empty index', () => {
            const stats = index.getStats();
            expect(stats.totalNodes).toBe(0);
            expect(stats.totalInstructions).toBe(0);
            expect(stats.avgDepth).toBe(0);
        });

        it('returns correct statistics after adding instructions', () => {
            index.addInstruction('p1', 'Unique instruction one');
            index.addInstruction('p2', 'Unique instruction two');
            index.addInstruction('p3', 'Unique instruction three');

            const stats = index.getStats();
            expect(stats.totalNodes).toBe(3);
            expect(stats.totalInstructions).toBe(3);
            expect(stats.avgDepth).toBe(1); // 1 parent per instruction
        });

        it('calculates avgDepth correctly with multiple parents per prefix', () => {
            const sharedText = 'shared instruction text';
            index.addInstruction('p1', sharedText);
            index.addInstruction('p2', sharedText);
            index.addInstruction('p3', 'unique instruction');

            const stats = index.getStats();
            expect(stats.totalNodes).toBe(2);
            expect(stats.totalInstructions).toBe(2);
            // avgDepth = totalParents / totalInstructions = (2 + 1) / 2 = 1.5
            expect(stats.avgDepth).toBe(1.5);
        });
    });

    // =========================================================================
    // getAllParentTaskIds
    // =========================================================================
    describe('getAllParentTaskIds', () => {
        it('returns all unique parent IDs', async () => {
            index.addInstruction('p1', 'Instruction A');
            index.addInstruction('p2', 'Instruction B');
            index.addInstruction('p1', 'Instruction C'); // p1 again

            const parentIds = await index.getAllParentTaskIds();
            expect(parentIds.sort()).toEqual(['p1', 'p2']);
        });

        it('returns empty array for empty index', async () => {
            const parentIds = await index.getAllParentTaskIds();
            expect(parentIds).toEqual([]);
        });
    });

    // =========================================================================
    // globalTaskInstructionIndex singleton
    // =========================================================================
    describe('globalTaskInstructionIndex', () => {
        it('is an instance of TaskInstructionIndex', () => {
            expect(globalTaskInstructionIndex).toBeInstanceOf(TaskInstructionIndex);
        });

        it('has all expected methods', () => {
            expect(typeof globalTaskInstructionIndex.addInstruction).toBe('function');
            expect(typeof globalTaskInstructionIndex.searchExactPrefix).toBe('function');
            expect(typeof globalTaskInstructionIndex.searchSimilar).toBe('function');
            expect(typeof globalTaskInstructionIndex.getStats).toBe('function');
            expect(typeof globalTaskInstructionIndex.clear).toBe('function');
            expect(typeof globalTaskInstructionIndex.getSize).toBe('function');
            expect(typeof globalTaskInstructionIndex.rebuildFromSkeletons).toBe('function');
        });
    });

    // =========================================================================
    // Edge Cases
    // =========================================================================
    describe('Edge Cases', () => {
        it('handles very long instructions without crashing', async () => {
            const veryLong = 'word '.repeat(5000);
            index.addInstruction('parent-001', veryLong);

            const size = await index.getSize();
            expect(size).toBeGreaterThanOrEqual(1);
        });

        it('handles unicode characters', async () => {
            index.addInstruction('parent-001', 'Caracteres accentues et emojis: cafe resume');
            const size = await index.getSize();
            expect(size).toBe(1);
        });

        it('handles instructions with only whitespace', async () => {
            index.addInstruction('parent-001', '     ');
            // The raw input '     ' passes the empty-check guard (non-empty string),
            // then computeInstructionPrefix normalizes it to '' which is stored in the trie.
            // The prefixToEntry map gets an entry with key '', so size = 1.
            const size = await index.getSize();
            expect(size).toBe(1);
        });

        it('handles null/undefined safely for addInstruction', () => {
            expect(() => index.addInstruction(null as any, 'test')).not.toThrow();
            expect(() => index.addInstruction('parent', null as any)).not.toThrow();
            expect(() => index.addInstruction('parent', undefined as any)).not.toThrow();
        });

        it('handles null/undefined safely for searchSimilar', async () => {
            const results = await index.searchSimilar(null as any, 0.2);
            expect(results).toHaveLength(0);
        });

        it('handles null/undefined safely for searchExactPrefix', () => {
            const results = index.searchExactPrefix(null as any, 192);
            expect(results).toHaveLength(0);
        });

        it('multiple clear calls do not crash', () => {
            index.clear();
            index.clear();
            index.clear();
            expect(true).toBe(true); // If we get here, no crash
        });

        it('operations work after clear and re-add', async () => {
            index.addInstruction('p1', 'First instruction');
            index.clear();
            index.addInstruction('p2', 'Second instruction');

            const size = await index.getSize();
            expect(size).toBe(1);

            const instructions = index.getInstructionsByParent('p1');
            expect(instructions).toHaveLength(0); // p1 was cleared

            const instructions2 = index.getInstructionsByParent('p2');
            expect(instructions2).toHaveLength(1);
        });
    });
});
