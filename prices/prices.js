/* 서원농산 — 도·소매·경락 단가 연동 (외부 라이브러리 없음)

   ① 도매(경락가)  aT '전국 공영도매시장 정산정보' (data.go.kr 15141809) — 등급(특·상)·최저·최고가 있고 1년 넘게 지난 날도 조회됨
                   https://apis.data.go.kr/B552845/katSale/trades  (시장 코드 필수 → WS_MARKETS 32곳 × 대분류 12·13)
                   환경변수 DATA_GO_KR_KEY  (공공데이터포털 '일반 인증키' — Decoding 값 권장, Encoding 값도 받음)
   ② 소매          KAMIS Open API  dailyPriceByCategoryList (채소류 200, 지역별)
                   환경변수 KAMIS_CERT_KEY, KAMIS_CERT_ID
   ③ 급식 납품 단가 공개 API 가 없어 CSV 파일(공공데이터포털 파일데이터)을 올려 연동한다.

   자료는 DATA_DIR/prices.json 하나에 쌓는다. 서버가 30분마다 깨어나 필요한 날짜만 받아 온다.
   시험할 때는 PRICES_MOCK=1 로 켜면 '시험용 가짜 자료'를 만들어 화면을 확인할 수 있다(화면에 빨간 띠가 뜬다). */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

/* ---------- 품목 정의 ----------
   group = 시세를 모으는 단위(아삭이 10kg·팩은 같은 시세를 쓴다), box = 박스 중량(kg) */
const GROUPS = [
  { key: "cheongyang",     name: "청양고추" },
  { key: "hongcheongyang", name: "홍청양고추" },
  { key: "putgochu",       name: "풋고추(녹광)" },
  { key: "hongcho",        name: "홍초(홍고추)" },
  { key: "kkwari",         name: "꽈리고추" },
  { key: "asak",           name: "아삭이(오이맛)고추" },
  { key: "paprikaRed",     name: "빨강 파프리카" },
  { key: "paprikaYellow",  name: "노랑 파프리카" },
  { key: "pimang",         name: "피망" },
  { key: "hongpimang",     name: "홍피망" },
];
const SKUS = [
  { key: "cheongyang",     name: "청양고추",        group: "cheongyang",     box: 10 },
  { key: "hongcheongyang", name: "홍청양고추",      group: "hongcheongyang", box: 10 },
  { key: "putgochu",       name: "풋고추",          group: "putgochu",       box: 10 },
  { key: "hongcho",        name: "홍초",            group: "hongcho",        box: 10 },
  { key: "kkwari",         name: "꽈리고추",        group: "kkwari",         box: 10 },
  { key: "asak10",         name: "아삭이고추 10kg", group: "asak",           box: 10 },
  { key: "asakpack",       name: "아삭이고추 팩",   group: "asak",           box: 3.6 },
  { key: "paprikaRed",     name: "빨강 파프리카",   group: "paprikaRed",     box: 5 },
  { key: "paprikaYellow",  name: "노랑 파프리카",   group: "paprikaYellow",  box: 5 },
  { key: "pimang",         name: "피망",            group: "pimang",         box: 10 },
  { key: "hongpimang",     name: "홍피망",          group: "hongpimang",     box: 10 },
];

