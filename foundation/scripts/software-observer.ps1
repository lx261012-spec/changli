param([string]$MatchNamesJson = '[]')
$ErrorActionPreference = 'Stop'
$matchNames = @($MatchNamesJson | ConvertFrom-Json)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundSoftware {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
while ($true) {
  $foregroundProcessId = [uint32]0
  $handle = [ForegroundSoftware]::GetForegroundWindow()
  [void][ForegroundSoftware]::GetWindowThreadProcessId($handle, [ref]$foregroundProcessId)
  $all = @(Get-Process)
  $foreground = ($all | Where-Object Id -EQ $foregroundProcessId | Select-Object -First 1).ProcessName
  $records = @($all | Where-Object { $_.ProcessName -in $matchNames } | ForEach-Object {
    $exePath = ''
    try { $exePath = [string]$_.Path } catch {}
    @{ id = $_.Id; path = $exePath }
  })
  @{ foreground = [string]$foreground; foregroundId = $foregroundProcessId; running = @($all.ProcessName | Sort-Object -Unique); processes = $records } | ConvertTo-Json -Depth 4 -Compress
  Start-Sleep -Seconds 5
}
