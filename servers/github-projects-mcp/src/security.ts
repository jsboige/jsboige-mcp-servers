/**
 * Vérifie si le mode lecture seule est activé en inspectant la variable d'environnement `GITHUB_PROJECTS_READ_ONLY`.
 * Lance une erreur si le mode lecture seule est activé, bloquant les opérations d'écriture.
 * @returns {void} - Ne retourne rien si le mode écriture est activé.
 * @throws {Error} Si `GITHUB_PROJECTS_READ_ONLY` est défini sur 'true' ou '1'.
 */
export function checkReadOnlyMode(): void {
  const isReadOnly = process.env.GITHUB_PROJECTS_READ_ONLY;
  if (isReadOnly === 'true' || isReadOnly === '1') {
    throw new Error('Read-only mode is enabled. Write operations are disabled.');
  }
}

/**
 * Vérifie si un dépôt est autorisé en le comparant à la liste blanche définie
 * dans la variable d'environnement `GITHUB_PROJECTS_ALLOWED_REPOS`.
 * Si la variable n'est pas définie, tous les dépôts sont autorisés.
 * @param {string} owner - Le propriétaire du dépôt (utilisateur ou organisation).
 * @param {string} repo - Le nom du dépôt.
 * @returns {void} - Ne retourne rien si le dépôt est autorisé.
 * @throws {Error} Si le dépôt n'est pas dans la liste des dépôts autorisés.
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