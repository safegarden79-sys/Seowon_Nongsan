@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONIOENCODING=utf-8

echo ============================================
echo  Seowon Nongsan Collector (auction_poller)
echo  Running from: %cd%
echo ============================================
echo.

echo [1/2] Pulling latest code (git pull origin main)...
git pull origin main
if errorlevel 1 (
    echo    WARNING: git pull failed - network or git config issue. Continuing anyway.
)
echo.

if not exist "secrets.json" (
    echo    secrets.json was not found in this folder.
    echo    Copy secrets.example.json to secrets.json, fill in the passwords, then run this again.
    echo.
    pause
    exit /b 1
)

echo [2/2] Starting the collector - the log will keep showing below. Press Ctrl+C to stop.
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    python main.py
) else (
    py main.py
)

echo.
echo Collector stopped. Check the messages above, especially any error lines.
pause
endlocal
