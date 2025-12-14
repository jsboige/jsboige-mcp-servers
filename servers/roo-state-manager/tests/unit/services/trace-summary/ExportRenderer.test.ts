import { describe, it, expect, beforeEach } from 'vitest';
import { ExportRenderer } from '../../../../src/services/trace-summary/ExportRenderer.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';
import { SummaryOptions, SummaryStatistics } from '../../../../src/services/TraceSummaryService.js';
import { ClassifiedContent } from '../../../../src/services/trace-summary/ContentClassifier.js';

describe('ExportRenderer', () => {
    let renderer: ExportRenderer;

    beforeEach(() => {
        renderer = new ExportRenderer();
    });

    describe('generateHeader', () => {
        it('should generate header with correct information', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {
                    totalSize: 1024,
                    createdAt: 0,
                    lastActivity: 0
                } as any,
                sequence: []
            };
            const options: SummaryOptions = {} as any;

            const header = renderer.generateHeader(conversation, options);
            expect(header).toContain('# RESUME DE TRACE D\'ORCHESTRATION ROO');
            expect(header).toContain('**Taille source :** 1 KB');
        });
    });
});