<#
.SYNOPSIS
    Corrige automatiquement les imports relatifs dans les fichiers de tests.

.DESCRIPTION
    Ce script parcourt tous les fichiers de tests et corrige les imports relatifs
    vers src/ en fonction de la profondeur du fichier dans la hiérarchie tests/.

.PARAMETER DryRun
    Mode simulation : affiche les changements sans les appliquer.

.PARAMETER ShowDetails
    Affiche des informations détaillées sur chaque correction.

.EXAMPLE
    .\scripts\fix-test-imports.ps1 -DryRun
    .\scripts\fix-test-imports.ps1 -ShowDetails
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$ShowDetails
)

$ErrorActionPreference = "Stop"

# Couleurs pour l'affichage
function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

# Calcule le nombre de niveaux "../" nécessaires
function Get-DepthLevel {
    param([string]$RelativePath)
    
    # Normalise le chemin
    $normalized = $RelativePath -replace '\\', '/'
    
    # Compte les niveaux de profondeur
    # tests/unit/utils/*.test.ts → 3 niveaux
    # tests/integration/api/*.test.ts → 3 niveaux
    # tests/e2e/*.test.ts → 2 niveaux
    
    $parts = $normalized -split '/' | Where-Object { $_ -ne '' -and $_ -ne 'tests' }
    
    if ($parts.Count -eq 0) {
        return 1
    }
    
    # Compte le nombre de sous-répertoires après 'tests/'
    return $parts.Count
}

# Construit le préfixe correct
function Get-CorrectPrefix {
    param([int]$Depth)
    
    $prefix = ""
    for ($i = 0; $i -lt $Depth; $i++) {
        $prefix += "../"
    }
    return $prefix
}

# Principal
Write-ColorOutput "🔧 Correction des imports relatifs dans les tests" "Cyan"
Write-ColorOutput "=================================================" "Cyan"

if ($DryRun) {
    Write-ColorOutput "`n⚠️  MODE DRY-RUN ACTIVÉ - Aucune modification ne sera effectuée`n" "Yellow"
}

# Cherche tous les fichiers de tests
$testFiles = Get-ChildItem -Path "tests" -Filter "*.test.ts" -Recurse

if ($testFiles.Count -eq 0) {
    Write-ColorOutput "❌ Aucun fichier de test trouvé" "Red"
    exit 1
}

Write-ColorOutput "📁 Fichiers de tests trouvés : $($testFiles.Count)`n" "White"

$totalFixed = 0
$totalFiles = 0
$errors = @()

