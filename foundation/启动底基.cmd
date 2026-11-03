@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "scripts\launch.mjs"
) else (
  node "scripts\launch.mjs"
)
pause
