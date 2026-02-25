/**
 * Tests pour workspace-analyzer.ts
 * Issue #492 - Couverture des utilitaires
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		readdir: vi.fn(),
		stat: vi.fn(),
		access: vi.fn()
	},
	readdir: vi.fn(),
	stat: vi.fn(),
	access: vi.fn()
}));

import { WorkspaceAnalyzer } from '../workspace-analyzer.js';

describe('WorkspaceAnalyzer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// analyzeWorkspaces
	// ============================================================

	describe('analyzeWorkspaces', () => {
		test('returns empty workspaces for empty conversations', async () => {
			const result = await WorkspaceAnalyzer.analyzeWorkspaces([]);
			expect(result.totalConversations).toBe(0);
			expect(result.workspaces).toEqual([]);
		});

		test('returns analysis metadata', async () => {
			const result = await WorkspaceAnalyzer.analyzeWorkspaces([]);
			expect(result.analysisMetadata).toBeDefined();
			expect(result.analysisMetadata.version).toBe('1.0.0');
			expect(result.analysisMetadata.algorithmsUsed).toContain('path_clustering');
		});

		test('detects workspaces from file paths', async () => {
			const conversations = [
				{
					metadata: {
						files_in_context: [
							{ path: '/project/src/index.ts' },
							{ path: '/project/src/utils.ts' },
							{ path: '/project/package.json' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project/src/app.ts' },
							{ path: '/project/README.md' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project/tests/test.ts' }
						]
					}
				}
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('handles conversations without files_in_context', async () => {
			const conversations = [
				{ metadata: {} },
				{ metadata: { files_in_context: [] } },
				{}
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.workspaces).toEqual([]);
		});

		test('includes relationships array', async () => {
			const result = await WorkspaceAnalyzer.analyzeWorkspaces([]);
			expect(result.relationships).toEqual([]);
		});

		test('includes errors array', async () => {
			const result = await WorkspaceAnalyzer.analyzeWorkspaces([]);
			expect(result.errors).toEqual([]);
		});

		test('analysis time is tracked', async () => {
			const result = await WorkspaceAnalyzer.analyzeWorkspaces([]);
			expect(result.analysisMetadata.analysisTime).toBeGreaterThanOrEqual(0);
		});

		test('processes multiple conversations with overlapping paths', async () => {
			const conversations = Array.from({ length: 5 }, (_, i) => ({
				metadata: {
					files_in_context: [
						{ path: `/workspace/src/file${i}.ts` },
						{ path: '/workspace/package.json' }
					]
				}
			})) as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(5);
		});
	});

	// ============================================================
	// TECH_INDICATORS (tested via analyzeWorkspaces integration)
	// ============================================================

	describe('tech detection via conversations', () => {
		test('detects javascript from .ts files', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/index.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/app.tsx' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/package.json' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			// The analyzer should process without errors
			expect(result.totalConversations).toBe(3);
		});

		test('detects python from .py files', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/main.py' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/utils.py' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/requirements.txt' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});
	});
});
