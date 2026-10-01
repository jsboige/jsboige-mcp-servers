/**
 * #3661 (grain Tier 2 N×) — TTL du scan disque Claude dans list-conversations.
 *
 * CLAUDE_SCAN_CACHE_TTL est aligné sur DISK_SCAN_CACHE_TTL (5 min). À 60 s, la
 * sweep se rejouait par client MCP actif chaque minute sur les machines à
 * nombreux hôtes (chaque hôte = processus privé = cache privé). Ce test verrouille
 * le comportement TTL : un scan à froid, un hit de cache sous TTL, un re-scan
 * après expiration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn(() => '/Users/test')
}));

const { mockClaudeDetect } = vi.hoisted(() => ({
	// détecteur Claude : résolution immédiate, aucune location → scan vide et rapide
	mockClaudeDetect: vi.fn(() => Promise.resolve([]))
}));

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return {
		...actual,
		default: { ...actual, homedir: mockHomedir },
		homedir: mockHomedir
	};
});

vi.mock('fs/promises', async () => {
	const actual = await vi.importActual<typeof import('fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		access: vi.fn()
	};
});

// Les chemins de mock sont relatifs au fichier de TEST (#2642) : depuis __tests__/,
// les modules du SUT (résolus depuis src/tools/conversation/) sont un niveau plus profonds.
vi.mock('../../task/disk-scanner.js', () => ({
	scanDiskForNewTasks: vi.fn(() => Promise.resolve([])),
	evictGoneLocalTasks: vi.fn(async () => ({ evicted: [], skippedRemote: 0, failOpenRoo: true, failOpenClaude: true })),
}));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: mockClaudeDetect,
		analyzeConversation: vi.fn()
	}
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		detectStorageLocations: vi.fn(() => Promise.resolve([]))
	}
}));

vi.mock('../../../services/task-archiver/index.js', () => ({
	TaskArchiver: {
		listArchivedTaskFiles: vi.fn(() => Promise.resolve([])),
		readArchivedTaskFromPath: vi.fn(() => Promise.resolve(null)),
	},
}));

vi.mock('../../../services/skeleton-cache.service.js', () => ({
	SkeletonCacheService: {
		getInstance: vi.fn(() => ({
			getCache: vi.fn(() => Promise.resolve(new Map())),
			getCacheImmediate: vi.fn(() => new Map()),
			awaitFreshnessWithBudget: vi.fn(() => Promise.resolve(true)),
			getCacheAgeMs: vi.fn(() => 1234),
			isLoadInProgress: vi.fn(() => false),
			tier3KnowsMachine: vi.fn(() => true)
		}))
	}
}));

import { listConversationsTool } from '../list-conversations.tool.js';

describe('list-conversations — Claude scan TTL (#3661)', () => {
	const mockConversationCache = new Map();

	beforeEach(() => {
		vi.clearAllMocks();
		mockHomedir.mockReturnValue('/Users/test');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('cache le scan disque Claude 5 minutes — pas de re-scan sous TTL, re-scan après expiration', async () => {
		// Seul Date.now est mocké : le Promise.race 5 s du handler garde ses vrais
		// timers, et l'avance du temps se fait par setSystemTime.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			// t=0 — cache à froid : le scan disque part (détecteur appelé)
			await listConversationsTool.handler({ source: 'claude' }, mockConversationCache);
			expect(mockClaudeDetect).toHaveBeenCalledTimes(1);

			// t=+4 min — dans le TTL 5 min : hit de cache, AUCUN nouveau scan.
			// (Régression : à l'ancien TTL 60 s, cet appel re-scannait.)
			vi.setSystemTime(Date.now() + 4 * 60_000);
			await listConversationsTool.handler({ source: 'claude' }, mockConversationCache);
			expect(mockClaudeDetect).toHaveBeenCalledTimes(1);

			// t=+5 min 1 s (depuis le scan populateur) — TTL expiré : re-scan.
			vi.setSystemTime(Date.now() + 60_000 + 1_000);
			await listConversationsTool.handler({ source: 'claude' }, mockConversationCache);
			expect(mockClaudeDetect).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
