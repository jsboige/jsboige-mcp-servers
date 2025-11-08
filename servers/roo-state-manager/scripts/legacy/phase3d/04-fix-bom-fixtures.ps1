# SDDD Phase 3D - Fix BOM Fixtures Script
# Single Direction, Deterministic, Debuggable

Write-Host "=== SDDD PHASE 3D: FIX BOM FIXTURES ===" -ForegroundColor Cyan
Write-Host "Approche: Single Direction, Deterministic, Debuggable" -ForegroundColor Yellow

# Nettoyer et recréer les fixtures avec encodage correct
$baseDir = "tests/unit/utils/fixtures/controlled-hierarchy"
$integrationBaseDir = "tests/integration/fixtures/controlled-hierarchy"

# IDs de test à créer
$testIds = @(
    "91e837de-a4b2-4c18-ab9b-6fcd36596e38",
    "305b3f90-e0e1-4870-8cf4-4fd33a08cfa4", 
    "03deadab-a06d-4b29-976d-3cc142add1d9",
    "38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7",
    "b423bff7-6fec-40fe-a00e-bb2a0ebb52f4",
    "8c06d62c-1ee2-4c3a-991e-c9483e90c8aa",
    "d6a6a99a-b7fd-41fc-86ce-2f17c9520437"
)

Write-Host "SDDD: Nettoyage des fixtures existantes..." -ForegroundColor Green

# Supprimer les fixtures existantes
foreach ($testId in $testIds) {
    $unitPath = "$baseDir/$testId"
    $integrationPath = "$integrationBaseDir/$testId"
    
    if (Test-Path $unitPath) {
        Remove-Item -Recurse -Force $unitPath
        Write-Host "SDDD: Supprimé $unitPath" -ForegroundColor Gray
    }
    
    if (Test-Path $integrationPath) {
        Remove-Item -Recurse -Force $integrationPath
        Write-Host "SDDD: Supprimé $integrationPath" -ForegroundColor Gray
    }
}

Write-Host "SDDD: Création des fixtures avec encodage UTF-8 sans BOM..." -ForegroundColor Green

# Fonction pour créer un fichier JSON sans BOM
function Create-JsonFileWithoutBOM {
    param(
        [string]$Path,
        [string]$Content
    )
    
    # Créer le répertoire si nécessaire
    $dir = Split-Path $Path -Parent
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    
    # Écrire le contenu avec encodage UTF-8 sans BOM
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
    
    Write-Host "SDDD: Créé $Path ($( $Content.Length ) caractères)" -ForegroundColor Gray
}

