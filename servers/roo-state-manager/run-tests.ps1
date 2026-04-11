$outputFile = "vitest-results.txt"
npx vitest run --maxWorkers=1 > $outputFile 2>&1
$exitCode = $LASTEXITCODE
Write-Host "Exit Code: $exitCode"
Get-Content $outputFile -Tail 30
exit $exitCode
