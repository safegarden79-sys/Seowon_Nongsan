@echo off
chcp 65001 >nul
title 서원농산 작업 체크 서버
cd /d "%~dp0"
echo 서버를 시작합니다. 이 창을 닫으면 서버가 꺼집니다.
echo 폰에서 접속할 주소:
ipconfig | findstr /C:"IPv4"
echo   → 위 주소 뒤에 :3000 을 붙여 접속하세요
echo.
:loop
node server.js
echo.
echo [서버가 멈췄습니다. 3초 뒤 다시 시작합니다]
timeout /t 3 >nul
goto loop
