import logger from './logger.js';

/**
 * Vérifie si le mode lecture seule est activé.
 * Lance une erreur si la variable d'environnement GITHUB_PROJECTS_READ_ONLY est définie sur 'true'.
 */
export function checkReadOnlyMode(): void {
  const isReadOnly = process.env.GITHUB_PROJECTS_READ_ONLY;
  if (isReadOnly === 'true' || isReadOnly === '1') {
    throw new Error('Read-only mode is enabled. Write operations are disabled.');
  }
}

/**
 * Vérifie si le dépôt est dans la liste des dépôts autorisés définie par la variable d'environnement
 * GITHUB_PROJECTS_ALLOWED_REPOS.
 * @param owner - Le propriétaire du dépôt.
 * @param repo - Le nom du dépôt.
 * @throws {Error} Si le dépôt n'est pas autorisé.
 */
export function checkRepoPermissions(owner: string, repo: string): void {
  const allowedReposVar = process.env.GITHUB_PROJECTS_ALLOWED_REPOS;
  if (!allowedReposVar) {
    // Si la variable n'est pas définie, on autorise tout
    return;
  }

  const allowedRepos = allowedReposVar.split(',').map(r => r.trim());
  const repoFullName = `${owner}/${repo}`;

  if (!allowedRepos.includes(repoFullName)) {
    throw new Error(`Access denied: Repository '${repoFullName}' is not in the allowed list.`);
  }
}

export async function getRepositoryId(octokit: any, owner: string, repo: string): Promise<string> {
  checkRepoPermissions(owner, repo);
  const query = `
    query GetRepositoryId($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        id
      }
    }
  `;
  const response = await octokit.graphql(query, { owner, repo }) as { repository: { id: string } };
  if (!response.repository?.id) {
    throw new Error(`Dépôt non trouvé : ${owner}/${repo}`);
  }
  return response.repository.id;
}

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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans executeCreateIssue: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeUpdateProjectField(
  octokit: any,
  { projectId, fieldId, name }: { projectId: string; fieldId: string; name: string; }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $fieldId: ID!, $name: String!) {
        updateProjectV2Field(input: {
          projectId: $projectId,
          fieldId: $fieldId,
          name: $name
        }) {
          projectV2Field {
            id
            name
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
      fieldId,
      name,
    });

    const field = result.updateProjectV2Field?.projectV2Field;
    if (!field) {
      throw new Error("La mise à jour du champ a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, field: { id: field.id, name: field.name } };

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans updateProjectV2Field: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans update_issue_state: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeDeleteProject(
  octokit: any,
  { projectId }: { projectId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!) {
        deleteProject(input: {projectId: $projectId}) {
          clientMutationId
        }
      }
    `;

    await octokit.graphql(mutation, {
      projectId,
    });

    return { success: true };

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans delete_project: ${readableError}`);
    return { success: false, message: `Erreur GraphQL: ${readableError}` };
  }
}
export async function executeCreateProjectField(
  octokit: any,
  { projectId, name, dataType }: { projectId: string; name: string; dataType: 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $dataType: ProjectV2FieldType!, $name: String!) {
        createProjectV2Field(input: {
          projectId: $projectId,
          dataType: $dataType,
          name: $name
        }) {
          projectV2Field {
            id
            name
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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans createProjectV2Field: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans executeUpdateProjectItemField: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeDeleteProjectField(
  octokit: any,
  { projectId, fieldId }: { projectId: string; fieldId: string }
) {
  checkReadOnlyMode();
  try {
    const mutation = `
      mutation($projectId: ID!, $fieldId: ID!) {
        deleteProjectV2Field(input: {
          projectId: $projectId,
          fieldId: $fieldId
        }) {
          projectV2Field {
            id
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      projectId,
      fieldId,
    });

    const deletedField = result.deleteProjectV2Field?.projectV2Field;
    if (!deletedField) {
      throw new Error("La suppression du champ a échoué ou n'a pas retourné les informations attendues.");
    }

    return { success: true, deletedFieldId: deletedField.id };

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans deleteProjectV2Field: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}
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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans executeConvertDraftToIssue: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

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
          state: CLOSED
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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans executeArchiveProject: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

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
          state: OPEN
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

  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans executeUnarchiveProject: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

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
  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans executeGetProjectItems: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}
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
  } catch (error: any) {
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    logger.error(`Erreur dans getProjectItemDetails: ${readableError}`);
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

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