@echo off
setlocal
rem Starts the bot as a background daemon and detaches.
rem Stop it with: setup-bot.cmd stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-bot.ps1" start %*
endlocal
