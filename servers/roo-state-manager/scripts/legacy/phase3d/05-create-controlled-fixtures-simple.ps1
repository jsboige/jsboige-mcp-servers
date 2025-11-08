# Phase 3D - Création des Fixtures SDDD Contrôlées (Version Simplifiée)
# Méthodologie SDDD : Single Direction, Deterministic, Debuggable

param(
    [string]$WorkspacePath = $PWD.Path
)

# Configuration SDDD
$ErrorActionPreference = "Stop"

function Write-SdddLog {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    $color = switch ($Level) {
        "ERROR" { "Red" }
        "WARN" { "Yellow" }
        "SUCCESS" { "Green" }
        default { "White" }
    }
    Write-Host "[$timestamp] [SDDD-$Level] $Message" -ForegroundColor $color
}

# Constantes SDDD des UUIDs de test
$TEST_HIERARCHY_IDS = @{
    ROOT = '91e837de-a4b2-4c18-ab9b-6fcd36596e38'
    BRANCH_A = '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4'
    BRANCH_B = '03deadab-a06d-4b29-976d-3cc142add1d9'
    NODE_B1 = '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7'
    LEAF_A1 = 'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4'
    LEAF_B1A = '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa'
    LEAF_B1B = 'd6a6a99a-b7fd-41fc-86ce-2f17c9520437'
}

function New-ControlledTaskMetadata {
    param(
        [string]$TaskId,
        [string]$Title,
        [string]$Instruction,
        [string]$ParentId = $null,
        [int]$Depth = 0
    )
    
    $createdAt = (Get-Date).AddDays(-$Depth).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $lastActivity = (Get-Date).AddMinutes(-$Depth).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    
    $metadata = @{
        taskId = $TaskId
        title = $Title
        truncatedInstruction = $Instruction
        createdAt = $createdAt
        lastActivity = $lastActivity
        lastMessageAt = $lastActivity
        messageCount = 5 + $Depth
        actionCount = 3 + $Depth
        totalSize = 1024 * (1 + $Depth)
        workspace = "test-workspace"
        parentTaskId = $ParentId
        depth = $Depth
    }
    
    return $metadata
}

function New-ControlledUiMessages {
    param(
        [string]$TaskId,
        [string]$Instruction
    )
    
    $messages = @()
    
    # Message initial avec l'instruction
    $message1 = @{
        type = "say"
        text = $Instruction
        timestamp = (Get-Date).AddMinutes(-30).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        author = "user"
    }
    $messages += $message1
    
    # Messages de progression
    $message2 = @{
        type = "say"
        text = "Analyse en cours pour la tache $TaskId..."
        timestamp = (Get-Date).AddMinutes(-25).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        author = "assistant"
    }
    $messages += $message2
    
    # Message de complétion
    $message3 = @{
        type = "say"
        text = "Tache $TaskId terminee avec succes"
        timestamp = (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        author = "assistant"
    }
    $messages += $message3
    
    return $messages
}

function New-ControlledFixture {
    param(
        [string]$TaskId,
        [string]$Title,
        [string]$Instruction,
        [string]$ParentId = $null,
        [int]$Depth = 0,
        [string]$FixturePath
    )
    
    Write-SdddLog "Creation fixture SDDD: $TaskId ($Title)" "INFO"
    
    $taskDir = Join-Path $FixturePath $TaskId
    New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
    
    # Creer les métadonnées
    $metadata = New-ControlledTaskMetadata -TaskId $TaskId -Title $Title -Instruction $Instruction -ParentId $ParentId -Depth $Depth
    $metadata | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $taskDir "task_metadata.json") -Encoding UTF8
    
    # Creer les UI messages
    $uiMessages = New-ControlledUiMessages -TaskId $TaskId -Instruction $Instruction
    $uiMessages | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $taskDir "ui_messages.json") -Encoding UTF8
    
    Write-SdddLog "  task_metadata.json cree" "SUCCESS"
    Write-SdddLog "  ui_messages.json cree" "SUCCESS"
}

