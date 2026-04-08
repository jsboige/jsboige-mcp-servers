#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Complete the lazy-load conversion for registry.ts (Issue #1140)

.DESCRIPTION
    This script converts ALL remaining toolExports.* references in registry.ts
    to use dynamic imports. This completes the lazy-loading refactor started
    in the initial PR.

.NOTES
    Run this from the roo-state-manager directory:
    pwsh scripts/complete-lazy-load-conversion.ps1
#>

$ErrorActionPreference = 'Stop'
$registryPath = "src/tools/registry.ts"

if (!(Test-Path $registryPath)) {
    Write-Error "registry.ts not found. Run this script from roo-state-manager directory."
    exit 1
}

Write-Host "Reading registry.ts..."
$content = Get-Content $registryPath -Raw

# Define all remaining conversions: function name -> import path
$conversions = @(
    @{ Func = 'roosyncGetDecisionDetails'; Path = './roosync/get-decision-details.js' }
    @{ Func = 'roosyncApproveDecision'; Path = './roosync/approve-decision.js' }
    @{ Func = 'roosyncRejectDecision'; Path = './roosync/reject-decision.js' }
    @{ Func = 'roosyncApplyDecision'; Path = './roosync/apply-decision.js' }
    @{ Func = 'roosyncRollbackDecision'; Path = './roosync/rollback-decision.js' }
    @{ Func = 'roosyncInit'; Path = './roosync/init.js' }
    @{ Func = 'roosyncUpdateBaseline'; Path = './roosync/baseline.js' }
    @{ Func = 'roosync_manage_baseline'; Path = './roosync/baseline.js' }
    @{ Func = 'roosyncDiagnose'; Path = './roosync/diagnose.js' }
    @{ Func = 'roosyncCollectConfig'; Path = './roosync/config.js' }
    @{ Func = 'roosyncPublishConfig'; Path = './roosync/config.js' }
    @{ Func = 'roosyncApplyConfig'; Path = './roosync/apply-config.js' }
    @{ Func = 'roosyncDecision'; Path = './roosync/decision.js' }
    @{ Func = 'roosyncDecisionInfo'; Path = './roosync/decision-info.js' }
    @{ Func = 'roosync_baseline'; Path = './roosync/baseline.js' }
    @{ Func = 'roosyncConfig'; Path = './roosync/config.js' }
    @{ Func = 'inventoryTool'; Path = './roosync/inventory.js'; Pattern = 'const invResult = await toolExports.inventoryTool.execute'; Replacement = 'const { inventoryTool } = await import(''./roosync/inventory.js'');{NL}                  const invResult = await inventoryTool.execute' }
    @{ Func = 'roosyncMachines'; Path = './roosync/machines.js'; Pattern = 'const machResult = await toolExports.roosyncMachines'; Replacement = 'const { roosyncMachines } = await import(''./roosync/machines.js'');{NL}                  const machResult = await roosyncMachines' }
    @{ Func = 'roosyncHeartbeat'; Path = './roosync/heartbeat.js'; Pattern = 'const heartbeatResult = await toolExports.roosyncHeartbeat'; Replacement = 'const { roosyncHeartbeat } = await import(''./roosync/heartbeat.js'');{NL}                  const heartbeatResult = await roosyncHeartbeat' }
    @{ Func = 'roosyncSend'; Path = './roosync/messaging/send.js'; Pattern = 'result = await toolExports.roosyncSend'; Replacement = 'const { roosyncSend } = await import(''./roosync/messaging/send.js'');{NL}                   result = await roosyncSend' }
    @{ Func = 'roosyncRead'; Path = './roosync/messaging/read.js'; Pattern = 'result = await toolExports.roosyncRead'; Replacement = 'const { roosyncRead } = await import(''./roosync/messaging/read.js'');{NL}                   result = await roosyncRead' }
    @{ Func = 'roosyncManage'; Path = './roosync/messaging/manage.js'; Pattern = 'result = await toolExports.roosyncManage'; Replacement = 'const { roosyncManage } = await import(''./roosync/messaging/manage.js'');{NL}                   result = await roosyncManage' }
    @{ Func = 'cleanupMessages'; Path = './roosync/messaging/cleanup-messages.js'; Pattern = 'result = await toolExports.cleanupMessages'; Replacement = 'const { cleanupMessages } = await import(''./roosync/messaging/cleanup-messages.js'');{NL}                   result = await cleanupMessages' }
    @{ Func = 'roosyncAttachments'; Path = './roosync/attachments/attachments.js'; Pattern = 'result = await toolExports.roosyncAttachments'; Replacement = 'const { roosyncAttachments } = await import(''./roosync/attachments/attachments.js'');{NL}                   result = await roosyncAttachments' }
    @{ Func = 'roosyncListAttachments'; Path = './roosync/attachments/list-attachments.js'; Pattern = 'result = await toolExports.roosyncListAttachments'; Replacement = 'const { roosyncListAttachments } = await import(''./roosync/attachments/list-attachments.js'');{NL}                   result = await roosyncListAttachments' }
    @{ Func = 'roosyncGetAttachment'; Path = './roosync/attachments/get-attachment.js'; Pattern = 'result = await toolExports.roosyncGetAttachment'; Replacement = 'const { roosyncGetAttachment } = await import(''./roosync/attachments/get-attachment.js'');{NL}                   result = await roosyncGetAttachment' }
    @{ Func = 'roosyncDeleteAttachment'; Path = './roosync/attachments/delete-attachment.js'; Pattern = 'result = await toolExports.roosyncDeleteAttachment'; Replacement = 'const { roosyncDeleteAttachment } = await import(''./roosync/attachments/delete-attachment.js'');{NL}                   result = await roosyncDeleteAttachment' }
    @{ Func = 'getMachineInventoryTool'; Path = './roosync/inventory.js'; Pattern = 'const invResult = await toolExports.getMachineInventoryTool.execute'; Replacement = 'const { getMachineInventoryTool } = await import(''./roosync/inventory.js'');{NL}                       const invResult = await getMachineInventoryTool.execute' }
    @{ Func = 'roosyncRefreshDashboard'; Path = './roosync/refresh-dashboard.js' }
    @{ Func = 'roosyncUpdateDashboard'; Path = './roosync/update-dashboard.js' }
    @{ Func = 'roosyncDashboard'; Path = './roosync/dashboard.js'; Pattern = 'const dashboardResult = await toolExports.roosyncDashboard'; Replacement = 'const { roosyncDashboard } = await import(''./roosync/dashboard.js'');{NL}                   const dashboardResult = await roosyncDashboard' }
    @{ Func = 'roosyncSyncEvent'; Path = './roosync/sync-event.js'; Pattern = 'const syncEventResult = await toolExports.roosyncSyncEvent'; Replacement = 'const { roosyncSyncEvent } = await import(''./roosync/sync-event.js'');{NL}                   const syncEventResult = await roosyncSyncEvent' }
    @{ Func = 'roosyncMcpManagement'; Path = './roosync/mcp-management.js'; Pattern = 'const mcpManagementResult = await toolExports.roosyncMcpManagement'; Replacement = 'const { roosyncMcpManagement } = await import(''./roosync/mcp-management.js'');{NL}                   const mcpManagementResult = await roosyncMcpManagement' }
    @{ Func = 'roosyncStorageManagement'; Path = './roosync/storage-management.js'; Pattern = 'const storageManagementResult = await toolExports.roosyncStorageManagement'; Replacement = 'const { roosyncStorageManagement } = await import(''./roosync/storage-management.js'');{NL}                   const storageManagementResult = await roosyncStorageManagement' }
)

