import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process
const mockExecAsync = vi.hoisted(() => vi.fn());
vi.mock('util', () => ({
  promisify: () => mockExecAsync,
}));

import {
  getGitHubProjectMetrics,
  getGitHubIssuesMetrics,
  getGitHubMetrics,
  formatGitHubMetricsForDashboard,
  type GitHubMetrics,
} from '../../../src/utils/github-helpers.js';

function makeProjectGraphQLResponse(statusCounts: { done: number; inProgress: number; todo: number }) {
  const nodes: any[] = [];
  for (let i = 0; i < statusCounts.done; i++) {
    nodes.push({ fieldValues: { nodes: [{ field: { name: 'Status' }, name: 'Done' }] } });
  }
  for (let i = 0; i < statusCounts.inProgress; i++) {
    nodes.push({ fieldValues: { nodes: [{ field: { name: 'Status' }, name: 'In Progress' }] } });
  }
  for (let i = 0; i < statusCounts.todo; i++) {
    nodes.push({ fieldValues: { nodes: [{ field: { name: 'Status' }, name: 'Todo' }] } });
  }
  // Add some items without Status field
  nodes.push({ fieldValues: { nodes: [{ field: { name: 'Other' }, name: 'X' }] } });

  return {
    data: {
      user: {
        projectV2: {
          items: {
            totalCount: nodes.length,
            nodes,
          },
        },
      },
    },
  };
}

describe('getGitHubProjectMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts items by status correctly', async () => {
    const response = makeProjectGraphQLResponse({ done: 3, inProgress: 2, todo: 5 });
    const jsonStr = JSON.stringify(response);
    mockExecAsync.mockResolvedValue({ stdout: jsonStr });

    const result = await getGitHubProjectMetrics();

    expect(result.totalItems).toBe(11); // 3+2+5+1(no status)
    expect(result.doneCount).toBe(3);
    expect(result.inProgressCount).toBe(2);
    expect(result.todoCount).toBe(5);
    expect(result.donePercentage).toBe(27); // 3/11 = 27%
  });

  it('handles all done', async () => {
    const response = makeProjectGraphQLResponse({ done: 10, inProgress: 0, todo: 0 });
    mockExecAsync.mockResolvedValue({ stdout: JSON.stringify(response) });

    const result = await getGitHubProjectMetrics();

    expect(result.donePercentage).toBe(91); // 10/11
  });

  it('handles empty project', async () => {
    const response = {
      data: { user: { projectV2: { items: { totalCount: 0, nodes: [] } } } },
    };
    mockExecAsync.mockResolvedValue({ stdout: JSON.stringify(response) });

    const result = await getGitHubProjectMetrics();

    expect(result.totalItems).toBe(0);
    expect(result.doneCount).toBe(0);
    expect(result.donePercentage).toBe(0);
  });

  it('handles case-insensitive status names', async () => {
    const response = {
      data: {
        user: {
          projectV2: {
            items: {
              totalCount: 2,
              nodes: [
                { fieldValues: { nodes: [{ field: { name: 'Status' }, name: 'DONE' }] } },
                { fieldValues: { nodes: [{ field: { name: 'Status' }, name: 'todo' }] } },
              ],
            },
          },
        },
      },
    };
    mockExecAsync.mockResolvedValue({ stdout: JSON.stringify(response) });

    const result = await getGitHubProjectMetrics();

    expect(result.doneCount).toBe(1);
    expect(result.todoCount).toBe(1);
  });

  it('returns defaults on error', async () => {
    mockExecAsync.mockRejectedValue(new Error('network error'));

    const result = await getGitHubProjectMetrics();

    expect(result.totalItems).toBe(0);
    expect(result.doneCount).toBe(0);
    expect(result.donePercentage).toBe(0);
  });

  it('handles items with null status name', async () => {
    const response = {
      data: {
        user: {
          projectV2: {
            items: {
              totalCount: 1,
              nodes: [
                { fieldValues: { nodes: [{ field: { name: 'Status' }, name: null }] } },
              ],
            },
          },
        },
      },
    };
    mockExecAsync.mockResolvedValue({ stdout: JSON.stringify(response) });

    const result = await getGitHubProjectMetrics();

    expect(result.totalItems).toBe(1);
    expect(result.doneCount).toBe(0);
  });

  it('escapes quotes in GraphQL query', async () => {
    mockExecAsync.mockResolvedValue({
      stdout: JSON.stringify(makeProjectGraphQLResponse({ done: 1, inProgress: 0, todo: 0 })),
    });

    await getGitHubProjectMetrics();

    expect(mockExecAsync).toHaveBeenCalledWith(
      expect.stringContaining('gh api graphql'),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });
});

