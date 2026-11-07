package com.hplayer;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 软件更新：从本仓库 GitHub Releases 取最新版 APK。
 *
 * 流程：
 *   1) GET api.github.com/repos/volcanochen/vcnc-football/releases/latest
 *      解析 tag_name / body / assets[].browser_download_url（找 .apk）
 *   2) 用「语义版本」(major.minor.patch) 比较最新版与当前 versionName，
 *      判断是否有更新（release 不带 versionCode，所以用版本名比较）
 *   3) 下载 APK 到 getFilesDir()/updates/，用自定义 UpdateProvider
 *      以 content:// 暴露给系统安装器触发安装
 *
 * 【为什么要多源下载】实测部分网络下 api.github.com 可达、github.com:443 却被拦，
 * 导致「检查更新成功但下载必失败」。因此按以下顺序逐个尝试，任一成功即用：
 *   a) Release 的 browser_download_url（境外 / 正常网络最快）
 *   b) jsDelivr CDN 的三个域名，指向仓库 release/ 下同名 APK
 *   c) api.github.com 的 contents 接口（返回 base64，走已确定可达的 API 域名）
 * 发布时必须把与 Release 资产同名的 APK 提交到仓库 release/ 目录。
 *
 * 回调全部发生在子线程，调用方（MainActivity）需要切回 UI 线程再操作 WebView。
 */
public class UpdateChecker {

    private static final String TAG = "VCNCFootball-Update";
    private static final String REPO = "volcanochen/vcnc-football";
    private static final String API = "https://api.github.com/repos/" + REPO + "/releases/latest";
    private static final String AUTHORITY = "com.vcncfootball.update";
    private static final String APK_NAME = "VCNC-Football.apk";
    private static final String[] CDN_HOSTS = {
            "https://cdn.jsdelivr.net/gh/",
            "https://fastly.jsdelivr.net/gh/",
            "https://gcore.jsdelivr.net/gh/"
    };

    private final Context ctx;
    private final UpdateListener listener;
    private final String curVersion;
    /** check() 生成的候选下载地址；downloadAndInstall() 按顺序尝试 */
    private final List<String> lastUrls = new ArrayList<>();

    public interface UpdateListener {
        /** 检查完成。hasUpdate 为 true 时下载地址一定非空 */
        void onChecked(boolean hasUpdate, String curVersion, String latestVersion,
                      String latestName, String notes, boolean apkAvailable);
        /** 下载进度 0~100 */
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

