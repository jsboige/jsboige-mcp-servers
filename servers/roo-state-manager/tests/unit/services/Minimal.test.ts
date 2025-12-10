import { describe, it, expect } from 'vitest';
import { ContentClassifier } from '../../../src/services/trace-summary/ContentClassifier.js';

describe('Minimal', () => {
    it('should import ContentClassifier', () => {
        expect(ContentClassifier).toBeDefined();
    });
});