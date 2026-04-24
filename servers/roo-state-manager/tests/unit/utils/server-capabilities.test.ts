import { describe, it, expect, beforeEach } from 'vitest';
import {
  ServerCapabilities,
  getServerCapabilities,
} from '../../../src/utils/server-capabilities';
import type { Capability } from '../../../src/utils/server-capabilities';

describe('ServerCapabilities', () => {
  let instance: ServerCapabilities;

  beforeEach(() => {
    // Reset singleton between tests
    ServerCapabilities.instance = null;
    instance = getServerCapabilities();
  });

  // --- Singleton ---

  describe('getInstance', () => {
    it('returns a ServerCapabilities instance', () => {
      expect(instance).toBeInstanceOf(ServerCapabilities);
    });

    it('returns the same instance on repeated calls', () => {
      const a = ServerCapabilities.getInstance();
      const b = ServerCapabilities.getInstance();
      expect(a).toBe(b);
    });
  });

  // --- Initial state ---

  describe('initial state', () => {
    it('has no degraded capabilities', () => {
      expect(instance.isDegraded()).toBe(false);
      expect(instance.getAllDegraded()).toEqual([]);
    });

    it('all capabilities are available', () => {
      const capabilities: Capability[] = ['sharedPath', 'qdrant', 'embeddings'];
      for (const cap of capabilities) {
        expect(instance.isAvailable(cap)).toBe(true);
      }
    });

    it('getDegradedReason returns null for all capabilities', () => {
      const capabilities: Capability[] = ['sharedPath', 'qdrant', 'embeddings'];
      for (const cap of capabilities) {
        expect(instance.getDegradedReason(cap)).toBeNull();
      }
    });

    it('getReport says all capabilities available', () => {
      expect(instance.getReport()).toBe('All capabilities available');
    });
  });

  // --- markDegraded ---

  describe('markDegraded', () => {
    it('marks a capability as degraded', () => {
      instance.markDegraded('qdrant', 'Connection refused');
      expect(instance.isDegraded()).toBe(true);
      expect(instance.isAvailable('qdrant')).toBe(false);
    });

    it('stores the reason', () => {
      instance.markDegraded('embeddings', 'API key missing');
      expect(instance.getDegradedReason('embeddings')).toBe('API key missing');
    });

    it('sets a valid since date', () => {
      const before = new Date();
      instance.markDegraded('sharedPath', 'Not found');
      const entry = instance.getAllDegraded()[0];
      expect(entry.since.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('overwrites previous degradation for same capability', () => {
      instance.markDegraded('qdrant', 'First reason');
      instance.markDegraded('qdrant', 'Second reason');
      expect(instance.getAllDegraded()).toHaveLength(1);
      expect(instance.getDegradedReason('qdrant')).toBe('Second reason');
    });

    it('can degrade multiple capabilities independently', () => {
      instance.markDegraded('sharedPath', 'A');
      instance.markDegraded('qdrant', 'B');
      instance.markDegraded('embeddings', 'C');
      expect(instance.getAllDegraded()).toHaveLength(3);
      expect(instance.isAvailable('sharedPath')).toBe(false);
      expect(instance.isAvailable('qdrant')).toBe(false);
      expect(instance.isAvailable('embeddings')).toBe(false);
    });
  });

  // --- isAvailable ---

  describe('isAvailable', () => {
    it('returns true when capability is not degraded', () => {
      expect(instance.isAvailable('sharedPath')).toBe(true);
    });

    it('returns false when capability is degraded', () => {
      instance.markDegraded('sharedPath', 'Missing');
      expect(instance.isAvailable('sharedPath')).toBe(false);
    });
  });

  // --- getDegradedReason ---

  describe('getDegradedReason', () => {
    it('returns null for available capability', () => {
      expect(instance.getDegradedReason('qdrant')).toBeNull();
    });

    it('returns the reason string for degraded capability', () => {
      instance.markDegraded('qdrant', 'Timeout after 30s');
      expect(instance.getDegradedReason('qdrant')).toBe('Timeout after 30s');
    });
  });

  // --- getAllDegraded ---

  describe('getAllDegraded', () => {
    it('returns empty array when nothing is degraded', () => {
      expect(instance.getAllDegraded()).toEqual([]);
    });

    it('returns entries with correct structure', () => {
      instance.markDegraded('qdrant', 'Down');
      const entries = instance.getAllDegraded();
      expect(entries).toHaveLength(1);
      expect(entries[0].capability).toBe('qdrant');
      expect(entries[0].reason).toBe('Down');
      expect(entries[0].since).toBeInstanceOf(Date);
    });
  });

  // --- isDegraded ---

  describe('isDegraded', () => {
    it('returns false when nothing is degraded', () => {
      expect(instance.isDegraded()).toBe(false);
    });

    it('returns true when at least one capability is degraded', () => {
      instance.markDegraded('embeddings', 'No model');
      expect(instance.isDegraded()).toBe(true);
    });
  });

  // --- getReport ---

  describe('getReport', () => {
    it('returns all-available message when nothing is degraded', () => {
      expect(instance.getReport()).toBe('All capabilities available');
    });

    it('includes capability name and reason for each degraded entry', () => {
      instance.markDegraded('sharedPath', 'Path not set');
      instance.markDegraded('qdrant', 'Auth failed');
      const report = instance.getReport();
      expect(report).toContain('Degraded capabilities (2)');
      expect(report).toContain('sharedPath: Path not set');
      expect(report).toContain('qdrant: Auth failed');
    });
  });

  // --- reset ---

  describe('reset', () => {
    it('clears all degraded capabilities', () => {
      instance.markDegraded('sharedPath', 'A');
      instance.markDegraded('qdrant', 'B');
      instance.reset();
      expect(instance.isDegraded()).toBe(false);
      expect(instance.getAllDegraded()).toEqual([]);
    });

    it('makes all capabilities available again', () => {
      instance.markDegraded('embeddings', 'X');
      instance.reset();
      expect(instance.isAvailable('embeddings')).toBe(true);
    });
  });

  // --- getServerCapabilities convenience ---

  describe('getServerCapabilities', () => {
    it('returns the singleton instance', () => {
      const caps = getServerCapabilities();
      expect(caps).toBe(ServerCapabilities.getInstance());
    });
  });
});
