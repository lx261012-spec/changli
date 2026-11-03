@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" --test test\*.test.mjs
) else (
  node --test test\*.test.mjs
)
pause