# Créer les fixtures pour chaque test ID
foreach ($testId in $testIds) {
    Write-Host "SDDD: Traitement de $testId..." -ForegroundColor Yellow
    
    # Générer des données déterministes basées sur l'ID
    $hash = [System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($testId))
    $seed = [BitConverter]::ToInt32($hash, 0)
    $random = New-Object System.Random($seed)
    
    # task_metadata.json
    $taskMetadata = @{
        workspace = "test-workspace"
        createdAt = "2025-10-17T21:56:00.000Z"
        parentTaskId = ""
        messageCount = 5 + $random.Next(1, 5)
        truncatedInstruction = "Phase 3D Hierarchy Reconstruction Execution SDDD - $testId"
        taskId = $testId
        lastActivity = "2025-10-17T21:56:00.000Z"
        actionCount = 3 + $random.Next(1, 3)
        totalSize = 1024 + $random.Next(512, 2048)
        title = "Tache Racine - $testId"
        depth = 0
        lastMessageAt = "2025-10-17T21:56:00.000Z"
    }
    
    # ui_messages.json
    $uiMessages = @(
        @{
            id = "msg-1"
            type = "user"
            content = "Message utilisateur 1 pour $testId"
            timestamp = "2025-10-17T21:55:00.000Z"
        },
        @{
            id = "msg-2"
            type = "assistant"
            content = "Message assistant 1 pour $testId"
            timestamp = "2025-10-17T21:55:30.000Z"
        },
        @{
            id = "msg-3"
            type = "user"
            content = "Message utilisateur 2 pour $testId"
            timestamp = "2025-10-17T21:56:00.000Z"
        }
    )
    
    # api_history.jsonl
    $apiHistory = @(
        @{
            role = "user"
            content = "Début de la tâche $testId"
            timestamp = "2025-10-17T21:55:00.000Z"
        },
        @{
            role = "assistant"
            content = "Traitement en cours pour $testId"
            timestamp = "2025-10-17T21:55:30.000Z"
        },
        @{
            role = "user"
            content = "Fin de la tâche $testId"
            timestamp = "2025-10-17T21:56:00.000Z"
        }
    )
    
    # Créer les fixtures pour les tests unitaires
    Create-JsonFileWithoutBOM -Path "$baseDir/$testId/task_metadata.json" -Content ($taskMetadata | ConvertTo-Json -Compress)
    Create-JsonFileWithoutBOM -Path "$baseDir/$testId/ui_messages.json" -Content ($uiMessages | ConvertTo-Json -Compress)
    
    # Créer le fichier JSONL pour les tests unitaires
    $apiHistoryJsonl = $apiHistory | ForEach-Object { $_ | ConvertTo-Json -Compress }
    Create-JsonFileWithoutBOM -Path "$baseDir/$testId/api_history.jsonl" -Content ($apiHistoryJsonl -join "`n")
    
    # Créer les mêmes fixtures pour les tests d'intégration
    Create-JsonFileWithoutBOM -Path "$integrationBaseDir/$testId/task_metadata.json" -Content ($taskMetadata | ConvertTo-Json -Compress)
    Create-JsonFileWithoutBOM -Path "$integrationBaseDir/$testId/ui_messages.json" -Content ($uiMessages | ConvertTo-Json -Compress)
    Create-JsonFileWithoutBOM -Path "$integrationBaseDir/$testId/api_history.jsonl" -Content ($apiHistoryJsonl -join "`n")
}

Write-Host "SDDD: Vérification des fichiers créés..." -ForegroundColor Green

# Vérifier que tous les fichiers ont été créés correctement
$filesCreated = 0
$filesExpected = $testIds.Count * 6 # 3 fichiers par test ID * 2 répertoires

foreach ($testId in $testIds) {
    $files = @(
        "$baseDir/$testId/task_metadata.json",
        "$baseDir/$testId/ui_messages.json", 
        "$baseDir/$testId/api_history.jsonl",
        "$integrationBaseDir/$testId/task_metadata.json",
        "$integrationBaseDir/$testId/ui_messages.json",
        "$integrationBaseDir/$testId/api_history.jsonl"
    )
    
    foreach ($file in $files) {
        if (Test-Path $file) {
            $content = Get-Content $file -Raw -Encoding UTF8
            if ($content.StartsWith("﻿")) {
                Write-Host "ERREUR: BOM détecté dans $file" -ForegroundColor Red
            } else {
                $filesCreated++
                Write-Host "SDDD: $file ✓" -ForegroundColor Green
            }
        } else {
            Write-Host "ERREUR: Fichier manquant $file" -ForegroundColor Red
        }
    }
}

Write-Host "=== RAPPORT SDDD ===" -ForegroundColor Cyan
Write-Host "Fichiers créés: $filesCreated/$filesExpected" -ForegroundColor Yellow
Write-Host "Tests IDs traités: $($testIds.Count)" -ForegroundColor Yellow

if ($filesCreated -eq $filesExpected) {
    Write-Host "✅ SDDD: Toutes les fixtures créées avec succès (sans BOM)" -ForegroundColor Green
    exit 0
} else {
    Write-Host "❌ SDDD: Erreur lors de la création des fixtures" -ForegroundColor Red
    exit 1
}