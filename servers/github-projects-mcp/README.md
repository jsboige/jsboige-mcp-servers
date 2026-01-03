# GitHub Projects MCP Server

This MCP server provides tools to interact with GitHub Projects.

## Prerequisites

- Node.js
- A GitHub Personal Access Token with `repo` and `project` scopes.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Create a `.env` file in the root of this server's directory (`mcps/internal/servers/github-projects-mcp`).
3.  Add your GitHub token to the `.env` file:
    ```
    GITHUB_TOKEN=your_personal_access_token
    ```

## Running the Server

To start the server for development or general use:

```bash
npm start
```

## Testing

The End-to-End (E2E) tests require the server to be running independently.

**1. Build the project:**

Make sure you have the latest code compiled:
```bash
npm run build
```

**2. Start the test server:**

In your first terminal, run:
```bash
npm run start:e2e
```
The server will start on the port specified in the `.env` file or on port 3000 by default. The E2E tests will connect to it on port 3001.

**3. Run the E2E tests:**

In a second terminal, run:
```bash
npm run test:e2e
```
Jest will execute the tests located in the `tests/` directory against the running server.

## Tools

### Monitoring des Workflows GitHub Actions

Cette section décrit les outils disponibles pour surveiller et analyser les workflows GitHub Actions d'un dépôt.

#### `list_repository_workflows`

Liste tous les workflows définis dans un dépôt GitHub.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt (utilisateur ou organisation)
- `repo` (string) : Nom du dépôt

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "workflows": [
    {
      "id": 161335,
      "node_id": "MDg6V29ya2Zsb3cxNjEzMzU=",
      "name": "CI",
      "path": ".github/workflows/ci.yml",
      "state": "active",
      "created_at": "2020-01-08T23:48:37.000Z",
      "updated_at": "2020-01-08T23:50:21.000Z",
      "url": "https://api.github.com/repos/octocat/Hello-World/actions/workflows/161335",
      "html_url": "https://github.com/octocat/Hello-World/blob/master/.github/workflows/ci.yml",
      "badge_url": "https://github.com/octocat/Hello-World/workflows/CI/badge.svg"
    }
  ]
}
```

#### `get_workflow_runs`

Récupère les exécutions (runs) d'un workflow spécifique, avec leur statut et leurs détails.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt
- `repo` (string) : Nom du dépôt
- `workflow_id` (number) : ID du workflow (peut aussi accepter le nom du fichier .yml)

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "workflow_runs": [
    {
      "id": 30433642,
      "name": "Build",
      "node_id": "MDExOldvcmtmbG93UnVuMzA0MzM2NDI=",
      "head_branch": "master",
      "head_sha": "acb5820ced9479c074f688cc328bf03f341a511d",
      "run_number": 562,
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "workflow_id": 161335,
      "created_at": "2020-01-22T19:33:08Z",
      "updated_at": "2020-01-22T19:33:08Z",
      "url": "https://api.github.com/repos/github/hello-world/actions/runs/30433642",
      "html_url": "https://github.com/github/hello-world/actions/runs/30433642"
    }
  ]
}
```

#### `get_workflow_run_status`

