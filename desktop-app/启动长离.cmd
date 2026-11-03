@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "scripts\start.cjs" %*
) else (
  node "scripts\start.cjs" %*
)
