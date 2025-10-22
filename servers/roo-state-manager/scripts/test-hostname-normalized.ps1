# Test Hostname Normalization
# ===========================
# Vérifie le hostname OS et sa version normalisée
# pour confirmer le comportement de getLocalMachineId()

Write-Host "`n🔍 Test Normalisation Hostname OS`n" -ForegroundColor Cyan

# Obtenir hostname brut
$hostname = hostname
Write-Host "Hostname brut (OS)     : $hostname" -ForegroundColor White

# Simuler la normalisation JavaScript : toLowerCase() + replace(/[^a-z0-9-]/g, '-')
$normalized = $hostname.ToLower() -replace '[^a-z0-9-]', '-'
Write-Host "Hostname normalisé     : $normalized" -ForegroundColor Green

# Afficher la fonction utilisée dans le code
Write-Host "`n📝 Fonction utilisée dans le code TypeScript :" -ForegroundColor Yellow
Write-Host "function getLocalMachineId(): string {" -ForegroundColor Gray
Write-Host "  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');" -ForegroundColor Gray
Write-Host "}" -ForegroundColor Gray

Write-Host "`n✅ Résultat attendu pour machineId : $normalized`n" -ForegroundColor Green