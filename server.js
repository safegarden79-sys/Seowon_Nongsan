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
const DIR    = process.env.DATA_DIR || ROOT;
const DATA   = path.join(DIR, "data.json");
const PHOTOS = path.join(DIR, "photos");
const BACKUP = path.join(DIR, "backup");
const PORT   = process.env.PORT || 3000;
/* 구글 글자 인식(Cloud Vision) 열쇠. 없으면 이 기능만 꺼지고 나머지는 그대로 돈다.
   폰이 열쇠를 알 필요가 없도록 서버가 대신 물어본다. */
const VISION_KEY = process.env.GOOGLE_VISION_KEY || "";
const MAX_PHOTOS = 60;

if (!fs.existsSync(DIR))    fs.mkdirSync(DIR, { recursive: true });
if (!fs.existsSync(PHOTOS)) fs.mkdirSync(PHOTOS, { recursive: true });

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
const payload = () => Object.assign({ build: BUILD, vision: !!VISION_KEY }, state);   // 판 번호와 인식기 유무를 얹어 보낸다
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
      /* 어느 시장에서 몇 줄이 들어왔는지 함께 적는다. 사진을 여러 장 한꺼번에
         읽었을 때 시장이 뒤섞이지 않았는지 기록만 보고 확인할 수 있다. */
      const 시장 = {};
      (op.rows || []).forEach(r => { if (r && r.mkt) 시장[r.mkt] = (시장[r.mkt] || 0) + 1; });
      const 내역 = Object.keys(시장).map(m => `${m} ${시장[m]}`).join(" · ");
      bump(by, `낙찰 ${added}줄 추가${updated ? `, ${updated}줄 갱신` : ""}${내역 ? ` (${내역})` : ""}`);
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

/* 구글이 준 낱말을 화면 쪽이 쓰는 상자 형식으로 바꾼다.
   {글자, 왼쪽, 오른쪽, 가운데높이, 글자높이} — Tesseract 가 주던 것과 같은 모양이다. */
function 글자상자(ann) {
  const out = [];
  ((ann.pages) || []).forEach(p => (p.blocks || []).forEach(b => (b.paragraphs || []).forEach(pa =>
    (pa.words || []).forEach(w => {
      const t = (w.symbols || []).map(s => s.text || "").join("").trim();
      const v = (w.boundingBox || {}).vertices || [];
      if (!t || v.length < 4) return;
      const xs = v.map(q => q.x || 0), ys = v.map(q => q.y || 0);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      out.push({ t, x0: Math.min(...xs), x1: Math.max(...xs), y: (y0 + y1) / 2, h: y1 - y0 });
    })
  )));
  return out.sort((a, b) => a.y - b.y || a.x0 - b.x0);
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
    return res.end(JSON.stringify({ ok: true, version: state.version, 판: BUILD, 글자인식: VISION_KEY ? "구글" : "폰에서", 접속자: clients.size,
      낙찰: Object.keys(state.lots).length, 작업일: state.workday, 가동초: Math.round(process.uptime()) }));
  }

  if (u.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify(payload()));
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

  /* 사진을 받아 구글에 글자 인식을 맡기고, 글자마다 위치 상자를 돌려준다.
     화면 쪽 표 해석(parseAuction)이 쓰는 형식 그대로 맞춰 보낸다. */
  if (u.pathname === "/api/ocr" && req.method === "POST") {
    if (!VISION_KEY) {
      res.writeHead(503, { "Content-Type": TYPES[".json"] });
      return res.end(JSON.stringify({ ok: false, error: "서버에 글자 인식 열쇠가 없습니다" }));
    }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 2.4e7) req.destroy(); });
    req.on("end", async () => {
      try {
        const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(JSON.parse(body).data || "");
        if (!m) throw new Error("사진을 읽지 못했습니다");
        const r = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(VISION_KEY), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{
            image: { content: m[2] },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            imageContext: { languageHints: ["ko", "en"] }
          }] })
        });
        const j = await r.json();
        if (!r.ok) throw new Error((j.error && j.error.message) || ("구글이 거절했습니다 (" + r.status + ")"));
        const one = (j.responses || [])[0] || {};
        if (one.error) throw new Error(one.error.message || "구글이 사진을 읽지 못했습니다");
        const ann = one.fullTextAnnotation || {};
        res.writeHead(200, { "Content-Type": TYPES[".json"] });
        res.end(JSON.stringify({ ok: true, text: ann.text || "", words: 글자상자(ann),
          width: ((ann.pages || [])[0] || {}).width || 0 }));
      } catch (e) {
        console.error("글자 인식 실패:", e.message);
        res.writeHead(502, { "Content-Type": TYPES[".json"] });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
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
    if (fs.existsSync(f)) {                        // 사진 이름은 한 번 정해지면 안 바뀐다 — 오래 담아둬도 된다
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
      return fs.createReadStream(f).pipe(res);
    }
    res.writeHead(404); return res.end();
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
  console.log(`작업일 ${state.workday} · 낙찰 ${Object.keys(state.lots).length}줄 · 접속자에게 실시간 전달`);
});
