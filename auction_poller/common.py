"""
서원농산 실시간 낙찰 수집 — 공통 기능
- 이미 보낸 낙찰(id=lotKey)을 기억해서 같은 줄을 두 번 보내지 않습니다.
- 서버(seowon-nongsan)로 새 낙찰 줄만 전송합니다.
- 경매가 열리는 요일·시간대에만 실제로 폴링하도록 활성 시간대를 계산합니다.
"""
import json, os, time, threading
from datetime import datetime, timedelta

SEEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seen_lots.json")
_lock = threading.Lock()
_seen_cache = None

# 활성 시간대: 일·월·화·수·목·금요일 당일 22:30 부터 다음날 새벽 1:00 까지
# (실제 경매가 진행되는 시간대만). (토요일은 "시작 요일"에서 뺀다 — 즉 토요일
# 22:30 ~ 일요일 새벽 1:00 은 활성 시간대가 아니다.) 매일 새벽 1:00~밤 22:30 은
# 어느 요일이든 항상 비활성 시간대이고(대부분의 하루가 여기 해당), 거기에 더해
# 토요일 22:30 부터 일요일 22:30 까지는 통째로 쉰다(토요일 밤 ~ 일요일 하루 —
# 보통 경매가 없는 구간).
ACTIVE_START = (22, 30)
ACTIVE_END = (1, 0)
EXCLUDED_START_WEEKDAY = 5  # datetime.weekday(): 월=0 ... 토=5, 일=6


def today_str():
    """이미 보낸 줄 기록(seen_lots.json)을 새로 시작하는 기준 날짜 = 경매일(경매가 끝나는 날).
    달력 날짜로 하면 밤 경매 도중 자정에 기록이 비워져 그날 밤 낙찰을 전부 다시 보낸다."""
    from seowon_bridge import query_dates, auction_date
    return auction_date("동화청과", query_dates("동화청과")[0])


class Pacer:
    """확인 주기를 일정하게 지킨다. 사이트 읽는 데 1.5초 걸렸으면 0.5초만 더 쉬고 다음을 읽는다
    (읽은 뒤 매번 간격만큼 통째로 쉬면 실제 주기가 '읽는 시간 + 간격'으로 늘어나 3초를 넘긴다).
    로그인 만료·오류가 연달아 나면 사이트에 계속 두드리지 않도록 점점 길게 쉰다(최대 60초)."""
    def __init__(self, interval):
        self.interval = interval
        self.t0 = time.time()
        self.fails = 0

    def start(self):
        self.t0 = time.time()

    def ok(self):
        self.fails = 0
        time.sleep(max(0.2, self.interval - (time.time() - self.t0)))

    def fail(self):
        self.fails += 1
        wait = self.interval if self.fails < 3 else min(60, self.interval * 2 ** (self.fails - 2))
        time.sleep(wait)
        return wait


def in_active_window(now=None):
    """지금이 '일월화수목금 22:30~익일새벽1:00' 활성 시간대인지 돌려준다."""
    now = now or datetime.now()
    t = now.time()
    on = now.replace(hour=ACTIVE_START[0], minute=ACTIVE_START[1], second=0, microsecond=0).time()
    off = now.replace(hour=ACTIVE_END[0], minute=ACTIVE_END[1], second=0, microsecond=0).time()
    if t >= on:
        # 오늘 22:30 에 시작하는 창 — 오늘이 시작 요일로 쓸 수 있어야 한다
        return now.weekday() != EXCLUDED_START_WEEKDAY
    if t <= off:
        # 어제 22:30 에 시작해서 아직 안 끝난 창 — 어제가 시작 요일이어야 한다
        yesterday = now - timedelta(days=1)
        return yesterday.weekday() != EXCLUDED_START_WEEKDAY
    return False


def wait_for_active(log, check_sec=30):
    """비활성 시간대면 활성 시간대가 될 때까지 기다린다.
    기다렸다가 막 활성화된 경우 True(= 새로 로그인해야 함), 원래부터 활성 시간대였으면
    False 를 돌려준다."""
    if in_active_window():
        return False
    log("비활성 시간대(새벽 1:00~밤 22:30, 토요일 22:30~일요일 22:30 포함) — 다음 활성 시간까지 기다립니다")
    while not in_active_window():
        time.sleep(check_sec)
    log("활성 시간대 시작 — 감시를 시작합니다")
    return True


def lot_key(mkt, date, no, qty, price):
    # index.html / server.js 와 똑같은 규칙: 시장·날짜·번호·수량·단가
    return "K|" + "|".join(str(x).strip() for x in [mkt, date, no, qty, price])


def load_seen():
    if not os.path.exists(SEEN_FILE):
        return {"date": today_str(), "ids": []}
    try:
        with open(SEEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"date": today_str(), "ids": []}
    if data.get("date") != today_str():
        # 날짜가 바뀌면 새로 시작한다 (lotKey 에 날짜가 들어있어서 안전함)
        return {"date": today_str(), "ids": []}
    return data


def save_seen(data):
    tmp = SEEN_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, SEEN_FILE)


def mark_and_filter_new(rows):
    """rows 중 아직 서버로 보내지 않은 것만 돌려주고, 보낸 것으로 바로 기록한다."""
    global _seen_cache
    with _lock:
        if _seen_cache is None or _seen_cache.get("date") != today_str():
            _seen_cache = load_seen()
        seen_ids = set(_seen_cache["ids"])
        new_rows = [r for r in rows if r["id"] not in seen_ids]
        if new_rows:
            seen_ids.update(r["id"] for r in new_rows)
            _seen_cache["ids"] = list(seen_ids)
            _seen_cache["date"] = today_str()
            save_seen(_seen_cache)
        return new_rows


def log(tag):
    def _log(msg):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [{tag}] {msg}", flush=True)
    return _log
