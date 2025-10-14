import logger from './logger.js';
import { checkReadOnlyMode, checkRepoPermissions } from './security.js';

/**
 * Récupère l'ID d'un dépôt GitHub à partir de son propriétaire et de son nom.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {string} owner - Le nom du propriétaire du dépôt (utilisateur ou organisation).
 * @param {string} repo - Le nom du dépôt.
 * @returns {Promise<string>} Une promesse qui résout avec l'ID du dépôt.
 * @throws {Error} Si le dépôt n'est pas trouvé.
 */
export async function getRepositoryId(octokit: any, owner: string, repo: string): Promise<string> {
  checkRepoPermissions(owner, repo);
  const query = `
    query GetRepositoryId($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
      }
    }
  `;
  try {
    const response = await octokit.graphql(query, { owner, repo }) as { repository: { id: string } };
    if (!response.repository?.id) {
      throw new Error(`Dépôt non trouvé : ${owner}/${repo}`);
    }
    return response.repository.id;
  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Crée une issue dans un dépôt et l'ajoute optionnellement à un projet.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la création de l'issue.
 * @param {string} params.repositoryId - L'ID du dépôt où créer l'issue.
 * @param {string} params.title - Le titre de l'issue.
 * @param {string} [params.body] - Le corps de l'issue (optionnel).
 * @param {string} [params.projectId] - L'ID du projet auquel ajouter l'issue (optionnel).
 * @returns {Promise<object>} Une promesse qui résout avec les informations de l'issue créée et l'ID de l'item de projet si applicable.
 */
export async function executeCreateIssue(
  octokit: any,
  { repositoryId, title, body, projectId }: { repositoryId: string; title: string; body?: string, projectId?: string }
) {
  checkReadOnlyMode();
  try {
    // 1. Créer l'issue
    const createIssueMutation = `
      mutation($repositoryId: ID!, $title: String!, $body: String) {
        createIssue(input:{repositoryId: $repositoryId, title: $title, body: $body}) {
          issue {
            id
            number
            url
          }
        }
      }
    `;
    const createIssueResult = await octokit.graphql(createIssueMutation, {
      repositoryId,
      title,
      body,
    }) as { createIssue: { issue: { id: string, number: number, url: string } } };

    const issue = createIssueResult.createIssue?.issue;
    if (!issue || !issue.id) {
      throw new Error("La création de l'issue a échoué ou n'a pas retourné les informations attendues.");
    }

    let projectItemId: string | undefined;

    // 2. Si projectId est fourni, ajouter l'issue au projet
    if (projectId) {
      const addItemMutation = `
        mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
            item {
              id
            }
          }
        }
      `;
      const addItemResult = await octokit.graphql(addItemMutation, {
        projectId,
        contentId: issue.id,
      }) as { addProjectV2ItemById: { item: { id: string } } };
      projectItemId = addItemResult.addProjectV2ItemById?.item.id;
    }

    return { success: true, issue, projectItemId };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Met à jour un champ dans un projet GitHub (par exemple, le renomme).
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la mise à jour du champ.
 * @param {string} params.projectId - L'ID du projet.
 * @param {string} params.fieldId - L'ID du champ à mettre à jour.
 * @param {string} params.name - Le nouveau nom pour le champ.
 * @returns {Promise<object>} Une promesse qui résout avec les informations du champ mis à jour.
 */
export async function executeUpdateProjectField(
  octokit: any,
  { projectId, fieldId, name }: { projectId: string; fieldId: string; name: string; }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($fieldId: ID!, $name: String!) {
        updateProjectV2Field(input: {
          fieldId: $fieldId,
          name: $name
        }) {
          projectV2Field {
            ... on ProjectV2Field {
              id
              name
            }
            ... on ProjectV2IterationField {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
            }
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      fieldId,
      name,
    });

    const field = result.updateProjectV2Field?.projectV2Field;
    if (!field) {
      throw new Error("La mise à jour du champ a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, field: { id: field.id, name: field.name } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Modifie l'état d'une issue GitHub (ouverte ou fermée).
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la mise à jour de l'issue.
 * @param {string} params.issueId - L'ID global de l'issue à modifier.
 * @param {'OPEN' | 'CLOSED'} params.state - Le nouvel état de l'issue.
 * @returns {Promise<object>} Une promesse qui résout avec les informations de l'issue mise à jour.
 */
export async function executeUpdateIssueState(
  octokit: any,
  { issueId, state }: { issueId: string, state: 'OPEN' | 'CLOSED' }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation UpdateIssue($issueId: ID!, $state: IssueState!) {
        updateIssue(input: {id: $issueId, state: $state}) {
          issue {
            id
            number
            state
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      issueId,
      state
    });

    const issue = result.updateIssue?.issue;
    if (!issue) {
      throw new Error("La mise à jour de l'issue a échoué ou n'a pas retourné les informations attendues.");
    }
    
    return { success: true, issue: { id: issue.id, number: issue.number, state: issue.state } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Supprime un projet GitHub de manière permanente.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la suppression du projet.
 * @param {string} params.projectId - L'ID du projet à supprimer.
 * @returns {Promise<object>} Une promesse qui résout avec un objet de succès ou d'erreur.
 */
export async function executeDeleteProject(
  octokit: any,
  { projectId }: { projectId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!) {
        deleteProjectV2(input: {projectId: $projectId}) {
          projectV2 {
            id
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
    });

    if (!result.deleteProjectV2?.projectV2?.id) {
        throw new Error("La suppression du projet a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, deletedProjectId: result.deleteProjectV2.projectV2.id };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}
/**
 * Crée un nouveau champ (colonne) dans un projet GitHub.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la création du champ.
 * @param {string} params.projectId - L'ID du projet où créer le champ.
 * @param {string} params.name - Le nom du nouveau champ.
 * @param {'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT'} params.dataType - Le type de données du champ.
 * @returns {Promise<object>} Une promesse qui résout avec les informations du champ créé.
 */
export async function executeCreateProjectField(
  octokit: any,
  { projectId, name, dataType }: { projectId: string; name: string; dataType: 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $dataType: ProjectV2CustomFieldType!, $name: String!) {
        createProjectV2Field(input: {
          projectId: $projectId,
          dataType: $dataType,
          name: $name
        }) {
          projectV2Field {
            ... on ProjectV2Field {
              id
              name
            }
            ... on ProjectV2IterationField {
              id
              name
            }
            ... on ProjectV2SingleSelectField {
              id
              name
            }
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
      name,
      dataType,
    });

    const field = result.createProjectV2Field?.projectV2Field;
    if (!field) {
      throw new Error("La création du champ a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, field: { id: field.id, name: field.name } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Met à jour la valeur d'un champ pour un élément spécifique dans un projet GitHub.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la mise à jour.
 * @param {string} params.projectId - L'ID du projet.
 * @param {string} params.itemId - L'ID de l'élément de projet.
 * @param {string} params.fieldId - L'ID du champ à mettre à jour.
 * @param {'text' | 'date' | 'single_select' | 'number'} params.fieldType - Le type du champ à mettre à jour.
 * @param {string} [params.value] - La nouvelle valeur pour les champs 'text', 'date', ou 'number'.
 * @param {string} [params.optionId] - L'ID de l'option pour les champs 'single_select'.
 * @returns {Promise<object>} Une promesse qui résout avec l'ID de l'élément mis à jour.
 */
export async function executeUpdateProjectItemField(
  octokit: any,
  { projectId, itemId, fieldId, fieldType, value, optionId }:
  { projectId: string; itemId: string; fieldId: string; fieldType: 'text' | 'date' | 'single_select' | 'number'; value?: string; optionId?: string; }
) {
  checkReadOnlyMode();
  try {
    let queryValue;
    let variables: any = { projectId: projectId, itemId: itemId, fieldId: fieldId };
    
    switch (fieldType) {
      case 'text':
        if (typeof value !== 'string') throw new Error("La 'value' est requise pour le type 'text'.");
        queryValue = 'value: { text: $text }'; 
        variables.text = value; 
        break;
      case 'date':
        if (typeof value !== 'string') throw new Error("La 'value' est requise pour le type 'date'.");
        queryValue = 'value: { date: $date }'; 
        variables.date = value; 
        break;
      case 'single_select':
        if (!optionId) throw new Error("L''option_id' est requis pour le type 'single_select'.");
        queryValue = 'value: { singleSelectOptionId: $optionId }'; 
        variables.optionId = optionId; 
        break;
      case 'number':
        if (typeof value !== 'string') throw new Error("La 'value' est requise pour le type 'number'.");
        const numValue = parseFloat(value);
        if(isNaN(numValue)) throw new Error("La valeur pour 'number' est invalide.");
        queryValue = 'value: { number: $number }'; 
        variables.number = numValue; 
        break;
      default:
        throw new Error(`Type de champ non pris en charge: ${fieldType}`);
    }

    const getMutationString = () => {
        let varType = '';
        switch(fieldType) {
            case 'text': varType = '$text: String!'; break;
            case 'date': varType = '$date: Date!'; break;
            case 'single_select': varType = '$optionId: String!'; break;
            case 'number': varType = '$number: Float!'; break;
        }
        return `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, ${varType}) {
          updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, ${queryValue} }) { 
            projectV2Item { id } 
          }
        }`;
    }
    
    const mutation = getMutationString();
    const result = await octokit.graphql(mutation, variables);

    const updatedItem = result.updateProjectV2ItemFieldValue?.projectV2Item;
    if (!updatedItem) {
      throw new Error("La mise à jour du champ a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, item: { id: updatedItem.id } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Supprime un champ d'un projet GitHub.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la suppression du champ.
 * @param {string} params.projectId - L'ID du projet.
 * @param {string} params.fieldId - L'ID du champ à supprimer.
 * @returns {Promise<object>} Une promesse qui résout avec l'ID du champ supprimé.
 */
export async function executeDeleteProjectField(
  octokit: any,
  { projectId, fieldId }: { projectId: string; fieldId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($fieldId: ID!) {
        deleteProjectV2Field(input: {
          fieldId: $fieldId
        }) {
          projectV2Field {
            ... on ProjectV2Field {
              id
            }
            ... on ProjectV2IterationField {
              id
            }
            ... on ProjectV2SingleSelectField {
              id
            }
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      fieldId,
    });

    const deletedField = result.deleteProjectV2Field?.projectV2Field;
    if (!deletedField) {
      throw new Error("La suppression du champ a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, deletedFieldId: deletedField.id };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}
/**
 * Convertit une note (draft issue) d'un projet en une issue GitHub standard.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la conversion.
 * @param {string} params.projectId - L'ID du projet contenant la note.
 * @param {string} params.draftId - L'ID de la note (draft issue) à convertir.
 * @returns {Promise<object>} Une promesse qui résout avec les informations de l'issue nouvellement créée.
 */
export async function executeConvertDraftToIssue(
  octokit: any,
  { projectId, draftId }: { projectId: string; draftId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $draftId: ID!) {
        convertProjectV2DraftIssueToIssue(input: {
          projectId: $projectId,
          draftIssueId: $draftId
        }) {
          issue {
            id
            number
            url
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
      draftId,
    });

    const issue = result.convertProjectV2DraftIssueToIssue?.issue;
    if (!issue) {
      throw new Error("La conversion de la note en issue a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, issue: { id: issue.id, number: issue.number, url: issue.url } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Archive un projet GitHub en le passant à l'état "CLOSED".
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour l'archivage.
 * @param {string} params.projectId - L'ID du projet à archiver.
 * @returns {Promise<object>} Une promesse qui résout avec les informations du projet mis à jour.
 */
export async function executeArchiveProject(
  octokit: any,
  { projectId }: { projectId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!) {
        updateProjectV2(input: {
          projectId: $projectId,
          closed: true
        }) {
          projectV2 {
            id
            closed
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
    });

    const project = result.updateProjectV2?.projectV2;
    if (!project) {
      throw new Error("L'archivage du projet a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, project: { id: project.id, closed: project.closed } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Désarchive un projet GitHub en le passant à l'état "OPEN".
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour le désarchivage.
 * @param {string} params.projectId - L'ID du projet à désarchiver.
 * @returns {Promise<object>} Une promesse qui résout avec les informations du projet mis à jour.
 */
export async function executeUnarchiveProject(
  octokit: any,
  { projectId }: { projectId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!) {
        updateProjectV2(input: {
          projectId: $projectId,
          closed: false
        }) {
          projectV2 {
            id
            closed
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
    });

    const project = result.updateProjectV2?.projectV2;
    if (!project) {
      throw new Error("Le désarchivage du projet a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, project: { id: project.id, closed: project.closed } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Récupère les éléments d'un projet GitHub, avec une option de filtrage côté client.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la récupération des éléments.
 * @param {string} params.projectId - L'ID du projet.
 * @param {any} [params.filterOptions] - Options pour filtrer les résultats côté client (ex: { state: 'Done' }).
 * @returns {Promise<object>} Une promesse qui résout avec la liste des éléments du projet.
 */
export async function executeGetProjectItems(
  octokit: any,
  { projectId, filterOptions }: { projectId: string; filterOptions?: any }
) {
  try {
    const variables: { [key: string]: any } = {
      id: projectId,
      first: 100,
    };
    
    let queryDef = `query GetProjectWithItems($id: ID!, $first: Int!, $after: String`;
    let itemsArgs = `first: $first, after: $after`;

    // GraphQL ne supportant pas le filtrage direct, nous récupérons tout et filtrons côté client.
    
    queryDef += `)`;

    const query = `
      ${queryDef} {
        node(id: $id) {
          ... on ProjectV2 {
            items(${itemsArgs}) {
              totalCount
              pageInfo {
                endCursor
                hasNextPage
              }
              nodes {
                id
                type
                content {
                  ... on DraftIssue {
                    title
                    body
                  }
                  ... on Issue {
                     title
                  }
                  ... on PullRequest {
                     title
                  }
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      date
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                        number
                        field { ... on ProjectV2FieldCommon { name } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await octokit.graphql(query, variables);
    const project = (response as any).node;
    if (!project) {
      throw new Error(`Projet non trouvé pour l'ID : ${projectId}.`);
    }
    let allItems = project.items.nodes;

    // Filtrage côté client
    if (filterOptions && Object.keys(filterOptions).length > 0) {
      allItems = allItems.filter((item: any) => {
        if (filterOptions.state) {
          const statusFieldValue = item.fieldValues.nodes.find(
            (fv: any) => fv.field?.name === 'Status'
          );
          if (statusFieldValue?.name?.toUpperCase() !== filterOptions.state.toUpperCase()) {
            return false;
          }
        }
        if (filterOptions.titleContains) {
          const title = item.content?.title?.toLowerCase() || '';
          if (!title.includes(filterOptions.titleContains.toLowerCase())) {
            return false;
          }
        }
        return true;
      });
    }

    return { success: true, items: allItems };
  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}
/**
 * Récupère les détails (titre et corps) d'un élément de projet spécifique (Issue, PR, ou DraftIssue).
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour la récupération des détails.
 * @param {string} params.itemId - L'ID de l'élément de projet.
 * @returns {Promise<{ success: boolean; item?: { title: string; body: string }; error?: string }>} Une promesse qui résout avec les détails de l'élément.
 */
export async function getProjectItemDetails(
  octokit: any,
  { itemId }: { itemId: string }
): Promise<{ success: boolean; item?: { title: string; body: string }; error?: string }> {
  try {
    const query = `
      query GetProjectItem($itemId: ID!) {
        node(id: $itemId) {
          ... on ProjectV2Item {
            content {
              ... on DraftIssue {
                title
                body
              }
              ... on Issue {
                title
                body
              }
              ... on PullRequest {
                title
                body
              }
            }
          }
        }
      }
    `;

    const response = await octokit.graphql(query, { itemId });
    const content = (response as any).node?.content;

    if (!content) {
      throw new Error(`Item non trouvé pour l'ID : ${itemId}.`);
    }

    return { success: true, item: { title: content.title, body: content.body } };
  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Analyse la complexité d'une tâche (item de projet) en se basant sur son titre et son corps.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour l'analyse.
 * @param {string} params.owner - Le propriétaire du dépôt.
 * @param {string} params.repo - Le nom du dépôt.
 * @param {number} params.projectNumber - Le numéro du projet (non utilisé directement dans la logique actuelle mais gardé pour le contexte).
 * @param {string} params.itemId - L'ID de l'item à analyser.
 * @returns {Promise<object>} Une promesse qui résout avec un objet indiquant la complexité ('faible', 'moyenne', 'élevée') et la raison.
 */
export async function analyze_task_complexity(
  octokit: any,
  { owner, repo, projectNumber, itemId }: { owner: string; repo: string; projectNumber: number; itemId: string; }
) {
  checkRepoPermissions(owner, repo);

  const itemDetails = await getProjectItemDetails(octokit, { itemId });

  if (!itemDetails.success || !itemDetails.item) {
    return { success: false, error: itemDetails.error || "Impossible de récupérer les détails de la tâche." };
  }

  const { title, body } = itemDetails.item;
  const fullText = `${title}\n${body || ''}`.toLowerCase();
  
  const keywords = ["investigate", "refactor", "security", "bug critique"];
  
  let complexity: 'faible' | 'moyenne' | 'élevée' = 'moyenne';
  let reasoning = 'La complexité est jugée moyenne par défaut.';

  if ((body || '').length < 50) {
    complexity = 'faible';
    reasoning = 'Le corps de la tâche est très court (< 50 caractères).';
  } else if ((body || '').length > 300 || keywords.some(kw => fullText.includes(kw))) {
    complexity = 'élevée';
    if ((body || '').length > 300) {
      reasoning = 'La description de la tâche est longue (> 300 caractères).';
    } else {
      const foundKeyword = keywords.find(kw => fullText.includes(kw));
      reasoning = `La tâche contient le mot-clé "${foundKeyword}".`;
    }
  }

  return { 
    success: true, 
    result: { 
      complexity, 
      reasoning 
    } 
  };
}
/**
 * Archive un élément d'un projet GitHub.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour l'archivage.
 * @param {string} params.projectId - L'ID du projet.
 * @param {string} params.itemId - L'ID de l'élément à archiver.
 * @returns {Promise<object>} Une promesse qui résout avec l'ID de l'élément archivé.
 */
export async function archiveProjectItem(
  octokit: any,
  { projectId, itemId }: { projectId: string; itemId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!) {
        archiveProjectV2Item(input: {
          projectId: $projectId,
          itemId: $itemId
        }) {
          item {
            id
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
      itemId,
    });

    const item = result.archiveProjectV2Item?.item;
    if (!item) {
      throw new Error("L'archivage de l'élément a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, item: { id: item.id } };

  } catch (e) {
    logger.error('GitHub API call failed in archiveProjectItem', { error: e });
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Désarchive un élément d'un projet GitHub.
 * @param {any} octokit - L'instance du client Octokit.
 * @param {object} params - Les paramètres pour le désarchivage.
 * @param {string} params.projectId - L'ID du projet.
 * @param {string} params.itemId - L'ID de l'élément à désarchiver.
 * @returns {Promise<object>} Une promesse qui résout avec l'ID de l'élément désarchivé.
 */
export async function unarchiveProjectItem(
  octokit: any,
  { projectId, itemId }: { projectId: string; itemId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $itemId: ID!) {
        unarchiveProjectV2Item(input: {
          projectId: $projectId,
          itemId: $itemId
        }) {
          item {
            id
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
      itemId,
    });

    const item = result.unarchiveProjectV2Item?.item;
    if (!item) {
      throw new Error("Le désarchivage de l'élément a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, item: { id: item.id } };

  } catch (e) {
    console.error('GitHub API call failed:', e);
    throw new Error(`GitHub API Error: ${(e as Error).message}`);
  }
}

/**
 * Récupère les détails d'un projet V2 par son Node ID.
 * @param octokit Le client Octokit.
 * @param projectId L'ID global du projet (node_id).
 * @returns Les détails du projet, y compris son numéro.
 */
export async function getProjectDetails(octokit: any, projectId: string): Promise<{ id: string; number: number; title: string; }> {
  try {
    const query = `
      query($id: ID!) {
        node(id: $id) {
          ... on ProjectV2 {
            id
            number
            title
          }
        }
      }
    `;
    const result = await (octokit.graphql as any)(query, { id: projectId });

    if (!result.node) {
      throw new Error(`Aucun projet trouvé avec l'ID ${projectId}`);
    }
    return result.node;
  } catch (error: any) {
    logger.error(`Erreur lors de la récupération des détails du projet ${projectId}`, { error });
    throw new Error(`Impossible de récupérer les détails du projet : ${error.message}`);
  }
}