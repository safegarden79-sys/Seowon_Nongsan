# 서원농산 작업 체크 — 어디서든 같은 방식으로 24시간 구동
FROM node:20-alpine
WORKDIR /app
COPY server.js index.html sw.js manifest.webmanifest icon.png ./
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data", "/app/photos", "/app/backup"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
