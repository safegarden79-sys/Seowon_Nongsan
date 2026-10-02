"""서원농산 서버로 보내는 다리 — auction_poller 에 끼워 쓰는 작은 모듈 (파이썬 기본 모듈만 사용)

사무실 PC 의 auction_poller 폴더에 이 파일을 넣고, 수집 반복문에서 아래 두 가지만 부르면 된다.

    from seowon_bridge import Bridge
    br = Bridge("https://서버주소")                  # 한 번만 만든다

    # 시장 화면을 한 번 읽을 때마다 (성공·실패 상관없이)
    br.heartbeat("서울청과", "ok", rows=len(rows), interval=2)        # 로그인 살아 있음
    br.heartbeat("서울청과", "expired", msg="로그인 화면으로 돌아감")   # 세션 만료
    br.heartbeat("서울청과", "error", msg=str(e))                     # 접속 오류 등

    # 바뀐 낙찰 줄이 있을 때
    br.send_lots(rows)

- heartbeat 는 서원농산 앱 최상단 오른쪽 툴바(서울 ● 동화 ●)를 녹색/빨강으로 바꾼다.
  30초(또는 확인 간격의 3배) 넘게 신호가 없으면 앱에서 회색(신호 끊김)이 된다.
- send_lots 는 각 줄에 '사이트에서 처음 본 시각(seenAt)'을 붙여 보낸다. 서버는 이것으로
  사이트 → 서버 도착 시간을 재서 /api/health 의 수신지연ms 에 보여준다.
- 보내기는 별도 스레드에서 하므로 서버가 느리거나 잠깐 끊겨도 수집 반복문은 멈추지 않는다.
  못 보낸 낙찰 줄은 다음에 다시 보낸다(최신 신호만 남기고, 낙찰 줄은 잃지 않는다).
- 3초 안에 받으려면 확인 간격을 2초 정도로 둔다 (사이트에서 줄이 생긴 뒤 최악 = 간격 + 읽는 시간 + 전송).

조회 날짜 (사이트마다 다르다) — 경매는 밤 22:30 에 시작해 다음날 낮 12:30 쯤 끝난다.
    for d in query_dates("동화청과"):   # 사이트 낙찰내역조회에 넣을 날짜(들)
        rows = 사이트에서_읽기(d)
        for r in rows: r["date"] = auction_date("동화청과", d)
- 동화청과: 10월 2일 밤 경매 결과가 '10월 3일' 로 조회된다. → 저녁(15시 이후)에는 내일 날짜,
  자정 넘어서는 오늘 날짜로 조회한다. 결국 한 번의 경매 내내 같은 날짜(다음날)로 조회한다.
- 서울청과: 그날 달력 날짜로 조회한다. 10월 2일 밤에는 '10월 2일', 자정이 지나면 '10월 3일'.
  자정 직전에 받은 줄을 놓치지 않도록 자정 뒤 10분 동안은 어제 날짜도 함께 조회한다.
- 서원농산 앱에 올릴 때(줄의 date)는 두 시장 모두 동화청과처럼 '경매가 끝나는 날' 하나로 맞춘다.
  그래야 하룻밤 경매가 앱에서 한 날짜에 모이고, 서울청과에서 자정 전후로 조회 날짜가 바뀌어도
  같은 낙찰이 날짜만 다른 두 줄(다른 id)로 쪼개지지 않는다.
"""
import datetime
import json
import queue
import threading
import time
import urllib.request

MARKETS = ("서울청과", "동화청과")
EVENING_FROM = 15        # 이 시(한국 시간) 이후는 '오늘 밤 경매'로 본다 (경매는 22:30 시작, 12:30 끝)


def _kst(now=None):
    """한국 시간. PC 시계의 시간대 설정과 상관없이 계산한다."""
    t = now if now is not None else datetime.datetime.now(datetime.timezone.utc)
    if t.tzinfo is None:                 # 시간대 없는 값은 한국 시간으로 본다 (시험용)
        return t
    return t.astimezone(datetime.timezone(datetime.timedelta(hours=9))).replace(tzinfo=None)


def query_dates(mkt, now=None):
    """지금 그 시장 사이트 낙찰내역조회에 넣어야 할 날짜(YYYY-MM-DD) 목록. 첫 번째가 주 날짜."""
    k = _kst(now)
    today = k.date()
    if mkt == "동화청과":
        d = today + datetime.timedelta(days=1) if k.hour >= EVENING_FROM else today
        return [d.isoformat()]
    if mkt == "서울청과":
        out = [today.isoformat()]
        if k.hour == 0 and k.minute < 10:         # 자정 직전 낙찰을 놓치지 않게
            out.append((today - datetime.timedelta(days=1)).isoformat())
        return out
    raise ValueError("시장 이름은 서울청과 또는 동화청과")


