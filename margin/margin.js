/* 마진 계산 — 서원 낙찰 단가(state.history) × 가락시장·전국 경락가 × 지역 소매가(prices 모듈)
   외부 라이브러리 없음. 화면은 margin/index.html, 엑셀은 margin/xlsx.js(margin/template.xlsx 에 자료를 채움).

   품목 키 = 품목군|등급|박스kg   (예: cheongyang|특|10)
   - 품목군은 prices.js 의 matchGroup(청양·홍청양·녹광·홍초·꽈리·아삭이·파프리카 빨강/노랑·피망·홍피망).
     못 찾는 품목(버섯 등)은 정리한 이름 그대로 쓰고 시세 비교는 비운다.
   - 박스kg 는 낙찰 줄의 unit(서울청과 '10kg' 등). 동화청과처럼 비어 있으면 품목 기본(10kg, 아삭이 팩 3.6kg).
   - 재경매(state.reauc)·사이트 정정(gone) 줄은 뺀다.

   한 채널의 마진 (박스 1개):
     원가 C = 낙찰 단가(최근 경매일 가중평균 | 최근 7일 평균 | 최근 7일 중 가장 비싼 날)
     부대비 F = 택배비 + 포장비 + 기타,  수수료율 r
     손익분기가 = (C + F) ÷ (1 − r)
     최소 마진가 = 손익분기가 × (1 + 최소 마진%)
     상한가 = 소매 기준: 지역 소매 kg당 가운데값 × 박스kg × (1 − 소매 대비 할인%)
              가락 기준: 가락 7일 kg당 평균 × 박스kg × (1 + 가락 대비 가산%)
              (그 기준 자료가 없으면 다른 기준으로 대신)
     최대 마진 = 상한가 × (1 − r) − C − F,  마진율 = 최대 마진 ÷ 상한가
     권장가 = (최소 마진가 + 상한가) ÷ 2   (상한가가 최소 마진가보다 낮으면 최소 마진가)
   엑셀의 수식도 똑같이 계산한다 (margin/build_template.py). 바꾸면 세 곳(여기·화면·템플릿)을 같이 고친다. */
const fs = require("fs");
const path = require("path");
const buildXlsx = require("./xlsx");
const createGarak = require("./garak");

const DEFAULT_SETTINGS = {
  costBasis: "7일평균",                 // 최근 | 7일평균 | 7일최고
  channels: [
    { key: "store",  name: "스마트스토어(택배)", feeRate: 5.5, shipping: 4000, packing: 800, other: 0,   ceilBasis: "소매", retailGap: 10, garakUp: 30, minMargin: 10 },
    { key: "rest",   name: "식당 직납",          feeRate: 0,   shipping: 0,    packing: 0,   other: 1500, ceilBasis: "가락", retailGap: 25, garakUp: 15, minMargin: 8 },
    { key: "resell", name: "도매 재판매",        feeRate: 0,   shipping: 0,    packing: 0,   other: 300,  ceilBasis: "가락", retailGap: 40, garakUp: 5,  minMargin: 3 },
  ],
};
const BASES = ["최근", "7일평균", "7일최고"];
const HIST_DAYS = 40;   // server.js 의 HISTORY_DAYS 와 같게

