/**
 * Rebuild Task Index — Recovered from destroyed vscode-global-state.ts (438L)
 *
 * Issue #814: Recovers the SQLite write-back functionality that was lost when
 * vscode-global-state.ts was deleted in commit fcd44db (2026-03-10).
 *
 * This module detects orphaned tasks (present on disk but missing from VS Code's
 * SQLite task index) and writes them back so they appear in Roo's task panel.
 *
 * Uses SQLite patterns from RooSettingsService but operates on taskHistory
 * within the Roo extension's global state blob.
 *
 * @module tools/maintenance/rebuild-task-index
 * @version 1.0.0
 * @since Recovery #814
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { existsSync, copyFileSync } from 'fs';
import sqlite3 from 'sqlite3';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('rebuild-task-index');

/**
 * The key VS Code uses to store Roo extension state in SQLite.
 * Must match the extension's actual key (case-sensitive in SQLite).
 */
const VSCDB_KEY = 'RooVeterinaryInc.roo-cline';

const VSCDB_RELATIVE_PATH = path.join('AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb');

interface HistoryItem {
	ts: number;
	task: string;
	workspace: string;
	id?: string;
}

interface VSCodeRooState {
	taskHistory?: HistoryItem[];
	[key: string]: unknown;
}

export interface RebuildTaskIndexArgs {
	workspace_filter?: string;
	max_tasks?: number;
	dry_run?: boolean;
}

// ── SQLite helpers (adapted from RooSettingsService patterns) ──

function getStateDbPath(): string {
	return path.join(os.homedir(), VSCDB_RELATIVE_PATH);
}

function openDatabase(filePath: string, mode: number): Promise<sqlite3.Database> {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(filePath, mode, (err) => {
			if (err) reject(new Error(`Cannot open state.vscdb: ${err.message}`));
			else resolve(db);
		});
	});
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
	return new Promise((resolve, reject) => {
		db.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function dbGet(db: sqlite3.Database, sql: string, params: unknown[]): Promise<{ value: string | Buffer } | undefined> {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err: Error | null, row: { value: string | Buffer } | undefined) => {
			if (err) reject(err);
			else resolve(row);
		});
	});
}

function dbRun(db: sqlite3.Database, sql: string, params: unknown[]): Promise<void> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, (err: Error | null) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

// ── State read/write (with temp copy for reads, backup for writes) ──

async function readRooState(): Promise<VSCodeRooState> {
	const dbPath = getStateDbPath();
	if (!existsSync(dbPath)) {
		throw new Error(`state.vscdb not found at: ${dbPath}`);
	}

	// Copy to temp to avoid locking conflicts with VS Code
	const tmpPath = dbPath + '.rebuild-tmp';
	try {
		copyFileSync(dbPath, tmpPath);
		const db = await openDatabase(tmpPath, sqlite3.OPEN_READONLY);
		try {
			const row = await dbGet(db, 'SELECT value FROM ItemTable WHERE key = ?', [VSCDB_KEY]);
			if (!row) {
				return {};
			}
			let value = typeof row.value === 'string' ? row.value : row.value.toString('utf-8');
			// Strip BOM if present
			if (value.charCodeAt(0) === 0xFEFF) {
				value = value.slice(1);
			}
			return JSON.parse(value);
		} finally {
			await closeDatabase(db);
		}
	} finally {
		try { await fs.unlink(tmpPath); } catch { /* ignore cleanup errors */ }
	}
}

async function writeRooState(state: VSCodeRooState): Promise<void> {
	const dbPath = getStateDbPath();

	// Create backup before writing
	const backupPath = dbPath + '.rebuild-backup';
	copyFileSync(dbPath, backupPath);
	logger.info(`Backup created: ${backupPath}`);

	const db = await openDatabase(dbPath, sqlite3.OPEN_READWRITE);
	try {
		const value = JSON.stringify(state);
		await dbRun(db, 'UPDATE ItemTable SET value = ? WHERE key = ?', [value, VSCDB_KEY]);
		logger.info('taskHistory written to state.vscdb');
	} finally {
		await closeDatabase(db);
	}
}

// ── Main handler ──

