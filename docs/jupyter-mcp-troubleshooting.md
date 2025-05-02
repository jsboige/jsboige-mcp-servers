# Guide de dépannage pour le serveur MCP Jupyter

Ce document présente les problèmes identifiés avec le serveur MCP Jupyter, les modifications déjà apportées pour améliorer la gestion des erreurs, et les pistes à explorer pour résoudre complètement les problèmes d'authentification.

## Problèmes identifiés

### Erreurs 403 Forbidden

Le principal problème rencontré est l'erreur `403 Forbidden` lors des requêtes à l'API Jupyter. Ces erreurs se produisent généralement dans les situations suivantes :

```
[W 2025-05-02 13:03:39.329 ServerApp] wrote error: 'Forbidden'
[W 2025-05-02 13:03:39.329 ServerApp] 403 GET /api/sessions?1746183819327 (@::1) 1.00ms referer=None
```

Cette erreur indique un problème d'authentification entre le serveur MCP et le serveur Jupyter. Bien que le token soit correctement configuré dans `config.json`, il semble que l'authentification échoue dans certains cas.

### Causes possibles

1. **Méthode d'authentification incompatible** : Le serveur Jupyter peut utiliser différentes méthodes d'authentification selon sa version et sa configuration.
2. **Problèmes de format du token** : Le token peut ne pas être transmis dans le format attendu par le serveur Jupyter.
3. **Problèmes de timing** : Des problèmes de synchronisation peuvent survenir si les requêtes sont envoyées avant que le serveur Jupyter ne soit complètement initialisé.
4. **Problèmes de CORS** : Des restrictions de partage de ressources entre origines peuvent bloquer certaines requêtes.

## Modifications déjà apportées

### Amélioration de la gestion des erreurs

Le code du serveur MCP Jupyter a été modifié pour améliorer la gestion des erreurs d'authentification :

1. **Tentatives multiples d'authentification** : Dans la fonction `testConnection()` du fichier `jupyter.ts`, le code tente d'abord une authentification avec le token via l'URL, puis essaie une seconde approche sans authentification si la première échoue.

2. **Continuation malgré les erreurs** : Le serveur est configuré pour continuer à fonctionner même en cas d'échec de connexion, ce qui permet d'éviter les interruptions complètes du service.

3. **Logs détaillés** : Des messages de log ont été ajoutés pour faciliter le diagnostic des problèmes d'authentification.

## Pistes à explorer

### 1. Méthodes d'authentification alternatives

Jupyter supporte plusieurs méthodes d'authentification :

- **Token dans l'URL** : `?token=<token>`
- **En-tête d'autorisation** : `Authorization: token <token>`
- **Cookie** : `_xsrf=<token>`

Il serait utile d'implémenter et de tester ces différentes méthodes pour déterminer laquelle fonctionne le mieux avec la configuration actuelle.

### 2. Vérification de la version de Jupyter

Les API Jupyter peuvent varier selon les versions. Il est important de vérifier la compatibilité entre la version de l'API utilisée par le serveur MCP et celle du serveur Jupyter en cours d'exécution.

```javascript
// Exemple de code pour vérifier la version de l'API Jupyter
async function checkJupyterVersion() {
  try {
    const response = await axios.get(`${baseUrl}/api`);
    console.log('Version de l\'API Jupyter:', response.data.version);
    return response.data.version;
  } catch (error) {
    console.error('Erreur lors de la vérification de la version:', error);
    return null;
  }
}
```

### 3. Utilisation de la bibliothèque officielle Jupyter

La bibliothèque `@jupyterlab/services` est utilisée dans le code actuel, mais il pourrait être utile de vérifier si nous utilisons les méthodes les plus récentes et les plus appropriées pour l'authentification.

### 4. Gestion des sessions

Les erreurs 403 se produisent souvent lors des requêtes à `/api/sessions`. Une meilleure gestion des sessions pourrait aider à résoudre ces problèmes :

```javascript
// Exemple de code pour une meilleure gestion des sessions
async function listSessions() {
  try {
    // Utiliser directement l'API de SessionManager
    const sessions = await sessionManager.refreshRunning();
    return sessions;
  } catch (error) {
    console.error('Erreur lors de la récupération des sessions:', error);
    
    // Tentative alternative avec axios
    try {
      const response = await axios.get(
        `${baseUrl}/api/sessions?token=${token}`,
        { headers: { Authorization: `token ${token}` } }
      );
      return response.data;
    } catch (secondError) {
      console.error('Échec de la tentative alternative:', secondError);
      return [];
    }
  }
}
```

## Références à la documentation de l'extension Jupyter de VSCode

L'extension Jupyter de VSCode gère efficacement la connexion aux kernels existants. Voici quelques références utiles pour comprendre son fonctionnement :

1. [Documentation officielle de l'extension Jupyter pour VSCode](https://code.visualstudio.com/docs/datascience/jupyter-notebooks)
2. [GitHub du projet Jupyter Extension pour VSCode](https://github.com/microsoft/vscode-jupyter)
3. [Documentation sur l'authentification Jupyter](https://jupyter-notebook.readthedocs.io/en/stable/security.html)
4. [API Jupyter Server](https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html)

### Points clés de l'extension VSCode

- **Détection automatique des serveurs** : L'extension VSCode peut détecter automatiquement les serveurs Jupyter en cours d'exécution.
- **Gestion des tokens** : Elle gère efficacement l'authentification par token.
- **Reconnexion** : Elle implémente des stratégies de reconnexion en cas d'échec.

## Étapes de débogage recommandées

1. **Vérifier les logs du serveur Jupyter** pour identifier précisément quand et pourquoi les erreurs 403 se produisent.
2. **Tester différentes méthodes d'authentification** en utilisant le script `test-jupyter-connection-status.js`.
3. **Comparer le comportement** avec l'extension Jupyter de VSCode pour identifier les différences dans la gestion de l'authentification.
4. **Mettre à jour la bibliothèque @jupyterlab/services** vers la dernière version compatible.
5. **Implémenter une stratégie de reconnexion** plus robuste en cas d'échec d'authentification.

## Conclusion

Les problèmes d'authentification avec le serveur Jupyter semblent principalement liés à la méthode d'authentification utilisée. En explorant les différentes méthodes d'authentification et en améliorant la gestion des erreurs, nous devrions pouvoir résoudre ces problèmes et assurer une connexion stable entre le serveur MCP et le serveur Jupyter.