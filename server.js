/* 서원농산 작업 체크 — 공유 서버
   외부 라이브러리 없이 Node 만으로 동작한다.  실행:  node server.js
   기본 포트 3000. 환경변수 PORT 로 변경 가능. */

const http = require("http");
const fs   = require("fs");
const path = require("path");

const ROOT   = __dirname;
const DATA   = path.join(ROOT, "data.json");
const PHOTOS = path.join(ROOT, "photos");
const PORT   = process.env.PORT || 3000;
const MAX_PHOTOS = 60;

if (!fs.existsSync(PHOTOS)) fs.mkdirSync(PHOTOS, { recursive: true });

/* ---------- 상태 ---------- */
let state = { version: 0, lots: {}, got: {}, cars: {}, notes: {}, lotnotes: {}, photos: [], log: [], workday: today() };

function today() {
  const d = new Date(Date.now() + 9 * 3600e3);      // 한국 시간 기준
  return d.toISOString().slice(0, 10);
}
try {
  if (fs.existsSync(DATA)) state = Object.assign(state, JSON.parse(fs.readFileSync(DATA, "utf8")));
} catch (e) { console.error("기존 자료를 읽지 못했습니다. 새로 시작합니다.", e.message); }

/* 매 변경마다 즉시 저장한다. 임시 파일에 쓴 뒤 바꿔치기해서
   저장 도중 서버가 꺼져도 자료가 깨지지 않는다. */
function persist() {
  try {
    const tmp = DATA + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA);
  } catch (e) { console.error("저장 실패", e.message); }
}

/* ---------- 접속자에게 밀어주기 (SSE) ---------- */
const clients = new Set();
function broadcast() {
  const msg = "data: " + JSON.stringify(state) + "\n\n";
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}
function bump(by, text) {
  state.version++;
  if (text) {
    state.log.unshift({ at: Date.now(), by, text });
    state.log = state.log.slice(0, 60);
  }
  persist();
  broadcast();
}

/* ---------- 작업 처리 ---------- */
function applyOp(user, op) {
  const now = Date.now();
  const by = String(user || "?").slice(0, 12);

  switch (op.t) {
    case "lots": {                                   // 사진에서 읽은 낙찰 줄 반영
      let added = 0, updated = 0;
      (op.rows || []).forEach(r => {
        if (!r.id) return;
        const old = state.lots[r.id];
        state.lots[r.id] = Object.assign({}, old || {}, r, {
          addedBy: old ? old.addedBy : by,
          addedAt: old ? old.addedAt : now,
          updatedBy: by, updatedAt: now
        });
        old ? updated++ : added++;
        if (state.got[r.id] && state.got[r.id].n > r.qty) state.got[r.id].n = r.qty;
      });
      bump(by, `낙찰 ${added}줄 추가${updated ? `, ${updated}줄 갱신` : ""}`);
      return;
    }
    case "got": {                                    // 박스 몇 개 챙겼는지
      const lot = state.lots[op.id];
      if (!lot) return;
      const n = Math.max(0, Math.min(lot.qty || 0, Number(op.n) || 0));
      state.got[op.id] = { n, by, at: now };
      bump(by, `${lot.item || "품목"} ${n}/${lot.qty}`);
      return;
    }
    case "car": {                                    // 상차 체크
      if (op.done) state.cars[op.id] = { by, at: now };
      else delete state.cars[op.id];
      bump(by, `${op.name || op.id} ${op.done ? "완료" : "완료 취소"}`);
      return;
    }
    case "note": {
      if (op.text) state.notes[op.id] = { text: String(op.text).slice(0, 300), by, at: now };
      else delete state.notes[op.id];
      bump(by, `${op.name || op.id} 메모`);
      return;
    }
    case "lotnote": {                                // 낙찰 줄에 남기는 주석
      const lot = state.lots[op.id];
      if (op.text) state.lotnotes[op.id] = { text: String(op.text).slice(0, 200), by, at: now };
      else delete state.lotnotes[op.id];
      bump(by, `${lot ? lot.item : "품목"} 주석`);
      return;
    }
    case "photo": {                                  // 경매 화면 사진 공유
      const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(op.data || "");
      if (!m) return;
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 900 * 1024) return;
      const id = "p" + now + Math.random().toString(36).slice(2, 6);
      fs.writeFileSync(path.join(PHOTOS, id + ".jpg"), buf);
      state.photos.unshift({ id, by, at: now, mkt: op.mkt || "" });
      while (state.photos.length > MAX_PHOTOS) {
        const old = state.photos.pop();
        try { fs.unlinkSync(path.join(PHOTOS, old.id + ".jpg")); } catch (e) {}
      }
      bump(by, "경매 화면 사진 올림");
      return;
    }
    case "delphoto": {
      const i = state.photos.findIndex(p => p.id === op.id);
      if (i < 0) return;
      try { fs.unlinkSync(path.join(PHOTOS, op.id + ".jpg")); } catch (e) {}
      state.photos.splice(i, 1);
      bump(by, "사진 삭제");
      return;
    }
    case "clearlots": {                              // 낙찰 내역만 전부 삭제 (상차 체크는 유지)
      state.lots = {}; state.got = {}; state.lotnotes = {};
      bump(by, "낙찰 내역 전체 삭제");
      return;
    }
    case "newday": {                                 // 새 작업 시작 — 모두에게 적용된다
      state.lots = {}; state.got = {}; state.cars = {}; state.notes = {}; state.lotnotes = {};
      state.photos.forEach(p => { try { fs.unlinkSync(path.join(PHOTOS, p.id + ".jpg")); } catch (e) {} });
      state.photos = []; state.log = []; state.workday = today();
      bump(by, "새 작업 시작 (전체 초기화)");
      return;
    }
  }
}

