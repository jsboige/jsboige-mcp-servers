import logger from './logger';

export async function getRepositoryId(octokit: any, owner: string, repo: string): Promise<string> {
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
    logger.error("Erreur dans executeCreateIssue", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeUpdateProjectField(
  octokit: any,
  { projectId, fieldId, name }: { projectId: string; fieldId: string; name: string; }
) {
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
    logger.error("Erreur dans updateProjectV2Field", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeUpdateIssueState(
  octokit: any,
  { issueId, state }: { issueId: string, state: 'OPEN' | 'CLOSED' }
) {
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
    logger.error("Erreur dans update_issue_state", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeDeleteProject(
  octokit: any,
  { projectId }: { projectId: string }
) {
  try {
    const mutation = `
      mutation($projectId: ID!) {
        deleteProject(input: {projectId: $projectId}) {
          project {
            id
          }
        }
      }
    `;

    await octokit.graphql(mutation, {
      projectId,
    });

    return { success: true };

  } catch (error: any) {
    logger.error("Erreur dans delete_project", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, message: `Erreur GraphQL: ${readableError}` };
  }
}
export async function executeCreateProjectField(
  octokit: any,
  { projectId, name, dataType }: { projectId: string; name: string; dataType: 'TEXT' | 'NUMBER' | 'DATE' | 'SINGLE_SELECT' }
) {
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
    logger.error("Erreur dans createProjectV2Field", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeUpdateProjectItemField(
  octokit: any,
  { projectId, itemId, fieldId, fieldType, value, optionId }: 
  { projectId: string; itemId: string; fieldId: string; fieldType: 'text' | 'date' | 'single_select' | 'number'; value?: string; optionId?: string; }
) {
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
    logger.error("Erreur dans executeUpdateProjectItemField", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}

export async function executeDeleteProjectField(
  octokit: any,
  { projectId, fieldId }: { projectId: string; fieldId: string }
) {
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
    logger.error("Erreur dans deleteProjectV2Field", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}
export async function executeConvertDraftToIssue(
  octokit: any,
  { projectId, draftId }: { projectId: string; draftId: string }
) {
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
    logger.error("Erreur dans executeConvertDraftToIssue", { error: error.message, fullError: JSON.stringify(error, null, 2) });
    const graphqlErrors = error.response?.data?.errors;
    const readableError = graphqlErrors ? graphqlErrors.map((e: any) => e.message).join(', ') : (error.message || 'Erreur inconnue.');
    return { success: false, error: `Erreur GraphQL: ${readableError}` };
  }
}