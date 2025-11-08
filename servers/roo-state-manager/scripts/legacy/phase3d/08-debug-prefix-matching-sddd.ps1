# Script SDDD Phase 3D - Diagnostic du Prefix Matching dans Reconstruction Hiérarchique
# Mission : Diagnostiquer et corriger les problèmes de prefix matching en suivant SDDD

param(
    [string]$TestPattern = "should reconstruct 100% of parent-child relationships",
    [switch]$Verbose = $false
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Configuration SDDD
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogDir = "scripts/phase3d/logs"
$OutputDir = "scripts/phase3d/output"

# Créer les répertoires
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$LogFile = "$LogDir/prefix-matching-debug-$Timestamp.log"
$ReportFile = "$OutputDir/prefix-matching-diagnostic-$Timestamp.md"

# Fonction de logging SDDD
function Write-SdddLog {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogEntry = "[$Timestamp] [$Level] SDDD: $Message"
    Write-Host $LogEntry -ForegroundColor $(switch($Level) { "ERROR" {"Red"} "WARN" {"Yellow"} "SUCCESS" {"Green"} default {"White"} })
    Add-Content -Path $LogFile -Value $LogEntry
}

# Fonction principale
function Main {
    Write-SdddLog "🚀 DÉBUT MISSION SDDD - Diagnostic Prefix Matching" "SUCCESS"
    Write-SdddLog "Target : $TestPattern"
    Write-SdddLog "Workspace : $((Get-Location).Path)"
    
    try {
        # Phase 1 : Exécution du test avec debug SDDD
        Write-SdddLog "🔍 PHASE 1 : Exécution du test avec ROO_DEBUG_INSTRUCTIONS=1" "INFO"
        
        $Env:ROO_DEBUG_INSTRUCTIONS = "1"
        $Env:ROO_DEBUG_HIERARCHY = "1"
        
        $TestCommand = "cd mcps/internal/servers/roo-state-manager; npm test -- --run --reporter=verbose --grep `"$TestPattern`""
        Write-SdddLog "Commande : $TestCommand"
        
        $TestOutput = powershell -c "$TestCommand" 2>&1
        $TestExitCode = $LASTEXITCODE
        
        Write-SdddLog "Test exit code : $TestExitCode"
        
        # Sauvegarder la sortie brute
        $RawOutputFile = "$OutputDir/test-raw-output-$Timestamp.txt"
        $TestOutput | Out-File -FilePath $RawOutputFile -Encoding UTF8
        Write-SdddLog "Sortie brute sauvegardée : $RawOutputFile"
        
        # Phase 2 : Analyse des logs SDDD
        Write-SdddLog "🔍 PHASE 2 : Analyse des logs SDDD" "INFO"
        
        $SdddLogs = $TestOutput | Where-Object { $_ -match "\[EXACT PREFIX SEARCH\]|\[SDDD\]|\[STRICT MODE\]" }
        
        if ($SdddLogs) {
            Write-SdddLog "Trouvé $($SdddLogs.Count) lignes de logs SDDD"
            
            # Extraire les informations clés
            $PrefixSearches = $SdddLogs | Where-Object { $_ -match "\[EXACT PREFIX SEARCH\]" }
            $SdddMessages = $SdddLogs | Where-Object { $_ -match "\[SDDD\]" }
            $StrictModeMessages = $SdddLogs | Where-Object { $_ -match "\[STRICT MODE\]" }
            
            Write-SdddLog "Analyses : $($PrefixSearches.Count) recherches de préfixe, $($SdddMessages.Count) messages SDDD, $($StrictModeMessages.Count) messages strict mode"
            
            # Phase 3 : Diagnostic du mismatch
            Write-SdddLog "🔍 PHASE 3 : Diagnostic du mismatch prefix/instruction" "INFO"
            
            $MismatchPatterns = @()
            $NoMatchPatterns = @()
            
            foreach ($Line in $PrefixSearches) {
                if ($Line -match "No match found for any prefix length") {
                    $NoMatchPatterns += $Line
                }
                if ($Line -match "Starting search with full prefix") {
                    if ($Line -match '"([^"]+)"') {
                        $FullPrefix = $matches[1]
                        Write-SdddLog "Full prefix analysé : $FullPrefix"
                    }
                }
            }
            
            Write-SdddLog "Diagnostic : $($NoMatchPatterns.Count) patterns sans correspondance"
            
            # Phase 4 : Génération du rapport
            Write-SdddLog "🔍 PHASE 4 : Génération du rapport SDDD" "INFO"
            
            $Rapport = @"
# Rapport de Diagnostic SDDD - Prefix Matching

**Mission** : Diagnostic et correction des problèmes de prefix matching dans la reconstruction hiérarchique  
**Timestamp** : $Timestamp  
**Test Cible** : $TestPattern  
**Exit Code** : $TestExitCode  

## 📊 Résultats de l'Analyse

### Logs SDDD Collectés
- **Total lignes SDDD** : $($SdddLogs.Count)
- **Recherches de préfixe** : $($PrefixSearches.Count)
- **Messages SDDD** : $($SdddMessages.Count)
- **Messages Strict Mode** : $($StrictModeMessages.Count)

### Patterns de Mismatch Identifiés
- **Patterns sans correspondance** : $($NoMatchPatterns.Count)

## 🔍 Logs SDDD Détaillés

### Recherche de Préfixes
```
$($PrefixSearches -join "`n")
```

### Messages SDDD
```
$($SdddMessages -join "`n")
```

### Messages Strict Mode
```
$($StrictModeMessages -join "`n")
```

## 📋 Analyse Technique

### Problème Identifié
Basé sur les logs, le problème principal semble être :
$(
    if ($NoMatchPatterns.Count -gt 0) {
        "Les préfixes indexés ne correspondent pas aux instructions des enfants lors de la recherche `searchExactPrefix`."
    } else {
        "Problème non identifié clairement dans les logs - nécessite investigation plus approfondie."
    }
)

### Prochaines Étapes SDDD
1. **Analyser le format exact** des préfixes indexés vs instructions recherchées
2. **Vérifier la logique de normalisation** dans `computeInstructionPrefix`
3. **Examiner le RadixTree** pour comprendre les préfixes stockés
4. **Proposer une correction** basée sur l'analyse

## 📁 Fichiers Générés
- **Logs bruts** : `$RawOutputFile`
- **Ce rapport** : `$ReportFile`
- **Log de session** : `$LogFile`

---
*Rapport généré par SDDD Phase 3D - Diagnostic Prefix Matching*
"@
            
            $Rapport | Out-File -FilePath $ReportFile -Encoding UTF8
            Write-SdddLog "Rapport SDDD généré : $ReportFile" "SUCCESS"
            
        } else {
            Write-SdddLog "Aucun log SDDD trouvé dans la sortie du test" "WARN"
        }
        
        # Phase 5 : Recommandations
        Write-SdddLog "🔍 PHASE 5 : Recommandations SDDD" "INFO"
        
        if ($TestExitCode -ne 0) {
            Write-SdddLog "❌ TEST EN ÉCHEC - Le problème est confirmé" "ERROR"
            Write-SdddLog "Recommandation : Analyser les logs SDDD pour identifier la cause racine"
        } else {
            Write-SdddLog "✅ TEST RÉUSSI - Le problème pourrait être résolu" "SUCCESS"
        }
        
    } catch {
        Write-SdddLog "ERREUR CRITIQUE : $($_.Exception.Message)" "ERROR"
        Write-SdddLog "Stack trace : $($_.ScriptStackTrace)" "ERROR"
        throw
    } finally {
        # Nettoyage variables d'environnement
        Remove-Item Env:ROO_DEBUG_INSTRUCTIONS -ErrorAction SilentlyContinue
        Remove-Item Env:ROO_DEBUG_HIERARCHY -ErrorAction SilentlyContinue
    }
    
    Write-SdddLog "🎯 FIN MISSION SDDD - Diagnostic Prefix Matching" "SUCCESS"
}

# Exécution principale
try {
    Main
    Write-Host "`n🎯 Mission SDDD terminée avec succès !" -ForegroundColor Green
    Write-Host "📁 Consultez les rapports dans : $OutputDir" -ForegroundColor Cyan
    Write-Host "📋 Logs de session : $LogFile" -ForegroundColor Cyan
} catch {
    Write-Host "`n❌ Erreur critique dans la mission SDDD" -ForegroundColor Red
    Write-Host "📋 Logs : $LogFile" -ForegroundColor Yellow
    exit 1
}