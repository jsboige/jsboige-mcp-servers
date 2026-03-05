/**
 * Helpers pour les métriques GitHub Project et Issues
 *
 * @module utils/github-helpers
 * @version 1.0.0
 * @issue #546 Phase 2
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Métriques du GitHub Project #67
 */
export interface GitHubProjectMetrics {
  totalItems: number;
  doneCount: number;
  inProgressCount: number;
  todoCount: number;
  donePercentage: number;
}

/**
 * Métriques d'issues GitHub
 */
export interface GitHubIssuesMetrics {
  openCount: number;
  closedCount: number;
  recentActivity: number; // Nombre d'issues modifiées dans les derniers 7 jours
}

/**
 * Ensemble des métriques GitHub
 */
export interface GitHubMetrics {
  project: GitHubProjectMetrics;
  issues: GitHubIssuesMetrics;
  lastUpdated: string;
}

/**
 * Exécute une commande GraphQL via gh CLI
 *
 * @param query Requête GraphQL
 * @returns Résultat JSON parsé
 */
async function ghGraphQL(query: string): Promise<any> {
  const { stdout } = await execAsync(`gh api graphql -f query="${query.replace(/"/g, '\\"')}"`, {
    env: { ...process.env }
  });

  // Nettoyer les sauts de ligne et espaces parasites dans le JSON
  const cleaned = stdout.replace(/\n/g, '').replace(/\s+/g, ' ');
  return JSON.parse(cleaned);
}

/**
 * Récupère les métriques du Project #67 via GraphQL
 *
 * @returns Métriques du projet
 */
export async function getGitHubProjectMetrics(): Promise<GitHubProjectMetrics> {
  try {
    const result = await ghGraphQL(`
      {
        user(login: "jsboige") {
          projectV2(number: 67) {
            items(first: 100) {
              totalCount
              nodes {
                fieldValues(first: 10) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);

    const items = result.data.user.projectV2.items;
    const totalItems = items.totalCount;

    let doneCount = 0;
    let inProgressCount = 0;
    let todoCount = 0;

    // Compter les items par statut
    for (const item of items.nodes) {
      for (const fieldValue of item.fieldValues.nodes) {
        if (fieldValue.field?.name === 'Status') {
          const statusName = fieldValue.name?.toLowerCase() || '';
          if (statusName === 'done') {
            doneCount++;
          } else if (statusName === 'in progress') {
            inProgressCount++;
          } else if (statusName === 'todo') {
            todoCount++;
          }
        }
      }
    }

    const donePercentage = totalItems > 0 ? Math.round((doneCount / totalItems) * 100) : 0;

    return {
      totalItems,
      doneCount,
      inProgressCount,
      todoCount,
      donePercentage
    };
  } catch (error) {
    console.error('[GITHUB METRICS] Erreur lors de la récupération des métriques du projet:', error);
    // Retourner des valeurs par défaut en cas d'erreur
    return {
      totalItems: 0,
      doneCount: 0,
      inProgressCount: 0,
      todoCount: 0,
      donePercentage: 0
    };
  }
}

/**
 * Récupère les métriques des issues GitHub
 *
 * @returns Métriques des issues
 */
export async function getGitHubIssuesMetrics(): Promise<GitHubIssuesMetrics> {
  try {
    // Issues ouvertes
    const openResult = await execAsync('gh issue list --repo jsboige/roo-extensions --state open --json id --jq length', {
      env: { ...process.env }
    });
    const openCount = parseInt(openResult.stdout.trim()) || 0;

    // Issues fermées
    const closedResult = await execAsync('gh issue list --repo jsboige/roo-extensions --state closed --limit 1 --json id --jq length', {
      env: { ...process.env }
    });
    // gh ne retourne pas le total pour closed, on utilise search pour compter
    const searchResult = await execAsync('gh search issues --repo jsboige/roo-extensions --state closed --json number --jq length', {
      env: { ...process.env }
    });
    const closedCount = parseInt(searchResult.stdout.trim()) || 0;

    // Activité récente (issues modifiées dans les derniers 7 jours)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 7);
    const recentDateStr = recentDate.toISOString().split('T')[0];

    const recentResult = await execAsync(
      `gh issue list --repo jsboige/roo-extensions --state all --search "updated:>=${recentDateStr}" --json id --jq length`,
      { env: { ...process.env } }
    );
    const recentActivity = parseInt(recentResult.stdout.trim()) || 0;

    return {
      openCount,
      closedCount,
      recentActivity
    };
  } catch (error) {
    console.error('[GITHUB METRICS] Erreur lors de la récupération des métriques des issues:', error);
    return {
      openCount: 0,
      closedCount: 0,
      recentActivity: 0
    };
  }
}

/**
 * Récupère toutes les métriques GitHub
 *
 * @returns Ensemble des métriques GitHub
 */
export async function getGitHubMetrics(): Promise<GitHubMetrics> {
  const [project, issues] = await Promise.all([
    getGitHubProjectMetrics(),
    getGitHubIssuesMetrics()
  ]);

  return {
    project,
    issues,
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Formate les métriques GitHub en markdown pour le dashboard
 *
 * @param metrics Métriques GitHub
 * @returns Contenu markdown
 */
export function formatGitHubMetricsForDashboard(metrics: GitHubMetrics): string {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  return `### Métriques GitHub Project #67
**Dernière mise à jour :** ${now}

#### Progression Globale
- **Total :** ${metrics.project.totalItems} items
- **Done :** ${metrics.project.doneCount} (${metrics.project.donePercentage}%)
- **In Progress :** ${metrics.project.inProgressCount}
- **Todo :** ${metrics.project.todoCount}

#### Issues
- **Ouvertes :** ${metrics.issues.openCount}
- **Fermées :** ${metrics.issues.closedCount}
- **Activité 7j :** ${metrics.issues.recentActivity} issues modifiées

---
`;
}
