package kr.co.seowon.check;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 휴대폰을 껐다 켜거나 앱을 새로 깔았을 때, 알림을 켜 두었으면 알림 서비스를 다시 띄운다 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (c.getSharedPreferences("seowon", Context.MODE_PRIVATE).getBoolean(NotifyService.PREF_ON, false)) {
            try { NotifyService.start(c); } catch (Exception e) { /* 기기가 막으면 앱을 열 때 다시 켠다 */ }
        }
    }
}
