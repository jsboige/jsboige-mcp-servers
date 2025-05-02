# Guide de démarrage

Ce guide vous aidera à démarrer avec les serveurs MCP (Model Context Protocol) en vous expliquant les prérequis, l'installation, la configuration et l'utilisation de base.

## Table des matières

- [Prérequis](#prérequis)
- [Installation](#installation)
  - [Installation globale](#installation-globale)
  - [Installation d'un serveur spécifique](#installation-dun-serveur-spécifique)
- [Configuration](#configuration)
  - [Configuration automatique](#configuration-automatique)
  - [Configuration manuelle](#configuration-manuelle)
  - [Configuration des clés API](#configuration-des-clés-api)
- [Utilisation](#utilisation)
  - [Démarrer un serveur MCP](#démarrer-un-serveur-mcp)
  - [Connecter un serveur MCP à un LLM](#connecter-un-serveur-mcp-à-un-llm)
  - [Exemples d'utilisation](#exemples-dutilisation)
- [Dépannage](#dépannage)
- [Ressources supplémentaires](#ressources-supplémentaires)

## Prérequis

Avant de commencer, assurez-vous d'avoir installé les outils suivants:

- **Node.js** (version 14.x ou supérieure)
  - Vérifiez votre version avec `node --version`
  - Téléchargez la dernière version depuis [nodejs.org](https://nodejs.org/)

- **npm** (version 6.x ou supérieure)
  - Vérifiez votre version avec `npm --version`
  - npm est généralement installé avec Node.js

- **Git**
  - Vérifiez votre version avec `git --version`
  - Téléchargez la dernière version depuis [git-scm.com](https://git-scm.com/)

Selon les serveurs MCP que vous souhaitez utiliser, vous pourriez avoir besoin de:

- Clés API pour certains services externes (par exemple, OpenWeatherMap pour le serveur météo)
- Droits d'administrateur pour certains utilitaires système
- Outils de développement spécifiques pour certains serveurs Dev Tools

## Installation

### Installation globale

Pour installer tous les serveurs MCP disponibles:

1. **Clonez le dépôt**:

```bash
git clone https://github.com/jsboige/jsboige-mcp-servers.git
cd jsboige-mcp-servers
```

2. **Installez les dépendances principales**:

```bash
npm install
```

3. **Installez tous les serveurs MCP**:

```bash
npm run install-all
```

Cette commande parcourt tous les répertoires de serveurs et exécute `npm install` dans chacun.

### Installation d'un serveur spécifique

Si vous souhaitez installer uniquement un serveur MCP spécifique:

1. **Clonez le dépôt** (si ce n'est pas déjà fait):

```bash
git clone https://github.com/jsboige/jsboige-mcp-servers.git
cd jsboige-mcp-servers
```

2. **Installez les dépendances principales**:

```bash
npm install
```

3. **Installez un serveur spécifique**:

```bash
# Exemple pour installer le serveur météo
cd servers/api-connectors/weather-api
npm install
```

## Configuration

### Configuration automatique

Pour configurer automatiquement tous les serveurs MCP:

```bash
npm run setup-config
```

Ce script vous guidera à travers la configuration de chaque serveur MCP disponible. Il vous posera des questions pour chaque paramètre de configuration et créera les fichiers de configuration nécessaires.

### Configuration manuelle

Vous pouvez également configurer manuellement chaque serveur:

1. **Copiez le fichier de configuration d'exemple**:

```bash
# Exemple pour le serveur météo
cp servers/api-connectors/weather-api/config.example.json servers/api-connectors/weather-api/config.json
```

2. **Éditez le fichier de configuration** avec votre éditeur préféré:

```bash
# Exemple avec VS Code
code servers/api-connectors/weather-api/config.json
```

3. **Modifiez les paramètres** selon vos besoins.

### Configuration des clés API

De nombreux serveurs MCP nécessitent des clés API pour accéder à des services externes. Voici comment les configurer:

1. **Obtenez une clé API** auprès du service concerné:
   - Pour OpenWeatherMap: [openweathermap.org/api](https://openweathermap.org/api)
   - Pour Google Search: [developers.google.com/custom-search](https://developers.google.com/custom-search)
   - Etc.

2. **Ajoutez la clé API** dans le fichier de configuration du serveur:

```json
{
  "apiKey": "VOTRE_CLÉ_API_ICI",
  "endpoint": "https://api.example.com",
  "timeout": 5000
}
```

3. **Protégez vos clés API**:
   - Ne partagez jamais vos clés API
   - N'incluez pas les fichiers de configuration contenant des clés API dans les dépôts publics
   - Les fichiers `config.json` sont déjà ignorés par Git (via `.gitignore`)

## Utilisation

### Démarrer un serveur MCP

Pour démarrer un serveur MCP:

```bash
# Exemple pour démarrer le serveur météo
cd servers/api-connectors/weather-api
node server.js
```

Par défaut, le serveur démarrera sur le port 3000 (ou le port spécifié dans la configuration). Vous verrez un message indiquant que le serveur est en cours d'exécution.

Pour démarrer un serveur avec des options spécifiques:

```bash
# Exemple pour démarrer le serveur sur un port différent
node server.js --port 3001
```

### Connecter un serveur MCP à un LLM

Les serveurs MCP peuvent être connectés à différents LLM qui supportent le protocole MCP. La méthode exacte dépend de l'interface LLM que vous utilisez, mais voici les étapes générales:

1. **Démarrez le serveur MCP** comme indiqué ci-dessus.

2. **Dans votre interface LLM**, configurez la connexion au serveur MCP:
   - Spécifiez l'URL du serveur (par exemple, `http://localhost:3000`)
   - Fournissez les informations d'authentification si nécessaire
   - Sélectionnez les outils que vous souhaitez activer

3. **Testez la connexion** en demandant au LLM d'utiliser un des outils fournis par le serveur MCP.

### Exemples d'utilisation

#### Exemple 1: Utilisation du serveur QuickFiles pour lister des répertoires

```
Utilisateur: Peux-tu me lister les fichiers dans mon répertoire src?

LLM: Je vais lister les fichiers dans votre répertoire src.
[Utilisation de l'outil quickfiles-server.list_directory_contents avec les paramètres {"paths": [{"path": "src", "recursive": true}]}]
Voici les fichiers dans votre répertoire src:
## Répertoire: src
📁 components/
  📄 Button.js - 2.5 KB (120 lignes)
  📄 Header.js - 1.8 KB (85 lignes)
  📄 Footer.js - 1.2 KB (60 lignes)
📁 utils/
  📄 helpers.js - 3.2 KB (150 lignes)
  📄 api.js - 4.5 KB (210 lignes)
📄 index.js - 0.8 KB (40 lignes)
📄 App.js - 2.1 KB (100 lignes)
```

#### Exemple 2: Utilisation du serveur QuickFiles pour lire plusieurs fichiers

```
Utilisateur: Peux-tu me montrer le contenu des fichiers index.js et App.js?

LLM: Je vais vous montrer le contenu de ces fichiers.
[Utilisation de l'outil quickfiles-server.read_multiple_files avec les paramètres {"paths": ["src/index.js", "src/App.js"], "show_line_numbers": true}]

## Fichier: src/index.js
```
1 | import React from 'react';
2 | import ReactDOM from 'react-dom';
3 | import './index.css';
4 | import App from './App';
5 |
6 | ReactDOM.render(
7 |   <React.StrictMode>
8 |     <App />
9 |   </React.StrictMode>,
10 | document.getElementById('root')
11 | );
```

## Fichier: src/App.js
```
1 | import React, { useState } from 'react';
2 | import './App.css';
3 | import Header from './components/Header';
4 | import Footer from './components/Footer';
5 | import Button from './components/Button';
6 |
7 | function App() {
8 |   const [count, setCount] = useState(0);
9 |
10 |   return (
11 |     <div className="App">
12 |       <Header />
13 |       <main>
14 |         <h1>Counter: {count}</h1>
15 |         <Button onClick={() => setCount(count + 1)}>
16 |           Increment
17 |         </Button>
18 |       </main>
19 |       <Footer />
20 |     </div>
21 |   );
22 | }
23 |
24 | export default App;
```
```

#### Exemple 3: Utilisation du serveur QuickFiles pour éditer plusieurs fichiers

```
Utilisateur: Peux-tu ajouter un commentaire de copyright à tous mes fichiers JavaScript?

LLM: Je vais ajouter un commentaire de copyright à vos fichiers JavaScript.
[Utilisation de l'outil quickfiles-server.edit_multiple_files avec les paramètres {
  "files": [
    {
      "path": "src/index.js",
      "diffs": [
        {
          "search": "import React from 'react';",
          "replace": "/**\n * Copyright 2025 - Tous droits réservés\n */\nimport React from 'react';"
        }
      ]
    },
    {
      "path": "src/App.js",
      "diffs": [
        {
          "search": "import React, { useState } from 'react';",
          "replace": "/**\n * Copyright 2025 - Tous droits réservés\n */\nimport React, { useState } from 'react';"
        }
      ]
    },
    {
      "path": "src/components/Button.js",
      "diffs": [
        {
          "search": "import React from 'react';",
          "replace": "/**\n * Copyright 2025 - Tous droits réservés\n */\nimport React from 'react';"
        }
      ]
    }
  ]
}]

J'ai ajouté un commentaire de copyright à tous vos fichiers JavaScript. Voici un résumé des modifications:
- src/index.js: Ajout du commentaire de copyright
- src/App.js: Ajout du commentaire de copyright
- src/components/Button.js: Ajout du commentaire de copyright
```

#### Exemple 4: Utilisation du serveur QuickFiles pour supprimer des fichiers

```
Utilisateur: Peux-tu supprimer tous les fichiers temporaires dans mon répertoire tmp?

LLM: Je vais supprimer les fichiers temporaires.
[Utilisation de l'outil quickfiles-server.list_directory_contents avec les paramètres {"paths": [{"path": "tmp", "recursive": false}]}]

J'ai trouvé les fichiers suivants dans le répertoire tmp:
- tmp/temp1.txt
- tmp/temp2.txt
- tmp/important.json
- tmp/backup.zip

Je vais supprimer uniquement les fichiers temporaires.
[Utilisation de l'outil quickfiles-server.delete_files avec les paramètres {
  "paths": [
    "tmp/temp1.txt",
    "tmp/temp2.txt"
  ]
}]

J'ai supprimé les fichiers temporaires suivants:
- tmp/temp1.txt
- tmp/temp2.txt

Les fichiers importants (important.json et backup.zip) ont été conservés.
```

#### Exemple 5: Utilisation du serveur Jupyter MCP

```
Utilisateur: Peux-tu créer un notebook Jupyter qui analyse des données avec pandas?

LLM: Je vais créer un notebook Jupyter pour vous.
[Utilisation de l'outil jupyter-mcp-server.create_notebook avec les paramètres {"path": "data_analysis.ipynb", "kernel": "python3"}]
J'ai créé un nouveau notebook. Maintenant, je vais ajouter des cellules avec du code pour l'analyse de données.

[Utilisation de l'outil jupyter-mcp-server.add_cell avec les paramètres {"path": "data_analysis.ipynb", "cell_type": "markdown", "source": "# Analyse de données avec pandas\n\nCe notebook montre comment charger et analyser des données avec pandas."}]

[Utilisation de l'outil jupyter-mcp-server.add_cell avec les paramètres {"path": "data_analysis.ipynb", "cell_type": "code", "source": "import pandas as pd\nimport matplotlib.pyplot as plt\nimport numpy as np\n\n# Pour afficher les graphiques dans le notebook\n%matplotlib inline"}]

[Utilisation de l'outil jupyter-mcp-server.add_cell avec les paramètres {"path": "data_analysis.ipynb", "cell_type": "code", "source": "# Créer des données d'exemple\ndata = {\n    'Produit': ['A', 'B', 'C', 'D', 'E'],\n    'Ventes': [150, 200, 125, 300, 175],\n    'Prix': [10, 15, 8, 25, 12]\n}\n\ndf = pd.DataFrame(data)\ndf"}]

[Utilisation de l'outil jupyter-mcp-server.add_cell avec les paramètres {"path": "data_analysis.ipynb", "cell_type": "code", "source": "# Calculer le chiffre d'affaires\ndf['CA'] = df['Ventes'] * df['Prix']\ndf"}]

[Utilisation de l'outil jupyter-mcp-server.add_cell avec les paramètres {"path": "data_analysis.ipynb", "cell_type": "code", "source": "# Visualiser les ventes\nplt.figure(figsize=(10, 6))\nplt.bar(df['Produit'], df['Ventes'], color='skyblue')\nplt.title('Ventes par produit')\nplt.xlabel('Produit')\nplt.ylabel('Ventes')\nplt.grid(axis='y', linestyle='--', alpha=0.7)\nplt.show()"}]

Le notebook a été créé avec succès. Vous pouvez maintenant l'ouvrir dans Jupyter et exécuter les cellules pour voir l'analyse de données.
```

## Dépannage

Si vous rencontrez des problèmes lors de l'installation ou de l'utilisation des serveurs MCP, consultez le [Guide de dépannage](troubleshooting.md) pour des solutions aux problèmes courants.

Voici quelques problèmes fréquents:

- **Erreur "Module not found"**: Assurez-vous d'avoir exécuté `npm install` dans le répertoire du serveur.
- **Erreur "EADDRINUSE"**: Le port est déjà utilisé. Essayez un autre port avec `--port`.
- **Erreur "Invalid API key"**: Vérifiez que votre clé API est correcte et active.
- **Le LLM ne peut pas se connecter au serveur**: Vérifiez que le serveur est en cours d'exécution et que l'URL est correcte.

## Ressources supplémentaires

- [Documentation sur l'architecture MCP](architecture.md)
- [Guide de contribution](../CONTRIBUTING.md)
- [Spécification MCP officielle](https://github.com/microsoft/mcp)
- [Licence](../LICENSE)

Si vous avez besoin d'aide supplémentaire, n'hésitez pas à [ouvrir une issue](https://github.com/jsboige/jsboige-mcp-servers/issues) sur GitHub.