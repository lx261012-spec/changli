@echo off
cd /d "%~dp0"
if not exist ".env" copy /y ".env.example" ".env" >nul
start "" notepad.exe "%~dp0.env"
