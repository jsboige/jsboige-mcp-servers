/**
 * Coverage complement for ServicesConfigService — #833 Sprint C3.
 *
 * Add-only, tests-only. Targets the cold paths the nominal suites never enter:
 *  - constructor default fallbacks (L254-255: `?? new PowerShellExecutor()`, `|| hostname()`)
 *  - collect() for all three kinds incl. container (L222-241, L351-362) + port-check
 *    builder arms (L159-166, L196-202) + collect error entry (L288-296)
 *  - probeHealth() unhealthy-HTTP (L627-628) and throw (L630) arms
 *  - applySingle() service / process-start(startArgs) / container branches
 *  - stopProcess() CommandLine-filter strategy (L598-607)
 *  - apply() post-start health rollback (L485-495) and per-target catch (L504-506)
 *
 * Reuses the nominal suite's mock strategy: mock logger, inject a mock
 * PowerShellExecutor via the constructor. `global.fetch` is stubbed per-test
 * for probeHealth. Apply tests run under fake timers (apply awaits a 2s
 * stabilization setTimeout).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServicesConfigService, SERVICE_REGISTRY } from '../ServicesConfigService.js';

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function createMockExecutor() {
  return { executeScript: vi.fn() } as any;
}

/** A PowerShellExecutionResult-shaped success/failure. */
function psResult(stdout: string, success = true, stderr = '') {
  return { success, stdout, stderr, exitCode: success ? 0 : 1 } as any;
}

/** Every executeScript call resolves to the given result. */
const RUNNING = '{"Status":"Running","Pid":4242,"Pids":[4242],"ListeningPorts":[6333]}';

