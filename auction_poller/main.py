"""
서원농산 실시간 낙찰 수집 — 실행 파일
서울청과와 동화청과를 동시에(각자 스레드로) 감시하다가, 새 낙찰이 보이면
바로 seowon-nongsan 서버로 올립니다.

사용법:
  1) pip install -r requirements.txt
  2) playwright install chromium   (동화청과용 브라우저, 한 번만)
  3) secrets.example.json 을 secrets.json 으로 복사하고 ID/비밀번호를 직접 입력
  4) python main.py   (콘솔 창을 계속 열어 두세요)
"""
import json
import os
import sys
import threading

import seoul_poller
import donghwa_poller
from seowon_bridge import Bridge

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    path = os.path.join(HERE, "secrets.json")
    if not os.path.exists(path):
        print("secrets.json 이 없습니다.")
        print("secrets.example.json 을 복사해서 secrets.json 을 만들고,")
        print("그 안에 서울청과/동화청과 ID·비밀번호를 직접 입력한 뒤 다시 실행하세요.")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    cfg = load_config()
    print(f"서버: {cfg['server_url']}  /  보내는 이름: {cfg['user']}")
    print("서울청과·동화청과 감시를 시작합니다. 끄려면 이 창에서 Ctrl+C.")

    # 두 시장이 같은 Bridge 하나를 나눠 쓴다 — 보내기는 그 안에서 별도 스레드가 하므로
    # 서버가 느리거나 잠깐 끊겨도 사이트를 읽는 반복문은 멈추지 않는다.
    bridge = Bridge(cfg["server_url"], user=cfg.get("user", "수집기"))

    threads = [
        threading.Thread(target=seoul_poller.run, args=(cfg, bridge), daemon=True, name="서울청과"),
        threading.Thread(target=donghwa_poller.run, args=(cfg, bridge), daemon=True, name="동화청과"),
    ]
    for t in threads:
        t.start()
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("종료합니다.")


if __name__ == "__main__":
    main()
