const fetch = require('node-fetch');
const { Tool } = require('../../../../../../node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js');

class GithubProjectsTool {
    name = 'github-projects';
    description = 'A tool for interacting with Github projects';
    inputSchema = {
        type: 'object',
        properties: {
            subcommand: {
                type: 'string',
                description: 'The subcommand to execute (e.g., search-repo, list-issues)',
                enum: ['search-repo', 'list-issues', 'list-projects', 'list-items', 'create-item', 'update-item']
            },
            query: {
                type: 'string',
                description: 'The query for the subcommand'
            }
        },
        required: ['subcommand', 'query']
    };
    outputSchema = {
        type: 'object',
        properties: {
            results: {
                type: 'array',
                items: {
                    type: 'string'
                }
            }
        }
    };

    constructor() {
        this.apiKey = process.env.GITHUB_PAT;
    }

    async _fetchGitHubAPI(query, variables = {}) {
        if (!this.apiKey) {
            throw new Error('GitHub PAT not found in environment variables (GITHUB_PAT)');
        }

        const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ query, variables })
        });

        if (!response.ok) {
            throw new Error(`GitHub API returned ${response.status}: ${await response.text()}`);
        }

        return response.json();
    }

    async execute(input) {
        const { subcommand, query } = input;
        switch (subcommand) {
            case 'search-repo':
                return this.searchRepo(query);
            case 'list-issues':
                return this.listIssues(query);
            case 'list-projects':
                return await this._handleListProjects();
            case 'list-items':
                return await this._handleListItems(query);
            case 'create-item':
                return await this._handleCreateItem(query);
            case 'update-item':
                return await this._handleUpdateItem(query);
            default:
                return { results: [`Unknown subcommand: ${subcommand}`] };
        }
    }

    async _handleUpdateItem(query) {
        const projectIdMatch = query.match(/--project-id\s+(\S+)/);
        const itemIdMatch = query.match(/--item-id\s+(\S+)/);
        const titleMatch = query.match(/--title\s+"([^"]+)"/);

        if (!projectIdMatch || !itemIdMatch || !titleMatch) {
            return { results: ['Error: --project-id, --item-id, and --title "..." are required.'] };
        }

        const projectId = projectIdMatch[1];
        const itemId = itemIdMatch[1];
        const newTitle = titleMatch[1];

        try {
            // Étape 1: Récupérer l'ID du champ "Title"
            const getFieldIdQuery = `
                query($itemId: ID!) {
                    node(id: $itemId) {
                        ... on ProjectV2Item {
                            fieldValues(first: 20) {
                                nodes {
                                    ... on ProjectV2ItemFieldTextValue {
                                        field {
                                            ... on ProjectV2Field {
                                                id
                                                name
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            `;
            const fieldData = await this._fetchGitHubAPI(getFieldIdQuery, { itemId });
            const titleField = fieldData.data.node.fieldValues.nodes.find(fv => fv.field && fv.field.name === 'Title');

            if (!titleField) {
                throw new Error('Could not find the "Title" field for the item.');
            }
            const fieldId = titleField.field.id;

            // Étape 2: Mettre à jour la valeur du champ
            const mutation = `
                mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $newTitle: String!) {
                    updateProjectV2ItemFieldValue(input: {
                        projectId: $projectId,
                        itemId: $itemId,
                        fieldId: $fieldId,
                        value: { text: $newTitle }
                    }) {
                        projectV2Item {
                            id
                        }
                    }
                }
            `;
            await this._fetchGitHubAPI(mutation, { projectId, itemId, fieldId, newTitle });

            return { results: [`Successfully updated item ${itemId}`] };
        } catch (error) {
            console.error('Error updating project item:', error);
            return { results: [`Error: ${error.message}`] };
        }
    }

    async _handleCreateItem(query) {
        const projectIdMatch = query.match(/--project-id\s+(\S+)/);
        const titleMatch = query.match(/--title\s+"([^"]+)"/);

        if (!projectIdMatch || !titleMatch) {
            return { results: ['Error: --project-id and --title "..." are required.'] };
        }

        const projectId = projectIdMatch[1];
        const title = titleMatch[1];

        const mutation = `
            mutation($projectId: ID!, $title: String!) {
                addProjectV2ItemById(input: {projectId: $projectId, contentId: "DRAFT_ISSUE", title: $title}) {
                    item {
                        id
                    }
                }
            }
        `;

        try {
            const data = await this._fetchGitHubAPI(mutation, { projectId, title });
            const newItemId = data.data.addProjectV2ItemById.item.id;
            return { results: [`Successfully created item with ID: ${newItemId}`] };
        } catch (error) {
            console.error('Error creating project item:', error);
            return { results: [`Error: ${error.message}`] };
        }
    }

    async _handleListItems(query) {
        const projectIdMatch = query.match(/--project-id\s+(\S+)/);
        if (!projectIdMatch) {
            return { results: ['Error: --project-id is required.'] };
        }
        const projectId = projectIdMatch[1];

        const graphqlQuery = `
            query($projectId: ID!) {
                node(id: $projectId) {
                    ... on ProjectV2 {
                        items(first: 20) {
                            nodes {
                                id
                                content {
                                    ... on DraftIssue {
                                        title
                                    }
                                    ... on Issue {
                                        title
                                    }
                                    ... on PullRequest {
                                        title
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;
        try {
            const data = await this._fetchGitHubAPI(graphqlQuery, { projectId });
            if (!data.data.node.items.nodes || data.data.node.items.nodes.length === 0) {
                return { results: [`No items found for project ${projectId}`] };
            }
            const items = data.data.node.items.nodes;
            const results = items.map(item => `ID: ${item.id}, Title: ${item.content.title}`);
            return { results };
        } catch (error) {
            console.error('Error fetching project items:', error);
            return { results: [`Error: ${error.message}`] };
        }
    }

    async _handleListProjects() {
        const query = `
            query {
                viewer {
                    projectsV2(first: 20) {
                        nodes {
                            id
                            title
                        }
                    }
                }
            }
        `;
        try {
            const data = await this._fetchGitHubAPI(query);
            if (!data.data.viewer.projectsV2.nodes || data.data.viewer.projectsV2.nodes.length === 0) {
                return { results: ['No projects found.'] };
            }
            const projects = data.data.viewer.projectsV2.nodes;
            const results = projects.map(p => `Project ID: ${p.id}, Title: ${p.title}`);
            return { results };
        } catch (error) {
            console.error('Error fetching projects:', error);
            return { results: [`Error: ${error.message}`] };
        }
    }

    async searchRepo(query) {
        console.log(`Executing searchRepo with query: ${query}`);
        try {
            const response = await fetch(`https://api.github.com/search/repositories?q=${query}`);
            if (!response.ok) {
                throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();
            if (data.items.length === 0) {
                return { results: ['No repository found.'] };
            }
            const repo = data.items[0];
            const results = [
                `Repository: ${repo.full_name}`,
                `Description: ${repo.description}`,
                `Stars: ${repo.stargazers_count}`,
                `Forks: ${repo.forks_count}`,
                `Open Issues: ${repo.open_issues_count}`,
                `URL: ${repo.html_url}`
            ];
            return { results };
        } catch (error) {
            console.error('Error fetching from GitHub API:', error);
            return { results: [`Error: ${error.message}`] };
        }
    }

    async listIssues(repo) {
        console.log(`Executing listIssues for repo: ${repo}`);
        try {
            const response = await fetch(`https://api.github.com/repos/${repo}/issues`);
            if (!response.ok) {
                throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();
            if (data.length === 0) {
                return { results: ['No issues found for this repository.'] };
            }
            const results = data.map(issue => `#${issue.number}: ${issue.title}`);
            return { results };
        } catch (error) {
            console.error('Error fetching from GitHub API:', error);
            return { results: [`Error: ${error.message}`] };
        }
    }
}

module.exports = { GithubProjectsTool };