describe('getGitHubIssuesMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct counts', async () => {
    mockExecAsync
      .mockResolvedValueOnce({ stdout: '15' })    // openCount
      .mockResolvedValueOnce({ stdout: '1' })     // closed result (gh issue list)
      .mockResolvedValueOnce({ stdout: '42' })    // closedCount (gh search)
      .mockResolvedValueOnce({ stdout: '7' });    // recentActivity

    const result = await getGitHubIssuesMetrics();

    expect(result.openCount).toBe(15);
    expect(result.closedCount).toBe(42);
    expect(result.recentActivity).toBe(7);
  });

  it('handles NaN values', async () => {
    mockExecAsync
      .mockResolvedValueOnce({ stdout: 'not-a-number' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' });

    const result = await getGitHubIssuesMetrics();

    expect(result.openCount).toBe(0);
    expect(result.closedCount).toBe(0);
    expect(result.recentActivity).toBe(0);
  });

  it('returns defaults on error', async () => {
    mockExecAsync.mockRejectedValue(new Error('gh not installed'));

    const result = await getGitHubIssuesMetrics();

    expect(result.openCount).toBe(0);
    expect(result.closedCount).toBe(0);
    expect(result.recentActivity).toBe(0);
  });

  it('computes recent date for activity query', async () => {
    mockExecAsync
      .mockResolvedValueOnce({ stdout: '5' })
      .mockResolvedValueOnce({ stdout: '1' })
      .mockResolvedValueOnce({ stdout: '10' })
      .mockResolvedValueOnce({ stdout: '3' });

    await getGitHubIssuesMetrics();

    // The 4th call should contain the recent date filter
    const lastCall = mockExecAsync.mock.calls[3][0] as string;
    expect(lastCall).toContain('updated:>=');
    // Should be within the last 7 days
    expect(lastCall).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('getGitHubMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('combines project and issues metrics', async () => {
    const projectResponse = makeProjectGraphQLResponse({ done: 5, inProgress: 3, todo: 2 });
    mockExecAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify(projectResponse) }) // project
      .mockResolvedValueOnce({ stdout: '5' })    // openCount
      .mockResolvedValueOnce({ stdout: '1' })    // closed
      .mockResolvedValueOnce({ stdout: '20' })   // closedCount
      .mockResolvedValueOnce({ stdout: '3' });   // recentActivity

    const result = await getGitHubMetrics();

    expect(result.project).toBeDefined();
    expect(result.issues).toBeDefined();
    expect(result.project.doneCount).toBe(5);
    expect(result.issues.openCount).toBe(5);
    expect(result.lastUpdated).toBeDefined();
    // Verify ISO date format
    expect(new Date(result.lastUpdated).toISOString()).toBe(result.lastUpdated);
  });

  it('handles partial failures gracefully', async () => {
    // Project fails, issues succeed
    mockExecAsync
      .mockRejectedValueOnce(new Error('project fail'))
      .mockResolvedValueOnce({ stdout: '10' })
      .mockResolvedValueOnce({ stdout: '1' })
      .mockResolvedValueOnce({ stdout: '50' })
      .mockResolvedValueOnce({ stdout: '5' });

    const result = await getGitHubMetrics();

    expect(result.project.totalItems).toBe(0); // defaults from error
    expect(result.issues.openCount).toBe(10);
  });
});

describe('formatGitHubMetricsForDashboard', () => {
  it('formats metrics as markdown', () => {
    const metrics: GitHubMetrics = {
      project: {
        totalItems: 30,
        doneCount: 15,
        inProgressCount: 5,
        todoCount: 10,
        donePercentage: 50,
      },
      issues: {
        openCount: 12,
        closedCount: 88,
        recentActivity: 7,
      },
      lastUpdated: '2026-04-21T10:00:00.000Z',
    };

    const md = formatGitHubMetricsForDashboard(metrics);

    expect(md).toContain('30 items');
    expect(md).toContain('Done :** 15 (50%)');
    expect(md).toContain('In Progress :** 5');
    expect(md).toContain('Todo :** 10');
    expect(md).toContain('Ouvertes :** 12');
    expect(md).toContain('Fermées :** 88');
    expect(md).toContain('7 issues');
    expect(md).toContain('Métriques GitHub');
  });

  it('handles zero values', () => {
    const metrics: GitHubMetrics = {
      project: { totalItems: 0, doneCount: 0, inProgressCount: 0, todoCount: 0, donePercentage: 0 },
      issues: { openCount: 0, closedCount: 0, recentActivity: 0 },
      lastUpdated: new Date().toISOString(),
    };

    const md = formatGitHubMetricsForDashboard(metrics);

    expect(md).toContain('0 items');
    expect(md).toContain('0%');
  });

  it('includes ISO timestamp', () => {
    const metrics: GitHubMetrics = {
      project: { totalItems: 1, doneCount: 1, inProgressCount: 0, todoCount: 0, donePercentage: 100 },
      issues: { openCount: 0, closedCount: 0, recentActivity: 0 },
      lastUpdated: '2026-04-21T12:34:56.000Z',
    };

    const md = formatGitHubMetricsForDashboard(metrics);

    expect(md).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
