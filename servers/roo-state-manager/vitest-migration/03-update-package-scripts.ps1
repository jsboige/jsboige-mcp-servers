#!/usr/bin/env pwsh
# Script de mise à jour des scripts package.json pour Vitest
# Date: 2025-10-14
# Mise à jour des scripts de tests Jest → Vitest

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  MISE À JOUR DES SCRIPTS PACKAGE.JSON                        ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Sauvegarde
Write-Host "📦 1. SAUVEGARDE" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupFile = "vitest-migration/backups/package.json.$timestamp.scripts.bak"
New-Item -ItemType Directory -Force -Path (Split-Path $backupFile) | Out-Null
Copy-Item "package.json" $backupFile
Write-Host "  ✅ Sauvegardé: $backupFile" -ForegroundColor Green
Write-Host ""

# Charger package.json
Write-Host "📝 2. MISE À JOUR DES SCRIPTS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json

# Supprimer les anciens scripts Jest
$oldScripts = @(
    "test:setup",
    "pretest"
)

Write-Host "  🗑️  Suppression des scripts obsolètes:" -ForegroundColor Yellow
foreach ($script in $oldScripts) {
    if ($packageJson.scripts.$script) {
        $packageJson.scripts.PSObject.Properties.Remove($script)
        Write-Host "     - $script" -ForegroundColor Gray
    }
}
Write-Host ""

# Nouveaux scripts Vitest
Write-Host "  ✏️  Ajout/Modification des scripts Vitest:" -ForegroundColor Cyan
$newScripts = @{
    "test" = "vitest"
    "test:run" = "vitest run"
    "test:ui" = "vitest --ui"
    "test:coverage" = "vitest run --coverage"
    "test:watch" = "vitest watch"
    "test:unit" = "vitest run tests/unit"
    "test:integration" = "vitest run tests/integration"
    "test:e2e" = "vitest run tests/e2e"
    "test:hierarchy" = "vitest run tests/unit/services/hierarchy-reconstruction-engine.test.ts"
    "test:hierarchy:debug" = "cross-env ROO_DEBUG_INSTRUCTIONS=1 npm run test:hierarchy"
    "test:detector" = "node build/tests/manual/test-storage-detector.js"
    "test:all" = "npm run build && npm run build:tests && npm run test:run && npm run test:detector"
}

foreach ($script in $newScripts.GetEnumerator()) {
    $packageJson.scripts | Add-Member -NotePropertyName $script.Key -NotePropertyValue $script.Value -Force
    Write-Host "     - $($script.Key): $($script.Value)" -ForegroundColor Gray
}
Write-Host ""

# Sauvegarder le package.json modifié
Write-Host "💾 3. SAUVEGARDE DU PACKAGE.JSON MODIFIÉ" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$json = $packageJson | ConvertTo-Json -Depth 100
$json = $json -replace '\\u0027', "'"
Set-Content -Path "package.json" -Value $json -Encoding UTF8
Write-Host "  ✅ package.json mis à jour" -ForegroundColor Green
Write-Host ""

# Résumé
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  RÉSUMÉ DES MODIFICATIONS                                    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "Scripts supprimés : $($oldScripts.Count)" -ForegroundColor Yellow
Write-Host "Scripts ajoutés   : $($newScripts.Count)" -ForegroundColor Green
Write-Host ""

# Liste des nouveaux scripts disponibles
Write-Host "📋 SCRIPTS DISPONIBLES:" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  npm test                 - Mode watch (développement)" -ForegroundColor Gray
Write-Host "  npm run test:run         - Run once (CI/validation)" -ForegroundColor Gray
Write-Host "  npm run test:ui          - Interface web Vitest" -ForegroundColor Gray
Write-Host "  npm run test:coverage    - Tests avec couverture" -ForegroundColor Gray
Write-Host "  npm run test:unit        - Tests unitaires seulement" -ForegroundColor Gray
Write-Host "  npm run test:integration - Tests d'intégration" -ForegroundColor Gray
Write-Host "  npm run test:e2e         - Tests end-to-end" -ForegroundColor Gray
Write-Host ""

# Sauvegarde du résultat
$outputFile = "vitest-migration/update-scripts-$timestamp.txt"
$output = @"
=== MISE À JOUR DES SCRIPTS - package.json ===
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Sauvegarde: $backupFile

Scripts supprimés:
$($oldScripts | ForEach-Object { "  - $_" } | Out-String)

Scripts ajoutés/modifiés:
$($newScripts.GetEnumerator() | ForEach-Object { "  - $($_.Key): $($_.Value)" } | Out-String)

Utilisation:
  npm test                 - Mode watch
  npm run test:run         - Run once
  npm run test:ui          - Interface UI
  npm run test:coverage    - Avec couverture
"@

Set-Content -Path $outputFile -Value $output -Encoding UTF8
Write-Host "📄 Résultat sauvegardé dans: $outputFile" -ForegroundColor Cyan
Write-Host ""

Write-Host "✅ Scripts package.json mis à jour avec succès!" -ForegroundColor Green
Write-Host "📝 Prochaine étape: Migrer les tests existants" -ForegroundColor Cyan
Write-Host ""