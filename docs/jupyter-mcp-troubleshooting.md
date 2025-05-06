# Guide de dépannage pour le serveur MCP Jupyter

Ce document présente les problèmes identifiés avec le serveur MCP Jupyter, les solutions recommandées, et les bonnes pratiques pour assurer un fonctionnement optimal.

## Problèmes courants et solutions

### Erreurs 403 Forbidden

**Symptômes**:
- Les requêtes à l'API Jupyter échouent avec une erreur 403 Forbidden.
- Les logs du serveur Jupyter affichent des messages comme `wrote error: 'Forbidden'`.
- Messages d'erreur dans les logs: 
```
[W 2025-05-02 13:03:39.329 ServerApp] wrote error: 'Forbidden'
[W 2025-05-02 13:03:39.329 ServerApp] 403 GET /api/sessions?1746183819327 (@::1) 1.00ms referer=None
```

**Causes**:
1. Token d'authentification incorrect ou mal configuré
2. Méthode d'authentification incompatible
3. Problèmes de CORS (Cross-Origin Resource Sharing)

**Solutions**:
1. **Vérifier la configuration du token**:
   - Assurez-vous que le token configuré dans `config.json` correspond exactement au token utilisé pour démarrer le serveur Jupyter.
   - Exemple de configuration correcte:
   ```json
   {
     "jupyterServer": {
       "baseUrl": "http://localhost:8888",
       "token": "test_token"
     }
   }
   ```

2. **Utiliser la méthode d'authentification recommandée**:
   - Utilisez à la fois le token dans l'URL et dans l'en-tête d'autorisation:
   ```javascript
   const response = await axios.get(`${apiUrl}?token=${token}`, {
     headers: {
       'Authorization': `token ${token}`
     }
   });
   ```
   - Testez différentes méthodes d'authentification en utilisant le script `test-jupyter-connection-status.js`.

3. **Configurer correctement le serveur Jupyter**:
   - Démarrez le serveur avec les options appropriées:
   ```bash
   jupyter notebook --NotebookApp.token=test_token --NotebookApp.allow_origin='*' --no-browser
   ```

4. **Redémarrer les services**:
   - Redémarrez le serveur Jupyter et le serveur MCP Jupyter.
   - Vérifiez que les deux services sont correctement démarrés avant de tenter une connexion.

### Paramètre content manquant

**Symptômes**:
- Les appels aux outils comme `write_notebook` échouent avec une erreur indiquant que le paramètre `content` est manquant.

**Causes**:
1. Format incorrect des paramètres
2. Incompatibilité entre le schéma d'outil et les paramètres attendus

**Solutions**:
1. **Vérifier le format des paramètres**:
   - Assurez-vous que tous les paramètres requis sont fournis lors de l'appel de l'outil.
   - Pour `write_notebook`, le paramètre `content` doit être un objet JSON valide conforme au format nbformat.

2. **Vérifier les schémas d'outils**:
   - Assurez-vous que les schémas d'outils correspondent aux attentes du serveur MCP.
   - Exemple de schéma correct pour `write_notebook`:
   ```javascript
   {
     type: "object",
     properties: {
       path: {
         type: "string",
         description: "Chemin du fichier notebook (.ipynb)"
       },
       content: {
         type: "object",
         description: "Contenu du notebook au format nbformat"
       }
     },
     required: ["path", "content"]
   }
   ```

### Erreur XSRF

**Symptômes**:
- Les requêtes POST ou PUT échouent avec une erreur XSRF.

**Causes**:
1. Protection XSRF (Cross-Site Request Forgery) activée sur le serveur Jupyter
2. Token XSRF manquant dans les requêtes

**Solutions**:
1. **Ajouter un en-tête X-XSRFToken**:
   - Récupérez d'abord le token XSRF via une requête GET.
   - Ajoutez l'en-tête `X-XSRFToken` aux requêtes POST et PUT.

2. **Désactiver temporairement la protection XSRF** (pour les tests uniquement):
   ```bash
   jupyter notebook --NotebookApp.disable_check_xsrf=True --NotebookApp.token=test_token --no-browser
   ```

3. **Implémentation correcte**:
   ```javascript
   // Récupérer le token XSRF
   const xsrfResponse = await axios.get(`${baseUrl}/api/contents?token=${token}`);
   const xsrfToken = xsrfResponse.headers['set-cookie']
     .find(cookie => cookie.startsWith('_xsrf='))
     .split('=')[1]
     .split(';')[0];
   
   // Utiliser le token XSRF dans les requêtes POST/PUT
   const response = await axios.post(`${baseUrl}/api/contents?token=${token}`, data, {
     headers: {
       'Authorization': `token ${token}`,
       'X-XSRFToken': xsrfToken
     }
   });
   ```

