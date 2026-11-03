param([ValidateSet('Snapshot','Attach','Probe','Inspect')][string]$Mode='Snapshot',[string]$WindowHandle='0',[int]$ParentPid=0,[int]$X=0,[int]$Y=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  $framework=[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-host.cs') -Raw -Encoding UTF8) -ReferencedAssemblies (Join-Path $framework 'Accessibility.dll')
  if($Mode -eq 'Inspect') { [DesktopHost]::Inspect([long]::Parse($WindowHandle)) }
  elseif($Mode -eq 'Probe') { [DesktopHost]::Probe($X,$Y) }
  elseif($Mode -eq 'Snapshot') { @{wallpaper=[DesktopHost]::Wallpaper()} | ConvertTo-Json -Compress }
  else { [DesktopHost]::Run([long]::Parse($WindowHandle),$ParentPid) }
} catch {
  @{type='native-error';message=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}
