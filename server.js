/* 서원농산 작업 체크 — 공유 서버
   외부 라이브러리 없이 Node 만으로 동작한다.  실행:  node server.js
   기본 포트 3000. 환경변수 PORT 로 변경 가능. */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const webpush = require("./webpush");

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
/* 재고 관리에서 '전량 출고'한 줄(출고 기록)을 며칠까지 보관할지. 소요금액을 월별로
   적산해 보려는 용도라 1년 넘게 둔다. */
const SHIPPED_DAYS = 400;

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
let state = { version: 0, lots: {}, got: {}, cars: {}, notes: {}, lotnotes: {}, history: {},
  inv: {}, shipped: {}, pollers: {}, pickup: {}, reauc: {}, log: [], workday: today() };

function today() {
  const d = new Date(Date.now() + 9 * 3600e3);      // 한국 시간 기준
  return d.toISOString().slice(0, 10);
}
try {
  if (fs.existsSync(DATA)) state = Object.assign(state, JSON.parse(fs.readFileSync(DATA, "utf8")));
} catch (e) { console.error("기존 자료를 읽지 못했습니다. 새로 시작합니다.", e.message); }
if (!state.history) state.history = {};
if (!state.inv)     state.inv = {};
if (!state.shipped) state.shipped = {};
if (!state.pollers) state.pollers = {};
if (!state.pickup)  state.pickup = {};    // 우선 픽업 표시 (오늘 작업용 — 새 작업 시작·낙찰 전체 삭제로 비운다)
if (!state.reauc)   state.reauc = {};     // 재경매로 분류한 줄 (지난 날짜 합계에도 쓰이므로 기록처럼 남긴다)
if (!state.pushSubs) state.pushSubs = {};
if (!state.fifo)    state.fifo = {};      // 선입선출 준비표 — 경매일 → 품목 → {plan, memo, done, by, at}
if (!state.prep)    state.prep = {};      // 경매 전 준비 양식 — 경매일 → 줄(품목|규격) → 칸 → 수량

/* ---------- 새 낙찰 알림 ----------
   ① 웹 푸시: 아이폰(홈 화면에 추가한 앱)·크롬이 '알림 허용'하면 구독을 받아 두고, 새 낙찰 때 보낸다.
   ② 안드로이드 서원농산 앱(APK): 앱 안의 알림 서비스가 /api/notify 에 붙어 있다가 받으면 알림을 띄운다.
      (APK 의 웹뷰는 웹 푸시를 못 받으므로 앱이 직접 띄운다) */
const VAPID = webpush.loadVapid(path.join(DIR, "vapid.json"));
const notifyClients = new Set();
function lotLine(r) {
  const unit = parseFloat(r.unit) ? parseFloat(r.unit) + "kg " : "";
  const item = String(r.item || "").replace(/\s+/g, "").replace(/^(.+)\((.+)\)$/, "$2$1");   // 고추(꽈리) → 꽈리고추
  return `${String(r.mkt || "").replace("청과", "")} ${item} · ${r.who || "-"} · ${unit}${r.grade || ""} ${r.qty}박스 · ${Number(r.price || 0).toLocaleString("ko-KR")}원`;
}
function notifyNewLots(rows) {
  if (!rows.length) return;
  const 시장 = {};
  rows.forEach(r => { const m = String(r.mkt || "").replace("청과", ""); 시장[m] = (시장[m] || 0) + 1; });
  const msg = {
    title: rows.length === 1 ? "🔔 새 낙찰" : `🔔 새 낙찰 ${rows.length}줄 (${Object.entries(시장).map(([m, n]) => m + " " + n).join(" · ")})`,
    body: rows.slice(0, 4).map(lotLine).join("\n") + (rows.length > 4 ? `\n외 ${rows.length - 4}줄` : ""),
    tag: "lots-" + Date.now(), at: Date.now(), n: rows.length
  };
  const line = "event: lots\ndata: " + JSON.stringify(msg) + "\n\n";
  for (const res of notifyClients) { try { res.write(line); } catch (e) { notifyClients.delete(res); } }
  const subject = state.publicUrl || "https://seowon-nongsan.local";
  for (const [ep, s] of Object.entries(state.pushSubs)) {
    webpush.send(s.sub, msg, VAPID, subject).then(r => {
      if (r.gone) { delete state.pushSubs[ep]; persist(); }
      else if (!r.ok) console.error("웹 푸시 실패", r.status, r.error || "", ep.slice(0, 60));
    });
  }
}

