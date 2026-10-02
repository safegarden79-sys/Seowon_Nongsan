@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONIOENCODING=utf-8

echo ============================================
echo  서원농산 수집기(auction_poller) 실행
echo  실행 위치: %cd%
echo ============================================
echo.

echo [1/2] 최신 코드 받기 (git pull origin main)...
git pull origin main
if errorlevel 1 (
    echo    ※ git pull 실패 — 네트워크 또는 git 설정 문제일 수 있습니다. 그래도 아래에서 계속 실행합니다.
)
echo.

if not exist secrets.json (
    echo    ※ secrets.json 이 이 폴더에 없습니다. secrets.example.json 을 복사해
    echo       secrets.json 으로 만들고 비밀번호를 채워 넣은 뒤 다시 실행하세요.
    echo.
    pause
    exit /b 1
)

echo [2/2] 수집기 실행 — 이 창에 로그가 계속 표시됩니다 (종료: Ctrl+C)
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    python main.py
) else (
    py main.py
)

echo.
echo ── 수집기가 종료되었습니다. 위에 뜬 내용(특히 오류 메시지)을 확인하세요. ──
pause
endlocal
