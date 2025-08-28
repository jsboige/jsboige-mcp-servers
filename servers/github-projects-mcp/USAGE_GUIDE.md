# Guide d'Utilisation du MCP `github-projects`

Ce document explique comment configurer et utiliser le MCP `github-projects` pour interagir avec l'API GitHub Projects V2.

## 1. Configuration Essentielle

Le bon fonctionnement de ce MCP repose sur une configuration correcte de l'authentification.

### Méthode Recommandée : Fichier `.env`

La méthode la plus simple et la plus robuste consiste à créer un fichier `.env` à la racine de ce serveur MCP (`mcps/internal/servers/github-projects-mcp/.env`).

Ce fichier doit contenir les tokens d'accès personnels (Personal Access Tokens) et la structure des comptes que vous souhaitez utiliser.

**Exemple de fichier `.env` :**

```dotenv
# Token pour le compte principal
GITHUB_TOKEN="ghp_VOTRE_TOKEN_POUR_COMPTE_1"

# Token pour un second compte
GITHUB_TOKEN_EPITA="ghp_VOTRE_TOKEN_POUR_COMPTE_2"

# Structure JSON qui mappe les propriétaires (owners) aux tokens
# Le serveur lira cette variable pour configurer l'accès multi-comptes.
GITHUB_ACCOUNTS_JSON="[{\"owner\": \"compte1\", \"token\": \"${env:GITHUB_TOKEN}\"}, {\"owner\": \"compte2\", \"token\": \"${env:GITHUB_TOKEN_EPITA}\"}]"
```

### Permissions (Scopes) du Token

Chaque token GitHub doit avoir au minimum les permissions (scopes) suivantes pour fonctionner avec ce MCP :

*   **`read:project`** : Pour lire les informations des projets.
*   **`write:project`** : Pour modifier les projets (créer des items, changer des statuts, etc.).
*   **`repo`** : Pour accéder aux informations des dépôts liés aux projets.
*   **`user`** : Pour lire les informations de base de l'utilisateur.

## 2. Outils Disponibles

Voici la liste des outils exposés par le MCP.

---
### `list_projects`

**Description:**
Liste les projets GitHub d'un utilisateur ou d'une organisation.

**Paramètres:**
*   `owner` (string, obligatoire): Nom d'utilisateur ou d'organisation.
*   `type` (string, optionnel, défaut: 'user'): Type de propriétaire. Peut être 'user' ou 'org'.
*   `state` (string, optionnel, défaut: 'open'): État des projets à récupérer. Peut être 'open', 'closed', ou 'all'.

**Exemple d'appel JSON:**
```json
{
  "owner": "jsboige",
  "type": "user"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "projects": [
    {
      "id": "PVT_kwHOADA1Xc4A-dZy",
      "title": "Test Project - 1753112188261",
      "number": 24,
      "description": null,
      "url": "https://github.com/users/jsboige/projects/24",
      "closed": false,
      "createdAt": "2025-07-21T15:36:29Z",
      "updatedAt": "2025-07-21T15:36:43Z"
    }
  ]
}
```

**Exemple de gestion d'erreur (Owner non trouvé):**
```json
{
  "success": false,
  "error": "Erreur API: Could not resolve to a User with the login of 'owner-inexistant'."
}
```

---
### `list_repositories`

**Description:**
Liste les dépôts d'un utilisateur ou d'une organisation.

**Paramètres:**
*   `owner` (string, obligatoire): Nom d'utilisateur ou d'organisation.
*   `type` (string, optionnel, défaut: 'user'): Type de propriétaire. Peut être 'user' ou 'org'.

**Exemple d'appel JSON:**
```json
{
  "owner": "jsboige",
  "type": "user"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "repositories": [
    {
      "id": "R_kgDOL_f-fA",
      "name": "roo-extensions",
      "url": "https://github.com/jsboige/roo-extensions"
    }
  ]
}
```

**Exemple de gestion d'erreur (Owner non trouvé):**
```json
{
  "success": false,
  "error": "Erreur API: Could not resolve to a User with the login of 'owner-inexistant'."
}
```

---
### `create_project`

**Description:**
Crée un nouveau projet GitHub.

**Paramètres:**
*   `owner` (string, obligatoire): Nom du propriétaire du projet (utilisateur ou organisation).
*   `title` (string, obligatoire): Titre du nouveau projet.
*   `repository_id` (string, optionnel): ID du dépôt à lier au projet.

**Exemple d'appel JSON:**
```json
{
  "owner": "jsboige",
  "title": "Mon Nouveau Projet de Test"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "project": {
    "id": "PVT_kwHOADA1Xc4A-daz",
    "title": "Mon Nouveau Projet de Test",
    "number": 25,
    "url": "https://github.com/users/jsboige/projects/25",
    "closed": false
  }
}
```

**Exemple de gestion d'erreur (Permissions manquantes):**
```json
{
  "success": false,
  "error": "Erreur GraphQL: You do not have the required permissions to create a project for this owner."
}
```

---
### `get_project`

**Description:**
Récupère les détails d'un projet GitHub, y compris ses éléments et ses champs.

**Paramètres:**
*   `owner` (string, obligatoire): Nom d'utilisateur ou d'organisation propriétaire du projet.
*   `project_number` (number, obligatoire): Le numéro du projet à récupérer.
*   `type` (string, optionnel, défaut: 'user'): Le type de propriétaire ('user' or 'org').