function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const r0 = n => (n == null || !isFinite(n)) ? null : Math.round(n);
const median = a => { a = a.filter(isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/* 앱 화면(index.html normItem)과 같은 이름 정리 */
const ITEM_ALIAS = { "홍청양고추": "홍청양", "아삭이고추": "오이맛고추", "녹광": "녹광고추", "빨강파프리카": "홍파프리카" };
function normItem(t) {
  let s = String(t || "").replace(/\s+/g, "");
  const m = s.match(/^(.+)\((.+)\)$/);
  if (m) s = m[2] + m[1];
  return ITEM_ALIAS[s] || s || "품목 미상";
}

/* 한 번에 계산 — 화면(margin/index.html)에도 같은 함수가 있다 */
function calc(sm, ch, basis) {
  if (!sm || !ch) return null;
  const C = basis === "최근" ? sm.lastBox : basis === "7일최고" ? sm.max7Box : sm.avg7Box;
  if (!isFinite(C) || C == null) return null;
  const r = (+ch.feeRate || 0) / 100, F = (+ch.shipping || 0) + (+ch.packing || 0) + (+ch.other || 0);
  const breakeven = (C + F) / (1 - r);
  const minPrice = breakeven * (1 + (+ch.minMargin || 0) / 100);
  const retailCeil = sm.retailKg ? sm.retailKg * sm.kg * (1 - (+ch.retailGap || 0) / 100) : null;
  const garakCeil = sm.garakKg7 ? sm.garakKg7 * sm.kg * (1 + (+ch.garakUp || 0) / 100) : null;
  let ceil, ceilSrc;
  if (ch.ceilBasis === "소매") { ceil = retailCeil ?? garakCeil; ceilSrc = retailCeil != null ? "소매" : garakCeil != null ? "가락(대신)" : null; }
  else { ceil = garakCeil ?? retailCeil; ceilSrc = garakCeil != null ? "가락" : retailCeil != null ? "소매(대신)" : null; }
  const margin = P => P * (1 - r) - C - F;
  const out = { cost: C, fixed: F, fee: r, breakeven, minPrice, ceil: ceil ?? null, ceilSrc };
  if (ceil != null) {
    out.maxMargin = margin(ceil); out.maxRate = out.maxMargin / ceil;
    out.rec = ceil > minPrice ? (minPrice + ceil) / 2 : minPrice;
    out.recMargin = margin(out.rec);
  }
  return out;
}

module.exports = function createMargin({ dir, prices, getState }) {
  const FILE = path.join(dir, "margin.json");
  let S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try { const saved = JSON.parse(fs.readFileSync(FILE, "utf8")); if (saved && saved.channels) S = saved; } catch (e) {}
  function save() { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(S, null, 1)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("마진 설정 저장 실패", e.message); } }

  const skuBox = {};
  for (const k of prices.skus) skuBox[k.group] = skuBox[k.group] || k.box;
  const gname = Object.fromEntries(prices.groups.map(g => [g.key, g.name]));

  function groupOf(item) {
    const t = String(item || "").replace(/\s+/g, "");
    let g = prices.matchGroup(t);
    if (!g && !/고추|파프리카|피망/.test(t) && /청양|꽈리|아삭|오이맛|녹광|홍초|풋/.test(t)) g = prices.matchGroup(t + "고추");
    return g;
  }
  function kgOf(l, g) {
    const n = parseFloat(String(l.unit || "").replace(/[^\d.]/g, ""));
    if (isFinite(n) && n > 0 && n < 100) return n;
    if (g === "asak" && /팩/.test(l.item || "")) return 3.6;
    return (g && skuBox[g]) || 10;
  }

  /* ---------- 품목 DB (서울청과·동화청과 누적 낙찰) ----------
     낙찰 기록(state.history)은 40일만 남으므로 날짜별·품목별 집계를 DATA_DIR/margin_db.json 에 따로 쌓는다(400일).
     daily[날짜][품목키] = {q, s, mn, mx, n, mkt:{시장: 수량}}  — 기록에 남아 있는 날짜는 늘 기록에서 다시 계산(정정·삭제 반영).
     items[기준키(품목군|등급)] = {name, group, grade, kgs:{박스kg: 수량}, first, last, qty, amt, days} — 가락 경락가를 모을 품목 목록. */
  const DBF = path.join(dir, "margin_db.json");
  let DB = { daily: {}, items: {}, at: 0 };
  try { DB = { ...DB, ...JSON.parse(fs.readFileSync(DBF, "utf8")) }; } catch (e) {}
  let dbSaved = JSON.stringify(DB.daily).length;
  function refreshDB() {
    const rows = lotRows(HIST_DAYS + 5);
    const fresh = {};
    for (const l of rows) {
      const d = (fresh[l.date] ||= {}), a = (d[l.key] ||= { q: 0, s: 0, mn: Infinity, mx: 0, n: 0, mkt: {} });
      a.q += l.qty; a.s += l.amt; a.n++; a.mn = Math.min(a.mn, l.price); a.mx = Math.max(a.mx, l.price); a.mkt[l.mkt] = (a.mkt[l.mkt] || 0) + l.qty;
    }
    const hist = getState().history || {};
    for (const d of Object.keys(hist)) DB.daily[d] = fresh[d] || {};      // 기록에 있는 날은 기록 기준으로 다시
    for (const [d, v] of Object.entries(fresh)) DB.daily[d] = v;            // (오늘 목록에만 있는 줄 포함)
    const cut = addDays(todayKST(), -400);
    for (const d of Object.keys(DB.daily)) if (d < cut || !Object.keys(DB.daily[d]).length) delete DB.daily[d];
    const items = {};
    for (const [d, day] of Object.entries(DB.daily)) for (const [k, a] of Object.entries(day)) {
      const [gk, grade, kg] = k.split("|");
      const ref = gk + "|" + grade, g = gname[gk] ? gk : null;
      const it = (items[ref] ||= { ref, name: g ? gname[g] : gk, group: g, grade, kgs: {}, first: d, last: d, qty: 0, amt: 0, days: 0, mkt: {} });
      it.kgs[kg] = (it.kgs[kg] || 0) + a.q; it.qty += a.q; it.amt += a.s; it.days++;
      if (d < it.first) it.first = d; if (d > it.last) it.last = d;
      for (const [m, q] of Object.entries(a.mkt || {})) it.mkt[m] = (it.mkt[m] || 0) + q;
    }
    DB.items = items; DB.at = Date.now();
    const n = JSON.stringify(DB.daily).length;
    if (n !== dbSaved) { dbSaved = n; try { fs.writeFileSync(DBF + ".tmp", JSON.stringify(DB)); fs.renameSync(DBF + ".tmp", DBF); } catch (e) { console.error("품목 DB 저장 실패", e.message); } }
    return DB;
  }
  const normName = t => String(t || "").replace(/\s+/g, "").replace(/[()]/g, "");
  /* 가락 경락가 줄(품목·품종 이름, 등급) → 우리 품목 DB 의 기준키. DB 에 없는 품목은 null (모으지 않음) */
  function matchKey(name, grade) {
    const g = groupOf(name);
    const std = prices.matchGrade(grade) || String(grade || "").trim() || "등급없음";
    const ref = g ? `${g}|${std}` : null;
    if (ref && DB.items[ref]) return ref;
    if (g) return null;
    const nn = normName(name);
    for (const it of Object.values(DB.items)) if (!it.group && it.grade === std && (normName(it.name) === nn || nn.includes(normName(it.name)))) return it.ref;
    return null;
  }
  const garak = createGarak({ dir, matchKey });
  setTimeout(() => { try { refreshDB(); } catch (e) { console.error("품목 DB", e.message); } garak.start(); }, 5000);
  setInterval(() => { try { refreshDB(); } catch (e) {} }, 60 * 60e3).unref();

  /* ---------- 서원 낙찰 → 날짜별·품목별 ---------- */
  function lotRows(days) {
    const st = getState();
    const cut = addDays(todayKST(), -(days || 40));
    const out = [];
    const seen = new Set();
    const add = l => {
      if (!l || !l.id || seen.has(l.id) || !l.date || l.date < cut) return;
      seen.add(l.id);
      if ((st.reauc || {})[l.id] || l.gone) return;
      const qty = +l.qty || 0, price = +l.price || 0;
      if (!qty || !price) return;
      const g = groupOf(l.item);
      const grade = prices.matchGrade(l.grade) || (String(l.grade || "").trim() || "등급없음");
      const kg = kgOf(l, g);
      const name = g ? gname[g] : normItem(l.item);
      out.push({ id: l.id, date: l.date, mkt: l.mkt, no: l.no, item: l.item, who: l.who, grade: l.grade, unit: l.unit,
        qty, price, amt: qty * price, group: g, std: grade, kg, key: `${g || name}|${grade}|${kg}`, ref: `${g || name}|${grade}`, name });
    };
    for (const day of Object.values(st.history || {})) for (const l of Object.values(day)) add(l);
    for (const l of Object.values(st.lots || {})) add(l);
    return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.mkt).localeCompare(String(b.mkt)) || (parseInt(a.no) || 0) - (parseInt(b.no) || 0));
  }

  /* ---------- 시세 (prices 모듈) ---------- */
  function wsDay(d, g, grade) {
    const day = prices.raw().ws.days[d]; const r = day && day.agg && day.agg[g] && day.agg[g][grade];
    if (!r) return null;
    let gq = 0, gs = 0, gmn = Infinity, gmx = 0, nq = 0, ns = 0;
    for (const [mk, m] of Object.entries(r)) {
      nq += m.q; ns += m.s;
      if (/가락/.test(mk)) { gq += m.q; gs += m.s; gmn = Math.min(gmn, m.mn); gmx = Math.max(gmx, m.mx); }
    }
    return { garak: gq ? gs / gq : null, garakQ: gq, garakMn: gq ? gmn : null, garakMx: gq ? gmx : null, nat: nq ? ns / nq : null, natQ: nq };
  }
  function rtDay(d, g) {
    const day = prices.raw().rt.days[d]; if (!day) return null;
    const vals = [];
    for (const reg of Object.values(day.regions || {})) {
      const it = (reg.items || {})[g]; if (!it || !it.length) continue;
      const v = median(it.map(x => +x.perKg).filter(x => x > 0)); if (v) vals.push(v);
    }
    return median(vals);
  }

  /* 가락 시세 한 날: 가락 공식 경락가 DB(garak.js) 가 있으면 그것, 없으면 aT 전국 자료 중 서울가락 줄 */
  function garakDay(d, ref, g, grade) {
    const o = garak.day(d, ref);
    if (o) return { kg: o.s / o.q, q: o.q, mn: o.mn, mx: o.mx, src: "가락공사" };
    const w = g && (grade === "특" || grade === "상") ? wsDay(d, g, grade) : null;
    if (w && w.garak) return { kg: w.garak, q: w.garakQ, mn: w.garakMn, mx: w.garakMx, src: "aT" };
    return null;
  }

  /* ---------- 묶어서 정리 ---------- */
  function build(days) {
    days = Math.max(7, Math.min(400, +days || 40));
    const today = todayKST(), cut = addDays(today, -(days - 1));
    refreshDB();
    const rows = lotRows(days);
    const byKey = {};
    for (const [d, day] of Object.entries(DB.daily)) {
      if (d < cut) continue;
      for (const [key, a] of Object.entries(day)) {
        const [gk, grade, kg] = key.split("|"), g = gname[gk] ? gk : null;
        const k = byKey[key] ||= { key, ref: gk + "|" + grade, group: g, name: g ? gname[g] : gk, grade, kg: +kg, dates: {} };
        k.dates[d] = a;
      }
    }
    const xs = []; for (let i = days - 1; i >= 0; i--) xs.push(addDays(today, -i));
    const items = [], daily = [];
    for (const k of Object.values(byKey)) {
      const ds = Object.keys(k.dates).sort();
      const last = ds[ds.length - 1];
      const d7 = ds.filter(d => d > addDays(last, -7));
      const sum = (list, f) => list.reduce((a, d) => a + f(k.dates[d]), 0);
      const std = (k.grade === "특" || k.grade === "상") && k.group;
      /* 시세 7일: 오늘 기준 최근 7일 가중평균 */
      let gq = 0, gs = 0, nq = 0, ns = 0, rk = null, rkDate = null; const srcs = new Set();
      for (let i = 0; i < 7; i++) {
        const d = addDays(today, -i), gd = garakDay(d, k.ref, k.group, k.grade);
        if (gd) { gq += gd.q; gs += gd.kg * gd.q; srcs.add(gd.src); }
        const w = std ? wsDay(d, k.group, k.grade) : null;
        if (w && w.nat) { nq += w.natQ; ns += w.nat * w.natQ; }
      }
      if (k.group) for (let i = 0; i < 10 && rk == null; i++) { const d = addDays(today, -i); const v = rtDay(d, k.group); if (v) { rk = v; rkDate = d; } }
      const mkt = {}; for (const d of ds) for (const [m, q] of Object.entries(k.dates[d].mkt || {})) mkt[m] = (mkt[m] || 0) + q;
      const sm = {
        key: k.key, ref: k.ref, group: k.group, name: k.name, grade: k.grade, kg: k.kg, label: `${k.name} ${k.grade} ${k.kg}kg`,
        lastDate: last, lastBox: k.dates[last].s / k.dates[last].q, lastQty: k.dates[last].q,
        avg7Box: sum(d7, d => d.s) / sum(d7, d => d.q), max7Box: Math.max(...d7.map(d => k.dates[d].s / k.dates[d].q)),
        avgBox: sum(ds, d => d.s) / sum(ds, d => d.q), minPrice: Math.min(...ds.map(d => k.dates[d].mn)), maxPrice: Math.max(...ds.map(d => k.dates[d].mx)),
        qty: sum(ds, d => d.q), amt: sum(ds, d => d.s), days: ds.length, mkt,
        garakKg7: gq ? gs / gq : null, garakSrc: [...srcs].join("+") || null, natKg7: nq ? ns / nq : null, retailKg: rk, retailDate: rkDate, market: !!(gq || rk),
      };
      sm.garakBox7 = sm.garakKg7 ? sm.garakKg7 * sm.kg : null;
      sm.vsGarak = sm.garakBox7 ? sm.garakBox7 - sm.avg7Box : null;   // + 면 가락 평균보다 싸게 산 것
      items.push(sm);
      for (const d of xs) {
        const o = k.dates[d], gd = garakDay(d, k.ref, k.group, k.grade), w = std ? wsDay(d, k.group, k.grade) : null, rt = k.group ? rtDay(d, k.group) : null;
        if (!o && !gd && !(w && w.nat) && !rt) continue;
        daily.push({ date: d, key: k.key, label: sm.label, name: k.name, grade: k.grade, kg: k.kg,
          qty: o ? o.q : null, avgBox: o ? o.s / o.q : null, minBox: o ? o.mn : null, maxBox: o ? o.mx : null, amt: o ? o.s : null,
          garakKg: gd && gd.kg, garakMn: gd && gd.mn, garakMx: gd && gd.mx, garakQ: gd && gd.q, garakSrc: gd && gd.src, natKg: w && w.nat, retailKg: rt });
      }
    }
    const CAT = ["cheongyang", "hongcheongyang", "putgochu", "hongcho", "kkwari", "asak", "paprikaRed", "paprikaYellow", "pimang", "hongpimang"];
    const ord = sm => (sm.group ? CAT.indexOf(sm.group) : 99);
    items.sort((a, b) => ord(a) - ord(b) || a.name.localeCompare(b.name, "ko") || (a.grade === "특" ? -1 : b.grade === "특" ? 1 : a.grade.localeCompare(b.grade, "ko")) || a.kg - b.kg);
    const st = prices.status();
    return { today, days, xs, items, daily, lots: rows, settings: S, mock: st.mock, itemDB: Object.values(DB.items),
      source: { wholesaleDays: st.wholesale.days, retailDays: st.retail.days, keys: st.keys, garak: garak.status(), archiveDays: Object.keys(DB.daily).length } };
  }

  /* 화면용으로 숫자를 줄인다 (원 단위 반올림, kg 당은 소수 없이) */
  function slim(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = typeof v === "number" && !Number.isInteger(v) ? (k === "kg" ? v : Math.round(v)) : v;
    return out;
  }

  function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }); res.end(JSON.stringify(obj)); }
  function body(req, limit = 1e5) {
    return new Promise((ok, no) => { const a = []; let n = 0; req.on("data", c => { n += c.length; if (n > limit) { no(new Error("너무 큽니다")); req.destroy(); } else a.push(c); }); req.on("end", () => ok(Buffer.concat(a))); req.on("error", no); });
  }
  function cleanSettings(b) {
    const out = { costBasis: BASES.includes(b.costBasis) ? b.costBasis : S.costBasis, channels: [] };
    for (const c of (Array.isArray(b.channels) ? b.channels : S.channels).slice(0, 8)) {
      const n = (k, lo, hi, d) => { const v = +c[k]; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
      out.channels.push({ key: String(c.key || "ch" + out.channels.length).replace(/[^\w-]/g, "").slice(0, 20) || "ch" + out.channels.length,
        name: String(c.name || "채널").slice(0, 30), feeRate: n("feeRate", 0, 60, 0), shipping: n("shipping", 0, 1e6, 0), packing: n("packing", 0, 1e6, 0),
        other: n("other", 0, 1e6, 0), ceilBasis: c.ceilBasis === "가락" ? "가락" : "소매", retailGap: n("retailGap", -100, 90, 0), garakUp: n("garakUp", -90, 500, 0), minMargin: n("minMargin", 0, 300, 0) });
    }
    if (!out.channels.length) out.channels = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.channels));
    return out;
  }

  async function handle(req, res, u) {
    const p = u.pathname;
    try {
      if (p === "/api/margin/data") {
        const b = build(u.searchParams.get("days"));
        return send(res, 200, { ...b, items: b.items.map(slim), daily: b.daily.map(slim), lots: undefined, lotCount: b.lots.length, itemDB: undefined, itemCount: b.itemDB.length });
      }
      if (p === "/api/margin/items") { refreshDB(); return send(res, 200, { items: Object.values(DB.items), days: Object.keys(DB.daily).length }); }
      if (p === "/api/margin/garak/status") return send(res, 200, garak.status());
      if (p === "/api/margin/garak/debug") return send(res, 200, { status: garak.status(), debug: garak.debug() });
      if (p === "/api/margin/garak/sync" && req.method === "POST") { refreshDB(); return send(res, 200, await garak.sync(true)); }
      if (p === "/api/margin/settings") {
        if (req.method === "POST") {
          const b = JSON.parse((await body(req)).toString("utf8") || "{}");
          if (b.reset) S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); else S = cleanSettings(b);
          save();
        }
        return send(res, 200, S);
      }
      if (p === "/api/margin/export.xlsx") {
        const b = build(u.searchParams.get("days"));
        b.calc = calc;
        const buf = buildXlsx(b);
        const name = `서원농산_마진계산_${b.today}.xlsx`;
        res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="margin_${b.today}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-cache" });
        return res.end(buf);
      }
      return send(res, 404, { error: "없는 주소" });
    } catch (e) {
      console.error("마진", e);
      return send(res, 400, { error: e.message });
    }
  }
  return { handle, build, calc, settings: () => S, garak, refreshDB };
};
module.exports.calc = calc;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