/* 이름(품목·품종 글자를 이어붙인 것)으로 우리 품목을 찾는다. 위에서부터 먼저 맞는 것. */
function matchGroup(t) {
  t = String(t || "").replace(/\s+/g, "");
  if (!t) return null;
  if (/파프리카/.test(t)) {
    if (/노랑|노란|황색|옐로|yellow/i.test(t)) return "paprikaYellow";
    if (/빨강|빨간|적색|홍|레드|red/i.test(t)) return "paprikaRed";
    return null;                                         // 주황·혼합 등은 뺀다
  }
  if (/피망/.test(t)) return /홍|적|빨/.test(t) ? "hongpimang" : "pimang";
  if (!/고추/.test(t)) return null;
  if (/고춧가루|건고추|화건|태양초|말린/.test(t)) return null;
  if (/청양/.test(t)) return /홍|붉은|적/.test(t) ? "hongcheongyang" : "cheongyang";
  if (/꽈리/.test(t)) return "kkwari";
  if (/아삭|오이맛|오이고추/.test(t)) return "asak";
  if (/홍고추|붉은고추|홍초|고추\(홍\)|홍\)/.test(t)) return "hongcho";
  if (/녹광|풋고추|고추\(풋\)|일반풋/.test(t)) return "putgochu";
  return null;
}
function matchGrade(g) {
  g = String(g || "").replace(/\s+/g, "");
  if (/^특|특품|특등/.test(g)) return "특";
  if (/^상$|^상품$|^상등|^상\(/.test(g)) return "상";
  return null;
}

/* 소매(KAMIS) 품목 → 우리 품목. 소매 조사에 없는 품목은 가까운 품목을 '대신' 쓰고 화면에 표시한다. */
const RETAIL_PROXY = {
  cheongyang:     { re: /청양/,            proxy: false },
  hongcheongyang: { re: /붉은고추/,         proxy: "붉은고추" },
  putgochu:       { re: /^풋고추|녹광/,     proxy: false },     // 청양·꽈리·오이맛 품종은 아래에서 뺀다
  hongcho:        { re: /붉은고추/,         proxy: false },
  kkwari:         { re: /꽈리/,            proxy: false },
  asak:           { re: /오이맛|오이고추/,   proxy: false },    // 그냥 '오이'(채소)는 제외
  paprikaRed:     { re: /파프리카/,         proxy: "파프리카(색 구분 없음)" },
  paprikaYellow:  { re: /파프리카/,         proxy: "파프리카(색 구분 없음)" },
  pimang:         { re: /피망/,            proxy: false },
  hongpimang:     { re: /피망/,            proxy: "피망(청)" },
};
/* KAMIS 소매 조사 지역 — 코드표(KAMIS 첨부 '지역코드')와 다르면 그 지역은 빈칸으로 남고 화면에서 빠진다 */
const DEFAULT_REGIONS = [
  ["1101", "서울"], ["2100", "부산"], ["2200", "대구"], ["2300", "인천"], ["2401", "광주"],
  ["2501", "대전"], ["2601", "울산"], ["3111", "수원"], ["3211", "춘천"], ["3311", "청주"],
  ["3511", "전주"], ["3711", "포항"], ["3814", "창원"], ["3613", "순천"], ["3714", "안동"], ["3911", "제주"],
];

/* 도매 경락가 = aT 전국 공영도매시장 '정산정보'(공공데이터포털 15141809, katSale). 실시간 경매정보(katRealTime2)는
   한 달치만 남고 등급 칸이 없어 특·상을 가를 수 없다. 정산정보는 시장 코드가 필수라 시장마다 부르고,
   우리 품목이 든 대분류(12 조미채소류 = 고추류, 13 양채류 = 피망·파프리카)만 받는다. */
const WS_URL = "https://apis.data.go.kr/B552845/katSale/trades";
const WS_CLASSES = ["12", "13"];
const WS_MARKETS = {
  "110001": "서울가락", "110008": "서울강서", "210001": "부산엄궁", "210009": "부산반여", "220001": "대구북부", "230001": "인천남촌",
  "230003": "인천삼산", "240001": "광주각화", "240004": "광주서부", "250001": "대전오정", "250003": "대전노은", "310101": "수원",
  "310401": "안양", "310901": "안산", "311201": "구리", "320101": "춘천", "320201": "원주", "320301": "강릉", "330101": "청주",
  "330201": "충주", "340101": "천안", "350101": "전주", "350301": "익산", "350402": "정읍", "360301": "순천", "370101": "포항",
  "370401": "안동", "371501": "구미", "380101": "창원팔용", "380201": "울산", "380303": "창원내서", "380401": "진주",
};
const KAMIS_URL = "http://www.kamis.or.kr/service/price/xml.do";
const KEEP_DAYS = 120;          // 날짜별 집계 보관 일수
const BACKFILL_DAYS = 28;       // 처음 켰을 때 거슬러 받는 일수
const MAX_PAGES = 20;           // 한 시장·한 대분류의 하루 정산 자료를 1,000줄씩 몇 쪽까지 받을지

/* ---------- 날짜 ---------- */
const kst = (t = Date.now()) => new Date(t + 9 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const todayKST = () => ymd(kst());
function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

/* ---------- 내려받기 ---------- */
function get(url, timeout = 25000, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const r = lib.get(url, { timeout, headers: { "User-Agent": "seowon-check/1.0", Accept: "application/json, text/xml, */*" } }, resp => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && hops < 3) {
        resp.resume();
        return get(new URL(resp.headers.location, url).toString(), timeout, hops + 1).then(resolve, reject);
      }
      const bufs = [];
      resp.on("data", d => bufs.push(d));
      resp.on("end", () => resolve({ status: resp.statusCode, body: Buffer.concat(bufs).toString("utf8") }));
    });
    r.on("timeout", () => r.destroy(new Error("응답 시간 초과")));
    r.on("error", reject);
  });
}
const num = v => { if (v == null) return NaN; const n = parseFloat(String(v).replace(/[,\s원]/g, "")); return isFinite(n) ? n : NaN; };
const encKey = k => /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k);   // Encoding 키는 그대로, Decoding 키는 인코딩
function parseJson(body, label) {
  try { return JSON.parse(body); }
  catch (e) {
    const m = body.match(/<returnAuthMsg>([^<]+)|<errMsg>([^<]+)|<resultMsg>([^<]+)/);
    throw new Error(label + " 응답이 JSON 이 아닙니다" + (m ? " — " + (m[1] || m[2] || m[3]) : ": " + body.slice(0, 160)));
  }
}
/* 응답 안에서 가장 큰 '객체 배열'을 찾는다 — 명세의 정확한 경로를 몰라도 자료 줄을 꺼낼 수 있게 */
function findItems(j) {
  let best = [];
  (function walk(o, depth) {
    if (!o || typeof o !== "object" || depth > 7) return;
    if (Array.isArray(o)) { if (o.length && typeof o[0] === "object" && !Array.isArray(o[0]) && o.length > best.length) best = o; o.forEach(x => walk(x, depth + 1)); return; }
    for (const v of Object.values(o)) walk(v, depth + 1);
  })(j, 0);
  if (!best.length) {     // item 이 한 줄이면 배열이 아니라 객체로 오는 API 가 있다
    const one = (function f(o, d) { if (!o || typeof o !== "object" || d > 7) return null; if (o.item && typeof o.item === "object" && !Array.isArray(o.item)) return [o.item]; for (const v of Object.values(o)) { const r = f(v, d + 1); if (r) return r; } return null; })(j, 0);
    if (one) best = one;
  }
  return best;
}
function findKey(j, re) {
  let out;
  (function walk(o, d) { if (out !== undefined || !o || typeof o !== "object" || d > 6) return; for (const [k, v] of Object.entries(o)) { if (re.test(k) && (typeof v !== "object")) { out = v; return; } walk(v, d + 1); } })(j, 0);
  return out;
}
const pickKey = (row, re, not) => Object.keys(row).find(k => re.test(k) && !(not && not.test(k)));

