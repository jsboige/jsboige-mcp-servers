# ============================================================================
# SCRIPT DE VALIDATION - CORRECTION PREFIX MATCHING
# Phase 3D - Étape 2.5 : Validation de la correction
# ============================================================================

# Configuration
$ErrorActionPreference = "Stop"
$env:ROO_DEBUG_INSTRUCTIONS = "1"  # Activer les logs SDDD

# Timestamp pour les logs
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = "output/validation-correction-$timestamp.log"

Write-Host "🔍 DÉBUT VALIDATION CORRECTION - Phase 3D.2.5" -ForegroundColor Cyan
Write-Host "Timestamp : $timestamp" -ForegroundColor Gray
Write-Host "Fichier log : $logFile" -ForegroundColor Gray
Write-Host ""

# Créer le répertoire de sortie si nécessaire
if (-not (Test-Path "output")) {
    New-Item -ItemType Directory -Path "output" | Out-Null
}

# Démarrer le logging
Start-Transcript -Path "output/$logFile" -Force

try {
    Write-Host "📊 ÉTAPE 1 : Validation du test cible" -ForegroundColor Yellow
    Write-Host "Test : 'should reconstruct 100% of parent-child relationships'" -ForegroundColor Gray
    Write-Host ""
    
    # Exécuter le test spécifique avec logs détaillés
    Write-Host "🧪 Exécution du test avec debug SDDD..." -ForegroundColor Green
    
    $testCommand = "npm test -- --testNamePattern='should reconstruct 100% of parent-child relationships' --verbose"
    
    Write-Host "Commande : $testCommand" -ForegroundColor Gray
    Write-Host ""
    
    # Exécuter dans le contexte du MCP roo-state-manager
    Set-Location "mcps/internal/servers/roo-state-manager"
    
    $testResult = Invoke-Expression $testCommand
    
    Write-Host ""
    Write-Host "📈 RÉSULTATS DU TEST :" -ForegroundColor Magenta
    Write-Host $testResult -ForegroundColor White
    Write-Host ""
    
    # Analyser les résultats
    if ($testResult -match "PASS.*should reconstruct 100%") {
        Write-Host "✅ SUCCÈS : Le test passe !" -ForegroundColor Green
        Write-Host "🎯 Taux de reconstruction : 100% (attendu)" -ForegroundColor Green
    } elseif ($testResult -match "FAIL.*should reconstruct 100%") {
        Write-Host "❌ ÉCHEC : Le test échoue encore" -ForegroundColor Red
        Write-Host "🔍 Analyse supplémentaire nécessaire" -ForegroundColor Yellow
    } else {
        Write-Host "⚠️ RÉSULTAT INCERTAIN : Vérification manuelle requise" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "📊 ÉTAPE 2 : Analyse des métriques de reconstruction" -ForegroundColor Yellow
    
    # Rechercher les métriques dans les logs
    $metricsRegex = "Taux de reconstruction\s*:\s*(\d+)%"
    if ($testResult -match $metricsRegex) {
        $reconstructionRate = $matches[1]
        Write-Host "📈 Taux de reconstruction détecté : $reconstructionRate%" -ForegroundColor Cyan
        
        if ($reconstructionRate -eq "100") {
            Write-Host "🏆 PERFORMANCE OPTIMALE !" -ForegroundColor Green
        } elseif ($reconstructionRate -gt "80") {
            Write-Host "🟢 BONNE PERFORMANCE" -ForegroundColor Green
        } elseif ($reconstructionRate -gt "50") {
            Write-Host "🟡 PERFORMANCE PARTIELLE" -ForegroundColor Yellow
        } else {
            Write-Host "🔴 PERFORMANCE INSUFFISANTE" -ForegroundColor Red
        }
    } else {
        Write-Host "⚠️ Métriques de reconstruction non trouvées dans les logs" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "📊 ÉTAPE 3 : Validation des logs SDDD" -ForegroundColor Yellow
    
    # Vérifier la présence des logs SDDD
    if ($testResult -match "SDDD:") {
        Write-Host "✅ Logs SDDD présents dans la sortie" -ForegroundColor Green
        
        # Compter les occurrences SDDD
        $sdddCount = ([regex]::Matches($testResult, "SDDD:")).Count
        Write-Host "📝 Nombre de logs SDDD : $sdddCount" -ForegroundColor Cyan
    } else {
        Write-Host "⚠️ Logs SDDD non détectés" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "📊 ÉTAPE 4 : Génération du rapport de validation" -ForegroundColor Yellow
    
    # Créer le rapport de validation
    $rapportValidation = @"
# 🔍 RAPPORT DE VALIDATION - Correction Prefix Matching

**Date :** $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")  
**Phase :** 3D.2.5 Validation de la correction  
**Test :** should reconstruct 100% of parent-child relationships  
**Status :** $(if ($testResult -match "PASS.*should reconstruct 100%") { "✅ SUCCÈS" } else { "❌ ÉCHEC" })

---

## 📊 Résultats du Test

```
$testResult
```

---

## 🎯 Métriques Clés

- **Taux de reconstruction** : $(if ($testResult -match $metricsRegex) { $matches[1] + "%" } else { "Non détecté" })
- **Logs SDDD** : $sdddCount occurrences
- **Status global** : $(if ($testResult -match "PASS.*should reconstruct 100%") { "SUCCÈS" } else { "ÉCHEC" })

---

## 🔍 Analyse Technique

### Correction Appliquée
- **Fichier :** `src/utils/task-instruction-index.ts`
- **Fonction :** `computeInstructionPrefix`
- **Changement :** Préservation de l'instruction parent complète pour indexation

### Impact Attendu
- **Avant :** 0% taux de reconstruction (mismatch indexation/recherche)
- **Après :** 95%+ taux de reconstruction (alignement des données)

---

## 🏆 Conclusion

$(if ($testResult -match "PASS.*should reconstruct 100%") { 
    "✅ La correction du prefix matching est VALIDÉE avec SUCCÈS !`nLe système reconstruction hiérarchique est de nouveau opérationnel." 
} else { 
    "❌ La correction nécessite des ajustements supplémentaires.`nAnalyse approfondie requise des logs d'échec." 
})

---

*Rapport généré automatiquement - Phase 3D SDDD*
"@
    
    # Sauvegarder le rapport
    $rapportPath = "output/rapport-validation-$timestamp.md"
    $rapportValidation | Out-File -FilePath $rapportPath -Encoding UTF8
    Write-Host "📄 Rapport sauvegardé : $rapportPath" -ForegroundColor Green
    
} catch {
    Write-Host "❌ ERREUR lors de la validation :" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor Gray
} finally {
    # Arrêter le logging
    Stop-Transcript
    
    Write-Host ""
    Write-Host "🏁 FIN VALIDATION CORRECTION" -ForegroundColor Cyan
    Write-Host "Log complet : output/$logFile" -ForegroundColor Gray
    Write-Host "Rapport : output/rapport-validation-$timestamp.md" -ForegroundColor Gray
}