export async function handleRebuildTaskIndex(args: RebuildTaskIndexArgs): Promise<CallToolResult> {
	const { workspace_filter, max_tasks = 0, dry_run = true } = args;

	try {
		// 1. Read current VS Code state
		const state = await readRooState();
		const indexedTasks = new Set<string>();
		const currentHistory: HistoryItem[] = [];

		if (state.taskHistory && Array.isArray(state.taskHistory)) {
			currentHistory.push(...state.taskHistory);
			for (const item of state.taskHistory) {
				if (item.id) {
					indexedTasks.add(item.id);
				}
			}
		}

		// 2. Scan tasks on disk
		const tasksDir = path.join(
			os.homedir(), 'AppData', 'Roaming', 'Code', 'User',
			'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks'
		);

		let diskTasks: Array<{ id: string; workspace?: string; lastActivity: Date }> = [];

		try {
			const entries = await fs.readdir(tasksDir);
			for (const entry of entries) {
				const taskPath = path.join(tasksDir, entry);
				const stats = await fs.stat(taskPath);
				if (!stats.isDirectory() || entry === '.skeletons') continue;

				// Verify the directory has files (not empty)
				const files = await fs.readdir(taskPath);
				if (files.length === 0) continue;

				// Detect workspace
				let workspace: string | undefined;
				try {
					const { WorkspaceDetector } = await import('../../utils/workspace-detector.js');
					const detector = new WorkspaceDetector({
						enableCache: true,
						validateExistence: false,
						normalizePaths: true
					});
					const result = await detector.detect(taskPath);
					if (result.workspace) {
						workspace = result.workspace;
					}
				} catch {
					// Keep workspace undefined
				}

				diskTasks.push({
					id: entry,
					workspace,
					lastActivity: stats.mtime
				});
			}
		} catch (error) {
			return {
				content: [{
					type: 'text',
					text: `Error reading tasks directory: ${error}`
				}],
				isError: true
			};
		}

		// 3. Identify orphans
		let orphans = diskTasks.filter(t => !indexedTasks.has(t.id));

		if (workspace_filter) {
			orphans = orphans.filter(t =>
				t.workspace && t.workspace.toLowerCase().includes(workspace_filter.toLowerCase())
			);
		}

		if (max_tasks > 0) {
			orphans = orphans.slice(0, max_tasks);
		}

		// 4. Build report
		let report = `# Rebuild Task Index\n\n`;
		report += `**Mode:** ${dry_run ? 'SIMULATION (dry-run)' : 'LIVE REBUILD'}\n`;
		report += `**Tasks in SQLite index:** ${indexedTasks.size}\n`;
		report += `**Tasks on disk:** ${diskTasks.length}\n`;
		report += `**Orphaned tasks (total):** ${diskTasks.filter(t => !indexedTasks.has(t.id)).length}\n`;

		if (workspace_filter) {
			report += `**Workspace filter:** ${workspace_filter}\n`;
		}
		if (max_tasks > 0) {
			report += `**Max tasks limit:** ${max_tasks}\n`;
		}
		report += `**Tasks to process:** ${orphans.length}\n\n`;

		if (orphans.length === 0) {
			report += `No orphaned tasks found. Index is in sync with disk.\n`;
			return { content: [{ type: 'text', text: report }] };
		}

		// 5. Generate history items for orphans
		const newItems: HistoryItem[] = [];
		let addedCount = 0;
		let metadataCount = 0;
		let errorCount = 0;
		const errors: string[] = [];

		for (const orphan of orphans) {
			try {
				const taskPath = path.join(tasksDir, orphan.id);
				let title = orphan.id;

				// Try to generate rich metadata via RooStorageDetector
				try {
					const skeleton = await RooStorageDetector.analyzeConversation(orphan.id, taskPath);
					if (skeleton?.metadata?.title) {
						title = skeleton.metadata.title;
					}
					if (skeleton?.metadata?.workspace) {
						orphan.workspace = skeleton.metadata.workspace;
					}
					metadataCount++;
				} catch {
					// Fall back to basic title
				}

				// Normalize workspace path
				let normalizedWorkspace = orphan.workspace || 'unknown';
				if (normalizedWorkspace !== 'unknown') {
					normalizedWorkspace = normalizedWorkspace.replace(/\//g, '\\').replace(/\\+$/, '');
				}

				newItems.push({
					ts: orphan.lastActivity.getTime(),
					task: title,
					workspace: normalizedWorkspace,
					id: orphan.id
				});
				addedCount++;
			} catch (error) {
				errorCount++;
				errors.push(`${orphan.id}: ${error}`);
			}
		}

		// 6. Write back to SQLite (unless dry-run)
		if (!dry_run && newItems.length > 0) {
			const allTasks = [...currentHistory, ...newItems].sort((a, b) => b.ts - a.ts);
			const updatedState = { ...state, taskHistory: allTasks };
			await writeRooState(updatedState);

			report += `## Result: INDEX UPDATED\n\n`;
			report += `**Tasks added:** ${addedCount}\n`;
			report += `**Rich metadata generated:** ${metadataCount}\n`;
			report += `**Total after update:** ${allTasks.length}\n`;
			if (errorCount > 0) {
				report += `**Errors:** ${errorCount}\n`;
			}
			report += `\n**Next steps:**\n`;
			report += `1. Restart VS Code completely\n`;
			report += `2. Verify tasks appear in the Roo panel\n`;
			report += `3. Validate tasks are functional\n`;
		} else {
			report += `## Result: SIMULATION\n\n`;
			report += `**Tasks that would be added:** ${addedCount}\n`;
			report += `**Rich metadata available:** ${metadataCount}\n`;
			report += `**New total after rebuild:** ${currentHistory.length + addedCount}\n`;
			if (errorCount > 0) {
				report += `**Potential errors:** ${errorCount}\n`;
			}
			report += `\nRe-run with \`dry_run: false\` to apply changes.\n`;
		}

		// Sample of tasks
		if (newItems.length > 0) {
			report += `\n## Sample (first 5):\n\n`;
			for (const item of newItems.slice(0, 5)) {
				report += `- **${item.id}** — ${item.task}\n`;
				report += `  Workspace: ${item.workspace} | ${new Date(item.ts).toISOString()}\n`;
			}
		}

		// Errors detail
		if (errors.length > 0) {
			report += `\n## Errors:\n\n`;
			for (const err of errors.slice(0, 10)) {
				report += `- ${err}\n`;
			}
			if (errors.length > 10) {
				report += `... and ${errors.length - 10} more.\n`;
			}
		}

		return { content: [{ type: 'text', text: report }] };

	} catch (error) {
		return {
			content: [{
				type: 'text',
				text: `Error during task index rebuild: ${error instanceof Error ? error.message : String(error)}`
			}],
			isError: true
		};
	}
}