/* 캘린더용 날짜별 기록을 너무 오래된 것부터 지운다 (매일 들어오는 낙찰 줄마다 부른다) */
function pruneHistory() {
  const cutoff = Date.now() - HISTORY_DAYS * 86400e3;
  for (const d of Object.keys(state.history)) {
    const t = new Date(d + "T00:00:00+09:00").getTime();
    if (isNaN(t) || t < cutoff) delete state.history[d];
  }
  for (const d of Object.keys(state.prep || {})) {
    const t = new Date(d + "T00:00:00+09:00").getTime();
    if (isNaN(t) || t < cutoff) delete state.prep[d];
  }
  for (const d of Object.keys(state.fifo || {})) {
    const t = new Date(d + "T00:00:00+09:00").getTime();
    if (isNaN(t) || t < cutoff) delete state.fifo[d];
  }
  /* 재경매 표시도 그 날짜 기록과 함께 정리한다 (id = K|시장|날짜|번호|수량|단가) */
  for (const id of Object.keys(state.reauc || {})) {
    const t = new Date(String(id).split("|")[2] + "T00:00:00+09:00").getTime();
    if (t < cutoff) delete state.reauc[id];
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

/* ---------- 재고 관리 (재고) ----------
   낙찰 줄은 들어오는 즉시 재고 목록(state.inv)에 잔여 수량 = 낙찰 수량으로 올라간다. 화면(재고 관리 탭)에는
   경매일이 지난 줄만 보이고, 오늘 경매일 줄은 하루가 지나면 rollover() 가 오늘 목록에서 빼면서 보이게 된다.
   이 목록은 '새 작업 시작'·'낙찰 내역 전체 삭제'와 상관없이 날을 넘겨 남는다 — 어제 받은
   물건이 오늘도 창고에 남아 있을 수 있기 때문이다. '전량 출고'를 누르면 목록에서 빠지고
   출고 기록(state.shipped)으로 옮겨져 소요금액 적산에 쓰인다. 이미 출고한 줄은 같은 id 로
   다시 들어와도(poller 재전송) 목록에 되살리지 않는다. */
function addToInv(rows, now) {
  let n = 0;
  (rows || []).forEach(r => {
    if (!r || !r.id || state.shipped[r.id]) return;
    const old = state.inv[r.id];
    const qty = Number(r.qty) || 0;
    if (old) {
      state.inv[r.id] = Object.assign({}, old, r, { left: Math.min(old.left, qty) });
    } else {
      state.inv[r.id] = Object.assign({}, r, { left: qty, inAt: now });
      n++;
    }
  });
  return n;
}
function pruneShipped() {
  const cutoff = Date.now() - SHIPPED_DAYS * 86400e3;
  for (const id of Object.keys(state.shipped)) {
    if (!(state.shipped[id].shippedAt >= cutoff)) delete state.shipped[id];
  }
}
pruneShipped();

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
/* history(날짜별 기록)와 shipped(출고 기록)는 꽤 커질 수 있어서 실시간으로 계속 내려보내는
   자료에는 안 싣는다. 캘린더는 /api/history*, 재고 관리의 출고 기록은 /api/shipped 로
   필요할 때만 따로 받아간다. */
const payload = () => {
  const { history, shipped, pushSubs, ...rest } = state;
  return Object.assign({ build: BUILD, now: Date.now() }, rest);   // 판 번호·서버 시각을 얹어 보낸다
};
function broadcast() {
  const msg = "data: " + JSON.stringify(payload()) + "\n\n";
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}
/* 수집기(poller) 신호만 가볍게 밀어준다. 몇 초마다 오므로 전체 상태·기록·저장은 건드리지 않는다. */
function broadcastPollers() {
  const msg = "event: poll\ndata: " + JSON.stringify({ pollers: state.pollers, now: Date.now() }) + "\n\n";
  for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
}
/* 수집기가 사이트에서 줄을 처음 본 때(seenAt) → 서버가 받은 때까지 걸린 시간. 최근 50개만 둔다. */
const lagLog = [];
function lagStats() {
  if (!lagLog.length) return null;
  const a = lagLog.map(x => x.lag).sort((x, y) => x - y);
  return { n: a.length, 최근: lagLog[lagLog.length - 1].lag, 중간: a[Math.floor(a.length / 2)], 최대: a[a.length - 1],
    초과3초: a.filter(x => x > 3000).length };
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

/* 기록에 남길 줄 이름. 오늘 목록에 없으면 그 날짜 기록에서 찾는다. */
function lotName(id) {
  const l = state.lots[id] || (state.history[String(id).split("|")[2]] || {})[id];
  return (l && [l.item, l.who].filter(Boolean).join(" · ")) || "낙찰 줄";
}
const 시장0 = rows => { const m = {}; (rows || []).forEach(r => { if (r && r.mkt) m[r.mkt] = 1; }); return m; };

/* ---------- 작업 처리 ---------- */
function applyOp(user, op, meta = {}) {
  const now = Date.now();
  /* 수집기가 보낸 시각(그 PC 시계). 받은 시각과의 차 = PC 시계 차이 + 전송 시간 */
  const net = Number(meta.sentAt) > 0 ? now - Number(meta.sentAt) : null;
  const by = String(user || "?").slice(0, 12);

  switch (op.t) {
    case "lots": {                                   // 실시간 수집기(또는 직접 추가)가 넣은 낙찰 줄 반영
      let added = 0, updated = 0; const fresh = [];
      (op.rows || []).forEach(r => {
        if (!r.id) return;
        const old = state.lots[r.id];
        state.lots[r.id] = Object.assign({}, old || {}, r, {
          addedBy: old ? old.addedBy : by,
          addedAt: old ? old.addedAt : now,
          updatedBy: by, updatedAt: now
        });
        if (old) updated++; else { added++; fresh.push(r); }
        if (state.got[r.id] && state.got[r.id].n > r.qty) state.got[r.id].n = r.qty;
      });
      addToHistory(op.rows);                          // 캘린더용 날짜별 기록에도 함께 남긴다
      pruneHistory();
      addToInv(op.rows, now);                         // 재고 관리(재고) 목록에도 올린다
      /* 수집기(poller)가 마지막으로 낙찰을 올린 때. 화면과 /api/health 에서 poller 가 살아 있는지 본다. */
      const seen = (op.rows || []).map(r => Number(r && r.seenAt)).filter(x => x > 0);
      const lag = seen.length ? Math.max(0, now - Math.min(...seen)) : null;
      if (lag != null) { lagLog.push({ at: now, lag, mkt: Object.keys(시장0(op.rows)).join("·") }); if (lagLog.length > 50) lagLog.shift(); }
      if (!op.quiet) state.lastLots = { at: now, by, n: (op.rows || []).length, lag, net };   // 되살리기(quiet)는 수집기 수신으로 치지 않는다
      /* 어느 시장에서 몇 줄이 들어왔는지 함께 적는다. 한 번에 여러 줄이 들어왔을 때
         시장이 뒤섞이지 않았는지 기록만 보고 확인할 수 있다. */
      const 시장 = {};
      (op.rows || []).forEach(r => { if (r && r.mkt) 시장[r.mkt] = (시장[r.mkt] || 0) + 1; });
      const 내역 = Object.keys(시장).map(m => `${m} ${시장[m]}`).join(" · ");
      if (!op.quiet) notifyNewLots(fresh);            // 새로 생긴 줄만 알림 (같은 줄 갱신은 알리지 않는다). quiet = 되살리기용, 알림 없음
      bump(by, `낙찰 ${added}줄 추가${updated ? `, ${updated}줄 갱신` : ""}${내역 ? ` (${내역})` : ""}`);
      return;
    }
    case "poll": {                                   // 수집기 신호 — 시장별 로그인 세션 상태 (몇 초마다 온다)
      const mkt = String(op.mkt || "");
      if (!["서울청과", "동화청과"].includes(mkt)) return;
      const session = ["ok", "expired", "error"].includes(op.session) ? op.session : "error";
      const old = state.pollers[mkt] || {};
      state.pollers[mkt] = {
        session, msg: String(op.msg || "").slice(0, 120), at: now, by,
        okAt: session === "ok" ? now : (old.okAt || null),
        since: old.session === session ? old.since : now,
        interval: Math.max(0, Math.min(600, Number(op.interval) || 0)) || null,   // 수집기가 몇 초마다 확인하는지
        net,                                          // PC 시계 차이 + 전송 시간(ms). 낙찰 지연에서 이만큼은 시계 탓일 수 있다
        rows: Number.isFinite(Number(op.rows)) ? Number(op.rows) : (old.rows ?? null) // 그 시장 화면의 낙찰 줄 수
      };
      if (old.session !== session) {                 // 상태가 바뀔 때만 기록·저장한다
        const 말 = { ok: "로그인 정상", expired: "로그인 만료!", error: "확인 오류" }[session];
        bump(by, `${mkt} ${말}${op.msg ? ` (${String(op.msg).slice(0, 40)})` : ""}`);
      } else broadcastPollers();
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
    case "invimport": {                              // 캘린더 기록에서 기간을 골라 재고 관리 목록으로 불러온다
      const from = String(op.from || ""), to = String(op.to || "9999-12-31");
      const rows = [];
      Object.keys(state.history).filter(d => d >= from && d <= to)
        .forEach(d => rows.push(...Object.values(state.history[d])));
      const n = addToInv(rows, now);
      bump(by, `재고 관리로 ${n}줄 불러옴 (${from}~${op.to || "오늘"})`);
      return;
    }
    case "invlock": {                                // 재고 관리 — 체크(고정). 풀기 전에는 잔여 수량·출고·삭제가 안 된다
      const it = state.inv[op.id];
      if (!it) return;
      if (op.on) it.lock = { by, at: now }; else delete it.lock;
      bump(by, `${[it.item, it.who].filter(Boolean).join(" · ")} ${op.on ? "고정" : "고정 풀기"}`);
      return;
    }
    case "invleft": {                                // 재고 관리 — 잔여 수량 고치기
      const it = state.inv[op.id];
      if (!it || it.lock) return;                    // 고정(체크)한 줄은 고치지 않는다
      it.left = Math.max(0, Math.min(Number(it.qty) || 0, Math.round(Number(op.left) || 0)));
      it.leftBy = by; it.leftAt = now;
      bump(by, `${[it.item, it.who].filter(Boolean).join(" · ")} 잔여 ${it.left}/${it.qty}`);
      return;
    }
    case "ship": {                                   // 전량 출고 — 목록에서 빼서 출고 기록으로 옮긴다
      const it = state.inv[op.id];
      if (!it || it.lock) return;                    // 고정(체크)한 줄은 출고하지 않는다
      delete state.inv[op.id];
      state.shipped[op.id] = Object.assign({}, it, { left: 0, shippedAt: now, shippedBy: by });
      pruneShipped();
      bump(by, `${[it.item, it.who].filter(Boolean).join(" · ")} 전량 출고`);
      return;
    }
    case "unship": {                                 // 전량 출고를 잘못 눌렀을 때 되돌린다
      const it = state.shipped[op.id];
      if (!it) return;
      delete state.shipped[op.id];
      const { shippedAt, shippedBy, ...rest } = it;
      state.inv[op.id] = Object.assign(rest, { left: Number(it.qty) || 0 });
      bump(by, `${[it.item, it.who].filter(Boolean).join(" · ")} 출고 되돌림`);
      return;
    }
    case "prepsave": {                               // 준비 양식 저장 — 수량을 적은 품목만 남겨 보여준다 (on:false 면 다시 전체 양식)
      const d = String(op.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      const day = state.prep[d] = state.prep[d] || {};
      if (op.on) day._saved = { by, at: now }; else delete day._saved;
      bump(by, `준비 양식 ${op.on ? "저장" : "다시 고치기"} (${d.slice(5)})`);
      return;
    }
    case "prep": {                                   // 경매 전 준비 양식 한 칸 (세계로 box·봉지대·봉지소 / 일일향 / 초록)
      const d = String(op.date || ""), row = String(op.row || "").slice(0, 40), col = String(op.col || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !row || !["box", "bagL", "bagS", "ilil", "chorok"].includes(col)) return;
      const day = state.prep[d] = state.prep[d] || {};
      const r = day[row] = day[row] || {};
      const v = op.value === "" || op.value == null ? null : Math.max(0, Math.round(Number(op.value) || 0));
      if (v == null) delete r[col]; else r[col] = v;
      if (!Object.keys(r).length) delete day[row];
      const 칸 = { box: "세계로 박스", bagL: "세계로 봉지(대)", bagS: "세계로 봉지(소)", ilil: "일일향", chorok: "초록" }[col];
      bump(by, `준비 양식 · ${row.replace("|", " ")} ${칸} ${v ?? "지움"}`);
      return;
    }
    case "fifo": {                                   // 선입선출 준비표 — 품목별 오늘 목표 수량·메모·준비 확인
      const d = String(op.date || ""), item = String(op.item || "").slice(0, 40);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !item) return;
      const day = state.fifo[d] = state.fifo[d] || {};
      const cur = Object.assign({}, day[item] || {});
      if ("plan" in op) cur.plan = op.plan === "" || op.plan == null ? null : Math.max(0, Math.round(Number(op.plan) || 0));
      if ("memo" in op) cur.memo = String(op.memo || "").slice(0, 100);
      if ("done" in op) cur.done = !!op.done;
      cur.by = by; cur.at = now;
      day[item] = cur;
      const 말 = "done" in op ? (cur.done ? "준비 확인" : "준비 확인 취소") : "plan" in op ? `목표 ${cur.plan ?? "-"}` : "메모";
      bump(by, `선입선출 · ${item} ${말}`);
      return;
    }
    case "pickup": {                                 // 우선 픽업 표시 켜기/끄기
      if (!op.id) return;
      if (op.on) state.pickup[op.id] = { by, at: now };
      else delete state.pickup[op.id];
      bump(by, `${lotName(op.id)} 우선 픽업${op.on ? "" : " 해제"}`);
      return;
    }
    case "reauc": {                                  // 재경매로 분류 / 일반 낙찰로 되돌리기 (줄을 세 번 연속 탭)
      if (!op.id) return;
      if (op.on) state.reauc[op.id] = { by, at: now };
      else delete state.reauc[op.id];
      bump(by, `${lotName(op.id)} ${op.on ? "재경매로 분류" : "일반 낙찰로 되돌림"}`);
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
      if (!lot || (state.inv[op.id] && state.inv[op.id].lock)) return;   // 재고에서 고정(체크)한 줄은 지우지 않는다
      delete state.lots[op.id];
      delete state.got[op.id];
      delete state.lotnotes[op.id];
      if (lot.date && state.history[lot.date]) delete state.history[lot.date][op.id];
      delete state.pickup[op.id]; delete state.reauc[op.id];
      delete state.inv[op.id];                        // 잘못 들어간 줄이니 재고 관리 목록에서도 뺀다
      bump(by, `${[lot.item, lot.who].filter(Boolean).join(" · ") || "낙찰"} 줄 삭제`);
      return;
    }
    case "clearlots": {                              // 낙찰 내역만 전부 삭제 (상차 체크는 유지, 캘린더 기록은 남는다)
      state.lots = {}; state.got = {}; state.lotnotes = {}; state.pickup = {};
      bump(by, "낙찰 내역 전체 삭제");
      return;
    }
    case "newday": {                                 // 새 작업 시작 — 모두에게 적용된다 (캘린더 기록은 남는다)
      state.lots = {}; state.got = {}; state.cars = {}; state.notes = {}; state.lotnotes = {}; state.pickup = {};
      state.log = []; state.workday = today();
      bump(by, "새 작업 시작 (전체 초기화)");
      return;
    }
  }
}

/* ---------- 요청 처리 ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css; charset=utf-8",
  ".apk": "application/vnd.android.package-archive" };

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
      마지막낙찰수신: state.lastLots ? new Date(state.lastLots.at + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " (" + state.lastLots.by + ")" : null,
      수집기: Object.fromEntries(Object.entries(state.pollers).map(([m, p]) => [m,
        { 세션: p.session, 신호초전: Math.round((Date.now() - p.at) / 1000), 간격초: p.interval, 시계차와전송ms: p.net ?? undefined, 메시지: p.msg || undefined }])),
      수신지연ms: lagStats(),
      /* 낙찰 지연(seenAt→서버)에서 'PC 시계 차이 + 전송'(net)을 빼면 수집기 안에서 기다린 시간이 남는다 */
      마지막낙찰: state.lastLots ? { 지연ms: state.lastLots.lag, 시계차와전송ms: state.lastLots.net ?? null } : null,
      알림: { 웹푸시: Object.keys(state.pushSubs).length, 앱: notifyClients.size },
      재고: Object.keys(state.inv).length, 출고기록: Object.keys(state.shipped).length,
      가동초: Math.round(process.uptime()) }));
  }

  /* 안드로이드 앱 업데이트 — 앱이 열릴 때 이 판 번호를 보고 더 높으면 '업데이트할까요?' 를 묻는다.
     판 정보는 android/build-apk.sh 가 APK 와 함께 app/version.json 에 쓴다. APK 는 /app/SEOWONY.apk */
  if (u.pathname === "/api/app") {
    let v = null;
    try { v = JSON.parse(fs.readFileSync(path.join(ROOT, "app", "version.json"), "utf8")); } catch (e) {}
    res.writeHead(v ? 200 : 404, { "Content-Type": TYPES[".json"], "Cache-Control": "no-cache" });
    return res.end(JSON.stringify(v ? { ...v, url: "/app/SEOWONY.apk" } : { error: "앱 판 정보 없음" }));
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

  /* 재고 관리 — 출고 기록 전체(최근 SHIPPED_DAYS 일). 소요금액 적산은 화면에서 한다. */
  /* ---------- 알림 ---------- */
  if (u.pathname === "/api/push/key") {               // 웹 푸시 공개 열쇠
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, key: VAPID.publicKey }));
  }
  if ((u.pathname === "/api/push/subscribe" || u.pathname === "/api/push/unsubscribe") && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        const ep = j.sub && j.sub.endpoint || j.endpoint;
        if (!ep || !/^https:\/\//.test(ep)) throw new Error();
        if (u.pathname.endsWith("/subscribe")) {
          if (!j.sub.keys || !j.sub.keys.p256dh || !j.sub.keys.auth) throw new Error();
          state.pushSubs[ep] = { sub: { endpoint: ep, keys: j.sub.keys }, user: String(j.user || "?").slice(0, 12), at: Date.now() };
          /* VAPID 'sub' 에 넣을 이 서버 주소 (사람 이메일 대신 서버 주소를 쓴다) */
          const proto = req.headers["x-forwarded-proto"] || "https";
          if (req.headers.host) state.publicUrl = `${proto}://${req.headers.host}`;
        } else delete state.pushSubs[ep];
        persist();
        res.writeHead(200, { "Content-Type": TYPES[".json"] });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": TYPES[".json"] });
        res.end(JSON.stringify({ ok: false, error: "구독 정보를 읽지 못했습니다" }));
      }
    });
    return;
  }
  if (u.pathname === "/api/push/test" && req.method === "POST") {   // 시험 알림 (앱의 '시험 알림' 버튼)
    notifyNewLots([{ mkt: "서울청과", item: "시험 알림", who: "서원농산", unit: "", grade: "", qty: 1, price: 0 }]);
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, 웹푸시: Object.keys(state.pushSubs).length, 앱: notifyClients.size }));
  }
  /* 안드로이드 앱 알림 서비스용 — 새 낙찰 때만 짧은 신호가 온다 (전체 자료는 안 보내 데이터를 아낀다) */
  if (u.pathname === "/api/notify") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 5000\n\n");
    notifyClients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
    req.on("close", () => { clearInterval(ping); notifyClients.delete(res); });
    return;
  }

  /* 선입선출 준비표용 — 날짜별 품목 낙찰 수량 (재경매 제외). 품목 이름 맞추기는 화면에서 한다. */
  if (u.pathname === "/api/itemstats") {
    const agg = {};
    for (const [d, rows] of Object.entries(state.history)) {
      for (const r of Object.values(rows)) {
        if (!r || state.reauc[r.id]) continue;
        const k = (r.item || "품목 미상") + "\u0000" + d;
        agg[k] = (agg[k] || 0) + (Number(r.qty) || 0);
      }
    }
    const rows = Object.entries(agg).map(([k, qty]) => { const [item, date] = k.split("\u0000"); return { item, date, qty }; });
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, rows }));
  }

  if (u.pathname === "/api/shipped") {
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify({ ok: true, rows: Object.values(state.shipped) }));
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
        const { user, ops, sentAt } = JSON.parse(body);
        (ops || []).forEach(op => applyOp(user, op, { sentAt }));
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
    const fresh = /\.(html|js|webmanifest|apk)$/i.test(file);
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

