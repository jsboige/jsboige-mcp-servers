# Script PowerShell pour tester le regex corrigé
# Test sur la fixture contrôlée

$fixtureFile = ".\tests\fixtures\controlled-hierarchy\38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7\ui_messages.json"
$regexPattern = '"text":"(\{\\\"tool\\\":\\\"newTask\\\",\\\"mode\\\":\\\"([^\\\"]+)\\\",\\\"content\\\":\\\"([\\s\\S]*?)\\\",\\\"todos\\\":\\\[\\\][^}]*\})"'

Write-Host "🧪 TEST REGEX CORRECTION FINALE" -ForegroundColor Green
Write-Host "===============================" -ForegroundColor Green
Write-Host ""

if (Test-Path $fixtureFile) {
    $content = Get-Content $fixtureFile -Raw
    Write-Host "📁 Fichier trouvé: $($fixtureFile)" -ForegroundColor Cyan
    Write-Host "📏 Taille: $($content.Length) chars" -ForegroundColor Cyan
    
    # Test du regex corrigé
    $matches = [regex]::Matches($content, $regexPattern)
    Write-Host "🎯 Matches trouvés: $($matches.Count)" -ForegroundColor Yellow
    
    foreach ($match in $matches) {
        $mode = $match.Groups[2].Value
        $contentPreview = $match.Groups[3].Value.Substring(0, [Math]::Min(100, $match.Groups[3].Value.Length))
        Write-Host "  ✅ Mode: '$mode' - Contenu: '$contentPreview...'" -ForegroundColor Green
    }
    
    if ($matches.Count -gt 0) {
        Write-Host "🎉 SUCCÈS! Le regex corrigé fonctionne!" -ForegroundColor Green
    } else {
        Write-Host "❌ ÉCHEC! Le regex ne trouve aucun match." -ForegroundColor Red
        
        # Debug: chercher newTask dans le contenu brut
        $basicMatches = [regex]::Matches($content, '"tool":"newTask"')
        Write-Host "🔍 DEBUG: Occurrences 'newTask' trouvées: $($basicMatches.Count)" -ForegroundColor Yellow
        
        if ($basicMatches.Count -gt 0) {
            Write-Host "📋 Premier exemple trouvé:" -ForegroundColor Yellow
            $contextStart = [Math]::Max(0, $basicMatches[0].Index - 100)
            $contextEnd = [Math]::Min($content.Length, $basicMatches[0].Index + 500)
            $context = $content.Substring($contextStart, $contextEnd - $contextStart)
            Write-Host $context -ForegroundColor Cyan
        }
    }
}
else {
    Write-Host "❌ Fichier non trouvé: $fixtureFile" -ForegroundColor Red
}

Write-Host ""
Write-Host "🏁 Test terminé" -ForegroundColor Green