def auction_date(mkt, query_date, now=None):
    """사이트에서 query_date 로 읽은 줄을 앱에 올릴 때 붙일 경매일(경매가 끝나는 날).
    동화청과는 조회 날짜가 곧 그 날짜다. 서울청과는 저녁(자정 전)에 그날 날짜로 읽은 줄이면
    다음날로 옮긴다. 자정 뒤 '어제 날짜'로 다시 읽은 줄도 같은 경매이므로 다음날이 된다."""
    q = datetime.date.fromisoformat(query_date)
    if mkt == "동화청과":
        return q.isoformat()
    k = _kst(now)
    if q < k.date() or k.hour >= EVENING_FROM:
        return (q + datetime.timedelta(days=1)).isoformat()
    return q.isoformat()


class Bridge:
    def __init__(self, server, user="수집기", timeout=5):
        self.url = server.rstrip("/") + "/api/op"
        self.user = user
        self.timeout = timeout
        self._seen = {}                 # 줄 id → 처음 본 시각(ms)
        self._lots = queue.Queue()      # 보낼 낙찰 묶음 (잃으면 안 됨)
        self._beat = {}                 # 시장 → 가장 최근 신호 (최신 것만 보내면 됨)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self.last_error = None
        threading.Thread(target=self._run, daemon=True).start()

    # ---- 부르는 쪽 ----
    def heartbeat(self, mkt, session, msg="", rows=None, interval=None):
        if mkt not in MARKETS:
            raise ValueError("시장 이름은 서울청과 또는 동화청과")
        op = {"t": "poll", "mkt": mkt, "session": session, "msg": str(msg)[:120]}
        if rows is not None:
            op["rows"] = int(rows)
        if interval is not None:
            op["interval"] = interval
        with self._lock:
            self._beat[mkt] = op
        self._wake.set()

    def send_lots(self, rows):
        now = int(time.time() * 1000)
        out = []
        for r in rows:
            r = dict(r)
            rid = r.get("id")
            if rid:
                r.setdefault("seenAt", self._seen.setdefault(rid, now))
            out.append(r)
        if len(self._seen) > 5000:      # 하루 넘게 켜 둬도 메모리가 늘지 않게
            self._seen = dict(list(self._seen.items())[-2000:])
        if out:
            self._lots.put(out)
            self._wake.set()

    # ---- 보내는 스레드 ----
    def _post(self, ops):
        body = json.dumps({"user": self.user, "ops": ops}).encode("utf-8")
        req = urllib.request.Request(self.url, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            return res.status == 200

    def _run(self):
        pending = None
        while True:
            self._wake.wait(1.0)
            self._wake.clear()
            ops = []
            if pending is None and not self._lots.empty():
                pending = self._lots.get()
            if pending:
                ops.append({"t": "lots", "rows": pending})
            with self._lock:
                beats, self._beat = list(self._beat.values()), {}
            ops.extend(beats)
            if not ops:
                continue
            try:
                self._post(ops)
                pending = None
                self.last_error = None
                if not self._lots.empty():
                    self._wake.set()
            except Exception as e:      # 서버가 잠깐 안 될 때 — 낙찰 줄은 잡아 두고 다시 보낸다
                self.last_error = str(e)
                time.sleep(1)


def looks_logged_out(final_url="", html=""):
    """사이트가 로그인 화면으로 돌려보냈는지 대략 판단한다.
    세션이 끊기면 두 사이트 모두 로그인 화면으로 보낸다. 사이트 화면이 바뀌면 이 조건을 고친다."""
    u = (final_url or "").lower()
    h = html or ""
    return ("login" in u) or ('type="password"' in h) or ("type='password'" in h) or ("로그인" in h and "낙찰" not in h)


if __name__ == "__main__":
    # 연결 시험:  python seowon_bridge.py https://서버주소
    # 두 시장 모두 '로그인 정상' 신호를 한 번 보낸다 → 앱 툴바가 녹색이 되면 서버 연결은 정상.
    # (진짜 로그인 상태가 아니라 시험 신호다. 30초 뒤 다시 회색이 된다.)
    import sys
    if len(sys.argv) < 2:
        print("사용법: python seowon_bridge.py https://서버주소")
        sys.exit(1)
    br = Bridge(sys.argv[1], user="연결시험")
    for m in MARKETS:
        br.heartbeat(m, "ok", msg="연결 시험 신호", interval=10)
        print(m, "오늘 조회 날짜:", query_dates(m), "→ 앱 경매일:", [auction_date(m, d) for d in query_dates(m)])
    time.sleep(3)
    print("전송 실패: " + br.last_error if br.last_error else "전송 완료 — 앱 오른쪽 위 서울·동화가 녹색인지 보세요 (30초 동안)")
