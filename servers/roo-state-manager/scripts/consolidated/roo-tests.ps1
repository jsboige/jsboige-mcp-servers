# Script unifié de tests pour roo-state-manager
# Ce script consolide toutes les fonctionnalités de test en un seul fichier

param(
    [Parameter(Mandatory=$false)][string]$TestMode = "unit",
    [Parameter(Mandatory=$false)][string]$OutputParam = "",
    [Parameter(Mandatory=$false)][switch]$Diagnostic,
    [Parameter(Mandatory=$false)][switch]$Audit,
    [Parameter(Mandatory=$false)][switch]$Detailed,
    [Parameter(Mandatory=$false)][switch]$Report,
    [Parameter(Mandatory=$false)][string]$Config = "config/test-config.json",
    [Parameter(Mandatory=$false)][switch]$Help
)

# Fonctions utilitaires
function Write-Info {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Error-Message {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
}

function Write-Success {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Verbose-Message {
    param([string]$Message)
    if ($Verbose) {
        Write-Host $Message -ForegroundColor Yellow
    }
}

# Fonction de chargement de configuration
function Load-Config {
    param([string]$ConfigPath)
    
    $fullConfigPath = Join-Path $ProjectRoot $ConfigPath
    
    if (-not (Test-Path $fullConfigPath)) {
        Write-Error-Message "Fichier de configuration non trouvé : $fullConfigPath"
        return $null
    }
    
    try {
        $configContent = Get-Content $fullConfigPath -Raw
        $config = $configContent | ConvertFrom-Json
        return $config
    } catch {
        Write-Error-Message "Erreur lors du chargement de la configuration : $($_.Exception.Message)"
        return $null
    }
}

# Fonction d'exécution des tests
function Invoke-Tests {
    param([string]$TestType, [psobject]$Config)
    
    Write-Host "EXECUTION DES TESTS" -ForegroundColor Cyan
    Write-Host "===================" -ForegroundColor Cyan
    Write-Host ""
    
    $testConfig = $Config.testTypes.$TestMode
    Write-Verbose-Message "TestConfig trouvé : $($testConfig | ConvertTo-Json -Compress)"
    if (-not $testConfig) {
        Write-Error-Message "Type de test non configure : $TestType"
        return $false
    }
    
    Write-Info "Type de tests : $TestType"
    Write-Info "Pattern : $($testConfig.pattern)"
    Write-Info "Timeout : $($testConfig.timeout)ms"
    Write-Info "Description : $($testConfig.description)"
    Write-Host ""
    
    # Preparation de la sortie
    $outputFormats = @()
    if ($OutputParam -eq "all" -or $OutputParam -eq "console") { $outputFormats += "console" }
    if ($OutputParam -eq "all" -or $OutputParam -eq "json") { $outputFormats += "json" }
    if ($OutputParam -eq "all" -or $OutputParam -eq "markdown") { $outputFormats += "markdown" }
    
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $outputFile = $Config.output.directory + "/" + ($Config.output.filename -replace '\{timestamp\}', $timestamp)
    
    # Creer le repertoire de sortie si necessaire
    $outputDir = Split-Path $outputFile -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    
    # Exécution réelle des tests avec Vitest
    $startTime = Get-Date
    Write-Info "Debut de l'execution : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))"
    
    # Exécuter les tests avec Vitest selon le type (sans construction préalable)
    $testCommand = switch ($TestType) {
        "unit" { "npx vitest run tests/unit --reporter=verbose --root `"$ProjectRoot`"" }
        "integration" { "npx vitest run tests/integration --reporter=verbose --root `"$ProjectRoot`"" }
        "e2e" { "npx vitest run tests/e2e --reporter=verbose --root `"$ProjectRoot`"" }
        "detector" { "npm run test:detector" }
        "all" { "npx vitest run tests --reporter=verbose --root `"$ProjectRoot`"" }
        default { "npx vitest run tests/unit --reporter=verbose --root `"$ProjectRoot`"" }
    }
    
    Write-Info "Execution des tests avec la commande: $testCommand"
    
    # Exécuter la commande depuis le répertoire racine du projet
    $testCommandFromRoot = "cd `"$ProjectRoot`" && $testCommand"
    $testOutput = cmd /c $testCommandFromRoot 2>&1
    $exitCode = $LASTEXITCODE
    
    # Afficher la sortie pour le débogage
    Write-Host "SORTIE DES TESTS:" -ForegroundColor Yellow
    Write-Host $testOutput -ForegroundColor White
    
    # Analyser les résultats pour extraire les statistiques
    $passingTests = 0
    $failingTests = 0
    $testCount = 0
    
    # Extraire les informations des résultats de Vitest
    if ($testOutput -match "(\d+)\s+passing") {
        $passingTests = [int]$matches[1]
    }
    if ($testOutput -match "(\d+)\s+failing") {
        $failingTests = [int]$matches[1]
    }
    if ($testOutput -match "Test Files\s+(\d+)") {
        $testCount = [int]$matches[1]
    }
    
    $endTime = Get-Date
    $duration = $endTime - $startTime
    
    # Le code de sortie vient déjà de l'exécution de Vitest
    # $exitCode est déjà défini par $LASTEXITCODE
    
    Write-Host ""
    Write-Host "RESULTATS" -ForegroundColor Cyan
    Write-Host "============" -ForegroundColor Cyan
    Write-Host "Duree : $($duration.TotalSeconds) secondes" -ForegroundColor White
    Write-Host "Code de sortie : $exitCode" -ForegroundColor White
    
    # Analyse des resultats
    if ($testOutput -match "(\d+) passing") {
        Write-Success "Tests passants : $($matches[1])"
    }
    
    if ($testOutput -match "(\d+) failing") {
        Write-Error-Message "Tests echouants : $($matches[1])"
    } else {
        Write-Success "Aucun echec detecte"
    }
    
    # Sauvegarder la sortie
    if ($outputFormats -contains "console") {
        Write-Host ""
        Write-Host "SORTIE CONSOLE" -ForegroundColor Cyan
        Write-Host "==================" -ForegroundColor Cyan
        Write-Host $testOutput
    }
    
    if ($outputFormats -contains "markdown") {
        $markdownOutput = $outputFile + ".md"
        $markdown = @"
# Rapport d'Execution des Tests

**Type** : $TestMode  
**Timestamp** : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  
**Duree** : $($duration.TotalSeconds) secondes  
**Code de sortie** : $exitCode  

## Sortie Complete

```
$testOutput
```

---

*Genere par roo-tests.ps1*
"@
        $markdown | Out-File -FilePath $markdownOutput -Encoding UTF8 -Force
        Write-Info "Rapport Markdown sauvegarde : $markdownOutput"
    }
    
    if ($outputFormats -contains "json") {
        $jsonOutput = $outputFile + ".json"
        $jsonResult = @{
            type = $TestMode
            timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
            duration = $duration.TotalSeconds
            exitCode = $exitCode
            output = $testOutput
            summary = @{
                total = $testCount
                passing = $passingTests
                failing = $failingTests
            }
        } | ConvertTo-Json -Depth 3
        $jsonResult | Out-File -FilePath $jsonOutput -Encoding UTF8 -Force
        Write-Info "Resultats JSON sauvegardes : $jsonOutput"
    }
    
    return $exitCode -eq 0
}

# Point d'entree principal
function Main {
    Write-Host "SCRIPT UNIFIE DE TESTS - roo-state-manager" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host ""
    
    if ($Help) {
        Show-Help
        return
    }
    
    # Charger la configuration
    $config = Load-Config -ConfigPath $Config
    if (-not $config) {
        Write-Error "Impossible de charger la configuration. Utilisation des valeurs par defaut."
        # Configuration par defaut minimale
        $config = @{
            testTypes = @{
                unit = @{ command = "test:unit"; timeout = 30000; pattern = "tests/unit/**/*.test.ts"; description = "Tests unitaires" }
                integration = @{ command = "test:integration"; timeout = 60000; pattern = "tests/integration/**/*.test.ts"; description = "Tests d'integration" }
                e2e = @{ command = "test:e2e"; timeout = 120000; pattern = "tests/e2e/**/*.test.ts"; description = "Tests end-to-end" }
                detector = @{ command = "test:detector"; timeout = 30000; pattern = "tests/unit/services/DiffDetector.test.ts"; description = "Tests du detecteur" }
                all = @{ command = "test"; timeout = 120000; pattern = "tests/**/*.test.ts"; description = "Tous les tests" }
            }
            output = @{
                formats = @("console")
                directory = "./test-results"
                filename = "test-results-{timestamp}"
            }
        }
    }
    
    Write-Info "Repertoire du projet : $ProjectRoot"
    Write-Info "Configuration chargee : $Config"
    Write-Host ""
    
    # Diagnostic si demande
    if ($Diagnostic) {
        Invoke-Diagnostic
        Write-Host ""
    }
    
    # Audit si demande
    if ($Audit) {
        Invoke-Audit
        Write-Host ""
    }
    
    # Execution des tests
    # Forcer TestMode à "all" si vide (contournement temporaire)
    if ([string]::IsNullOrEmpty($TestMode)) {
        $TestMode = "all"
        Write-Verbose-Message "TestMode forcé à 'all' car vide"
    }
    
    $success = Invoke-Tests -TestType $TestMode -Config $config
    
    if ($success) {
        Write-Success "Tests termines avec succes"
        exit 0
    } else {
        Write-Error-Message "Echec des tests"
        exit 1
    }
}

# Fonction d'aide
function Show-Help {
    Write-Host @"
USAGE: roo-tests.ps1 [PARAMETRES]

PARAMETRES:
    -TestMode <type>    Type de tests (unit, integration, e2e, detector, all)
    -OutputParam <type>  Format de sortie (console, json, markdown, all)
    -Diagnostic         Active le mode diagnostic
    -Audit             Active le mode audit
    -Detailed          Affiche les details supplementaires
    -Report            Genere un rapport complet
    -Config <path>     Chemin du fichier de configuration
    -Help              Affiche cette aide

EXEMPLES:
    .\roo-tests.ps1
    .\roo-tests.ps1 -TestMode integration
    .\roo-tests.ps1 -TestMode all -OutputParam all
    .\roo-tests.ps1 -Diagnostic -Verbose
"@ -ForegroundColor White
}

# Initialisation
$ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Write-Verbose-Message "Répertoire racine du projet: $ProjectRoot"

# Lancer le point d'entree
Main
