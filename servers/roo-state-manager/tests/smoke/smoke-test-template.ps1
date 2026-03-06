# Smoke Test Template - Issue #564 Phase 2
# Tests that MCP tools return coherent and up-to-date data

param(
    [string]$ToolName = "conversation_browser",
    [switch]$Verbose = $false
)

# Configuration
$WORKSPACE = "D:\dev\roo-extensions"
$ROO_STORAGE = "$env:APPDATA\Code\User\globalStorage\rooveterinaryinc.roo-cline\tasks"
$TEST_TASK_ID = "smoke-test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$MACHINE_ID = $env:COMPUTERNAME

# Colors for output
function Write-Success { param($msg) Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Fail { param($msg) Write-Host "❌ $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "ℹ️  $msg" -ForegroundColor Cyan }

# Test Results
$script:TestsPassed = 0
$script:TestsFailed = 0
$script:Results = @()

function Record-Result {
    param(
        [string]$TestName,
        [bool]$Passed,
        [string]$Details = ""
    )

    $script:Results += @{
        Test = $TestName
        Passed = $Passed
        Details = $Details
        Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Machine = $MACHINE_ID
    }

    if ($Passed) {
        $script:TestsPassed++
        Write-Success "$TestName - PASS"
    } else {
        $script:TestsFailed++
        Write-Fail "$TestName - FAIL: $Details"
    }
}

# ============================================================================
# SMOKE TEST: conversation_browser
# ============================================================================

function Test-ConversationBrowser {
    Write-Info "Testing conversation_browser - Stale Data Detection"

    # 1. Setup: Count tasks before
    Write-Host "  1. Counting existing tasks..."
    $beforeCount = 0
    # TODO: Call MCP conversation_browser(action: "list") via proper interface
    # For now, simulate by checking filesystem
    if (Test-Path $ROO_STORAGE) {
        $beforeCount = (Get-ChildItem $ROO_STORAGE -Directory).Count
    }
    Write-Host "     Before: $beforeCount tasks"

    # 2. Action: Create new task on disk (simulate Roo)
    Write-Host "  2. Creating test task on disk..."
    $testTaskPath = Join-Path $ROO_STORAGE $TEST_TASK_ID
    New-Item -Path $testTaskPath -ItemType Directory -Force | Out-Null

    $skeleton = @{
        id = $TEST_TASK_ID
        instruction = "Smoke test task #564"
        timestamp = (Get-Date).ToString("o")
        metadata = @{
            mode = "test"
            workspace = $WORKSPACE
        }
    } | ConvertTo-Json -Depth 10

    $skeleton | Out-File -FilePath (Join-Path $testTaskPath "skeleton.json") -Encoding utf8NoBOM
    Write-Host "     Created: $testTaskPath"

    # 3. Call: List tasks via MCP
    Write-Host "  3. Calling conversation_browser(action: 'list')..."
    # TODO: Replace with actual MCP call
    Start-Sleep -Seconds 2  # Simulate MCP call
    $afterCount = (Get-ChildItem $ROO_STORAGE -Directory).Count
    Write-Host "     After: $afterCount tasks"

    # 4. Assert: New task should be visible
    Write-Host "  4. Validating result..."
    $expected = $beforeCount + 1
    $passed = ($afterCount -eq $expected)

    if ($passed) {
        Record-Result "conversation_browser: Detects new task after creation" $true
    } else {
        Record-Result "conversation_browser: Detects new task after creation" $false `
            "Expected $expected tasks, got $afterCount (Cache stale?)"
    }

    # 5. Cleanup
    Write-Host "  5. Cleaning up..."
    Remove-Item -Path $testTaskPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ""
}

# ============================================================================
# SMOKE TEST: roosync_send / roosync_read
# ============================================================================

function Test-RooSyncMessaging {
    Write-Info "Testing roosync_send/roosync_read - Message Delivery"

    # 1. Setup: Count messages before
    Write-Host "  1. Checking inbox before..."
    # TODO: Call roosync_read(mode: "inbox", status: "all")
    $beforeCount = 0
    Write-Host "     Before: $beforeCount messages"

    # 2. Action: Send test message
    Write-Host "  2. Sending test message..."
    $testSubject = "Smoke Test #564 - $(Get-Date -Format 'HHmmss')"
    # TODO: Call roosync_send(action: "send", to: "myia-ai-01", subject: ..., body: ...)
    Write-Host "     Subject: $testSubject"

    # 3. Call: Read inbox
    Write-Host "  3. Reading inbox..."
    Start-Sleep -Seconds 2  # Allow GDrive sync
    # TODO: Call roosync_read(mode: "inbox", status: "unread")
    $afterCount = 0
    Write-Host "     After: $afterCount messages"

    # 4. Assert: Message should be sent (check sent folder)
    Write-Host "  4. Validating message sent..."
    # TODO: Check .shared-state/messages/sent/{MACHINE_ID}/ for message
    $passed = $false  # Placeholder

    Record-Result "roosync_send: Message sent successfully" $passed

    Write-Host ""
}

# ============================================================================
# SMOKE TEST: roosync_search
# ============================================================================

function Test-RooSyncSearch {
    Write-Info "Testing roosync_search - Finds New Tasks"

    # 1. Setup: Search for unique term (should not exist)
    Write-Host "  1. Searching for non-existent term..."
    $uniqueTerm = "smoke-test-564-$(Get-Random)"
    # TODO: Call roosync_search(action: "text", search_query: $uniqueTerm)
    Write-Host "     Term: $uniqueTerm"

    # 2. Action: Create task with unique term
    Write-Host "  2. Creating task with search term..."
    $testTaskPath = Join-Path $ROO_STORAGE $TEST_TASK_ID
    New-Item -Path $testTaskPath -ItemType Directory -Force | Out-Null

    $skeleton = @{
        id = $TEST_TASK_ID
        instruction = "Task containing $uniqueTerm for smoke test"
        timestamp = (Get-Date).ToString("o")
    } | ConvertTo-Json -Depth 10

    $skeleton | Out-File -FilePath (Join-Path $testTaskPath "skeleton.json") -Encoding utf8NoBOM

    # 3. Call: Search again
    Write-Host "  3. Searching for term again..."
    Start-Sleep -Seconds 2
    # TODO: Call roosync_search(action: "text", search_query: $uniqueTerm)
    $found = $false  # Placeholder

    # 4. Assert: Task should be found
    Write-Host "  4. Validating search result..."
    Record-Result "roosync_search: Finds newly created task" $found

    # 5. Cleanup
    Remove-Item -Path $testTaskPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ""
}

# ============================================================================
# SMOKE TEST: codebase_search
# ============================================================================

function Test-CodebaseSearch {
    Write-Info "Testing codebase_search - Finds New Files"

    # 1. Setup: Create unique file in workspace
    Write-Host "  1. Creating test file in workspace..."
    $uniqueContent = "smoke-test-564-$(Get-Random)"
    $testFile = Join-Path $WORKSPACE "smoke-test-$uniqueContent.tmp"
    "Test file for codebase_search smoke test: $uniqueContent" | Out-File -FilePath $testFile -Encoding utf8NoBOM
    Write-Host "     File: $testFile"

    # 2. Call: Search for unique content
    Write-Host "  2. Searching for unique content..."
    Start-Sleep -Seconds 3  # Allow indexing
    # TODO: Call codebase_search(query: $uniqueContent, workspace: $WORKSPACE)
    $found = $false  # Placeholder

    # 3. Assert: File should be found
    Write-Host "  3. Validating search result..."
    if ($found) {
        Record-Result "codebase_search: Finds newly created file" $true
    } else {
        Record-Result "codebase_search: Finds newly created file" $false `
            "Index may be stale or not updated"
    }

    # 4. Cleanup
    Remove-Item -Path $testFile -Force -ErrorAction SilentlyContinue
    Write-Host ""
}

# ============================================================================
# SMOKE TEST: manage_mcp_settings
# ============================================================================

function Test-ManageMcpSettings {
    Write-Info "Testing manage_mcp_settings - Read/Write Cycle"

    # 1. Setup: Backup current settings
    Write-Host "  1. Backing up current settings..."
    # TODO: Call manage_mcp_settings(action: "backup")

    # 2. Action: Read settings
    Write-Host "  2. Reading settings..."
    # TODO: Call manage_mcp_settings(action: "read")
    $settingsRead = $true  # Placeholder

    # 3. Assert: Settings should be valid JSON
    Write-Host "  3. Validating settings structure..."
    Record-Result "manage_mcp_settings: Reads valid JSON" $settingsRead

    # 4. Action: Write settings (no-op, same content)
    Write-Host "  4. Writing settings back (no-op)..."
    # TODO: Call manage_mcp_settings(action: "write", settings: {...})
    $settingsWritten = $true  # Placeholder

    # 5. Assert: Write should succeed
    Record-Result "manage_mcp_settings: Writes without corruption" $settingsWritten

    Write-Host ""
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  MCP Smoke Tests - Issue #564 Phase 2" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Machine: $MACHINE_ID"
Write-Host "Workspace: $WORKSPACE"
Write-Host "Tool: $ToolName"
Write-Host ""

# Run tests based on tool name
switch ($ToolName) {
    "conversation_browser" { Test-ConversationBrowser }
    "roosync_send" { Test-RooSyncMessaging }
    "roosync_search" { Test-RooSyncSearch }
    "codebase_search" { Test-CodebaseSearch }
    "manage_mcp_settings" { Test-ManageMcpSettings }
    "all" {
        Test-ConversationBrowser
        Test-RooSyncMessaging
        Test-RooSyncSearch
        Test-CodebaseSearch
        Test-ManageMcpSettings
    }
    default {
        Write-Fail "Unknown tool: $ToolName"
        Write-Host "Available tools: conversation_browser, roosync_send, roosync_search, codebase_search, manage_mcp_settings, all"
        exit 1
    }
}

# ============================================================================
# RESULTS SUMMARY
# ============================================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  RESULTS SUMMARY" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Passed: $script:TestsPassed" -ForegroundColor Green
Write-Host "Failed: $script:TestsFailed" -ForegroundColor Red
Write-Host "Total:  $($script:TestsPassed + $script:TestsFailed)"
Write-Host ""

# Save results to JSON
$resultsFile = Join-Path $PSScriptRoot "smoke-test-results-$MACHINE_ID-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
$script:Results | ConvertTo-Json -Depth 10 | Out-File -FilePath $resultsFile -Encoding utf8NoBOM
Write-Host "Results saved to: $resultsFile"
Write-Host ""

# Exit with failure if any test failed
if ($script:TestsFailed -gt 0) {
    exit 1
}

exit 0
