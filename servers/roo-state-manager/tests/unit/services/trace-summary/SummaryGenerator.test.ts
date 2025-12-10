import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SummaryGenerator } from '../../../../src/services/trace-summary/SummaryGenerator.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';
import { ContentClassifier } from '../../../../src/services/trace-summary/ContentClassifier.js';
import { ExportRenderer } from '../../../../src/services/trace-summary/ExportRenderer.js';
import { InteractiveFeatures } from '../../../../src/services/trace-summary/InteractiveFeatures.js';

// Mock dependencies
vi.mock('../../../../src/services/trace-summary/ContentClassifier.js');
vi.mock('../../../../src/services/trace-summary/ExportRenderer.js');
vi.mock('../../../../src/services/trace-summary/InteractiveFeatures.js');

describe('SummaryGenerator', () => {
    let generator: SummaryGenerator;
    let mockClassifier: any;
    let mockRenderer: any;
    let mockInteractive: any;

    const mockConversation: ConversationSkeleton = {
        taskId: 'test-id',
        truncatedInstruction: 'Test Conversation',
        parentTaskId: '',
        sequence: [
            { role: 'user', content: 'Hello', timestamp: new Date().toISOString(), isTruncated: false },
            { role: 'assistant', content: 'Hi there', timestamp: new Date().toISOString(), isTruncated: false }
        ],
        metadata: {
            title: 'Test Conversation',
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            messageCount: 2,
            actionCount: 0,
            totalSize: 100,
            workspace: 'test-workspace',
            dataSource: 'test-source'
        },
    };

    const mockClassifiedContent = [
        { type: 'User', subType: 'UserMessage', content: 'Hello' },
        { type: 'Assistant', subType: 'Completion', content: 'Hi there' }
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Setup mocks
        mockClassifier = {
            classifyContentFromMarkdownOrJson: vi.fn().mockResolvedValue(mockClassifiedContent)
        };
        
        mockRenderer = {
            generateHeader: vi.fn().mockReturnValue('# Header'),
            generateMetadata: vi.fn().mockReturnValue('Metadata'),
            generateEmbeddedCss: vi.fn().mockReturnValue('<style>css</style>'),
            generateStatistics: vi.fn().mockReturnValue('Stats'),
            generateFooter: vi.fn().mockReturnValue('Footer'),
            ensureSingleCss: vi.fn().mockImplementation((content) => content),
            renderSummary: vi.fn().mockResolvedValue('Full Rendered Summary')
        };
        
        mockInteractive = {
            renderConversationContentWithStrategies: vi.fn().mockResolvedValue('Interactive Content')
        };

        // Mock constructors
        (ContentClassifier as any).mockImplementation(() => mockClassifier);
        (ExportRenderer as any).mockImplementation(() => mockRenderer);
        (InteractiveFeatures as any).mockImplementation(() => mockInteractive);

        generator = new SummaryGenerator();
    });

    describe('generateSummary', () => {
        it('should generate summary using standard renderer by default', async () => {
            const result = await generator.generateSummary(mockConversation);

            expect(result.success).toBe(true);
            expect(result.content).toBe('Full Rendered Summary');
            expect(mockClassifier.classifyContentFromMarkdownOrJson).toHaveBeenCalledWith(
                mockConversation,
                expect.objectContaining({ detailLevel: 'Full' })
            );
            expect(mockRenderer.renderSummary).toHaveBeenCalled();
        });

        it('should use interactive features when enableDetailLevels is true', async () => {
            const options = {
                enableDetailLevels: true,
                detailLevel: 'Full' as const,
                includeCss: true
            };

            const result = await generator.generateSummary(mockConversation, options);

            expect(result.success).toBe(true);
            expect(mockInteractive.renderConversationContentWithStrategies).toHaveBeenCalled();
            expect(mockRenderer.generateHeader).toHaveBeenCalled();
            expect(mockRenderer.generateMetadata).toHaveBeenCalled();
            expect(mockRenderer.generateEmbeddedCss).toHaveBeenCalled();
            expect(mockRenderer.generateStatistics).toHaveBeenCalled();
            expect(mockRenderer.generateFooter).toHaveBeenCalled();
            
            // Verify content assembly
            expect(result.content).toContain('# Header');
            expect(result.content).toContain('Metadata');
            expect(result.content).toContain('<style>css</style>');
            expect(result.content).toContain('Stats');
            expect(result.content).toContain('Interactive Content');
            expect(result.content).toContain('Footer');
        });

        it('should handle errors gracefully', async () => {
            mockClassifier.classifyContentFromMarkdownOrJson.mockRejectedValue(new Error('Classification failed'));

            const result = await generator.generateSummary(mockConversation);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Classification failed');
            expect(result.statistics.totalSections).toBe(0);
        });
    });

    describe('calculateStatistics', () => {
        it('should calculate correct statistics from classified content', () => {
            const stats = generator.calculateStatistics(mockClassifiedContent as any);

            expect(stats.totalSections).toBe(2);
            expect(stats.userMessages).toBe(1);
            expect(stats.assistantMessages).toBe(1);
            expect(stats.userContentSize).toBe(5); // "Hello".length
            expect(stats.assistantContentSize).toBe(8); // "Hi there".length
            expect(stats.totalContentSize).toBe(13);
        });

        it('should handle empty content', () => {
            const stats = generator.calculateStatistics([]);

            expect(stats.totalSections).toBe(0);
            expect(stats.totalContentSize).toBe(0);
            expect(stats.userPercentage).toBe(0);
        });
    });

    describe('mergeWithDefaultOptions', () => {
        it('should use defaults when no options provided', () => {
            const options = generator.mergeWithDefaultOptions({});

            expect(options.detailLevel).toBe('Full');
            expect(options.includeCss).toBe(true);
            expect(options.outputFormat).toBe('markdown');
        });

        it('should override defaults with provided options', () => {
            const options = generator.mergeWithDefaultOptions({
                detailLevel: 'Summary',
                includeCss: false
            });

            expect(options.detailLevel).toBe('Summary');
            expect(options.includeCss).toBe(false);
        });

        it('should set tocStyle based on outputFormat if not provided', () => {
            const optionsHtml = generator.mergeWithDefaultOptions({ outputFormat: 'html' });
            expect(optionsHtml.tocStyle).toBe('html');

            const optionsMd = generator.mergeWithDefaultOptions({ outputFormat: 'markdown' });
            expect(optionsMd.tocStyle).toBe('markdown');
        });
    });

    describe('getOriginalContentSize', () => {
        it('should calculate total size of message content', () => {
            const size = generator.getOriginalContentSize(mockConversation);
            expect(size).toBe(13); // "Hello" + "Hi there"
        });

        it('should handle empty conversation', () => {
            const size = generator.getOriginalContentSize({ ...mockConversation, sequence: [] });
            expect(size).toBe(0);
        });
    });
});