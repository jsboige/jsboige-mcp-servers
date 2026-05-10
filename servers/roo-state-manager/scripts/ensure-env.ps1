#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Ensure .env exists for roo-state-manager — restores from .env.template if missing,
    detects placeholder values, validates required keys.

.DESCRIPTION
    Issue #2089 — Protects .env from being lost after `git submodule update --init --recursive`
    or other agressive git operations. Idempotent: safe to run repeatedly.

    Behaviour:
    - If .env missing AND .env.template exists: copies template -> .env, warns user.
    - If .env exists: validates all keys from template are present, adds missing keys.
    - Detects __FILL_ME__ placeholders and warns user to fill them.

.EXAMPLE
    pwsh ./scripts/ensure-env.ps1
    pwsh ./scripts/ensure-env.ps1 -Quiet

.NOTES
    Run from mcps/internal/servers/roo-state-manager/ directory.
    Exit codes: 0 = OK, 1 = missing template, 2 = placeholders detected
#>
[CmdletBinding()]
param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rsmDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $rsmDir '.env'
$templateFile = Join-Path $rsmDir '.env.template'

function Write-Info {
    param([string]$Message)
    if (-not $Quiet) { Write-Host "[ensure-env] $Message" -ForegroundColor Cyan }
}

function Write-Warning2 {
    param([string]$Message)
    Write-Host "[ensure-env] WARN: $Message" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host "[ensure-env] ERROR: $Message" -ForegroundColor Red
}

if (-not (Test-Path $templateFile)) {
    Write-Err ".env.template missing at $templateFile — cannot validate or restore .env"
    exit 1
}

function Read-EnvKeys {
    param([string]$Path)
    $keys = @()
    foreach ($line in (Get-Content $Path -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if ($trimmed -and -not $trimmed.StartsWith('#') -and $trimmed.Contains('=')) {
            $key = $trimmed.Split('=', 2)[0].Trim()
            if ($key) { $keys += $key }
        }
    }
    return $keys
}

$templateKeys = Read-EnvKeys -Path $templateFile

if (-not (Test-Path $envFile)) {
    Write-Warning2 ".env missing — restoring from .env.template"
    Copy-Item -Path $templateFile -Destination $envFile -Force
    Write-Warning2 "Restored .env contains __FILL_ME__ placeholders for secrets:"
    foreach ($line in (Get-Content $envFile)) {
        if ($line -match '^([^#=]+)=__FILL_ME__') {
            Write-Warning2 "  - $($matches[1].Trim())"
        }
    }
    Write-Warning2 "Edit .env and replace __FILL_ME__ with real values before starting MCP server."
    exit 2
}

# .env exists — validate keys
$envKeys = Read-EnvKeys -Path $envFile
$missingKeys = $templateKeys | Where-Object { $_ -notin $envKeys }

if ($missingKeys.Count -gt 0) {
    Write-Warning2 "$($missingKeys.Count) keys missing from .env (present in template):"
    foreach ($key in $missingKeys) {
        Write-Warning2 "  - $key"
    }
    Write-Warning2 "Appending missing keys from template (with placeholders)..."
    $appendLines = @('', "# === Added by ensure-env.ps1 on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') ===")
    foreach ($key in $missingKeys) {
        $templateLine = (Get-Content $templateFile) | Where-Object { $_ -match "^$([regex]::Escape($key))=" } | Select-Object -First 1
        if ($templateLine) { $appendLines += $templateLine }
    }
    Add-Content -Path $envFile -Value $appendLines -Encoding UTF8
    Write-Warning2 "Missing keys appended. Edit .env to fill placeholders."
}

# Detect placeholders
$placeholderKeys = @()
foreach ($line in (Get-Content $envFile)) {
    if ($line -match '^([^#=]+)=__FILL_ME__') {
        $placeholderKeys += $matches[1].Trim()
    }
}

if ($placeholderKeys.Count -gt 0) {
    Write-Warning2 "$($placeholderKeys.Count) keys still contain __FILL_ME__ placeholders:"
    foreach ($key in $placeholderKeys) {
        Write-Warning2 "  - $key"
    }
    exit 2
}

Write-Info ".env OK — all $($templateKeys.Count) keys present, no placeholders detected."
exit 0
