import { Octokit } from '@octokit/rest';

// Structure partagée
export interface GitHubAccount {
  owner: string;
  token: string;
}

/**
 * Obtient un client GitHub authentifié pour un propriétaire spécifique.
 * @param owner Le nom du propriétaire du compte GitHub à utiliser.
 * @param accounts La liste des comptes GitHub disponibles.
 * @returns Une instance d'Octokit authentifiée.
 */
export function getGitHubClient(owner: string | undefined, accounts: GitHubAccount[]): Octokit {
  console.log('[GP-MCP][GITHUB] Appel de getGitHubClient avec owner:', owner, 'et accounts:', JSON.stringify(accounts));
  let token: string | undefined;

  let account: GitHubAccount | undefined;
  if (owner) {
    account = accounts.find(acc => acc.owner.toLowerCase() === owner.toLowerCase());
    if (!account) {
      throw new Error(`[GP-MCP][CONFIG_ERROR] Aucun compte trouvé pour le propriétaire '${owner}'.`);
    }
  } else if (accounts.length > 0) {
    account = accounts[0];
  }

  if (!account) {
    throw new Error('[GP-MCP][CONFIG_ERROR] Aucun compte GitHub n\'est configuré.');
  }

  token = account.token;

  // Tenter de résoudre la variable d'environnement si le token est sous la forme ${env:VAR}
  const envVarMatch = token.match(/^\${env:(.*)}$/);
  if (envVarMatch && envVarMatch[1]) {
    const envVarName = envVarMatch[1];
    token = process.env[envVarName];
    if (!token) {
      throw new Error(`[GP-MCP][CONFIG_ERROR] La variable d'environnement '${envVarName}' spécifiée dans la configuration n'est pas définie.`);
    }
  }

  if (!token) {
    throw new Error('[GP-MCP][CONFIG_ERROR] Le token GitHub est vide ou non défini après résolution.');
  }

  console.log(`[GP-MCP][GITHUB] Utilisation du token: ${token}`);

  return new Octokit({
    auth: token,
    userAgent: 'github-projects-mcp/0.1.0',
    timeZone: 'Europe/Paris',
    baseUrl: 'https://api.github.com',
  });
}

/**
 * Vérifie si un utilisateur ou une organisation existe sur GitHub
 * @param octokit Client GitHub
 * @param owner Nom d'utilisateur ou d'organisation
 * @param type Type de propriétaire (user ou org)
 * @returns Booléen indiquant si le propriétaire existe
 */
export async function checkOwnerExists(octokit: Octokit, owner: string, type: 'user' | 'org'): Promise<boolean> {
  try {
    if (type === 'user') {
      await octokit.users.getByUsername({ username: owner });
    } else {
      await octokit.orgs.get({ org: owner });
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Obtient l'ID d'un utilisateur ou d'une organisation
 * @param octokit Client GitHub
 * @param owner Nom d'utilisateur ou d'organisation
 * @param type Type de propriétaire (user ou org)
 * @returns ID du propriétaire
 */
export async function getOwnerId(octokit: Octokit, owner: string, type: 'user' | 'org'): Promise<string> {
  try {
    const query = `
      query($login: String!) {
        ${type === 'user' ? 'user' : 'organization'}(login: $login) {
          id
        }
      }
    `;

    const response = await octokit.graphql(query, {
      login: owner
    });

    // Ajouter une assertion de type pour response
    const typedResponse = response as any;
    return type === 'user' ? typedResponse.user.id : typedResponse.organization.id;
  } catch (error: any) {
    throw new Error(`Erreur lors de la récupération de l'ID du propriétaire: ${error.message}`);
  }
}

/**
 * Vérifie si un projet existe
 * @param octokit Client GitHub
 * @param owner Nom d'utilisateur ou d'organisation
 * @param projectNumber Numéro du projet
 * @returns Booléen indiquant si le projet existe
 */
export async function checkProjectExists(octokit: Octokit, owner: string, projectNumber: number): Promise<boolean> {
  try {
    const query = `
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
          }
        }
      }
    `;

    await octokit.graphql(query, {
      owner,
      number: projectNumber
    });

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Obtient l'ID d'un projet à partir de son numéro
 * @param octokit Client GitHub
 * @param owner Nom d'utilisateur ou d'organisation
 * @param projectNumber Numéro du projet
 * @returns ID du projet
 */
export async function getProjectId(octokit: Octokit, owner: string, projectNumber: number): Promise<string> {
  try {
    const query = `
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
          }
        }
      }
    `;

    const response = await octokit.graphql(query, {
      owner,
      number: projectNumber
    });

    // Ajouter une assertion de type pour response
    const typedResponse = response as any;
    return typedResponse.user.projectV2.id;
  } catch (error: any) {
    throw new Error(`Erreur lors de la récupération de l'ID du projet: ${error.message}`);
  }
}

/**
 * Obtient les champs disponibles pour un projet
 * @param octokit Client GitHub
 * @param projectId ID du projet
 * @returns Liste des champs du projet
 */
export async function getProjectFields(octokit: Octokit, projectId: string): Promise<any[]> {
  try {
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
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
      projectId
    });

    // Ajouter une assertion de type pour response
    const typedResponse = response as any;
    return typedResponse.node.fields.nodes;
  } catch (error: any) {
    throw new Error(`Erreur lors de la récupération des champs du projet: ${error.message}`);
  }
}