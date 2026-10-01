/* 서원농산 작업 체크 — 공유 서버
   외부 라이브러리 없이 Node 만으로 동작한다.  실행:  node server.js
   기본 포트 3000. 환경변수 PORT 로 변경 가능. */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const ROOT   = __dirname;
/* 자료를 어디에 둘지. Render 에 유료 디스크를 붙이면 그 경로를 DATA_DIR 로 준다.
   (예: DATA_DIR=/var/data) 그러면 다시 배포해도 자료가 살아남는다.
   주지 않으면 지금까지처럼 프로그램 폴더에 둔다. */
const DIR    = path.resolve(process.env.DATA_DIR || ROOT);   // 상대 경로로 들어와도 절대 경로로 바꾼다
const DATA   = path.join(DIR, "data.json");
const BACKUP = path.join(DIR, "backup");
const PORT   = process.env.PORT || 3000;
/* 날짜별 낙찰 기록(history)을 며칠까지 보관할지. 캘린더에서 "최근 한 달"을 보여주려는
   용도라 여유 있게 40일로 둔다. */
const HISTORY_DAYS = 40;

if (!fs.existsSync(DIR))    fs.mkdirSync(DIR, { recursive: true });

/* 자료를 정말 붙여둔 디스크에 쓰고 있는지 한눈에 보이게 한다.
   디스크를 붙이고도 DATA_DIR 를 안 주면 프로그램 폴더에 쓰게 되는데,
   그러면 다시 배포할 때마다 그날 자료가 사라진다. 겉으로는 멀쩡해 보여서 놓치기 쉽다. */
const 자료위치 = (() => {
  /* DATA_DIR 를 '/var/data' 가 아니라 'var/data' 로 넣으면 프로그램 폴더 안에 만들어진다.
     쓰기는 되므로 겉으로는 멀쩡해 보이지만 배포 때 그대로 사라진다. 그래서 경로가
     프로그램 폴더 안쪽인지를 먼저 본다. */
  const 안쪽 = DIR === ROOT || DIR.startsWith(ROOT + path.sep);
  try {
    const t = path.join(DIR, ".쓰기시험");
    fs.writeFileSync(t, "1"); fs.unlinkSync(t);
  } catch (e) { return DIR + " — 쓸 수 없습니다! (" + e.code + ")"; }
  if (DIR === ROOT) return "프로그램 폴더 — 배포하면 사라집니다";
  if (안쪽) return DIR + " — 프로그램 폴더 안이라 배포하면 사라집니다 (DATA_DIR 를 / 로 시작하는 경로로 고치세요)";
  return DIR + " — 배포해도 남습니다";
})();

/* 화면 파일이 바뀌면 이 값이 달라진다. 접속자에게 함께 내려보내서
   새 판이 올라오면 각자 폰이 스스로 받아 적용하게 한다. */
const BUILD = (() => {
  const h = crypto.createHash("sha1");
  for (const f of ["index.html", "sw.js"]) {
    try { h.update(fs.readFileSync(path.join(ROOT, f))); } catch (e) {}
  }
  return h.digest("hex").slice(0, 8);
})();

/* ---------- 상태 ---------- */
let state = { version: 0, lots: {}, got: {}, cars: {}, notes: {}, lotnotes: {}, history: {}, log: [], workday: today() };

function today() {
  const d = new Date(Date.now() + 9 * 3600e3);      // 한국 시간 기준
  return d.toISOString().slice(0, 10);
}
try {
  if (fs.existsSync(DATA)) state = Object.assign(state, JSON.parse(fs.readFileSync(DATA, "utf8")));
} catch (e) { console.error("기존 자료를 읽지 못했습니다. 새로 시작합니다.", e.message); }
if (!state.history) state.history = {};

/* 캘린더용 날짜별 기록을 너무 오래된 것부터 지운다 (매일 들어오는 낙찰 줄마다 부른다) */
function pruneHistory() {
  const cutoff = Date.now() - HISTORY_DAYS * 86400e3;
  for (const d of Object.keys(state.history)) {
    const t = new Date(d + "T00:00:00+09:00").getTime();
    if (isNaN(t) || t < cutoff) delete state.history[d];
  }
}
pruneHistory();

/* 낙찰 줄을 날짜별 영구 기록에도 함께 쌓는다. 이 기록은 '낙찰 내역 전체 삭제'나
   '새 작업 시작'을 눌러도 지워지지 않는다 — 캘린더에서 지난 날짜를 다시 볼 수 있어야 하기 때문이다. */
function addToHistory(rows) {
  (rows || []).forEach(r => {
    if (!r || !r.id || !r.date) return;
    state.history[r.date] = state.history[r.date] || {};
    state.history[r.date][r.id] = Object.assign({}, state.history[r.date][r.id] || {}, r);
  });
}

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
/* history(날짜별 기록)는 꽤 커질 수 있어서 실시간으로 계속 내려보내는 자료에는 안 싣는다.
   캘린더는 /api/history, /api/history/:날짜 로 필요할 때만 따로 받아간다. */
