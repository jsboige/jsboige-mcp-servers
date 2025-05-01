# System Utils

Ce répertoire contient des serveurs MCP qui fournissent des utilitaires système pour permettre aux LLM d'interagir avec le système d'exploitation et les ressources locales.

## Serveurs disponibles

Actuellement, ce répertoire ne contient pas encore de serveurs MCP. Voici quelques exemples de serveurs qui pourraient être ajoutés:

### File Manager

Un serveur MCP pour gérer les fichiers et répertoires sur le système local.

**Outils potentiels:**
- `list_files`: Lister les fichiers dans un répertoire
- `read_file`: Lire le contenu d'un fichier
- `write_file`: Écrire dans un fichier
- `search_files`: Rechercher des fichiers par nom ou contenu
- `get_file_info`: Obtenir des informations sur un fichier (taille, date de modification, etc.)

### System Monitor

Un serveur MCP pour surveiller les ressources système.

**Outils potentiels:**
- `get_system_info`: Obtenir des informations sur le système (OS, CPU, mémoire, etc.)
- `monitor_cpu`: Surveiller l'utilisation du CPU
- `monitor_memory`: Surveiller l'utilisation de la mémoire
- `monitor_disk`: Surveiller l'utilisation du disque
- `monitor_network`: Surveiller l'activité réseau

### Process Manager

Un serveur MCP pour gérer les processus système.

**Outils potentiels:**
- `list_processes`: Lister les processus en cours d'exécution
- `start_process`: Démarrer un nouveau processus
- `stop_process`: Arrêter un processus
- `get_process_info`: Obtenir des informations sur un processus

### Database Connector

Un serveur MCP pour se connecter à des bases de données locales.

**Outils potentiels:**
- `execute_query`: Exécuter une requête SQL
- `list_databases`: Lister les bases de données disponibles
- `list_tables`: Lister les tables d'une base de données
- `get_schema`: Obtenir le schéma d'une table

## Comment ajouter un nouveau serveur

Pour ajouter un nouveau serveur System Util:

1. Créez un nouveau répertoire avec le nom du serveur
2. Suivez la structure standard des serveurs MCP:
   ```
   server-name/
   ├── README.md           # Documentation du serveur
   ├── package.json        # Dépendances et scripts
   ├── server.js           # Point d'entrée du serveur
   ├── config.example.json # Configuration d'exemple
   └── src/                # Code source
   ```
3. Implémentez les outils et ressources nécessaires
4. Documentez l'utilisation du serveur dans le README.md
5. Ajoutez des tests pour vérifier le bon fonctionnement

## Bonnes pratiques

- Implémentez des mesures de sécurité strictes pour éviter les abus
- Limitez l'accès aux ressources sensibles du système
- Validez soigneusement toutes les entrées utilisateur
- Documentez clairement les permissions requises pour chaque outil
- Assurez-vous que les outils fonctionnent sur différents systèmes d'exploitation (Windows, Linux, macOS)
- Gérez correctement les erreurs et fournissez des messages d'erreur utiles