import logger from './logger';

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