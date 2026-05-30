/**
 * ServicesConfigService - Collect/apply for Windows services and processes
 *
 * Target `services:<name>` for roosync_config (#2409 VibeSync Epic).
 * Manages the lifecycle of critical cluster services (vLLM, Qdrant, IIS, sk-agent).
 *
 * Architecture:
 *   - "service" (Windows service via Get-Service/Set-Service)
 *   - "process" (managed process via PID tracking + Start-Process)
 *   - "container" (Docker container via docker CLI)
 *
 * Ownership is enforced via static SERVICE_REGISTRY — apply is refused
 * if the current machine is not the designated owner.
 *
 * @module ServicesConfigService
 * @version 1.0.0
 */

import { PowerShellExecutor } from './PowerShellExecutor.js';
import { createLogger, Logger } from '../utils/logger.js';
import { hostname } from 'os';

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

/** The kind of managed entity */
export type ServiceKind = 'service' | 'process' | 'container';

/** Health status after collect or apply */
export interface ServiceHealth {
  /** Whether the endpoint responded */
  healthy: boolean;
  /** Latency in ms (if checked) */
  latencyMs?: number;
  /** Error message if unhealthy */
  error?: string;
}

/** Collected state for a single service target */
export interface ServiceEntry {
  /** Logical name (e.g. "vllm", "qdrant") */
  name: string;
  /** What kind of entity this is */
  kind: ServiceKind;
  /** Running / Stopped / Unknown */
  status: string;
  /** PID if applicable */
  pid?: number;
  /** Port(s) listening (if detected) */
  ports?: number[];
  /** Health probe result */
  health?: ServiceHealth;
  /** Machine that owns this service */
  owner: string;
}

/** Result of a collect operation */
export interface ServicesCollectResult {
  services: ServiceEntry[];
  collectedAt: string;
  machineId: string;
}

/** A single change applied */
export interface AppliedChange {
  name: string;
  action: 'start' | 'stop' | 'restart';
  before: string;
  after: string;
  /** Health check after apply */
  healthAfter?: ServiceHealth;
}

/** Result of an apply operation */
export interface ServicesApplyResult {
  success: boolean;
  changes: AppliedChange[];
  errors: string[];
  rollbackPerformed: boolean;
}

/** Registry entry defining a known cluster service */
export interface ServiceRegistryEntry {
  /** Logical name */
  name: string;
  /** Kind of entity */
  kind: ServiceKind;
  /** Designated owner machine ID */
  owner: string;
  /** For kind=service: the Windows service name */
  windowsServiceName?: string;
  /** For kind=process: the executable name to find/launch */
  processName?: string;
  /** For kind=container: the container name */
  containerName?: string;
  /** Expected listening port(s) for health check */
  ports?: number[];
  /** HTTP health endpoint (GET expected 2xx) */
  healthEndpoint?: string;
  /** Startup command (for process kind) */
  startCommand?: string;
  /** Startup arguments */
  startArgs?: string[];
  /** Working directory for process start */
  startCwd?: string;
}

// ──────────────────────────────────────────────────
// Static registry — cluster infrastructure
// ──────────────────────────────────────────────────

export const SERVICE_REGISTRY: ServiceRegistryEntry[] = [
  {
    name: 'qdrant',
    kind: 'service',
    owner: 'myia-ai-01',
    windowsServiceName: 'Qdrant',
    ports: [6333],
    healthEndpoint: 'http://localhost:6333/healthz',
  },
  {
    name: 'iis',
    kind: 'service',
    owner: 'myia-po-2023',
    windowsServiceName: 'W3SVC',
    ports: [80, 443],
  },
  {
    name: 'vllm',
    kind: 'process',
    owner: 'myia-ai-01',
    processName: 'python',
    ports: [5002],
    healthEndpoint: 'http://localhost:5002/v1/models',
    startCommand: 'python',
    startArgs: ['-m', 'vllm.entrypoints.openai.api_server', '--port', '5002', '--model', 'qwen3.6-35b-a3b'],
  },
  {
    name: 'sk-agent',
    kind: 'container',
    owner: 'myia-ai-01',
    containerName: 'sk-agent',
    ports: [8765],
    healthEndpoint: 'http://localhost:8765/health',
  },
];

