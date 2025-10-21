# Script de Diagnostic des Tests avec Journalisation Détaillée
param(
    [string]$OutputFile = "test-diagnostic-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "DIAGNOSTIC DES TESTS AVEC JOURNALISATION" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Se placer dans le répertoire du package
$packageRoot = Split-Path -Parent $PSScriptRoot
Set-Location $packageRoot

Write-Host "📁 Répertoire : $packageRoot" -ForegroundColor Yellow
Write-Host "📝 Fichier de sortie : $OutputFile" -ForegroundColor Yellow
Write-Host ""

# Timestamp de début
$startTime = Get-Date
Write-Host "⏱️  Début : $($startTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Green
Write-Host ""

# Journaliser l'état initial
Write-Host "🔍 ÉTAT INITIAL" -ForegroundColor Magenta
Write-Host "Node version :" -ForegroundColor White
node --version 2>&1 | Tee-Object -FilePath $OutputFile -Append
Write-Host "NPM version :" -ForegroundColor White
npm --version 2>&1 | Tee-Object -FilePath $OutputFile -Append
Write-Host "PowerShell version :" -ForegroundColor White
$PSVersionTable.PSVersion 2>&1 | Tee-Object -FilePath $OutputFile -Append
Write-Host ""

# Vérifier les dépendances
Write-Host "📦 VÉRIFICATION DES DÉPENDANCES" -ForegroundColor Magenta
Write-Host "Vérification de package.json..." -ForegroundColor White
if (Test-Path "package.json") {
    Write-Host "✅ package.json trouvé" -ForegroundColor Green
    Get-Content "package.json" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
} else {
    Write-Host "❌ package.json non trouvé" -ForegroundColor Red
    "ERREUR: package.json non trouvé" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}
Write-Host ""

# Vérifier node_modules
Write-Host "📂 VÉRIFICATION DE node_modules" -ForegroundColor Magenta
if (Test-Path "node_modules") {
    Write-Host "✅ node_modules trouvé" -ForegroundColor Green
    $moduleCount = (Get-ChildItem "node_modules" -Directory).Count
    Write-Host "📊 Nombre de modules : $moduleCount" -ForegroundColor White
    "Nombre de modules dans node_modules: $moduleCount" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
} else {
    Write-Host "❌ node_modules non trouvé" -ForegroundColor Red
    "ERREUR: node_modules non trouvé" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}
Write-Host ""

# Vérifier Jest spécifiquement
Write-Host "🧪 VÉRIFICATION DE JEST" -ForegroundColor Magenta
try {
    $jestVersion = npx jest --version 2>&1
    Write-Host "✅ Jest version : $jestVersion" -ForegroundColor Green
    "Jest version: $jestVersion" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
} catch {
    Write-Host "❌ Erreur lors de la vérification de Jest : $_" -ForegroundColor Red
    "ERREUR Jest: $_" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}
Write-Host ""

# Vérifier les fichiers de test
Write-Host "📄 VÉRIFICATION DES FICHIERS DE TEST" -ForegroundColor Magenta
$testFiles = Get-ChildItem -Path "src/tests" -Filter "*.test.ts" -Recurse
Write-Host "📊 Fichiers de test trouvés : $($testFiles.Count)" -ForegroundColor White
foreach ($file in $testFiles) {
    Write-Host "  - $($file.FullName)" -ForegroundColor Gray
    "Fichier de test: $($file.FullName)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}
Write-Host ""

# Vérifier la configuration TypeScript
Write-Host "🔧 VÉRIFICATION DE LA CONFIGURATION TYPESCRIPT" -ForegroundColor Magenta
if (Test-Path "tsconfig.json") {
    Write-Host "✅ tsconfig.json trouvé" -ForegroundColor Green
    Get-Content "tsconfig.json" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
} else {
    Write-Host "❌ tsconfig.json non trouvé" -ForegroundColor Red
    "ERREUR: tsconfig.json non trouvé" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}

if (Test-Path "jest.config.cjs") {
    Write-Host "✅ jest.config.cjs trouvé" -ForegroundColor Green
    Get-Content "jest.config.cjs" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
} else {
    Write-Host "❌ jest.config.cjs non trouvé" -ForegroundColor Red
    "ERREUR: jest.config.cjs non trouvé" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}
Write-Host ""

# Tenter une compilation TypeScript
Write-Host "🔨 TEST DE COMPILATION TYPESCRIPT" -ForegroundColor Magenta
Write-Host "Tentative de compilation..." -ForegroundColor White
try {
    $compileResult = npx tsc --noEmit 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Compilation TypeScript réussie" -ForegroundColor Green
        "Compilation TypeScript: SUCCÈS" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
    } else {
        Write-Host "⚠️  Erreurs de compilation TypeScript" -ForegroundColor Yellow
        Write-Host $compileResult -ForegroundColor Gray
        "Compilation TypeScript: ERREUR" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
        $compileResult | Out-File -FilePath $OutputFile -Append -Encoding UTF8
    }
} catch {
    Write-Host "❌ Erreur lors de la compilation : $_" -ForegroundColor Red
    "ERREUR compilation: $_" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
}
Write-Host ""

# Exécuter les tests avec journalisation détaillée
Write-Host "🧪 EXÉCUTION DES TESTS" -ForegroundColor Magenta
Write-Host "Début de l'exécution des tests..." -ForegroundColor White

# Journaliser avant l'exécution
"DÉBUT EXÉCUTION DES TESTS: $(Get-Date)" | Out-File -FilePath $OutputFile -Append -Encoding UTF8

# Exécuter avec timeout et capture détaillée
$testProcess = Start-Process -FilePath "npm" -ArgumentList "test" -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$($packageRoot)\test-output.log" -RedirectStandardError "$($packageRoot)\test-error.log"

$testOutput = Get-Content "$($packageRoot)\test-output.log" -Raw -ErrorAction SilentlyContinue
$testError = Get-Content "$($packageRoot)\test-error.log" -Raw -ErrorAction SilentlyContinue

# Journaliser les résultats
"TEST OUTPUT:" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
$testOutput | Out-File -FilePath $OutputFile -Append -Encoding UTF8

"TEST ERROR:" | Out-File -FilePath $OutputFile -Append -Encoding UTF8
$testError | Out-File -FilePath $OutputFile -Append -Encoding UTF8

$exitCode = $testProcess.ExitCode

Write-Host ""
Write-Host "📊 RÉSULTATS" -ForegroundColor Magenta
Write-Host "Code de sortie : $exitCode" -ForegroundColor White

if ($testOutput -match "(\d+) passing") {
    Write-Host "✅ Tests passants : $($matches[1])" -ForegroundColor Green
}

if ($testOutput -match "(\d+) failing") {
    Write-Host "❌ Tests échouants : $($matches[1])" -ForegroundColor Red
}

if ($exitCode -eq 0) {
    Write-Host "✅ SUCCÈS" -ForegroundColor Green
} else {
    Write-Host "⚠️  ÉCHECS DÉTECTÉS" -ForegroundColor Yellow
}

# Timestamp de fin
$endTime = Get-Date
$duration = $endTime - $startTime

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "⏱️  Fin : $($endTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Green
Write-Host "⏱️  Durée : $($duration.TotalSeconds) secondes" -ForegroundColor Green
Write-Host "📄 Journal complet : $OutputFile" -ForegroundColor Yellow
Write-Host "📄 Sortie des tests : test-output.log" -ForegroundColor Yellow
Write-Host "📄 Erreurs des tests : test-error.log" -ForegroundColor Yellow
Write-Host ""

# Nettoyer les fichiers temporaires si nécessaire
Remove-Item "$($packageRoot)\test-output.log" -ErrorAction SilentlyContinue
Remove-Item "$($packageRoot)\test-error.log" -ErrorAction SilentlyContinue

Write-Host "Diagnostic terminé." -ForegroundColor Cyan