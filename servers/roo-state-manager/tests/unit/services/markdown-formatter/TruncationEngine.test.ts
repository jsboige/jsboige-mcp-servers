import { describe, it, expect } from 'vitest';
import { TruncationEngine } from '../../../../src/services/markdown-formatter/TruncationEngine.js';

describe('TruncationEngine', () => {
    describe('truncateToolParameters', () => {
        it('should return N/A for null or undefined params', () => {
            expect(TruncationEngine.truncateToolParameters(null)).toEqual({ content: 'N/A', wasTruncated: false });
            expect(TruncationEngine.truncateToolParameters(undefined)).toEqual({ content: 'N/A', wasTruncated: false });
        });

        it('should not truncate if content length is within limit', () => {
            const params = { key: 'value' };
            const result = TruncationEngine.truncateToolParameters(params, { maxParameterLength: 100 } as any);
            expect(result.wasTruncated).toBe(false);
            expect(result.content).toBe(JSON.stringify(params, null, 2));
        });

        it('should truncate string content exceeding limit', () => {
            const params = 'a'.repeat(100);
            const result = TruncationEngine.truncateToolParameters(params, { maxParameterLength: 50 } as any);
            expect(result.wasTruncated).toBe(true);
            expect(result.content).toBe('a'.repeat(50) + '...');
        });

        it('should intelligently truncate object content exceeding limit', () => {
            const params = {
                key1: 'value1',
                key2: 'value2',
                key3: 'value3',
                key4: 'value4'
            };
            // Force truncation by setting a small limit
            const result = TruncationEngine.truncateToolParameters(params, { maxParameterLength: 30, preserveStructure: true } as any);
            expect(result.wasTruncated).toBe(true);
            const parsedContent = JSON.parse(result.content);
            expect(parsedContent).toHaveProperty('...');
        });

        it('should use simple truncation for objects if preserveStructure is false', () => {
            const params = { key: 'value' };
            const result = TruncationEngine.truncateToolParameters(params, { maxParameterLength: 5, preserveStructure: false } as any);
            expect(result.wasTruncated).toBe(true);
            expect(result.content.endsWith('...')).toBe(true);
            expect(() => JSON.parse(result.content)).toThrow(); // Should not be valid JSON
        });
    });

    describe('truncateToolResult', () => {
        it('should return N/A for null or undefined result', () => {
            expect(TruncationEngine.truncateToolResult(null)).toEqual({ content: 'N/A', wasTruncated: false });
            expect(TruncationEngine.truncateToolResult(undefined)).toEqual({ content: 'N/A', wasTruncated: false });
        });

        it('should not truncate if content length is within limit', () => {
            const resultData = 'Short result';
            const result = TruncationEngine.truncateToolResult(resultData, { maxResultLength: 100 } as any);
            expect(result.wasTruncated).toBe(false);
            expect(result.content).toBe(resultData);
        });

        it('should truncate long content preserving context', () => {
            const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
            const resultData = lines.join('\n');
            const result = TruncationEngine.truncateToolResult(resultData, { maxResultLength: 50 } as any);
            
            expect(result.wasTruncated).toBe(true);
            expect(result.content).toContain('Line 1');
            expect(result.content).toContain('Line 20');
            expect(result.content).toContain('lignes tronquées');
        });

        it('should use simple truncation for short but over-limit content', () => {
            const resultData = 'This is a somewhat long string but without newlines';
            const result = TruncationEngine.truncateToolResult(resultData, { maxResultLength: 10 } as any);
            
            expect(result.wasTruncated).toBe(true);
            expect(result.content).toBe('This is a ...');
        });
    });

    describe('generateTruncationToggle', () => {
        it('should generate HTML for truncation toggle', () => {
            const html = TruncationEngine.generateTruncationToggle('Full Content', 'Truncated...', 'test-id');
            expect(html).toContain('id="truncated-test-id"');
            expect(html).toContain('id="full-test-id"');
            expect(html).toContain('Truncated...');
            expect(html).toContain('Full Content');
            expect(html).toContain('onclick="toggleTruncation(\'test-id\')"');
        });
    });

    describe('generateExpandableContent', () => {
        it('should generate HTML for expandable content', () => {
            const html = TruncationEngine.generateExpandableContent('Hidden Content', 'Summary', 'test-id');
            expect(html).toContain('class="expandable-container"');
            expect(html).toContain('Summary');
            expect(html).toContain('Hidden Content');
            expect(html).toContain('onclick="toggleExpandable(\'test-id\')"');
        });
    });
});