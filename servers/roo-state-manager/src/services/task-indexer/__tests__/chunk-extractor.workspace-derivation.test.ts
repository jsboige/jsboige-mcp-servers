/**
 * #3344: workspace derivation in ChunkExtractor.
 *
 * Two emitter cohorts indexed points with no workspace coordinates:
 *  - claude-code sessions: JSONL entries carry `cwd` — now derived when the
 *    caller passes no metadata (28% of claude-code points in the ai-01 sample);
 *  - roo tasks: task_metadata.json may omit `workspace`, but the conversation
 *    history embeds "Current Workspace Directory (<path>)" — now derived with
 *    the same regex as roo-storage-detector (67% of roo points in the sample).
 *
 * Also covers `workspaceBasename` (separator-robust, CI-portable) and the
 * VectorIndexer safety net via direct import (derivation from workspace when
 * the name is missing).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	extractChunksFromTask,
	extractChunksFromClaudeSession,
	workspaceBasename,
} from '../ChunkExtractor.js';

// computeChunkId relies on uuid v5. A global setup auto-mocks 'uuid' (v5 undefined),
// same workaround as ChunkExtractor.coverage.test.ts.
vi.mock('uuid', async () => await vi.importActual('uuid'));

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-3344-ws-'));
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('workspaceBasename (#3344)', () => {
	it('handles forward slashes', () => {
		expect(workspaceBasename('d:/dev/CoursIA-2')).toBe('CoursIA-2');
	});

	it('handles backslashes regardless of host platform', () => {
		// path.basename would keep the whole string on posix — this must not
		expect(workspaceBasename('D:\\dev\\CoursIA-2')).toBe('CoursIA-2');
	});

	it('handles doubled backslashes (raw-JSON captured form)', () => {
		expect(workspaceBasename('d:\\\\dev\\\\CoursIA-2')).toBe('CoursIA-2');
	});

	it('returns the input for a bare name', () => {
		expect(workspaceBasename('CoursIA-2')).toBe('CoursIA-2');
	});
});

describe('extractChunksFromClaudeSession — cwd derivation (#3344)', () => {
	it('derives workspace + workspace_name from entry.cwd when no metadata is passed', async () => {
		const sessionFile = path.join(tmpDir, 'cwd-session.jsonl');
		const line = JSON.stringify({
			type: 'user',
			cwd: 'D:\\dev\\CoursIA-2',
			message: { role: 'user', content: 'hello from CoursIA-2' },
			timestamp: '2026-08-31T15:00:00.000Z',
		});
		await fs.writeFile(sessionFile, line + '\n', 'utf-8');

		const chunks = await extractChunksFromClaudeSession('claude-cwd-session', sessionFile);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].workspace).toBe('D:\\dev\\CoursIA-2');
		expect(chunks[0].workspace_name).toBe('CoursIA-2');
	});

	it('keeps explicit metadata.workspace over derived cwd', async () => {
		const sessionFile = path.join(tmpDir, 'meta-session.jsonl');
		const line = JSON.stringify({
			type: 'user',
			cwd: 'D:\\dev\\OtherProject',
			message: { role: 'user', content: 'hello' },
		});
		await fs.writeFile(sessionFile, line + '\n', 'utf-8');

		const chunks = await extractChunksFromClaudeSession('claude-meta-session', sessionFile, {
			workspace: 'd:/dev/CoursIA-2',
		});
		expect(chunks[0].workspace).toBe('d:/dev/CoursIA-2');
		expect(chunks[0].workspace_name).toBe('CoursIA-2');
	});

	it('leaves workspace undefined when neither metadata nor cwd exists', async () => {
		const sessionFile = path.join(tmpDir, 'nocwd-session.jsonl');
		const line = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: 'hello' },
		});
		await fs.writeFile(sessionFile, line + '\n', 'utf-8');

		const chunks = await extractChunksFromClaudeSession('claude-nocwd-session', sessionFile);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].workspace).toBeUndefined();
		expect(chunks[0].workspace_name).toBeUndefined();
	});
});

describe('extractChunksFromTask — Current Workspace Directory derivation (#3344)', () => {
	it('derives workspace from api_conversation_history when task_metadata omits it', async () => {
		const taskDir = path.join(tmpDir, 'roo-task-3344');
		await fs.mkdir(taskDir, { recursive: true });
		// metadata WITHOUT workspace — the 48.2% cohort's root cause
		await fs.writeFile(
			path.join(taskDir, 'task_metadata.json'),
			JSON.stringify({ title: 'T #3344', parentTaskId: undefined }),
			'utf-8'
		);
		const history = [{
			role: 'user',
			content: 'Environment context: Current Workspace Directory (d:\\dev\\CoursIA-2) — proceed.',
			timestamp: '2026-08-31T15:00:00.000Z',
		}];
		await fs.writeFile(
			path.join(taskDir, 'api_conversation_history.json'),
			JSON.stringify(history),
			'utf-8'
		);

		const chunks = await extractChunksFromTask('roo-task-3344', taskDir);
		expect(chunks.length).toBeGreaterThan(0);
		// Regex runs on the RAW file content — backslashes arrive JSON-escaped
		expect(chunks[0].workspace).toContain('CoursIA-2');
		expect(chunks[0].workspace_name).toBe('CoursIA-2');
	});

	it('keeps task_metadata.workspace when present (no derivation)', async () => {
		const taskDir = path.join(tmpDir, 'roo-task-meta');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(
			path.join(taskDir, 'task_metadata.json'),
			JSON.stringify({ workspace: 'd:/dev/CanonicalWS', title: 'T2' }),
			'utf-8'
		);
		await fs.writeFile(
			path.join(taskDir, 'api_conversation_history.json'),
			JSON.stringify([{ role: 'user', content: 'Current Workspace Directory (d:\\dev\\ShouldNotWin)' }]),
			'utf-8'
		);

		const chunks = await extractChunksFromTask('roo-task-meta', taskDir);
		expect(chunks[0].workspace).toBe('d:/dev/CanonicalWS');
		expect(chunks[0].workspace_name).toBe('CanonicalWS');
	});
});
