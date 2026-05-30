/**
 * Unit tests for ServicesConfigService — W1/W2/W3 follow-ups
 *
 * W1: Stop-Process PID filter (no longer kills ALL processes with same name)
 * W2: startArgs array (PowerShell @() array instead of flat join)
 * W3: Bidirectional apply reconciliation (start AND stop via desiredStatuses)
 *
 * @module tests/unit/services/ServicesConfigService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks ---
const { mockExecuteScript } = vi.hoisted(() => ({
  mockExecuteScript: vi.fn(),
}));

// Mock PowerShellExecutor module — provide both instance method and static method
vi.mock('../../../src/services/PowerShellExecutor.js', () => {
  return {
    PowerShellExecutor: class MockPowerShellExecutor {
      executeScript = mockExecuteScript;
      static parseJsonOutput = (input: string) => {
        try { return JSON.parse(input); } catch { return {}; }
      };
    },
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('os', () => ({
  hostname: () => 'myia-ai-01',
}));

// Import AFTER mocks
import {
  ServicesConfigService,
  SERVICE_REGISTRY,
} from '../../../src/services/ServicesConfigService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(): ServicesConfigService {
  // Inject mock executor via constructor DI
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockExecutor: any = { executeScript: mockExecuteScript };
  const svc = new ServicesConfigService(mockExecutor);
  // Force machineId to match vllm owner for ownership tests
  Object.defineProperty(svc, 'machineId', { value: 'myia-ai-01', writable: true });
  return svc;
}

/** Default successful executor response */
function successResponse(stdout = '{}') {
  return Promise.resolve({ success: true as const, stdout, stderr: '', exitCode: 0 });
}

/** Collect response for a running process with PID */
function runningProcessResponse(pid: number, ports: number[] = []) {
  const data: Record<string, unknown> = { Status: 'Running', Pids: [pid] };
  if (ports.length > 0) data.ListeningPorts = ports;
  return successResponse(JSON.stringify(data));
}

/** Collect response for a stopped process */
function stoppedProcessResponse() {
  return successResponse(JSON.stringify({ Status: 'Stopped' }));
}

/** Collect response for a running Windows service */
function runningServiceResponse(pid?: number) {
  const data: Record<string, unknown> = { Status: 'Running', StartType: 'Automatic', DisplayName: 'Test Service' };
  if (pid) data.Pid = pid;
  return successResponse(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// W1: Stop-Process PID filter
// ---------------------------------------------------------------------------

describe('W1: Stop-Process PID filter', () => {
  let service: ServicesConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createService();
  });

  it('should use PID-based kill when PID is available', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningProcessResponse(12345)) // collect before
      .mockResolvedValueOnce(successResponse())             // stop by PID
      .mockResolvedValueOnce(stoppedProcessResponse())      // collect after
    ;

    const result = await service.apply(['vllm'], 'stop');

    expect(result.errors).toEqual([]);
    expect(mockExecuteScript.mock.calls.length).toBe(3);

    // Call 1 is the stop — should use PID
    const stopCallScript = mockExecuteScript.mock.calls[1][1][1] as string;
    expect(stopCallScript).toContain('Stop-Process -Id 12345');
    expect(result.success).toBe(true);
  });

  it('should NOT use broad Stop-Process -Name when PID is available', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningProcessResponse(99999))
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(stoppedProcessResponse())
    ;

    await service.apply(['vllm'], 'stop');

    // Only check the stop call (call index 1), not the collect calls which legitimately use Get-Process
    const stopCallScript = mockExecuteScript.mock.calls[1]?.[1]?.[1] as string;
    expect(stopCallScript).not.toContain("Stop-Process -Name 'python'");
    expect(stopCallScript).not.toContain("Get-Process -Name 'python'");
    expect(stopCallScript).toContain('Stop-Process -Id 99999');
  });

  it('should fallback to CommandLine filter when no PID is available', async () => {
    // Process is stopped (no PID) → restart calls stop then start
    mockExecuteScript
      .mockResolvedValueOnce(stoppedProcessResponse())    // collect before (Stopped, no PID)
      .mockResolvedValueOnce(successResponse())           // CommandLine-based stop
      .mockResolvedValueOnce(successResponse())           // start
      .mockResolvedValueOnce(runningProcessResponse(555)) // collect after
    ;

    const result = await service.apply(['vllm'], 'restart');

    // The stop call (call 1) should use Win32_Process filter
    const stopCallScript = mockExecuteScript.mock.calls[1][1][1] as string;
    expect(stopCallScript).toContain('Win32_Process');
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W2: startArgs array
// ---------------------------------------------------------------------------

describe('W2: startArgs PowerShell array', () => {
  let service: ServicesConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createService();
  });

  it('should generate PowerShell @() array for ArgumentList', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(stoppedProcessResponse())
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(runningProcessResponse(789))
    ;

    await service.apply(['vllm'], 'start');

    // Call 1 is the start script
    const startScript = mockExecuteScript.mock.calls[1][1][1] as string;
    expect(startScript).toMatch(/@\(.*'-m'.*\)/);
    expect(startScript).not.toMatch(/-ArgumentList '-m vllm/);
  });

  it('should properly quote each argument individually', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(stoppedProcessResponse())
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(runningProcessResponse(789))
    ;

    await service.apply(['vllm'], 'start');

    const startScript = mockExecuteScript.mock.calls[1][1][1] as string;
    expect(startScript).toContain("'--port'");
    expect(startScript).toContain("'5002'");
  });

  it('should handle service kind (no startArgs)', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningServiceResponse(100))
      .mockResolvedValueOnce(successResponse())          // stop service
      .mockResolvedValueOnce(successResponse())          // start service
      .mockResolvedValueOnce(runningServiceResponse(100))
    ;

    const result = await service.apply(['qdrant'], 'restart');
    expect(result.success).toBe(true);
    expect(result.changes[0].action).toBe('restart');
  });
});

