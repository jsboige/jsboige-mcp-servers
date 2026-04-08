#!/usr/bin/env pwsh
# Script to convert remaining toolExports references to dynamic imports in registry.ts
# Issue #1140: Lazy-load tools to reduce MCP startup time

$registryPath = Join-Path $PSScriptRoot "..\src\tools\registry.ts"
$content = Get-Content $registryPath -Raw

# Define mappings of function names to their import paths
$imports = @{
    'roosyncGetDecisionDetails' = './roosync/decision-info.js'
    'roosyncApproveDecision' = './roosync/decision.js'
    'roosyncRejectDecision' = './roosync/decision.js'
    'roosyncApplyDecision' = './roosync/decision.js'
    'roosyncRollbackDecision' = './roosync/decision.js'
    'roosyncInit' = './roosync/init.js'
    'roosyncUpdateBaseline' = './roosync/baseline.js'
    'roosync_manage_baseline' = './roosync/baseline.js'
    'roosyncDiagnose' = './roosync/diagnose.js'
    'roosync_baseline' = './roosync/baseline.js'
    'roosyncDecision' = './roosync/decision.js'
    'roosyncDecisionInfo' = './roosync/decision-info.js'
    'roosyncConfig' = './roosync/config.js'
    'inventoryTool' = './roosync/inventory.js'
    'roosyncMachines' = './roosync/machines.js'
    'roosyncHeartbeat' = './roosync/heartbeat.js'
    'roosyncSend' = './roosync/messaging/send.js'
    'roosyncRead' = './roosync/messaging/read.js'
    'roosyncManage' = './roosync/messaging/manage.js'
    'cleanupMessages' = './roosync/messaging/cleanup-messages.js'
    'roosyncAttachments' = './roosync/attachments/attachments.js'
    'roosyncListAttachments' = './roosync/attachments/list-attachments.js'
    'roosyncGetAttachment' = './roosync/attachments/get-attachment.js'
    'roosyncDeleteAttachment' = './roosync/attachments/delete-attachment.js'
    'getMachineInventoryTool' = './roosync/inventory.js'
    'roosyncRefreshDashboard' = './roosync/refresh-dashboard.js'
    'roosyncUpdateDashboard' = './roosync/update-dashboard.js'
    'roosyncDashboard' = './roosync/dashboard.js'
    'roosyncSyncEvent' = './roosync/sync-event.js'
    'roosyncMcpManagement' = './roosync/mcp-management.js'
    'roosyncStorageManagement' = './roosync/storage-management.js'
    'roosyncCollectConfig' = './roosync/config.js'
    'roosyncPublishConfig' = './roosync/config.js'
    'roosyncApplyConfig' = './roosync/apply-config.js'
}

# Pattern to match: toolExports.functionName(
foreach ($func in $imports.Keys) {
    $path = $imports[$func]

    # Match patterns like: const roosyncResult = await toolExports.functionName(args)
    $pattern = "const roosyncResult = await toolExports\.$func\(args as any\);"
    $replacement = "const { $func } = await import('$path');`n                  const roosyncResult = await $func(args as any);"
    $content = $content -replace [regex]::Escape($pattern), $replacement

    # Match patterns like: result = await toolExports.functionName.execute(args)
    $pattern2 = "const invResult = await toolExports\.$func\.execute\(args as any, \{\} as any\);"
    $replacement2 = "const { $func } = await import('$path');`n                  const invResult = await $func.execute(args as any, {} as any);"
    $content = $content -replace [regex]::Escape($pattern2), $replacement2

    # Match patterns like: result = await toolExports.functionName(args) as CallToolResult
    $pattern3 = "result = await toolExports\.$func\(args as any\) as CallToolResult;"
    $replacement3 = "const { $func } = await import('$path');`n                   result = await $func(args as any) as CallToolResult;"
    $content = $content -replace [regex]::Escape($pattern3), $replacement3

    # Match patterns without assignment
    $pattern4 = "const machResult = await toolExports\.$func\(args as any\);"
    $replacement4 = "const { $func } = await import('$path');`n                  const machResult = await $func(args as any);"
    $content = $content -replace [regex]::Escape($pattern4), $replacement4
}

# Save the result
[System.IO.File]::WriteAllText($registryPath, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host "Conversion complete. Remaining toolExports references:"
Select-String -Path $registryPath -Pattern "toolExports\." | ForEach-Object {
    Write-Host "  Line $($_.LineNumber): $($_.Line.Trim())"
}
