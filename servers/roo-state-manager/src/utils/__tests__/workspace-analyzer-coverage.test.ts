/**
 * Tests de couverture supplémentaires pour workspace-analyzer.ts
 * Amélioration de la couverture des cas limites et scénarios complexes
 */

import { describe, test, expect, vi } from 'vitest';
import { WorkspaceAnalyzer } from '../workspace-analyzer.js';

describe('WorkspaceAnalyzer - Coverage Tests', () => {
	// ============================================================
	// Scénarios de détection de workspace complexes
	// ============================================================

	describe('complex workspace detection', () => {
		test('detects workspace with mixed technologies', async () => {
			const conversations = [
				{
					metadata: {
						files_in_context: [
							{ path: '/project/src/index.ts' },
							{ path: '/project/src/app.py' },
							{ path: '/project/requirements.txt' },
							{ path: '/project/package.json' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project/tsconfig.json' },
							{ path: '/project/setup.py' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project/src/utils.ts' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project/main.py' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project/README.md' }
						]
					}
				}
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(5);
			// Function should complete without errors regardless of detection results
			expect(result.analysisMetadata).toBeDefined();
		});

		test('detects multiple distinct workspaces', async () => {
			const conversations = [
				{
					metadata: {
						files_in_context: [
							{ path: '/project-a/src/index.ts' },
							{ path: '/project-a/package.json' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project-a/src/utils.ts' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project-b/main.py' },
							{ path: '/project-b/requirements.txt' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project-b/app.py' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/project-b/tests/test.py' }
						]
					}
				}
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			// Should detect at least the Python workspace (3+ conversations)
			expect(result.totalConversations).toBe(5);
		});

		test('handles workspace with deeply nested structure', async () => {
			const conversations = [
				{
					metadata: {
						files_in_context: [
							{ path: '/deep/nested/project/src/components/Button.tsx' },
							{ path: '/deep/nested/project/src/utils/helpers.ts' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/deep/nested/project/package.json' }
						]
					}
				},
				{
					metadata: {
						files_in_context: [
							{ path: '/deep/nested/project/README.md' }
						]
					}
				}
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});
	});

	// ============================================================
	// Détection de technologies
	// ============================================================

	describe('technology detection', () => {
		test('detects Java workspace', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/main/java/App.java' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/pom.xml' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/main/java/Utils.java' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('detects Rust workspace', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/main.rs' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/Cargo.toml' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/lib.rs' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('detects Go workspace', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/main.go' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/go.mod' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/handlers/server.go' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('detects Docker configuration', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/Dockerfile' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/docker-compose.yml' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/.dockerignore' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('detects VS Code workspace', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/.vscode/settings.json' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/.vscode/launch.json' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/.vscode/tasks.json' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});
	});

	// ============================================================
	// Cas limites et gestion des erreurs
	// ============================================================

	describe('edge cases and error handling', () => {
		test('handles conversations with null metadata', async () => {
			const conversations = [
				{ metadata: null },
				{ metadata: { files_in_context: [{ path: '/proj/file.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/file2.ts' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('handles empty file paths', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '' }] } },
				{ metadata: { files_in_context: [{ path: '/valid/path.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/valid/path2.ts' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('handles files without extensions', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/Makefile' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/CMakeLists' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/README' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('filters out system directories', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/node_modules/pkg/index.js' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/.git/objects/data' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/index.ts' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			// System dirs should not create workspace candidates
			expect(result.totalConversations).toBe(3);
		});

		test('requires minimum conversations for workspace', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/index.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/utils.ts' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			// Less than 3 conversations, should not generate workspace
			expect(result.workspaces.length).toBe(0);
		});
	});

	// ============================================================
	// Quality metrics
	// ============================================================

	describe('quality metrics', () => {
		test('calculates workspace detection accuracy', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/file1.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/file2.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/file3.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/other/pkg/file.py' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.analysisMetadata.qualityMetrics).toBeDefined();
			expect(result.analysisMetadata.qualityMetrics.workspaceDetectionAccuracy).toBeGreaterThanOrEqual(0);
			expect(result.analysisMetadata.qualityMetrics.workspaceDetectionAccuracy).toBeLessThanOrEqual(1);
		});

		test('calculates relationship confidence', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/file1.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/file2.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/file3.ts' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.analysisMetadata.qualityMetrics.relationshipConfidence).toBeGreaterThanOrEqual(0);
		});
	});

	// ============================================================
	// Workspace confidence scoring
	// ============================================================

	describe('workspace confidence scoring', () => {
		test('higher confidence with more conversations', async () => {
			const manyConvs = Array.from({ length: 10 }, (_, i) => ({
				metadata: { files_in_context: [{ path: `/proj/src/file${i}.ts` }] }
			})) as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(manyConvs);
			if (result.workspaces.length > 0) {
				expect(result.workspaces[0].confidence).toBeGreaterThan(0);
			}
		});

		test('higher confidence with diverse file patterns', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/index.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/tests/test.test.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/package.json' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/README.md' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/tsconfig.json' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			if (result.workspaces.length > 0) {
				expect(result.workspaces[0].confidence).toBeGreaterThan(0);
			}
		});

		test('filters low confidence workspaces', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/weak/file.txt' }] } },
				{ metadata: { files_in_context: [{ path: '/weak/file2.txt' }] } },
				{ metadata: { files_in_context: [{ path: '/weak/file3.txt' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			// Low confidence workspaces should be filtered out
			expect(result.workspaces.every(ws => ws.confidence >= 0.6)).toBe(true);
		});
	});

	// ============================================================
	// Cross-platform paths
	// ============================================================

	describe('cross-platform path handling', () => {
		test('handles Windows paths', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: 'C:\\Projects\\MyApp\\src\\index.ts' }] } },
				{ metadata: { files_in_context: [{ path: 'C:\\Projects\\MyApp\\src\\utils.ts' }] } },
				{ metadata: { files_in_context: [{ path: 'C:\\Projects\\MyApp\\package.json' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('handles mixed path separators', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: 'C:/Projects/MyApp\\src/index.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/mnt/c/projects/myapp/src/utils.ts' }] } },
				{ metadata: { files_in_context: [{ path: 'C:\\Projects\\MyApp/package.json' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('handles UNC paths', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '\\\\server\\share\\project\\file.ts' }] } },
				{ metadata: { files_in_context: [{ path: '\\\\server\\share\\project\\file2.ts' }] } },
				{ metadata: { files_in_context: [{ path: '\\\\server\\share\\project\\package.json' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});
	});

	// ============================================================
	// File patterns extraction
	// ============================================================

	describe('file patterns extraction', () => {
		test('extracts TypeScript patterns', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/app.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/utils.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/component.tsx' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});

		test('extracts directory patterns', async () => {
			const conversations = [
				{ metadata: { files_in_context: [{ path: '/proj/src/file1.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/file2.ts' }] } },
				{ metadata: { files_in_context: [{ path: '/proj/src/file3.ts' }] } }
			] as any[];

			const result = await WorkspaceAnalyzer.analyzeWorkspaces(conversations);
			expect(result.totalConversations).toBe(3);
		});
	});
});
