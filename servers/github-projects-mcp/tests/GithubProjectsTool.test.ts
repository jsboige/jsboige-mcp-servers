import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { Octokit } from '@octokit/core';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getGitHubClient, GitHubAccount } from '../src/utils/github';
import {
  analyze_task_complexity,
  archiveProjectItem,
  executeCreateIssue,
  executeDeleteProject,
  executeGetProjectItems,
  getProjectItemDetails,
  getRepositoryId,
  unarchiveProjectItem,
} from '../src/github-actions';
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
  let accounts: GitHubAccount[];
  let testProjectId: string;
  let testIssueNodeId: string;
  let testProjectItemId: string;
  let repositoryId: string;
  let tools: Tool[];

  beforeAll(async () => {
    if (!TEST_GITHUB_OWNER || !TEST_GITHUB_REPO) {
      throw new Error('Les variables d\'environnement TEST_GITHUB_OWNER et TEST_GITHUB_REPO sont requises.');
    }

    accounts = [{ owner: TEST_GITHUB_OWNER!, token: process.env.GITHUB_TOKEN! }];
    octokit = getGitHubClient(TEST_GITHUB_OWNER!, accounts);
    tools = setupTools(null as any, accounts) as any;

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
      console.error('Failed to create test item:', issueResult);
      throw new Error(`Failed to create test item: ${title} - ${JSON.stringify(issueResult)}`);
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

    // Attendre que l'API reflète également l'item "Bug"
    await poll(
      async () => {
        const result = await executeGetProjectItems(octokit, {
          projectId: testProjectId,
        });
        const bugItems = result.items.filter((item: any) => item.content?.title?.includes('Bug'));
        return bugItems.length >= 1;
      },
      'Failed to find 1 "Bug" item after polling.'
    );

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
    
    // Obtenir le numéro du projet de test
    const listProjectsTool = tools.find(t => t.name === 'list_projects') as any;
    const allProjects = await listProjectsTool.execute({ owner: TEST_GITHUB_OWNER! });
    const projectInfo = allProjects.projects.find((p: any) => p.id === testProjectId);
    
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: projectInfo.number,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('moyenne');
  });

  it('should return "élevée" complexity for a long task', async () => {
    const longBody = 'This is a very long task description. '.repeat(20) + 'It requires a lot of effort and careful planning. The implementation details are complex and involve multiple components interacting with each other. We need to be very careful with this one to avoid introducing regressions in other parts of the system.';
    const itemId = await createTestItem('Long Task', longBody);
    
    // Obtenir le numéro du projet de test
    const listProjectsTool = tools.find(t => t.name === 'list_projects') as any;
    const allProjects = await listProjectsTool.execute({ owner: TEST_GITHUB_OWNER! });
    const projectInfo = allProjects.projects.find((p: any) => p.id === testProjectId);
    
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: projectInfo.number,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('élevée');
    expect(result.result?.reasoning).toContain('> 300 caractères');
  });

  it('should return "élevée" complexity for a task with critical keywords', async () => {
    const itemId = await createTestItem('Critical Bug Task', 'We need to investigate this critical bug immediately. It is causing a major outage.');
    
    // Obtenir le numéro du projet de test
    const listProjectsTool = tools.find(t => t.name === 'list_projects') as any;
    const allProjects = await listProjectsTool.execute({ owner: TEST_GITHUB_OWNER! });
    const projectInfo = allProjects.projects.find((p: any) => p.id === testProjectId);
    
    const result = await analyze_task_complexity(octokit, {
      owner: TEST_GITHUB_OWNER!,
      repo: TEST_GITHUB_REPO!,
      projectNumber: projectInfo.number,
      itemId: itemId,
    });
    expect(result.success).toBe(true);
    expect(result.result?.complexity).toBe('élevée');
    expect(result.result?.reasoning).toContain('mot-clé');
  });

  describe('Project Item Archiving', () => {
    it('should archive and unarchive a project item', async () => {
      // 1. Create a draft issue to have a clean state
      const draftIssueQuery = `mutation($projectId: ID!, $title: String!, $body: String) { addProjectV2DraftIssue(input: {projectId: $projectId, title: $title, body: $body}) { projectItem { id } } }`;
      const draftIssueResult = await octokit.graphql<any>(draftIssueQuery, {
        projectId: testProjectId,
        title: 'Test Draft for Archiving',
        body: 'This is a test draft.',
      });
      const itemId = draftIssueResult.addProjectV2DraftIssue?.projectItem?.id;
      expect(itemId).toBeDefined();

      // 2. Archive the item
      await expect(
        archiveProjectItem(octokit, {
          projectId: testProjectId,
          itemId: itemId,
        })
      ).resolves.not.toThrow();

      // 3. Unarchive the item
      await expect(
        unarchiveProjectItem(octokit, {
          projectId: testProjectId,
          itemId: itemId,
        })
      ).resolves.not.toThrow();
    }, 60000);
  });
    describe('Project Management (CRUD)', () => {
        it('should create, get, update, and delete a project', async () => {
            const createTool = tools.find(t => t.name === 'create_project') as any;
            const getTool = tools.find(t => t.name === 'get_project') as any;
            const updateTool = tools.find(t => t.name === 'update_project') as any;
            const deleteTool = tools.find(t => t.name === 'delete_project') as any;

            const initialTitle = `CRUD Sub-Test - ${Date.now()}`;

            const createResult = await createTool.execute({ owner: TEST_GITHUB_OWNER!, title: initialTitle });
            expect(createResult.success).toBe(true);
            const tempProjectId = createResult.project.id;
            const tempProjectNumber = createResult.project.number;

            const getResult = await getTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: tempProjectNumber });
            expect(getResult.project.title).toBe(initialTitle);

            const updatedTitle = `CRUD Sub-Test - UPDATED`;
            await updateTool.execute({ owner: TEST_GITHUB_OWNER!, project_id: tempProjectId, title: updatedTitle });
            
            await poll(async () => {
                const getUpdatedResult = await getTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: tempProjectNumber});
                return getUpdatedResult.success && getUpdatedResult.project.title === updatedTitle;
            }, 'Project title was not updated.');

            await deleteTool.execute({ owner: TEST_GITHUB_OWNER!, projectId: tempProjectId });
            
            const getDeletedResult = await getTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: tempProjectNumber });
            expect(getDeletedResult.success).toBe(false);

        }, 60000);
    });
    describe('Project Field Management', () => {
        it('should create, update, and delete a project field', async () => {
            const createFieldTool = tools.find(t => t.name === 'create_project_field') as any;
            const updateFieldTool = tools.find(t => t.name === 'update_project_field') as any;
            const deleteFieldTool = tools.find(t => t.name === 'delete_project_field') as any;
            const getProjectTool = tools.find(t => t.name === 'get_project') as any;
            
            // On a besoin du numéro du projet principal pour retrouver les champs plus tard
            let mainProject = await getProjectTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: 0, project_id: testProjectId });
            if (!mainProject.success) {
                // Fallback si la recherche par ID n'est pas implémentée ou échoue, trouver via le titre
                const listProjectsTool = tools.find(t => t.name === 'list_projects') as any;
                const allProjects = await listProjectsTool.execute({ owner: TEST_GITHUB_OWNER!});
                const projectInfo = allProjects.projects.find((p: any) => p.id === testProjectId);
                mainProject = await getProjectTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: projectInfo.number });
            }
            const testProjectNumber = mainProject.project.number;
            
            const initialFieldName = `Test Field - ${Date.now()}`;

            // 1. Create Field
            const createResult = await createFieldTool.execute({ owner: TEST_GITHUB_OWNER!, projectId: testProjectId, name: initialFieldName, dataType: 'TEXT' });
            expect(createResult.success).toBe(true);
            const createdFieldId = createResult.field.id;

            // 2. Update Field
            const updatedFieldName = `Test Field - UPDATED ${Date.now()}`;
            await updateFieldTool.execute({ owner: TEST_GITHUB_OWNER!, projectId: testProjectId, fieldId: createdFieldId, name: updatedFieldName });

            await poll(async () => {
                const getResult = await getProjectTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: testProjectNumber });
                if (!getResult.success) return false;
                const field = getResult.project.fields.nodes.find((f: any) => f.id === createdFieldId);
                return field?.name === updatedFieldName;
            }, `Field name was not updated to "${updatedFieldName}"`);

            // 3. Delete Field
            await deleteFieldTool.execute({ owner: TEST_GITHUB_OWNER!, projectId: testProjectId, fieldId: createdFieldId });
            
            await poll(async () => {
                const getFinalResult = await getProjectTool.execute({ owner: TEST_GITHUB_OWNER!, project_number: testProjectNumber });
                if (!getFinalResult.success) return false;
                const fieldExists = getFinalResult.project.fields.nodes.some((f: any) => f.id === createdFieldId);
                return !fieldExists;
            }, `Field with ID ${createdFieldId} was not deleted.`);
            
        }, 60000);
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
    expect(() => checkReadOnlyMode()).not.toThrow();
    expect(() => checkRepoPermissions('any', 'repo')).not.toThrow();
  });
});
