param(
    [switch]$Uninstall,
    [int]$Hour = $env:SCHEDULE_HOUR ? [int]$env:SCHEDULE_HOUR : 7,
    [int]$Minute = $env:SCHEDULE_MINUTE ? [int]$env:SCHEDULE_MINUTE : 0
)

$TaskName = "DailyInspiration"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

if ($Uninstall) {
    Write-Host "Uninstalling $TaskName scheduled task..."
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Uninstalled."
    } catch {
        Write-Host "Task not found or already removed."
    }
    exit 0
}

Write-Host "Installing $TaskName scheduled task..."

# Find npx
$NpxPath = (Get-Command npx -ErrorAction SilentlyContinue).Source
if (-not $NpxPath) {
    Write-Host "Error: npx not found. Please install Node.js first."
    exit 1
}

# Create the scheduled task action
$Action = New-ScheduledTaskAction `
    -Execute $NpxPath `
    -Argument "tsx src/index.ts" `
    -WorkingDirectory $ProjectDir

# Trigger daily at the configured time
$TriggerTime = "{0:D2}:{1:D2}AM" -f $Hour, $Minute
$Trigger = New-ScheduledTaskTrigger -Daily -At $TriggerTime

# Run whether user is logged in or not (with current user)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

# Register the task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Description "Generates and sets a daily inspirational quote wallpaper" `
    -Force

Write-Host "Installed scheduled task: $TaskName"
Write-Host ("The wallpaper will update daily at {0:D2}:{1:D2}." -f $Hour, $Minute)
Write-Host "To uninstall: powershell $PSCommandPath -Uninstall"
