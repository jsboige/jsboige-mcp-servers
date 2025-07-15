// On ne peut pas tester le module 'tools.ts' directement à cause
// des problèmes de résolution de l'import './utils/github.js'.
// À la place, nous allons tester la *logique* de la fonction execute
// en l'isolant ici.

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import logger from '../src/logger';
import {
  getRepositoryId,
  executeCreateIssue,
  executeUpdateIssueState,
  executeDeleteProject,
  executeCreateProjectField,
  executeUpdateProjectItemField, // La fonction que nous allons tester
  executeDeleteProjectField
} from '../src/github-actions';

// Mock du logger pour éviter les erreurs
jest.mock('../src/logger', () => ({
    __esModule: true,
    default: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
}));


describe(' logique de update_issue_state', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
        (logger.error as jest.Mock).mockClear();
    });

    it('doit changer l\'état d\'une issue avec succès', async () => {
        const mockApiResponse = {
            updateIssue: {
                issue: { id: 'test-issue-id', number: 123, state: 'CLOSED' },
            },
        };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeUpdateIssueState(mockOctokit, {
            issueId: 'test-issue-id',
            state: 'CLOSED',
        });
        
        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(mockGraphql.mock.calls[0][0]).toContain('mutation UpdateIssue');
        expect(mockGraphql.mock.calls[0][1]).toEqual({ issueId: 'test-issue-id', state: 'CLOSED' });

        expect(result.success).toBe(true);
        expect(result.issue).toEqual({ id: 'test-issue-id', number: 123, state: 'CLOSED' });
    });

    it('doit gérer une erreur de l\'API GraphQL', async () => {
        const mockApiError = new Error("GraphQL Error");
        (mockApiError as any).response = { data: { errors: [{ message: 'Could not resolve to an issue' }] } };
        mockGraphql.mockRejectedValue(mockApiError);

        const result = await executeUpdateIssueState(mockOctokit, {
            issueId: 'invalid-id',
            state: 'OPEN',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Erreur GraphQL: Could not resolve to an issue');
        expect(logger.error).toHaveBeenCalled();
    });

    it('doit gérer un cas où l\'API ne retourne pas l\'issue attendue', async () => {
        const mockApiResponse = { updateIssue: { issue: null } };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeUpdateIssueState(mockOctokit, {
            issueId: 'test-issue-id',
            state: 'CLOSED',
        });
        
        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toBe("Erreur GraphQL: La mise à jour de l'issue a échoué ou n'a pas retourné les informations attendues.");
    });
});

describe('logique de delete_project', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
        (logger.error as jest.Mock).mockClear();
    });

    it('devrait retourner { success: true } après une suppression réussie', async () => {
        const mockApiResponse = {
            deleteProject: {
                project: { id: 'PROJECT_ID' },
            },
        };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeDeleteProject(mockOctokit, {
            projectId: 'PROJECT_ID',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true });
    });

    it('devrait retourner { success: false, message: "..." } en cas d\'erreur de l\'API', async () => {
        const mockError = new Error('Projet non trouvé');
        mockGraphql.mockRejectedValue(mockError);

        const result = await executeDeleteProject(mockOctokit, {
            projectId: 'UNKNOWN_PROJECT_ID',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            success: false,
            message: 'Erreur GraphQL: Projet non trouvé',
        });
        expect(logger.error).toHaveBeenCalled();
    });
});

describe('logique de getRepositoryId', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
    });

    it('devrait retourner l\'ID du dépôt quand il est trouvé', async () => {
        mockGraphql.mockResolvedValue({
            repository: {
                id: 'repo-id-123'
            }
        });
        const result = await getRepositoryId(mockOctokit, 'owner', 'repo');
        expect(result).toBe('repo-id-123');
        expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { owner: 'owner', repo: 'repo' });
    });

    it('devrait jeter une erreur si le dépôt n\'est pas trouvé', async () => {
        mockGraphql.mockResolvedValue({ repository: null });
        await expect(getRepositoryId(mockOctokit, 'owner', 'repo')).rejects.toThrow('Dépôt non trouvé : owner/repo');
    });
});

