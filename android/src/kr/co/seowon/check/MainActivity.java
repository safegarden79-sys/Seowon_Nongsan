package kr.co.seowon.check;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.content.Intent;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.app.PendingIntent;
import android.content.pm.PackageInstaller;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * SEOWONY (서원농산 작업 체크) — 사무실 서버에 붙는 껍데기 앱.
 * 화면과 자료는 모두 서버에서 온다. 주소는 처음 한 번만 넣으면 기억한다.
 */
public class MainActivity extends Activity {

    private static final String PREF = "seowon";
    static final String KEY_URL = "server";
    WebView web;
    ValueCallback<Uri[]> filePicker;
    static final int PICK_FILE = 1001;
    static final int REQ_NOTIFY = 1002;
    static final String PREF_ASKED = "notify_asked";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);              // 체크 기록 저장에 필요
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);  // 신호가 끊겨도 저장된 화면을 쓴다
        web.setBackgroundColor(Color.WHITE);
        /* 웹 화면이 알림 상태를 보고 켜고 끌 수 있게 이어준다 (window.SeowonApp) */
        web.addJavascriptInterface(new Bridge(this), "SeowonApp");

        web.setWebViewClient(new Client(this));

        /* 사진 고르기(경매 화면 인식)와 카메라 권한 */
        web.setWebChromeClient(new Chrome(this));

        setContentView(web);

        String url = prefs().getString(KEY_URL, null);
        if (url == null || url.length() == 0) askServer(true);
        else { web.loadUrl(url); askNotifyOnce(); }
    }

    /* ==================== 앱 업데이트 ====================
       앱을 열거나 다시 볼 때 서버(/api/app)에 새 판이 있는지 물어본다. 더 높은 판이 있으면
       '업데이트할까요?' 를 묻고, 누르면 서버의 SEOWONY.apk 를 받아 안드로이드 설치 화면을 띄운다.
       (플레이 스토어 밖 앱이라 조용히 깔 수는 없고, 안드로이드가 마지막에 한 번 더 확인한다.
        처음 한 번은 '이 출처의 앱 설치 허용'을 켜 달라고 설정 화면으로 보낸다.) */
    static final String ACTION_INSTALL = "kr.co.seowon.check.INSTALL_STATUS";
    static final String PREF_UPD_LATER = "upd_later_";
    long lastUpdCheck = 0;
    String pendingApk = null;               // 설치 허용을 켜러 간 사이 기다리는 APK 주소
    boolean updating = false;

    @Override
    protected void onResume() {
        super.onResume();
        if (pendingApk != null && canInstall()) { String a = pendingApk; pendingApk = null; downloadAndInstall(a); return; }
        checkUpdate(false);
    }

    int myVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
    }
    String myVersionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    boolean canInstall() { return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls(); }

    static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[8192]; int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }

    void toast(String m) { runOnUiThread(() -> Toast.makeText(this, m, Toast.LENGTH_LONG).show()); }

    void checkUpdate(final boolean manual) {
        final String base = prefs().getString(KEY_URL, null);
        if (base == null || updating) return;
        final long now = System.currentTimeMillis();
        if (!manual && now - lastUpdCheck < 10 * 60 * 1000) return;     // 10분에 한 번만
        lastUpdCheck = now;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/app").openConnection();
                c.setConnectTimeout(8000); c.setReadTimeout(8000);
                if (c.getResponseCode() != 200) throw new Exception("서버 응답 " + c.getResponseCode());
                JSONObject j = new JSONObject(readAll(c.getInputStream()));
                final int vc = j.getInt("versionCode");
                final String vn = j.optString("versionName", "" + vc), notes = j.optString("notes", "");
                String apk = j.optString("url", "/app/SEOWONY.apk");
                final String apkUrl = apk.startsWith("http") ? apk : base + apk;
                if (vc <= myVersion()) { if (manual) toast("최신 판입니다 (" + myVersionName() + ")"); return; }
                if (!manual && prefs().getLong(PREF_UPD_LATER + vc, 0) > now) return;   // '나중에' 누른 뒤 12시간은 조용히
                runOnUiThread(() -> askUpdate(vc, vn, notes, apkUrl));
            } catch (Exception e) {
                if (manual) toast("업데이트 확인 실패: " + e.getMessage());
            }
        }).start();
    }

    void askUpdate(final int vc, String vn, String notes, final String apkUrl) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("SEOWONY 업데이트")
                .setMessage("새 판 " + vn + " 이 나왔습니다. (지금 " + myVersionName() + ")\n"
                        + (notes.length() > 0 ? "\n" + notes + "\n" : "") + "\n지금 업데이트할까요?")
                .setPositiveButton("업데이트", (d, w) -> startUpdate(apkUrl))
                .setNegativeButton("나중에", (d, w) ->
                        prefs().edit().putLong(PREF_UPD_LATER + vc, System.currentTimeMillis() + 12L * 3600 * 1000).apply())
                .show();
    }

    void startUpdate(String apkUrl) {
        if (!canInstall()) {
            pendingApk = apkUrl;
            Toast.makeText(this, "처음 한 번만: '이 출처 허용'을 켜고 뒤로 돌아오면 설치가 이어집니다", Toast.LENGTH_LONG).show();
            try { startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))); }
            catch (Exception e) { pendingApk = null; toast("설정 화면을 열지 못했습니다"); }
            return;
        }
        downloadAndInstall(apkUrl);
    }

    void downloadAndInstall(final String apkUrl) {
        updating = true;
        Toast.makeText(this, "새 판을 내려받는 중…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                PackageInstaller pi = getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(getPackageName());
                int id = pi.createSession(p);
                PackageInstaller.Session s = pi.openSession(id);
                HttpURLConnection c = (HttpURLConnection) new URL(apkUrl).openConnection();
                c.setConnectTimeout(10000); c.setReadTimeout(30000);
                if (c.getResponseCode() != 200) throw new Exception("서버 응답 " + c.getResponseCode());
                long len = c.getContentLengthLong();
                try (InputStream in = c.getInputStream(); OutputStream out = s.openWrite("SEOWONY.apk", 0, len > 0 ? len : -1)) {
                    byte[] buf = new byte[65536]; int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    s.fsync(out);
                }
                Intent i = new Intent(this, MainActivity.class).setAction(ACTION_INSTALL);
                int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getActivity(this, 7, i, fl).getIntentSender());
                s.close();
            } catch (Exception e) {
                updating = false;
                toast("업데이트하지 못했습니다: " + e.getMessage());
            }
        }).start();
    }

    /* 설치 진행 결과 — 안드로이드가 '설치할까요?' 확인을 요구하면 그 화면을 띄운다 */
    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (!ACTION_INSTALL.equals(i.getAction())) return;
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) startActivity(confirm);
        } else if (st != PackageInstaller.STATUS_SUCCESS) {
            updating = false;
            String m = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            if (st != PackageInstaller.STATUS_FAILURE_ABORTED) Toast.makeText(this, "설치하지 못했습니다" + (m != null ? ": " + m : ""), Toast.LENGTH_LONG).show();
        }
    }

    /* ==================== 새 낙찰 알림 ====================
       처음 한 번 '알림을 받으시겠어요?'를 묻고, 받기를 누르면 안드로이드 알림 허용(13 이상)을 거쳐
       알림 서비스(NotifyService)를 켠다. 켜 두었으면 앱을 열 때마다 서비스가 살아 있게 한다. */
    void askNotifyOnce() {
        if (prefs().getBoolean(NotifyService.PREF_ON, false)) { if (notifyAllowed()) NotifyService.start(this); return; }
        if (prefs().getBoolean(PREF_ASKED, false)) return;
        prefs().edit().putBoolean(PREF_ASKED, true).apply();
        new AlertDialog.Builder(this)
                .setTitle("새 낙찰 알림")
                .setMessage("새 낙찰이 들어올 때마다 이 휴대폰에 알림을 받으시겠어요?\n앱을 닫아 두어도 알림이 옵니다.")
                .setPositiveButton("알림 받기", (d, w) -> enableNotify())
                .setNegativeButton("나중에", null)
                .show();
    }

    boolean notifyAllowed() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        return ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled();
    }

    void enableNotify() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);   // 안드로이드가 직접 허용 여부를 묻는다
            return;
        }
        if (!((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled()) {
            Toast.makeText(this, "알림이 꺼져 있습니다. 설정에서 '알림 허용'을 켜 주세요.", Toast.LENGTH_LONG).show();
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(i);
            return;
        }
        prefs().edit().putBoolean(NotifyService.PREF_ON, true).apply();
        NotifyService.start(this);
        askBatteryExemption();
        Toast.makeText(this, "새 낙찰 알림을 켰습니다", Toast.LENGTH_SHORT).show();
        notifyWeb();
    }

    void disableNotify() {
        prefs().edit().putBoolean(NotifyService.PREF_ON, false).apply();
        NotifyService.stop(this);
        Toast.makeText(this, "이 휴대폰의 낙찰 알림을 껐습니다", Toast.LENGTH_SHORT).show();
        notifyWeb();
    }

    /* 절전 때문에 밤사이 알림이 끊기지 않도록, 이 앱을 '배터리 최적화 제외'로 해 달라고 한 번 묻는다 */
    void askBatteryExemption() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= 23 && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            }
        } catch (Exception e) { /* 지원하지 않는 기기 */ }
    }

    void notifyWeb() { web.post(() -> web.evaluateJavascript("window.onNotifyChanged&&window.onNotifyChanged()", null)); }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_NOTIFY) {
            if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) enableNotify();
            else { Toast.makeText(this, "알림이 허용되지 않았습니다. 앱 아래쪽 🔔 알림 에서 다시 켤 수 있습니다.", Toast.LENGTH_LONG).show(); notifyWeb(); }
            return;
        }
        super.onRequestPermissionsResult(req, perms, res);
    }

    /** 웹 화면(index.html)에서 부르는 창구 — window.SeowonApp.notifyState() 등 */
    public static class Bridge {
        private final MainActivity a;
        Bridge(MainActivity act) { a = act; }
        @JavascriptInterface public String notifyState() {
            boolean on = a.prefs().getBoolean(NotifyService.PREF_ON, false);
            if (!on) return "off";                   // 아직 안 켬 → 웹 화면에 '알림 받기' 버튼
            return a.notifyAllowed() ? "on" : "denied"; // 켰는데 설정에서 막힘 → 설정 안내
        }
        @JavascriptInterface public void requestNotify() { a.runOnUiThread(a::enableNotify); }
        @JavascriptInterface public void disableNotify() { a.runOnUiThread(a::disableNotify); }
        @JavascriptInterface public String appVersion() { return a.myVersionName(); }
        @JavascriptInterface public void checkUpdate() { a.runOnUiThread(() -> a.checkUpdate(true)); }
    }

    /* 안드로이드 dex 변환 도구가 비정적 내부 클래스의 WebChromeClient 상속을 처리하지 못한다.
       그래서 static 으로 두고 액티비티를 넘겨받는다. */

    /** 연결 실패를 알려준다 */
    private static class Client extends WebViewClient {
        private final MainActivity a;
        Client(MainActivity act) { a = act; }
        @Override
        public void onReceivedError(WebView v, int code, String desc, String url) {
            Toast.makeText(a, "서버에 연결하지 못했습니다. 메뉴에서 주소를 확인해 주세요.", Toast.LENGTH_LONG).show();
        }
    }

    /** 사진 고르기와 권한 처리 */
    private static class Chrome extends WebChromeClient {
        private final MainActivity a;
        Chrome(MainActivity act) { a = act; }
        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
            a.filePicker = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.setType("image/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            a.startActivityForResult(Intent.createChooser(i, "경매 화면 사진 고르기"), PICK_FILE);
            return true;
        }
        @Override
        public void onPermissionRequest(PermissionRequest req) { req.grant(req.getResources()); }
    }

    SharedPreferences prefs() { return getSharedPreferences(PREF, Context.MODE_PRIVATE); }

    /** 서버 주소 입력 창 */
    private void askServer(final boolean first) {
        final EditText box = new EditText(this);
        box.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        box.setHint("http://192.168.0.10:3000");
        box.setText(prefs().getString(KEY_URL, "https://seowon-nongsan-zjyr.onrender.com"));   // 새로 깔아도 주소를 다시 칠 필요 없게

        LinearLayout wrap = new LinearLayout(this);
        wrap.setPadding(48, 24, 48, 0);
        wrap.addView(box);

        new AlertDialog.Builder(this)
                .setTitle("서버 주소")
                .setMessage(first ? "사무실 서버 주소를 넣어주세요. 한 번만 넣으면 기억합니다."
                                  : "새 주소를 넣어주세요.")
                .setView(wrap)
                .setCancelable(!first)
                .setPositiveButton("연결", new Save(this, box))
                .show();
    }

    /** 입력한 주소를 저장하고 접속한다 */
    private static class Save implements android.content.DialogInterface.OnClickListener {
        private final MainActivity a; private final EditText box;
        Save(MainActivity act, EditText b) { a = act; box = b; }
        public void onClick(android.content.DialogInterface d, int which) {
            String u = box.getText().toString().trim();
            if (u.length() == 0) return;
            if (!u.startsWith("http")) u = "http://" + u;
            while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
            a.prefs().edit().putString(KEY_URL, u).apply();
            a.web.loadUrl(u);
            a.askNotifyOnce();
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu m) {
        m.add(0, 1, 0, "새로 고침");
        m.add(0, 2, 0, "서버 주소 바꾸기");
        m.add(0, 3, 0, "업데이트 확인");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) { web.reload(); return true; }
        if (item.getItemId() == 2) { askServer(false); return true; }
        if (item.getItemId() == 3) { checkUpdate(true); return true; }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK_FILE) {
            if (filePicker == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    out = new Uri[n];
                    for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    out = new Uri[]{ data.getData() };
                }
            }
            filePicker.onReceiveValue(out);
            filePicker = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    /** 뒤로 가기는 앱 종료가 아니라 화면 뒤로 */
    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK && web.canGoBack()) { web.goBack(); return true; }
        return super.onKeyDown(code, e);
    }
}