                synchronized (lastUrls) {
                    lastUrls.clear();
                    if (apk != null && !apk.isEmpty()) {
                        lastUrls.add(apk);
                        String fileName = apk.substring(apk.lastIndexOf('/') + 1);
                        for (String host : CDN_HOSTS) {
                            lastUrls.add(host + REPO + "@" + tag + "/release/" + fileName);
                        }
                        // 兜底：API 域名在受限网络下通常仍可达；仓库 release/ 里有同名文件
                        lastUrls.add("https://api.github.com/repos/" + REPO
                                + "/contents/release/" + fileName + "?ref=" + tag);
                    }
                }
                boolean has = apk != null && !apk.isEmpty() && compareVer(latestVer, curVersion) > 0;
                if (listener != null) {
                    final boolean fHas = has;
                    final String fLv = latestVer, fTag = tag, fNotes = notes;
                    final boolean fApk = apk != null && !apk.isEmpty();
                    listener.onChecked(fHas, curVersion, fLv, fTag, fNotes, fApk);
                }
            } catch (Exception e) {
                emitError("检查更新失败：" + shortMsg(e));
            }
        }).start();
    }

    public void downloadAndInstall() {
        final List<String> urls;
        synchronized (lastUrls) {
            if (lastUrls.isEmpty()) {
                emitError("没有可用的下载地址，请重新检查更新");
                return;
            }
            urls = new ArrayList<>(lastUrls);
        }
        new Thread(() -> {
            File dir = new File(ctx.getFilesDir(), "updates");
            if (!dir.exists() && !dir.mkdirs()) {
                emitError("无法创建下载目录");
                return;
            }
            File apk = new File(dir, APK_NAME);
            StringBuilder errs = new StringBuilder();
            for (int i = 0; i < urls.size(); i++) {
                String url = urls.get(i);
                try {
                    Log.i(TAG, "try source " + (i + 1) + "/" + urls.size() + ": " + hostOf(url));
                    if (listener != null) listener.onProgress(0);
                    byte[] data = fetch(url);
                    // APK 是 zip；拒绝把错误页 / HTML 当安装包交给系统安装器
                    if (data.length < 1024 || data[0] != 'P' || data[1] != 'K') {
                        throw new Exception("响应不是 APK（" + data.length + " bytes）");
                    }
                    writeBytes(apk, data);
                    if (listener != null) listener.onProgress(100);
                    Log.i(TAG, "apk downloaded from " + hostOf(url) + ": " + data.length + " bytes");
                    install(apk);
                    return;
                } catch (Exception e) {
                    Log.w(TAG, "source failed " + hostOf(url) + ": " + e.getMessage());
                    errs.append(hostOf(url)).append(": ").append(shortMsg(e)).append("; ");
                }
            }
            emitError("下载失败（已试 " + urls.size() + " 个源）：" + errs);
        }).start();
    }

    /** 取回 APK 字节。contents 接口返回 JSON(base64)，其它源直接返回二进制。 */
    private byte[] fetch(String url) throws Exception {
        boolean isApiJson = url.contains("/contents/");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(8000);
        c.setReadTimeout(25000);
        c.setRequestProperty("User-Agent", "VCNC-Football");
        if (isApiJson) c.setRequestProperty("Accept", "application/vnd.github+json");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            InputStream in = c.getInputStream();
            if (isApiJson) {
                String json = readString(in);
                in.close();
                String content = str(json, "content");
                if (content.isEmpty()) throw new Exception("接口未返回文件内容");
                byte[] out = Base64.decode(content.replaceAll("\\s", ""), Base64.DEFAULT);
                if (listener != null) listener.onProgress(90);
                return out;
            }
            int total = c.getContentLength();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n, got = 0;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                got += n;
                if (total > 0 && listener != null) {
                    listener.onProgress(Math.min(99, got * 100 / total));
                }
            }
            in.close();
            return bos.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private static void writeBytes(File f, byte[] data) throws Exception {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try { out.write(data); } finally { out.close(); }
        if (f.exists() && !f.delete()) throw new Exception("无法删除旧 APK");
        if (!tmp.renameTo(f)) throw new Exception("无法保存 APK");
    }

    private static String hostOf(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return url; }
    }

    private static String shortMsg(Exception e) {
        String s = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        return s.length() > 70 ? s.substring(0, 70) + "…" : s;
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
            // 显式指向系统「软件包安装程序」。装了 ES File Explorer 之类文件管理器的设备
            // 会弹出「打开方式」，用户一旦选错，content:// 拿不到授权且根本不会安装。
            try {
                List<ResolveInfo> ris = ctx.getPackageManager().queryIntentActivities(i, 0);
                for (ResolveInfo ri : ris) {
                    String pkg = ri.activityInfo.packageName;
                    if (pkg != null && pkg.toLowerCase().contains("packageinstaller")) {
                        i.setComponent(new ComponentName(pkg, ri.activityInfo.name));
                        break;
                    }
                }
            } catch (Exception ignore) { /* 找不到就退回隐式意图 */ }
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            if (listener != null) listener.onInstallStarted();
        } catch (Exception e) {
            emitError("启动安装失败：" + shortMsg(e));
        }
    }

    // ----------------------------- 解析辅助（不依赖 org.json，手写提取更稳） -----------------------------

    private static String str(String body, String key) {
        java.util.regex.Pattern p = java.util.regex.Pattern.compile("\"" + key + "\"\\s*:\\s*\"");
        java.util.regex.Matcher m = p.matcher(body);
        if (!m.find()) return "";
        int s = m.end();
        StringBuilder sb = new StringBuilder();
        for (int i = s; i < body.length(); i++) {
            char ch = body.charAt(i);
            if (ch == '"') {
                if (i > s && body.charAt(i - 1) == '\\') { sb.append(ch); continue; }
                break;
            }
            sb.append(ch);
        }
        return unescape(sb.toString());
    }

    private static String findApk(String body) {
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
