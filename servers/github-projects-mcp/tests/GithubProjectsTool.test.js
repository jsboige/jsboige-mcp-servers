const { setupTools } = require('../dist/tools.js');
const { getGitHubClient } = require('../dist/utils/github.js');

// Mock du client GitHub
jest.mock('../dist/utils/github.js', () => ({
  getGitHubClient: jest.fn().mockReturnValue({
    graphql: jest.fn(),
  }),
}));

// Mock du serveur MCP
const mockServer = {
  setRequestHandler: jest.fn(),
};

describe('GitHub Projects Tools', () => {
  let octokit;
  let tools;

  beforeEach(async () => {
    // Nettoyer les mocks avant chaque test
    jest.clearAllMocks();

    // Récupérer le client mocké
    octokit = getGitHubClient();
    
    // Configurer les outils avec le serveur mocké
    setupTools(mockServer);

    // Le premier appel configure le handler pour ListTools, le second pour CallTool.
    const listToolsHandler = mockServer.setRequestHandler.mock.calls[0][1];
    if (listToolsHandler) {
      const toolListResult = await listToolsHandler();
      tools = toolListResult.tools;
    } else {
      tools = [];
    }
  });

  describe('delete_project_item', () => {
    let deleteTool;

    beforeEach(() => {
        deleteTool = tools.find(t => t.name === 'delete_project_item');
        if (!deleteTool) {
            throw new Error("L'outil 'delete_project_item' est introuvable.");
        }
    });

    it('should successfully delete an item and return its ID', async () => {
      // Préparation de la réponse mockée de l'API GraphQL
      const mockApiResponse = {
        deleteProjectV2Item: {
          deletedItemId: 'DELETED_ID_123',
        },
      };
      octokit.graphql.mockResolvedValue(mockApiResponse);

      // Exécution de l'outil
      const result = await deleteTool.execute({
        project_id: 'PROJECT_ID_456',
        item_id: 'ITEM_ID_789',
      });

      // Vérifications
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(octokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining('deleteProjectV2Item'), // Vérifie que la mutation est correcte
        {
          projectId: 'PROJECT_ID_456',
          itemId: 'ITEM_ID_789',
        }
      );
      expect(result).toEqual({
        success: true,
        deleted_item_id: 'DELETED_ID_123',
      });
    });

    it('should return an error if the API call fails', async () => {
      // Préparation du mock pour simuler une erreur
      const errorMessage = 'API Error: Not found';
      octokit.graphql.mockRejectedValue(new Error(errorMessage));

      // Exécution
      const result = await deleteTool.execute({
        project_id: 'PROJECT_ID_456',
        item_id: 'ITEM_ID_789',
      });

      // Vérifications
      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should return an error if the API response does not contain the deleted item ID', async () => {
        // Mock d'une réponse invalide de l'API
        const mockInvalidResponse = {
            deleteProjectV2Item: null // ou {}
        };
        octokit.graphql.mockResolvedValue(mockInvalidResponse);

        // Exécution
        const result = await deleteTool.execute({
          project_id: 'PROJECT_ID_456',
          item_id: 'ITEM_ID_789',
        });
  
        // Vérification
        expect(result.success).toBe(false);
        expect(result.error).toContain('La réponse de l\'API n\'a pas retourné d\'ID d\'élément supprimé.');
      });
  });
});