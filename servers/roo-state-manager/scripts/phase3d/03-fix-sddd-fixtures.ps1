# Phase 3D - ÉTAPE 2 : Correction SDDD Fixture Loading
# Script SDDD pour créer des fixtures sans BOM UTF-8

param(
    [switch]$Verify = $false,
    [switch]$Clean = $false
)

Write-Host "🔧 Phase 3D - SDDD Fixture Loading" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan

# Configuration SDDD
$baseDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixturesBaseDir = "$baseDir/tests"
$testIds = @(
    '91e837de-a4b2-4c18-ab9b-6fcd36596e38',
    '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4',
    '03deadab-a06d-4b29-976d-3cc142add1d9',
    '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7',
    'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4',
    '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa',
    'd6a6a99a-b7fd-41fc-86ce-2f17c9520437'
)

function Test-BomPresence {
    param([string]$FilePath)
    
    if (-not (Test-Path $FilePath)) {
        return $false
    }
    
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    return $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
}

function Write-JsonWithoutBom {
    param(
        [string]$FilePath,
        [object]$Data
    )
    
    # Convertir en JSON
    $jsonContent = $Data | ConvertTo-Json -Depth 10 -Compress
    
    # Écriture SDDD sans BOM
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($FilePath, $jsonContent, $utf8NoBom)
    
    Write-Host "  ✅ Créé: $FilePath" -ForegroundColor Green
}

if ($Clean) {
    Write-Host "🧹 Nettoyage des fixtures existantes..." -ForegroundColor Yellow
    
    $pathsToClean = @(
        "$fixturesBaseDir/unit/utils/fixtures/controlled-hierarchy",
        "$fixturesBaseDir/integration/fixtures/controlled-hierarchy"
    )
    
    foreach ($path in $pathsToClean) {
        if (Test-Path $path) {
            Remove-Item -Recurse -Force $path
            Write-Host "  🗑️  Supprimé: $path" -ForegroundColor Red
        }
    }
}

if ($Verify) {
    Write-Host "🔍 Vérification SDDD des fixtures..." -ForegroundColor Yellow
    
    $fixturePaths = @(
        "$fixturesBaseDir/unit/utils/fixtures/controlled-hierarchy",
        "$fixturesBaseDir/integration/fixtures/controlled-hierarchy"
    )
    
    $totalFiles = 0
    $filesWithBom = 0
    $filesWithoutBom = 0
    
    foreach ($basePath in $fixturePaths) {
        if (Test-Path $basePath) {
            $jsonFiles = Get-ChildItem -Recurse -Include '*.json', '*.jsonl' -Path $basePath
            
            foreach ($file in $jsonFiles) {
                $totalFiles++
                $hasBom = Test-BomPresence -FilePath $file.FullName
                
                if ($hasBom) {
                    $filesWithBom++
                    Write-Host "  ❌ BOM: $($file.Name)" -ForegroundColor Red
                } else {
                    $filesWithoutBom++
                    Write-Host "  ✅ OK: $($file.Name)" -ForegroundColor Green
                }
            }
        }
    }
    
    Write-Host ""
    Write-Host "📊 Résultats SDDD:" -ForegroundColor Cyan
    Write-Host "  Total fichiers: $totalFiles"
    Write-Host "  Sans BOM: $filesWithoutBom" -ForegroundColor Green
    Write-Host "  Avec BOM: $filesWithBom" -ForegroundColor Red
    
    if ($filesWithBom -eq 0 -and $totalFiles -gt 0) {
        Write-Host "✅ SDDD: Toutes les fixtures sont sans BOM!" -ForegroundColor Green
    } else {
        Write-Host "❌ SDDD: Des fixtures avec BOM détectées!" -ForegroundColor Red
    }
    
    exit
}

# Création SDDD des fixtures
Write-Host "📁 Création SDDD des fixtures contrôlées..." -ForegroundColor Yellow

# Création des répertoires de base
$unitBaseDir = "$fixturesBaseDir/unit/utils/fixtures/controlled-hierarchy"
$integrationBaseDir = "$fixturesBaseDir/integration/fixtures/controlled-hierarchy"

New-Item -ItemType Directory -Force -Path $unitBaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $integrationBaseDir | Out-Null

Write-Host "  📂 Répertoires créés"

# Création des fixtures pour chaque ID de test
foreach ($testId in $testIds) {
    Write-Host ""
    Write-Host "  🔧 Traitement fixture: $testId" -ForegroundColor Cyan
    
    # Création des sous-répertoires
    $unitDir = "$unitBaseDir/$testId"
    $integrationDir = "$integrationBaseDir/$testId"
    
    New-Item -ItemType Directory -Force -Path $unitDir | Out-Null
    New-Item -ItemType Directory -Force -Path $integrationDir | Out-Null
    
    # task_metadata.json
    $metadata = @{
        workspace = 'test-workspace'
        createdAt = '2025-10-17T21:56:00.000Z'
        parentTaskId = ''
        messageCount = 5
        truncatedInstruction = 'Phase 3D Hierarchy Reconstruction Execution SDDD.'
        taskId = $testId
        lastActivity = '2025-10-17T21:56:00.000Z'
        actionCount = 3
        totalSize = 1024
        title = "Tache Racine - $testId"
        depth = 0
        lastMessageAt = '2025-10-17T21:56:00.000Z'
    }
    
    Write-JsonWithoutBom -FilePath "$unitDir/task_metadata.json" -Data $metadata
    Write-JsonWithoutBom -FilePath "$integrationDir/task_metadata.json" -Data $metadata
    
    # ui_messages.json
    $uiMessages = @{
        messages = @(
            @{
                id = 'msg-1'
                type = 'user'
                content = 'Initial user message'
                timestamp = '2025-10-17T21:56:00.000Z'
            },
            @{
                id = 'msg-2'
                type = 'assistant'
                content = 'Assistant response'
                timestamp = '2025-10-17T21:56:01.000Z'
            }
        )
    }
    
    Write-JsonWithoutBom -FilePath "$unitDir/ui_messages.json" -Data $uiMessages
    Write-JsonWithoutBom -FilePath "$integrationDir/ui_messages.json" -Data $uiMessages
    
    # api_history.jsonl
    $apiHistory = @(
        @{
            role = 'user'
            content = 'API history content'
            timestamp = '2025-10-17T21:56:00.000Z'
        }
    )
    
    Write-JsonWithoutBom -FilePath "$unitDir/api_history.jsonl" -Data $apiHistory
    Write-JsonWithoutBom -FilePath "$integrationDir/api_history.jsonl" -Data $apiHistory
}

Write-Host ""
Write-Host "✅ SDDD: Fixtures créées avec succès!" -ForegroundColor Green

# Vérification automatique
Write-Host ""
Write-Host "🔍 Vérification automatique SDDD..." -ForegroundColor Yellow
$scriptPath = Join-Path $PSScriptRoot "03-fix-sddd-fixtures.ps1"
& $scriptPath -Verify