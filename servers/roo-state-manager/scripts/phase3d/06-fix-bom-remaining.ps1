# SDDD Phase 3D: Fix BOM Remaining
# Approche: Single Direction, Deterministic, Debuggable

Write-Host "=== SDDD PHASE 3D: FIX BOM REMAINING ==="
Write-Host "Approche: Single Direction, Deterministic, Debuggable"

$paths = @(
    "tests/unit/utils/fixtures/controlled-hierarchy",
    "tests/integration/fixtures/controlled-hierarchy"
)

$totalFixed = 0

foreach ($path in $paths) {
    if (Test-Path $path) {
        Write-Host "SDDD: Traitement de $path..."
        
        $files = Get-ChildItem -Path $path -Recurse -Filter "*.json"
        
        foreach ($file in $files) {
            Write-Host "SDDD: Vérification de $($file.FullName)..."
            
            # Lire le contenu en bytes pour détecter le BOM
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            
            # Vérifier si le fichier commence par UTF-8 BOM (EF BB BF)
            if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
                Write-Host "SDDD: BOM détecté - Correction de $($file.Name)"
                
                # Lire le contenu sans le BOM
                $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.UTF8Encoding]::new($false))
                
                # Réécrire sans BOM
                [System.IO.File]::WriteAllText($file.FullName, $content, [System.Text.UTF8Encoding]::new($false))
                
                $totalFixed++
                Write-Host "SDDD: BOM corrigé pour $($file.Name)"
            } else {
                Write-Host "SDDD: Pas de BOM pour $($file.Name)"
            }
        }
    } else {
        Write-Host "SDDD: Chemin $path inexistant"
    }
}

Write-Host "=== RAPPORT SDDD ==="
Write-Host "Fichiers corrigés: $totalFixed"
Write-Host "✅ SDDD: Tous les BOM restants ont été corrigés"