# Script Git Sync - Main Repository
# Date: 2025-10-15
# Objectif: Synchroniser le depot principal avec le sous-module

$ErrorActionPreference = "Stop"

Write-Host "`n=== GIT SYNC - MAIN REPOSITORY ===" -ForegroundColor Cyan

# Retourner au depot principal
Set-Location "d:/dev/roo-extensions"
Write-Host "[INFO] Working directory: $(Get-Location)" -ForegroundColor Gray

# Verifier le statut
Write-Host "`n[1/5] Verification du statut..." -ForegroundColor Yellow
git status --short

# Ajouter le sous-module
Write-Host "`n[2/5] Ajout du sous-module..." -ForegroundColor Yellow
git add mcps/internal/servers/roo-state-manager
Write-Host "[OK] Sous-module ajoute" -ForegroundColor Green

# Creer le message de commit
Write-Host "`n[3/5] Creation du commit..." -ForegroundColor Yellow
$commitMsgFile = "commit-msg-main-repo.txt"
"chore(submodules): sync roo-state-manager - phase 1 partial + docs" | Out-File -FilePath $commitMsgFile -Encoding UTF8
"" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Progress:" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- Tests: 372 to 379 of 478 tests" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- 7 tests fixed infrastructure" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- Documentation complete for phase 1" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- Ready for parser XML corrections" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Submodule commit: c609b60" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Refs: PHASE1_CORRECTIONS_PARTIAL_REPORT.md" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8

git commit -F $commitMsgFile
Remove-Item $commitMsgFile -ErrorAction SilentlyContinue
$commitHash = git rev-parse --short HEAD
Write-Host "[OK] Commit cree: $commitHash" -ForegroundColor Green

# Pull avec rebase
Write-Host "`n[4/5] Pull avec rebase..." -ForegroundColor Yellow
git pull --rebase origin main

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Echec du pull rebase" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Pull rebase reussi" -ForegroundColor Green

# Push
Write-Host "`n[5/5] Push vers origin..." -ForegroundColor Yellow
git push origin main

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Echec du push" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Push reussi" -ForegroundColor Green

# Resume
Write-Host "`n=== RESUME ===" -ForegroundColor Cyan
Write-Host "Main repo commit: $commitHash" -ForegroundColor White
Write-Host "Submodule commit: c609b60" -ForegroundColor White
Write-Host "Branch: main" -ForegroundColor White
Write-Host "Status: Synchronise avec origin/main" -ForegroundColor Green
Write-Host "`n[OK] Synchronisation principale terminee" -ForegroundColor Green