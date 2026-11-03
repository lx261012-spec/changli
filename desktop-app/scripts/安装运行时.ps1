$ErrorActionPreference='Stop'
$appRoot=Split-Path -Parent $PSScriptRoot
$runtimeRoot=Join-Path $appRoot 'runtime'
if(Test-Path -LiteralPath (Join-Path $runtimeRoot 'electron.exe')) { Write-Host '运行时已包含，可直接启动长离。'; exit 0 }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$archivePath=Join-Path $runtimeRoot 'electron-v43.3.0-win32-x64.zip'
$expected='18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9'
Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v43.3.0/electron-v43.3.0-win32-x64.zip' -OutFile $archivePath -UseBasicParsing
if((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw '官方运行时校验失败，保留下载文件供检查，未安装。' }
Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot
Write-Host 'Electron运行时已核验并解压。'
