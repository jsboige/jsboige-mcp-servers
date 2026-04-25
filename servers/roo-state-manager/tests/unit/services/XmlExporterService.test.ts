import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XmlExporterService } from '../../../src/services/XmlExporterService.js';
import { ConversationSkeleton, MessageSkeleton, ActionSkeleton } from '../../../src/types/conversation.js';
import { promises as fs } from 'fs';
import { join } from 'path';

function makeSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
	return {
		taskId: 'task-001',
		parentTaskId: undefined,
		metadata: {
			title: 'Test Task',
			lastActivity: '2026-04-25T10:00:00Z',
			createdAt: '2026-04-25T09:00:00Z',
			mode: 'code',
			messageCount: 2,
			actionCount: 1,
			totalSize: 1024,
		},
		sequence: [],
		...overrides,
	};
}

function makeMessage(content = 'Hello world', role: 'user' | 'assistant' = 'user'): MessageSkeleton {
	return {
		role,
		content,
		timestamp: '2026-04-25T10:01:00Z',
		isTruncated: false,
	};
}

function makeAction(overrides: Partial<ActionSkeleton> = {}): ActionSkeleton {
	return {
		type: 'tool_use',
		name: 'read_file',
		status: 'completed',
		timestamp: '2026-04-25T10:02:00Z',
		parameters: { path: '/some/file.ts' },
		...overrides,
	};
}

