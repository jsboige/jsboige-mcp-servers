import { describe, it, expect, beforeEach } from 'vitest';
import { ContentClassifier } from '../../../../src/services/trace-summary/ContentClassifier.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

describe('ContentClassifier', () => {
    let classifier: ContentClassifier;

    beforeEach(() => {
        classifier = new ContentClassifier();
    });

    describe('classifyConversationContent', () => {
        it('should classify user messages correctly', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {} as any,
                sequence: [
                    { role: 'user', content: 'Hello world', timestamp: '123', isTruncated: false }
                ]
            };

            const result = classifier.classifyConversationContent(conversation);
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                type: 'User',
                subType: 'UserMessage',
                content: 'Hello world',
                index: 0
            });
        });

        it('should classify assistant messages correctly', () => {
            const conversation: ConversationSkeleton = {
                taskId: 'test-task',
                metadata: {} as any,
                sequence: [
                    { role: 'assistant', content: 'Hello user', timestamp: '123', isTruncated: false }
                ]
            };

            const result = classifier.classifyConversationContent(conversation);
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                type: 'Assistant',
                subType: 'ToolCall', // Default fallback
                content: 'Hello user',
                index: 0
            });
        });
    });
});