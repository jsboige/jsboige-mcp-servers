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