const payload = () => {
  const { history, ...rest } = state;
  return Object.assign({ build: BUILD }, rest);     // 판 번호를 얹어 보낸다
};
function broadcast() {
  const msg = "data: " + JSON.stringify(payload()) + "\n\n";
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
    case "lots": {                                   // 실시간 수집기(또는 직접 추가)가 넣은 낙찰 줄 반영
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
      addToHistory(op.rows);                          // 캘린더용 날짜별 기록에도 함께 남긴다
      pruneHistory();
      /* 어느 시장에서 몇 줄이 들어왔는지 함께 적는다. 한 번에 여러 줄이 들어왔을 때
         시장이 뒤섞이지 않았는지 기록만 보고 확인할 수 있다. */
      const 시장 = {};
      (op.rows || []).forEach(r => { if (r && r.mkt) 시장[r.mkt] = (시장[r.mkt] || 0) + 1; });
      const 내역 = Object.keys(시장).map(m => `${m} ${시장[m]}`).join(" · ");
      bump(by, `낙찰 ${added}줄 추가${updated ? `, ${updated}줄 갱신` : ""}${내역 ? ` (${내역})` : ""}`);
      return;
    }
    case "histlots": {                                // 지난 낙찰 내역 백필 — 오늘 작업 목록(state.lots)에는 넣지 않는다
      let n = 0;
      (op.rows || []).forEach(r => { if (r && r.id && r.date) n++; });
      addToHistory(op.rows);
      pruneHistory();
      bump(by, `지난 낙찰 내역 ${n}줄 가져옴`);
      return;
    }
    case "got": {                                    // 박스 몇 개 챙겼는지
      const lot = state.lots[op.id];
      if (!lot) return;
      const n = Math.max(0, Math.min(lot.qty || 0, Number(op.n) || 0));
      state.got[op.id] = { n, by, at: now };
      /* 같은 품목이라도 생산자와 단위가 다르면 다른 줄이다. 셋을 함께 적어야
         기록만 보고도 어느 줄을 고쳤는지 알 수 있다. */
      const 이름 = [lot.item || "품목", lot.who, lot.unit && `${lot.unit}`].filter(Boolean).join(" · ");
      bump(by, `${이름} · ${n}/${lot.qty}`);
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
    case "dellot": {                                 // 잘못 들어간 낙찰 줄 하나만 지운다 (오늘 목록 + 그 날짜 기록 모두에서)
      const lot = state.lots[op.id];
      if (!lot) return;
      delete state.lots[op.id];
      delete state.got[op.id];
      delete state.lotnotes[op.id];
      if (lot.date && state.history[lot.date]) delete state.history[lot.date][op.id];
      bump(by, `${[lot.item, lot.who].filter(Boolean).join(" · ") || "낙찰"} 줄 삭제`);
      return;
    }
    case "clearlots": {                              // 낙찰 내역만 전부 삭제 (상차 체크는 유지, 캘린더 기록은 남는다)
      state.lots = {}; state.got = {}; state.lotnotes = {};
      bump(by, "낙찰 내역 전체 삭제");
      return;
    }
    case "newday": {                                 // 새 작업 시작 — 모두에게 적용된다 (캘린더 기록은 남는다)
      state.lots = {}; state.got = {}; state.cars = {}; state.notes = {}; state.lotnotes = {};
      state.log = []; state.workday = today();
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
    return res.end(JSON.stringify({ ok: true, version: state.version, 판: BUILD, 자료위치, 접속자: clients.size,
      낙찰: Object.keys(state.lots).length, 작업일: state.workday, 기록일수: Object.keys(state.history).length,
      가동초: Math.round(process.uptime()) }));
  }

  if (u.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify(payload()));
  }

  /* 캘린더 — 날짜별 요약(그 날 몇 줄, 어느 시장 몇 줄). 최근 HISTORY_DAYS 일만 남아있다. */
  if (u.pathname === "/api/history") {
    const days = {};
    Object.keys(state.history).sort().forEach(d => {
      const rows = Object.values(state.history[d]);
      const mkt = {};
      rows.forEach(r => { if (r && r.mkt) mkt[r.mkt] = (mkt[r.mkt] || 0) + 1; });
      days[d] = { count: rows.length, mkt };
    });
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, days }));
  }

  /* 캘린더 — 하루치 낙찰 줄 전체 (예: /api/history/2026-09-15) */
  if (u.pathname.startsWith("/api/history/")) {
    const date = decodeURIComponent(u.pathname.slice("/api/history/".length));
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, date, lots: state.history[date] || {} }));
  }

  if (u.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    res.write("data: " + JSON.stringify(payload()) + "\n\n");
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

  // 정적 파일
  let name = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(ROOT, path.normalize(name).replace(/^(\.\.[/\\])+/, ""));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    /* 화면·스크립트는 늘 서버에 다시 물어보게 한다. 그래야 새 판이 바로 내려간다. */
    const fresh = /\.(html|js|webmanifest)$/i.test(file);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": fresh ? "no-cache" : "public, max-age=86400"
    });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("찾을 수 없습니다");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { persist(); console.log("\n자료를 저장하고 종료합니다."); process.exit(0); });
}

/* 하루 한 번 자료를 백업해 둔다 (최근 14개 보관) */
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
  console.log(`서원농산 공유 서버 실행 중 — 포트 ${PORT} · 화면 판 ${BUILD}`);
  console.log(`자료 ${자료위치}`);
  console.log(`작업일 ${state.workday} · 낙찰 ${Object.keys(state.lots).length}줄 · 기록 ${Object.keys(state.history).length}일치 · 접속자에게 실시간 전달`);
});
