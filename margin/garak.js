/* 가락시장 경락가 DB — 서울시농수산식품공사 공식 Open API (서울 열린데이터광장 OA-2664
   "(신)유통정보 - 품목별등급별가격(도매시장법인거래)") 를 매일 받아 우리 품목만 남긴다.

   - 우리 품목 = 서울청과·동화청과 누적 낙찰 품목 (margin.js 의 품목 DB, itemFilter()).
   - 인증키·서비스 이름은 환경변수로만 (저장소에 적지 않는다):
       GARAK_API_KEY   서울 열린데이터광장 인증키
       GARAK_SERVICE   OA-2664 'Open API' 탭에 적힌 서비스 이름
       GARAK_URL       (선택) 주소 틀. 기본 http://openapi.seoul.go.kr:8088/{KEY}/json/{SERVICE}/{START}/{END}/{YMD}
                       {KEY} {SERVICE} {START} {END} {YMD}(20261027) {DATE}(2026-10-27) 를 바꿔 넣는다.
   - 응답 필드 이름은 명세를 못 받아 정규식으로 찾는다(품목·품종·등급·단위·평균가·수량). 실제 응답 첫 줄은
     /api/margin/garak/debug 에 남는다 — 품목이 안 잡히면 여기부터 본다.
   - 자료는 DATA_DIR/garak.json, 날짜별 {key: {q, s, mn, mx, n}} (kg당 가격, 수량 가중). 400일 보관.
   - temp.garak.co.kr/price/OZViewer.do 화면은 사이트가 자동 접근을 막아 두어(robots.txt) 읽지 않는다. */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const KEEP = 400;
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function get(url, ms = 20000) {
  return new Promise((ok, no) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "SEOWONY/1.0 (seowon nongsan)" } }, res => {
      const a = []; res.on("data", c => a.push(c)); res.on("end", () => ok({ status: res.statusCode, text: Buffer.concat(a).toString("utf8") }));
    });
    req.setTimeout(ms, () => req.destroy(new Error("응답 시간 초과")));
    req.on("error", no);
  });
}
const pick = (o, re) => { const k = Object.keys(o).find(k => re.test(k)); return k ? o[k] : undefined; };
const num = v => { const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, "")); return isFinite(n) ? n : null; };
/* '10kg' '10키로' '4kg상자' '5kg 박스' → 10 / 4 / 5 */
function kgOf(t) {
  const s = String(t || "");
  const m = s.match(/([\d.]+)\s*(kg|㎏|키로|킬로)/i);
  if (m) return +m[1];
  const g = s.match(/([\d.]+)\s*g\b/i);
  if (g) return +g[1] / 1000;
  return null;
}

