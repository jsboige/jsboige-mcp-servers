# Script Git Workflow - Phase 1 Partial Commit
# Date: 2025-10-15
# Objectif: Commiter les modifications Phase 1 partielle + corrections

$ErrorActionPreference = "Stop"

Write-Host "`n=== GIT WORKFLOW - PHASE 1 PARTIAL ===" -ForegroundColor Cyan

# Etape 1: Mise a jour .gitignore
Write-Host "`n[1/6] Mise a jour .gitignore..." -ForegroundColor Yellow
$gitignoreContent = @"
# Dependencies
/node_modules/

# Build artifacts
/build/

# Cache and temporary files
.cache/

# Environment variables (contains secrets)
.env

# Logs
*.log

# Test results
test-results.json

# Debug outputs
mcp-debugging/

# Reports and documentation
/*.md
!README.md
!CHANGELOG.md
!REFACTORING*.md
!VALIDATION*.md
!BATCH*.md
!GIT_SYNC*.md
!PROJECT_FINAL_SYNTHESIS.md
!PHASE*.md
!NEXT_SESSION*.md
!TEST_FAILURES*.md
!FUNCTIONAL_REDUNDANCY*.md

# Reports
/*-report.md
/*-validation.md
!docs/**/*-validation.md

# Vitest migration
vitest-migration/
"@
Set-Content -Path ".gitignore" -Value $gitignoreContent -Encoding UTF8
Write-Host "[OK] .gitignore mis a jour" -ForegroundColor Green

# Etape 2: Verifier les fichiers apres exclusion
Write-Host "`n[2/6] Verification des fichiers a commiter..." -ForegroundColor Yellow
git status --porcelain
$filesCount = (git status --porcelain).Count
Write-Host "[OK] Fichiers a commiter: $filesCount" -ForegroundColor Green

# Etape 3: Ajout selectif des fichiers
Write-Host "`n[3/6] Ajout des fichiers pertinents..." -ForegroundColor Yellow
git add .gitignore
git add src/tools/task/export-tree-md.tool.ts
git add src/tools/task/get-tree.tool.ts

# Ajouter les documentations de la Phase 1
$docsToAdd = @(
    "PHASE1_CORRECTIONS_PARTIAL_REPORT.md",
    "NEXT_SESSION_PLAN.md",
    "PROJECT_FINAL_SYNTHESIS.md",
    "TEST_FAILURES_ROOT_CAUSES.md",
    "FUNCTIONAL_REDUNDANCY_ANALYSIS.md",
    "BATCH10_DEAD_CODE_REMOVAL_REPORT.md"
)

foreach ($doc in $docsToAdd) {
    if (Test-Path $doc) {
        git add $doc
        Write-Host "  + $doc" -ForegroundColor Gray
    } else {
        Write-Host "  - $doc (non trouve)" -ForegroundColor DarkGray
    }
}

Write-Host "[OK] Fichiers ajoutes au staging" -ForegroundColor Green

# Etape 4: Afficher ce qui va etre commite
Write-Host "`n[4/6] Fichiers dans le staging:" -ForegroundColor Yellow
git status --short

# Etape 5: Commit
Write-Host "`n[5/6] Creation du commit..." -ForegroundColor Yellow

# Creer le fichier de message directement
$commitMsgFile = "commit-msg-temp.txt"
"fix(tests): phase 1 partial - 7 tests + documentation" | Out-File -FilePath $commitMsgFile -Encoding UTF8
"" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Corrections completed:" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- hierarchy-reconstruction-engine imports 4 tests" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- unstable_mockModule to vi.mock 3 tests" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Documentation:" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- PHASE1_CORRECTIONS_PARTIAL_REPORT.md" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- NEXT_SESSION_PLAN.md" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- PROJECT_FINAL_SYNTHESIS.md updated" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- TEST_FAILURES_ROOT_CAUSES.md" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- FUNCTIONAL_REDUNDANCY_ANALYSIS.md" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"- BATCH10_DEAD_CODE_REMOVAL_REPORT.md" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Progress: 372 to 379 of 478 tests" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Remaining: Parser XML 13 tests" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8
"Status: Ready for Phase 1 completion" | Out-File -FilePath $commitMsgFile -Append -Encoding UTF8

git commit -F $commitMsgFile
Remove-Item $commitMsgFile -ErrorAction SilentlyContinue
$commitHash = git rev-parse --short HEAD
Write-Host "[OK] Commit cree: $commitHash" -ForegroundColor Green

# Etape 6: Pull avec rebase
Write-Host "`n[6/6] Synchronisation avec origin..." -ForegroundColor Yellow
Write-Host "  Pull avec rebase..." -ForegroundColor Gray
git pull --rebase origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Pull rebase reussi" -ForegroundColor Green
    
    # Push
    Write-Host "  Push vers origin..." -ForegroundColor Gray
    git push origin main
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Push reussi" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Erreur lors du push" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[ERROR] Conflits lors du pull rebase - resolution manuelle necessaire" -ForegroundColor Red
    exit 1
}

# Resume final
Write-Host "`n=== RESUME ===" -ForegroundColor Cyan
Write-Host "Commit hash: $commitHash" -ForegroundColor White
Write-Host "Branch: main" -ForegroundColor White
Write-Host "Status: Synchronise avec origin/main" -ForegroundColor Green
Write-Host "`n[OK] Workflow Git termine avec succes" -ForegroundColor Green