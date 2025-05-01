# Jinavigator MCP Server

Un serveur MCP qui utilise l'API Jina pour convertir des pages web en Markdown.

## Description

Jinavigator est un serveur MCP (Model Context Protocol) qui permet de convertir des pages web en Markdown en utilisant l'API Jina. L'API Jina fonctionne en ajoutant l'URL cible comme suffixe à l'URL de base "https://r.jina.ai/".

## Installation

```bash
# Installer les dépendances
npm install
```

## Compilation

```bash
# Compiler le projet TypeScript
npm run build
```

## Utilisation

```bash
# Démarrer le serveur
npm start
```

Ou pour le développement :

```bash
# Compiler et démarrer le serveur
npm run dev
```

## Outils disponibles

### convert_web_to_markdown

Convertit une page web en Markdown en utilisant l'API Jina.

**Paramètres d'entrée :**
- `url` (string, obligatoire) : URL de la page web à convertir en Markdown
- `start_line` (number, optionnel) : Ligne de début pour extraire une partie spécifique du contenu
- `end_line` (number, optionnel) : Ligne de fin pour extraire une partie spécifique du contenu

**Exemple d'utilisation :**

```json
{
  "url": "https://github.com/github/github-mcp-server",
  "start_line": 10,
  "end_line": 20
}
```

**Exemple de sortie :**

```json
{
  "result": "# GitHub MCP Server\n\nA Model Context Protocol server for GitHub...\n"
}
```

### access_jina_resource

Accède au contenu Markdown d'une page web via un URI au format jina://{url}.

**Paramètres d'entrée :**
- `uri` (string, obligatoire) : URI au format jina://{url} pour accéder au contenu Markdown d'une page web
- `start_line` (number, optionnel) : Ligne de début pour extraire une partie spécifique du contenu
- `end_line` (number, optionnel) : Ligne de fin pour extraire une partie spécifique du contenu

**Exemple d'utilisation :**

```json
{
  "uri": "jina://https://github.com/github/github-mcp-server"
}
```

**Exemple de sortie :**

```json
{
  "result": {
    "content": "# GitHub MCP Server\n\nA Model Context Protocol server for GitHub...\n",
    "contentType": "text/markdown"
  }
}
```

## Fonctionnement

Le serveur utilise l'API Jina pour convertir des pages web en Markdown. L'API Jina fonctionne en ajoutant l'URL cible comme suffixe à l'URL de base "https://r.jina.ai/".

Par exemple, pour convertir la page GitHub "https://github.com/github/github-mcp-server" en Markdown, on utiliserait "https://r.jina.ai/https://github.com/github/github-mcp-server".

## Filtrage du contenu

Le serveur permet de filtrer le contenu Markdown en spécifiant des bornes inférieures et supérieures sous forme de numéros de lignes. Cela est utile pour extraire seulement une partie spécifique du contenu d'une page web.

## Accès via URI

Le serveur fournit également un outil pour accéder au contenu Markdown d'une page web via un URI au format "jina://{url}". Cela permet d'utiliser le serveur comme une ressource MCP.