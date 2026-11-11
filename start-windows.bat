@echo off
rem Double-click to start the overlay on Windows. Quit from the tray icon (right click).
rem   start-windows.bat              primary screen
rem   start-windows.bat -Screen 1    second screen
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0overlay\win-overlay.ps1" %*
if errorlevel 1 pause