// ──────────────────────────────────────────────────
// PowerShell scripts (inline for PowerShellExecutor)
// ──────────────────────────────────────────────────

/**
 * Build a PowerShell script to collect Windows service info.
 * Uses string interpolation (not param()) because PowerShellExecutor
 * invokes via `-Command` which does not bind param() blocks (#2409 review).
 */
function buildCollectServiceScript(serviceName: string, ports: number[]): string {
  const portCheck = ports.length > 0 ? `
$Ports = @(${ports.join(',')})
$listeningPorts = @()
foreach ($port in $Ports) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) { $listeningPorts += $port }
}
$result.ListeningPorts = $listeningPorts` : '';

  return `
$ErrorActionPreference = 'Stop'
$result = @{}

# Get service info
try {
  $svc = Get-Service -Name '${serviceName}' -ErrorAction Stop
  $result.Status = $svc.Status.ToString()
  $result.StartType = $svc.StartType.ToString()
  $result.DisplayName = $svc.DisplayName
} catch {
  $result.Status = 'NotFound'
  $result.Error = $_.Exception.Message
}

# Get PID from Win32_Service
try {
  $wmi = Get-CimInstance -ClassName Win32_Service -Filter "Name='${serviceName}'" -ErrorAction SilentlyContinue
  if ($wmi) { $result.Pid = $wmi.ProcessId }
} catch {}
${portCheck}

$result | ConvertTo-Json -Depth 5
`;
}

function buildCollectProcessScript(processName: string, ports: number[]): string {
  const portCheck = ports.length > 0 ? `
$Ports = @(${ports.join(',')})
$listeningPorts = @()
foreach ($port in $Ports) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) { $listeningPorts += $port }
}
$result.ListeningPorts = $listeningPorts` : '';

  return `
$ErrorActionPreference = 'Stop'
$result = @{}

# Find process
$procs = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue
if ($procs) {
  $result.Status = 'Running'
  $result.Pids = @($procs | ForEach-Object { $_.Id })
} else {
  $result.Status = 'Stopped'
}
${portCheck}

$result | ConvertTo-Json -Depth 5
`;
}

function buildCollectContainerScript(containerName: string): string {
  return `
$ErrorActionPreference = 'Stop'
$result = @{}

try {
  $container = docker inspect --format '{{.State.Status}}' '${containerName}' 2>$null
  if ($LASTEXITCODE -eq 0) {
    $result.Status = $container.Trim()
  } else {
    $result.Status = 'NotFound'
  }
} catch {
  $result.Status = 'NotFound'
  $result.Error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 5
`;
}

// ──────────────────────────────────────────────────
// Service class
// ──────────────────────────────────────────────────

export class ServicesConfigService {
  private logger: Logger;
  private executor: PowerShellExecutor;
  private machineId: string;

  constructor(executor?: PowerShellExecutor) {
    this.logger = createLogger('ServicesConfigService');
    this.executor = executor ?? new PowerShellExecutor();
    this.machineId = process.env.ROOSYNC_MACHINE_ID || hostname().toLowerCase();
  }

  // ── Collect ────────────────────────────────────

