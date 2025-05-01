# Serveur MCP Jupyter

Ce serveur MCP permet d'interagir avec des notebooks Jupyter, en offrant des fonctionnalités pour la lecture, la modification et l'exécution de notebooks.

## Fonctionnalités

- **Gestion des notebooks** : lecture, modification et sauvegarde de notebooks Jupyter
- **Exécution de code** : démarrage et arrêt de kernels, exécution de cellules individuelles ou de notebooks complets
- **Récupération des résultats** : récupération des sorties textuelles et riches (images, HTML, etc.)

## Outils MCP exposés

1. `read_notebook` : Lit un notebook Jupyter à partir d'un fichier
2. `write_notebook` : Écrit/sauvegarde un notebook Jupyter dans un fichier
3. `create_notebook` : Crée un nouveau notebook vide
4. `add_cell` : Ajoute une cellule à un notebook
5. `remove_cell` : Supprime une cellule d'un notebook
6. `update_cell` : Modifie une cellule d'un notebook
7. `list_kernels` : Liste les kernels disponibles et actifs
8. `start_kernel` : Démarre un nouveau kernel
9. `stop_kernel` : Arrête un kernel actif
10. `interrupt_kernel` : Interrompt l'exécution d'un kernel
11. `restart_kernel` : Redémarre un kernel
12. `execute_cell` : Exécute du code dans un kernel spécifique
13. `execute_notebook` : Exécute toutes les cellules de code d'un notebook
14. `execute_notebook_cell` : Exécute une cellule spécifique d'un notebook

## Prérequis

- Node.js (v14 ou supérieur)
- Python avec Jupyter installé (voir section Installation de Jupyter ci-dessous)
- Un serveur Jupyter en cours d'exécution (par défaut sur http://localhost:8888)

## Installation de Jupyter

Pour utiliser ce serveur MCP, vous devez avoir Jupyter installé et en cours d'exécution. Voici comment l'installer et le démarrer :

1. Un environnement virtuel Python a été créé dans le dossier `jupyter-env` pour isoler les dépendances
2. Jupyter est installé dans cet environnement virtuel
3. Pour démarrer le serveur Jupyter, exécutez le script `start-jupyter.bat`

Le serveur Jupyter démarrera sans ouvrir de navigateur. Il sera accessible à l'adresse http://localhost:8888.

## Installation

1. Clonez ce dépôt
2. Installez les dépendances :

```bash
npm install
```

3. Compilez le projet :

```bash
npm run build
```

## Configuration

Par défaut, le serveur MCP Jupyter se connecte à un serveur Jupyter en cours d'exécution sur http://localhost:8888. Vous pouvez modifier cette configuration en passant des options lors de l'initialisation du serveur.

## Utilisation

Pour démarrer le serveur MCP Jupyter :

```bash
npm start
```

## Dépendances principales

- `@modelcontextprotocol/sdk` : SDK pour l'implémentation du serveur MCP
- `@jupyterlab/services` : Pour l'interaction avec les kernels Jupyter
- `nbformat` : Pour la manipulation des fichiers notebook
- `ws` : Pour la communication WebSocket
- `axios` : Pour les requêtes HTTP

## Exemple d'utilisation

Voici un exemple d'utilisation du serveur MCP Jupyter pour exécuter une cellule de code :

```javascript
// Démarrer un kernel
const kernelResponse = await client.callTool('jupyter-mcp-server', 'start_kernel', {
  kernel_name: 'python3'
});

const kernelId = kernelResponse.kernel_id;

// Exécuter du code
const result = await client.callTool('jupyter-mcp-server', 'execute_cell', {
  kernel_id: kernelId,
  code: 'print("Hello, world!")'
});

console.log(result.outputs);

// Arrêter le kernel
await client.callTool('jupyter-mcp-server', 'stop_kernel', {
  kernel_id: kernelId
});
```

## Remarques importantes

- Assurez-vous que le serveur Jupyter est en cours d'exécution avant de démarrer le serveur MCP Jupyter.
- Pour utiliser ce serveur MCP, vous devez avoir installé les dépendances nécessaires, notamment `@modelcontextprotocol/sdk` et `@jupyterlab/services`.