// ---------------------------------------------------------------------------
// W3: Bidirectional apply reconciliation
// ---------------------------------------------------------------------------

describe('W3: Bidirectional reconciliation', () => {
  let service: ServicesConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createService();
  });

  it('should start a stopped service when desiredStatus is Running', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(stoppedProcessResponse())
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(runningProcessResponse(456))
    ;

    const result = await service.apply(
      ['vllm'],
      'start',
      false,
      { vllm: 'Running' }
    );

    expect(result.success).toBe(true);
    expect(result.changes[0].action).toBe('start');
  });

  it('should stop a running service when desiredStatus is Stopped', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningProcessResponse(789))
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(stoppedProcessResponse())
    ;

    const result = await service.apply(
      ['vllm'],
      'start', // overridden by reconciliation
      false,
      { vllm: 'Stopped' }
    );

    expect(result.success).toBe(true);
    expect(result.changes[0].action).toBe('stop');
  });

  it('should skip when current state matches desired state', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningProcessResponse(999))
    ;

    const result = await service.apply(
      ['vllm'],
      'start',
      false,
      { vllm: 'Running' }
    );

    expect(result.success).toBe(true);
    expect(result.changes[0].before).toBe('Running');
    expect(mockExecuteScript.mock.calls.length).toBe(1);
  });

  it('should pass collected PID to stop during reconciliation', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningProcessResponse(42))
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(stoppedProcessResponse())
    ;

    await service.apply(
      ['vllm'],
      'start',
      false,
      { vllm: 'Stopped' }
    );

    const stopCallScript = mockExecuteScript.mock.calls[1][1][1] as string;
    expect(stopCallScript).toContain('Stop-Process -Id 42');
  });

  it('should use explicit operation when no desiredStatuses provided', async () => {
    mockExecuteScript
      .mockResolvedValueOnce(runningProcessResponse(111))
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(stoppedProcessResponse())
    ;

    const result = await service.apply(['vllm'], 'stop');

    expect(result.success).toBe(true);
    expect(result.changes[0].action).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

describe('Registry helpers', () => {
  it('should parse services: target', () => {
    expect(ServicesConfigService.parseServiceTarget('services:vllm')).toBe('vllm');
    expect(ServicesConfigService.parseServiceTarget('config:modes')).toBeNull();
  });

  it('should validate service names', () => {
    expect(ServicesConfigService.isValidServiceName('vllm')).toBe(true);
    expect(ServicesConfigService.isValidServiceName('nonexistent')).toBe(false);
  });

  it('should list all registered names', () => {
    const names = ServicesConfigService.getRegisteredNames();
    expect(names).toContain('vllm');
    expect(names).toContain('qdrant');
    expect(names).toContain('iis');
    expect(names).toContain('sk-agent');
  });
});