describe('XmlExporterService', () => {
	let service: XmlExporterService;

	beforeEach(() => {
		service = new XmlExporterService();
	});

	describe('generateTaskXml', () => {
		it('should generate XML with basic skeleton', () => {
			const skeleton = makeSkeleton();
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('taskId="task-001"');
			expect(xml).toContain('<title>Test Task</title>');
			expect(xml).toContain('<messageCount>2</messageCount>');
			expect(xml).toContain('<actionCount>1</actionCount>');
			expect(xml).toContain('<totalSize>1024</totalSize>');
		});

		it('should include parentTaskId when present', () => {
			const skeleton = makeSkeleton({ parentTaskId: 'parent-001' });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('parentTaskId="parent-001"');
		});

		it('should omit parentTaskId when absent', () => {
			const skeleton = makeSkeleton({ parentTaskId: undefined });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).not.toContain('parentTaskId');
		});

		it('should include mode when present', () => {
			const skeleton = makeSkeleton();
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('<mode>code</mode>');
		});

		it('should omit title when absent', () => {
			const skeleton = makeSkeleton({
				metadata: {
					title: '',
					lastActivity: '2026-04-25T10:00:00Z',
					createdAt: '2026-04-25T09:00:00Z',
					mode: 'code',
					messageCount: 0,
					actionCount: 0,
					totalSize: 0,
				},
			});
			const xml = service.generateTaskXml(skeleton);

			expect(xml).not.toContain('<title>');
		});

		it('should include message in sequence', () => {
			const msg = makeMessage('Test message content', 'assistant');
			const skeleton = makeSkeleton({ sequence: [msg] });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('role="assistant"');
			expect(xml).toContain('Test message content');
		});

		it('should truncate long content when includeContent is false', () => {
			const longContent = 'A'.repeat(200);
			const msg = makeMessage(longContent);
			const skeleton = makeSkeleton({ sequence: [msg] });
			const xml = service.generateTaskXml(skeleton, { includeContent: false });

			expect(xml).toContain('...');
			expect(xml).not.toContain(longContent);
		});

		it('should include full content when includeContent is true', () => {
			const longContent = 'A'.repeat(200);
			const msg = makeMessage(longContent);
			const skeleton = makeSkeleton({ sequence: [msg] });
			const xml = service.generateTaskXml(skeleton, { includeContent: true });

			expect(xml).toContain(longContent);
		});

		it('should include action with parameters', () => {
			const action = makeAction({ parameters: { path: '/test.ts', line: 42 } });
			const skeleton = makeSkeleton({ sequence: [action] });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('type="tool_use"');
			expect(xml).toContain('name="read_file"');
			expect(xml).toContain('status="completed"');
			expect(xml).toContain('path');
		});

		it('should include action without parameters when empty', () => {
			const action = makeAction({ parameters: {} });
			const skeleton = makeSkeleton({ sequence: [action] });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).not.toContain('<parameters>');
		});

		it('should include action file_path and line_count', () => {
			const action = makeAction({ file_path: '/src/file.ts', line_count: 50 });
			const skeleton = makeSkeleton({ sequence: [action] });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('filePath="/src/file.ts"');
			expect(xml).toContain('lineCount="50"');
		});

		it('should include content_size when present', () => {
			const action = makeAction({ content_size: 2048 });
			const skeleton = makeSkeleton({ sequence: [action] });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('contentSize="2048"');
		});

		it('should include isTruncated flag on messages', () => {
			const msg: MessageSkeleton = {
				role: 'assistant',
				content: 'truncated msg',
				timestamp: '2026-04-25T10:01:00Z',
				isTruncated: true,
			};
			const skeleton = makeSkeleton({ sequence: [msg] });
			const xml = service.generateTaskXml(skeleton);

			expect(xml).toContain('isTruncated="true"');
		});

		it('should respect prettyPrint option', () => {
			const skeleton = makeSkeleton();
			const xmlPretty = service.generateTaskXml(skeleton, { prettyPrint: true });
			const xmlCompact = service.generateTaskXml(skeleton, { prettyPrint: false });

			// Pretty printed should have newlines, compact should not
			const prettyLines = xmlPretty.split('\n').length;
			const compactLines = xmlCompact.split('\n').length;
			expect(prettyLines).toBeGreaterThan(compactLines);
		});
	});

	describe('generateConversationXml', () => {
		it('should generate conversation XML with root and children', () => {
			const root = makeSkeleton({ taskId: 'root-001' });
			const child = makeSkeleton({ taskId: 'child-001', parentTaskId: 'root-001' });
			const xml = service.generateConversationXml(root, [child]);

			expect(xml).toContain('conversationId="root-001"');
			expect(xml).toContain('taskId="root-001"');
			expect(xml).toContain('taskId="child-001"');
			expect(xml).toContain('exportTimestamp');
		});

		it('should respect maxDepth option', () => {
			const root = makeSkeleton({ taskId: 'root-001' });
			const child = makeSkeleton({ taskId: 'child-001', parentTaskId: 'root-001' });
			const grandchild = makeSkeleton({ taskId: 'gc-001', parentTaskId: 'child-001' });
			const xml = service.generateConversationXml(root, [child, grandchild], { maxDepth: 2 });

			expect(xml).toContain('taskId="root-001"');
			expect(xml).toContain('taskId="child-001"');
			expect(xml).not.toContain('taskId="gc-001"');
		});

		it('should include children section only when children exist', () => {
			const root = makeSkeleton({ taskId: 'root-001' });
			const child = makeSkeleton({ taskId: 'child-001', parentTaskId: 'root-001' });
			const xml = service.generateConversationXml(root, [child]);

			expect(xml).toContain('<children>');
		});

		it('should handle empty children array', () => {
			const root = makeSkeleton({ taskId: 'root-001' });
			const xml = service.generateConversationXml(root, []);

			expect(xml).toContain('taskId="root-001"');
			expect(xml).not.toContain('<children>');
		});

		it('should include message content with includeContent option', () => {
			const msg = makeMessage('Full content here', 'assistant');
			const root = makeSkeleton({ taskId: 'root-001', sequence: [msg] });
			const xml = service.generateConversationXml(root, [], { includeContent: true });

			expect(xml).toContain('Full content here');
		});
	});

	describe('generateProjectXml', () => {
		it('should generate project XML with summary and conversations', () => {
			const skeletons = [
				makeSkeleton({ taskId: 'task-001' }),
				makeSkeleton({ taskId: 'task-002', parentTaskId: 'task-001' }),
			];
			const xml = service.generateProjectXml(skeletons, '/project/path');

			expect(xml).toContain('<projectExport>');
			expect(xml).toContain('/project/path');
			expect(xml).toContain('<conversationCount>1</conversationCount>');
			expect(xml).toContain('<totalTasks>2</totalTasks>');
		});

		it('should filter by startDate', () => {
			const old = makeSkeleton({
				taskId: 'old-001',
				metadata: {
					title: 'Old',
					lastActivity: '2026-01-01T00:00:00Z',
					createdAt: '2026-01-01T00:00:00Z',
					mode: 'code',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const recent = makeSkeleton({
				taskId: 'recent-001',
				metadata: {
					title: 'Recent',
					lastActivity: '2026-04-25T00:00:00Z',
					createdAt: '2026-04-25T00:00:00Z',
					mode: 'code',
					messageCount: 1,
					actionCount: 0,
					totalSize: 200,
				},
			});

			const xml = service.generateProjectXml([old, recent], '/project', {
				startDate: '2026-04-01',
			});

			expect(xml).toContain('rootTaskId="recent-001"');
			expect(xml).not.toContain('rootTaskId="old-001"');
		});

		it('should filter by endDate', () => {
			const old = makeSkeleton({
				taskId: 'old-001',
				metadata: {
					title: 'Old',
					lastActivity: '2026-01-15T00:00:00Z',
					createdAt: '2026-01-15T00:00:00Z',
					mode: 'code',
					messageCount: 1,
					actionCount: 0,
					totalSize: 100,
				},
			});
			const recent = makeSkeleton({
				taskId: 'recent-001',
				metadata: {
					title: 'Recent',
					lastActivity: '2026-04-25T00:00:00Z',
					createdAt: '2026-04-25T00:00:00Z',
					mode: 'code',
					messageCount: 1,
					actionCount: 0,
					totalSize: 200,
				},
			});

			const xml = service.generateProjectXml([old, recent], '/project', {
				endDate: '2026-02-01',
			});

			expect(xml).toContain('rootTaskId="old-001"');
			expect(xml).not.toContain('rootTaskId="recent-001"');
		});

		it('should calculate totalSize correctly', () => {
			const skeletons = [
				makeSkeleton({
					taskId: 't1',
					metadata: {
						title: 'T1',
						lastActivity: '2026-04-25T00:00:00Z',
						createdAt: '2026-04-25T00:00:00Z',
						mode: 'code',
						messageCount: 1,
						actionCount: 0,
						totalSize: 500,
					},
				}),
				makeSkeleton({
					taskId: 't2',
					parentTaskId: 't1',
					metadata: {
						title: 'T2',
						lastActivity: '2026-04-25T00:00:00Z',
						createdAt: '2026-04-25T00:00:00Z',
						mode: 'code',
						messageCount: 1,
						actionCount: 0,
						totalSize: 300,
					},
				}),
			];

			const xml = service.generateProjectXml(skeletons, '/project');

			expect(xml).toContain('<totalSize>800</totalSize>');
		});

		it('should count child tasks per conversation', () => {
			const skeletons = [
				makeSkeleton({ taskId: 'root-001' }),
				makeSkeleton({ taskId: 'child-001', parentTaskId: 'root-001' }),
				makeSkeleton({ taskId: 'child-002', parentTaskId: 'root-001' }),
			];

			const xml = service.generateProjectXml(skeletons, '/project');

			expect(xml).toContain('taskCount="3"');
		});

		it('should handle empty skeletons array', () => {
			const xml = service.generateProjectXml([], '/empty/project');

			expect(xml).toContain('<conversationCount>0</conversationCount>');
			expect(xml).toContain('<totalTasks>0</totalTasks>');
		});

		it('should include dateRange in summary', () => {
			const skeletons = [makeSkeleton()];
			const xml = service.generateProjectXml(skeletons, '/project');

			expect(xml).toContain('start=');
			expect(xml).toContain('end=');
		});
	});

	describe('saveXmlToFile', () => {
		let tmpDir: string;
		let origCwd: string;

		beforeEach(async () => {
			origCwd = process.cwd();
			tmpDir = join(origCwd, 'test-xml-export-' + Date.now());
			await fs.mkdir(tmpDir, { recursive: true });
			process.chdir(tmpDir);
		});

		afterEach(async () => {
			process.chdir(origCwd);
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		});

		it('should save XML to a file', async () => {
			const filePath = 'output.xml';
			await service.saveXmlToFile('<root>test</root>', filePath);

			const content = await fs.readFile(join(tmpDir, filePath), 'utf-8');
			expect(content).toBe('<root>test</root>');
		});

		it('should create parent directories', async () => {
			const filePath = join('sub', 'dir', 'output.xml');
			await service.saveXmlToFile('<root>test</root>', filePath);

			const content = await fs.readFile(join(tmpDir, filePath), 'utf-8');
			expect(content).toBe('<root>test</root>');
		});

		it('should reject directory traversal paths', async () => {
			await expect(
				service.saveXmlToFile('test', '../../../etc/passwd')
			).rejects.toThrow('Unsafe file path');
		});

		it('should reject absolute paths', async () => {
			await expect(
				service.saveXmlToFile('test', '/absolute/path/file.xml')
			).rejects.toThrow('Unsafe file path');
		});

		it('should reject paths that are too long', async () => {
			const longPath = 'a'.repeat(261) + '.xml';
			await expect(
				service.saveXmlToFile('test', longPath)
			).rejects.toThrow('File path too long');
		});

		it('should reject paths with Windows forbidden characters', async () => {
			await expect(
				service.saveXmlToFile('test', 'file<name>.xml')
			).rejects.toThrow('Unsafe file path');
		});
	});
});
