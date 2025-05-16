import { MCPResource } from '@modelcontextprotocol/server';
import { getGitHubClient } from './utils/github';

// Initialiser le client GitHub
const octokit = getGitHubClient();

/**
 * Liste des ressources MCP pour accéder aux données de GitHub Projects
 */
export const projectsResources: MCPResource[] = [
  // Ressource pour accéder aux projets d'un utilisateur ou d'une organisation
  {
    name: 'projects',
    description: 'Accès aux projets GitHub d\'un utilisateur ou d\'une organisation',
    uriSchema: 'github-projects://{owner}/{type}?state={state}',
    fetch: async (uri) => {
      try {
        // Extraire les paramètres de l'URI
        const url = new URL(uri);
        const pathParts = url.pathname.split('/').filter(Boolean);
        
        if (pathParts.length < 2) {
          throw new Error('URI invalide: format attendu github-projects://{owner}/{type}');
        }
        
        const owner = pathParts[0];
        const type = pathParts[1];
        const state = url.searchParams.get('state') || 'open';
        
        if (!['user', 'org'].includes(type)) {
          throw new Error('Type invalide: doit être "user" ou "org"');
        }
        
        if (!['open', 'closed', 'all'].includes(state)) {
          throw new Error('État invalide: doit être "open", "closed" ou "all"');
        }
        
        // Utiliser l'API GraphQL pour récupérer les projets (v2)
        const query = `
          query($owner: String!, $type: String!) {
            ${type === 'user' ? 'user' : 'organization'}(login: $owner) {
              projectsV2(first: 20, states: ${state === 'all' ? '[OPEN, CLOSED]' : state === 'closed' ? '[CLOSED]' : '[OPEN]'}) {
                nodes {
                  id
                  title
                  number
                  shortDescription
                  url
                  closed
                  createdAt
                  updatedAt
                }
              }
            }
          }
        `;

        const response = await octokit.graphql(query, {
          owner,
          type
        });

        const projects = type === 'user' 
          ? response.user.projectsV2.nodes 
          : response.organization.projectsV2.nodes;

        return {
          format: 'json',
          content: JSON.stringify({
            owner,
            type,
            state,
            projects: projects.map((project: any) => ({
              id: project.id,
              title: project.title,
              number: project.number,
              description: project.shortDescription,
              url: project.url,
              closed: project.closed,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt
            }))
          }, null, 2)
        };
      } catch (error: any) {
        return {
          format: 'json',
          content: JSON.stringify({
            error: error.message || 'Erreur lors de la récupération des projets'
          }, null, 2)
        };
      }
    }
  },
  
  // Ressource pour accéder à un projet spécifique
  {
    name: 'project',
    description: 'Accès à un projet GitHub spécifique',
    uriSchema: 'github-project://{owner}/{project_number}',
    fetch: async (uri) => {
      try {
        // Extraire les paramètres de l'URI
        const url = new URL(uri);
        const pathParts = url.pathname.split('/').filter(Boolean);
        
        if (pathParts.length < 2) {
          throw new Error('URI invalide: format attendu github-project://{owner}/{project_number}');
        }
        
        const owner = pathParts[0];
        const projectNumber = parseInt(pathParts[1], 10);
        
        if (isNaN(projectNumber)) {
          throw new Error('Numéro de projet invalide: doit être un nombre');
        }
        
        // Utiliser l'API GraphQL pour récupérer les détails d'un projet (v2)
        const query = `
          query($owner: String!, $number: Int!) {
            user(login: $owner) {
              projectV2(number: $number) {
                id
                title
                number
                shortDescription
                url
                closed
                createdAt
                updatedAt
                items(first: 100) {
                  nodes {
                    id
                    type
                    content {
                      ... on Issue {
                        title
                        number
                        state
                        url
                      }
                      ... on PullRequest {
                        title
                        number
                        state
                        url
                      }
                      ... on DraftIssue {
                        title
                        body
                      }
                    }
                    fieldValues(first: 20) {
                      nodes {
                        ... on ProjectV2ItemFieldTextValue {
                          text
                          field {
                            ... on ProjectV2FieldCommon {
                              name
                            }
                          }
                        }
                        ... on ProjectV2ItemFieldDateValue {
                          date
                          field {
                            ... on ProjectV2FieldCommon {
                              name
                            }
                          }
                        }
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          name
                          field {
                            ... on ProjectV2FieldCommon {
                              name
                            }
                          }
                        }
                      }
                    }
                  }
                }
                fields(first: 20) {
                  nodes {
                    ... on ProjectV2FieldCommon {
                      id
                      name
                    }
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                      options {
                        id
                        name
                        color
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const response = await octokit.graphql(query, {
          owner,
          number: projectNumber
        });

        const project = response.user.projectV2;

        return {
          format: 'json',
          content: JSON.stringify({
            id: project.id,
            title: project.title,
            number: project.number,
            description: project.shortDescription,
            url: project.url,
            closed: project.closed,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            items: project.items.nodes.map((item: any) => {
              const itemData: any = {
                id: item.id,
                type: item.type
              };

              if (item.content) {
                itemData.content = {
                  title: item.content.title,
                  number: item.content.number,
                  state: item.content.state,
                  url: item.content.url,
                  body: item.content.body
                };
              }

              if (item.fieldValues && item.fieldValues.nodes) {
                itemData.fields = item.fieldValues.nodes.map((fieldValue: any) => {
                  if (fieldValue.field && fieldValue.field.name) {
                    return {
                      name: fieldValue.field.name,
                      value: fieldValue.text || fieldValue.date || fieldValue.name
                    };
                  }
                  return null;
                }).filter(Boolean);
              }

              return itemData;
            }),
            fields: project.fields.nodes.map((field: any) => {
              const fieldData: any = {
                id: field.id,
                name: field.name
              };

              if (field.options) {
                fieldData.options = field.options.map((option: any) => ({
                  id: option.id,
                  name: option.name,
                  color: option.color
                }));
              }

              return fieldData;
            })
          }, null, 2)
        };
      } catch (error: any) {
        return {
          format: 'json',
          content: JSON.stringify({
            error: error.message || 'Erreur lors de la récupération du projet'
          }, null, 2)
        };
      }
    }
  }
];