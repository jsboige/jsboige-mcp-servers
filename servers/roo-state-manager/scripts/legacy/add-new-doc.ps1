# 🆕 SCRIPT D'AJOUT NOUVEAU DOCUMENT
# ===================================
# Ajoute automatiquement un nouveau document selon la convention
# Usage: .\add-new-doc.ps1 -Type "RAPPORT" -Title "mission-validation-xyz"

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("RAPPORT", "DOC-TECH", "PHASE", "SUIVI", "PLAN", "SYNTH", "DEBUG")]
    [string]$Type,
    
    [Parameter(Mandatory=$true)]
    [string]$Title,
    
    [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
    [string]$CustomTemplate = "",
    [switch]$OpenAfterCreate = $false
)

$DocsPath = Join-Path $PSScriptRoot ".." "docs"
$ArchivesPath = Join-Path $DocsPath "archives"
$TemplatesPath = Join-Path $DocsPath "templates"

# Nettoyer le titre (kebab-case)
$CleanTitle = $Title.ToLower() -replace '[^a-z0-9\-]', '-' -replace '-+', '-'
$CleanTitle = $CleanTitle.Trim('-')

# Déterminer le mois d'archive
$DateParts = $Date -split '-'
$ArchiveMonth = "$($DateParts[0])-$($DateParts[1])"
$ArchiveDir = Join-Path $ArchivesPath $ArchiveMonth

# Créer le répertoire d'archive si nécessaire
if (-not (Test-Path $ArchiveDir)) {
    New-Item -Path $ArchiveDir -ItemType Directory -Force | Out-Null
    Write-Host "📁 Répertoire créé : archives/$ArchiveMonth" -ForegroundColor Green
}

# Déterminer le numéro séquentiel pour le jour
$ExistingFiles = Get-ChildItem $ArchiveDir -File | Where-Object { $_.BaseName -like "$Date-*" }
$NextSequence = ($ExistingFiles | ForEach-Object { 
    $parts = $_.BaseName -split '-'
    if ($parts.Length -ge 4) { [int]$parts[3] } else { 0 }
} | Measure-Object -Maximum).Maximum + 1

$SequenceStr = $NextSequence.ToString("00")

# Construire le nom du fichier
$FileName = "$Date-$SequenceStr-$Type-$CleanTitle.md"
$FilePath = Join-Path $ArchiveDir $FileName

# Sélectionner le template
$TemplateFile = switch ($Type) {
    "RAPPORT" { "rapport-template.md" }
    "DOC-TECH" { "doc-tech-template.md" }
    "PLAN" { "plan-template.md" }
    default { "rapport-template.md" }  # Fallback
}

if ($CustomTemplate -and (Test-Path (Join-Path $TemplatesPath $CustomTemplate))) {
    $TemplateFile = $CustomTemplate
}

$TemplatePath = Join-Path $TemplatesPath $TemplateFile

# Créer le fichier à partir du template
if (Test-Path $TemplatePath) {
    $templateContent = Get-Content $TemplatePath -Raw -Encoding UTF8
    
    # Remplacer les placeholders
    $templateContent = $templateContent -replace '\[TITRE_MISSION\]', $Title.ToUpper()
    $templateContent = $templateContent -replace 'YYYY-MM-DD', $Date
    $templateContent = $templateContent -replace '\[DATE\]', (Get-Date -Format "dd/MM/yyyy HH:mm")
    
    # Écrire le fichier
    Set-Content -Path $FilePath -Value $templateContent -Encoding UTF8
    Write-Host "✅ Document créé : $FileName" -ForegroundColor Green
} else {
    # Template basique si pas de template trouvé
    $basicContent = @"
# 📊 $Type - $($Title.ToUpper())

**Date :** $Date  
**Type :** $Type  
**Statut :** ⏳ EN COURS

---

## 🎯 OBJECTIF

[Description de l'objectif]

## 📋 CONTEXTE

[Contexte et problématique]

## 🔬 ACTIONS

### 1. Action 1
[Détails]

### 2. Action 2
[Détails]

## 📊 RÉSULTATS

[Résultats et conclusions]

---
*Document généré automatiquement le $(Get-Date -Format "dd/MM/yyyy HH:mm")*
"@
    
    Set-Content -Path $FilePath -Value $basicContent -Encoding UTF8
    Write-Host "✅ Document créé avec template basique : $FileName" -ForegroundColor Yellow
}

# Afficher les informations
Write-Host "`n📋 INFORMATIONS DU DOCUMENT:" -ForegroundColor Cyan
Write-Host "  • Nom : $FileName"
Write-Host "  • Chemin : archives/$ArchiveMonth/$FileName"
Write-Host "  • Type : $Type"
Write-Host "  • Séquence : $SequenceStr (pour le $Date)"
Write-Host "  • Template : $TemplateFile"

# Mise à jour automatique de l'index
$IndexPath = Join-Path $DocsPath "active" "INDEX-DOCUMENTATION.md"
if (Test-Path $IndexPath) {
    Write-Host "`n🔄 Mise à jour de l'index..." -ForegroundColor Yellow
    # Ici on pourrait ajouter la logique de mise à jour de l'index
    # Pour l'instant, on indique juste qu'une mise à jour manuelle est recommandée
    Write-Host "  ⚠️ Mise à jour manuelle de l'INDEX-DOCUMENTATION.md recommandée"
}

# Ouvrir le fichier dans l'éditeur si demandé
if ($OpenAfterCreate -and (Get-Command "code" -ErrorAction SilentlyContinue)) {
    Start-Process "code" -ArgumentList $FilePath
    Write-Host "🚀 Fichier ouvert dans VS Code" -ForegroundColor Green
}

Write-Host "`n🎯 PROCHAINES ÉTAPES:" -ForegroundColor Magenta
Write-Host "  1. Éditer le document : archives/$ArchiveMonth/$FileName"
Write-Host "  2. Mettre à jour l'INDEX-DOCUMENTATION.md"
Write-Host "  3. Commiter les changements"

Write-Host "`n✅ Opération terminée !" -ForegroundColor Green