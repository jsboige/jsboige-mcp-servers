# PowerShell script to analyze encoding-helpers coverage
cd "D:/dev/roo-extensions/.claude/worktrees/wt-worker-myia-po-2025-20260405-172150/mcps/internal/servers/roo-state-manager"

# Read the coverage-final.json
$coverageFile = "coverage/coverage-final.json"

if (Test-Path $coverageFile) {
    Write-Host "Analyzing coverage from $coverageFile..."

    # Read the coverage data
    $coverageData = Get-Content $coverageFile | ConvertFrom-Json

    # Find encoding-helpers.ts coverage data
    $encodingHelpersCoverage = $null

    if ($coverageData.coverageMap) {
        foreach ($filePath in $coverageData.coverageMap.PSObject.Properties.Name) {
            if ($filePath -like "*encoding-helpers*") {
                $encodingHelpersCoverage = $coverageData.coverageMap[$filePath]
                break
            }
        }
    }

    if ($encodingHelpersCoverage) {
        Write-Host ""
        Write-Host "=== ENCODING-HELPERS COVERAGE ANALYSIS ==="
        Write-Host "File: $filePath"
        Write-Host ""

        # Analyze line coverage
        $totalLines = 0
        $coveredLines = 0

        if ($encodingHelpersCoverage.lines) {
            foreach ($lineNum in $encodingHelpersCoverage.lines.PSObject.Properties.Name) {
                $lineStatus = $encodingHelpersCoverage.lines[$lineNum]
                $totalLines++
                if ($lineStatus -eq 1) {
                    $coveredLines++
                }
            }
        }

        $coveragePercent = if ($totalLines -gt 0) { [math]::Round(($coveredLines / $totalLines) * 100, 2) } else { 0 }

        Write-Host "Lines covered: $coveredLines / $totalLines"
        Write-Host "Line coverage: $coveragePercent%"
        Write-Host ""

        # Show function coverage
        if ($encodingHelpersCoverage.functions) {
            $totalFunctions = 0
            $coveredFunctions = 0

            foreach ($funcName in $encodingHelpersCoverage.functions.PSObject.Properties.Name) {
                $funcStatus = $encodingHelpersCoverage.functions[$funcName]
                $totalFunctions++
                if ($funcStatus -eq 1) {
                    $coveredFunctions++
                }
            }

            $functionPercent = if ($totalFunctions -gt 0) { [math]::Round(($coveredFunctions / $totalFunctions) * 100, 2) } else { 0 }

            Write-Host "Functions covered: $coveredFunctions / $totalFunctions"
            Write-Host "Function coverage: $functionPercent%"
        }

        Write-Host "=========================================="
    } else {
        Write-Host "No coverage data found for encoding-helpers.ts"
    }

    # Also check the summary from lcov.info
    Write-Host ""
    Write-Host "=== SUMMARY FROM LCOV.INFO ==="
    if (Test-Path "coverage/lcov.info") {
        $coveredLines = 0
        $totalLines = 0

        Get-Content "coverage/lcov.info" | ForEach-Object {
            if ($_ -like "SF:*") {
                $currentFile = $_
            } elseif ($_ -like "DA:*") {
                $parts = $_ -split ','
                if ($parts[2] -eq "1") {
                    $coveredLines++
                }
                $totalLines++
            }
        }

        $coveragePercent = if ($totalLines -gt 0) { [math]::Round(($coveredLines / $totalLines) * 100, 2) } else { 0 }

        Write-Host "Total project lines covered: $coveredLines / $totalLines"
        Write-Host "Total project coverage: $coveragePercent%"
    } else {
        Write-Host "No lcov.info file found"
    }
} else {
    Write-Host "Coverage file not found: $coverageFile"
}