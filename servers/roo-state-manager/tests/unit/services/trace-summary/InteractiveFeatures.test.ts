import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractiveFeatures } from '../../../../src/services/trace-summary/InteractiveFeatures.js';
import { SummaryOptions } from '../../../../src/services/TraceSummaryService.js';
import { ClassifiedContent } from '../../../../src/services/trace-summary/ContentClassifier.js';
import { DetailLevelStrategyFactory } from '../../../../src/services/reporting/DetailLevelStrategyFactory.js';

// Mock DetailLevelStrategyFactory
vi.mock('../../../../src/services/reporting/DetailLevelStrategyFactory.js', () => ({
    DetailLevelStrategyFactory: {
        createStrategy: vi.fn().mockReturnValue({
            generateReport: vi.fn().mockReturnValue('Strategic Content')
        })
    }
}));

describe('InteractiveFeatures', () => {
    let interactive: InteractiveFeatures;

    beforeEach(() => {
        interactive = new InteractiveFeatures();
    });

    describe('renderConversationContentWithStrategies', () => {
        it('should use legacy renderer when enableDetailLevels is false', async () => {
            const content: ClassifiedContent[] = [];
            const options: SummaryOptions = {
                enableDetailLevels: false,
                detailLevel: 'Full'
            } as any;

            await interactive.renderConversationContentWithStrategies(content, options);
            expect(DetailLevelStrategyFactory.createStrategy).not.toHaveBeenCalled();
        });
    });
});