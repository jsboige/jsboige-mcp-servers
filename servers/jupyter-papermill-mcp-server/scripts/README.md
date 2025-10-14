# Scripts de Migration MCP Jupyter

Ce répertoire contient les scripts PowerShell utilisés pour la migration du MCP Jupyter de Node.js vers Python/Papermill.

## 📋 Scripts Disponibles

### Script 03 - Validation de l'environnement Python
**Fichier**: `03-validate-python-env.ps1`

Valide que l'environnement Python est correctement configuré avant la migration.

**Utilisation**:
```powershell
pwsh -ExecutionPolicy Bypass -File "03-validate-python-env.ps1"
```

**Vérifie**:
- Python 3.13 disponible
- Module papermill_mcp accessible
- Dépendances installées (mcp, papermill, jupyter_client, nbformat)

---

### Script 04 - Backup de la configuration
**Fichier**: `04-backup-mcp-settings.ps1`

Crée un backup horodaté de mcp_settings.json avant toute modification.

**Utilisation**:
```powershell
pwsh -ExecutionPolicy Bypass -File "04-backup-mcp-settings.ps1"
```

**Résultat**:
- Backup dans: `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\backups\`
- Format: `mcp_settings-backup-YYYYMMDD-HHMMSS.json`
- Validation JSON intégrée

---

### Script 05 - Migration de la configuration
**Fichier**: `05-update-mcp-config.ps1`

Applique la migration en remplaçant la configuration Node.js par Python/Papermill.

**Utilisation**:
```powershell
pwsh -ExecutionPolicy Bypass -File "05-update-mcp-config.ps1"
```

**Actions**:
1. Sauvegarde l'ancienne config en `jupyter-old` (disabled)
2. Crée la nouvelle config Python/Papermill en `jupyter` (active)
3. Valide le JSON avant écriture
4. Vérifie post-écriture

**⚠️ Important**: Exécutez d'abord le script 04 pour créer un backup !

---

### Script 06 - Validation de la migration
**Fichier**: `06-validate-migration.ps1`

Valide que la migration s'est déroulée correctement.

**Utilisation**:
```powershell
pwsh -ExecutionPolicy Bypass -File "06-validate-migration.ps1"
```

**Vérifie**:
- Configuration `jupyter` correctement configurée
- Configuration `jupyter-old` sauvegardée
- Tous les chemins valides
- Outils autorisés configurés
- Backup disponible

**Code de sortie**: 0 si succès, 1 si échec

---

### Script 00 - Orchestration Complète
**Fichier**: `00-run-all-migration.ps1`

Script maître qui exécute tous les scripts dans l'ordre correct.

**Utilisation**:
```powershell
pwsh -ExecutionPolicy Bypass -File "00-run-all-migration.ps1"
```

**Séquence**:
1. Validation environnement (03)
2. Backup configuration (04)
3. Migration (05)
4. Validation finale (06)

**⚠️ Recommandé**: Utilisez ce script pour une migration complète et sécurisée.

---

## 🚀 Utilisation Rapide

### Migration Complète (Recommandé)
```powershell
cd mcps/internal/servers/jupyter-papermill-mcp-server/scripts
pwsh -ExecutionPolicy Bypass -File "00-run-all-migration.ps1"
```

### Migration Manuelle (Pas à Pas)
```powershell
cd mcps/internal/servers/jupyter-papermill-mcp-server/scripts

# 1. Valider l'environnement
pwsh -ExecutionPolicy Bypass -File "03-validate-python-env.ps1"

# 2. Créer un backup
pwsh -ExecutionPolicy Bypass -File "04-backup-mcp-settings.ps1"

# 3. Effectuer la migration
pwsh -ExecutionPolicy Bypass -File "05-update-mcp-config.ps1"

# 4. Valider la migration
pwsh -ExecutionPolicy Bypass -File "06-validate-migration.ps1"
```

---

## 🔄 Rollback

En cas de problème, restaurer le backup :

```powershell
# Trouver le dernier backup
$backupDir = "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\backups"
$latestBackup = Get-ChildItem -Path $backupDir -Filter "mcp_settings-backup-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Restaurer
Copy-Item $latestBackup.FullName "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json" -Force

# Redémarrer VS Code
```

---

## 📚 Documentation

Voir le rapport complet de migration : `../RAPPORT-MIGRATION-MCP-JUPYTER.md`

---

## ⚠️ Prérequis

- PowerShell 7+ installé
- Python 3.13 installé à `C:\Python313\python.exe`
- Module `papermill_mcp` installé
- VS Code avec l'extension Roo

---

## 🆘 Support

En cas de problème :
1. Consulter le rapport de migration
2. Vérifier les logs de chaque script
3. Utiliser la procédure de rollback si nécessaire
4. Consulter les logs MCP dans VS Code (Output → Model Context Protocol)

---

*Scripts créés le 9 octobre 2025 - Migration MCP Jupyter*