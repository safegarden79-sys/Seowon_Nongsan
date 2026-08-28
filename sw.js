/* 서원농산 작업 체크 — 오프라인 대비
   화면과 스크립트는 서버에 먼저 물어보고, 서버에 닿지 않을 때만 담아둔 것을 쓴다.
   그래야 새 판이 올라오면 바로 내려가고, 신호가 끊겨도 앱은 열린다.
   경매 화면 사진과 바깥에서 받아오는 인식 엔진은 한 번 받으면 안 바뀌므로
   담아둔 것을 먼저 쓴다. 서버와 실시간으로 주고받는 /api/ 는 건드리지 않는다. */
const CACHE = "seowon-v10";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {}))))   // 하나 실패해도 나머지는 담는다
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 서버 우선 — 받아오면 담아두고, 못 받아오면 담아둔 것을 내준다 */
async function serverFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (e) {
    const hit = await caches.match(req);
    if (hit) return hit;
    if (req.mode === "navigate") {                     // 주소만 열었을 때는 화면이라도 띄운다
      const idx = await caches.match("./index.html");
      if (idx) return idx;
    }
    throw e;
  }
}

/* 담아둔 것 우선 — 사진·인식 엔진처럼 한 번 받으면 안 바뀌는 것 */
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === "opaque")) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  const mine = url.origin === self.location.origin;

  if (mine && url.pathname.startsWith("/api/")) return;   // 실시간 통신은 그대로 흘려보낸다

  if (mine && !url.pathname.startsWith("/photos/")) {
    e.respondWith(serverFirst(req));                      // 화면·스크립트·아이콘
    return;
  }
  e.respondWith(cacheFirst(req));                         // 사진·인식 엔진
});
