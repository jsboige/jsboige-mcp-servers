# Version 1.1 of the Roo State Diagnostic Tool

# --- Configuration ---
$globalStoragePath = Join-Path $env:APPDATA "Code\User\globalStorage\rooveterinaryinc.roo-cline"
$tasksPath = Join-Path $globalStoragePath "tasks"
$essentialMetadataFiles = @("api_conversation_history.json", "task_metadata.json", "ui_messages.json")

# --- Initialization ---
$report = @{
    status = "OK"
    storagePath = $globalStoragePath
    vscdbStatus = "Not Analyzed"
    totalTasks = 0
    totalSizeMB = 0
    totalMetadataSizeMB = 0
    totalCheckpointsSizeMB = 0
    latestTasksAnalysis = @()
    issues = @()
}

# --- Main Logic ---

# 1. Check Storage Path Access
if (-not (Test-Path -Path $globalStoragePath)) {
    $report.status = "ERROR"
    $report.issues += "Storage path not found at $($globalStoragePath)."
    $report | ConvertTo-Json -Depth 5
    exit
}

# 2. totalTasks: Count total number of task directories
if (Test-Path -Path $tasksPath) {
    try {
        $taskDirectories = Get-ChildItem -Path $tasksPath -Directory -ErrorAction Stop
        $report.totalTasks = $taskDirectories.Count
    } catch {
        $report.status = "ERROR"
        $report.issues += "Failed to count task directories: $_"
        $report | ConvertTo-Json -Depth 5
        exit
    }
} else {
    $report.status = "WARNING"
    $report.issues += "Tasks directory not found at $($tasksPath). No tasks to analyze."
    $report | ConvertTo-Json -Depth 5
    exit
}

# 3. Analyze content of tasks directory (Size and Composition)
if ($report.totalTasks -gt 0) {
    $totalMetadataSizeBytes = 0
    $totalCheckpointsSizeBytes = 0

    foreach ($taskDir in $taskDirectories) {
        try {
            # Metadata size: sum of file sizes at the root of the task directory
            $metadataFiles = Get-ChildItem -Path $taskDir.FullName -File -ErrorAction Stop
            $totalMetadataSizeBytes += ($metadataFiles | Measure-Object -Property Length -Sum -ErrorAction Stop).Sum

            # Checkpoints size: sum of file sizes in the 'checkpoints' subdirectory
            $checkpointsPath = Join-Path $taskDir.FullName "checkpoints"
            if (Test-Path -Path $checkpointsPath) {
                $checkpointFiles = Get-ChildItem -Path $checkpointsPath -File -Recurse -Force -ErrorAction Stop
                $totalCheckpointsSizeBytes += ($checkpointFiles | Measure-Object -Property Length -Sum -ErrorAction Stop).Sum
            }
        } catch {
            $report.status = "WARNING"
            $report.issues += "Failed to analyze directory $($taskDir.FullName): $_"
        }
    }

    $report.totalMetadataSizeMB = [math]::Round($totalMetadataSizeBytes / 1MB, 2)
    $report.totalCheckpointsSizeMB = [math]::Round($totalCheckpointsSizeBytes / 1MB, 2)
    $report.totalSizeMB = $report.totalMetadataSizeMB + $report.totalCheckpointsSizeMB
}


# 4. In-depth analysis of the 10 most recent tasks
if ($report.totalTasks -gt 0) {
    $latestTasks = $taskDirectories | Sort-Object -Property LastWriteTime -Descending | Select-Object -First 10
    
    foreach ($task in $latestTasks) {
        $analysisResult = @{
            taskId = $task.Name
            isValid = $true
            missingFiles = @()
            metadataSizeMB = 0
            checkpointSizeMB = 0
        }

        # --- Size Calculation ---
        # Metadata size
        $metadataFiles = Get-ChildItem -Path $task.FullName -File -ErrorAction SilentlyContinue
        $taskMetadataBytes = ($metadataFiles | Measure-Object -Property Length -Sum).Sum
        $analysisResult.metadataSizeMB = [math]::Round($taskMetadataBytes / 1MB, 2)

        # Checkpoint size
        $checkpointsPath = Join-Path $task.FullName "checkpoints"
        if (Test-Path $checkpointsPath) {
            $checkpointFiles = Get-ChildItem -Path $checkpointsPath -File -Recurse -Force -ErrorAction SilentlyContinue
            $taskCheckpointBytes = ($checkpointFiles | Measure-Object -Property Length -Sum).Sum
            $analysisResult.checkpointSizeMB = [math]::Round($taskCheckpointBytes / 1MB, 2)
        }

        # --- Validation of essential files ---
        # This part of the validation logic is flawed because some tasks lack api_conversation_history.json and have api_history.json instead
        # However, the script is correct in categorizing files. For now, we accept this validation issue.
        $foundFiles = $metadataFiles | ForEach-Object { $_.Name }
        foreach ($expectedFile in $essentialMetadataFiles) {
            if ($foundFiles -notcontains $expectedFile) {
                # Let's check for the old name as a fallback for validation
                if ($expectedFile -eq "api_conversation_history.json" -and $foundFiles -contains "api_history.json") {
                    # This is an old task format, consider it valid for structure check.
                } else {
                    $analysisResult.isValid = $false
                    $analysisResult.missingFiles += $expectedFile
                }
            }
        }

        if (-not $analysisResult.isValid) {
            $report.status = "WARNING"
            $report.issues += "Task $($task.Name) is missing files: $($analysisResult.missingFiles -join ', ')."
        }

        $report.latestTasksAnalysis += $analysisResult
    }
}

# Final status check - if there are any issues but status is still OK, downgrade to WARNING
if ($report.issues.Count -gt 0 -and $report.status -eq "OK") {
    $report.status = "WARNING"
}

# --- Output ---
$report | ConvertTo-Json -Depth 5