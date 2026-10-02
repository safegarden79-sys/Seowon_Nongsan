"""
동화청과(donghwafp.com) 실시간 낙찰 수집
- 낙찰서(Successfull.aspx)는 Crystal Reports 뷰어가 iframe(bobjid_*) 안에
  낙찰 표를 그립니다. 글자가 표(table)가 아니라 좌표로 찍힌 <span> 들이라
  "같은 세로줄(x좌표)에 있는 글자는 같은 항목"이라는 규칙으로 줄을 복원합니다.
- 카테고리 선택(#ctlArea)은 비워 둡니다. 실제로 비워 두고 검색해도 그날 전체
  (피망·파프리카·고추 포함 모든 품목)가 한 번에 나오는 것을 확인했습니다 —
  카테고리 코드를 하나씩 맞출 필요가 없습니다.
"""
import re
import time
from datetime import datetime
from playwright.sync_api import sync_playwright
from common import lot_key, mark_and_filter_new, log, Pacer, in_active_window, wait_for_active
from seowon_bridge import query_dates, auction_date
# looks_logged_out() 은 seowon_bridge 가 제공하는 범용 판단 함수지만, 동화청과는 이미
# #ctlUserId 가 있는지로 정확히 판정하는 is_login_page() 가 있어 그걸 그대로 쓴다
# (looks_logged_out 은 그 함수가 없는 새 사이트를 붙일 때 참고용).

MKT = "동화청과"
LOGIN_URL = "https://www.donghwafp.com/web/contents/homepage_helper/member/login.aspx"
DATA_URL = "https://www.donghwafp.com/web/contents/wholesaler/Successfull.aspx"

# 각 칸의 가로 중심점(px) 범위. donghwafp.com 의 "낙찰서" 리포트 레이아웃을
# 실측해서 정했습니다. 사이트 쪽에서 레이아웃을 바꾸면 다시 측정해야 합니다.
COL_BOUNDS = [
    ("no",    0,   150),
    ("item",  150, 280),
    ("who",   280, 360),
    ("qty",   360, 415),
    ("grade", 415, 465),
    ("price", 465, 530),
    ("amt",   530, 600),
]


def classify(mid):
    for name, lo, hi in COL_BOUNDS:
        if lo <= mid < hi:
            return name
    return None


def login(page, uid, upw):
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    page.fill("#ctlUserId", uid)
    page.fill("#ctlPasswd", upw)
    page.click("#CPH_Content_ctlLoginBtn")
    page.wait_for_load_state("networkidle")


def is_login_page(page):
    try:
        return page.locator("#ctlUserId").count() > 0
    except Exception:
        return True


def read_report_rows(page):
    """현재 화면의 bobjid iframe 안 표를 좌표 기준으로 읽어 줄 단위로 복원한다."""
    data = page.evaluate(r"""
() => {
  const ifr = Array.from(document.querySelectorAll('iframe')).find(f => f.id && f.id.startsWith('bobjid'));
  if (!ifr) return null;
  const doc = ifr.contentDocument || ifr.contentWindow.document;
  const dateSpan = Array.from(doc.querySelectorAll('span'))
    .find(s => /^\d{4}\/\s*\d{2}\/\d{2}$/.test(s.textContent.trim()));
  const reportDate = dateSpan ? dateSpan.textContent.trim() : null;
  const spans = Array.from(doc.querySelectorAll('span')).map(el => {
    const txt = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!txt) return null;
    const r = el.getBoundingClientRect();
    return {txt, x: r.left, y: r.top, w: r.width};
  }).filter(Boolean);
  return {reportDate, spans};
}
""")
    if not data or not data.get("spans"):
        return [], None
    # y좌표(허용오차 4px)로 같은 줄끼리 묶는다
    rows_by_y = []
    for s in data["spans"]:
        placed = False
        for grp in rows_by_y:
            if abs(grp["y"] - s["y"]) <= 4:
                grp["items"].append(s)
                placed = True
                break
        if not placed:
            rows_by_y.append({"y": s["y"], "items": [s]})
    results = []
    for grp in rows_by_y:
        cells = {}
        for s in grp["items"]:
            mid = s["x"] + s["w"] / 2
            col = classify(mid)
            if col:
                cells[col] = s["txt"]
        no = cells.get("no", "")
        # 실제 낙찰 줄만 남긴다: 번호가 숫자(보통 6자리)이고 수량·단가가 있는 줄
        if re.fullmatch(r"\d{5,7}", no) and cells.get("qty") and cells.get("price"):
            results.append(cells)
    return results, data.get("reportDate")


