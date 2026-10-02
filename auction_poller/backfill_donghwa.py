"""
동화청과 지난 낙찰 내역 백필 (캘린더용 — 최근 한 달 정도를 한 번에 채워 넣기)

서원농산 APP 의 "📅 캘린더" 탭에서 과거 날짜를 조회할 수 있게 하려면, 서버의
날짜별 영구 기록(history)에 지난 자료가 들어 있어야 합니다. 이 프로그램을 평소에
계속 켜 둘 필요는 없고, **딱 한 번(또는 가끔)** 실행해서 지난 날짜들을 한꺼번에
채워 넣는 용도입니다.

- 오늘 치 "작업 목록"(state.lots, 박스체크/상차체크용)에는 전혀 영향을 주지 않습니다.
  서버에 "histlots" op 로 보내서, 캘린더용 기록(state.history)에만 쌓입니다.
- 이미 채워진 날짜를 다시 돌려도 안전합니다 — 같은 낙찰 줄(id)은 덮어쓰기만 됩니다.

⚠ 서울청과는 포함되지 않습니다
--------------------------------
서울청과 사이트에서 과거 날짜의 낙찰 내역을 조회하는 화면("낙찰명세서")을
직접 찾아 시도해봤지만, 날짜를 어떻게 넣어도 사이트 쪽에서
"잘못된 요청입니다" 로만 응답합니다 — 그 화면 자체가 사이트에서 고장나 있는
것으로 보입니다(클라이언트에서 고칠 수 있는 문제가 아닙니다). 그래서 서울청과의
지난 낙찰은 이 방법으로는 가져올 수 없고, **동화청과만** 채울 수 있습니다.
서울청과는 앞으로 poller 가 실시간으로 올리는 것부터 캘린더에 쌓이기 시작합니다.

사용법
------
  python backfill_donghwa.py            # 최근 30일 (오늘 포함)
  python backfill_donghwa.py 40         # 최근 40일로 늘리고 싶을 때

main.py 가 쓰는 것과 같은 secrets.json 을 그대로 씁니다. poller(main.py)가 지금
돌고 있는 중에 같이 실행해도 되지만, 혹시 동화청과가 한 계정 동시 로그인을 막는
사이트라면 잠깐 서로 다시 로그인하는 모습이 보일 수 있습니다 — 걱정할 필요는
없고(둘 다 자동으로 다시 로그인합니다), 되도록 poller 가 쉬는 시간(낮 12:30~밤
22:30)에 실행하는 게 깔끔합니다.
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta

import requests
from playwright.sync_api import sync_playwright

import donghwa_poller as dh

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    path = os.path.join(HERE, "secrets.json")
    if not os.path.exists(path):
        print("secrets.json 이 없습니다. main.py 를 실행할 때 쓰는 secrets.json 이 이 폴더에 있어야 합니다.")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def push_hist(server_url, user, rows, log):
    if not rows:
        return
    body = {"user": user, "ops": [{"t": "histlots", "rows": rows}]}
    try:
        r = requests.post(server_url.rstrip("/") + "/api/op", json=body, timeout=15)
        r.raise_for_status()
    except Exception as e:
        log(f"⚠ 서버 전송 실패: {e}")
        raise


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    cfg = load_config()

    def log(msg):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

    log(f"서버: {cfg['server_url']}")
    log(f"동화청과 — 오늘부터 지난 {days}일치 낙찰 내역을 가져와 캘린더 기록에 채웁니다.")
    log("⚠ 서울청과는 과거 날짜 조회 화면이 사이트 쪽에서 고장나 있어 이 방법으로는 백필할 수 없습니다 (동화청과만 가능).")

    total_rows = 0
    days_with_data = 0
    days_failed = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=cfg.get("headless", True))
        page = browser.new_page()
        dh.login(page, cfg["dh_id"], cfg["dh_pw"])
        log("로그인 완료")

        today = datetime.now().date()
        for i in range(days):
            d = today - timedelta(days=i)
            ds = d.strftime("%Y-%m-%d")
            rows = None
            try:
                rows = dh.fetch_rows(page, date_str=ds)
                if rows is None:
                    log(f"[{ds}] 로그인이 풀린 것으로 보입니다 — 다시 로그인합니다")
                    dh.login(page, cfg["dh_id"], cfg["dh_pw"])
                    rows = dh.fetch_rows(page, date_str=ds)
            except Exception as e:
                log(f"[{ds}] 오류: {e} — 이 날짜는 건너뜁니다")
                days_failed.append(ds)
                continue

            if rows is None:
                log(f"[{ds}] 다시 로그인한 뒤에도 읽지 못했습니다 — 건너뜁니다")
                days_failed.append(ds)
                continue

            if rows:
                try:
                    push_hist(cfg["server_url"], cfg["user"], rows, log)
                except Exception:
                    days_failed.append(ds)
                    continue
                days_with_data += 1
                total_rows += len(rows)
                log(f"[{ds}] {len(rows)}줄 가져옴")
            else:
                log(f"[{ds}] 낙찰 없음 (경매 없는 날이거나 자료 없음)")

            time.sleep(1)  # 사이트에 너무 빠르게 연달아 요청하지 않도록 살짝 쉰다

        browser.close()

    log(f"완료: {days_with_data}일치, 총 {total_rows}줄을 캘린더 기록으로 올렸습니다.")
    if days_failed:
        log(f"⚠ 못 가져온 날짜({len(days_failed)}일): {', '.join(days_failed)} — 다시 실행하면 그 날짜만 또 시도됩니다(이미 받은 날짜는 덮어쓰기만 되어 안전합니다).")


if __name__ == "__main__":
    main()
