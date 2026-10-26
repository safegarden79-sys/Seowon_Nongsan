/* 가격 화면 공통 — 자료 받기, 숫자 표시, 선 그래프(SVG) */
const PX = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const won = n => (n == null || !isFinite(n)) ? "—" : Math.round(n).toLocaleString("ko-KR");
  const r100 = n => Math.ceil(n / 100) * 100;
  async function j(url, opt) { const r = await fetch(url, opt); const t = await r.json(); if (!r.ok) throw new Error(t.error || r.status); return t; }
  const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function weekStart(s) { const d = new Date(s + "T00:00:00Z"); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); return d.toISOString().slice(0, 10); }
  const md = s => s.slice(5).replace("-", "/");
  const ago = t => { if (!t) return "없음"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "방금" : m < 60 ? m + "분 전" : m < 1440 ? Math.round(m / 60) + "시간 전" : Math.round(m / 1440) + "일 전"; };

  function nav(on) {
    const links = [["index.html", "가격 정보"], ["wholesale.html", "공영도매시장 추이"], ["retail.html", "지역별 소매가격"], ["school.html", "급식 납품 단가"]];
    document.body.insertAdjacentHTML("afterbegin",
      `<header class="top"><a class="home" href="/">← SEOWONY</a><nav>${links.map(([h, t]) => `<a href="${h}" class="${h === on ? "on" : ""}">${t}</a>`).join("")}</nav></header>`);
  }
  function banners(st, el) {
    const b = [];
    if (st.mock) b.push(`<div class="banner mock">시험용 가짜 자료입니다 (PRICES_MOCK=1). 실제 시세가 아닙니다.</div>`);
    return el.innerHTML = b.join("");
  }

  /* 선 그래프: series=[{name,color,dash,points:[[x문자열,y]]}], xs=x축 문자열 순서 */
  function lineChart(el, { series, xs, yFmt = won, h = 260 }) {
    const W = Math.max(320, el.clientWidth || 600), H = h, L = 58, R = 12, T = 12, B = 28;
    const vals = series.flatMap(s => s.points.map(p => p[1])).filter(v => isFinite(v));
    if (!vals.length || !xs.length) { el.innerHTML = `<div class="empty">아직 자료가 없습니다</div>`; return; }
    let mn = Math.min(...vals), mx = Math.max(...vals); const pad = (mx - mn) * 0.12 || mx * 0.1 || 1; mn -= pad; mx += pad;
    const X = i => L + (W - L - R) * (xs.length === 1 ? 0.5 : i / (xs.length - 1));
    const Y = v => T + (H - T - B) * (1 - (v - mn) / (mx - mn));
    const idx = Object.fromEntries(xs.map((x, i) => [x, i]));
    let g = "";
    for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4, y = Y(v); g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#E7EEE3"/><text x="${L - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#7A857D">${yFmt(v)}</text>`; }
    const step = Math.max(1, Math.ceil(xs.length / Math.floor((W - L) / 56)));
    xs.forEach((x, i) => { if (i % step === 0 || i === xs.length - 1) g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#7A857D">${md(x)}</text>`; });
    for (const s of series) {
      const pts = s.points.filter(p => idx[p[0]] != null && isFinite(p[1])).sort((a, b) => idx[a[0]] - idx[b[0]]);
      if (!pts.length) continue;
      g += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.w || 2.2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round" points="${pts.map(p => X(idx[p[0]]) + "," + Y(p[1])).join(" ")}"/>`;
      for (const p of pts) g += `<circle cx="${X(idx[p[0]])}" cy="${Y(p[1])}" r="${pts.length > 40 ? 1.6 : 2.6}" fill="${s.color}"><title>${esc(s.name)} ${md(p[0])}: ${yFmt(p[1])}</title></circle>`;
    }
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="가격 추이 그래프">${g}</svg>
      <div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
  }
  /* 낮음(연두) → 높음(주황) */
  function heat(v, mn, mx) {
    if (!isFinite(v)) return "#fff";
    const t = mx > mn ? (v - mn) / (mx - mn) : 0.5;
    const a = [226, 241, 214], b = [255, 214, 170], c = [246, 150, 110];
    const mix = (p, q, u) => p.map((x, i) => Math.round(x + (q[i] - x) * u));
    const col = t < 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2);
    return `rgb(${col.join(",")})`;
  }
  const COLORS = ["#2F7A34", "#D9472B", "#1F6FB2", "#A87700", "#7A3FB0", "#0E8C8C", "#C2185B", "#5D6B2F"];
  return { $, esc, won, r100, j, kstToday, addDays, weekStart, md, ago, nav, banners, lineChart, heat, COLORS };
})();
