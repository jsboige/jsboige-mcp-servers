/**
 * Tests pour InteractiveFeatures.ts
 * Issue #492 - Couverture des services trace-summary
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing - paths relative to THIS test file
const { mockRenderConversationContent, mockExtractToolCallDetails, mockExtractToolResultDetails, mockCreateStrategy, mockGenerateReport } = vi.hoisted(() => ({
	mockRenderConversationContent: vi.fn(),
	mockExtractToolCallDetails: vi.fn(),
	mockExtractToolResultDetails: vi.fn(),
	mockCreateStrategy: vi.fn(),
	mockGenerateReport: vi.fn()
}));

// Paths are relative to the test file: __tests__/InteractiveFeatures.test.ts
// ContentClassifier is at ../ContentClassifier.js (up from __tests__ to trace-summary)
vi.mock('../ContentClassifier.js', () => ({
	ContentClassifier: class {
		extractToolCallDetails(...args: any[]) { return mockExtractToolCallDetails(...args); }
		extractToolResultDetails(...args: any[]) { return mockExtractToolResultDetails(...args); }
	}
}));

vi.mock('../ExportRenderer.js', () => ({
	ExportRenderer: class {
		renderConversationContent(...args: any[]) { return mockRenderConversationContent(...args); }
	}
}));

// DetailLevelStrategyFactory is at ../../reporting/DetailLevelStrategyFactory.js
vi.mock('../../reporting/DetailLevelStrategyFactory.js', () => ({
	DetailLevelStrategyFactory: {
		createStrategy: mockCreateStrategy
	}
}));

import { InteractiveFeatures } from '../InteractiveFeatures.js';

describe('InteractiveFeatures', () => {
	let features: InteractiveFeatures;

	beforeEach(() => {
		vi.clearAllMocks();
		features = new InteractiveFeatures();
		mockExtractToolCallDetails.mockReturnValue(null);
		mockExtractToolResultDetails.mockReturnValue(null);
	});

	// ============================================================
	// renderConversationContentWithStrategies
	// ============================================================

	describe('renderConversationContentWithStrategies', () => {
		const sampleContent = [
			{ role: 'user', content: 'Hello', type: 'message' },
			{ role: 'assistant', content: 'Hi there', type: 'message' }
		];

		test('falls back to legacy renderer when enableDetailLevels is false', async () => {
			mockRenderConversationContent.mockReturnValue('legacy output');

			const result = await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{ enableDetailLevels: false } as any
			);

			expect(result).toBe('legacy output');
			expect(mockRenderConversationContent).toHaveBeenCalledWith(sampleContent, expect.any(Object));
			expect(mockCreateStrategy).not.toHaveBeenCalled();
		});

		test('falls back to legacy renderer when enableDetailLevels is undefined', async () => {
			mockRenderConversationContent.mockReturnValue('legacy');

			const result = await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{} as any
			);

			expect(result).toBe('legacy');
		});

		test('uses strategy when enableDetailLevels is true', async () => {
			const mockStrategy = { generateReport: mockGenerateReport };
			mockCreateStrategy.mockReturnValue(mockStrategy);
			mockGenerateReport.mockReturnValue('strategy output');

			const result = await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{
					enableDetailLevels: true,
					detailLevel: 'Full',
					outputFormat: 'markdown'
				} as any
			);

			expect(result).toBe('strategy output');
			expect(mockCreateStrategy).toHaveBeenCalledWith('Full');
		});

		test('falls back to legacy on strategy error', async () => {
			mockCreateStrategy.mockImplementation(() => { throw new Error('Strategy error'); });
			mockRenderConversationContent.mockReturnValue('fallback');

			const result = await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{ enableDetailLevels: true, detailLevel: 'Full' } as any
			);

			expect(result).toBe('fallback');
		});

		test('passes enhanced options to strategy', async () => {
			const mockStrategy = { generateReport: mockGenerateReport };
			mockCreateStrategy.mockReturnValue(mockStrategy);
			mockGenerateReport.mockReturnValue('output');

			await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{
					enableDetailLevels: true,
					detailLevel: 'NoTools',
					outputFormat: 'markdown',
					truncationChars: 500,
					compactStats: true,
					includeCss: false,
					generateToc: true
				} as any
			);

			expect(mockGenerateReport).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					detailLevel: 'NoTools',
					outputFormat: 'markdown',
					truncationChars: 500,
					compactStats: true,
					includeCss: false,
					generateToc: true
				})
			);
		});

		test('converts content to enhanced format with metadata', async () => {
			const mockStrategy = { generateReport: mockGenerateReport };
			mockCreateStrategy.mockReturnValue(mockStrategy);
			mockGenerateReport.mockImplementation((enhancedContent: any[]) => {
				// Verify enhanced format
				expect(enhancedContent[0]).toHaveProperty('contentSize');
				expect(enhancedContent[0]).toHaveProperty('isRelevant', true);
				expect(enhancedContent[0]).toHaveProperty('confidenceScore', 0.8);
				expect(enhancedContent[0]).toHaveProperty('timestamp');
				expect(enhancedContent[0]).toHaveProperty('processingNotes');
				return 'ok';
			});

			await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{ enableDetailLevels: true, detailLevel: 'Full' } as any
			);

			expect(mockGenerateReport).toHaveBeenCalled();
		});

		test('maps non-markdown output format correctly', async () => {
			const mockStrategy = { generateReport: mockGenerateReport };
			mockCreateStrategy.mockReturnValue(mockStrategy);
			mockGenerateReport.mockReturnValue('html output');

			await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{
					enableDetailLevels: true,
					detailLevel: 'Full',
					outputFormat: 'html'
				} as any
			);

			expect(mockGenerateReport).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({ outputFormat: 'html' })
			);
		});

		test('calls extractToolCallDetails for each content item', async () => {
			const mockStrategy = { generateReport: mockGenerateReport };
			mockCreateStrategy.mockReturnValue(mockStrategy);
			mockGenerateReport.mockReturnValue('ok');

			await features.renderConversationContentWithStrategies(
				sampleContent as any,
				{ enableDetailLevels: true, detailLevel: 'Full' } as any
			);

			expect(mockExtractToolCallDetails).toHaveBeenCalledTimes(2);
			expect(mockExtractToolResultDetails).toHaveBeenCalledTimes(2);
		});
	});
});