describe('ServicesConfigService — coverage complement (#833)', () => {
  let service: ServicesConfigService;
  let mockExecutor: ReturnType<typeof createMockExecutor>;
  const originalMachineId = process.env.ROOSYNC_MACHINE_ID;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROOSYNC_MACHINE_ID = 'myia-po-2023'; // owns `iis`
    mockExecutor = createMockExecutor();
    service = new ServicesConfigService(mockExecutor);
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    if (originalMachineId === undefined) delete process.env.ROOSYNC_MACHINE_ID;
    else process.env.ROOSYNC_MACHINE_ID = originalMachineId;
  });

  // ── constructor fallbacks ──────────────────────────────────────────────

  it('default-constructs its executor and machineId (L254-255 fallbacks)', () => {
    delete process.env.ROOSYNC_MACHINE_ID; // → `|| hostname()` right arm
    const s = new ServicesConfigService(); // no executor → `?? new PowerShellExecutor()` right arm
    expect(s).toBeInstanceOf(ServicesConfigService);
  });

  // ── collect() ──────────────────────────────────────────────────────────

  it('collects service, process, and container kinds with a healthy probe', async () => {
    mockExecutor.executeScript.mockResolvedValue(psResult(RUNNING));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any);

    const result = await service.collect(['qdrant', 'iis', 'vllm', 'sk-agent']);

    expect(result.services).toHaveLength(4);
    expect(result.services.map(s => s.kind)).toEqual(['service', 'service', 'process', 'container']);
    // qdrant/vllm/sk-agent have a healthEndpoint and status !== Stopped → probed healthy.
    expect(result.services.find(s => s.name === 'qdrant')!.health?.healthy).toBe(true);
    expect(result.services.find(s => s.name === 'sk-agent')!.status).toBe('Running');
    // iis has no healthEndpoint → no probe.
    expect(result.services.find(s => s.name === 'iis')!.health).toBeUndefined();
    // The container-kind script was built (docker inspect) — proves buildCollectContainerScript ran.
    const scripts = mockExecutor.executeScript.mock.calls.map((c: any) => c[1][1]);
    expect(scripts.some((s: string) => s.includes('docker inspect'))).toBe(true);
  });

  it('skips the health probe when a service is Stopped (L367 guard)', async () => {
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Stopped"}'));
    global.fetch = vi.fn();

    const result = await service.collect(['qdrant']);

    expect(result.services[0].status).toBe('Stopped');
    expect(result.services[0].health).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('records a collect failure as an error entry (L288-296)', async () => {
    mockExecutor.executeScript.mockRejectedValue(new Error('powershell died'));

    const result = await service.collect(['qdrant']);

    expect(result.services[0].status).toBe('error');
    expect(result.services[0].health?.healthy).toBe(false);
    expect(result.services[0].health?.error).toContain('powershell died');
  });

  // ── probeHealth() arms (driven via collect) ────────────────────────────

  it('reports unhealthy with the HTTP status on a non-2xx probe (L627-628)', async () => {
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Running"}'));
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as any);

    const result = await service.collect(['qdrant']);

    expect(result.services[0].health?.healthy).toBe(false);
    expect(result.services[0].health?.error).toBe('HTTP 503');
  });

  it('reports unhealthy with the error message when the probe throws (L630)', async () => {
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Running"}'));
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.collect(['qdrant']);

    expect(result.services[0].health?.healthy).toBe(false);
    expect(result.services[0].health?.error).toContain('ECONNREFUSED');
  });

  // ── apply() / applySingle() (fake timers) ──────────────────────────────

  it('applies a start to a service target (applySingle service L534-540)', async () => {
    vi.useFakeTimers();
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Running"}'));

    const p = service.apply(['iis'], 'start'); // iis owned by po-2023, no healthEndpoint
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    expect(result.changes[0].action).toBe('start');
    const scripts = mockExecutor.executeScript.mock.calls.map((c: any) => c[1][1]);
    expect(scripts.some((s: string) => s.includes("Start-Service -Name 'W3SVC'"))).toBe(true);
  });

  it('collects a per-target error when the service op fails (L537-538 throw → L504-506)', async () => {
    mockExecutor.executeScript
      .mockResolvedValueOnce(psResult('{"Status":"Stopped"}')) // before
      .mockResolvedValueOnce(psResult('', false, 'access denied')); // applySingle → !success → throw

    // applySingle throws before the 2s setTimeout is reached → no fake timers needed.
    const result = await service.apply(['iis'], 'start');

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('iis');
    expect(result.errors[0]).toContain('access denied');
  });

  it('stops a process via CommandLine filter when no PID was collected (L598-607)', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01'; // owns vllm
    const svc = new ServicesConfigService(mockExecutor);
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Running"}')); // no Pid → strategy 2
    vi.useFakeTimers();

    const p = svc.apply(['vllm'], 'stop');
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    const scripts = mockExecutor.executeScript.mock.calls.map((c: any) => c[1][1]);
    expect(scripts.some((s: string) => s.includes('Win32_Process') && s.includes('CommandLine'))).toBe(true);
  });

  it('starts a process with a startArgs ArgumentList and probes health (L549-567)', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01'; // owns vllm
    const svc = new ServicesConfigService(mockExecutor);
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Stopped"}'));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any);
    vi.useFakeTimers();

    const p = svc.apply(['vllm'], 'start');
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    const startScript = mockExecutor.executeScript.mock.calls
      .map((c: any) => c[1][1])
      .find((s: string) => s.includes('Start-Process'));
    expect(startScript).toContain('-ArgumentList @(');
    expect(result.changes[0].healthAfter?.healthy).toBe(true);
  });

  it('restarts a container target via docker (applySingle container L571-580)', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01'; // owns sk-agent
    const svc = new ServicesConfigService(mockExecutor);
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"running"}'));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as any);
    vi.useFakeTimers();

    const p = svc.apply(['sk-agent'], 'restart');
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.success).toBe(true);
    const scripts = mockExecutor.executeScript.mock.calls.map((c: any) => c[1][1]);
    expect(scripts.some((s: string) => s.includes('docker restart sk-agent'))).toBe(true);
  });

  it('rolls back when the post-start health check fails (L485-495)', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01'; // owns qdrant (service + healthEndpoint)
    const svc = new ServicesConfigService(mockExecutor);
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Running"}'));
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as any); // unhealthy → rollback
    vi.useFakeTimers();

    const p = svc.apply(['qdrant'], 'start');
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.rollbackPerformed).toBe(true);
  });

  it('skips reconciliation when the target is already in the desired state (L455-465)', async () => {
    mockExecutor.executeScript.mockResolvedValue(psResult('{"Status":"Running"}'));
    vi.useFakeTimers();

    // iis (owned by po-2023) is Running and desired Running → already-in-state skip.
    const p = service.apply(['iis'], 'start', false, { iis: 'Running' });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(result.changes[0].before).toBe(result.changes[0].after);
    expect(result.changes[0].before).toBe('Running');
  });

  it('throws & records an error when a process start fails (L565-567)', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01'; // owns vllm
    const svc = new ServicesConfigService(mockExecutor);
    mockExecutor.executeScript
      .mockResolvedValueOnce(psResult('{"Status":"Stopped"}')) // before collect
      .mockResolvedValueOnce(psResult('', false, 'spawn denied')); // Start-Process → !success → throw

    // applySingle throws before the 2s setTimeout → no fake timers needed.
    const result = await svc.apply(['vllm'], 'start');

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('vllm');
    expect(result.errors[0]).toContain('spawn denied');
  });

  it('throws & records an error when a container op fails (L577-579)', async () => {
    process.env.ROOSYNC_MACHINE_ID = 'myia-ai-01'; // owns sk-agent
    const svc = new ServicesConfigService(mockExecutor);
    mockExecutor.executeScript
      .mockResolvedValueOnce(psResult('{"Status":"running"}')) // before collect
      .mockResolvedValueOnce(psResult('', false, 'docker daemon down')); // docker stop → !success → throw

    const result = await svc.apply(['sk-agent'], 'stop');

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('sk-agent');
    expect(result.errors[0]).toContain('docker daemon down');
  });
});
