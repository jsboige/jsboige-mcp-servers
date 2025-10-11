# Script 04 - Backup de mcp_settings.json avant migration
# Date: 2025-10-09
# Objectif: Créer un backup sécurisé avant de modifier la configuration MCP

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
Write-Host "[BACKUP] Création du backup de mcp_settings.json..." -ForegroundColor Cyan

# Chemins
$sourceFile = "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json"
$backupDir = "C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\backups"
$backupFile = Join-Path $backupDir "mcp_settings-backup-$timestamp.json"

# 1. Vérifier que le fichier source existe
Write-Host "`n[1] Vérification du fichier source..." -ForegroundColor Yellow
if (Test-Path $sourceFile) {
    Write-Host "   ✓ Fichier trouvé: $sourceFile" -ForegroundColor Green
    $sourceSize = (Get-Item $sourceFile).Length
    Write-Host "   ✓ Taille: $sourceSize octets" -ForegroundColor Green
} else {
    Write-Host "   ✗ Fichier source introuvable!" -ForegroundColor Red
    exit 1
}

# 2. Créer le répertoire de backup s'il n'existe pas
Write-Host "`n[2] Préparation du répertoire de backup..." -ForegroundColor Yellow
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Write-Host "   ✓ Répertoire créé: $backupDir" -ForegroundColor Green
} else {
    Write-Host "   ✓ Répertoire existant: $backupDir" -ForegroundColor Green
}

# 3. Créer le backup
Write-Host "`n[3] Copie du fichier..." -ForegroundColor Yellow
try {
    Copy-Item -Path $sourceFile -Destination $backupFile -Force
    Write-Host "   ✓ Backup créé: $backupFile" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Erreur lors de la copie: $_" -ForegroundColor Red
    exit 1
}

# 4. Vérifier l'intégrité du backup
Write-Host "`n[4] Vérification de l'intégrité..." -ForegroundColor Yellow
if (Test-Path $backupFile) {
    $backupSize = (Get-Item $backupFile).Length
    if ($backupSize -eq $sourceSize) {
        Write-Host "   ✓ Taille identique: $backupSize octets" -ForegroundColor Green
        
        # Vérifier que c'est un JSON valide
        try {
            $json = Get-Content $backupFile -Raw | ConvertFrom-Json
            Write-Host "   ✓ JSON valide" -ForegroundColor Green
        } catch {
            Write-Host "   ✗ JSON invalide dans le backup!" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "   ✗ Tailles différentes! Source: $sourceSize, Backup: $backupSize" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "   ✗ Backup introuvable!" -ForegroundColor Red
    exit 1
}

# 5. Résumé
Write-Host "`n[RÉSUMÉ] Backup créé avec succès:" -ForegroundColor Cyan
Write-Host "   Fichier source: $sourceFile" -ForegroundColor White
Write-Host "   Fichier backup: $backupFile" -ForegroundColor White
Write-Host "   Taille: $backupSize octets" -ForegroundColor White
Write-Host "   Timestamp: $timestamp" -ForegroundColor White

Write-Host "`n[INFO] Pour restaurer en cas de problème:" -ForegroundColor Yellow
Write-Host "   Copy-Item '$backupFile' '$sourceFile' -Force" -ForegroundColor Gray

Write-Host "`n[BACKUP] Terminé." -ForegroundColor Cyan

# Retourner le chemin du backup pour utilisation ultérieure
return $backupFile