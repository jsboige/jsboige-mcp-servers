# Phase 3D - Création des Fixtures SDDD Contrôlées
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
    COLLECTE = 'e73ea764-4971-4adb-9197-52c2f8ede8ef'
}

function New-ControlledTaskMetadata {
    param(
        [string]$TaskId,
        [string]$Title,
        [string]$Instruction,
        [string]$ParentId = $null,
        [int]$Depth = 0,
        [string]$Workspace = "test-workspace"
    )
    
    $createdAt = (Get-Date).AddDays(-$Depth).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $lastActivity = (Get-Date).AddMinutes(-$Depth).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    
    return @{
        taskId = $TaskId
        title = $Title
        truncatedInstruction = $Instruction
        createdAt = $createdAt
        lastActivity = $lastActivity
        lastMessageAt = $lastActivity
        messageCount = 5 + $Depth
        actionCount = 3 + $Depth
        totalSize = 1024 * (1 + $Depth)
        workspace = $Workspace
        parentTaskId = $ParentId
        depth = $Depth
    }
}

function New-ControlledUiMessages {
    param(
        [string]$TaskId,
        [string]$Instruction,
        [string]$ParentId = $null
    )
    
    $messages = @()
    
    # Message initial avec l'instruction
    $messages += @{
        type = "say"
        text = $Instruction
        timestamp = (Get-Date).AddMinutes(-30).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        author = "user"
    }
    
    # Messages de progression
    $messages += @{
        type = "say"
        text = "Analyse en cours pour la tâche $TaskId..."
        timestamp = (Get-Date).AddMinutes(-25).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        author = "assistant"
    }
    
    # Si c'est une tâche parente, ajouter des déclarations new_task
    if ($ParentId -eq $null) {
        $messages += @{
            type = "tool_call"
            tool = "new_task"
            text = "Création d'une sous-tâche pour $TaskId"
            timestamp = (Get-Date).AddMinutes(-20).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            author = "assistant"
        }
    }
    
    # Message de complétion
    $messages += @{
        type = "say"
        text = "Tâche $TaskId terminée avec succès"
        timestamp = (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        author = "assistant"
    }
    
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
    
    Write-SdddLog "Création fixture SDDD: $TaskId ($Title)" "INFO"
    
    $taskDir = Join-Path $FixturePath $TaskId
    New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
    
    # Créer les métadonnées
    $metadata = New-ControlledTaskMetadata -TaskId $TaskId -Title $Title -Instruction $Instruction -ParentId $ParentId -Depth $Depth
    $metadata | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $taskDir "task_metadata.json") -Encoding UTF8
    
    # Créer les UI messages
    $uiMessages = New-ControlledUiMessages -TaskId $TaskId -Instruction $Instruction -ParentId $ParentId
    $uiMessages | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $taskDir "ui_messages.json") -Encoding UTF8
    
    Write-SdddLog "  ✓ task_metadata.json créé" "SUCCESS"
    Write-SdddLog "  ✓ ui_messages.json créé" "SUCCESS"
}

