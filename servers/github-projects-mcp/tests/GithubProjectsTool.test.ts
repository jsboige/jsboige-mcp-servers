import { Octokit } from '@octokit/core';
import {
  analyze_task_complexity,
  executeCreateIssue,
  executeDeleteProject,
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
      await executeDeleteProject(octokit, { projectId: testProjectId });
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

  it('should return "faible" complexity for a short task', async () => {
    const itemId = await createTestItem('Short Task', 'Just do it.');
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: 0,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('faible');
    expect(result.result?.reasoning).toContain('< 50 caractères');
  });

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