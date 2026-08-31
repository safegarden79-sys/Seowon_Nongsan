# 서원농산 작업 체크 — 이 폴더에 대한 안내

가락시장 중도매인 사무실(서원농산)에서 A·B·C 세 사람이 함께 쓰는
상차 체크 / 낙찰 내역 공유 앱입니다.

## 구성

| 파일 | 역할 |
|---|---|
| `server.js` | 공유 서버. 외부 라이브러리 없음(Node 기본 모듈만). SSE 로 실시간 전달 |
| `index.html` | 앱 화면 전체. OCR(Tesseract.js CDN), 오프라인 대기열 포함 |
| `sw.js` | 서비스워커. 화면은 서버 우선·실패 시 캐시, `/api/` 는 건드리지 않는다 |
| `data.json` | 서버가 자동 생성/갱신. 낙찰·체크·메모·사진목록 |
| `photos/` | 공유된 경매 화면 사진 |
| `backup/` | 6시간마다 자동 백업 (최근 14개) |

## 실행

```bash
node server.js            # 기본 포트 3000
PORT=8080 node server.js  # 포트 변경
DATA_DIR=/var/data node server.js   # 자료를 다른 곳(유료 디스크 등)에 둘 때
GOOGLE_VISION_KEY=... node server.js  # 사진 글자 인식을 구글에 맡길 때
```

## 사진 글자 인식

`GOOGLE_VISION_KEY` 가 있으면 폰이 사진을 서버로 보내고, 서버가 구글 Cloud Vision
(`DOCUMENT_TEXT_DETECTION`)에 물어본 뒤 **글자마다 위치 상자**를 돌려준다.
그 상자는 Tesseract 가 주던 것과 같은 모양이라 `parseAuction` 이 그대로 받는다.
열쇠가 없거나 신호가 끊기면 예전처럼 폰에서 Tesseract 로 읽는다(정확도는 낮다).
열쇠는 서버에만 두고 폰에는 절대 내려보내지 않는다.

## 24시간 구동

```bash
sudo bash setup.sh        # systemd(리눅스) 또는 launchd(맥) 등록
docker compose up -d      # 도커를 쓰는 경우
start.bat                 # 윈도우 (창을 열어둬야 함)
```

## 상태 점검

```bash
curl localhost:3000/api/health
# {"ok":true,"version":12,"접속자":3,"낙찰":25,"작업일":"2026-08-26","가동초":8213}
```

## 서버 API

- `GET  /api/state`  현재 공통 자료 전체
- `GET  /api/stream` SSE. 변경될 때마다 전체 상태를 밀어준다
- `POST /api/op`     `{user, ops:[...]}` 형태로 조작 전달
- `POST /api/ocr`    `{data:"data:image/jpeg;base64,..."}` → `{ok,text,words,width}`
- `GET  /api/health` 상태 점검

조작(op) 종류: `lots`(낙찰 줄 추가·갱신) `got`(박스 수) `car`(상차 체크)
`note`(메모) `photo` `delphoto` `clearlots`(낙찰만 삭제) `newday`(전체 초기화)

## 손댈 때 주의할 점

- **낙찰 줄의 id 는 내용으로 만든 고정키**입니다(`lotKey`). 같은 낙찰을 다시 읽어도
  같은 id 가 나와야 세어둔 박스 수가 유지됩니다. id 생성 규칙을 바꾸면 기존 체크가 끊깁니다.
- **수량은 OCR 로 읽은 값을 그대로 쓰지 않습니다.** 거래금액 ÷ 경락단가로 되계산하고
  (`fixQty`), 검산이 맞지 않는 줄만 확인 화면에서 붉게 표시합니다. 이 검산을 빼면 안 됩니다.
- **OCR 전처리는 확대 + 흑백까지만** 합니다. 대비를 올리면 인식률이 크게 떨어집니다
  (실측: 동화청과 금액 인식 23개 → 1개).
- 품목명 교정(`fixItem`)은 편집거리가 아니라 핵심어 판별입니다. 새 품목이 생기면
  거기에 규칙을 한 줄 추가하세요.
- `newday` 와 `clearlots` 는 **세 사람 모두의 자료**를 지웁니다.

## 사람이 쓰는 방법

`안내_공유서버.md` 를 참고하세요.
