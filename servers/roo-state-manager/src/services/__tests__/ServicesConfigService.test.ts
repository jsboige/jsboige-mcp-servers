import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ServicesConfigService,
  SERVICE_REGISTRY,
} from '../ServicesConfigService.js';
import type { PowerShellExecutionResult } from '../PowerShellExecutor.js';

// Mock logger (Service instantiates createLogger in its constructor)
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Minimal mock executor: only executeScript is used by the service. */
function createMockExecutor() {
  return {
    executeScript: vi.fn<() => Promise<PowerShellExecutionResult>>(),
  } as any;
}

describe('ServicesConfigService', () => {
  let service: ServicesConfigService;
  let mockExecutor: ReturnType<typeof createMockExecutor>;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    // Own `iis` (owner 'myia-po-2023' in SERVICE_REGISTRY L125) for ownership-pass tests.
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2023';
    mockExecutor = createMockExecutor();
    service = new ServicesConfigService(mockExecutor);
  });

  afterEach(() => {
    // Restore ROOSYNC_MACHINE_ID (don't leak env into other test files).
    if (originalMachineId === undefined) {
      delete process.env.ROOSYNC_MACHINE_ID;
    } else {
      process.env.ROOSYNC_MACHINE_ID = originalMachineId;
    }
  });

  // ============================================================
  // Static registry helpers
  // ============================================================

  describe('static helpers', () => {
    it('getRegisteredNames returns every registry entry name', () => {
      const names = ServicesConfigService.getRegisteredNames();
      // SERVICE_REGISTRY (L113-147) has exactly 4 targets.
      expect(names).toHaveLength(SERVICE_REGISTRY.length);
      expect(names).toEqual(expect.arrayContaining(['qdrant', 'iis', 'vllm', 'sk-agent']));
    });

    it('getRegistryEntry returns the entry by name, undefined when missing', () => {
      const vllm = ServicesConfigService.getRegistryEntry('vllm');
      expect(vllm).toBeDefined();
      expect(vllm!.kind).toBe('process');
      expect(vllm!.owner).toBe('myia-ai-01');
      // Regression guard: vLLM health probe must hit the UNAUTHENTICATED /health
      // endpoint. /v1/models requires the API key → unauth probe 401s → false DOWN.
      expect(vllm!.healthEndpoint).toContain('/health');
      expect(vllm!.healthEndpoint).not.toContain('/v1/models');
      // Unknown name → undefined (registry.find fallback L643)
      expect(ServicesConfigService.getRegistryEntry('does-not-exist')).toBeUndefined();
    });

    it('parseServiceTarget extracts the name after services: prefix, null otherwise', () => {
      // L647-652: slice(9) when prefix matches 'services:'.
      expect(ServicesConfigService.parseServiceTarget('services:vllm')).toBe('vllm');
      expect(ServicesConfigService.parseServiceTarget('services:iis')).toBe('iis');
      // Non-services targets (e.g. modes:, plain names) → null.
      expect(ServicesConfigService.parseServiceTarget('modes:code')).toBeNull();
      expect(ServicesConfigService.parseServiceTarget('vllm')).toBeNull();
    });

    it('isValidServiceName is true for registered names, false otherwise', () => {
      // L655-657: SERVICE_REGISTRY.some match.
      expect(ServicesConfigService.isValidServiceName('iis')).toBe(true);
      expect(ServicesConfigService.isValidServiceName('qdrant')).toBe(true);
      expect(ServicesConfigService.isValidServiceName('nope')).toBe(false);
    });

    it('SERVICE_REGISTRY declares a non-empty owner for every entry', () => {
      // Ownership enforcement (L415) relies on every entry having a concrete owner.
      for (const entry of SERVICE_REGISTRY) {
        expect(entry.owner).toBeTruthy();
        expect(typeof entry.owner).toBe('string');
      }
      // `iis` is owned by this machine — used by the ownership-pass tests below.
      const iis = SERVICE_REGISTRY.find(r => r.name === 'iis');
      expect(iis!.owner).toBe('myia-po-2023');
    });
  });

  // ============================================================
  // collect
  // ============================================================

  describe('collect', () => {
    it('dry-run reports a dry-run entry without invoking the executor', async () => {
      // L275-283: dryRun short-circuits before collectSingle.
      const result = await service.collect(['iis'], true);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].status).toBe('dry-run');
      expect(result.services[0].name).toBe('iis');
      expect(result.services[0].owner).toBe('myia-po-2023');
      expect(mockExecutor.executeScript).not.toHaveBeenCalled();
      expect(result.machineId).toBe('myia-po-2023');
    });

    it('skips unknown targets (warn) and excludes them from the result', async () => {
      // L270-273: unknown name → logger.warn + continue (no entry pushed).
      const result = await service.collect(['unknown-target', 'iis'], true);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].name).toBe('iis');
      // Unknown target produced no entry.
      expect(result.services.find(s => s.name === 'unknown-target')).toBeUndefined();
    });

    it('collects a service-kind target and maps Status/Pid/ListeningPorts', async () => {
      // collectSingle 'service' branch (L313-330): parseJsonOutput reads
      // {Status, Pid, ListeningPorts}. `iis` has no healthEndpoint → no fetch.
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify({ Status: 'Running', Pid: 456, ListeningPorts: [80, 443] }),
        stderr: '',
        exitCode: 0,
        executionTime: 100,
      });

      const result = await service.collect(['iis']);

      expect(result.services).toHaveLength(1);
      const entry = result.services[0];
      expect(entry.status).toBe('Running');
      expect(entry.pid).toBe(456);
      expect(entry.ports).toEqual([80, 443]);
      expect(entry.kind).toBe('service');
      // No healthEndpoint on iis → health probe skipped (L367).
      expect(entry.health).toBeUndefined();
      expect(mockExecutor.executeScript).toHaveBeenCalledTimes(1);
    });

    it('records an error entry when collectSingle throws', async () => {
      // L285-297: collectSingle rejection → push status 'error' + health.healthy false.
      mockExecutor.executeScript.mockRejectedValue(new Error('PowerShell boom'));

      const result = await service.collect(['iis']);

      const entry = result.services[0];
      expect(entry.status).toBe('error');
      expect(entry.health).toBeDefined();
      expect(entry.health!.healthy).toBe(false);
      expect(entry.health!.error).toContain('PowerShell boom');
    });

    it('reports a non-owned target as not-owned without probing (owner-scoping)', async () => {
      // vllm is owned by 'myia-ai-01'; current machine is 'myia-po-2023'.
      // A non-owner must NOT probe locally — the local process/health probe would
      // find nothing and wrongly report the service DOWN (false fleet-wide "vLLM DOWN").
      const result = await service.collect(['vllm']);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].name).toBe('vllm');
      expect(result.services[0].status).toBe('not-owned');
      expect(result.services[0].owner).toBe('myia-ai-01');
      // Gate fired before collectSingle → no executor call.
      expect(mockExecutor.executeScript).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // apply
  // ============================================================

  describe('apply', () => {
    it('rejects a target owned by another machine (ownership violation)', async () => {
      // vllm owner is 'myia-ai-01' (L132); current machine is 'myia-po-2023'.
      // L415-418: push "Ownership violation" + continue (no collectSingle).
      const result = await service.apply(['vllm'], 'start');

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/Ownership violation/);
      expect(result.errors[0]).toContain('myia-ai-01');
      // No executor call (gate fired before collectSingle).
      expect(mockExecutor.executeScript).not.toHaveBeenCalled();
      expect(result.changes).toHaveLength(0);
    });

    it('rejects an unknown service target', async () => {
      // L408-412: regEntry missing → "Unknown service target" (before ownership).
      const result = await service.apply(['totally-unknown'], 'start');

      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/Unknown service target/);
      expect(mockExecutor.executeScript).not.toHaveBeenCalled();
    });

    it('dry-run reports the change without invoking the executor', async () => {
      // iis owned by po-2023 → ownership passes; L427-435 dryRun short-circuit.
      const result = await service.apply(['iis'], 'restart', true);

      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].before).toBe('dry-run');
      expect(result.changes[0].after).toBe('dry-run');
      expect(result.changes[0].action).toBe('restart');
      expect(mockExecutor.executeScript).not.toHaveBeenCalled();
    });

    it('W3 reconciliation skips a target already in its desired state', async () => {
      // L444-465: desiredStatuses provided → reconciliation mode.
      // iis currently 'Running' and desired 'Running' → isRunning && shouldBeRunning
      // → "already in desired state" branch: change before==after, NO applySingle.
      mockExecutor.executeScript.mockResolvedValue({
        success: true,
        stdout: JSON.stringify({ Status: 'Running', Pid: 789, ListeningPorts: [80] }),
        stderr: '',
        exitCode: 0,
        executionTime: 80,
      });

      const result = await service.apply(['iis'], 'start', false, { iis: 'Running' });

      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(1);
      const change = result.changes[0];
      expect(change.before).toBe('Running');
      expect(change.after).toBe('Running');
      // Only the before-state collect ran — applySingle was skipped (continue L464).
      // For a service-kind collect, executeScript is called once per collectSingle.
      expect(mockExecutor.executeScript).toHaveBeenCalledTimes(1);
    });
  });
});