**Exemple d'appel JSON:**
```json
{
  "owner": "jsboige",
  "project_number": 24
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "project": {
    "id": "PVT_kwHOADA1Xc4A-dZy",
    "title": "Test Project - 1753112188261",
    "number": 24,
    "shortDescription": null,
    "url": "https://github.com/users/jsboige/projects/24",
    "closed": false,
    "createdAt": "2025-07-21T15:36:29Z",
    "updatedAt": "2025-07-21T15:36:43Z",
    "items": {
      "nodes": []
    },
    "fields": {
      "nodes": [
        {
          "id": "PVTSSF_lAHOADA1Xc4A-dZyzgH88lI",
          "name": "Status"
        }
      ]
    }
  }
}
```

**Exemple de gestion d'erreur (Projet non trouvé):**
```json
{
  "success": false,
  "error": "Projet non trouvé pour jsboige/99."
}
```

---
### `add_item_to_project`

**Description:**
Ajoute un élément (issue, pull request, ou note) à un projet.

**Paramètres:**
*   `owner` (string, obligatoire): Le propriétaire du projet.
*   `project_id` (string, obligatoire): L'ID du projet.
*   `content_id` (string, optionnel): L'ID de l'issue ou de la pull request. Requis si `content_type` n'est pas `draft_issue`.
*   `content_type` (string, optionnel, défaut: 'issue'): Type de contenu. Peut être 'issue', 'pull_request', ou 'draft_issue'.
*   `draft_title` (string, optionnel): Titre pour une note (`draft_issue`). Requis si `content_type` est `draft_issue`.
*   `draft_body` (string, optionnel): Corps pour une note.

**Exemple d'appel JSON (créer une note):**
```json
{
  "owner": "jsboige",
  "project_id": "PVT_kwHOADA1Xc4A-dZy",
  "content_type": "draft_issue",
  "draft_title": "Nouvelle tâche à faire"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "item_id": "PVTI_lAHOADA1Xc4A-dZyzgS88lQ"
}
```

**Exemple de gestion d'erreur (Paramètre manquant):**
```json
{
  "success": false,
  "error": "Le titre est requis pour une draft_issue."
}
```

---
### `update_project_item_field`

**Description:**
Met à jour la valeur d'un champ pour un élément dans un projet.

**Paramètres:**
*   `owner` (string, obligatoire): Le propriétaire du projet.
*   `project_id` (string, obligatoire): L'ID du projet.
*   `item_id` (string, obligatoire): L'ID de l'élément à modifier.
*   `field_id` (string, obligatoire): L'ID du champ à modifier.
*   `field_type` (string, obligatoire): Le type du champ. Peut être 'text', 'date', 'single_select', ou 'number'.
*   `value` (string, optionnel): La nouvelle valeur pour les champs de type 'text', 'date', ou 'number'.
*   `option_id` (string, optionnel): L'ID de l'option pour un champ de type `single_select`.

**Exemple d'appel JSON (changer le statut d'un item):**
```json
{
  "owner": "jsboige",
  "project_id": "PVT_kwHOADA1Xc4A-dZy",
  "item_id": "PVTI_lAHOADA1Xc4A-dZyzgS88lQ",
  "field_id": "PVTSSF_lAHOADA1Xc4A-dZyzgH88lI",
  "field_type": "single_select",
  "option_id": "47fc9ee4"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "updated_item_id": "PVTI_lAHOADA1Xc4A-dZyzgS88lQ"
}
```

**Exemple de gestion d'erreur (ID de champ invalide):**
```json
{
  "success": false,
  "error": "Erreur GraphQL: Field value is not valid for this field."
}
```

---
### `delete_project_item`

**Description:**
Supprime un élément d'un projet.

**Paramètres:**
*   `owner` (string, obligatoire): Le propriétaire du projet.
*   `project_id` (string, obligatoire): L'ID du projet.
*   `item_id` (string, obligatoire): L'ID de l'élément à supprimer.

**Exemple d'appel JSON:**
```json
{
  "owner": "jsboige",
  "project_id": "PVT_kwHOADA1Xc4A-dZy",
  "item_id": "PVTI_lAHOADA1Xc4A-dZyzgS88lQ"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "deleted_item_id": "PVTI_lAHOADA1Xc4A-dZyzgS88lQ"
}
```

**Exemple de gestion d'erreur (Item non trouvé):**
```json
{
  "success": false,
  "error": "Erreur API: Could not resolve to a node with the global id of 'ID_INVALIDE'"
}
```

---
### `delete_project`

**Description:**
Supprime un projet GitHub.

**Paramètres:**
*   `owner` (string, obligatoire): Le propriétaire du projet.
*   `projectId` (string, obligatoire): L'ID du projet à supprimer.

**Exemple d'appel JSON:**
```json
{
  "owner": "jsboige",
  "projectId": "PVT_kwHOADA1Xc4A-daz"
}
```

**Exemple de résultat réussi:**
```json
{
  "success": true,
  "deletedProjectId": "PVT_kwHOADA1Xc4A-daz"
}
```

**Exemple de gestion d'erreur (ID de projet invalide):**
```json
{
  "success": false,
  "error": "Erreur GraphQL: Could not resolve to a node with the global id of 'ID_INVALIDE'"
}
```

---