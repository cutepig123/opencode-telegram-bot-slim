@echo off
setlocal
rem Machine O (bot host): starts the Telegram bot in the foreground.
rem Double-click or run from a terminal; Ctrl+C stops it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-bot.ps1" run %*
endlocal
