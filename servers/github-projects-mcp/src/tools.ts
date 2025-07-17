import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getGitHubClient } from './utils/github.js';
import { analyze_task_complexity, executeGetProjectItems, executeArchiveProject, executeUnarchiveProject, executeConvertDraftToIssue, executeCreateProjectField, executeDeleteProject, executeDeleteProjectField, executeUpdateIssueState, getRepositoryId, executeCreateIssue, executeUpdateProjectField, executeUpdateProjectItemField, archiveProjectItem, unarchiveProjectItem } from './github-actions.js';
import { checkReadOnlyMode, checkRepoPermissions } from './security.js';
import logger from './logger.js';

interface GitHubProjectNode {
  id: string;
  title: string;
  number: number;
  shortDescription?: string;
  url: string;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
  items?: {
    nodes: GitHubProjectItem[];
  };
  fields?: {
    nodes: GitHubProjectField[];
  };
}

interface GitHubProjectItemContent {
  title?: string;
  number?: number;
  state?: string;
  url?: string;
  body?: string;
}

interface GitHubProjectItem {
  id: string;
  type: string;
  content?: GitHubProjectItemContent;
  fieldValues?: {
    nodes: GitHubProjectFieldValue[];
  };
}

interface GitHubProjectFieldValue {
  text?: string;
  date?: string;
  name?: string; // For single select option name
  field?: {
    name?: string; // For field name
  };
}

interface GitHubProjectFieldOption {
  id: string;
  name: string;
  color?: string;
}

interface GitHubProjectField {
  id: string;
  name: string;
  options?: GitHubProjectFieldOption[];
}

interface GraphQLProjectsResponseUser {
  user: {
    projectsV2: {
      nodes: GitHubProjectNode[];
    };
  };
}

interface GraphQLProjectsResponseOrg {
  organization: {
    projectsV2: {
      nodes: GitHubProjectNode[];
    };
  };
}

interface GraphQLOwnerIdResponse {
  user?: { id: string };
  organization?: { id: string };
}

interface GraphQLCreateProjectResponse {
  createProjectV2: {
    projectV2: GitHubProjectNode;
  };
}

interface GraphQLGetProjectResponse {
    user?: { projectV2: GitHubProjectNode };
    organization?: { projectV2: GitHubProjectNode };
}

interface GraphQLAddProjectItemResponse {
  addProjectV2ItemById?: { // Pour issues/PRs
    item: { id: string };
  };
  addProjectV2DraftIssue?: { // Pour draft issues
    projectItem: { id: string };
  };
}

interface GraphQLUpdateProjectItemFieldResponse {
  updateProjectV2ItemFieldValue: {
    projectV2Item: {
      id: string;
    };
  };
}

interface GraphQLDeleteProjectItemResponse {
  deleteProjectV2Item: {
    deletedItemId: string;
  };
}

// Initialiser le client GitHub
const octokit = getGitHubClient();

/**
 * Configure les outils MCP pour interagir avec GitHub Projects
 * @param server Instance du serveur MCP
 */