Obtient le statut détaillé d'une exécution de workflow spécifique.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt
- `repo` (string) : Nom du dépôt
- `run_id` (number) : ID de l'exécution du workflow

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "workflow_run": {
    "id": 30433642,
    "name": "Build",
    "node_id": "MDExOldvcmtmbG93UnVuMzA0MzM2NDI=",
    "head_branch": "master",
    "head_sha": "acb5820ced9479c074f688cc328bf03f341a511d",
    "run_number": 562,
    "event": "push",
    "status": "completed",
    "conclusion": "success",
    "workflow_id": 161335,
    "created_at": "2020-01-22T19:33:08Z",
    "updated_at": "2020-01-22T19:33:08Z",
    "url": "https://api.github.com/repos/github/hello-world/actions/runs/30433642",
    "html_url": "https://github.com/github/hello-world/actions/runs/30433642"
  }
}
```

**États possibles pour `status` :**
- `completed` : L'exécution est terminée
- `in_progress` : L'exécution est en cours
- `queued` : L'exécution est en file d'attente
- `requested` : L'exécution a été demandée
- `waiting` : L'exécution attend
- `pending` : L'exécution est en attente

**Conclusions possibles pour `conclusion` (si status = "completed") :**
- `success` : L'exécution s'est terminée avec succès
- `failure` : L'exécution a échoué
- `cancelled` : L'exécution a été annulée
- `skipped` : L'exécution a été ignorée
- `timed_out` : L'exécution a expiré
- `action_required` : Une action manuelle est requise
- `neutral` : L'exécution s'est terminée de manière neutre

### Gestion des Issues de Dépôt

Cette section décrit les outils disponibles pour gérer les issues (issues classiques) d'un dépôt GitHub.

#### `list_repository_issues`

Liste toutes les issues d'un dépôt GitHub avec support de pagination et filtrage par état.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt (utilisateur ou organisation)
- `repo` (string) : Nom du dépôt
- `state` (string, optionnel) : État des issues à récupérer (`open`, `closed`, ou `all`). Par défaut : `open`
- `per_page` (number, optionnel) : Nombre d'issues par page. Par défaut : 30
- `page` (number, optionnel) : Numéro de page. Par défaut : 1

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "issues": [
    {
      "id": 1,
      "number": 1,
      "title": "Issue de test",
      "state": "open",
      "html_url": "https://github.com/owner/repo/issues/1",
      "user": {
        "login": "owner"
      },
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ],
  "total_count": 1
}
```

#### `get_repository_issue`

Récupère les détails complets d'une issue spécifique d'un dépôt.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt
- `repo` (string) : Nom du dépôt
- `issue_number` (number) : Numéro de l'issue

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "issue": {
    "id": 1,
    "number": 1,
    "title": "Issue de test",
    "body": "Description de l'issue",
    "state": "open",
    "html_url": "https://github.com/owner/repo/issues/1",
    "user": {
      "login": "owner"
    },
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z",
    "comments": 0
  }
}
```

#### `delete_repository_issue`

Supprime (ferme) une issue d'un dépôt. **Note :** GitHub ne permet pas de supprimer directement les issues. L'outil ferme l'issue à la place.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt
- `repo` (string) : Nom du dépôt
- `issue_number` (number) : Numéro de l'issue à supprimer
- `comment` (string, optionnel) : Commentaire à ajouter avant la fermeture

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "issue": {
    "number": 1,
    "state": "closed",
    "html_url": "https://github.com/owner/repo/issues/1"
  },
  "note": "GitHub ne permet pas de supprimer directement les issues. L'issue a été fermée à la place."
}
```

#### `delete_repository_issues_bulk`

Supprime (ferme) plusieurs issues d'un dépôt en une seule opération. Idéal pour nettoyer un grand nombre d'issues de test.

**Paramètres :**
- `owner` (string) : Nom du propriétaire du dépôt
- `repo` (string) : Nom du dépôt
- `issueNumbers` (number[]) : Liste des numéros d'issues à supprimer
- `comment` (string, optionnel) : Commentaire à ajouter avant la fermeture de chaque issue

**Exemple de retour en cas de succès :**
```json
{
  "success": true,
  "deleted": [
    { "number": 1, "url": "https://github.com/owner/repo/issues/1" },
    { "number": 2, "url": "https://github.com/owner/repo/issues/2" }
  ],
  "failed": [],
  "note": "GitHub ne permet pas de supprimer directement les issues. Les issues ont été fermées à la place."
}
```

**Exemple d'utilisation pour nettoyer des issues de test :**
```javascript
// Supprimer 246 issues de test en une seule opération
{
  "owner": "jsboige",
  "repo": "roo-extensions",
  "issueNumbers": [1, 2, 3, ..., 246],
  "comment": "Issue de test supprimée automatiquement"
}
```

**Note importante :** GitHub ne permet pas de supprimer directement les issues via l'API. Ces outils ferment les issues à la place. Les issues fermées restent visibles dans l'historique du dépôt mais ne sont plus actives.