$changeCount = 0

foreach ($conv in $conversions) {
    $func = $conv.Func
    $path = $conv.Path

    # Use custom pattern if provided, otherwise use default
    if ($conv.Pattern -and $conv.Replacement) {
        $pattern = $conv.Pattern
        $replacement = $conv.Replacement -replace '\{NL\}', "`n"
    } else {
        # Default pattern for standard roosyncResult cases
        $pattern = "const roosyncResult = await toolExports\.$func\(args as any\);"
        $replacement = "const { $func } = await import('$path');`n                  const roosyncResult = await $func(args as any);"
    }

    if ($content -match [regex]::Escape($pattern)) {
        Write-Host "  Converting $func..."
        $content = $content -replace [regex]::Escape($pattern), $replacement
        $changeCount++
    }
}

# Save with UTF-8 no-BOM
[System.IO.File]::WriteAllText((Resolve-Path $registryPath), $content, [System.Text.UTF8Encoding]::new($false))

Write-Host "`n✓ Conversion complete: $changeCount functions converted"
Write-Host "`nChecking for remaining toolExports references..."
$remaining = Select-String -Path $registryPath -Pattern "toolExports\."
if ($remaining) {
    Write-Host "WARNING: Found $($remaining.Count) remaining references:`n"
    $remaining | ForEach-Object { Write-Host "  Line $($_.LineNumber): $($_.Line.Trim())" }
    Write-Host "`nThese may need manual conversion or are expected (e.g., in comments)."
} else {
    Write-Host "✓ No remaining toolExports references found!`n"
}

Write-Host "Run 'npm run build' and 'npx vitest run' to verify."
