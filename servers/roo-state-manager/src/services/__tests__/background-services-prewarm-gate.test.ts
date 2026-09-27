/**
 * #3661 (grain Tier 2 N×) — porte prewarm sur la sweep Claude au démarrage.
 *
 * `loadClaudeCodeSessions` (sweep startup : readdir de chaque projet Claude +
 * lecture de chaque .jsonl) est lancé dans la chaîne fire-and-forget de
 * `initializeBackgroundServices`, AVANT et HORS de l'élection Worker A de #1163 :
 * chaque hôte MCP le paie. Ce test verrouille la porte livrée avec #3661 :
 * quand le prewarm est désactivé (`ROO_AUTO_DISABLE_PREWARM=1` ou
 * `SKELETON_PREWARM=false`), la sweep eager est sautée — la visibilité Tier 2
 * reste assurée par les lectures lazy (#1752) et scanClaudeSessions (TTL 5 min).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { mockClaudeDetect } = vi.hoisted(() => ({
	mockClaudeDetect: vi.fn(() => Promise.resolve([]))
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		promises: {
			readdir: vi.fn(),
			readFile: vi.fn(),
			writeFile: vi.fn(),
			stat: vi.fn(),
			access: vi.fn(),
			mkdir: vi.fn(),
		},
	};
});

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: vi.fn(),
		analyzeConversation: vi.fn(),
	},
}));

vi.mock('../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: mockClaudeDetect,
		analyzeConversation: vi.fn(),
	},
}));

vi.mock('../../tools/index.js', () => ({}));

vi.mock('../task-archiver/index.js', () => ({
	TaskArchiver: {
		archiveTask: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock('../task-indexer.js', () => {
	const indexTaskSpy = vi.fn().mockResolvedValue([]);
	const countPointsByHostOsSpy = vi.fn().mockResolvedValue(0);
	class MockTaskIndexer {
		async indexTask(taskId: string, source: 'roo' | 'claude-code') {
			return indexTaskSpy(taskId, source);
		}
		async countPointsByHostOs(hostOs: string) {
			return countPointsByHostOsSpy(hostOs);
		}
	}
	(MockTaskIndexer as any).indexTaskSpy = indexTaskSpy;
	(MockTaskIndexer as any).countPointsByHostOsSpy = countPointsByHostOsSpy;
	return {
		TaskIndexer: MockTaskIndexer,
		getHostIdentifier: vi.fn().mockReturnValue('test-host'),
	};
});

vi.mock('../unified-store/writer-factory.js', () => {
	const upsertConversationOnly = vi.fn().mockResolvedValue(undefined);
	return {
		getUnifiedStoreWriter: () => ({
			upsertConversationOnly,
			upsertMessages: vi.fn().mockResolvedValue(undefined),
			ping: vi.fn().mockResolvedValue(true),
		}),
		resetWriterInstance: vi.fn(),
	};
});

import { initializeBackgroundServices } from '../background-services.js';
import type { ServerState } from '../state-manager.service.js';

function createMockState(): ServerState {
	return {
		conversationCache: new Map(),
		qdrantIndexQueue: new Set(),
		qdrantIndexInterval: null,
		isQdrantIndexingEnabled: true,
		qdrantIndexCache: new Map(),
		lastQdrantConsistencyCheck: 0,
		indexingDecisionService: {
			shouldIndex: vi.fn().mockReturnValue({ shouldIndex: false, reason: 'skip', action: 'skip', requiresSave: false }),
			migrateLegacyIndexingState: vi.fn().mockReturnValue(false),
			markIndexingSuccess: vi.fn(),
			markIndexingFailure: vi.fn(),
		},
		indexingMetrics: {
			totalTasks: 0,
			skippedTasks: 0,
			indexedTasks: 0,
			failedTasks: 0,
			retryTasks: 0,
			bandwidthSaved: 0,
			lastIndexedAt: undefined,
		},
		xmlExporterService: {} as any,
		exportConfigManager: {} as any,
		traceSummaryService: {} as any,
		llmService: {} as any,
		narrativeContextBuilderService: {} as any,
		synthesisOrchestratorService: {} as any,
	} as unknown as ServerState;
}

const ENV_KEYS = ['ROO_AUTO_DISABLE_PREWARM', 'SKELETON_PREWARM', 'SKELETON_CLAUDE_TIER', 'SKELETON_ARCHIVE_TIER'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of ENV_KEYS) {
		if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** Laisse la chaîne fire-and-forget (loadSkeletonsFromDisk → gate → sweep) se jouer. */
async function settleBackgroundChain(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 150));
}

describe('initializeBackgroundServices — porte prewarm sur la sweep Claude (#3661)', () => {
	it('ROO_AUTO_DISABLE_PREWARM=1 → la sweep eager loadClaudeCodeSessions est SAUTÉE', async () => {
		process.env.ROO_AUTO_DISABLE_PREWARM = '1';
		const state = createMockState();

		await initializeBackgroundServices(state);
		await settleBackgroundChain();

		expect(mockClaudeDetect).not.toHaveBeenCalled();
	});

	it('SKELETON_PREWARM=false (kill-switch explicite) → sweep SAUTÉE aussi', async () => {
		process.env.SKELETON_PREWARM = 'false';
		const state = createMockState();

		await initializeBackgroundServices(state);
		await settleBackgroundChain();

		expect(mockClaudeDetect).not.toHaveBeenCalled();
	});

	it('prewarm ON (défaut) → la sweep eager tourne (détecteur Claude appelé)', async () => {
		const state = createMockState();

		await initializeBackgroundServices(state);
		await settleBackgroundChain();

		expect(mockClaudeDetect).toHaveBeenCalled();
	});
});
