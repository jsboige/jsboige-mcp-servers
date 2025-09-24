# Script PowerShell pour validation finale jupyter-papermill
# Contourne les problemes d'encodage UTF-8 vs cp1252

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

Write-Host "VALIDATION FINALE SERVEUR JUPYTER-PAPERMILL" -ForegroundColor Green
Write-Host "Execution du test via conda run..." -ForegroundColor Yellow

# Utilisation de conda run directement
try {
    & C:\ProgramData\miniconda3\Scripts\conda.exe run -n mcp-jupyter-py310 python test_validation_finale.py
    $exitCode = $LASTEXITCODE
    
    if ($exitCode -eq 0) {
        Write-Host "VALIDATION REUSSIE" -ForegroundColor Green
    } elseif ($exitCode -eq 1) {
        Write-Host "VALIDATION PARTIELLE" -ForegroundColor Yellow
    } else {
        Write-Host "VALIDATION ECHOUEE" -ForegroundColor Red
    }
    
    exit $exitCode
    
} catch {
    Write-Host "ERREUR during validation: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}