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

# 활성 시간대: 일·월·화·수·목·금요일 당일 22:30 부터 다음날 12:30 까지.
# (토요일은 "시작 요일"에서 뺀다 — 즉 토요일 22:30 ~ 일요일 12:30 은 활성 시간대가
#  아니다.) 매일 낮 12:30~밤 22:30 은 어느 요일이든 항상 비활성 시간대이고,
# 거기에 더해 토요일 22:30 부터 일요일 22:30 까지는 통째로 쉰다
# (토요일 밤 ~ 일요일 하루 — 보통 경매가 없는 구간).
ACTIVE_START = (22, 30)
ACTIVE_END = (12, 30)
EXCLUDED_START_WEEKDAY = 5  # datetime.weekday(): 월=0 ... 토=5, 일=6


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


def in_active_window(now=None):
    """지금이 '일월화수목금 22:30~익일12:30' 활성 시간대인지 돌려준다."""
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
    log("비활성 시간대(낮 12:30~밤 22:30, 토요일 22:30~일요일 22:30 포함) — 다음 활성 시간까지 기다립니다")
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
