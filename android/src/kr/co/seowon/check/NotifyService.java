package kr.co.seowon.check;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 새 낙찰 알림 서비스.
 * 앱 화면(웹뷰)은 웹 푸시를 받을 수 없어서, 이 서비스가 서버의 /api/notify 에 계속 붙어 있다가
 * 새 낙찰 신호가 오면 휴대폰 알림을 띄운다. 앱을 닫아도 돌도록 '포그라운드 서비스'로 둔다
 * (상단에 작은 '알림 대기' 표시가 하나 남는다 — 안드로이드 규칙상 필요).
 * 끊기면 5초 → 최대 60초 간격으로 다시 붙는다. 서버 주소는 앱에서 넣은 값을 그대로 쓴다.
 */
public class NotifyService extends Service {
    static final String CH_WAIT = "wait", CH_LOTS = "lots";
    static final String PREF_ON = "notify_on";
    private volatile boolean running;
    private Thread worker;
    private int seq = 100;

    static void start(Context c) {
        Intent i = new Intent(c, NotifyService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }
    static void stop(Context c) { c.stopService(new Intent(c, NotifyService.class)); }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel wait = new NotificationChannel(CH_WAIT, "알림 대기 (끄지 마세요)", NotificationManager.IMPORTANCE_MIN);
            wait.setShowBadge(false);
            NotificationChannel lots = new NotificationChannel(CH_LOTS, "새 낙찰", NotificationManager.IMPORTANCE_HIGH);
            lots.enableVibration(true);
            lots.setVibrationPattern(new long[]{0, 250, 150, 250});
            nm.createNotificationChannel(wait);
            nm.createNotificationChannel(lots);
        }
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification.Builder builder(String ch) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ch) : new Notification.Builder(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification waitN = builder(CH_WAIT)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("서원농산 낙찰 알림 켜짐")
                .setContentText("새 낙찰이 들어오면 알려 드립니다")
                .setContentIntent(openApp())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, waitN, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, waitN);
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "seowon-notify");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    /** 서버 /api/notify 에 붙어 'event: lots' 를 기다린다 */
    private void loop() {
        long backoff = 5000;
        while (running) {
            String base = getSharedPreferences("seowon", MODE_PRIVATE).getString(MainActivity.KEY_URL, null);
            if (base == null || base.length() == 0) { nap(30000); continue; }
            HttpURLConnection con = null;
            try {
                con = (HttpURLConnection) new URL(base + "/api/notify").openConnection();
                con.setConnectTimeout(15000);
                con.setReadTimeout(70000);            // 서버가 25초마다 신호를 보내므로 70초 동안 아무것도 없으면 끊긴 것
                con.setRequestProperty("Accept", "text/event-stream");
                BufferedReader in = new BufferedReader(new InputStreamReader(con.getInputStream(), "UTF-8"));
                backoff = 5000;
                String line, event = "message";
                StringBuilder data = new StringBuilder();
                while (running && (line = in.readLine()) != null) {
                    if (line.startsWith("event:")) event = line.substring(6).trim();
                    else if (line.startsWith("data:")) data.append(line.substring(5).trim());
                    else if (line.length() == 0) {
                        if ("lots".equals(event) && data.length() > 0) show(data.toString());
                        event = "message"; data.setLength(0);
                    }
                }
            } catch (Exception e) {
                // 서버 재시작·신호 약함 — 잠시 뒤 다시 붙는다
            } finally {
                if (con != null) con.disconnect();
            }
            if (running) { nap(backoff); backoff = Math.min(60000, backoff * 2); }
        }
    }

    private void nap(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { /* 멈출 때 */ } }

    private void show(String json) {
        try {
            JSONObject m = new JSONObject(json);
            String title = m.optString("title", "새 낙찰"), body = m.optString("body", "");
            String first = body.contains("\n") ? body.substring(0, body.indexOf('\n')) : body;
            Notification.Builder b = builder(CH_LOTS)
                    .setSmallIcon(android.R.drawable.stat_notify_more)
                    .setContentTitle(title)
                    .setContentText(first)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setContentIntent(openApp())
                    .setAutoCancel(true)
                    .setWhen(m.optLong("at", System.currentTimeMillis()))
                    .setShowWhen(true);
            if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(seq++, b.build());
        } catch (Exception e) {
            // 알 수 없는 내용은 건너뛴다
        }
    }
}
