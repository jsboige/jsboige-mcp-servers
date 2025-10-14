# Script 00 - Orchestration Complète de la Migration MCP Jupyter
# Date: 2025-10-09
# Objectif: Exécuter tous les scripts de migration dans le bon ordre

Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MIGRATION MCP JUPYTER - Node.js → Python/Papermill" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$scriptDir = $PSScriptRoot
$allSuccess = $true

# Fonction pour exécuter un script et vérifier le résultat
function Run-Script {
    param(
        [string]$ScriptName,
        [string]$Description
    )
    
    Write-Host "───────────────────────────────────────────────────────────────" -ForegroundColor Gray
    Write-Host "▶ $Description" -ForegroundColor Yellow
    Write-Host "───────────────────────────────────────────────────────────────" -ForegroundColor Gray
    Write-Host ""
    
    $scriptPath = Join-Path $scriptDir $ScriptName
    
    if (-not (Test-Path $scriptPath)) {
        Write-Host "✗ Script introuvable: $ScriptName" -ForegroundColor Red
        return $false
    }
    
    try {
        & $scriptPath
        $exitCode = $LASTEXITCODE
        
        if ($exitCode -eq 0 -or $null -eq $exitCode) {
            Write-Host ""
            Write-Host "✓ $Description - SUCCÈS" -ForegroundColor Green
            Write-Host ""
            return $true
        } else {
            Write-Host ""
            Write-Host "✗ $Description - ÉCHEC (code: $exitCode)" -ForegroundColor Red
            Write-Host ""
            return $false
        }
    } catch {
        Write-Host ""
        Write-Host "✗ $Description - ERREUR: $_" -ForegroundColor Red
        Write-Host ""
        return $false
    }
}

# Demander confirmation avant de commencer
Write-Host "Cette migration va:" -ForegroundColor Yellow
Write-Host "  1. Valider l'environnement Python" -ForegroundColor White
Write-Host "  2. Créer un backup de mcp_settings.json" -ForegroundColor White
Write-Host "  3. Migrer la configuration vers Python/Papermill" -ForegroundColor White
Write-Host "  4. Valider la migration" -ForegroundColor White
Write-Host ""
Write-Host "⚠️  La configuration sera modifiée !" -ForegroundColor Yellow
Write-Host ""
$confirmation = Read-Host "Voulez-vous continuer? (O/N)"

if ($confirmation -ne "O" -and $confirmation -ne "o") {
    Write-Host ""
    Write-Host "Migration annulée par l'utilisateur." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "Démarrage de la migration..." -ForegroundColor Cyan
Write-Host ""
Start-Sleep -Seconds 1

# ÉTAPE 1: Validation de l'environnement Python
$step1 = Run-Script "03-validate-python-env.ps1" "ÉTAPE 1/4: Validation de l'environnement Python"
if (-not $step1) {
    $allSuccess = $false
    Write-Host "✗ La validation de l'environnement a échoué." -ForegroundColor Red
    Write-Host "✗ Migration interrompue." -ForegroundColor Red
    exit 1
}

# ÉTAPE 2: Backup de la configuration
$step2 = Run-Script "04-backup-mcp-settings.ps1" "ÉTAPE 2/4: Backup de la configuration"
if (-not $step2) {
    $allSuccess = $false
    Write-Host "✗ La création du backup a échoué." -ForegroundColor Red
    Write-Host "✗ Migration interrompue par sécurité." -ForegroundColor Red
    exit 1
}

# ÉTAPE 3: Migration de la configuration
$step3 = Run-Script "05-update-mcp-config.ps1" "ÉTAPE 3/4: Migration de la configuration"
if (-not $step3) {
    $allSuccess = $false
    Write-Host "✗ La migration a échoué." -ForegroundColor Red
    Write-Host ""
    Write-Host "ℹ️  Un backup a été créé à l'étape 2." -ForegroundColor Yellow
    Write-Host "ℹ️  Vous pouvez restaurer la configuration avec le script 04." -ForegroundColor Yellow
    exit 1
}

# ÉTAPE 4: Validation de la migration
$step4 = Run-Script "06-validate-migration.ps1" "ÉTAPE 4/4: Validation de la migration"
if (-not $step4) {
    $allSuccess = $false
    Write-Host "✗ La validation a échoué." -ForegroundColor Red
    Write-Host ""
    Write-Host "⚠️  La configuration a été modifiée mais la validation a échoué." -ForegroundColor Yellow
    Write-Host "ℹ️  Vérifiez les erreurs ci-dessus." -ForegroundColor Yellow
    Write-Host "ℹ️  Un backup est disponible pour rollback si nécessaire." -ForegroundColor Yellow
    exit 1
}

# Résumé final
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  RÉSUMÉ DE LA MIGRATION" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

if ($allSuccess) {
    Write-Host "✓ MIGRATION RÉUSSIE !" -ForegroundColor Green
    Write-Host ""
    Write-Host "Toutes les étapes ont été complétées avec succès:" -ForegroundColor White
    Write-Host "  ✓ Environnement Python validé" -ForegroundColor Green
    Write-Host "  ✓ Backup créé" -ForegroundColor Green
    Write-Host "  ✓ Configuration migrée" -ForegroundColor Green
    Write-Host "  ✓ Migration validée" -ForegroundColor Green
    Write-Host ""
    Write-Host "┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
    Write-Host "│  PROCHAINES ÉTAPES REQUISES                                 │" -ForegroundColor Yellow
    Write-Host "└─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "1. Redémarrer VS Code ou recharger la fenêtre:" -ForegroundColor White
    Write-Host "   → Ctrl+Shift+P → 'Developer: Reload Window'" -ForegroundColor Gray
    Write-Host ""
    Write-Host "2. Vérifier les logs MCP:" -ForegroundColor White
    Write-Host "   → Output → Model Context Protocol" -ForegroundColor Gray
    Write-Host ""
    Write-Host "3. Tester les outils Jupyter depuis Roo" -ForegroundColor White
    Write-Host ""
    Write-Host "📄 Rapport complet: ../RAPPORT-MIGRATION-MCP-JUPYTER.md" -ForegroundColor Cyan
    Write-Host ""
} else {
    Write-Host "✗ MIGRATION ÉCHOUÉE" -ForegroundColor Red
    Write-Host ""
    Write-Host "Certaines étapes ont échoué. Consultez les erreurs ci-dessus." -ForegroundColor White
    Write-Host ""
    Write-Host "Pour restaurer la configuration:" -ForegroundColor Yellow
    Write-Host "  1. Localiser le backup dans:" -ForegroundColor White
    Write-Host "     C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\" -ForegroundColor Gray
    Write-Host "     rooveterinaryinc.roo-cline\settings\backups\" -ForegroundColor Gray
    Write-Host "  2. Copier le dernier backup vers mcp_settings.json" -ForegroundColor White
    Write-Host ""
}

Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Cyan

if ($allSuccess) {
    exit 0
} else {
    exit 1
}