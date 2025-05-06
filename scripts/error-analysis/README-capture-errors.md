# Outil de Capture des Erreurs Roo pour MCP Jupyter

Cet outil permet de capturer et d'analyser les messages d'erreur générés lors de l'utilisation du serveur MCP Jupyter avec Roo. Il est particulièrement utile lorsque vous ne pouvez pas copier-coller directement les messages d'erreur depuis la fenêtre de chat de Roo.

## Fonctionnalités

- Démarre automatiquement les serveurs Jupyter Notebook et MCP Jupyter
- Capture la sortie standard et d'erreur des deux serveurs
- Enregistre tous les messages dans un fichier log (`roo-errors.log`)
- Affiche les messages en temps réel dans la console avec code couleur
- Détecte automatiquement les erreurs courantes et suggère des solutions
- Compatible avec Windows, macOS et Linux

## Prérequis

- Node.js (v14 ou supérieur)
- Jupyter Notebook installé et accessible via la commande `jupyter`
- Le serveur MCP Jupyter correctement configuré

## Installation

Aucune installation supplémentaire n'est nécessaire si vous avez déjà configuré le serveur MCP Jupyter. L'outil utilise les mêmes dépendances.

## Utilisation

1. Ouvrez un terminal dans le répertoire racine du projet
2. Exécutez la commande suivante:

```bash
node capture-roo-errors.js
```

3. Attendez que les deux serveurs démarrent (vous verrez un message de confirmation)
4. Utilisez Roo normalement avec le serveur MCP Jupyter
5. Si des erreurs se produisent, consultez le fichier `roo-errors.log` et la console pour les détails
6. Pour arrêter les serveurs, appuyez sur `Ctrl+C` dans le terminal

## Interprétation des logs

Le fichier de log contient les informations suivantes:

- Horodatage de chaque message
- Source du message (Jupyter Notebook, MCP Jupyter Server ou Système)
- Type de message (INFO ou ERREUR)
- Contenu du message
- Solutions suggérées pour les erreurs détectées

Exemple de log:
```
2025-02-05T00:38:24.123Z [INFO] [Système] Démarrage de Jupyter Notebook...
2025-02-05T00:38:26.456Z [INFO] [Jupyter Notebook] Jupyter Notebook 6.4.12 is running at http://localhost:8888/
2025-02-05T00:38:30.789Z [ERREUR] [MCP Jupyter Server] Erreur lors de l'initialisation des services Jupyter: Error: connect ECONNREFUSED 127.0.0.1:8888

=== SOLUTIONS POSSIBLES ===
- Impossible de se connecter au serveur Jupyter. Vérifiez qu'il est bien démarré sur le port 8888.
=========================
```

## Erreurs courantes et solutions

### 1. Erreur de connexion au serveur Jupyter

**Symptôme**: Messages contenant `ECONNREFUSED` ou `Erreur lors de l'initialisation des services Jupyter`

**Solutions**:
- Vérifiez que Jupyter Notebook est bien démarré et accessible à l'adresse http://localhost:8888
- Vérifiez qu'aucun pare-feu ne bloque la connexion
- Si Jupyter utilise un port différent, modifiez la configuration dans `servers/jupyter-mcp-server/config.json`

### 2. Problème d'authentification

**Symptôme**: Messages contenant `token invalid` ou erreurs d'authentification

**Solutions**:
- Vérifiez le token dans `servers/jupyter-mcp-server/config.json`
- Récupérez le token correct depuis la console Jupyter ou l'URL de Jupyter

### 3. Problèmes avec les kernels

**Symptôme**: Messages contenant `Kernel non trouvé` ou erreurs liées aux kernels

**Solutions**:
- Vérifiez que le kernel demandé existe (généralement `python3`)
- Assurez-vous de démarrer un kernel avant d'exécuter du code
- Utilisez l'ID de kernel retourné par l'outil `start_kernel`

### 4. Jupyter non installé ou non accessible

**Symptôme**: Messages contenant `n'est pas installé ou n'est pas dans le PATH`

**Solutions**:
- Installez Jupyter avec `pip install jupyter`
- Assurez-vous que la commande `jupyter` est accessible dans votre PATH

## Personnalisation

Vous pouvez personnaliser le comportement de l'outil en modifiant les paramètres dans la section `config` au début du fichier `capture-roo-errors.js`:

- `jupyterCommand`: Commande pour démarrer Jupyter (par défaut: `jupyter`)
- `jupyterArgs`: Arguments pour Jupyter (par défaut: `['notebook', '--no-browser']`)
- `startupDelay`: Délai d'attente après le démarrage de Jupyter (par défaut: `5000` ms)
- `logFile`: Chemin du fichier de log (par défaut: `roo-errors.log`)
- `errorPatterns`: Patterns d'erreurs à détecter et leurs solutions

## Contribution

Pour améliorer cet outil:

1. Ajoutez de nouveaux patterns d'erreurs dans la section `errorPatterns` du fichier `capture-roo-errors.js`
2. Améliorez les solutions suggérées pour les erreurs existantes
3. Ajoutez des fonctionnalités supplémentaires pour faciliter le débogage

## Limitations

- Cet outil ne peut pas capturer directement les erreurs affichées dans l'interface de Roo
- Il capture uniquement les erreurs générées par les serveurs Jupyter et MCP Jupyter
- Pour les erreurs spécifiques à Roo, vous devrez toujours noter manuellement les messages d'erreur

## Support

Si vous rencontrez des problèmes avec cet outil, veuillez:

1. Vérifier le fichier de log pour les erreurs détaillées
2. Consulter les solutions suggérées dans ce README
3. Si le problème persiste, ouvrez une issue sur le dépôt GitHub du projet