package com.milkmanga.reader;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.*;
import java.io.*;
import java.util.TimeZone;

public final class CacheMaintenance extends BroadcastReceiver {
    private static ImageCache cache;
    static volatile Runnable onCleared;
    static synchronized ImageCache images(Context context) {
        if(cache==null)cache=new ImageCache(new File(context.getCacheDir(),"online-images"),512L*1024*1024);
        return cache;
    }
    static synchronized void check(Context context) {
        SharedPreferences state=context.getSharedPreferences("cache-maintenance",Context.MODE_PRIVATE);
        long now=System.currentTimeMillis();
        if(state.getLong("last-cleared",0)>=ImageCache.cutoff(now,TimeZone.getDefault()))return;
        try {
            images(context).clear();
            // Remove the previous version's disposable HTTP cache too.
            removeOldCache(new File(context.getCacheDir(),"images-http"));
            if(state.edit().putLong("last-cleared",now).commit()) {
                Runnable listener=onCleared;if(listener!=null)listener.run();
            }
        } catch(IOException ignored) { /* Retry on the next foreground check; keep user data untouched. */ }
    }
    private static void removeOldCache(File root) throws IOException {
        File[] children=root.listFiles();
        if(children!=null)for(File child:children)removeOldCache(child);
        if(root.exists()&&!root.delete())throw new IOException("缓存清理未完成");
    }
    static void schedule(Context context) {
        Intent intent=new Intent(context,CacheMaintenance.class).setAction("com.milkmanga.reader.CLEAR_CACHE");
        PendingIntent alarm=PendingIntent.getBroadcast(context,3,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        AlarmManager manager=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);
        if(manager!=null)manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,ImageCache.nextCleanup(System.currentTimeMillis(),TimeZone.getDefault()),alarm);
    }
    @Override public void onReceive(Context context,Intent intent) {
        schedule(context);
        PendingResult result=goAsync();
        new Thread(()->{try {check(context.getApplicationContext());}finally {result.finish();}},"cache-cleanup").start();
    }
}
