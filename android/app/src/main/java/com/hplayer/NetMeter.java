package com.hplayer;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicLong;

/**
 * 网络流量计量：只统计「真实从网络下载」的字节，不统计 WebView 与本机
 * 127.0.0.1 代理之间的回环流量，也不统计命中磁盘缓存后从本地文件读出的字节。
 *
 * 埋点位置：
 *   BiliApi.httpGetString          B 站接口（feed / 评论 / playurl / wbi）
 *   MediaCache.Response.writeTo    视频/音频流首次下载（fromCache=false）
 *   MediaCache.prefetchRange       后台集锦预取
 *   ProxyServer.writeProxied       上游不给 206 时的透传兜底
 *
 * 累计值写 SharedPreferences，重启 App 不清零；「清零」只清累计口径，
 * 不影响缓存文件本身。
 */
public final class NetMeter {
    private static final String PREF = "netmeter";
    private static final String KEY_TOTAL = "total_bytes";
    private static final String KEY_SAVED = "saved_bytes";
    private static final long FLUSH_INTERVAL_MS = 5000;
    private static final long FLUSH_BYTES = 1024 * 1024;

    private static volatile NetMeter sInstance;

    private final Context ctx;
    private final AtomicLong session = new AtomicLong();       // 本次启动网络字节
    private final AtomicLong total = new AtomicLong();         // 安装以来累计网络字节
    private final AtomicLong sessionSaved = new AtomicLong();  // 本次启动缓存省下
    private final AtomicLong saved = new AtomicLong();         // 累计缓存省下
    private final AtomicLong dirty = new AtomicLong();

    private long lastSampleBytes;
    private long lastSampleMs;
    private double smoothSpeed;
    private long lastFlushMs;

    private NetMeter(Context c) {
        ctx = c.getApplicationContext();
        SharedPreferences p = prefs();
        total.set(p.getLong(KEY_TOTAL, 0));
        saved.set(p.getLong(KEY_SAVED, 0));
        lastSampleMs = System.currentTimeMillis();
        lastFlushMs = lastSampleMs;
    }

    public static void init(Context c) {
        if (sInstance == null) {
            synchronized (NetMeter.class) {
                if (sInstance == null) sInstance = new NetMeter(c);
            }
        }
    }

    /** 真实网络下载字节（任何线程可调用；init 之前调用会被安全忽略） */
    public static void addNetwork(long n) {
        NetMeter m = sInstance;
        if (m != null) m.add(n, false);
    }

    /** 命中本地磁盘缓存、因而没有走网络的字节 */
    public static void addSaved(long n) {
        NetMeter m = sInstance;
        if (m != null) m.add(n, true);
    }

    private void add(long n, boolean cached) {
        if (n <= 0) return;
        if (cached) {
            sessionSaved.addAndGet(n);
            saved.addAndGet(n);
        } else {
            session.addAndGet(n);
            total.addAndGet(n);
        }
        dirty.addAndGet(n);
        maybeFlush(false);
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    private synchronized void maybeFlush(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && dirty.get() < FLUSH_BYTES && now - lastFlushMs < FLUSH_INTERVAL_MS) return;
        prefs().edit()
                .putLong(KEY_TOTAL, total.get())
                .putLong(KEY_SAVED, saved.get())
                .apply();
        dirty.set(0);
        lastFlushMs = now;
    }

    public static void flush() {
        NetMeter m = sInstance;
        if (m != null) m.maybeFlush(true);
    }

    public static void reset() {
        NetMeter m = sInstance;
        if (m == null) return;
        synchronized (m) {
            m.session.set(0);
            m.total.set(0);
            m.sessionSaved.set(0);
            m.saved.set(0);
            m.dirty.set(0);
            m.smoothSpeed = 0;
            m.lastSampleBytes = 0;
            m.lastSampleMs = System.currentTimeMillis();
            m.prefs().edit().putLong(KEY_TOTAL, 0).putLong(KEY_SAVED, 0).apply();
        }
    }

    /** 前端每 ~1.2s 拉一次；按两次采样之间的增量算瞬时速率，再做指数平滑 */
    public static synchronized JSONObject stat() {
        NetMeter m = sInstance;
        long now = System.currentTimeMillis();
        JSONObject j = new JSONObject();
        try {
            if (m == null) {
                j.put("ok", true).put("speed", 0).put("session", 0).put("total", 0)
                        .put("sessionSaved", 0).put("saved", 0)
                        .put("network", "unknown").put("ts", now);
                return j;
            }
            long cur = m.session.get();
            double dt = (now - m.lastSampleMs) / 1000.0;
            double inst = dt > 0.05 ? (cur - m.lastSampleBytes) / dt : 0;
            if (inst < 0) inst = 0;
            // 上升快跟随、下降缓回落，避免数字在 0 和峰值之间乱跳
            double alpha = inst > m.smoothSpeed ? 0.65 : 0.35;
            m.smoothSpeed = m.smoothSpeed * (1 - alpha) + inst * alpha;
            if (m.smoothSpeed < 1024) m.smoothSpeed = 0;   // <1KB/s 直接归零
            m.lastSampleBytes = cur;
            m.lastSampleMs = now;
            m.maybeFlush(false);

            j.put("ok", true);
            j.put("speed", (long) m.smoothSpeed);
            j.put("session", m.session.get());
            j.put("total", m.total.get());
            j.put("sessionSaved", m.sessionSaved.get());
            j.put("saved", m.saved.get());
            j.put("network", m.networkType());
            j.put("ts", now);
        } catch (Exception ignore) {
        }
        return j;
    }

    private String networkType() {
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
            if (ni == null || !ni.isConnected()) return "offline";
            if (ni.getType() == ConnectivityManager.TYPE_WIFI) return "wifi";
            if (ni.getType() == ConnectivityManager.TYPE_MOBILE) return "mobile";
            return "other";
        } catch (Exception e) {
            return "unknown";
        }
    }
}
