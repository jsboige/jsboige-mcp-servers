#!/usr/bin/env pwsh
# Script de migration automatique des fichiers de tests Jest → Vitest
# Date: 2025-10-14
# Remplace les imports @jest/globals par vitest

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot/..

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  MIGRATION DES FICHIERS DE TESTS - Jest → Vitest            ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Trouver tous les fichiers de tests (excluant node_modules)
Write-Host "🔍 1. RECHERCHE DES FICHIERS DE TESTS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

$testFiles = @()
$testFiles += Get-ChildItem -Path "tests" -Include "*.test.ts","*.spec.ts" -Recurse -ErrorAction SilentlyContinue
$testFiles += Get-ChildItem -Path "src" -Include "*.test.ts","*.spec.ts" -Recurse -ErrorAction SilentlyContinue

Write-Host "  ✅ Trouvé $($testFiles.Count) fichier(s) de tests" -ForegroundColor Green
Write-Host ""

if ($testFiles.Count -eq 0) {
    Write-Host "  ⚠️  Aucun fichier de tests trouvé à migrer" -ForegroundColor Yellow
    exit 0
}

# Compteurs
$filesModified = 0
$filesSkipped = 0
$totalReplacements = 0

# Sauvegarde
Write-Host "📦 2. SAUVEGARDE DES TESTS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = "vitest-migration/backups/tests-$timestamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

foreach ($file in $testFiles) {
    $relativePath = $file.FullName.Replace((Get-Location).Path + "\", "")
    $backupPath = Join-Path $backupDir $relativePath
    $backupFolder = Split-Path $backupPath -Parent
    New-Item -ItemType Directory -Force -Path $backupFolder -ErrorAction SilentlyContinue | Out-Null
    Copy-Item $file.FullName $backupPath -Force
}

Write-Host "  ✅ Tests sauvegardés dans: $backupDir" -ForegroundColor Green
Write-Host ""

# Migration des fichiers
Write-Host "🔄 3. MIGRATION DES FICHIERS" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

foreach ($file in $testFiles) {
    $relativePath = $file.FullName.Replace((Get-Location).Path + "\", "")
    Write-Host "  📝 $relativePath" -ForegroundColor Cyan
    
    $content = Get-Content $file.FullName -Raw -Encoding UTF8
    $originalContent = $content
    $fileReplacements = 0
    
    # Pattern 1: Remplacement de l'import @jest/globals
    if ($content -match "from '@jest/globals'") {
        $content = $content -replace "from '@jest/globals'", "from 'vitest'"
        $fileReplacements++
        Write-Host "     ✓ Import @jest/globals → vitest" -ForegroundColor Gray
    }
    
    # Pattern 2: Remplacement de jest.fn(), jest.mock(), etc.
    if ($content -match '\bjest\.') {
        $jestCalls = [regex]::Matches($content, '\bjest\.(\w+)')
        foreach ($match in $jestCalls) {
            $method = $match.Groups[1].Value
            Write-Host "     ✓ jest.$method() → vi.$method()" -ForegroundColor Gray
        }
        $content = $content -replace '\bjest\.', 'vi.'
        $fileReplacements++
    }
    
    # Pattern 3: Ajout de l'import vi si nécessaire (et pas déjà présent)
    if ($content -match '\bvi\.' -and $content -notmatch "import.*vi.*from 'vitest'") {
        # Trouver la ligne d'import vitest existante
        if ($content -match "import \{([^\}]+)\} from 'vitest'") {
            $imports = $matches[1]
            if ($imports -notmatch '\bvi\b') {
                # Ajouter vi à l'import existant
                $newImports = $imports + ', vi'
                $content = $content -replace "import \{$imports\} from 'vitest'", "import { $newImports } from 'vitest'"
                Write-Host "     ✓ Ajout de 'vi' dans l'import vitest" -ForegroundColor Gray
                $fileReplacements++
            }
        }
    }
    
    # Si le fichier a été modifié
    if ($content -ne $originalContent) {
        Set-Content -Path $file.FullName -Value $content -Encoding UTF8 -NoNewline
        $filesModified++
        $totalReplacements += $fileReplacements
        Write-Host "     ✅ Migré ($fileReplacements remplacement(s))" -ForegroundColor Green
    } else {
        $filesSkipped++
        Write-Host "     ⏭  Aucune modification nécessaire" -ForegroundColor Gray
    }
    Write-Host ""
}

# Résumé
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  RÉSUMÉ DE LA MIGRATION                                      ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "Fichiers trouvés      : $($testFiles.Count)" -ForegroundColor Cyan
Write-Host "Fichiers modifiés     : $filesModified" -ForegroundColor Green
Write-Host "Fichiers inchangés    : $filesSkipped" -ForegroundColor Gray
Write-Host "Total remplacements   : $totalReplacements" -ForegroundColor Yellow
Write-Host ""

# Patterns migrés
Write-Host "📋 PATTERNS MIGRÉS:" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  ✓ from '@jest/globals' → from 'vitest'" -ForegroundColor Gray
Write-Host "  ✓ jest.fn()            → vi.fn()" -ForegroundColor Gray
Write-Host "  ✓ jest.mock()          → vi.mock()" -ForegroundColor Gray
Write-Host "  ✓ jest.spyOn()         → vi.spyOn()" -ForegroundColor Gray
Write-Host "  ✓ jest.*               → vi.*" -ForegroundColor Gray
Write-Host ""

# Sauvegarde du rapport
$outputFile = "vitest-migration/migration-tests-$timestamp.txt"
$output = @"
=== MIGRATION DES TESTS - Jest → Vitest ===
Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Sauvegarde: $backupDir

Statistiques:
  - Fichiers trouvés   : $($testFiles.Count)
  - Fichiers modifiés  : $filesModified
  - Fichiers inchangés : $filesSkipped
  - Total remplacements: $totalReplacements

Fichiers migrés:
$($testFiles | Where-Object { 
    $content = Get-Content $_.FullName -Raw
    $content -match "from 'vitest'" 
} | ForEach-Object { 
    "  - " + $_.FullName.Replace((Get-Location).Path + "\", "") 
} | Out-String)

Patterns migrés:
  - from '@jest/globals' → from 'vitest'
  - jest.* → vi.*
"@

Set-Content -Path $outputFile -Value $output -Encoding UTF8
Write-Host "📄 Rapport sauvegardé dans: $outputFile" -ForegroundColor Cyan
Write-Host ""

Write-Host "✅ Migration des tests terminée avec succès!" -ForegroundColor Green
Write-Host "📝 Prochaine étape: Valider la migration avec npm run test:run" -ForegroundColor Cyan
Write-Host ""