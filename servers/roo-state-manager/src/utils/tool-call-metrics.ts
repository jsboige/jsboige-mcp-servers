/**
 * Tool Call Metrics — In-memory per-tool usage tracking
 *
 * Counts every MCP tool call, tracking call count, total duration,
 * and last call timestamp. Stats are exposed via roosync_get_status.
 *
 * @module utils/tool-call-metrics
 */

interface ToolStats {
  count: number;
  totalMs: number;
  lastCallAt: string;
  errorCount: number;
}

const metrics = new Map<string, ToolStats>();
let sessionStartAt: string = new Date().toISOString();

export function recordToolCall(toolName: string, durationMs: number, hadError: boolean): void {
  const existing = metrics.get(toolName);
  if (existing) {
    existing.count++;
    existing.totalMs += durationMs;
    existing.lastCallAt = new Date().toISOString();
    if (hadError) existing.errorCount++;
  } else {
    metrics.set(toolName, {
      count: 1,
      totalMs: durationMs,
      lastCallAt: new Date().toISOString(),
      errorCount: hadError ? 1 : 0,
    });
  }
}

export interface ToolUsageSnapshot {
  sessionStartAt: string;
  totalCalls: number;
  uniqueTools: number;
  topTools: Array<{ name: string; count: number; avgMs: number; lastCallAt: string }>;
  bottomTools: Array<{ name: string; count: number; avgMs: number; lastCallAt: string }>;
  errorTools: Array<{ name: string; errorCount: number }>;
}

export function getToolUsageSnapshot(topN = 5, bottomN = 5): ToolUsageSnapshot {
  const entries = Array.from(metrics.entries()).map(([name, stats]) => ({
    name,
    count: stats.count,
    avgMs: Math.round(stats.totalMs / stats.count),
    lastCallAt: stats.lastCallAt,
    errorCount: stats.errorCount,
  }));

  const totalCalls = entries.reduce((sum, e) => sum + e.count, 0);

  const byCount = [...entries].sort((a, b) => b.count - a.count);
  const topTools = byCount.slice(0, topN).map(({ name, count, avgMs, lastCallAt }) => ({
    name,
    count,
    avgMs,
    lastCallAt,
  }));

  const bottomTools = byCount
    .slice(Math.max(0, byCount.length - bottomN))
    .reverse()
    .map(({ name, count, avgMs, lastCallAt }) => ({ name, count, avgMs, lastCallAt }));

  const errorTools = entries
    .filter((e) => e.errorCount > 0)
    .sort((a, b) => b.errorCount - a.errorCount)
    .map(({ name, errorCount }) => ({ name, errorCount }));

  return {
    sessionStartAt,
    totalCalls,
    uniqueTools: entries.length,
    topTools,
    bottomTools,
    errorTools,
  };
}

export function resetMetrics(): void {
  metrics.clear();
  sessionStartAt = new Date().toISOString();
}