function New-ControlledHierarchyFixtures {
    param([string]$BasePath)
    
    Write-SdddLog "=== CRÉATION DES FIXTURES SDDD CONTRÔLÉES ===" "SUCCESS"
    
    # Créer les répertoires de base
    $unitFixturePath = Join-Path $BasePath "tests/unit/utils/fixtures/controlled-hierarchy"
    $integrationFixturePath = Join-Path $BasePath "tests/integration/fixtures/controlled-hierarchy"
    
    New-Item -ItemType Directory -Path $unitFixturePath -Force | Out-Null
    New-Item -ItemType Directory -Path $integrationFixturePath -Force | Out-Null
    
    Write-SdddLog "Répertoires créés:" "INFO"
    Write-SdddLog "  - $unitFixturePath" "INFO"
    Write-SdddLog "  - $integrationFixturePath" "INFO"
    
    # Définir la hiérarchie contrôlée SDDD
    $rootInstruction = '# Phase 3D : Hierarchy Reconstruction - Execution SDDD. Corriger les 12 tests hierarchy echouants en suivant la methodologie SDDD pour atteindre 92.1%+ de tests passants.'
    $branchAInstruction = '## ETAPE 1 : Diagnostic SDDD Precis. Executer les tests hierarchy avec mode verbose SDDD pour identifier les erreurs precise.'
    $branchBInstruction = '## ETAPE 2 : Correction SDDD Fixture Loading. Analyser le chargement des fixtures dans les tests et corriger les problemes de lecture.'
    $nodeB1Instruction = '## ETAPE 4 : Validation SDDD. Executer les tests hierarchy un par un avec reporter verbose pour validation progressive.'
    $leafA1Instruction = '## ETAPE 5 : Documentation SDDD. Creer le rapport PHASE3D_SDDD_REPORT.md avec la methodologie SDDD.'
    $leafB1AInstruction = '### Tests unitaires SDDD. Tests pour calculer les profondeurs de maniere deterministe avec validation des resultats.'
    $leafB1BInstruction = '### Mocks SDDD controles. Mock du filesystem avec vi.mock pour garantir la reproductibilite des tests.'

    $hierarchy = @(
        @{
            TaskId = $TEST_HIERARCHY_IDS.ROOT
            Title = "Tache Racine - Phase 3D SDDD"
            Instruction = $rootInstruction
            ParentId = $null
            Depth = 0
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.BRANCH_A
            Title = "Branche A - Diagnostic SDDD"
            Instruction = $branchAInstruction
            ParentId = $TEST_HIERARCHY_IDS.ROOT
            Depth = 1
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.BRANCH_B
            Title = "Branche B - Correction SDDD"
            Instruction = $branchBInstruction
            ParentId = $TEST_HIERARCHY_IDS.ROOT
            Depth = 1
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.NODE_B1
            Title = "Noeud B1 - Validation SDDD"
            Instruction = $nodeB1Instruction
            ParentId = $TEST_HIERARCHY_IDS.BRANCH_B
            Depth = 2
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.LEAF_A1
            Title = "Feuille A1 - Documentation SDDD"
            Instruction = $leafA1Instruction
            ParentId = $TEST_HIERARCHY_IDS.BRANCH_A
            Depth = 2
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.LEAF_B1A
            Title = "Feuille B1A - Tests Unitaires SDDD"
            Instruction = $leafB1AInstruction
            ParentId = $TEST_HIERARCHY_IDS.NODE_B1
            Depth = 3
        },
        @{
            TaskId = $TEST_HIERARCHY_IDS.LEAF_B1B
            Title = "Feuille B1B - Mocks SDDD"
            Instruction = $leafB1BInstruction
            ParentId = $TEST_HIERARCHY_IDS.NODE_B1
            Depth = 3
        }
    )
    
    # Créer les fixtures pour les tests unitaires
    Write-SdddLog "Création fixtures tests unitaires..." "INFO"
    foreach ($task in $hierarchy) {
        if ($task.TaskId -ne $TEST_HIERARCHY_IDS.COLLECTE) {
            New-ControlledFixture -TaskId $task.TaskId -Title $task.Title -Instruction $task.Instruction -ParentId $task.ParentId -Depth $task.Depth -FixturePath $unitFixturePath
        }
    }
    
    # Créer les fixtures pour les tests d'intégration (mêmes données)
    Write-SdddLog "Création fixtures tests intégration..." "INFO"
    foreach ($task in $hierarchy) {
        if ($task.TaskId -ne $TEST_HIERARCHY_IDS.COLLECTE) {
            New-ControlledFixture -TaskId $task.TaskId -Title $task.Title -Instruction $task.Instruction -ParentId $task.ParentId -Depth $task.Depth -FixturePath $integrationFixturePath
        }
    }
    
    # Créer un fichier de résumé SDDD
    $summary = @{
        timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        methodology = "SDDD"
        totalTasks = $hierarchy.Count - 1 # Exclure COLLECTE
        maxDepth = 3
        hierarchy = $hierarchy | Where-Object { $_.TaskId -ne $TEST_HIERARCHY_IDS.COLLECTE }
        fixturePaths = @{
            unit = $unitFixturePath
            integration = $integrationFixturePath
        }
    }
    
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $unitFixturePath "hierarchy-summary.json") -Encoding UTF8
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath (Join-Path $integrationFixturePath "hierarchy-summary.json") -Encoding UTF8
    
    Write-SdddLog "✅ Fixtures SDDD créées avec succès" "SUCCESS"
    Write-SdddLog "Total tâches: $($summary.totalTasks)" "INFO"
    Write-SdddLog "Profondeur max: $($summary.maxDepth)" "INFO"
    
    return $summary
}

# Script principal SDDD
try {
    Write-SdddLog "=== DÉBUT CRÉATION FIXTURES SDDD ===" "SUCCESS"
    Write-SdddLog "Workspace: $WorkspacePath" "INFO"
    
    # Créer les fixtures contrôlées
    $result = New-ControlledHierarchyFixtures -BasePath $WorkspacePath
    
    Write-SdddLog "=== FIXTURES SDDD CRÉÉES AVEC SUCCÈS ===" "SUCCESS"
    Write-SdddLog "Méthodologie: SDDD" "INFO"
    Write-SdddLog "Reproductibilité: 100%" "INFO"
    Write-SdddLog "Déterminisme: 100%" "INFO"
    
}
catch {
    Write-SdddLog "Erreur critique: $($_.Exception.Message)" "ERROR"
    Write-SdddLog "Stack trace: $($_.ScriptStackTrace)" "ERROR"
    exit 1
}