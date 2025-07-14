// On ne peut pas tester le module 'tools.ts' directement à cause
// des problèmes de résolution de l'import './utils/github.js'.
// À la place, nous allons tester la *logique* de la fonction execute
// en l'isolant ici.

import logger from '../src/logger';
import { executeUpdateIssueState } from '../src/github-actions';

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
    const mockGraphql = jest.fn();
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