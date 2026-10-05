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

/**
 * 서원농산 작업 체크 — 사무실 서버에 붙는 껍데기 앱.
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
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) { web.reload(); return true; }
        if (item.getItemId() == 2) { askServer(false); return true; }
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