describe('logique de create_issue', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
        (logger.error as jest.Mock).mockClear();
    });

    it('doit créer une issue avec succès (sans projectId)', async () => {
        const mockApiResponse = {
            createIssue: {
                issue: { id: 'issue-1', number: 1, url: 'http://issue.url' }
            }
        };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeCreateIssue(mockOctokit, {
            repositoryId: 'repo-1',
            title: 'Test Issue',
            body: 'This is a test'
        });

        expect(result.success).toBe(true);
        expect(result.issue).toEqual({ id: 'issue-1', number: 1, url: 'http://issue.url' });
        expect(result.projectItemId).toBeUndefined();
        expect(mockGraphql).toHaveBeenCalledTimes(1);
    });

    it('doit créer une issue et l\'ajouter à un projet', async () => {
        const createIssueResponse = {
            createIssue: { issue: { id: 'issue-2', number: 2, url: 'http://issue.url/2' } }
        };
        const addItemResponse = {
            addProjectV2ItemById: { item: { id: 'project-item-1' } }
        };
        mockGraphql.mockResolvedValueOnce(createIssueResponse).mockResolvedValueOnce(addItemResponse);

        const result = await executeCreateIssue(mockOctokit, {
            repositoryId: 'repo-1',
            title: 'Test with Project',
            projectId: 'project-1'
        });

        expect(result.success).toBe(true);
        expect(result.issue?.id).toBe('issue-2');
        expect(result.projectItemId).toBe('project-item-1');
        expect(mockGraphql).toHaveBeenCalledTimes(2);
    });

    it('doit gérer un échec de la création de l\'issue', async () => {
        mockGraphql.mockRejectedValue(new Error("API Error"));

        const result = await executeCreateIssue(mockOctokit, {
            repositoryId: 'repo-1',
            title: 'Failed Issue'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('API Error');
        expect(logger.error).toHaveBeenCalled();
    });

    it('doit gérer un échec de l\'ajout au projet', async () => {
        const createIssueResponse = {
            createIssue: { issue: { id: 'issue-3', number: 3, url: 'http://issue.url/3' } }
        };
        mockGraphql.mockResolvedValueOnce(createIssueResponse).mockRejectedValueOnce(new Error("Project Error"));

        const result = await executeCreateIssue(mockOctokit, {
            repositoryId: 'repo-1',
            title: 'Test with Project Fail',
            projectId: 'project-1'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Project Error');
        expect(logger.error).toHaveBeenCalled();
    });
});

describe('logique de create_project_field', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
        (logger.error as jest.Mock).mockClear();
    });

    it('devrait créer un champ de projet avec succès', async () => {
        const mockApiResponse = {
            createProjectV2Field: {
                projectV2Field: { id: 'field-123', name: 'Nouveau Champ' },
            },
        };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeCreateProjectField(mockOctokit, {
            projectId: 'project-id-456',
            name: 'Nouveau Champ',
            dataType: 'TEXT',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(mockGraphql.mock.calls[0][0]).toContain('createProjectV2Field');
        expect(mockGraphql.mock.calls[0][1]).toEqual({
            projectId: 'project-id-456',
            name: 'Nouveau Champ',
            dataType: 'TEXT',
        });

        expect(result.success).toBe(true);
        expect(result.field).toEqual({ id: 'field-123', name: 'Nouveau Champ' });
    });

    it('devrait gérer une erreur de l\'API GraphQL lors de la création d\'un champ', async () => {
        const mockApiError = new Error("GraphQL Error");
        (mockApiError as any).response = { data: { errors: [{ message: 'Invalid project ID' }] } };
        mockGraphql.mockRejectedValue(mockApiError);

        const result = await executeCreateProjectField(mockOctokit, {
            projectId: 'invalid-id',
            name: 'Champ Échoué',
            dataType: 'TEXT',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Erreur GraphQL: Invalid project ID');
        expect(logger.error).toHaveBeenCalled();
    });

    it('devrait gérer le cas où l\'API ne retourne pas le champ attendu', async () => {
        const mockApiResponse = { createProjectV2Field: { projectV2Field: null } };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeCreateProjectField(mockOctokit, {
            projectId: 'project-id-789',
            name: 'Champ Inattendu',
            dataType: 'NUMBER',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toBe("Erreur GraphQL: La création du champ a échoué ou n'a pas retourné les informations attendues.");
    });
});

describe('logique de update_project_item_field', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
        (logger.error as jest.Mock).mockClear();
    });

    it('devrait mettre à jour la valeur texte d\'un item avec succès', async () => {
        const mockApiResponse = {
            updateProjectV2ItemFieldValue: {
                projectV2Item: { id: 'item-id-123' },
            },
        };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeUpdateProjectItemField(mockOctokit, {
            projectId: 'project-id-456',
            itemId: 'item-id-123',
            fieldId: 'field-id-789',
            fieldType: 'text',
            value: 'Nouvelle valeur texte',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(mockGraphql.mock.calls[0][0]).toContain('updateProjectV2ItemFieldValue');
        expect(mockGraphql.mock.calls[0][1]).toEqual({
            projectId: 'project-id-456',
            itemId: 'item-id-123',
            fieldId: 'field-id-789',
            text: 'Nouvelle valeur texte',
        });

        expect(result.success).toBe(true);
        expect(result.item).toEqual({ id: 'item-id-123' });
    });

    it('devrait gérer une erreur de l\'API GraphQL', async () => {
        const mockApiError = new Error("GraphQL Error");
        (mockApiError as any).response = { data: { errors: [{ message: 'Field value is invalid' }] } };
        mockGraphql.mockRejectedValue(mockApiError);

        const result = await executeUpdateProjectItemField(mockOctokit, {
            projectId: 'project-id-456',
            itemId: 'item-id-123',
            fieldId: 'field-id-789',
            fieldType: 'text',
            value: 'valeur invalide',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Erreur GraphQL: Field value is invalid');
        expect(logger.error).toHaveBeenCalled();
    });

    it('devrait gérer le cas où l\'API ne retourne pas l\'item attendu', async () => {
        const mockApiResponse = { updateProjectV2ItemFieldValue: { projectV2Item: null } };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeUpdateProjectItemField(mockOctokit, {
            projectId: 'project-id-456',
            itemId: 'item-id-123',
            fieldId: 'field-id-789',
            fieldType: 'text',
            value: 'une valeur',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toBe("Erreur GraphQL: La mise à jour du champ a échoué ou n'a pas retourné les informations attendues.");
    });
});

describe('logique de delete_project_field', () => {
    const mockGraphql = jest.fn<(...args: any[]) => any>();
    const mockOctokit = {
        graphql: mockGraphql,
    };

    beforeEach(() => {
        mockGraphql.mockClear();
        (logger.error as jest.Mock).mockClear();
    });

    it('devrait supprimer un champ de projet avec succès', async () => {
        const mockApiResponse = {
            deleteProjectV2Field: {
                projectV2Field: { id: 'field-id-to-delete' },
            },
        };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeDeleteProjectField(mockOctokit, {
            projectId: 'project-id-123',
            fieldId: 'field-id-to-delete',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(mockGraphql.mock.calls[0][0]).toContain('deleteProjectV2Field');
        expect(mockGraphql.mock.calls[0][1]).toEqual({
            projectId: 'project-id-123',
            fieldId: 'field-id-to-delete',
        });

        expect(result.success).toBe(true);
        expect(result.deletedFieldId).toBe('field-id-to-delete');
    });

    it('devrait gérer une erreur de l\'API GraphQL lors de la suppression', async () => {
        const mockApiError = new Error("GraphQL Error");
        (mockApiError as any).response = { data: { errors: [{ message: 'Field not found' }] } };
        mockGraphql.mockRejectedValue(mockApiError);

        const result = await executeDeleteProjectField(mockOctokit, {
            projectId: 'project-id-123',
            fieldId: 'invalid-field-id',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Erreur GraphQL: Field not found');
        expect(logger.error).toHaveBeenCalled();
    });

    it('devrait gérer le cas où l\'API ne retourne pas le champ supprimé attendu', async () => {
        const mockApiResponse = { deleteProjectV2Field: { projectV2Field: null } };
        mockGraphql.mockResolvedValue(mockApiResponse);

        const result = await executeDeleteProjectField(mockOctokit, {
            projectId: 'project-id-123',
            fieldId: 'field-id-without-return',
        });

        expect(mockGraphql).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toBe("Erreur GraphQL: La suppression du champ a échoué ou n'a pas retourné les informations attendues.");
    });
});