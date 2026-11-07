package com.hplayer;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 软件更新：从本仓库 GitHub Releases 取最新版 APK。
 *
 * 流程：
 *   1) GET api.github.com/repos/volcanochen/vcnc-football/releases/latest
 *      解析 tag_name / body / assets[].browser_download_url（找 .apk）
 *   2) 用「语义版本」(major.minor.patch) 比较最新版与当前 versionName，
 *      判断是否有更新（release 不带 versionCode，所以用版本名比较）
 *   3) 有更新则下载 APK 到 getFilesDir()/updates/，用自定义 UpdateProvider
 *      以 content:// 暴露给系统安装器触发安装
 *
 * 回调全部发生在子线程，调用方（MainActivity）需要切回 UI 线程再操作 WebView。
 */
public class UpdateChecker {

    private static final String TAG = "VCNCFootball-Update";
    private static final String API =
            "https://api.github.com/repos/volcanochen/vcnc-football/releases/latest";
    private static final String AUTHORITY = "com.vcncfootball.update";
    private static final String APK_NAME = "VCNC-Football.apk";

    private final Context ctx;
    private final UpdateListener listener;
    private final String curVersion;
    private String lastApkUrl = null;

    public interface UpdateListener {
        /** 检查完成。hasUpdate 为 true 时 apkUrl 一定非空 */
        void onChecked(boolean hasUpdate, String curVersion, String latestVersion,
                      String latestName, String notes, boolean apkAvailable);
        /** 下载进度 0~100；<-1 表示未知长度 */
        void onProgress(int pct);
        /** 出错（网络/解析/权限等），msg 已是人话 */
        void onError(String msg);
        /** 已成功触发系统安装器（后续由用户在系统 UI 完成） */
        void onInstallStarted();
    }

    public UpdateChecker(Context ctx, UpdateListener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
        String v = "?";
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            v = pi.versionName != null ? pi.versionName : "?";
        } catch (Exception e) {
            Log.w(TAG, "read versionName: " + e);
        }
        this.curVersion = v;
    }

    public void check() {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(API).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(20000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", "VCNC-Football");
                int code = c.getResponseCode();
                if (code != 200) {
                    emitError("GitHub API 返回 " + code + "，稍后重试");
                    c.disconnect();
                    return;
                }
                String body = readString(c.getInputStream());
                c.disconnect();

                String tag = str(body, "tag_name");
                String latestVer = tag.startsWith("v") ? tag.substring(1) : tag;
                String notes = str(body, "body");
                String apk = findApk(body);
                lastApkUrl = apk;
                boolean has = apk != null && !apk.isEmpty() && compareVer(latestVer, curVersion) > 0;
                if (listener != null) {
                    final boolean fHas = has;
                    final String fLv = latestVer, fTag = tag, fNotes = notes;
                    final boolean fApk = apk != null && !apk.isEmpty();
                    listener.onChecked(fHas, curVersion, fLv, fTag, fNotes, fApk);
                }
            } catch (Exception e) {
                emitError("检查更新失败：" + e.getMessage());
            }
        }).start();
    }

    public void downloadAndInstall() {
        if (lastApkUrl == null || lastApkUrl.isEmpty()) {
            emitError("没有可用的下载地址，请重新检查更新");
            return;
        }
        final String url = lastApkUrl;
        new Thread(() -> {
            File dir = new File(ctx.getFilesDir(), "updates");
            if (!dir.exists() && !dir.mkdirs()) {
                emitError("无法创建下载目录");
                return;
            }
            File apk = new File(dir, APK_NAME);
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(60000);
                c.setRequestProperty("User-Agent", "VCNC-Football");
                int code = c.getResponseCode();
                if (code != 200) {
                    emitError("下载失败：HTTP " + code);
                    c.disconnect();
                    return;
                }
                int total = c.getContentLength();
                InputStream in = c.getInputStream();
                FileOutputStream out = new FileOutputStream(apk);
                byte[] buf = new byte[8192];
                int n, got = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    if (total > 0 && listener != null) {
                        listener.onProgress(got * 100 / total);
                    }
                }
                out.close();
                in.close();
                c.disconnect();
                if (listener != null) listener.onProgress(100);
                Log.i(TAG, "apk downloaded: " + apk.length() + " bytes");
                install(apk);
            } catch (Exception e) {
                emitError("下载失败：" + e.getMessage());
            }
        }).start();
    }

    private void install(File apk) {
        // Android 8+ 需要先获得「安装未知应用」授权
        if (Build.VERSION.SDK_INT >= 26) {
            if (!ctx.getPackageManager().canRequestPackageInstalls()) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + ctx.getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                    emitError("请先在设置里允许本应用安装未知应用，然后重新点击更新");
                } catch (Exception e) {
                    emitError("无法打开安装授权设置");
                }
                return;
            }
        }
        try {
            Uri uri = Uri.parse("content://" + AUTHORITY + "/" + APK_NAME);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            if (listener != null) listener.onInstallStarted();
        } catch (Exception e) {
            emitError("启动安装失败：" + e.getMessage());
        }
    }

    // ----------------------------- 解析辅助（不依赖 org.json，手写提取更稳） -----------------------------

    private static String str(String body, String key) {
        // 找 "key":"value" 或 "key": "value"
        String pat = "\"" + key + "\"\\s*:\\s*\"";
        java.util.regex.Pattern p = java.util.regex.Pattern.compile(pat);
        java.util.regex.Matcher m = p.matcher(body);
        if (!m.find()) return "";
        int s = m.end();
        StringBuilder sb = new StringBuilder();
        for (int i = s; i < body.length(); i++) {
            char ch = body.charAt(i);
            if (ch == '"') {
                // 处理转义 \" ，但 && 不需要跨字符状态，简单处理：若前一个是 \ 则继续
                if (i > s && body.charAt(i - 1) == '\\') { sb.append(ch); continue; }
                break;
            }
            sb.append(ch);
        }
        return unescape(sb.toString());
    }

    private static String findApk(String body) {
        // assets 数组里找 "browser_download_url":"...apk"
        java.util.regex.Pattern p = java.util.regex.Pattern
                .compile("\"browser_download_url\"\\s*:\\s*\"(https?://[^\"]+?\\.apk)\"");
        java.util.regex.Matcher m = p.matcher(body);
        if (m.find()) return m.group(1);
        return null;
    }

    private static String readString(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }

    private static String unescape(String s) {
        return s.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
                .replace("\\\"", "\"").replace("\\\\", "\\");
    }

    /** 语义版本比较：返回 >0 表示 a 比 b 新 */
    private static int compareVer(String a, String b) {
        int[] x = parseVer(a), y = parseVer(b);
        for (int i = 0; i < 3; i++) {
            if (x[i] != y[i]) return Integer.compare(x[i], y[i]);
        }
        return 0;
    }

    private static int[] parseVer(String v) {
        int[] out = new int[]{0, 0, 0};
        if (v == null) return out;
        v = v.trim();
        if (v.startsWith("v") || v.startsWith("V")) v = v.substring(1);
        String[] parts = v.split("\\.");
        for (int i = 0; i < Math.min(3, parts.length); i++) {
            try {
                out[i] = Integer.parseInt(parts[i].replaceAll("[^0-9].*$", ""));
            } catch (Exception e) {
                out[i] = 0;
            }
        }
        return out;
    }

    private void emitError(String msg) {
        if (listener != null) listener.onError(msg);
    }
}