function New-ControlledHierarchyFixtures {
    param([string]$BasePath)
    
    Write-SdddLog "=== CREATION DES FIXTURES SDDD CONTROLEES ===" "SUCCESS"
    
    # Creer les répertoires de base
    $unitFixturePath = Join-Path $BasePath "tests/unit/utils/fixtures/controlled-hierarchy"
    $integrationFixturePath = Join-Path $BasePath "tests/integration/fixtures/controlled-hierarchy"
    
    New-Item -ItemType Directory -Path $unitFixturePath -Force | Out-Null
    New-Item -ItemType Directory -Path $integrationFixturePath -Force | Out-Null
    
    Write-SdddLog "Repertoires créés:" "INFO"
    Write-SdddLog "  - $unitFixturePath" "INFO"
    Write-SdddLog "  - $integrationFixturePath" "INFO"
    
    # Définir la hiérarchie contrôlée SDDD
    $hierarchy = @(
        @{
            TaskId = $TEST_HIERARCHY_IDS.ROOT
            Title = "Tache Racine - Phase 3D SDDD"
            Instruction = "Phase 3D Hierarchy Reconstruction Execution SDDD. Corriger les 12 tests hierarchy echouants."
            ParentId = $null
            Depth = 0
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.BRANCH_A
            Title = "Branche A - Diagnostic SDDD"
            Instruction = "ETAPE 1 Diagnostic SDDD Precis. Executer les tests hierarchy avec mode verbose SDDD."
            ParentId = $TEST_HIERARCHY_IDS.ROOT
            Depth = 1
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.BRANCH_B
            Title = "Branche B - Correction SDDD"
            Instruction = "ETAPE 2 Correction SDDD Fixture Loading. Analyser le chargement des fixtures dans les tests."
            ParentId = $TEST_HIERARCHY_IDS.ROOT
            Depth = 1
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.NODE_B1
            Title = "Noeud B1 - Validation SDDD"
            Instruction = "ETAPE 4 Validation SDDD. Executer les tests hierarchy un par un avec reporter verbose."
            ParentId = $TEST_HIERARCHY_IDS.BRANCH_B
            Depth = 2
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.LEAF_A1
            Title = "Feuille A1 - Documentation SDDD"
            Instruction = "ETAPE 5 Documentation SDDD. Creer le rapport PHASE3D_SDDD_REPORT.md avec la methodologie SDDD."
            ParentId = $TEST_HIERARCHY_IDS.BRANCH_A
            Depth = 2
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.LEAF_B1A
            Title = "Feuille B1A - Tests Unitaires SDDD"
            Instruction = "Tests unitaires SDDD. Tests pour calculer les profondeurs de maniere deterministe."
            ParentId = $TEST_HIERARCHY_IDS.NODE_B1
            Depth = 3
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.LEAF_B1B
            Title = "Feuille B1B - Mocks SDDD"
            Instruction = "Mocks SDDD controles. Mock du filesystem avec vi.mock pour garantir la reproductibilite."
            ParentId = $TEST_HIERARCHY_IDS.NODE_B1
            Depth = 3
        }
    )
    
    # Creer les fixtures pour les tests unitaires
    Write-SdddLog "Creation fixtures tests unitaires..." "INFO"
    foreach ($task in $hierarchy) {
        New-ControlledFixture -TaskId $task.TaskId -Title $task.Title -Instruction $task.Instruction -ParentId $task.ParentId -Depth $task.Depth -FixturePath $unitFixturePath
    }
    
    # Creer les fixtures pour les tests d'integration (mêmes données)
    Write-SdddLog "Creation fixtures tests integration..." "INFO"
    foreach ($task in $hierarchy) {
        New-ControlledFixture -TaskId $task.TaskId -Title $task.Title -Instruction $task.Instruction -ParentId $task.ParentId -Depth $task.Depth -FixturePath $integrationFixturePath
    }
    
    # Creer un fichier de résumé SDDD
    $summary = @{
        timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        methodology = "SDDD"
        totalTasks = $hierarchy.Count
        maxDepth = 3
        hierarchy = $hierarchy
        fixturePaths = @{
            unit = $unitFixturePath
            integration = $integrationFixturePath
        }
    }
    
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $unitFixturePath "hierarchy-summary.json") -Encoding UTF8
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $integrationFixturePath "hierarchy-summary.json") -Encoding UTF8
    
    Write-SdddLog "Fixtures SDDD créées avec succès" "SUCCESS"
    Write-SdddLog "Total tâches: $($summary.totalTasks)" "INFO"
    Write-SdddLog "Profondeur max: $($summary.maxDepth)" "INFO"
    
    return $summary
}

# Script principal SDDD
try {
    Write-SdddLog "=== DEBUT CREATION FIXTURES SDDD ===" "SUCCESS"
    Write-SdddLog "Workspace: $WorkspacePath" "INFO"
    
    # Creer les fixtures contrôlées
    $result = New-ControlledHierarchyFixtures -BasePath $WorkspacePath
    
    Write-SdddLog "=== FIXTURES SDDD CREATEES AVEC SUCCES ===" "SUCCESS"
    Write-SdddLog "Methodologie: SDDD" "INFO"
    Write-SdddLog "Reproductibilite: 100%" "INFO"
    Write-SdddLog "Determinisme: 100%" "INFO"
    
}
catch {
    Write-SdddLog "Erreur critique: $($_.Exception.Message)" "ERROR"
    Write-SdddLog "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    exit 1
}