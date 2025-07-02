const { GithubProjectsTool } = require('../src/tools/GithubProjectsTool');
const fetch = require('node-fetch');

jest.mock('node-fetch');

const { Response } = jest.requireActual('node-fetch');

describe('GithubProjectsTool', () => {
  let tool;
  
  beforeEach(() => {
    // 1. Configurer l'environnement en premier
    process.env.GITHUB_PAT = 'test-pat';

    // 2. Instancier l'outil après la configuration
    tool = new GithubProjectsTool();

    // 3. Nettoyer les mocks
    fetch.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // 1. Restaurer les mocks
    console.log.mockRestore();
    console.error.mockRestore();

    // 2. Nettoyer l'environnement
    delete process.env.GITHUB_PAT;
  });

  it('should return a list of repository names on successful API call', async () => {
    const mockData = {
      items: [
        {
          full_name: 'test/repo1',
          description: 'A test repo',
          stargazers_count: 10,
          forks_count: 5,
          open_issues_count: 2,
          html_url: 'https://github.com/test/repo1'
        },
      ],
    };
    fetch.mockReturnValue(Promise.resolve(new Response(JSON.stringify(mockData))));

    const input = { subcommand: 'search-repo', query: 'test' };
    const result = await tool.execute(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://api.github.com/search/repositories?q=test');
    expect(result.results).toEqual([
      'Repository: test/repo1',
      'Description: A test repo',
      'Stars: 10',
      'Forks: 5',
      'Open Issues: 2',
      'URL: https://github.com/test/repo1'
    ]);
  });

  it('should return an error message on failed API call', async () => {
    fetch.mockReturnValue(Promise.resolve(new Response('Error', { status: 500 })));

    const input = { subcommand: 'search-repo', query: 'test' };
    const result = await tool.execute(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual(['Error: GitHub API returned 500: Internal Server Error']);
  });

  it('should handle network errors gracefully', async () => {
    fetch.mockReturnValue(Promise.reject(new Error('Network error')));

    const input = { subcommand: 'search-repo', query: 'test' };
    const result = await tool.execute(input);
    
    expect(result.results).toEqual(['Error: Network error']);
  });

  it('should return an error for an unknown subcommand', async () => {
    const input = { subcommand: 'unknown', query: 'test' };
    const result = await tool.execute(input);
    expect(result.results).toEqual(['Unknown subcommand: unknown']);
  });

  describe('list-issues', () => {
    it('should return a list of issues for a repository', async () => {
      const mockData = [
        { number: 1, title: 'Test issue 1' },
        { number: 2, title: 'Test issue 2' },
      ];
      fetch.mockReturnValue(Promise.resolve(new Response(JSON.stringify(mockData))));

      const input = { subcommand: 'list-issues', query: 'test/repo' };
      const result = await tool.execute(input);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/test/repo/issues');
      expect(result.results).toEqual(['#1: Test issue 1', '#2: Test issue 2']);
    });

    it('should return a message if no issues are found', async () => {
      fetch.mockReturnValue(Promise.resolve(new Response(JSON.stringify([]))));

      const input = { subcommand: 'list-issues', query: 'test/repo' };
      const result = await tool.execute(input);

      expect(result.results).toEqual(['No issues found for this repository.']);
    });
  });

  describe('list-projects', () => {
    it('should correctly list all projects for the authenticated user', async () => {
      const mockData = {
        data: {
          viewer: {
            projectsV2: {
              nodes: [
                { id: 'PVT_001', title: 'Project Alpha' },
                { id: 'PVT_002', title: 'Project Beta' },
              ],
            },
          },
        },
      };
      
      fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockData),
      });

      const input = { subcommand: 'list-projects', query: '' };
      const result = await tool.execute(input);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('https://api.github.com/graphql', expect.any(Object));
      const fetchOptions = fetch.mock.calls[0][1];
      expect(fetchOptions.headers.Authorization).toBe('Bearer test-pat');

      expect(result.results).toEqual([
        'Project ID: PVT_001, Title: Project Alpha',
        'Project ID: PVT_002, Title: Project Beta',
      ]);
    });

    it('should return an error if GITHUB_PAT is not set', async () => {
        delete process.env.GITHUB_PAT;
        tool = new GithubProjectsTool(); // Re-instantiate to read the new env
  
        const input = { subcommand: 'list-projects', query: '' };
        const result = await tool.execute(input);
  
        expect(result.results).toEqual(['Error: GitHub PAT not found in environment variables (GITHUB_PAT)']);
    });
  });

  describe('list-items', () => {
    it('should list items for a specific project ID', async () => {
      const mockData = {
        data: {
          node: {
            items: {
              nodes: [
                { id: 'ITEM_1', content: { title: 'First Item' } },
                { id: 'ITEM_2', content: { title: 'Second Item' } },
              ],
            },
          },
        },
      };

      fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockData),
      });

      const input = { subcommand: 'list-items', query: '--project-id PVT_123' };
      const result = await tool.execute(input);

      expect(fetch).toHaveBeenCalledTimes(1);
      const fetchOptions = fetch.mock.calls[0][1];
      const body = JSON.parse(fetchOptions.body);
      expect(body.variables.projectId).toBe('PVT_123');

      expect(result.results).toEqual([
        'ID: ITEM_1, Title: First Item',
        'ID: ITEM_2, Title: Second Item',
      ]);
    });

    it('should return an error if --project-id is missing', async () => {
        const input = { subcommand: 'list-items', query: '' };
        const result = await tool.execute(input);
        expect(result.results).toEqual(['Error: --project-id is required.']);
    });
  });

  describe('create-item', () => {
    it('should create a new item in a project', async () => {
      const mockData = {
        data: {
          addProjectV2ItemById: {
            item: {
              id: 'NEW_ITEM_ID',
            },
          },
        },
      };

      fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockData),
      });

      const input = { subcommand: 'create-item', query: '--project-id PVT_123 --title "Nouveau Ticket"' };
      const result = await tool.execute(input);

      expect(fetch).toHaveBeenCalledTimes(1);
      const fetchOptions = fetch.mock.calls[0][1];
      const body = JSON.parse(fetchOptions.body);
      expect(body.variables).toEqual({ projectId: 'PVT_123', title: 'Nouveau Ticket' });
      expect(result.results).toEqual(['Successfully created item with ID: NEW_ITEM_ID']);
    });

    it('should return an error if --project-id or --title is missing', async () => {
        const input = { subcommand: 'create-item', query: '--project-id PVT_123' };
        const result = await tool.execute(input);
        expect(result.results).toEqual(['Error: --project-id and --title "..." are required.']);
    });
  });

  describe('update-item', () => {
    it('should update the title of an existing item', async () => {
        // Mock pour l'étape 1: Récupérer l'ID du champ
        const getFieldIdResponse = {
            data: {
                node: {
                    fieldValues: {
                        nodes: [{
                            field: {
                                id: 'FIELD_ID_TITLE',
                                name: 'Title'
                            }
                        }]
                    }
                }
            }
        };

        // Mock pour l'étape 2: Mettre à jour la valeur du champ
        const updateItemResponse = {
            data: {
                updateProjectV2ItemFieldValue: {
                    projectV2Item: {
                        id: 'ITEM_123'
                    }
                }
            }
        };

        fetch
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(getFieldIdResponse),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue(updateItemResponse),
            });

        const input = {
            subcommand: 'update-item',
            query: '--project-id PVT_456 --item-id ITEM_123 --title "Titre Mis à Jour"'
        };
        const result = await tool.execute(input);

        expect(fetch).toHaveBeenCalledTimes(2);

        // Vérification du premier appel (récupération de l'ID du champ)
        const firstCallBody = JSON.parse(fetch.mock.calls[0][1].body);
        expect(firstCallBody.variables.itemId).toBe('ITEM_123');

        // Vérification du second appel (mutation de mise à jour)
        const secondCallBody = JSON.parse(fetch.mock.calls[1][1].body);
        expect(secondCallBody.variables).toEqual({
            projectId: 'PVT_456',
            itemId: 'ITEM_123',
            fieldId: 'FIELD_ID_TITLE',
            newTitle: 'Titre Mis à Jour'
        });

        expect(result.results).toEqual(['Successfully updated item ITEM_123']);
    });

    it('should return an error if required parameters are missing', async () => {
        const input = { subcommand: 'update-item', query: '--project-id PVT_456' };
        const result = await tool.execute(input);
        expect(result.results).toEqual(['Error: --project-id, --item-id, and --title "..." are required.']);
    });
  });
});