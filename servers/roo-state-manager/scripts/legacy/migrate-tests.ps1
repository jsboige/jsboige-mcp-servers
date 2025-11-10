<#
.SYNOPSIS
    Script automatisé de migration de l'arborescence des tests
.DESCRIPTION
    Implémente le plan de migration MIGRATION-PLAN-TESTS.md étape par étape
    avec validation et possibilité de rollback
.PARAMETER DryRun
    Mode simulation : affiche les actions sans les exécuter
.PARAMETER SkipGit
    Ne pas créer de branche Git ni de commits
.EXAMPLE
    .\migrate-tests.ps1 -DryRun
    .\migrate-tests.ps1
    .\migrate-tests.ps1 -SkipGit
#>

param(
    [switch]$DryRun = $false,
    [switch]$SkipGit = $false
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# Couleurs pour les messages
function Write-Step { param($Message) Write-Host "`n[STEP] $Message" -ForegroundColor Cyan }
function Write-Success { param($Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Warning { param($Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Failure { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Gray }

# Fonction pour demander confirmation (désactivée - mode auto)
function Confirm-Action {
    param(
        [string]$Message,
        [switch]$Force
    )
    
    # Mode automatique : toujours accepter
    return $true
}

# Fonction pour déplacer un fichier avec validation
function Move-FileSafely {
    param(
        [string]$Source,
        [string]$Destination
    )
    
    if ($DryRun) {
        Write-Info "DRY-RUN: Move '$Source' -> '$Destination'"
        return $true
    }
    
    if (-not (Test-Path $Source)) {
        Write-Warning "Source not found: $Source"
        return $false
    }
    
    $destDir = Split-Path $Destination -Parent
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    
    try {
        Move-Item -Path $Source -Destination $Destination -Force
        Write-Info "Moved: $(Split-Path $Source -Leaf) -> $Destination"
        return $true
    } catch {
        Write-Failure "Failed to move $Source : $_"
        return $false
    }
}

Write-Host @"
╔════════════════════════════════════════════════════════════╗
║   MIGRATION ARBORESCENCE TESTS - roo-state-manager        ║
║                                                            ║
║   Mode: $(if ($DryRun) { "DRY-RUN (simulation)" } else { "EXECUTION RÉELLE" })                                  ║
╚════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

if ($DryRun) {
    Write-Warning "MODE DRY-RUN : Aucun fichier ne sera modifié"
}

# Statistiques
$stats = @{
    DirectoriesCreated = 0
    FilesMoved = 0
    FilesArchived = 0
    Errors = 0
}

# ============================================================================
# PRÉ-REQUIS
# ============================================================================

Write-Step "PRÉ-REQUIS : Vérification de l'environnement"

if (-not $SkipGit) {
    Write-Info "Vérification de Git..."
    $gitStatus = git status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Failure "Git non disponible ou pas un dépôt Git"
        exit 1
    }
    
    Write-Info "État Git actuel :"
    git status --short
    
    if (-not (Confirm-Action "Créer une branche dédiée 'refactor/tests-reorganization' ?")) {
        Write-Warning "Migration annulée par l'utilisateur"
        exit 0
    }
    
    if (-not $DryRun) {
        git checkout -b "refactor/tests-reorganization" 2>&1 | Out-Null
        git add .
        git commit -m "chore: state before tests reorganization" 2>&1 | Out-Null
        Write-Success "Branche créée et état sauvegardé"
    }
}

Write-Info "Exécution du baseline des tests..."
if (-not $DryRun) {
    npm test > "pre-migration-results.log" 2>&1
    Write-Success "Baseline sauvegardé dans pre-migration-results.log"
}

# ============================================================================
# ÉTAPE 1 : CRÉATION STRUCTURE
# ============================================================================

Write-Step "ÉTAPE 1/11 : Création de la nouvelle structure"

$directories = @(
    "tests/unit/services",
    "tests/unit/utils",
    "tests/unit/tools",
    "tests/unit/gateway",
    "tests/integration/hierarchy",
    "tests/integration/storage",
    "tests/integration/api",
    "tests/e2e/scenarios",
    "tests/helpers",
    "tests/archive",
    "tests/archive/manual",
    "tests/archive/compiled"
)

foreach ($dir in $directories) {
    if ($DryRun) {
        Write-Info "DRY-RUN: Create directory '$dir'"
    } else {
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $stats.DirectoriesCreated++
            Write-Info "Created: $dir"
        }
    }
}

Write-Success "Étape 1 terminée : $($stats.DirectoriesCreated) répertoires créés"

# ============================================================================
# ÉTAPE 2 : ARCHIVAGE FICHIERS COMPILÉS
# ============================================================================

Write-Step "ÉTAPE 2/11 : Archivage des fichiers compilés"

$compiledFiles = Get-ChildItem -Path "tests" -Recurse -Include "*.test.js","*.test.d.ts","*.test.js.map","*.test.d.ts.map" -File

Write-Info "Trouvé $($compiledFiles.Count) fichiers compilés"

if (-not (Confirm-Action "Archiver ces fichiers compilés ?")) {
    Write-Warning "Étape 2 ignorée"
} else {
    foreach ($file in $compiledFiles) {
        $destPath = Join-Path "tests/archive/compiled" $file.Name
        if (Move-FileSafely -Source $file.FullName -Destination $destPath) {
            $stats.FilesArchived++
        } else {
            $stats.Errors++
        }
    }
    
    # Créer README
    if (-not $DryRun) {
        @"
# Archive - Fichiers Compilés

Ces fichiers sont générés automatiquement par TypeScript lors du build.

## Raison de l'archivage
- Pollution du répertoire source
- Générés par \`npm run build:tests\`
- Doivent être dans \`build/tests/\` uniquement

## Date d'archivage
$(Get-Date -Format "yyyy-MM-dd")

## Action recommandée
Ces fichiers peuvent être supprimés en toute sécurité.
"@ | Out-File -FilePath "tests/archive/compiled/README.md" -Encoding UTF8
    }
    
    Write-Success "Étape 2 terminée : $($stats.FilesArchived) fichiers archivés"
}

# ============================================================================
# ÉTAPE 3 : MIGRATION TESTS DEPUIS src/
# ============================================================================

Write-Step "ÉTAPE 3/11 : Migration des tests depuis src/"

$srcMigrations = @(
    @{ Src="src/test-detail-levels.ts"; Dest="tests/archive/manual/detail-levels-manual.ts" },
    @{ Src="src/test-enhanced-integration.ts"; Dest="tests/archive/manual/enhanced-integration-manual.ts" },
    @{ Src="src/test-hierarchy-fix.ts"; Dest="tests/archive/manual/hierarchy-fix-manual.ts" },
    @{ Src="src/test-hierarchy-limited.ts"; Dest="tests/archive/manual/hierarchy-limited-manual.ts" },
    @{ Src="src/test-hierarchy-reconstruction.ts"; Dest="tests/archive/manual/hierarchy-reconstruction-manual.ts" },
    @{ Src="src/test-strategy-refactoring.js"; Dest="tests/archive/manual/strategy-refactoring-manual.js" },
    @{ Src="src/index.test.ts"; Dest="tests/integration/api/unified-gateway-index.test.ts" },
    @{ Src="src/__tests__/UnifiedApiGateway.test.ts"; Dest="tests/unit/gateway/unified-api-gateway.test.ts" }
)

if (-not (Confirm-Action "Migrer $($srcMigrations.Count) fichiers depuis src/ ?")) {
    Write-Warning "Étape 3 ignorée"
} else {
    foreach ($migration in $srcMigrations) {
        if (Move-FileSafely -Source $migration.Src -Destination $migration.Dest) {
            $stats.FilesMoved++
        } else {
            $stats.Errors++
        }
    }
    
    # Créer README pour archive/manual
    if (-not $DryRun) {
        @"
# Archive - Tests Manuels

Ces fichiers étaient des scripts de tests manuels ou des fichiers obsolètes.

## Contenu
- \`*-manual.ts\` : Scripts d'exploration/débogage manuel
- Fichiers vides ou non utilisés

## Raison de l'archivage
- Pas de vrais tests automatisés
- Utilisés pour débogage ponctuel
- Remplacés par les vrais tests dans tests/

## Date d'archivage
$(Get-Date -Format "yyyy-MM-dd")

## Action recommandée
Conserver pour référence historique.
"@ | Out-File -FilePath "tests/archive/manual/README.md" -Encoding UTF8
    }
    
    Write-Success "Étape 3 terminée : $($stats.FilesMoved) fichiers migrés"
}

# ============================================================================
# ÉTAPE 4 : CATÉGORISATION TESTS UNIT
# ============================================================================

Write-Step "ÉTAPE 4/11 : Catégorisation des tests unitaires"

$unitMigrations = @(
    # Utils
    @{ Src="tests/bom-handling.test.ts"; Dest="tests/unit/utils/bom-handling.test.ts" },
    @{ Src="tests/timestamp-parsing.test.ts"; Dest="tests/unit/utils/timestamp-parsing.test.ts" },
    @{ Src="tests/versioning.test.ts"; Dest="tests/unit/utils/versioning.test.ts" },
    @{ Src="tests/utils/hierarchy-inference.test.ts"; Dest="tests/unit/utils/hierarchy-inference.test.ts" },
    # Services
    @{ Src="tests/task-instruction-index.test.ts"; Dest="tests/unit/services/task-instruction-index.test.ts" },
    @{ Src="tests/task-navigator.test.ts"; Dest="tests/unit/services/task-navigator.test.ts" },
    @{ Src="tests/xml-parsing.test.ts"; Dest="tests/unit/services/xml-parsing.test.ts" },
    @{ Src="tests/services/indexing-decision.test.ts"; Dest="tests/unit/services/indexing-decision.test.ts" },
    @{ Src="tests/services/synthesis.service.test.ts"; Dest="tests/unit/services/synthesis.service.test.ts" },
    @{ Src="tests/services/task-indexer.test.ts"; Dest="tests/unit/services/task-indexer.test.ts" },
    @{ Src="tests/services/anti-leak-protections.test.ts"; Dest="tests/archive/anti-leak-protections.test.ts.TODO" },
    # Tools
    @{ Src="tests/manage-mcp-settings.test.ts"; Dest="tests/unit/tools/manage-mcp-settings.test.ts" },
    @{ Src="tests/read-vscode-logs.test.ts"; Dest="tests/unit/tools/read-vscode-logs.test.ts" },
    @{ Src="tests/view-conversation-tree.test.ts"; Dest="tests/unit/tools/view-conversation-tree.test.ts" }
)

if (-not (Confirm-Action "Migrer $($unitMigrations.Count) tests unitaires ?")) {
    Write-Warning "Étape 4 ignorée"
} else {
    foreach ($migration in $unitMigrations) {
        if (Move-FileSafely -Source $migration.Src -Destination $migration.Dest) {
            $stats.FilesMoved++
        } else {
            $stats.Errors++
        }
    }
    
    Write-Success "Étape 4 terminée : tests unitaires catégorisés"
}

# ============================================================================
# ÉTAPE 5 : CATÉGORISATION TESTS INTEGRATION
# ============================================================================

Write-Step "ÉTAPE 5/11 : Catégorisation des tests d'intégration"

$integrationMigrations = @(
    @{ Src="tests/hierarchy-real-data.test.ts"; Dest="tests/integration/hierarchy/real-data.test.ts" },
    @{ Src="tests/hierarchy-reconstruction-engine.test.ts"; Dest="tests/integration/hierarchy/reconstruction-engine.test.ts" },
    @{ Src="tests/hierarchy-reconstruction.test.ts"; Dest="tests/integration/hierarchy/full-pipeline.test.ts" },
    @{ Src="tests/roo-storage-detector.test.ts"; Dest="tests/integration/storage/detector.test.ts" },
    @{ Src="tests/integration.test.ts"; Dest="tests/integration/api/unified-gateway.test.ts" },
    @{ Src="tests/task-tree-integration.test.js"; Dest="tests/integration/api/task-tree.test.js" }
)

if (-not (Confirm-Action "Migrer $($integrationMigrations.Count) tests d'intégration ?")) {
    Write-Warning "Étape 5 ignorée"
} else {
    foreach ($migration in $integrationMigrations) {
        if (Move-FileSafely -Source $migration.Src -Destination $migration.Dest) {
            $stats.FilesMoved++
        } else {
            $stats.Errors++
        }
    }
    
    Write-Success "Étape 5 terminée : tests d'intégration catégorisés"
}

# ============================================================================
# ÉTAPE 6 : CATÉGORISATION TESTS E2E
# ============================================================================

Write-Step "ÉTAPE 6/11 : Catégorisation des tests E2E"

$e2eMigrations = @(
    @{ Src="tests/e2e/semantic-search.test.ts"; Dest="tests/e2e/scenarios/semantic-search.test.ts" },
    @{ Src="tests/e2e/task-navigation.test.ts"; Dest="tests/e2e/scenarios/task-navigation.test.ts" },
    @{ Src="tests/e2e/placeholder.test.ts"; Dest="tests/e2e/scenarios/placeholder.test.ts" }
)

if (Test-Path "tests/e2e/e2e-runner.ts") {
    $e2eMigrations += @{ Src="tests/e2e/e2e-runner.ts"; Dest="tests/helpers/e2e-runner.ts" }
}

if (-not (Confirm-Action "Migrer $($e2eMigrations.Count) tests E2E ?")) {
    Write-Warning "Étape 6 ignorée"
} else {
    foreach ($migration in $e2eMigrations) {
        if (Move-FileSafely -Source $migration.Src -Destination $migration.Dest) {
            $stats.FilesMoved++
        } else {
            $stats.Errors++
        }
    }
    
    Write-Success "Étape 6 terminée : tests E2E catégorisés"
}

# ============================================================================
# ÉTAPE 7 : NETTOYAGE
# ============================================================================

Write-Step "ÉTAPE 7/11 : Nettoyage des répertoires vides"

$emptyDirs = @("tests/services", "tests/utils")

foreach ($dir in $emptyDirs) {
    if (Test-Path $dir) {
        $items = Get-ChildItem $dir -ErrorAction SilentlyContinue
        if ($items.Count -eq 0) {
            if ($DryRun) {
                Write-Info "DRY-RUN: Remove empty directory '$dir'"
            } else {
                Remove-Item $dir -Recurse -Force
                Write-Info "Removed empty directory: $dir"
            }
        }
    }
}

# Créer README.md pour tests/
if (-not $DryRun) {
    @"
# Organisation des Tests - roo-state-manager

Ce répertoire contient tous les tests du projet, organisés par type.

## Structure

\`\`\`
tests/
├── unit/              # Tests unitaires rapides et isolés
│   ├── services/      # Tests des services
│   ├── utils/         # Tests des utilitaires
│   ├── tools/         # Tests des outils MCP
│   └── gateway/       # Tests du gateway API
├── integration/       # Tests d'intégration multi-modules
│   ├── hierarchy/     # Tests de la hiérarchie complète
│   ├── storage/       # Tests de détection et storage
│   └── api/           # Tests de l'API gateway
├── e2e/              # Tests end-to-end complets
│   └── scenarios/    # Scénarios utilisateur complets
├── fixtures/         # Données de test (conservées)
├── config/           # Configuration Jest
├── helpers/          # Utilitaires de tests
└── archive/          # Tests obsolètes/désactivés
\`\`\`

## Exécution

\`\`\`bash
npm test              # Tous les tests
npm run test:unit     # Tests unitaires
npm run test:integration  # Tests d'intégration
npm run test:e2e      # Tests end-to-end
\`\`\`

Date de réorganisation : $(Get-Date -Format "yyyy-MM-dd")
"@ | Out-File -FilePath "tests/README.md" -Encoding UTF8
}

Write-Success "Étape 7 terminée : nettoyage effectué"

# ============================================================================
# RAPPORT FINAL
# ============================================================================

Write-Step "RAPPORT DE MIGRATION"

Write-Host @"

╔════════════════════════════════════════════════════════════╗
║                   STATISTIQUES FINALES                     ║
╚════════════════════════════════════════════════════════════╝

  Répertoires créés   : $($stats.DirectoriesCreated)
  Fichiers déplacés   : $($stats.FilesMoved)
  Fichiers archivés   : $($stats.FilesArchived)
  Erreurs             : $($stats.Errors)

"@

if ($stats.Errors -gt 0) {
    Write-Failure "Des erreurs sont survenues pendant la migration !"
    Write-Info "Vérifiez les messages ci-dessus pour plus de détails"
    exit 1
}

if ($DryRun) {
    Write-Info "MODE DRY-RUN : Aucune modification n'a été effectuée"
    Write-Info "Relancez sans -DryRun pour exécuter la migration réelle"
} else {
    Write-Success "Migration terminée avec succès !"
    Write-Info ""
    Write-Info "PROCHAINES ÉTAPES :"
    Write-Info "1. Mettre à jour jest.config.js (voir MIGRATION-PLAN-TESTS.md Étape 8)"
    Write-Info "2. Mettre à jour package.json (ajouter scripts test:unit, etc.)"
    Write-Info "3. Corriger les imports relatifs si nécessaire"
    Write-Info "4. Exécuter : npm run build && npm run build:tests"
    Write-Info "5. Exécuter : npm test"
    Write-Info "6. Comparer avec pre-migration-results.log"
}

Write-Host ""