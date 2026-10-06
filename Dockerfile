# 서원농산 작업 체크 — 어디서든 같은 방식으로 24시간 구동
FROM node:20-alpine
WORKDIR /app
# 서버가 쓰는 파일은 빠짐없이 여기 적는다 — 빠지면 새 판이 켜지지 못하고 예전 판으로 되돌아간다
COPY server.js webpush.js index.html sw.js manifest.webmanifest icon.png ./
# 안드로이드 앱 새 판(SEOWONY.apk + version.json) — 앱이 여기서 업데이트를 받아 간다
COPY app ./app
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data", "/app/photos", "/app/backup"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
