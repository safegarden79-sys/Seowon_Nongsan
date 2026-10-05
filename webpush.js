/* 서원농산 — 웹 푸시(아이폰 홈 화면 앱·안드로이드 크롬)를 외부 라이브러리 없이 보낸다.
   표준: RFC 8291(내용 암호화, aes128gcm) · RFC 8292(VAPID 서명).
   서버 열쇠(VAPID)는 처음 한 번 만들어 자료 폴더의 vapid.json 에 둔다. 열쇠가 바뀌면 이미 허용한
   폰들의 구독이 모두 무효가 되므로, 자료 폴더(DATA_DIR)를 배포해도 남는 곳에 두어야 한다. */
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");

const b64u = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/* ---------- VAPID 열쇠 ---------- */
function loadVapid(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j.publicKey && j.privateJwk) return j;
  } catch (e) {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const j = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])),   // 65바이트 비압축 점
    privateJwk: privateKey.export({ format: "jwk" })
  };
  fs.writeFileSync(file, JSON.stringify(j));
  return j;
}

function vapidHeader(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/* ---------- 내용 암호화 (RFC 8291) ----------
   asPrivate·salt 는 시험(RFC 예시값 대조)할 때만 넘긴다. 평소에는 매번 새로 만든다. */
function encrypt(payload, p256dh, auth, asPrivate, salt) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  salt = salt || crypto.randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, enc]);
}

/* 구독 하나에 보낸다. 결과: {ok, status, gone} — gone 이면 그 폰이 알림을 끄거나 앱을 지운 것이니 구독을 지운다. */
function send(sub, payload, vapid, subject) {
  return new Promise(resolve => {
    let body;
    try { body = encrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth); }
    catch (e) { return resolve({ ok: false, status: 0, gone: true, error: "구독 정보가 잘못됨" }); }
    const u = new URL(sub.endpoint);
    const req = https.request({
      method: "POST", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm",
        "Content-Length": body.length, TTL: "3600", Urgency: "high",
        Authorization: vapidHeader(vapid, sub.endpoint, subject)
      },
      timeout: 10000
    }, res => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
                gone: res.statusCode === 404 || res.statusCode === 410 });
    });
    req.on("timeout", () => req.destroy(new Error("시간 초과")));
    req.on("error", e => resolve({ ok: false, status: 0, gone: false, error: e.message }));
    req.end(body);
  });
}

module.exports = { loadVapid, encrypt, send, vapidHeader, b64u, unb64u };