module.exports = function createGarak({ dir, matchKey }) {
  const FILE = path.join(dir, "garak.json");
  let G = { days: {}, last: null, error: null, debug: null, calls: {} };
  try { G = { ...G, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) {}
  const save = () => { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(G)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("가락 경락가 저장 실패", e.message); } };
  const key = process.env.GARAK_API_KEY, service = process.env.GARAK_SERVICE;
  const tpl = process.env.GARAK_URL || "http://openapi.seoul.go.kr:8088/{KEY}/json/{SERVICE}/{START}/{END}/{YMD}";
  const ready = () => !!(key && (service || !/\{SERVICE\}/.test(tpl)));
  const url = (d, a, b) => tpl.replace("{KEY}", encodeURIComponent(key)).replace("{SERVICE}", encodeURIComponent(service || ""))
    .replace("{START}", a).replace("{END}", b).replace("{YMD}", d.replace(/-/g, "")).replace("{DATE}", d);

  /* 응답에서 줄 목록 꺼내기 (서울 열린데이터: {서비스: {list_total_count, RESULT, row:[...]}}) */
  function rowsOf(j) {
    if (!j || typeof j !== "object") return { rows: [], total: 0 };
    if (Array.isArray(j)) return { rows: j, total: j.length };
    for (const v of Object.values(j)) {
      if (v && typeof v === "object" && Array.isArray(v.row)) return { rows: v.row, total: +v.list_total_count || v.row.length, result: v.RESULT };
    }
    if (j.RESULT) return { rows: [], total: 0, result: j.RESULT };
    const arr = Object.values(j).find(Array.isArray);
    return { rows: arr || [], total: arr ? arr.length : 0 };
  }
  /* 한 줄 → {name, grade, kg, perKg, qty} */
  function norm(r) {
    const name = [pick(r, /PUM.*NM|PUM_NAME|ITEM.*NM|품목/i), pick(r, /KIND.*NM|JONG|VRTY|SPCS|품종/i)].filter(Boolean).join(" ");
    const grade = pick(r, /GRADE|GRD|G_NAME|등급/i);
    const unit = pick(r, /UNIT|DANQ|단위|규격|STD/i);
    let kg = kgOf(unit);
    if (kg == null) { const u = num(pick(r, /UNIT_QTY|U_QTY|DANQ/i)); if (u && u > 0 && u < 100) kg = u; }
    const avg = num(pick(r, /AV.*P|AVG|AVR|평균/i)) ?? num(pick(r, /PRICE|가격|_P$/i));
    const qty = num(pick(r, /QTY|QNT|수량|거래량|CNT/i)) || 1;
    if (!name || !avg || !kg) return null;
    return { name, grade: String(grade || ""), kg, perKg: avg / kg, qty };
  }

  async function fetchDay(d) {
    const agg = {};
    let start = 1, total = Infinity, seen = 0, matched = 0;
    while (start <= total && start <= 20000) {
      const r = await get(url(d, start, start + 999));
      G.calls[todayKST()] = (G.calls[todayKST()] || 0) + 1;
      let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error(`JSON 이 아닙니다 (HTTP ${r.status}): ${r.text.slice(0, 160)}`); }
      const o = rowsOf(j);
      if (start === 1) G.debug = { at: Date.now(), date: d, status: r.status, result: o.result || null, total: o.total, first: o.rows[0] || null, keys: o.rows[0] ? Object.keys(o.rows[0]) : [] };
      if (o.result && o.result.CODE && !/INFO-000/.test(o.result.CODE) && !o.rows.length) {
        if (/INFO-200/.test(o.result.CODE)) break;                    // 해당 자료 없음 (일요일 등)
        throw new Error(`${o.result.CODE} ${o.result.MESSAGE || ""}`);
      }
      total = o.total; seen += o.rows.length;
      for (const raw of o.rows) {
        const n = norm(raw); if (!n) continue;
        const k = matchKey(n.name, n.grade); if (!k) continue;            // 우리 품목만
        matched++;
        const a = (agg[k] ||= { q: 0, s: 0, mn: Infinity, mx: 0, n: 0 });
        a.q += n.qty; a.s += n.perKg * n.qty; a.n++; a.mn = Math.min(a.mn, n.perKg); a.mx = Math.max(a.mx, n.perKg);
      }
      if (!o.rows.length) break;
      start += 1000;
    }
    for (const a of Object.values(agg)) { a.avg = Math.round(a.s / a.q); a.s = Math.round(a.s); a.mn = Math.round(a.mn); a.mx = Math.round(a.mx); }
    return { agg, seen, matched };
  }

  let busy = false;
  async function sync(force) {
    if (!ready() || busy) return { skipped: !ready() ? "GARAK_API_KEY · GARAK_SERVICE 가 없습니다" : "받는 중" };
    busy = true;
    const done = [];
    try {
      const today = todayKST();
      const want = [today, addDays(today, -1)];
      for (let i = 2; i < 40 && want.length < 5; i++) { const d = addDays(today, -i); if (!G.days[d]) want.push(d); }
      for (const d of want) {
        const old = G.days[d];
        if (!force && old && old.final) continue;
        if (!force && old && d === today && Date.now() - old.at < 3 * 3600e3) continue;
        const r = await fetchDay(d);
        G.days[d] = { agg: r.agg, at: Date.now(), seen: r.seen, matched: r.matched, final: d < today };
        done.push(`${d} ${r.seen}줄 중 우리 품목 ${r.matched}줄`);
      }
      const cut = addDays(today, -KEEP);
      for (const d of Object.keys(G.days)) if (d < cut) delete G.days[d];
      G.last = Date.now(); G.error = null;
    } catch (e) {
      G.error = { at: Date.now(), msg: e.message };
      console.error("가락 경락가", e.message);
    } finally { busy = false; save(); }
    return { done, error: G.error };
  }
  function start() {
    if (!ready()) return;
    setTimeout(() => sync(), 20000);
    setInterval(() => sync(), 30 * 60e3).unref();
  }
  function status() {
    return { ready: ready(), service: service || null, days: Object.keys(G.days).length, last: G.last, error: G.error, callsToday: G.calls[todayKST()] || 0, busy };
  }
  /* 그 날짜·품목 키의 kg당 집계 */
  const day = (d, k) => (G.days[d] && G.days[d].agg[k]) || null;
  return { start, sync, status, day, debug: () => G.debug, raw: () => G, _test: { norm, rowsOf, kgOf, fetchDay } };
};
