@echo off
REM Wrapper pour sk-agent MCP - appelle le script PowerShell
powershell -ExecutionPolicy Bypass -File "%~dp0run-sk-agent.ps1"
