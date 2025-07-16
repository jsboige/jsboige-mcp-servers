import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { Octokit } from '@octokit/core';
import {
  analyze_task_complexity,
  executeCreateIssue,
  executeDeleteProject,
  executeGetProjectItems,
  getProjectItemDetails,
  getRepositoryId,
} from '../src/github-actions';
import { getGitHubClient } from '../src/utils/github';
import { setupTools } from '../src/tools'; // Pour créer le projet
import dotenv from 'dotenv';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement depuis le fichier .env de test
dotenv.config({ path: path.resolve(__dirname, './.env') });

const TEST_GITHUB_OWNER = process.env.TEST_GITHUB_OWNER;
const TEST_GITHUB_REPO = process.env.TEST_GITHUB_REPO;
const TEST_PROJECT_TITLE = `Test Project - ${Date.now()}`;

// Helper function for polling to handle API eventual consistency
const poll = async (
  action: () => Promise<boolean>,
  errorMessage: string,
  timeout = 20000, // 20 seconds
  interval = 3000  // 3 seconds
) => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await action()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Polling timed out: ${errorMessage}`);
};

describe('GitHub Actions E2E Tests', () => {
  let octokit: Octokit;
  let testProjectId: string;
  let testIssueNodeId: string;
  let testProjectItemId: string;
  let repositoryId: string;

  beforeAll(async () => {
    if (!TEST_GITHUB_OWNER || !TEST_GITHUB_REPO) {
      throw new Error('Les variables d\'environnement TEST_GITHUB_OWNER et TEST_GITHUB_REPO sont requises.');
    }

    octokit = getGitHubClient();

    repositoryId = await getRepositoryId(octokit, TEST_GITHUB_OWNER, TEST_GITHUB_REPO);

    // 1. Créer un projet de test (logique copiée de l'outil 'create_project')
    let ownerId;
    try {
        const userQuery = await octokit.graphql<{ user: { id: string } }>(`query($login: String!) { user(login: $login) { id } }`, { login: TEST_GITHUB_OWNER });
        ownerId = userQuery.user?.id;
    } catch (e) { /* ignorer */ }

    if (!ownerId) {
        try {
            const orgQuery = await octokit.graphql<{ organization: { id: string } }>(`query($login: String!) { organization(login: $login) { id } }`, { login: TEST_GITHUB_OWNER });
            ownerId = orgQuery.organization?.id;
        } catch (e) { /* ignorer */ }
    }
    if (!ownerId) throw new Error(`Impossible de trouver l'ID pour le propriétaire ${TEST_GITHUB_OWNER}`);

    const createProjectMutation = `
        mutation CreateProject($input: CreateProjectV2Input!) {
            createProjectV2(input: $input) {
                projectV2 { id, title, number, url }
            }
        }`;
    const createProjectResult = await octokit.graphql<any>(createProjectMutation, {
        input: {
            ownerId,
            title: TEST_PROJECT_TITLE,
            repositoryId,
        }
    });

    const project = createProjectResult.createProjectV2?.projectV2;
    if (!project?.id) {
        console.error("Détails de l'échec de la création du projet:", createProjectResult);
        throw new Error('Échec de la création du projet de test.');
    }
    testProjectId = project.id;
    
    // La vérification se fait déjà sur la variable 'project' quelques lignes au-dessus.
    // Je supprime ce bloc redondant et incorrect.


    // 2. Créer une issue de test et l'ajouter au projet
    const issueResult = await executeCreateIssue(octokit, {
      repositoryId,
      title: 'Test Issue for Complexity Analysis',
      body: 'This is a simple test issue.',
      projectId: testProjectId,
    });

    if (!issueResult.success || !issueResult.issue?.id || !issueResult.projectItemId) {
      throw new Error('Échec de la création de l\'issue de test.');
    }
    testIssueNodeId = issueResult.issue.id;
    testProjectItemId = issueResult.projectItemId;
  }, 60000); // Timeout de 60s pour les opérations GitHub

  afterAll(async () => {
    if (testProjectId) {
      // On s'attend à ce que la suppression échoue si le projet n'existe plus,
      // ou réussisse. Dans le cadre du test, nous ne voulons pas faire échouer
      // le nettoyage si le projet a déjà été supprimé.
      // Le test original échouait car il ne gérait pas l'erreur de l'API.
      // Le nouveau code lance une exception.
      try {
        await executeDeleteProject(octokit, { projectId: testProjectId });
      } catch (error) {
        console.log(`Le nettoyage du projet a échoué (ce qui peut être normal si le projet a été supprimé par le test) : ${(error as Error).message}`);
      }
    }
  }, 60000);

  // Helper function to create a test issue and return its item ID
  const createTestItem = async (title: string, body: string): Promise<string> => {
    const issueResult = await executeCreateIssue(octokit, {
      repositoryId,
      title,
      body,
      projectId: testProjectId,
    });
    if (!issueResult.success || !issueResult.projectItemId) {
      throw new Error(`Failed to create test item: ${title}`);
    }
    return issueResult.projectItemId;
  };

  it('should filter items by title contains (client-side)', async () => {
    // Créer des items de test pour ce test spécifique
    await createTestItem('Feature: User Authentication', 'Implement user login and registration.');
    await createTestItem('Feature: User Profile', 'Users should have a profile page.');
    await createTestItem('Bug: Fix login button', 'The login button is not working on Safari.');

    // Attendre que l'API reflète les nouveaux items en utilisant le polling
    await poll(
      async () => {
        const result = await executeGetProjectItems(octokit, {
          projectId: testProjectId,
        });
        const featureItems = result.items.filter((item: any) => item.content?.title?.includes('Feature'));
        return featureItems.length >= 2;
      },
      'Failed to find 2 "Feature" items after polling.'
    );

    // Effectuer le test de filtrage final
    const featureItemsResult = await executeGetProjectItems(octokit, {
      projectId: testProjectId,
      filterOptions: { titleContains: 'Feature' },
    });
    expect(featureItemsResult.success).toBe(true);
    expect(featureItemsResult.items.length).toBe(2);
    expect(featureItemsResult.items.every((item: any) => item.content.title.includes('Feature'))).toBe(true);

    const bugItemsResult = await executeGetProjectItems(octokit, {
      projectId: testProjectId,
      filterOptions: { titleContains: 'Bug' },
    });
    expect(bugItemsResult.success).toBe(true);
    expect(bugItemsResult.items.length).toBe(1);
    expect(bugItemsResult.items[0].content.title).toContain('Bug');
  }, 60000);

  it('should return "moyenne" complexity for a standard task', async () => {
    const itemId = await createTestItem('Standard Task', 'This is a standard task with a description of reasonable length that should result in medium complexity.');
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: 0,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('moyenne');
  });

  it('should return "élevée" complexity for a long task', async () => {
    const longBody = 'This is a very long task description. '.repeat(20) + 'It requires a lot of effort and careful planning. The implementation details are complex and involve multiple components interacting with each other. We need to be very careful with this one to avoid introducing regressions in other parts of the system.';
    const itemId = await createTestItem('Long Task', longBody);
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: 0,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('élevée');
    expect(result.result?.reasoning).toContain('> 300 caractères');
  });

  it('should return "élevée" complexity for a task with critical keywords', async () => {
    const itemId = await createTestItem('Critical Bug Task', 'We need to investigate this critical bug immediately. It is causing a major outage.');
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: 0,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('élevée');
    expect(result.result?.reasoning).toContain('mot-clé');
  });
});

