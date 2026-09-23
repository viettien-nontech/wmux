# Close wmux gracefully, rebuild ~/wmux-app from this checkout, relaunch it.
# Runs detached (outside wmux's process tree), because closing wmux kills
# every pane - including the one that started this. Log: %TEMP%\wmux-repack.log
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'wmux-repack.log'
function Say($s) { "$(Get-Date -Format 'HH:mm:ss') $s" | Tee-Object -FilePath $log -Append }
"" | Set-Content $log
Say 'start - waiting 15s so the pane that launched this can finish its reply'
Start-Sleep 15

# Graceful close: the same as clicking the window's X, so the session is saved.
Get-Process wmux -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } |
  ForEach-Object { Say "closing window of pid $($_.Id)"; [void]$_.CloseMainWindow() }
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Process wmux -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
if (Get-Process wmux -ErrorAction SilentlyContinue) {
  Say 'ABORT: wmux still running after 60s (a confirm dialog?). Nothing was packaged. Close wmux yourself, then run: npm run package:app'
  exit 1
}
Say 'wmux closed'

Set-Location (Split-Path $PSScriptRoot -Parent)
Say 'npm run package:app ...'
npm run package:app *>> $log
if ($LASTEXITCODE -ne 0) { Say "PACKAGE FAILED (exit $LASTEXITCODE) - relaunching the old app anyway" }

$asar = Join-Path $env:USERPROFILE 'wmux-app\resources\app.asar'
$hits = (Select-String -Path $asar -Pattern 'wmux/cdp-state' -SimpleMatch -AllMatches -ErrorAction SilentlyContinue | Measure-Object).Count
Say "check: app.asar lines with 'wmux/cdp-state' = $hits (0 means the fork build is NOT in place)"

Start-Process (Join-Path $env:USERPROFILE 'wmux-app\wmux.exe')
Say 'relaunched wmux'
