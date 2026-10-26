/* 마진 계산 엑셀 만들기 — margin/template.xlsx(수식·그래프·서식, build_template.py 가 만든 것)를 열어
   설정 칸·품목요약·일별데이터·낙찰원장에 자료를 채워 새 xlsx 로 돌려준다. 외부 라이브러리 없음(zlib 만).
   - 수식은 계산 값 없이 넣고 workbook 의 fullCalcOnLoad 로 엑셀·구글 시트·LibreOffice 가 열 때 다시 계산한다.
   - 품목요약 그래프 범위는 실제 줄 수로 줄이고, 품목 이름 축은 글자(strRef)로 바꾼다. */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TPL = path.join(__dirname, "template.xlsx");
const META = JSON.parse(fs.readFileSync(path.join(__dirname, "template.json"), "utf8"));

/* ---------- zip 읽기·쓰기 (저장·deflate 만) ---------- */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("zip 이 아닙니다");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString("utf8");
    const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nl + el + cl;
  }
  return files;
}
const CRC = (() => { const t = new Int32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(files) {
  const parts = [], cen = [];
  let off = 0;
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5);
  for (const [name, raw] of files) {
    const nb = Buffer.from(name, "utf8"), data = zlib.deflateRawSync(raw, { level: 6 }), crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(tm, 10); h.writeUInt16LE(dt, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, nb, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(tm, 12); c.writeUInt16LE(dt, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nb);
    off += 30 + nb.length + data.length;
  }
  const cbuf = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.size, 8); e.writeUInt16LE(files.size, 10); e.writeUInt32LE(cbuf.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cbuf, e]);
}

/* ---------- 칸 만들기 ---------- */
const xesc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
function colName(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; }
function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
const serial = ymd => { const [y, m, d] = ymd.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
/* v: number | string | {f: 수식} | {d: 'YYYY-MM-DD'} | null */
function cellXml(ref, s, v) {
  const sa = s != null ? ` s="${s}"` : "";
  if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return `<c r="${ref}"${sa}/>`;
  if (typeof v === "number") return `<c r="${ref}"${sa}><v>${+v.toFixed(6)}</v></c>`;
  if (v.f != null) return `<c r="${ref}"${sa}><f>${xesc(v.f)}</f></c>`;
  if (v.d != null) return `<c r="${ref}"${sa}><v>${serial(v.d)}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
}
/* 이미 있는 칸(템플릿에서 서식을 준 칸)의 값을 바꾼다 — 서식(s)은 그대로 */
function setCell(xml, ref, v) {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = xml.match(re);
  if (!m) throw new Error(`템플릿에 ${ref} 칸이 없습니다`);
  const s = (m[1].match(/ s="(\d+)"/) || [])[1];
  return xml.replace(re, cellXml(ref, s, v));
}
/* 2행(본보기 줄)의 서식을 읽어 2행부터 rows 로 바꾼다 */
function fillRows(xml, rows, lastCol) {
  const r2 = xml.match(/<row r="2"[^>]*>([\s\S]*?)<\/row>/);
  const styles = {};
  if (r2) for (const m of r2[1].matchAll(/<c r="([A-Z]+)2"[^>]*? s="(\d+)"/g)) styles[m[1]] = m[2];
  const body = rows.map((cells, i) => {
    const r = i + 2;
    return `<row r="${r}">` + cells.map((v, j) => { const c = colName(j + 1); return cellXml(c + r, styles[c], v); }).join("") + `</row>`;
  }).join("");
  xml = xml.replace(/<row r="2"[^>]*>[\s\S]*?<\/row>/, "").replace("</sheetData>", body + "</sheetData>");
  const last = Math.max(2, rows.length + 1);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${lastCol}${last}"/>`);
  xml = xml.replace(/<autoFilter ref="([A-Z]+)1:([A-Z]+)1"/, `<autoFilter ref="$11:$2${last}"`);
  return xml;
}

