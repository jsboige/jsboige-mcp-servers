/**
 * Tests pour StateManager
 * Issue #492 - Couverture des services non testés
 *
 * @module services/__tests__/state-manager.service
 */

import { describe, test, expect } from 'vitest';
import { StateManager } from '../state-manager.service.js';
import { TraceSummaryService } from '../TraceSummaryService.js';
import { IndexingDecisionService } from '../indexing-decision.js';
import { XmlExporterService } from '../XmlExporterService.js';
import { ExportConfigManager } from '../ExportConfigManager.js';
import { SynthesisOrchestratorService } from '../synthesis/SynthesisOrchestratorService.js';

describe('StateManager', () => {
	// ============================================================
	// Constructor
	// ============================================================

	describe('constructor', () => {
		test('creates instance successfully', () => {
			const manager = new StateManager();
			expect(manager).toBeInstanceOf(StateManager);
		});

		test('initializes empty conversation cache', () => {
			const manager = new StateManager();
			expect(manager.getConversationCache()).toBeInstanceOf(Map);
			expect(manager.getConversationCache().size).toBe(0);
		});
	});

	// ============================================================
	// Getters
	// ============================================================

	describe('getters', () => {
		test('getState returns full state object', () => {
			const manager = new StateManager();
			const state = manager.getState();

			expect(state).toBeDefined();
			expect(state.conversationCache).toBeInstanceOf(Map);
			expect(state.xmlExporterService).toBeInstanceOf(XmlExporterService);
			expect(state.exportConfigManager).toBeInstanceOf(ExportConfigManager);
			expect(state.traceSummaryService).toBeInstanceOf(TraceSummaryService);
			expect(state.indexingDecisionService).toBeInstanceOf(IndexingDecisionService);
			expect(state.synthesisOrchestratorService).toBeInstanceOf(SynthesisOrchestratorService);
		});

		test('getConversationCache returns the cache map', () => {
			const manager = new StateManager();
			const cache = manager.getConversationCache();
			expect(cache).toBeInstanceOf(Map);
			// Verify it's the same instance
			expect(cache).toBe(manager.getState().conversationCache);
		});

		test('getTraceSummaryService returns TraceSummaryService', () => {
			const manager = new StateManager();
			expect(manager.getTraceSummaryService()).toBeInstanceOf(TraceSummaryService);
		});

		test('getIndexingDecisionService returns IndexingDecisionService', () => {
			const manager = new StateManager();
			expect(manager.getIndexingDecisionService()).toBeInstanceOf(IndexingDecisionService);
		});

		test('getXmlExporterService returns XmlExporterService', () => {
			const manager = new StateManager();
			expect(manager.getXmlExporterService()).toBeInstanceOf(XmlExporterService);
		});

		test('getExportConfigManager returns ExportConfigManager', () => {
			const manager = new StateManager();
			expect(manager.getExportConfigManager()).toBeInstanceOf(ExportConfigManager);
		});

		test('getSynthesisOrchestratorService returns SynthesisOrchestratorService', () => {
			const manager = new StateManager();
			expect(manager.getSynthesisOrchestratorService()).toBeInstanceOf(SynthesisOrchestratorService);
		});
	});

	// ============================================================
	// Initial state values
	// ============================================================

	describe('initial state', () => {
		test('indexing metrics start at zero', () => {
			const manager = new StateManager();
			const state = manager.getState();
			expect(state.indexingMetrics).toEqual({
				totalTasks: 0,
				skippedTasks: 0,
				indexedTasks: 0,
				failedTasks: 0,
				retryTasks: 0,
				bandwidthSaved: 0
			});
		});

		test('qdrant index queue is empty', () => {
			const manager = new StateManager();
			const state = manager.getState();
			expect(state.qdrantIndexQueue).toBeInstanceOf(Set);
			expect(state.qdrantIndexQueue.size).toBe(0);
		});

		test('qdrant indexing is enabled by default', () => {
			const manager = new StateManager();
			const state = manager.getState();
			expect(state.isQdrantIndexingEnabled).toBe(true);
		});

		test('qdrant index interval is null initially', () => {
			const manager = new StateManager();
			const state = manager.getState();
			expect(state.qdrantIndexInterval).toBeNull();
		});

		test('qdrant index cache is empty', () => {
			const manager = new StateManager();
			const state = manager.getState();
			expect(state.qdrantIndexCache).toBeInstanceOf(Map);
			expect(state.qdrantIndexCache.size).toBe(0);
		});

		test('last consistency check is 0', () => {
			const manager = new StateManager();
			const state = manager.getState();
			expect(state.lastQdrantConsistencyCheck).toBe(0);
		});
	});

	// ============================================================
	// State mutability (shared references)
	// ============================================================

	describe('state mutability', () => {
		test('cache is shared between getState and getConversationCache', () => {
			const manager = new StateManager();
			const cache = manager.getConversationCache();
			cache.set('test-id', { taskId: 'test-id' } as any);

			expect(manager.getState().conversationCache.has('test-id')).toBe(true);
			expect(manager.getConversationCache().get('test-id')).toEqual({ taskId: 'test-id' });
		});

		test('indexing metrics are mutable through state reference', () => {
			const manager = new StateManager();
			const state = manager.getState();
			state.indexingMetrics.totalTasks = 10;
			state.indexingMetrics.indexedTasks = 5;

			expect(manager.getState().indexingMetrics.totalTasks).toBe(10);
			expect(manager.getState().indexingMetrics.indexedTasks).toBe(5);
		});
	});
});
