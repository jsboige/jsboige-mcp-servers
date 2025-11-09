# Script Git Push - Apres commit Phase 1
# Date: 2025-10-15
# Objectif: Finaliser le push apres le commit c609b60

$ErrorActionPreference = "Stop"

Write-Host "`n=== GIT PUSH - FINALIZATION ===" -ForegroundColor Cyan

# Stasher les changements non commites
Write-Host "`n[1/4] Stash des changements non commites..." -ForegroundColor Yellow
git stash push -u -m "Temp stash before pull rebase - quickfiles and scripts"
Write-Host "[OK] Changements stashes" -ForegroundColor Green

# Pull avec rebase
Write-Host "`n[2/4] Pull avec rebase..." -ForegroundColor Yellow
git pull --rebase origin main

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Echec du pull rebase" -ForegroundColor Red
    Write-Host "Recuperation du stash..." -ForegroundColor Yellow
    git stash pop
    exit 1
}
Write-Host "[OK] Pull rebase reussi" -ForegroundColor Green

# Push
Write-Host "`n[3/4] Push vers origin..." -ForegroundColor Yellow
git push origin main

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Echec du push" -ForegroundColor Red
    Write-Host "Recuperation du stash..." -ForegroundColor Yellow
    git stash pop
    exit 1
}
Write-Host "[OK] Push reussi" -ForegroundColor Green

# Recuperer les changements stashes
Write-Host "`n[4/4] Recuperation du stash..." -ForegroundColor Yellow
git stash pop
Write-Host "[OK] Stash recupere" -ForegroundColor Green

# Afficher le commit hash
$commitHash = git rev-parse --short HEAD
Write-Host "`n=== RESUME ===" -ForegroundColor Cyan
Write-Host "Commit hash: $commitHash" -ForegroundColor White
Write-Host "Branch: main" -ForegroundColor White
Write-Host "Status: Synchronise avec origin/main" -ForegroundColor Green
Write-Host "`n[OK] Push finalise avec succes" -ForegroundColor Green