/* ---------- 하루가 지나면 지난 낙찰을 재고 관리로 ----------
   경매일 = 경매가 끝나는 날(수집기 auction_date 와 같은 규칙: 한국 시간 15시 이후는 내일).
   경매일이 바뀌면 오늘 작업 목록(state.lots)에서 지난 경매일 줄을 빼서 재고(state.inv)로 넘긴다.
   그 줄들은 날짜별 기록(history)에 그대로 남아 낙찰 내역에서 날짜를 골라 계속 볼 수 있다. */
function auctionDay() {
  const k = new Date(Date.now() + 9 * 3600e3);
  if (k.getUTCHours() >= 15) k.setUTCDate(k.getUTCDate() + 1);
  return k.toISOString().slice(0, 10);
}
/* 재고로 넘기는 기준 — 경매는 밤 22:30 에 시작해 새벽에 끝나므로, 한국 시간 0시 30분이 지나면 그날(경매가 끝나는 날)
   낙찰을 재고로 넘긴다. 이 날짜 '전'의 줄이 재고 대상이다. (00:00~00:30 은 아직 오늘 경매 중으로 본다) */
const INV_CUT_MIN = 30;                                // 0시 30분
function invCutDay() {
  const k = new Date(Date.now() + 9 * 3600e3);
  if (k.getUTCHours() * 60 + k.getUTCMinutes() >= INV_CUT_MIN) k.setUTCDate(k.getUTCDate() + 1);
  return k.toISOString().slice(0, 10);
}
/* 오늘 작업 목록(챙김 체크·주석·우선 픽업)을 닫는 기준 — 새벽 0시 30분 전에 다 못 가져오는 날이 있어
   챙김 여부는 새벽 5시 30분까지 열어 둔다. 재고 관리에는 0시 30분부터 보이고(invCutDay, 화면 재고기준KST),
   오늘 작업 목록에서는 5시 30분에 빠진다(이때 챙김·주석·우선 픽업도 정리). */