### Problèmes de gestion des kernels

**Symptômes**:
- Les outils de gestion des kernels (`start_kernel`, `stop_kernel`, etc.) ne fonctionnent pas de manière fiable.
- Erreurs lors de l'exécution de code via les outils `execute_cell` et `execute_notebook`.

**Causes**:
1. Problèmes d'authentification
2. Kernels non démarrés ou dans un état incorrect
3. Incompatibilité de version

**Solutions**:
1. **Vérifier l'état des kernels**:
   - Utilisez l'outil `list_kernels` pour vérifier les kernels disponibles et actifs.
   - Assurez-vous qu'un kernel est démarré avant d'essayer d'exécuter du code.

2. **Redémarrer les kernels problématiques**:
   - Si un kernel est bloqué, utilisez l'outil `restart_kernel` pour le redémarrer.
   - En cas d'échec, arrêtez le kernel avec `stop_kernel` puis démarrez-en un nouveau.

3. **Vérifier la compatibilité**:
   - Assurez-vous que la version de Jupyter utilisée est compatible avec le serveur MCP Jupyter.
   - Vérifiez les versions des bibliothèques `@jupyterlab/services` et autres dépendances.

## Configuration correcte

### Configuration du serveur Jupyter

Pour un fonctionnement optimal, configurez le serveur Jupyter avec les options suivantes:

```bash
jupyter notebook --NotebookApp.token=test_token --NotebookApp.allow_origin='*' --no-browser
```

Options importantes:
- `--NotebookApp.token=test_token`: Définit un token d'authentification explicite.
- `--NotebookApp.allow_origin='*'`: Autorise les requêtes cross-origin (important pour l'API).
- `--no-browser`: Empêche l'ouverture automatique du navigateur.

Pour les environnements de production, remplacez `'*'` par l'origine spécifique de votre application et utilisez un token sécurisé.

### Configuration du MCP Jupyter

Assurez-vous que le fichier `config.json` dans le répertoire du serveur MCP Jupyter contient les informations correctes:

```json
{
  "jupyterServer": {
    "baseUrl": "http://localhost:8888",
    "token": "test_token"
  }
}
```

Remplacez `test_token` par le même token utilisé pour démarrer le serveur Jupyter.

## Bonnes pratiques

### Vérification de la connexion

Avant d'utiliser les outils MCP Jupyter, vérifiez que la connexion au serveur Jupyter est établie:

```javascript
// Exemple de code pour vérifier la connexion
async function testConnection() {
  try {
    // Essayer avec le token dans l'URL et dans l'en-tête
    const response = await axios.get(`${baseUrl}/api/contents?token=${token}`, {
      headers: {
        'Authorization': `token ${token}`
      }
    });
    console.log('Connexion réussie!');
    return true;
  } catch (error) {
    console.error('Erreur de connexion:', error.message);
    return false;
  }
}
```

### Gestion des erreurs

Implémentez une gestion robuste des erreurs dans vos applications:

1. **Tentatives multiples**: Essayez différentes méthodes d'authentification en cas d'échec.
2. **Logs détaillés**: Enregistrez des informations détaillées pour faciliter le diagnostic.
3. **Dégradation gracieuse**: Permettez à l'application de continuer à fonctionner avec des fonctionnalités limitées en cas d'échec de connexion.

### Tests systématiques

Testez régulièrement la connexion et les fonctionnalités:

1. Utilisez le script `test-jupyter-connection-status.js` pour tester différentes méthodes d'authentification.
2. Créez des tests automatisés pour chaque outil MCP Jupyter.
3. Documentez les résultats des tests et les problèmes rencontrés.

## Références utiles

- [Documentation officielle de Jupyter](https://jupyter-notebook.readthedocs.io/en/stable/)
- [API Jupyter Server](https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html)
- [Documentation sur l'authentification Jupyter](https://jupyter-notebook.readthedocs.io/en/stable/security.html)
- [GitHub du projet Jupyter Extension pour VSCode](https://github.com/microsoft/vscode-jupyter)
- [Documentation de la bibliothèque @jupyterlab/services](https://jupyterlab.github.io/jupyterlab/services/)

## Conclusion

Les problèmes d'authentification sont à l'origine de la plupart des difficultés rencontrées avec le serveur MCP Jupyter. En suivant les recommandations de ce guide, vous devriez pouvoir résoudre ces problèmes et assurer un fonctionnement fiable du serveur MCP Jupyter.

Si vous rencontrez des problèmes persistants, n'hésitez pas à consulter les logs détaillés du serveur Jupyter et du serveur MCP, et à ouvrir une issue sur le dépôt GitHub du projet.