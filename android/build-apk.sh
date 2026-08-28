#!/usr/bin/env bash
# 서원농산 체크 — APK 빌드 (Gradle 없이 안드로이드 도구만 사용)
set -e
SDK="${ANDROID_HOME:-/home/claude/android/sdk}"
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$APP/build"

rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/classes" "$OUT/gen"

echo "① 리소스 컴파일"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res.zip"

echo "② 리소스 링크"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLAT" \
  --manifest "$APP/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  "$OUT/res.zip"

echo "③ 자바 컴파일"
javac --release 11 -nowarn -g:none -classpath "$PLAT" \
  -d "$OUT/classes" \
  $(find "$APP/src" "$OUT/gen" -name '*.java')

echo "④ dex 변환"
jar cf "$OUT/classes.jar" -C "$OUT/classes" .
"$BT/d8" --min-api 24 --lib "$PLAT" --output "$OUT" "$OUT/classes.jar"

echo "⑤ APK 조립"
cd "$OUT" && cp base.apk unsigned.apk && zip -q -u unsigned.apk classes.dex

echo "⑥ 정렬"
"$BT/zipalign" -f 4 unsigned.apk aligned.apk

echo "⑦ 서명"
if [ ! -f "$APP/seowon.keystore" ]; then
  keytool -genkeypair -keystore "$APP/seowon.keystore" -alias seowon \
    -storepass seowon1234 -keypass seowon1234 -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Seowon Nongsan, O=Seowon, C=KR" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$APP/seowon.keystore" --ks-pass pass:seowon1234 \
  --key-pass pass:seowon1234 --out "$OUT/서원농산체크.apk" aligned.apk

"$BT/apksigner" verify --print-certs "$OUT/서원농산체크.apk" | head -3
echo
echo "완성: $OUT/서원농산체크.apk"
ls -lh "$OUT/서원농산체크.apk"