foreach ($file in $testFiles) {
    $relativePath = $file.FullName.Substring((Get-Location).Path.Length + 1)
    $relativePath = $relativePath -replace '\\', '/'
    
    # Calcule la profondeur
    $depth = Get-DepthLevel -RelativePath $relativePath
    $correctPrefix = Get-CorrectPrefix -Depth $depth
    
    if ($ShowDetails) {
        Write-ColorOutput "  📄 $relativePath (profondeur: $depth)" "Gray"
    }
    
    try {
        # Lit le contenu du fichier
        $content = Get-Content -Path $file.FullName -Raw -Encoding UTF8
        $originalContent = $content
        $changesMade = $false
        $changesDetail = @()
        
        # Patterns pour détecter TOUS les imports relatifs
        $patterns = @(
            @{
                Regex = "from\s+['""](\.\./)+src/"
                Description = "Import relatif vers src/"
            },
            @{
                Regex = "from\s+['""](\.\./)+package\.json"
                Description = "Import relatif vers package.json"
            },
            @{
                Regex = "jest\.mock\(['""](\.\./)+src/"
                Description = "Jest mock vers src/"
            },
            @{
                Regex = "jest\.mock\(['""](\.\./)+utils/"
                Description = "Jest mock vers utils/"
            },
            @{
                Regex = "jest\.unstable_mockModule\(['""](\.\./)+src/"
                Description = "Jest unstable_mockModule vers src/"
            },
            @{
                Regex = "[import|require]\(['""](\.\./)+package\.json"
                Description = "Import/require de package.json"
            }
        )
        
        foreach ($pattern in $patterns) {
            $matches = [regex]::Matches($content, $pattern.Regex)
            
            foreach ($match in $matches) {
                $oldImport = $match.Value
                
                # Extrait le nombre de "../"
                $currentPrefix = ($match.Groups[1].Captures | ForEach-Object { $_.Value }) -join ''
                
                # Détermine le type de remplacement
                if ($oldImport -match "package\.json") {
                    $newImport = $oldImport -replace "(\.\./)+package\.json", "${correctPrefix}package.json"
                }
                elseif ($oldImport -match "(\.\./)+utils/") {
                    $newImport = $oldImport -replace "(\.\./)+utils/", "${correctPrefix}utils/"
                }
                else {
                    # Par défaut, remplace vers src/
                    $newImport = $oldImport -replace "(\.\./)+src/", "${correctPrefix}src/"
                }
                
                if ($oldImport -ne $newImport) {
                    $content = $content -replace [regex]::Escape($oldImport), $newImport
                    $changesMade = $true
                    $changesDetail += "    - '$oldImport' → '$newImport'"
                }
            }
        }
        
        if ($changesMade) {
            $totalFiles++
            
            Write-ColorOutput "`n✏️  $relativePath" "Yellow"
            foreach ($detail in $changesDetail) {
                Write-ColorOutput $detail "Gray"
            }
            
            if (-not $DryRun) {
                # Écrit le fichier corrigé
                $content | Set-Content -Path $file.FullName -Encoding UTF8 -NoNewline
                $totalFixed++
                Write-ColorOutput "    ✅ Corrigé" "Green"
            } else {
                Write-ColorOutput "    🔍 Serait corrigé (dry-run)" "Cyan"
            }
        } elseif ($ShowDetails) {
            Write-ColorOutput "    ✓ Imports déjà corrects" "DarkGreen"
        }
        
    } catch {
        $errorMsg = "Erreur lors du traitement de $relativePath : $_"
        $errors += $errorMsg
        Write-ColorOutput "    ❌ $errorMsg" "Red"
    }
}

# Résumé
Write-ColorOutput "`n=================================================" "Cyan"
Write-ColorOutput "📊 RÉSUMÉ" "Cyan"
Write-ColorOutput "=================================================" "Cyan"

if ($DryRun) {
    Write-ColorOutput "Mode : DRY-RUN (simulation)" "Yellow"
    Write-ColorOutput "Fichiers à corriger : $totalFiles" "White"
} else {
    Write-ColorOutput "Mode : PRODUCTION (modifications appliquées)" "Green"
    Write-ColorOutput "Fichiers corrigés : $totalFixed" "White"
}

Write-ColorOutput "Fichiers analysés : $($testFiles.Count)" "White"

if ($errors.Count -gt 0) {
    Write-ColorOutput "`n❌ Erreurs rencontrées : $($errors.Count)" "Red"
    foreach ($err in $errors) {
        Write-ColorOutput "  - $err" "Red"
    }
    exit 1
}

if ($DryRun -and $totalFiles -gt 0) {
    Write-ColorOutput "`n💡 Pour appliquer les corrections, exécutez :" "Cyan"
    Write-ColorOutput "   .\scripts\fix-test-imports.ps1" "White"
} elseif (-not $DryRun -and $totalFixed -gt 0) {
    Write-ColorOutput "`n✅ Corrections appliquées avec succès !" "Green"
    Write-ColorOutput "💡 Prochaines étapes :" "Cyan"
    Write-ColorOutput "   1. Vérifier les changements : git diff" "White"
    Write-ColorOutput "   2. Lancer les tests : npm test" "White"
    Write-ColorOutput "   3. Commiter si OK : git add . && git commit" "White"
} else {
    Write-ColorOutput "`n✅ Tous les imports sont déjà corrects !" "Green"
}

Write-ColorOutput "" "White"