/* ---------- 요청 처리 ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css; charset=utf-8" };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (u.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, version: state.version, 접속자: clients.size,
      낙찰: Object.keys(state.lots).length, 작업일: state.workday, 가동초: Math.round(process.uptime()) }));
  }

  if (u.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify(state));
  }

  if (u.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    res.write("data: " + JSON.stringify(state) + "\n\n");
    clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (u.pathname === "/api/op" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on("end", () => {
      try {
        const { user, ops } = JSON.parse(body);
        (ops || []).forEach(op => applyOp(user, op));
        res.writeHead(200, { "Content-Type": TYPES[".json"] });
        res.end(JSON.stringify({ ok: true, version: state.version }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": TYPES[".json"] });
        res.end(JSON.stringify({ ok: false, error: "요청을 읽지 못했습니다" }));
      }
    });
    return;
  }

  if (u.pathname.startsWith("/photos/")) {
    const f = path.join(PHOTOS, path.basename(u.pathname));
    if (fs.existsSync(f)) { res.writeHead(200, { "Content-Type": "image/jpeg" }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); return res.end();
  }

  // 정적 파일
  let name = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(ROOT, path.normalize(name).replace(/^(\.\.[/\\])+/, ""));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("찾을 수 없습니다");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { persist(); console.log("\n자료를 저장하고 종료합니다."); process.exit(0); });
}

/* 하루 한 번 자료를 백업해 둔다 (최근 14개 보관) */
const BACKUP = path.join(ROOT, "backup");
function backup() {
  try {
    if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
    fs.writeFileSync(path.join(BACKUP, `data-${today()}.json`), JSON.stringify(state));
    const old = fs.readdirSync(BACKUP).filter(f => f.startsWith("data-")).sort();
    while (old.length > 14) { try { fs.unlinkSync(path.join(BACKUP, old.shift())); } catch (e) {} }
  } catch (e) { console.error("백업 실패", e.message); }
}
backup();
setInterval(backup, 6 * 3600e3);

/* 예기치 못한 오류로 서버가 죽지 않게 막는다 */
process.on("uncaughtException", e => { console.error("오류:", e.message); persist(); });
process.on("unhandledRejection", e => console.error("오류:", e));

server.listen(PORT, () => {
  console.log(`서원농산 공유 서버 실행 중 — 포트 ${PORT}`);
  console.log(`작업일 ${state.workday} · 낙찰 ${Object.keys(state.lots).length}줄 · 접속자에게 실시간 전달`);
});