const LOT_CLOSE_MIN = 5 * 60 + 30;                     // 새벽 5시 30분
function lotCloseDay() {
  const k = new Date(Date.now() + 9 * 3600e3);
  if (k.getUTCHours() * 60 + k.getUTCMinutes() >= LOT_CLOSE_MIN) k.setUTCDate(k.getUTCDate() + 1);
  return k.toISOString().slice(0, 10);
}
function rollover() {
  const day = lotCloseDay();
  const old = Object.values(state.lots).filter(l => !l.date || l.date < day);
  if (!old.length) return;
  addToInv(old, Date.now());                           // 이미 재고에 있으면 그대로, 전량 출고한 줄은 되살리지 않는다
  for (const l of old) { delete state.lots[l.id]; delete state.got[l.id]; delete state.lotnotes[l.id]; delete state.pickup[l.id]; }
  bump("서원이", `지난 경매 낙찰 ${old.length}줄의 챙김을 마감했습니다 (새벽 5시 30분, 재고 관리에서 계속 관리)`);
}
rollover();
setInterval(rollover, 60 * 1000);

/* 예기치 못한 오류로 서버가 죽지 않게 막는다 */
process.on("uncaughtException", e => { console.error("오류:", e.message); persist(); });
process.on("unhandledRejection", e => console.error("오류:", e));

server.listen(PORT, () => {
  console.log(`서원농산 공유 서버 실행 중 — 포트 ${PORT} · 화면 판 ${BUILD}`);
  console.log(`자료 ${자료위치}`);
  console.log(`작업일 ${state.workday} · 낙찰 ${Object.keys(state.lots).length}줄 · 기록 ${Object.keys(state.history).length}일치 · 접속자에게 실시간 전달`);
});