module.exports = function buildXlsx(b) {
  const files = unzip(fs.readFileSync(TPL));
  const sh = META.sheets;
  /* 시트 이름 → 파일 */
  const wbx = files.get("xl/workbook.xml").toString("utf8"), rels = files.get("xl/_rels/workbook.xml.rels").toString("utf8");
  const sheetFile = {};
  for (const m of wbx.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const t = rels.match(new RegExp(`Target="([^"]+)" Id="${m[2]}"`)) || rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`));
    sheetFile[m[1]] = t[1].replace(/^\//, "").replace(/^(?!xl\/)/, "xl/");
  }
  const get = name => files.get(sheetFile[name]).toString("utf8");
  const put = (name, xml) => files.set(sheetFile[name], Buffer.from(xml, "utf8"));
  const S = b.settings, chs = S.channels.slice(0, 8);
  const items = b.items;

  /* 설정 */
  let x = get(sh.settings);
  for (let i = 0; i < 8; i++) {
    const c = chs[i], r = 4 + i;
    const vals = c ? [c.name, c.feeRate, c.shipping, c.packing, c.other, c.ceilBasis, c.retailGap, c.garakUp, c.minMargin] : Array(9).fill(null);
    vals.forEach((v, j) => { x = setCell(x, colName(j + 1) + r, v); });
  }
  x = setCell(x, "C13", S.costBasis);
  x = setCell(x, "B15", `${b.xs[0]} ~ ${b.xs[b.xs.length - 1]} (${b.days}일) · 낙찰 ${b.lots.length}줄 · 품목 ${items.length}개`);
  x = setCell(x, "B16", new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " (한국 시간)");
  x = setCell(x, "B17", b.mock ? "시험용 가짜 시세입니다 (PRICES_MOCK=1) — 실제 시세가 아닙니다" :
    `공영도매시장 경락가 ${b.source.wholesaleDays}일치 · 지역 소매가 ${b.source.retailDays}일치${b.source.keys && !b.source.keys.dataGoKr ? " (도매 인증키 없음)" : ""}${b.source.keys && !b.source.keys.kamis ? " (소매 인증키 없음)" : ""}`);
  put(sh.settings, x);

  /* 계산기 기본 선택 */
  x = get(sh.calc);
  const first = items.find(i => i.garakKg7 || i.retailKg) || items[0];
  x = setCell(x, "C4", first ? first.label : null);
  x = setCell(x, "C5", chs[0] ? chs[0].name : null);
  x = setCell(x, "C6", S.costBasis);
  put(sh.calc, x);

  /* 품목요약 */
  const F = META.summaryFormulas;
  const fcols = Object.keys(F).sort((a, c) => colNum(a) - colNum(c));
  const lastSumCol = fcols[fcols.length - 1];
  const rows = items.slice(0, META.summaryRows).map((it, i) => {
    const r = i + 2;
    const v = [it.label, it.group ? it.name : "(시세 없음) " + it.name, it.grade, it.kg, { d: it.lastDate }, it.lastBox, it.avg7Box, it.max7Box, it.avgBox,
      it.minPrice, it.maxPrice, it.qty, it.amt, it.garakKg7, it.natKg7, it.retailKg];
    while (v.length < colNum(lastSumCol)) v.push(null);
    for (const c of fcols) v[colNum(c) - 1] = { f: F[c].replace(/\{r\}/g, r) };
    return v;
  });
  put(sh.summary, fillRows(get(sh.summary), rows, lastSumCol));
  const lastSum = Math.max(2, rows.length + 1);

  /* 일별데이터 */
  const drows = b.daily.map(d => [{ d: d.date }, d.label, d.grade, d.kg, d.qty, d.avgBox, d.minBox, d.maxBox, d.amt,
    d.garakKg, d.garakMn, d.garakMx, d.garakQ, d.natKg, d.retailKg, d.garakKg ? d.garakKg * d.kg : null, d.garakKg && d.avgBox ? d.garakKg * d.kg - d.avgBox : null,
    d.garakSrc === "가락공사" ? "가락시장 공식" : d.garakSrc === "aT" ? "aT 서울가락" : null]);
  put(sh.daily, fillRows(get(sh.daily), drows, "R"));

  /* 품목DB */
  const mk = (it, re) => Object.entries(it.mkt || {}).filter(([m]) => re.test(m)).reduce((a, [, q]) => a + q, 0);
  const irows = (b.itemDB || []).slice().sort((a, c) => c.qty - a.qty).map(it => [it.name, it.group ? it.name : "(시세 없음)", it.grade,
    Object.entries(it.kgs).sort((a, c) => c[1] - a[1]).map(([kg, q]) => `${kg}kg ${q}`).join(" · "), { d: it.first }, { d: it.last }, it.days, it.qty, it.amt,
    it.qty ? it.amt / it.qty : null, mk(it, /서울/), mk(it, /동화/), "모음"]);
  put(sh.itemdb, fillRows(get(sh.itemdb), irows, "M"));

  /* 낙찰원장 */
  const lrows = b.lots.map(l => [{ d: l.date }, l.mkt, l.no, l.item, l.name, l.who, l.unit, l.grade, l.kg, l.qty, l.price, l.amt]);
  put(sh.lots, fillRows(get(sh.lots), lrows, "L"));

  /* 그래프: 품목요약 범위를 실제 줄 수로, 품목 축은 글자로 */
  const sumQ = `'${sh.summary}'!`;
  for (const [name, buf] of files) {
    if (!/^xl\/charts\/chart\d+\.xml$/.test(name)) continue;
    let c = buf.toString("utf8");
    if (!c.includes(sumQ)) continue;
    c = c.replace(/<cat><numRef><f>([^<]*)<\/f><\/numRef><\/cat>/g, "<cat><strRef><f>$1</f></strRef></cat>");
    c = c.replace(new RegExp(`(${sumQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\$[A-Z]+\\$2:\\$[A-Z]+\\$)${META.summaryRows + 1}`, "g"), `$1${lastSum}`);
    files.set(name, Buffer.from(c, "utf8"));
  }
  return zip(files);
};
module.exports._test = { unzip, zip, setCell, fillRows, serial };