  /**
   * Collect the state of specified service targets.
   * @param names - Service names from the registry (e.g. ['qdrant', 'vllm'])
   * @param dryRun - If true, only report what would be collected
   */
  async collect(names: string[], dryRun?: boolean): Promise<ServicesCollectResult> {
    const entries: ServiceEntry[] = [];

    for (const name of names) {
      const regEntry = SERVICE_REGISTRY.find(r => r.name === name);
      if (!regEntry) {
        this.logger.warn(`Unknown service target: ${name}`);
        continue;
      }

      if (dryRun) {
        entries.push({
          name: regEntry.name,
          kind: regEntry.kind,
          status: 'dry-run',
          owner: regEntry.owner,
        });
        continue;
      }

      try {
        const entry = await this.collectSingle(regEntry);
        entries.push(entry);
      } catch (err) {
        this.logger.error(`Failed to collect ${name}: ${err instanceof Error ? err.message : String(err)}`);
        entries.push({
          name: regEntry.name,
          kind: regEntry.kind,
          status: 'error',
          owner: regEntry.owner,
          health: { healthy: false, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return {
      services: entries,
      collectedAt: new Date().toISOString(),
      machineId: this.machineId,
    };
  }

  private async collectSingle(entry: ServiceRegistryEntry): Promise<ServiceEntry> {
    let status = 'Unknown';
    let pid: number | undefined;
    let ports: number[] = [];

    switch (entry.kind) {
      case 'service': {
        const script = buildCollectServiceScript(
          entry.windowsServiceName || entry.name,
          entry.ports ?? []
        );
        const result = await this.executor.executeScript(
          '', ['-Command', script],
          { timeout: 15000 }
        );
        if (result.success) {
          const parsed = PowerShellExecutor.parseJsonOutput<{
            Status: string; Pid?: number; ListeningPorts?: number[]
          }>(result.stdout);
          status = parsed.Status;
          pid = parsed.Pid;
          ports = parsed.ListeningPorts ?? [];
        }
        break;
      }
      case 'process': {
        const script = buildCollectProcessScript(
          entry.processName || entry.name,
          entry.ports ?? []
        );
        const result = await this.executor.executeScript(
          '', ['-Command', script],
          { timeout: 15000 }
        );
        if (result.success) {
          const parsed = PowerShellExecutor.parseJsonOutput<{
            Status: string; Pids?: number[]; ListeningPorts?: number[]
          }>(result.stdout);
          status = parsed.Status;
          if (parsed.Pids?.length) { pid = parsed.Pids[0]; }
          ports = parsed.ListeningPorts ?? [];
        }
        break;
      }
      case 'container': {
        const script = buildCollectContainerScript(entry.containerName || entry.name);
        const result = await this.executor.executeScript(
          '', ['-Command', script],
          { timeout: 15000 }
        );
        if (result.success) {
          const parsed = PowerShellExecutor.parseJsonOutput<{ Status: string }>(result.stdout);
          status = parsed.Status;
        }
        break;
      }
    }

    // Health probe
    let health: ServiceHealth | undefined;
    if (entry.healthEndpoint && status !== 'Stopped' && status !== 'NotFound') {
      health = await this.probeHealth(entry.healthEndpoint);
    }

    return {
      name: entry.name,
      kind: entry.kind,
      status,
      pid,
      ports,
      health,
      owner: entry.owner,
    };
  }

  // ── Apply ──────────────────────────────────────

  /**
   * Apply an operation to specified service targets.
   * Enforces ownership: refuses if current machine ≠ designated owner.
   *
   * @param targets - Service names with operation (e.g. ['vllm'])
   * @param operation - 'start' | 'stop' | 'restart'
   * @param dryRun - If true, only report what would be done
   */
  async apply(
    targets: string[],
    operation: 'start' | 'stop' | 'restart',
    dryRun?: boolean
  ): Promise<ServicesApplyResult> {
    const changes: AppliedChange[] = [];
    const errors: string[] = [];
    let rollbackPerformed = false;

    for (const name of targets) {
      const regEntry = SERVICE_REGISTRY.find(r => r.name === name);
      if (!regEntry) {
        errors.push(`Unknown service target: ${name}`);
        continue;
      }

      // Ownership enforcement
      if (regEntry.owner !== this.machineId) {
        errors.push(`Ownership violation: ${name} is owned by ${regEntry.owner}, not ${this.machineId}`);
        continue;
      }

      if (dryRun) {
        changes.push({
          name,
          action: operation,
          before: 'dry-run',
          after: 'dry-run',
        });
        continue;
      }

      try {
        // Collect before state
        const before = await this.collectSingle(regEntry);
        const beforeStatus = before.status;

        // Execute the operation
        await this.applySingle(regEntry, operation);

        // Wait a moment for the service to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Collect after state
        const after = await this.collectSingle(regEntry);
        const afterStatus = after.status;

        // Health check
        let healthAfter: ServiceHealth | undefined;
        if (regEntry.healthEndpoint) {
          healthAfter = await this.probeHealth(regEntry.healthEndpoint);
        }

        // Rollback if health check fails on start/restart
        if ((operation === 'start' || operation === 'restart') && healthAfter && !healthAfter.healthy) {
          this.logger.warn(`Health check failed for ${name} after ${operation}. Rolling back.`);
          // Best-effort rollback: stop what we just started
          try {
            await this.applySingle(regEntry, 'stop');
            rollbackPerformed = true;
          } catch (rollbackErr) {
            this.logger.error(`Rollback failed for ${name}: ${rollbackErr}`);
          }
        }

        changes.push({
          name,
          action: operation,
          before: beforeStatus,
          after: afterStatus,
          healthAfter,
        });
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      success: errors.length === 0,
      changes,
      errors,
      rollbackPerformed,
    };
  }

  private async applySingle(entry: ServiceRegistryEntry, operation: 'start' | 'stop' | 'restart'): Promise<void> {
    const opVerb = operation === 'start' ? 'Start' : operation === 'stop' ? 'Stop' : 'Restart';

    switch (entry.kind) {
      case 'service': {
        const svcName = entry.windowsServiceName || entry.name;
        const script = `${opVerb}-Service -Name '${svcName}' -ErrorAction Stop`;
        const result = await this.executor.executeScript('', ['-Command', script], { timeout: 30000 });
        if (!result.success) {
          throw new Error(`Service ${opVerb} failed for ${svcName}: ${result.stderr}`);
        }
        break;
      }
      case 'process': {
        if (operation === 'stop' || operation === 'restart') {
          const killScript = `Get-Process -Name '${entry.processName}' -ErrorAction SilentlyContinue | Stop-Process -Force`;
          await this.executor.executeScript('', ['-Command', killScript], { timeout: 15000 });
          if (operation === 'stop') break;
          // For restart, wait for process to die
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (operation === 'start' || operation === 'restart') {
          if (!entry.startCommand) {
            throw new Error(`No startCommand defined for process target: ${entry.name}`);
          }
          const startScript = [
            'Start-Process',
            `-FilePath '${entry.startCommand}'`,
            ...(entry.startArgs?.length ? [`-ArgumentList '${entry.startArgs.join(' ')}'`] : []),
            ...(entry.startCwd ? [`-WorkingDirectory '${entry.startCwd}'`] : []),
            '-WindowStyle Hidden',
          ].join(' ');
          const result = await this.executor.executeScript('', ['-Command', startScript], { timeout: 15000 });
          if (!result.success) {
            throw new Error(`Process start failed for ${entry.name}: ${result.stderr}`);
          }
        }
        break;
      }
      case 'container': {
        const containerName = entry.containerName || entry.name;
        const dockerOp = operation === 'restart' ? 'restart' : operation === 'start' ? 'start' : 'stop';
        const result = await this.executor.executeScript(
          '', ['-Command', `docker ${dockerOp} ${containerName}`], { timeout: 30000 }
        );
        if (!result.success) {
          throw new Error(`Container ${dockerOp} failed for ${containerName}: ${result.stderr}`);
        }
        break;
      }
    }
  }

  // ── Health probe ───────────────────────────────

  private async probeHealth(endpoint: string): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      if (response.ok) {
        return { healthy: true, latencyMs };
      }
      return { healthy: false, latencyMs, error: `HTTP ${response.status}` };
    } catch (err) {
      return { healthy: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Registry helpers ───────────────────────────

  /** Get all registered service names */
  static getRegisteredNames(): string[] {
    return SERVICE_REGISTRY.map(r => r.name);
  }

  /** Get registry entry by name */
  static getRegistryEntry(name: string): ServiceRegistryEntry | undefined {
    return SERVICE_REGISTRY.find(r => r.name === name);
  }

  /** Check if a target name matches the services:<name> pattern */
  static parseServiceTarget(target: string): string | null {
    if (target.startsWith('services:')) {
      return target.slice(9);
    }
    return null;
  }

  /** Validate that a service name exists in the registry */
  static isValidServiceName(name: string): boolean {
    return SERVICE_REGISTRY.some(r => r.name === name);
  }
}
