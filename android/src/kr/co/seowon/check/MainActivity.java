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
        web.setBackgroundColor(Color.parseColor("#262624"));

        web.setWebViewClient(new Client(this));

        /* 사진 고르기(경매 화면 인식)와 카메라 권한 */
        web.setWebChromeClient(new Chrome(this));

        setContentView(web);

        String url = prefs().getString(KEY_URL, null);
        if (url == null || url.length() == 0) askServer(true);
        else web.loadUrl(url);
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
        box.setText(prefs().getString(KEY_URL, "http://192.168.0.10:3000"));

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