def normalize_date(report_date):
    if not report_date:
        return datetime.now().strftime("%Y-%m-%d")
    m = re.match(r"(\d{4})/\s*(\d{2})/(\d{2})", report_date)
    if not m:
        return datetime.now().strftime("%Y-%m-%d")
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def search_date(page, date_str=None):
    """date_str 이 없으면 오늘, 있으면 그 날짜(YYYY-MM-DD)로 검색한다.
    백필 스크립트가 지난 날짜를 하나씩 조회할 때도 이 함수를 그대로 쓴다."""
    date_str = date_str or datetime.now().strftime("%Y-%m-%d")
    page.fill("#txtSearchDate", date_str)
    page.evaluate("document.querySelector('#ctlArea') && (document.querySelector('#ctlArea').value='')")
    page.click("#CPH_Content_ctlSearchBtn")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(800)  # 리포트 iframe 렌더링 대기


def fetch_rows(page, date_str=None):
    """date_str 이 없으면 오늘 낙찰을 읽고, 있으면 그 날짜의 낙찰을 읽는다
    (지난 날짜 백필용 — search_date 에 그대로 전달된다)."""
    if DATA_URL not in page.url:
        page.goto(DATA_URL, wait_until="domcontentloaded")
    if is_login_page(page):
        return None
    search_date(page, date_str)
    if is_login_page(page):
        return None
    raw_rows, report_date = read_report_rows(page)
    date = normalize_date(report_date) if date_str is None else date_str
    rows = []
    for c in raw_rows:
        qty_n = int(re.sub(r"[^\d]", "", c.get("qty", "")) or 0)
        price_n = int(re.sub(r"[^\d]", "", c.get("price", "")) or 0)
        row = {
            "mkt": MKT, "date": date, "no": c.get("no", ""),
            "item": c.get("item", ""), "who": c.get("who", ""),
            "unit": "", "grade": c.get("grade", ""),
            "qty": qty_n, "price": price_n,
        }
        row["id"] = lot_key(row["mkt"], row["date"], row["no"], row["qty"], row["price"])
        rows.append(row)
    return rows


def run(cfg, bridge):
    L = log(MKT)
    interval = cfg.get("poll_interval_sec", 2)
    pace = Pacer(interval)
    while True:
        wait_for_active(L)   # 비활성 시간대면 브라우저를 열지 않은 채 활성 시간대까지 기다린다
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=cfg.get("headless", True))
            page = browser.new_page()
            logged_in = False
            while in_active_window():
                pace.start()
                try:
                    if not logged_in:
                        login(page, cfg["dh_id"], cfg["dh_pw"])
                        logged_in = True
                        L("로그인 완료")
                    qd = query_dates(MKT)[0]              # 지금 사이트에 넣어야 할 조회 날짜
                    rows = fetch_rows(page, date_str=qd)
                    if rows is None:
                        bridge.heartbeat(MKT, "expired", msg="로그인 화면으로 돌아감", interval=interval)
                        logged_in = False
                        L(f"로그인이 풀린 것으로 보입니다 — {pace.fail():.0f}초 뒤 다시 로그인합니다")
                        continue
                    ad = auction_date(MKT, qd)             # 앱에 올릴 경매일(경매가 끝나는 날)
                    for r in rows:
                        r["date"] = ad
                        r["id"] = lot_key(r["mkt"], r["date"], r["no"], r["qty"], r["price"])
                    bridge.heartbeat(MKT, "ok", rows=len(rows), interval=interval)
                    new_rows = mark_and_filter_new(rows)
                    if new_rows:
                        L(f"새 낙찰 {len(new_rows)}줄 발견 — 전송: " +
                          ", ".join(f"{r['no']}({r['item']})" for r in new_rows))
                    bridge.send_lots(new_rows)
                except Exception as e:
                    bridge.heartbeat(MKT, "error", msg=str(e), interval=interval)
                    logged_in = False
                    L(f"오류: {e} — {pace.fail():.0f}초 뒤 재시도")
                    continue
                pace.ok()
            browser.close()
            L("비활성 시간대로 들어가 브라우저를 닫습니다 (활성 시간대가 되면 다시 엽니다)")


if __name__ == "__main__":
    import json, os
    from seowon_bridge import Bridge
    with open(os.path.join(os.path.dirname(__file__), "secrets.json"), "r", encoding="utf-8") as f:
        cfg = json.load(f)
    run(cfg, Bridge(cfg["server_url"], user=cfg.get("user", "수집기")))
