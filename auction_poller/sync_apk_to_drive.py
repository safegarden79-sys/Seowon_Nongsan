"""SEOWONY 안드로이드 APK 를 구글 드라이브 'SEOWONY 앱' 폴더(safegarden79@gmail.com)에 올려 두는 작은 도우미.

사무실 PC 에 '구글 드라이브 데스크톱(Google Drive for desktop)'이 safegarden79@gmail.com 으로 로그인되어 있으면
드라이브가 'G:\\내 드라이브' 같은 폴더로 보인다. run_poller.bat 이 git pull 로 새 코드를 받은 뒤 이 파일을 부르면,
저장소의 app/SEOWONY.apk 를 그 안의 'SEOWONY 앱' 폴더에 복사한다 → 드라이브가 알아서 올린다.

- SEOWONY.apk           : 언제나 최신 판 (다섯 명에게 공유하는 기본 파일)
- SEOWONY_<판>.apk      : 판마다 한 벌씩 보관 (예: SEOWONY_1.2.apk). 이미 있으면 다시 쓰지 않는다.

드라이브 폴더 위치가 다르면 이 폴더(auction_poller)에 drive_folder.txt 를 만들고 한 줄로 경로를 적는다.
예)  G:\\내 드라이브\\SEOWONY 앱
드라이브가 없거나 못 찾으면 아무것도 바꾸지 않고 안내만 출력한다 (수집기는 그대로 켜진다).
"""
import json
import os
import shutil
import string
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
APK = os.path.join(REPO, "app", "SEOWONY.apk")
VERSION = os.path.join(REPO, "app", "version.json")
FOLDER_NAME = "SEOWONY 앱"


def candidates():
    """드라이브 폴더가 있을 만한 곳들 (먼저 찾은 것을 쓴다)"""
    custom = os.path.join(HERE, "drive_folder.txt")
    if os.path.exists(custom):
        raw = open(custom, "rb").read()
        for enc in ("utf-8-sig", "cp949"):          # 메모장 기본 저장(ANSI=cp949)으로 적어도 읽히게
            try:
                p = raw.decode(enc).strip().strip('"')
                break
            except UnicodeDecodeError:
                p = ""
        p = p.splitlines()[0].strip().strip('"') if p else ""
        if p:
            yield p
    env = os.environ.get("SEOWONY_DRIVE_DIR")
    if env:
        yield env
    roots = []
    if os.name == "nt":
        for letter in string.ascii_uppercase[3:]:          # D: ~ Z: (구글 드라이브는 보통 G:)
            roots += [f"{letter}:\\내 드라이브", f"{letter}:\\My Drive"]
    home = os.path.expanduser("~")
    roots += [os.path.join(home, "Google Drive", "내 드라이브"), os.path.join(home, "Google Drive", "My Drive"),
              os.path.join(home, "Google Drive"), os.path.join(home, "내 드라이브"), os.path.join(home, "My Drive")]
    for r in roots:
        if os.path.isdir(r):
            yield os.path.join(r, FOLDER_NAME)


def main():
    if not os.path.exists(APK):
        print("   APK 없음 (app/SEOWONY.apk) — 건너뜀")
        return
    # 'SEOWONY 앱' 폴더의 바로 위(= 내 드라이브)가 실제로 있어야 쓴다
    target = next((p for p in candidates() if os.path.isdir(os.path.dirname(os.path.normpath(p)))), None)
    if not target:
        print("   구글 드라이브 폴더를 찾지 못했습니다 — APK 드라이브 복사를 건너뜁니다.")
        print("   (이 PC 에 '구글 드라이브 데스크톱'을 safegarden79@gmail.com 으로 설치하면 자동으로 올라갑니다.")
        print("    위치가 다르면 auction_poller\\drive_folder.txt 에 'SEOWONY 앱' 폴더 경로를 한 줄로 적어 주세요.)")
        return
    os.makedirs(target, exist_ok=True)
    ver = ""
    try:
        with open(VERSION, encoding="utf-8") as f:
            ver = str(json.load(f).get("versionName") or "")
    except Exception:
        pass
    latest = os.path.join(target, "SEOWONY.apk")
    same = os.path.exists(latest) and os.path.getsize(latest) == os.path.getsize(APK) and \
        open(latest, "rb").read() == open(APK, "rb").read()
    if not same:
        shutil.copyfile(APK, latest)
        print(f"   드라이브에 최신 APK 올림: {latest}" + (f" (판 {ver})" if ver else ""))
    else:
        print(f"   드라이브 APK 는 이미 최신입니다 ({target})")
    if ver:
        kept = os.path.join(target, f"SEOWONY_{ver}.apk")
        if not os.path.exists(kept):
            shutil.copyfile(APK, kept)
            print(f"   판 보관: {kept}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:                                  # 드라이브 문제로 수집기가 멈추면 안 된다
        print("   APK 드라이브 복사 중 오류 (수집기는 계속 켭니다):", e)
    sys.exit(0)
