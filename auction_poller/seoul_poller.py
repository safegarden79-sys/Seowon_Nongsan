"""
서울청과(sfvc.co.kr) 실시간 낙찰 수집
- /mypage/auction.asp 는 단순한 HTML 표라서 requests 만으로 충분합니다.
- 이 화면 자체에는 날짜를 골라 넣는 기능이 없습니다(그냥 "오늘" 치만 보여줍니다) — 그래서
  query_dates("서울청과") 를 여러 날짜를 돌려받아도 실제로 사이트에 다시 요청하지는 않고,
  한 번 읽은 결과에 각 날짜에 대응하는 경매일(auction_date)을 붙여서 처리합니다. 자정 바로
  뒤 10분은 "어제"와 "오늘" 두 날짜가 모두 같은 경매일(오늘)로 합쳐지므로 결과가 중복 없이
  그대로 모입니다(id 가 같아지면 자동으로 하나로 묶입니다).
"""
import re, time
import requests
from bs4 import BeautifulSoup
from common import lot_key, mark_and_filter_new, log, wait_for_active
from seowon_bridge import query_dates, auction_date

MKT = "서울청과"
BASE = "https://www.sfvc.co.kr"
LOGIN_URL = BASE + "/membership/Login_Check.asp"
LOGIN_PAGE = BASE + "/membership/login.asp"
DATA_URL = BASE + "/mypage/auction.asp"


def login(session, uid, upass):
    data = {"confNo": "ok", "BACKURL": "", "log_flag": "", "uid": uid, "upass": upass}
    r = session.post(LOGIN_URL, data=data, timeout=10, headers={"Referer": LOGIN_PAGE})
    r.raise_for_status()
    return r


def is_logged_out(html):
    # 로그인 폼이 보이거나, 표 머리글(일련번호)이 없으면 로그인이 풀린 것으로 본다.
    # (seowon_bridge.looks_logged_out() 보다 이 사이트에 맞춰 더 정확하게 판정하므로 그대로 쓴다.)
    return ('name="uid"' in html and 'name="upass"' in html) or ("일련번호" not in html)


def fetch_raw(session):
    """사이트 화면을 한 번 읽는다. 로그인이 풀려 있으면 None, 아니면 (날짜 없는) 줄 목록."""
    r = session.get(DATA_URL, timeout=10)
    r.raise_for_status()
    html = r.text
    if is_logged_out(html):
        return None
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="bbs_list01")
    if not table:
        return []
    rows = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 9:
            continue
        no, who, pum, jong, unit, grade, qty, price, _amt = \
            [td.get_text(strip=True) for td in tds[:9]]
        qty_n = int(re.sub(r"[^\d]", "", qty) or 0)
        price_n = int(re.sub(r"[^\d]", "", price) or 0)
        rows.append({
            "mkt": MKT, "no": no,
            "item": jong or pum, "who": who, "unit": unit, "grade": grade,
            "qty": qty_n, "price": price_n,
        })
    return rows


def fetch_rows(session):
    """query_dates(서울청과) 의 각 날짜에 맞는 경매일(auction_date)을 붙여 낙찰 줄을 돌려준다.
    (화면 자체는 한 번만 읽는다 — 위 docstring 참고.) 로그인이 풀려 있으면 None."""
    raw = fetch_raw(session)
    if raw is None:
        return None
    by_id = {}
    for qd in query_dates(MKT):
        ad = auction_date(MKT, qd)
        for base in raw:
            row = dict(base, date=ad)
            row["id"] = lot_key(row["mkt"], row["date"], row["no"], row["qty"], row["price"])
            by_id[row["id"]] = row
    return list(by_id.values())


def run(cfg, bridge):
    L = log(MKT)
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})
    logged_in = False
    interval = cfg.get("poll_interval_sec", 2)
    while True:
        if wait_for_active(L):
            logged_in = False   # 쉬었다가 다시 시작하니 새로 로그인한다
        try:
            if not logged_in:
                login(session, cfg["sfvc_id"], cfg["sfvc_pw"])
                logged_in = True
                L("로그인 완료")
            rows = fetch_rows(session)
            if rows is None:
                bridge.heartbeat(MKT, "expired", msg="로그인 화면으로 돌아감", interval=interval)
                L("로그인이 풀린 것으로 보입니다 — 다시 로그인합니다")
                logged_in = False
                continue
            bridge.heartbeat(MKT, "ok", rows=len(rows), interval=interval)
            new_rows = mark_and_filter_new(rows)
            if new_rows:
                L(f"새 낙찰 {len(new_rows)}줄 발견 — 전송: " +
                  ", ".join(f"{r['no']}({r['item']})" for r in new_rows))
            bridge.send_lots(new_rows)
        except Exception as e:
            bridge.heartbeat(MKT, "error", msg=str(e), interval=interval)
            L(f"오류: {e} — {interval}초 뒤 재시도")
            logged_in = False
        time.sleep(interval)


if __name__ == "__main__":
    import json, os
    from seowon_bridge import Bridge
    with open(os.path.join(os.path.dirname(__file__), "secrets.json"), "r", encoding="utf-8") as f:
        cfg = json.load(f)
    run(cfg, Bridge(cfg["server_url"], user=cfg.get("user", "수집기")))