import { checkReadOnlyMode, checkRepoPermissions } from '../src/security';

describe('Security Features', () => {

  afterEach(() => {
    // Nettoyer les variables d'environnement après chaque test
    delete process.env.GITHUB_PROJECTS_READ_ONLY;
    delete process.env.GITHUB_PROJECTS_ALLOWED_REPOS;
  });

  it('should block write operations when in read-only mode', () => {
    process.env.GITHUB_PROJECTS_READ_ONLY = 'true';
    
    expect(() => checkReadOnlyMode()).toThrow('Read-only mode is enabled.');
  });

  it('should block operations on unauthorized repositories', () => {
    process.env.GITHUB_PROJECTS_ALLOWED_REPOS = 'owner/allowed-repo,another/allowed-repo';
    
    expect(() => checkRepoPermissions('unauthorized', 'repo')).toThrow("Access denied: Repository 'unauthorized/repo' is not in the allowed list.");
  });

  it('should allow operations on authorized repositories', () => {
    process.env.GITHUB_PROJECTS_ALLOWED_REPOS = 'owner/allowed-repo,another/allowed-repo';
    
    expect(() => checkRepoPermissions('owner', 'allowed-repo')).not.toThrow();
  });

  it('should allow all operations when no restrictions are set', () => {
    // No env variables set
    expect(() => checkReadOnlyMode()).not.toThrow();
    expect(() => checkRepoPermissions('any', 'repo')).not.toThrow();
  });
});