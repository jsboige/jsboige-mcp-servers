# Guide de Dépannage

Ce document vous aide à résoudre les problèmes courants que vous pourriez rencontrer avec l'extension Roo et ses composants.

## Problèmes avec le MCP `roo-state-manager`

### Symptôme : Certaines conversations n'apparaissent pas ou le serveur semble instable.

Si vous remarquez que des conversations récentes sont manquantes ou que le `roo-state-manager` semble planter et redémarrer fréquemment, cela peut être dû à des fichiers de tâches corrompus.

**Cause Technique :**
Chaque conversation est stockée dans son propre dossier. Si l'un des fichiers de cette conversation (contenant les métadonnées ou l'historique) est mal formé, le processus de scan du serveur pouvait auparavant planter, l'empêchant de traiter les conversations suivantes.

**Solution Automatique :**
Le `roo-state-manager` a été mis à jour pour être plus résilient.
1.  **Gestion des Erreurs :** Le serveur va maintenant détecter les fichiers de tâches corrompus, ignorer la tâche problématique, et continuer à traiter les autres. Une erreur sera consignée dans les logs techniques pour analyse, mais cela n'interrompera plus le service.
2.  **Reconstruction du Cache au Démarrage :** À chaque démarrage, le serveur reconstruit la liste de toutes les conversations valides, garantissant que l'état affiché est toujours le plus propre possible.

**Que faire ?**
En général, aucune action n'est requise de votre part. Le système est conçu pour se réparer automatiquement. Si vous suspectez qu'une conversation spécifique est corrompue et souhaitez la récupérer, vous pouvez contacter le support technique en leur fournissant l'ID de la tâche (le nom du dossier de la conversation).

### Symptôme : La recherche sémantique ne trouve pas de résultats pour des tâches récentes.

**Cause Technique :**
La recherche sémantique repose sur un index. Si de nouvelles tâches sont créées pendant que le `roo-state-manager` est hors ligne, ou si le processus d'indexation échoue pour une raison quelconque, ces tâches ne seront pas incluses dans l'index et n'apparaîtront donc pas dans les résultats de recherche.

**Solution Automatique :**
Le `roo-state-manager` inclut désormais un processus de **réindexation automatique en tâche de fond** à chaque démarrage.
1.  Il scanne toutes les conversations valides.
2.  Il vérifie si chaque conversation est présente dans l'index de recherche.
3.  Toutes les conversations manquantes sont automatiquement ajoutées à une file d'attente et indexées en arrière-plan, sans impacter les performances du serveur.

**Que faire ?**
Aucune action n'est nécessaire. Attendez simplement quelques minutes après le démarrage de VS Code pour que le processus de réindexation se termine. Les tâches récemment créées devraient alors apparaître dans les résultats de recherche.