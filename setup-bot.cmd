@echo off
setlocal
rem Setup and control for the OpenCode Telegram Bot built from source.
rem Usage: setup-bot.cmd [install^|run^|start^|stop^|status^|config^|clean] [options]
rem Options: -OpenCodeUrl^|-BrowserRoots^|-TelegramApiRoot^|-CaCert^|-Locale^|-EnvFile
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-bot.ps1" %*
endlocal