/* ---------- 상태 ---------- */
module.exports = function createPrices({ dir }) {
  const FILE = path.join(dir, "prices.json");
  const MOCK = process.env.PRICES_MOCK === "1";
  let S = {
    ws: { days: {}, learned: null, last: null, error: null, calls: {} },
    rt: { days: {}, last: null, error: null },
    school: { rows: [], files: [] },
    settings: { shipping: 0, packing: 0, feeRate: 0, minMargin: 10, retailGap: 10, costBasis: "max7", regions: DEFAULT_REGIONS },
    debug: {},
  };
  try { const saved = JSON.parse(fs.readFileSync(FILE, "utf8")); S = { ...S, ...saved, settings: { ...S.settings, ...(saved.settings || {}) } }; } catch (e) {}
  let dirty = false, saveTimer = null;
  function save() { dirty = true; if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; if (!dirty) return; dirty = false; try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(S)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("가격 자료 저장 실패", e.message); } }, 1500); }
  function prune(days) { const cut = addDays(todayKST(), -KEEP_DAYS); for (const d of Object.keys(days)) if (d < cut) delete days[d]; }
  function countCall(n = 1) { const d = todayKST(); S.ws.calls = { [d]: ((S.ws.calls || {})[d] || 0) + n }; }

  /* ---------- ① 도매 경락가 ---------- */
  function normWs(it) {
    const nameKeys = Object.keys(it).filter(k => /(gds_.*_nm|item_nm|prdlst_nm|kind_nm|vrty_nm|spcs_nm|cmdt_nm|std_.*_nm)$/i.test(k));
    const name = nameKeys.map(k => it[k]).join(" ");
    const group = matchGroup(name);
    if (!group) return null;
    const gk = pickKey(it, /grd_nm|grade_nm|^grd$|grade$/i);
    const grade = matchGrade(gk ? it[gk] : "");
    if (!grade) return { group, grade: null };
    const mk0 = pickKey(it, /whsl_mrkt_nm|mrkt_nm|market/i), mc0 = pickKey(it, /whsl_mrkt_cd/i);
    const mcd0 = it[pickKey(it, /gds_mclsf_cd/i)] || null, mnm0 = it[pickKey(it, /gds_mclsf_nm/i)] || null;
    /* 정산정보: 한 줄 = 그날 그 시장·품목·등급·규격의 합계. kg당 = 총가격 ÷ 단위총물량(kg), 거래량 = 단위총물량 */
    if (it.totprc != null && it.unit_tot_qty != null) {
      let f = 1; const u = String(it.unit_nm || "kg").trim();
      if (/^g$|그램/i.test(u)) f = 1 / 1000; else if (!/kg|키로|킬로/i.test(u)) return { group, grade, bad: true, mcd: mcd0, mnm: mnm0 };
      const kgTot = num(it.unit_tot_qty) * f, tot = num(it.totprc), uq = num(it.unit_qty) * f;
      const market = String((mk0 && it[mk0]) || (mc0 && it[mc0]) || "미상").trim();
      if (!(kgTot > 0) || !(tot > 0)) return { group, grade, bad: true, mcd: mcd0, mnm: mnm0 };
      const perKg = tot / kgTot;
      if (perKg < 50 || perKg > 200000) return { group, grade, bad: true, mcd: mcd0, mnm: mnm0 };
      const lo = uq > 0 ? num(it.lwprc) / uq : NaN, hi = uq > 0 ? num(it.hgprc) / uq : NaN;
      return { group, grade, market, perKg, qty: kgTot, lo: lo > 0 ? lo : perKg, hi: hi > 0 ? hi : perKg, mcd: mcd0, mnm: mnm0 };
    }
    const pk = pickKey(it, /scsbd_prc|scsbd_amt/i) || pickKey(it, /_prc$|price|_pr$/i, /unit|avg/i);
    const price = num(it[pk]);
    const uq = pickKey(it, /unit_qty|unit_wght|wght|weight/i);
    const un = pickKey(it, /unit_nm|unit$/i, /qty|cd$/i);
    let kg = num(uq ? it[uq] : NaN);
    const unitName = un ? String(it[un]) : "kg";
    if (/^g$|그램/i.test(unitName.trim())) kg = kg / 1000;
    else if (!/kg|키로|킬로/i.test(unitName)) { const m = unitName.match(/([\d.]+)\s*(kg|g)/i); if (m) kg = num(m[1]) / (m[2].toLowerCase() === "g" ? 1000 : 1); }
    const qk = pickKey(it, /^qty$|scsbd_qty|trd_qty|_qty$|_cnt$/i, /unit/i);
    const qty = Math.max(1, num(qk ? it[qk] : 1) || 1);
    const mk = pickKey(it, /whsl_mrkt_nm|mrkt_nm|market/i);
    const mc = pickKey(it, /whsl_mrkt_cd/i);
    const market = String((mk && it[mk]) || (mc && it[mc]) || "미상").trim();
    const mcd = it[pickKey(it, /gds_mclsf_cd/i)] || null;
    const mnm = it[pickKey(it, /gds_mclsf_nm/i)] || null;
    if (!(price > 0) || !(kg > 0)) return { group, grade, bad: true, mcd, mnm };
    const perKg = price / kg;
    if (perKg < 50 || perKg > 200000) return { group, grade, bad: true, mcd, mnm };
    return { group, grade, market, perKg, qty, mcd, mnm };
  }
  function addAgg(agg, n) {
    const g = (agg[n.group] ||= {}), r = (g[n.grade] ||= {}), m = (r[n.market] ||= { q: 0, s: 0, mn: Infinity, mx: 0, n: 0 });
    m.q += n.qty; m.s += n.perKg * n.qty; m.n++; m.mn = Math.min(m.mn, n.lo ?? n.perKg); m.mx = Math.max(m.mx, n.hi ?? n.perKg);
  }
  function roundAgg(agg) {
    for (const g of Object.values(agg)) for (const r of Object.values(g)) for (const m of Object.values(r)) {
      m.avg = Math.round(m.s / m.q); m.mn = Math.round(m.mn); m.mx = Math.round(m.mx); m.s = Math.round(m.s);
    }
    return agg;
  }
  async function getRetry(url, tries = 4) {
    let last;
    for (let t = 0; t < tries; t++) {
      try { return await get(url, 60000); } catch (e) { last = e; await new Promise(r => setTimeout(r, 1500 * (t + 1))); }
    }
    throw last;
  }
  async function fetchWsDay(date) {
    const key = process.env.DATA_GO_KR_KEY;
    if (!key) throw new Error("DATA_GO_KR_KEY 가 없습니다");
    const agg = {};
    let rows = 0, matched = 0, calls = 0, failed = 0;
    for (const mcd of Object.keys(WS_MARKETS)) {
      for (const lc of WS_CLASSES) {
        try {
          for (let page = 1; page <= MAX_PAGES; page++) {
            const q = new URLSearchParams({ pageNo: String(page), numOfRows: "1000", returnType: "json" });
            q.set("cond[whsl_mrkt_cd::EQ]", mcd);
            q.set("cond[trd_clcln_ymd::EQ]", date);
            q.set("cond[gds_lclsf_cd::EQ]", lc);
            const r = await getRetry(WS_URL + "?serviceKey=" + encKey(key) + "&" + q.toString());
            calls++; countCall();
            if (r.status >= 400) throw new Error("경락가 API HTTP " + r.status + " " + r.body.slice(0, 120));
            const j = parseJson(r.body, "경락가 API");
            const rc = findKey(j, /^resultCode$/i);
            if (rc != null && !/^0+$|^INFO-0+$/.test(String(rc))) throw new Error("경락가 API 오류 " + rc + " " + (findKey(j, /^resultMsg$/i) || ""));
            const items = findItems(j);
            const total = num(findKey(j, /^totalCount$/i));
            if (items[0] && mcd === "110001" && page === 1) { S.debug.wsKeys = Object.keys(items[0]); S.debug.wsSample = items[0]; S.debug.wsAt = Date.now(); }
            for (const it of items) {
              rows++;
              const n = normWs(it);
              if (!n || !n.grade || n.bad) continue;
              matched++; addAgg(agg, n);
            }
            if (items.length < 1000 || (total > 0 && page * 1000 >= total)) break;
          }
        } catch (e) {
          if (/SERVICE_KEY|인증|등록되지/.test(e.message)) throw e;      // 키 문제면 그날 전체를 멈춘다
          failed++; S.debug.wsLastFail = { date, mcd, lc, msg: e.message, at: Date.now() };
        }
      }
    }
    if (failed > Object.keys(WS_MARKETS).length) throw new Error(`경락가 API 실패가 너무 많습니다 (${failed}건)`);
    return { agg: roundAgg(agg), rows, matched, calls, failed };
  }

  /* ---------- ② 소매 KAMIS ---------- */
  function parseUnit(u) {
    const m = String(u || "").replace(/\s/g, "").match(/^([\d.]+)?(kg|g|개|마리|포기|단|봉|구)$/i);
    if (!m) return null;
    const n = m[1] ? num(m[1]) : 1;
    if (/^kg$/i.test(m[2])) return { kg: n };
    if (/^g$/i.test(m[2])) return { kg: n / 1000 };
    return { each: n, word: m[2] };
  }
  async function fetchRtDay(date) {
    const key = process.env.KAMIS_CERT_KEY, id = process.env.KAMIS_CERT_ID;
    if (!key || !id) throw new Error("KAMIS_CERT_KEY / KAMIS_CERT_ID 가 없습니다");
    const out = {};
    let calls = 0;
    for (const [code, rname] of S.settings.regions || DEFAULT_REGIONS) {
      const q = new URLSearchParams({
        action: "dailyPriceByCategoryList", p_cert_key: key, p_cert_id: id, p_returntype: "json",
        p_product_cls_code: "01", p_item_category_code: "200", p_country_code: code, p_regday: date, p_convert_kg_yn: "N",
      });
      const r = await get(KAMIS_URL + "?" + q.toString()); calls++;
      let j; try { j = parseJson(r.body, "KAMIS"); } catch (e) { S.rt.lastRegionError = rname + ": " + e.message; continue; }
      const err = findKey(j, /^error_code$/i);
      if (err && err !== "000") { if (err === "900") throw new Error("KAMIS 인증 실패(900) — 인증키·아이디를 확인하세요"); continue; }
      const items = findItems(j);
      if (items[0] && !S.debug.rtKeys) { S.debug.rtKeys = Object.keys(items[0]); S.debug.rtSample = items[0]; }
      for (const it of items) {
        const label = `${it.item_name || ""} ${it.kind_name || ""}`.trim();
        const rank = String(it.rank || "").trim();
        const p = num(it.dpr1);
        if (!(p > 0)) continue;
        for (const [g, def] of Object.entries(RETAIL_PROXY)) {
          if (!def.re.test(label)) continue;
          if (g === "putgochu" && /청양|꽈리|오이/.test(label)) continue;
          const u = parseUnit(it.unit);
          const row = { label, rank, unit: it.unit, price: p, w: num(it.dpr3) || null, m: num(it.dpr5) || null, y: num(it.dpr6) || null, avg: num(it.dpr7) || null };
          if (u && u.kg) row.perKg = Math.round(p / u.kg);
          ((out[code] ||= { name: rname, items: {} }).items[g] ||= []).push(row);
        }
      }
    }
    return { regions: out, calls };
  }

  /* ---------- ③ 급식 납품 단가 CSV ---------- */
  function decodeCsv(buf) {
    let t = buf.toString("utf8");
    if ((t.match(/�/g) || []).length > 3) { try { t = new TextDecoder("euc-kr").decode(buf); } catch (e) {} }
    return t.replace(/^﻿/, "");
  }
  function parseCsv(t) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c !== "\r") cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }
  function specKg(s) {
    const m = String(s || "").replace(/\s/g, "").match(/([\d.]+)\s*(kg|㎏|키로|g)/i);
    if (!m) return null;
    return num(m[1]) / (/^g$/i.test(m[2]) ? 1000 : 1);
  }
  function importSchool(buf, filename) {
    const rows = parseCsv(decodeCsv(buf));
    if (rows.length < 2) throw new Error("CSV 에 자료 줄이 없습니다");
    const head = rows[0].map(h => h.trim());
    const col = re => head.findIndex(h => re.test(h));
    const ci = {
      name: col(/식품명|상세식품명|품명|품목명|상품명|식재료/),
      spec: col(/규격|단위|포장/),
      price: col(/^단가|단가\(원\)|계약단가|낙찰단가|견적단가/),
      qty: col(/수량/),
      date: col(/견적일|계약일|일자|납품일|날짜/),
      region: col(/지역|시군|시도|학교|구매사|기관/),
    };
    if (ci.name < 0 || ci.price < 0) throw new Error("식품명·단가 열을 찾지 못했습니다. 첫 줄 머리글: " + head.join(", "));
    let added = 0, matched = 0;
    const src = (filename || "업로드").slice(0, 80);
    S.school.rows = S.school.rows.filter(r => r.src !== src);            // 같은 파일을 다시 올리면 바꿔 넣는다
    for (const r of rows.slice(1)) {
      const name = r[ci.name] || "";
      const spec = ci.spec >= 0 ? r[ci.spec] : "";
      const group = matchGroup(name + " " + spec);
      if (!group) continue;
      matched++;
      const price = num(r[ci.price]);
      if (!(price > 0)) continue;
      const kg = specKg(spec) || specKg(name);
      const date = ci.date >= 0 ? String(r[ci.date]).replace(/[./]/g, "-").slice(0, 10) : "";
      S.school.rows.push({ src, group, name: name.trim(), spec: String(spec).trim(), price, kg: kg || null, perKg: kg ? Math.round(price / kg) : null,
        qty: ci.qty >= 0 ? num(r[ci.qty]) || null : null, date, region: ci.region >= 0 ? String(r[ci.region]).trim() : "" });
      added++;
    }
    S.school.files = [...(S.school.files || []).filter(f => f.name !== src), { name: src, at: Date.now(), rows: rows.length - 1, matched, added, columns: head }];
    save();
    return { rows: rows.length - 1, matched, added, columns: head };
  }

  /* ---------- 시험용 가짜 자료 ---------- */
  function mockFill() {
    const markets = ["서울가락", "서울강서", "부산엄궁", "부산반여", "대구북부", "인천삼산", "광주각화", "대전오정", "울산", "수원", "청주", "전주", "창원팔용", "안동", "구리"];
    const base = { cheongyang: 2600, hongcheongyang: 3800, putgochu: 2400, hongcho: 3300, kkwari: 2300, asak: 2100, paprikaRed: 3900, paprikaYellow: 3700, pimang: 2500, hongpimang: 3600 };
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 70; i++) {
      const d = addDays(todayKST(), -i);
      const agg = {};
      for (const g of Object.keys(base)) {
        for (const grade of ["특", "상"]) {
          for (const mk of markets) {
            if (rnd() < 0.25) continue;
            const season = 1 + 0.18 * Math.sin((i + g.length * 3) / 9);
            const v = base[g] * (grade === "특" ? 1.35 : 1) * season * (0.88 + rnd() * 0.24);
            addAgg(agg, { group: g, grade, market: mk, perKg: v, qty: 5 + Math.round(rnd() * 60) });
          }
        }
      }
      S.ws.days[d] = { agg: roundAgg(agg), at: Date.now(), rows: 0, matched: 0, mock: true, final: true };
      const regions = {};
      for (const [code, rname] of DEFAULT_REGIONS.slice(0, 10)) {
        const items = {};
        for (const g of Object.keys(base)) {
          const p = Math.round(base[g] * 2.1 * (0.9 + rnd() * 0.3) / 10) * 10;
          items[g] = [{ label: g, rank: "상품", unit: "1kg", price: p, perKg: p, w: Math.round(p * 0.97), m: Math.round(p * 1.05), y: Math.round(p * 0.92), avg: Math.round(p * 0.98) }];
        }
        regions[code] = { name: rname, items };
      }
      S.rt.days[d] = { regions, at: Date.now(), mock: true };
    }
    S.ws.last = S.rt.last = Date.now(); S.mock = true;
  }

  /* ---------- 자동 동기화 ---------- */
  let busy = false;
  async function syncOnce(force) {
    if (busy) return { busy: true };
    busy = true;
    const done = [];
    try {
      const now = kst(), hour = now.getUTCHours(), today = todayKST();
      if (process.env.DATA_GO_KR_KEY) {
        try {
          const want = [];
          /* 오늘: 아침 6시 이후 3시간마다 / 어제: 마감 확정본이 없으면 / 지난 날: 빠진 날 하루 3개씩 */
          const t = S.ws.days[today];
          if (hour >= 6 && (force || !t || Date.now() - t.at > 3 * 3600e3)) want.push(today);
          const y = addDays(today, -1);
          if (!S.ws.days[y] || !S.ws.days[y].final) want.push(y);
          let back = 0;
          for (let i = 2; i <= BACKFILL_DAYS && back < 3; i++) { const d = addDays(today, -i); if (!S.ws.days[d]) { want.push(d); back++; } }
          for (const d of want) {
            const r = await fetchWsDay(d);
            S.ws.days[d] = { agg: r.agg, at: Date.now(), rows: r.rows, matched: r.matched, final: d < today && !r.failed, src: "katSale" };
            done.push(`도매 ${d} ${r.matched}/${r.rows}줄 (${r.calls}회 호출${r.failed ? `, 실패 ${r.failed}` : ""})`);
          }
          S.ws.last = Date.now(); S.ws.error = null; prune(S.ws.days);
        } catch (e) { S.ws.error = { msg: e.message, at: Date.now() }; done.push("도매 오류: " + e.message); }
      }
      if (process.env.KAMIS_CERT_KEY && process.env.KAMIS_CERT_ID) {
        try {
          const want = [];
          if (hour >= 15 && (force || !S.rt.days[today] || Date.now() - S.rt.days[today].at > 6 * 3600e3)) want.push(today);
          let back = 0;
          for (let i = 1; i <= BACKFILL_DAYS && back < 4; i++) { const d = addDays(today, -i); if (!S.rt.days[d]) { want.push(d); back++; } }
          for (const d of want) {
            const r = await fetchRtDay(d);
            S.rt.days[d] = { regions: r.regions, at: Date.now() };
            done.push(`소매 ${d} ${Object.keys(r.regions).length}개 지역`);
          }
          S.rt.last = Date.now(); S.rt.error = null; prune(S.rt.days);
        } catch (e) { S.rt.error = { msg: e.message, at: Date.now() }; done.push("소매 오류: " + e.message); }
      }
    } finally { busy = false; S.lastSync = { at: Date.now(), done }; save(); }
    return { done };
  }
  function start() {
    if (MOCK) { mockFill(); save(); console.log("가격 연동: 시험용 가짜 자료 모드 (PRICES_MOCK=1)"); return; }
    if (S.mock) { S.ws.days = {}; S.rt.days = {}; S.mock = false; }          // 시험 자료가 남아 있으면 지운다
    for (const [d, v] of Object.entries(S.ws.days)) if (v.src !== "katSale") delete S.ws.days[d];   // 예전 실시간 API 자료(등급 없음)는 다시 받는다
    const ready = [process.env.DATA_GO_KR_KEY ? "경락가" : null, process.env.KAMIS_CERT_KEY ? "KAMIS" : null].filter(Boolean);
    console.log("가격 연동: " + (ready.length ? ready.join("·") + " 자동 수집 (30분마다 확인)" : "인증키가 없어 꺼져 있음 (DATA_GO_KR_KEY / KAMIS_CERT_KEY·KAMIS_CERT_ID)"));
    if (!ready.length) return;
    setTimeout(() => syncOnce().catch(e => console.error("가격 수집 오류", e.message)), 15000);
    setInterval(() => syncOnce().catch(e => console.error("가격 수집 오류", e.message)), 30 * 60e3);
  }

  /* ---------- 요청 처리 ---------- */
  function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }); res.end(JSON.stringify(obj)); }
  function body(req, limit = 20e6) {
    return new Promise((resolve, reject) => {
      const bufs = []; let n = 0;
      req.on("data", d => { n += d.length; if (n > limit) { reject(new Error("너무 큽니다")); req.destroy(); } else bufs.push(d); });
      req.on("end", () => resolve(Buffer.concat(bufs)));
      req.on("error", reject);
    });
  }
  function sliceDays(days, n) {
    const cut = addDays(todayKST(), -Math.max(1, Math.min(KEEP_DAYS, n || 56)));
    return Object.fromEntries(Object.entries(days).filter(([d]) => d >= cut).sort());
  }
  function status() {
    return {
      mock: MOCK || !!S.mock,
      keys: { dataGoKr: !!process.env.DATA_GO_KR_KEY, kamis: !!(process.env.KAMIS_CERT_KEY && process.env.KAMIS_CERT_ID) },
      wholesale: { days: Object.keys(S.ws.days).length, last: S.ws.last, error: S.ws.error, callsToday: (S.ws.calls || {})[todayKST()] || 0, learnedCodes: S.ws.learned ? S.ws.learned.names : null },
      retail: { days: Object.keys(S.rt.days).length, last: S.rt.last, error: S.rt.error, regionError: S.rt.lastRegionError || null },
      school: { rows: S.school.rows.length, files: S.school.files || [] },
      lastSync: S.lastSync || null, busy,
    };
  }

  async function handle(req, res, u) {
    const p = u.pathname;
    try {
      if (p === "/api/prices/status") return send(res, 200, status());
      if (p === "/api/prices/meta") return send(res, 200, { groups: GROUPS, skus: SKUS, retailProxy: Object.fromEntries(Object.entries(RETAIL_PROXY).map(([k, v]) => [k, v.proxy])), regions: S.settings.regions || DEFAULT_REGIONS });
      if (p === "/api/prices/wholesale") return send(res, 200, { mock: MOCK || !!S.mock, days: sliceDays(S.ws.days, num(u.searchParams.get("days"))) });
      if (p === "/api/prices/retail") return send(res, 200, { mock: MOCK || !!S.mock, days: sliceDays(S.rt.days, num(u.searchParams.get("days"))) });
      if (p === "/api/prices/school") return send(res, 200, S.school);
      if (p === "/api/prices/debug") return send(res, 200, S.debug);
      if (p === "/api/prices/settings") {
        if (req.method === "POST") {
          const b = JSON.parse((await body(req, 1e5)).toString("utf8") || "{}");
          for (const k of ["shipping", "packing", "feeRate", "minMargin", "retailGap"]) if (k in b && isFinite(+b[k])) S.settings[k] = +b[k];
          if (b.costBasis === "avg7" || b.costBasis === "max7") S.settings.costBasis = b.costBasis;
          save();
        }
        const { regions, ...rest } = S.settings;
        return send(res, 200, rest);
      }
      if (p === "/api/prices/sync" && req.method === "POST") {
        if (MOCK) return send(res, 200, { done: ["시험용 자료 모드라 받지 않았습니다"] });
        return send(res, 200, await syncOnce(true));
      }
      if (p === "/api/prices/school/import" && req.method === "POST") {
        const buf = await body(req);
        const name = decodeURIComponent(req.headers["x-filename"] || "업로드.csv");
        return send(res, 200, importSchool(buf, name));
      }
      if (p === "/api/prices/school/remove" && req.method === "POST") {
        const b = JSON.parse((await body(req, 1e4)).toString("utf8") || "{}");
        S.school.rows = S.school.rows.filter(r => r.src !== b.name);
        S.school.files = (S.school.files || []).filter(f => f.name !== b.name);
        save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "없는 주소" });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  /* 마진 계산(margin/margin.js)이 도매·소매 집계를 읽어 간다 */
  return { start, handle, status, raw: () => S, groups: GROUPS, skus: SKUS, matchGroup, matchGrade, _test: { matchGroup, matchGrade, normWs, parseCsv, importSchool, parseUnit, findItems, S: () => S } };
};
