import { describe, it, expect, beforeEach } from 'vitest';
import { ServerCapabilities, getServerCapabilities } from '../server-capabilities.js';

describe('ServerCapabilities', () => {
	let caps: ServerCapabilities;

	beforeEach(() => {
		caps = new ServerCapabilities();
		caps.reset();
		// Also reset the singleton for clean tests
		getServerCapabilities().reset();
	});

	describe('basic state', () => {
		it('starts with no degraded capabilities', () => {
			expect(caps.isDegraded()).toBe(false);
			expect(caps.getAllDegraded()).toEqual([]);
			expect(caps.getReport()).toBe('All capabilities available');
		});

		it('isAvailable returns true when not degraded', () => {
			expect(caps.isAvailable('sharedPath')).toBe(true);
			expect(caps.isAvailable('qdrant')).toBe(true);
			expect(caps.isAvailable('embeddings')).toBe(true);
		});
	});

	describe('markDegraded', () => {
		it('marks a capability as degraded', () => {
			caps.markDegraded('sharedPath', 'ROOSYNC_SHARED_PATH missing');
			expect(caps.isAvailable('sharedPath')).toBe(false);
			expect(caps.isDegraded()).toBe(true);
		});

		it('stores the degradation reason', () => {
			caps.markDegraded('qdrant', 'QDRANT_URL absent');
			expect(caps.getDegradedReason('qdrant')).toBe('QDRANT_URL absent');
		});

		it('returns null reason for available capability', () => {
			expect(caps.getDegradedReason('sharedPath')).toBeNull();
		});

		it('supports multiple degraded capabilities', () => {
			caps.markDegraded('sharedPath', 'path missing');
			caps.markDegraded('qdrant', 'url missing');
			caps.markDegraded('embeddings', 'key missing');
			expect(caps.getAllDegraded()).toHaveLength(3);
			expect(caps.isDegraded()).toBe(true);
		});

		it('overwrites previous degradation for same capability', () => {
			caps.markDegraded('sharedPath', 'reason A');
			caps.markDegraded('sharedPath', 'reason B');
			expect(caps.getAllDegraded()).toHaveLength(1);
			expect(caps.getDegradedReason('sharedPath')).toBe('reason B');
		});
	});

	describe('getReport', () => {
		it('reports degraded capabilities', () => {
			caps.markDegraded('sharedPath', 'ROOSYNC_SHARED_PATH VIDE');
			const report = caps.getReport();
			expect(report).toContain('Degraded capabilities (1)');
			expect(report).toContain('sharedPath');
			expect(report).toContain('ROOSYNC_SHARED_PATH VIDE');
		});

		it('reports all capabilities when none degraded', () => {
			expect(caps.getReport()).toBe('All capabilities available');
		});
	});

	describe('reset', () => {
		it('clears all degraded capabilities', () => {
			caps.markDegraded('sharedPath', 'test');
			caps.markDegraded('qdrant', 'test');
			caps.reset();
			expect(caps.isDegraded()).toBe(false);
			expect(caps.getAllDegraded()).toEqual([]);
		});
	});

	describe('singleton', () => {
		it('getServerCapabilities returns same instance', () => {
			const a = getServerCapabilities();
			const b = getServerCapabilities();
			expect(a).toBe(b);
		});
	});
});
