/**
 * Tests pour github-helpers.ts
 *
 * Couvre :
 * - getGitHubProjectMetrics : récupération métriques projet via GraphQL
 * - getGitHubIssuesMetrics : récupération métriques issues
 * - getGitHubMetrics : agrégation des métriques
 * - formatGitHubMetricsForDashboard : formatage markdown
 * - Gestion des erreurs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exec } from 'child_process';
import {
  getGitHubProjectMetrics,
  getGitHubIssuesMetrics,
  getGitHubMetrics,
  formatGitHubMetricsForDashboard,
  type GitHubMetrics
} from '../github-helpers.js';

// Mock exec
vi.mock('child_process', () => ({
  exec: vi.fn()
}));

const mockExec = vi.mocked(exec);

describe('github-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('getGitHubProjectMetrics', () => {
    it('should parse GraphQL response and extract metrics', async () => {
      const mockGraphQLResponse = {
        data: {
          user: {
            projectV2: {
              items: {
                totalCount: 100,
                nodes: [
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'Done', field: { name: 'Status' } }
                      ]
                    }
                  },
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'In Progress', field: { name: 'Status' } }
                      ]
                    }
                  },
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'Todo', field: { name: 'Status' } }
                      ]
                    }
                  },
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'Done', field: { name: 'Status' } }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      };

      mockExec.mockImplementationOnce((cmd, options, callback) => {
        // @ts-ignore - callback is optional
        if (typeof callback === 'function') {
          callback(null, { stdout: JSON.stringify(mockGraphQLResponse) }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubProjectMetrics();

      expect(metrics.totalItems).toBe(100);
      expect(metrics.doneCount).toBe(2);
      expect(metrics.inProgressCount).toBe(1);
      expect(metrics.todoCount).toBe(1);
      expect(metrics.donePercentage).toBe(2);
    });

    it('should handle case-insensitive status names', async () => {
      const mockGraphQLResponse = {
        data: {
          user: {
            projectV2: {
              items: {
                totalCount: 10,
                nodes: [
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'DONE', field: { name: 'Status' } },
                        { name: 'done', field: { name: 'OtherField' } }
                      ]
                    }
                  },
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'IN PROGRESS', field: { name: 'Status' } }
                      ]
                    }
                  },
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'TODO', field: { name: 'Status' } }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      };

      mockExec.mockImplementationOnce((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callback(null, { stdout: JSON.stringify(mockGraphQLResponse) }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubProjectMetrics();

      expect(metrics.doneCount).toBe(1);
      expect(metrics.inProgressCount).toBe(1);
      expect(metrics.todoCount).toBe(1);
    });

    it('should return zero metrics on GraphQL error', async () => {
      mockExec.mockImplementationOnce((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callback(new Error('GraphQL failed'), { stdout: '' }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubProjectMetrics();

      expect(metrics.totalItems).toBe(0);
      expect(metrics.doneCount).toBe(0);
      expect(metrics.donePercentage).toBe(0);
      expect(console.error).toHaveBeenCalled();
    });

    it('should handle empty items list', async () => {
      const mockGraphQLResponse = {
        data: {
          user: {
            projectV2: {
              items: {
                totalCount: 0,
                nodes: []
              }
            }
          }
        }
      };

      mockExec.mockImplementationOnce((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callback(null, { stdout: JSON.stringify(mockGraphQLResponse) }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubProjectMetrics();

      expect(metrics.totalItems).toBe(0);
      expect(metrics.doneCount).toBe(0);
      expect(metrics.inProgressCount).toBe(0);
      expect(metrics.todoCount).toBe(0);
      expect(metrics.donePercentage).toBe(0);
    });

    it('should handle items without status field', async () => {
      const mockGraphQLResponse = {
        data: {
          user: {
            projectV2: {
              items: {
                totalCount: 5,
                nodes: [
                  {
                    fieldValues: {
                      nodes: [
                        { name: 'Done', field: { name: 'Priority' } }
                      ]
                    }
                  },
                  {
                    fieldValues: {
                      nodes: []
                    }
                  }
                ]
              }
            }
          }
        }
      };

      mockExec.mockImplementationOnce((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callback(null, { stdout: JSON.stringify(mockGraphQLResponse) }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubProjectMetrics();

      expect(metrics.totalItems).toBe(5);
      expect(metrics.doneCount).toBe(0);
      expect(metrics.inProgressCount).toBe(0);
      expect(metrics.todoCount).toBe(0);
    });
  });

  describe('getGitHubIssuesMetrics', () => {
    it('should parse gh CLI output for issues metrics', async () => {
      let callCount = 0;
      mockExec.mockImplementation((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callCount++;
          if (callCount === 1) {
            // open issues
            callback(null, { stdout: '42' }, '');
          } else if (callCount === 2) {
            // closed issues (limit 1)
            callback(null, { stdout: '0' }, '');
          } else if (callCount === 3) {
            // search for closed count
            callback(null, { stdout: '150' }, '');
          } else if (callCount === 4) {
            // recent activity
            callback(null, { stdout: '7' }, '');
          }
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubIssuesMetrics();

      expect(metrics.openCount).toBe(42);
      expect(metrics.closedCount).toBe(150);
      expect(metrics.recentActivity).toBe(7);
    });

    it('should return zero metrics on exec error', async () => {
      mockExec.mockImplementation((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callback(new Error('gh not found'), { stdout: '' }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubIssuesMetrics();

      expect(metrics.openCount).toBe(0);
      expect(metrics.closedCount).toBe(0);
      expect(metrics.recentActivity).toBe(0);
      expect(console.error).toHaveBeenCalled();
    });

    it('should handle non-numeric output gracefully', async () => {
      let callCount = 0;
      mockExec.mockImplementation((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callCount++;
          if (callCount <= 4) {
            callback(null, { stdout: 'not a number' }, '');
          }
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubIssuesMetrics();

      expect(metrics.openCount).toBe(0);
      expect(metrics.closedCount).toBe(0);
      expect(metrics.recentActivity).toBe(0);
    });
  });

  describe('getGitHubMetrics', () => {
    it('should aggregate project and issues metrics', async () => {
      // Mock getGitHubProjectMetrics
      let callIndex = 0;
      mockExec.mockImplementation((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callIndex++;
          // Call 1: graphql for project metrics
          if (callIndex === 1 && cmd.includes('graphql')) {
            const mockGraphQLResponse = {
              data: {
                user: {
                  projectV2: {
                    items: {
                      totalCount: 50,
                      nodes: [
                        {
                          fieldValues: {
                            nodes: [
                              { name: 'Done', field: { name: 'Status' } }
                            ]
                          }
                        }
                      ]
                    }
                  }
                }
              }
            };
            callback(null, { stdout: JSON.stringify(mockGraphQLResponse) }, '');
          }
          // Call 2: open issues
          else if (callIndex === 2 && cmd.includes('--state open')) {
            callback(null, { stdout: '10' }, '');
          }
          // Call 3: closed issues (limit 1)
          else if (callIndex === 3 && cmd.includes('--state closed') && cmd.includes('--limit 1')) {
            callback(null, { stdout: '0' }, '');
          }
          // Call 4: search for closed count
          else if (callIndex === 4 && cmd.includes('search')) {
            callback(null, { stdout: '100' }, '');
          }
          // Call 5: recent activity
          else if (callIndex === 5 && cmd.includes('updated:>=')) {
            callback(null, { stdout: '5' }, '');
          }
          else {
            callback(null, { stdout: '0' }, '');
          }
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubMetrics();

      expect(metrics.project.totalItems).toBe(50);
      expect(metrics.project.doneCount).toBe(1);
      expect(metrics.issues.openCount).toBe(10);
      expect(metrics.issues.closedCount).toBe(100);
      expect(metrics.issues.recentActivity).toBe(5);
      expect(metrics.lastUpdated).toBeDefined();
    });

    it('should include timestamp in ISO format', async () => {
      const beforeTest = Date.now();

      mockExec.mockImplementation((cmd, options, callback) => {
        // @ts-ignore
        if (typeof callback === 'function') {
          callback(null, { stdout: '{}' }, '');
        }
        // @ts-ignore
        return { catch: vi.fn() };
      });

      const metrics = await getGitHubMetrics();

      const afterTest = Date.now();
      const metricsTime = new Date(metrics.lastUpdated).getTime();

      expect(metricsTime).toBeGreaterThanOrEqual(beforeTest);
      expect(metricsTime).toBeLessThanOrEqual(afterTest);
    });
  });

  describe('formatGitHubMetricsForDashboard', () => {
    it('should format metrics as markdown', () => {
      const metrics: GitHubMetrics = {
        project: {
          totalItems: 100,
          doneCount: 60,
          inProgressCount: 20,
          todoCount: 20,
          donePercentage: 60
        },
        issues: {
          openCount: 15,
          closedCount: 85,
          recentActivity: 8
        },
        lastUpdated: '2026-03-22T10:30:00.000Z'
      };

      const formatted = formatGitHubMetricsForDashboard(metrics);

      expect(formatted).toContain('### Métriques GitHub Project #67');
      expect(formatted).toContain('**Total :** 100 items');
      expect(formatted).toContain('**Done :** 60 (60%)');
      expect(formatted).toContain('**In Progress :** 20');
      expect(formatted).toContain('**Todo :** 20');
      expect(formatted).toContain('**Ouvertes :** 15');
      expect(formatted).toContain('**Fermées :** 85');
      expect(formatted).toContain('**Activité 7j :** 8 issues modifiées');
      expect(formatted).toContain('---');
    });

    it('should format date correctly using current time', () => {
      const metrics: GitHubMetrics = {
        project: {
          totalItems: 0,
          doneCount: 0,
          inProgressCount: 0,
          todoCount: 0,
          donePercentage: 0
        },
        issues: {
          openCount: 0,
          closedCount: 0,
          recentActivity: 0
        },
        lastUpdated: '2026-03-22T14:25:30.123Z'
      };

      const formatted = formatGitHubMetricsForDashboard(metrics);

      // formatGitHubMetricsForDashboard uses current time, not lastUpdated
      expect(formatted).toContain('**Dernière mise à jour :**');
      expect(formatted).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    });

    it('should handle zero values', () => {
      const metrics: GitHubMetrics = {
        project: {
          totalItems: 0,
          doneCount: 0,
          inProgressCount: 0,
          todoCount: 0,
          donePercentage: 0
        },
        issues: {
          openCount: 0,
          closedCount: 0,
          recentActivity: 0
        },
        lastUpdated: '2026-03-22T10:00:00.000Z'
      };

      const formatted = formatGitHubMetricsForDashboard(metrics);

      expect(formatted).toContain('**Total :** 0 items');
      expect(formatted).toContain('**Done :** 0 (0%)');
      expect(formatted).toContain('**In Progress :** 0');
      expect(formatted).toContain('**Todo :** 0');
    });
  });
});