export function setupTools(server: any) {
  const allTools: Tool[] = [
    /**
     * @tool list_projects
     * @description Liste les projets GitHub d'un utilisateur ou d'une organisation.
     * @param {string} owner - Nom d'utilisateur ou d'organisation.
     * @param {'user' | 'org'} [type='user'] - Type de propriétaire (utilisateur ou organisation).
     * @param {'open' | 'closed' | 'all'} [state='open'] - État des projets à récupérer.
     * @returns {Promise<object>} Un objet contenant la liste des projets.
     */
    {
      name: 'list_projects',
      description: 'Liste les projets GitHub d\'un utilisateur ou d\'une organisation',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Nom d\'utilisateur ou d\'organisation' },
          type: { type: 'string', enum: ['user', 'org'], description: 'Type de propriétaire (utilisateur ou organisation)', default: 'user' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'État des projets à récupérer', default: 'open' }
        },
        required: ['owner']
      },
      execute: async ({ owner, type = 'user', state = 'open' }: { owner: string; type?: 'user' | 'org'; state?: 'open' | 'closed' | 'all' }) => {
        try {
          const query = `
            query($owner: String!) {
              ${type === 'user' ? 'user' : 'organization'}(login: $owner) {
                projectsV2(first: 20) {
                  nodes { id, title, number, shortDescription, url, closed, createdAt, updatedAt }
                }
              }
            }
          `;
          const response = await octokit.graphql(query, { owner }) as any;
          let projects: GitHubProjectNode[] = (type === 'user' ? response.user?.projectsV2?.nodes : response.organization?.projectsV2?.nodes) || [];
          return {
            success: true,
            projects: projects.map(p => ({ id: p.id, title: p.title, number: p.number, description: p.shortDescription, url: p.url, closed: p.closed, createdAt: p.createdAt, updatedAt: p.updatedAt }))
          };
        } catch (error: any) {
          logger.error('Erreur dans list_projects', { error });
          return { success: false, error: error.message || 'Erreur lors de la récupération des projets' };
        }
      }
    },
    /**
     * @tool list_repositories
     * @description Liste les dépôts d'un utilisateur ou d'une organisation.
     * @param {string} owner - Nom d'utilisateur ou d'organisation.
     * @param {'user' | 'org'} [type='user'] - Type de propriétaire (utilisateur ou organisation).
     * @returns {Promise<object>} Un objet contenant la liste des dépôts.
     */
    {
      name: 'list_repositories',
      description: "Liste les dépôts d'un utilisateur ou d'une organisation",
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "Nom d_utilisateur ou d_organisation" },
          type: { type: 'string', enum: ['user', 'org'], description: 'Type de propriétaire (utilisateur ou organisation)', default: 'user' }
        },
        required: ['owner']
      },
      execute: async ({ owner, type = 'user' }: { owner: string; type?: 'user' | 'org' }) => {
        try {
          const query = `
            query($owner: String!) {
              ${type === 'user' ? 'user' : 'organization'}(login: $owner) {
                repositories(first: 50, orderBy: {field: PUSHED_AT, direction: DESC}) {
                  nodes {
                    id
                    name
                    url
                  }
                }
              }
            }
          `;
          const response = await octokit.graphql(query, { owner }) as any;
          const repositories = (type === 'user' ? response.user?.repositories?.nodes : response.organization?.repositories?.nodes) || [];
          return {
            success: true,
            repositories: repositories.map((r: any) => ({ id: r.id, name: r.name, url: r.url }))
          };
        } catch (error: any) {
          logger.error('Erreur dans list_repositories', { error });
          return { success: false, error: error.message || 'Erreur lors de la récupération des dépôts' };
        }
      }
    },
    /**
     * @tool create_project
     * @description Crée un nouveau projet GitHub, potentiellement lié à un dépôt.
     * @param {string} owner - Nom du propriétaire du projet (utilisateur ou organisation).
     * @param {string} title - Titre du nouveau projet.
     * @param {string} [repository_id] - ID du dépôt à lier au projet (optionnel).
     * @returns {Promise<object>} Un objet contenant les détails du projet créé.
     */
    {
      name: 'create_project',
      description: 'Crée un nouveau projet GitHub, potentiellement lié à un dépôt.',
      inputSchema: {
          type: 'object',
          properties: {
              owner: { type: 'string', description: 'Nom du propriétaire du projet (utilisateur ou organisation).' },
              title: { type: 'string', description: 'Titre du nouveau projet.' },
              repository_id: { type: 'string', description: 'ID du dépôt à lier au projet (optionnel).' },
          },
          required: ['owner', 'title']
      },
      execute: async ({ owner, title, repository_id }: { owner: string, title: string, repository_id?: string }) => {
          try {
              checkReadOnlyMode();
              // Deviner le type de propriétaire (user/org) pour obtenir l'ID.
              // Note: une approche plus robuste pourrait nécessiter un paramètre 'type' explicite.
              let ownerId: string | undefined;
              try {
                const userQuery = await octokit.graphql<{ user: { id: string } }>(`query($login: String!) { user(login: $login) { id } }`, { login: owner });
                ownerId = userQuery.user?.id;
              } catch (e) {
                  // Ignorer l'erreur si l'utilisateur n'est pas trouvé
              }

              if (!ownerId) {
                  try {
                      const orgQuery = await octokit.graphql<{ organization: { id: string } }>(`query($login: String!) { organization(login: $login) { id } }`, { login: owner });
                      ownerId = orgQuery.organization?.id;
                  } catch (e) {
                      // Ignorer l'erreur si l'organisation n'est pas trouvée
                  }
              }

              if (!ownerId) {
                  throw new Error(`Impossible de trouver un utilisateur ou une organisation nommé '${owner}'.`);
              }

              const mutation = `
                  mutation CreateProject($input: CreateProjectV2Input!) {
                      createProjectV2(input: $input) {
                          projectV2 {
                              id, title, number, url, closed
                          }
                      }
                  }`;

              const input: { ownerId: string; title: string; repositoryId?: string } = { ownerId, title };
              if (repository_id) {
                  input.repositoryId = repository_id;
              }

              const result = await octokit.graphql<GraphQLCreateProjectResponse>(mutation, { input });
              const project = result.createProjectV2?.projectV2;

              if (!project) {
                  throw new Error('La réponse de l\'API n\'a pas retourné de projet.');
              }

              return { success: true, project };
          } catch (error: any) {
              // Log complet de l'erreur pour inspection
              logger.error('Erreur détaillée dans create_project', {
                  errorMessage: error.message,
                  errorName: error.name,
                  errorStack: error.stack,
                  errorResponse: error.response,
                  fullError: JSON.stringify(error, null, 2)
              });

              // Tentative d'extraire un message d'erreur plus précis de la réponse GraphQL
              const graphqlErrors = error.response?.data?.errors;
              const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');

              return { success: false, error: `Erreur GraphQL: ${readableError}` };
          }
      }
    },
    /**
     * @tool get_project
     * @description Récupère les détails d'un projet GitHub, y compris ses éléments et ses champs.
     * @param {string} owner - Nom d'utilisateur ou d'organisation propriétaire du projet.
     * @param {number} project_number - Le numéro du projet à récupérer.
     * @param {'user' | 'org'} [type='user'] - Le type de propriétaire ('user' or 'org').
     * @returns {Promise<object>} Une promesse qui résout avec les détails complets du projet.
     */
    {
      name: 'get_project',
      description: 'Récupère les détails d\'un projet GitHub',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Nom d\'utilisateur ou d\'organisation' },
          project_number: { type: 'number', description: 'Numéro du projet' },
          type: { type: 'string', enum: ['user', 'org'], default: 'user', description: 'Type de propriétaire (utilisateur ou organisation)' }
        },
        required: ['owner', 'project_number']
      },
      execute: async ({ owner, project_number, type = 'user' }: { owner: string; project_number: number; type?: 'user' | 'org' }) => {
        try {
          // On ne peut pas vérifier ici car on n'a pas le nom du repo
          // La vérification se fera dans les fonctions qui utilisent le repo
          checkRepoPermissions(owner, "any"); // TODO: Fix this by getting the repo name from the project
          const query = `
            query($owner: String!, $number: Int!) {
              ${type === 'user' ? 'user' : 'organization'}(login: $owner) {
                projectV2(number: $number) {
                  id, title, number, shortDescription, url, closed, createdAt, updatedAt,
                  items(first: 100) { nodes { id, type, content {
                    ... on Issue { title, number, state, url, repository { nameWithOwner } }, ... on PullRequest { title, number, state, url, repository { nameWithOwner } }, ... on DraftIssue { title, body }
                  }, fieldValues(first: 20) { nodes {
                    ... on ProjectV2ItemFieldTextValue { text, field { ... on ProjectV2FieldCommon { name } } }, ... on ProjectV2ItemFieldDateValue { date, field { ... on ProjectV2FieldCommon { name } } }, ... on ProjectV2ItemFieldSingleSelectValue { name, field { ... on ProjectV2FieldCommon { name } } }
                  }}}},
                  fields(first: 20) { nodes {
                    ... on ProjectV2FieldCommon { id, name }, ... on ProjectV2SingleSelectField { id, name, options { id, name, color } }
                  }}
                }
              }
            }`;
          const response = await octokit.graphql(query, { owner, number: project_number }) as any;
          const project = type === 'user' ? response.user?.projectV2 : response.organization?.projectV2;
          if (!project) throw new Error(`Projet non trouvé pour ${owner}/${project_number}.`);
          // La vérification est déléguée aux appels utilisant les repos
          return { success: true, project };
        } catch (error: any) {
          logger.error('Erreur dans get_project', { error });
          return { success: false, error: error.message || 'Erreur lors de la récupération du projet' };
        }
      }
    },
    /**
     * @tool get_project_items
     * @description Récupère les éléments (issues, PRs, notes) d'un projet GitHub. Un filtrage optionnel peut être appliqué.
     * @param {string} project_id - L'ID du projet dont les éléments doivent être récupérés.
     * @param {object} [filterOptions] - Un objet de critères pour filtrer les éléments (par exemple, par statut).
     * @returns {Promise<object>} Une promesse qui résout avec la liste des éléments du projet.
     */
    {
      name: 'get_project_items',
      description: "Récupère les éléments d'un projet, avec une option de filtrage.",
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: "ID du projet." },
          filterOptions: {
            type: 'object',
            description: "Critères de filtrage (ex: { 'status': 'Done' }).",
            properties: {},
            additionalProperties: true
          }
        },
        required: ['project_id']
      },
      execute: async ({ project_id, filterOptions }: { project_id: string, filterOptions?: any }) => {
        return await executeGetProjectItems(octokit, { projectId: project_id, filterOptions });
      }
    },
    /**
     * @tool add_item_to_project
     * @description Ajoute un élément (issue, pull request, ou une note) à un projet GitHub.
     * @param {string} project_id - L'ID du projet auquel ajouter l'élément.
     * @param {string} [content_id] - L'ID de l'issue ou de la pull request à ajouter. Requis si 'content_type' n'est pas 'draft_issue'.
     * @param {'issue' | 'pull_request' | 'draft_issue'} [content_type='issue'] - Le type de contenu à ajouter.
     * @param {string} [draft_title] - Le titre de la note (draft issue). Requis pour 'draft_issue'.
     * @param {string} [draft_body] - Le corps de la note (draft issue).
     * @returns {Promise<object>} Une promesse qui résout avec l'ID du nouvel élément de projet créé.
     */
    {
      name: 'add_item_to_project',
      description: 'Ajoute un élément (issue, pull request ou note) à un projet GitHub',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'ID du projet' },
          content_id: { type: 'string', description: 'ID de l\'élément à ajouter' },
          content_type: { type: 'string', enum: ['issue', 'pull_request', 'draft_issue'], default: 'issue' },
          draft_title: { type: 'string', description: 'Titre de la note' },
          draft_body: { type: 'string', description: 'Corps de la note' }
        },
        required: ['project_id']
      },
      execute: async ({ project_id, content_id, content_type = 'issue', draft_title, draft_body }: {
        project_id: string;
        content_id?: string;
        content_type?: 'issue' | 'pull_request' | 'draft_issue';
        draft_title?: string;
        draft_body?: string;
      }) => {
        try {
          checkReadOnlyMode();
          let query;
          let variables: any = { projectId: project_id };
          if (content_type === 'draft_issue') {
            if (!draft_title) throw new Error("Le titre est requis pour une draft_issue.");
            query = `mutation($projectId: ID!, $title: String!, $body: String) { addProjectV2DraftIssue(input: {projectId: $projectId, title: $title, body: $body}) { projectItem { id } } }`;
            variables = { ...variables, title: draft_title, body: draft_body };
          } else {
            if (!content_id) throw new Error("content_id est requis pour issue ou pull_request.");
            query = `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }`;
            variables.contentId = content_id;
          }
          const response = await octokit.graphql(query, variables) as any;
          const itemId = content_type === 'draft_issue' ? response.addProjectV2DraftIssue?.projectItem?.id : response.addProjectV2ItemById?.item?.id;
          if (!itemId) throw new Error("Impossible d'ajouter l'élément.");
          return { success: true, item_id: itemId };
        } catch (error: any) {
          logger.error('Erreur dans add_item_to_project', { error });
          return { success: false, error: error.message || 'Erreur lors de l\'ajout de l\'élément' };
        }
      }
    },
    /**
     * @tool update_project_item_field
     * @description Met à jour la valeur d'un champ spécifique pour un élément dans un projet GitHub.
     * @param {string} project_id - L'ID du projet.
     * @param {string} item_id - L'ID de l'élément à mettre à jour.
     * @param {string} field_id - L'ID du champ à modifier.
     * @param {'text' | 'date' | 'single_select' | 'number'} field_type - Le type de données du champ.
     * @param {string} [value] - La nouvelle valeur pour les champs de type `text`, `date`, ou `number`.
     * @param {string} [option_id] - L'ID de l'option sélectionnée pour un champ de type `single_select`.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de l'opération de mise à jour.
     */
    {
      name: 'update_project_item_field',
      description: 'Met à jour la valeur d\'un champ pour un élément dans un projet GitHub',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'ID du projet' },
          item_id: { type: 'string', description: 'ID de l\'élément' },
          field_id: { type: 'string', description: 'ID du champ' },
          field_type: { type: 'string', enum: ['text', 'date', 'single_select', 'number'], default: 'text' },
          value: { type: 'string', description: 'Nouvelle valeur' },
          option_id: { type: 'string', description: 'ID de l\'option pour single_select' }
        },
        required: ['project_id', 'item_id', 'field_id', 'field_type']
      },
      execute: async ({ project_id, item_id, field_id, field_type, value, option_id }: {
        project_id: string;
        item_id: string;
        field_id: string;
        field_type: 'text' | 'date' | 'single_select' | 'number';
        value?: string;
        option_id?: string;
      }) => {
        checkReadOnlyMode();
        return await executeUpdateProjectItemField(octokit, {
          projectId: project_id,
          itemId: item_id,
          fieldId: field_id,
          fieldType: field_type,
          value: value,
          optionId: option_id
        });
      }
    },
    /**
     * @tool delete_project_item
     * @description Supprime un élément (issue, PR, note) d'un projet GitHub.
     * @param {string} project_id - L'ID du projet.
     * @param {string} item_id - L'ID de l'élément à supprimer.
     * @returns {Promise<object>} Une promesse qui résout avec l'ID de l'élément supprimé.
     */
    {
      name: 'delete_project_item',
      description: 'Supprime un élément d\'un projet GitHub',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'ID du projet' },
          item_id: { type: 'string', description: 'ID de l\'élément à supprimer' },
        },
        required: ['project_id', 'item_id'],
      },
      execute: async ({ project_id, item_id }: { project_id: string, item_id: string }) => {
        try {
          checkReadOnlyMode();
          const mutation = `
            mutation($projectId: ID!, $itemId: ID!) {
              deleteProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) {
                deletedItemId
              }
            }
          `;
          const result = await octokit.graphql<GraphQLDeleteProjectItemResponse>(mutation, {
            projectId: project_id,
            itemId: item_id,
          });

          const deletedItemId = result.deleteProjectV2Item?.deletedItemId;

          if (!deletedItemId) {
            throw new Error('La réponse de l\'API n\'a pas retourné d\'ID d\'élément supprimé.');
          }

          return { success: true, deleted_item_id: deletedItemId };
        } catch (error: any) {
          logger.error('Erreur dans delete_project_item', { error });
          return { success: false, error: error.message || 'Une erreur est survenue lors de la suppression de l\'élément.' };
        }
      }
    },
    /**
     * @tool delete_project
     * @description Supprime un projet GitHub de manière permanente.
     * @param {string} projectId - L'ID du projet à supprimer.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de l'opération de suppression.
     */
    {
      name: 'delete_project',
      description: 'Supprime un projet GitHub',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "L'ID du projet à supprimer." },
        },
        required: ['projectId'],
      },
      execute: async ({ projectId }: { projectId: string }) => {
        checkReadOnlyMode();
        return await executeDeleteProject(octokit, { projectId });
      }
    },
    /**
     * @tool update_project
     * @description Met à jour le titre, la description et/ou l'état d'un projet GitHub.
     * @param {string} project_id - L'ID du projet à modifier.
     * @param {string} [title] - Le nouveau titre du projet.
     * @param {string} [description] - La nouvelle description courte du projet.
     * @param {'OPEN' | 'CLOSED'} [state] - Le nouvel état du projet ('OPEN' ou 'CLOSED'). NOTE: Ce paramètre est actuellement ignoré par l'outil.
     * @returns {Promise<object>} Une promesse qui résout avec l'ID du projet mis à jour.
     */
    {
      name: 'update_project',
      description: "Modifie le titre, la description et l'état d'un projet.",
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'L\'ID du projet à modifier.' },
          title: { type: 'string', description: 'Le nouveau titre du projet.' },
          description: { type: 'string', description: 'La nouvelle description courte du projet.' },
          state: { type: 'string', enum: ['OPEN', 'CLOSED'], description: "Le nouvel état du projet ('OPEN' ou 'CLOSED'). NOTE: This parameter is currently ignored by the tool." }
        },
        required: ['project_id']
      },
      execute: async ({ project_id, title, description, state }: { project_id: string, title?: string, description?: string, state?: 'OPEN' | 'CLOSED' }) => {
        checkReadOnlyMode();
        let input: { projectId: string; title?: string; shortDescription?: string; state?: 'OPEN' | 'CLOSED' } | undefined;
        try {
          const mutation = `
            mutation UpdateProject($input: UpdateProjectV2Input!) {
              updateProjectV2(input: $input) {
                projectV2 {
                  id
                }
              }
            }
          `;
          
          input = {
            projectId: project_id,
          };
          
          if (title !== undefined) input.title = title;
          if (description !== undefined) input.shortDescription = description;
          // if (state) input.state = state; // This field is not accepted by the API
          
          logger.info('[DEBUG] Calling updateProjectV2 with input:', { input });
          const response = await octokit.graphql<any>(mutation, { input });

          if (!response?.updateProjectV2?.projectV2?.id) {
            throw new Error("La mise à jour a échoué ou n'a pas retourné l'ID du projet.");
          }

          return { success: true, projectId: response.updateProjectV2.projectV2.id };
        } catch (error: any) {
          logger.error("Erreur dans update_project", { error, input });
          return { success: false, error: error.message || "Une erreur est survenue lors de la mise à jour du projet." };
        }
      }
    },
    /**
     * @tool create_issue
     * @description Crée une nouvelle issue dans un dépôt GitHub et peut l'ajouter à un projet.
     * @param {string} repositoryName - Le nom complet du dépôt (ex: 'owner/repo').
     * @param {string} title - Le titre de l'issue.
     * @param {string} [body] - Le corps de l'issue (optionnel).
     * @param {string} [projectId] - L'ID du projet auquel ajouter l'issue (optionnel).
     * @returns {Promise<object>} Une promesse qui résout avec les détails de l'issue créée.
     */
    {
      name: 'create_issue',
      description: "Crée une issue dans un dépôt et l'ajoute optionnellement à un projet.",
      inputSchema: {
        type: 'object',
        properties: {
          repositoryName: { type: 'string', description: "Le nom complet du dépôt (ex: 'owner/repo')." },
          title: { type: 'string', description: "Le titre de l'issue." },
          body: { type: 'string', description: "Le corps de l'issue (optionnel)." },
          projectId: { type: 'string', description: "L'ID du projet auquel ajouter la nouvelle issue (optionnel)." }
        },
        required: ['repositoryName', 'title']
      },
      execute: async ({ repositoryName, title, body, projectId }: { repositoryName: string, title: string, body?: string, projectId?: string }) => {
        try {
          checkReadOnlyMode();
          const [owner, repo] = repositoryName.split('/');
          if (!owner || !repo) {
            throw new Error("Le format de 'repositoryName' doit être 'owner/repo'.");
          }
          checkRepoPermissions(owner, repo);
          const repositoryId = await getRepositoryId(octokit, owner, repo);
          return await executeCreateIssue(octokit, { repositoryId, title, body, projectId });
        } catch (error: any) {
          logger.error("Erreur dans l'outil create_issue", { error: error.message });
          return { success: false, error: error.message };
        }
      }
    },
    /**
     * @tool update_issue_state
     * @description Modifie l'état d'une issue (ouvre ou ferme).
     * @param {string} issueId - L'ID global de l'issue à modifier.
     * @param {'OPEN' | 'CLOSED'} state - Le nouvel état de l'issue.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de la mise à jour.
     */
    {
      name: 'update_issue_state',
      description: "Modifie l'état d'une issue (ouverte ou fermée).",
      inputSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: "L'ID global de l'issue à modifier." },
          state: { type: 'string', enum: ['OPEN', 'CLOSED'], description: "Le nouvel état de l'issue." }
        },
        required: ['issueId', 'state']
      },
      execute: async ({ issueId, state }: { issueId: string, state: 'OPEN' | 'CLOSED' }) => {
        checkReadOnlyMode();
        return await executeUpdateIssueState(octokit, { issueId, state });
      }
    },
    /**
     * @tool create_project_field
     * @description Crée un nouveau champ (colonne) dans un projet GitHub.
     * @param {string} projectId - L'ID du projet où créer le champ.
     * @param {string} name - Le nom du nouveau champ.
     * @param {'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT'} dataType - Le type de données du champ.
     * @returns {Promise<object>} Une promesse qui résout avec les détails du champ créé.
     */
    {
      name: 'create_project_field',
      description: "Crée un nouveau champ (colonne) dans un projet GitHub.",
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "L'ID du projet." },
          name: { type: 'string', description: "Le nom du nouveau champ." },
          dataType: {
            type: 'string',
            enum: ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT'],
            description: "Le type de données du champ."
          }
        },
        required: ['projectId', 'name', 'dataType']
      },
      execute: async ({ projectId, name, dataType }: { projectId: string, name: string, dataType: 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' }) => {
        checkReadOnlyMode();
        return await executeCreateProjectField(octokit, { projectId, name, dataType });
      }
    },
    /**
     * @tool update_project_field
     * @description Met à jour un champ existant dans un projet (par exemple, renomme une colonne).
     * @param {string} projectId - L'ID du projet.
     * @param {string} fieldId - L'ID du champ à mettre à jour.
     * @param {string} name - Le nouveau nom pour le champ.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de la mise à jour.
     */
    {
      name: 'update_project_field',
      description: 'Updates an existing field in a project (e.g., renames a column).',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "The ID of the project." },
          fieldId: { type: 'string', description: "The ID of the field to update." },
          name: { type: 'string', description: "The new name for the field." },
        },
        required: ['projectId', 'fieldId', 'name']
      },
      execute: async ({ projectId, fieldId, name }: { projectId: string, fieldId: string, name: string }) => {
        checkReadOnlyMode();
        return await executeUpdateProjectField(octokit, { projectId, fieldId, name });
      }
    },
    /**
     * @tool delete_project_field
     * @description Supprime un champ d'un projet.
     * @param {string} projectId - L'ID du projet.
     * @param {string} fieldId - L'ID du champ à supprimer.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de la suppression.
     */
    {
      name: 'delete_project_field',
      description: 'Deletes a field from a project.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "The ID of the project." },
          fieldId: { type: 'string', description: "The ID of the field to delete." },
        },
        required: ['projectId', 'fieldId']
      },
      execute: async ({ projectId, fieldId }: { projectId: string, fieldId: string }) => {
        checkReadOnlyMode();
        return await executeDeleteProjectField(octokit, { projectId, fieldId });
      }
    },
    /**
     * @tool convert_draft_to_issue
     * @description Convertit une note (draft issue) d'un projet en une véritable issue GitHub.
     * @param {string} projectId - L'ID du projet contenant la note.
     * @param {string} draftId - L'ID de la note à convertir.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de la conversion.
     */
    {
      name: 'convert_draft_to_issue',
      description: 'Converts a draft issue in a project into a standard GitHub issue.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "The ID of the project." },
          draftId: { type: 'string', description: "The ID of the draft issue to convert." },
        },
        required: ['projectId', 'draftId']
      },
      execute: async ({ projectId, draftId }: { projectId: string, draftId: string }) => {
        checkReadOnlyMode();
        return await executeConvertDraftToIssue(octokit, { projectId, draftId });
      }
    },
    /**
     * @tool archive_project
     * @description Archive un projet GitHub. Le projet ne sera plus visible dans la liste des projets actifs.
     * @param {string} projectId - L'ID du projet à archiver.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de l'archivage.
     */
    {
      name: 'archive_project',
      description: 'Archive un projet GitHub.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "L'ID du projet à archiver." },
        },
        required: ['projectId'],
      },
      execute: async ({ projectId }: { projectId: string }) => {
        checkReadOnlyMode();
        return await executeArchiveProject(octokit, { projectId });
      }
    },
    /**
     * @tool unarchive_project
     * @description Ré-ouvre (désarchive) un projet GitHub précédemment archivé.
     * @param {string} projectId - L'ID du projet à désarchiver.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat du désarchivage.
     */
    {
      name: 'unarchive_project',
      description: 'Ré-ouvre (désarchive) un projet GitHub.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "L'ID du projet à désarchiver." },
        },
        required: ['projectId'],
      },
      execute: async ({ projectId }: { projectId: string }) => {
        checkReadOnlyMode();
        return await executeUnarchiveProject(octokit, { projectId });
      }
    },
    /**
     * @tool archive_project_item
     * @description Archive un élément d'un projet GitHub.
     * @param {string} projectId - L'ID du projet.
     * @param {string} itemId - L'ID de l'élément à archiver.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat de l'archivage.
     */
    {
      name: 'archive_project_item',
      description: "Archive un élément d'un projet GitHub.",
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "L'ID du projet." },
          itemId: { type: 'string', description: "L'ID de l'élément à archiver." },
        },
        required: ['projectId', 'itemId'],
      },
      execute: async ({ projectId, itemId }: { projectId: string, itemId: string }) => {
        checkReadOnlyMode();
        // La permission est vérifiée au niveau du projet, pas du repo individuel pour cette action
        return await archiveProjectItem(octokit, { projectId, itemId });
      }
    },
    /**
     * @tool unarchive_project_item
     * @description Désarchive un élément d'un projet GitHub.
     * @param {string} projectId - L'ID du projet.
     * @param {string} itemId - L'ID de l'élément à désarchiver.
     * @returns {Promise<object>} Une promesse qui résout avec le résultat du désarchivage.
     */
    {
      name: 'unarchive_project_item',
      description: "Désarchive un élément d'un projet GitHub.",
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "L'ID du projet." },
          itemId: { type: 'string', description: "L'ID de l'élément à désarchiver." },
        },
        required: ['projectId', 'itemId'],
      },
      execute: async ({ projectId, itemId }: { projectId: string, itemId: string }) => {
        checkReadOnlyMode();
        return await unarchiveProjectItem(octokit, { projectId, itemId });
      }
    },
    /**
     * @tool analyze_task_complexity
     * @description Analyse la complexité d'une tâche (item) dans un projet GitHub en se basant sur son titre et sa description.
     * @param {string} owner - Le propriétaire du dépôt contenant le projet.
     * @param {string} repo - Le nom du dépôt contenant le projet.
     * @param {number} projectNumber - Le numéro du projet.
     * @param {string} itemId - L'ID de l'item (tâche) à analyser.
     * @returns {Promise<object>} Une promesse qui résout avec l'analyse de complexité.
     */
    {
      name: 'analyze_task_complexity',
      description: "Analyse la complexité d'une tâche (item) dans un projet GitHub en se basant sur son titre et sa description.",
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "Le propriétaire du dépôt." },
          repo: { type: 'string', description: "Le nom du dépôt." },
          projectNumber: { type: 'number', description: "Le numéro du projet." },
          itemId: { type: 'string', description: "L'ID de l'item (tâche) à analyser." }
        },
        required: ['owner', 'repo', 'projectNumber', 'itemId']
      },
      execute: async ({ owner, repo, projectNumber, itemId }: { owner: string; repo: string; projectNumber: number; itemId: string; }) => {
        return await analyze_task_complexity(octokit, { owner, repo, projectNumber, itemId });
      }
    }
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
try {
    const tool = allTools.find(t => t.name === request.params.name);
    if (!tool || typeof tool.execute !== 'function') {
        throw new McpError(
            ErrorCode.MethodNotFound,
            `Outil inconnu ou non exécutable: ${request.params.name}`
        );
    }
    const result = await tool.execute(request.params.arguments);
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.success
    };
} catch (error: any) {
        const errorMessage = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
        logger.error(`Erreur lors de l'exécution de l'outil ${request.params.name}`, {
            error: errorMessage,
            stack: error.stack
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }, null, 2) }],
            isError: true
        };
    }
  });
}