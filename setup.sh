#!/usr/bin/env bash
# 서원농산 작업 체크 — 24시간 상시 구동 설치
# 사용법:  sudo bash setup.sh
# 하는 일: systemd 서비스로 등록해 부팅 시 자동 시작, 죽으면 자동 재시작.

set -e
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=seowon
PORT="${PORT:-3000}"

echo "설치 위치 : $APP_DIR"

# 1) Node 확인
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 없습니다. 설치합니다..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "Node.js 를 직접 설치한 뒤 다시 실행해 주세요: https://nodejs.org"
    exit 1
  fi
fi
echo "Node : $(node -v)"

RUN_USER="${SUDO_USER:-$(whoami)}"

# 2) macOS 는 launchd, 리눅스는 systemd
if [[ "$OSTYPE" == "darwin"* ]]; then
  PLIST="/Library/LaunchDaemons/com.seowon.check.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.seowon.check</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string><string>$APP_DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/server.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "설치 완료 (launchd). 상태 확인: launchctl list | grep seowon"
else
  cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=서원농산 작업 체크 공유 서버
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
StandardOutput=append:$APP_DIR/server.log
StandardError=append:$APP_DIR/server.log

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE"
  sleep 2
  systemctl --no-pager --lines=5 status "$SERVICE" || true
  echo
  echo "설치 완료 (systemd)."
  echo "  상태 보기 : systemctl status $SERVICE"
  echo "  다시 시작 : systemctl restart $SERVICE"
  echo "  기록 보기 : journalctl -u $SERVICE -f"
fi

echo
echo "접속 주소 확인 :"
if command -v hostname >/dev/null 2>&1; then
  for ip in $(hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null); do
    echo "   http://$ip:$PORT"
  done
fi
echo "같은 와이파이의 폰에서 위 주소로 접속하면 됩니다."
echo "밖에서도 쓰시려면 공유기 포트포워딩 또는 Cloudflare Tunnel 이 필요합니다 (안내문 참고)."
