<#
.SYNOPSIS
    Restaure le fichier .env depuis .env.template si le .env est manquant ou vide.
.DESCRIPTION
    Ce script est appele automatiquement apres un git submodule update ou git pull
    pour s'assurer que le fichier .env existe toujours avec les bonnes valeurs.
    Il ne modifie JAMAIS les valeurs existantes — il ne fait que restaurer les
    placeholders si le .env est absent ou vide.
.EXAMPLE
    .\scripts\restore-env.ps1
.EXAMPLE
    .\scripts\restore-env.ps1 -Force
.NOTES
    Version: 1.0.0
    Issue: #2089
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [switch]$Force,

    [Parameter(Mandatory = $false)]
    [string]$EnvPath = "$PSScriptRoot\..\\.env",

    [Parameter(Mandatory = $false)]
    [string]$TemplatePath = "$PSScriptRoot\..\\.env.template"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    Write-Host "[$timestamp] [$Level] $Message"
}

# Verifier que le template existe
if (-not (Test-Path $TemplatePath)) {
    Write-Log "Template .env.template introuvable: $TemplatePath" "WARN"
    exit 1
}

# Verifier que le .env existe
if (Test-Path $EnvPath) {
    $content = Get-Content $EnvPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($content)) {
        Write-Log ".env existe deja et n'est pas vide — aucune action necessaire." "OK"
        exit 0
    }
    Write-Log ".env existe mais est vide — restauration depuis template." "WARN"
} else {
    Write-Log ".env introuvable — creation depuis template." "INFO"
}

# Creer le .env a partir du template
Copy-Item $TemplatePath $EnvPath -Force
Write-Log ".env restaure depuis .env.template" "OK"

# Verifier et remplacer les placeholders non-definis
$placeholders = @("CHANGE_ME_MACHINE_ID", "CHANGE_ME_SHARED_PATH", "CHANGE_ME_MEDIUM_KEY", "CHANGE_ME_MINI_KEY", "CHANGE_ME_EMBEDDING_KEY", "CHANGE_ME_QDRANT_KEY")
$missing = @()

foreach ($placeholder in $placeholders) {
    if (Select-String -Path $EnvPath -Pattern $placeholder -Quiet) {
        $missing += $placeholder
    }
}

if ($missing.Count -gt 0) {
    Write-Log "Placeholders non-remplaces detectes: $($missing -join ', ')" "WARN"
    Write-Log "Veuillez remplir les valeurs manquantes dans $EnvPath" "WARN"
} else {
    Write-Log "Tous les placeholders ont ete remplaces." "OK"
}

Write-Log "Restauration terminee." "OK"
