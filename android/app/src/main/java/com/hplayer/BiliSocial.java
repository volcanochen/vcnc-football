package com.hplayer;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * VCNC足球 · B 站账号社交模块（与桌面版 social.py 同语义，纯 Android 标准库）。
 *
 * 职责：扫码登录 -> 本机持久化凭证 -> 账号信息 / 大会员判定 -> 当前视频一键三连。
 *
 * 安全边界：
 *  - 凭证只写应用私有目录 files/social.json（沙箱隔离），不下发前端、不写日志；
 *  - 三连 / 登出走 POST，路由层校验同源；
 *  - 登出只清本机凭证，不调 B 站 logout（避免踢掉用户其它设备的登录态）；
 *  - 日志只打印状态，绝不打印 SESSDATA / bili_jct 原文。
 *
 * B 站 2026-08 起 Web 扫码登录改版：成功时不再把 SESSDATA 拼在返回 URL 上，
 * 而是通过 poll 响应的 Set-Cookie 下发。这里两条路径都兼容。
 */
public final class BiliSocial {
    private static final String TAG = "HPlayer";
    private static final String PASSPORT = "https://passport.bilibili.com";
    private static final String API = "https://api.bilibili.com";

    /** 凭证里保留的键；Expires / Path / Domain 等 HTTP 属性一律丢弃 */
    private static final String[] COOKIE_KEYS = {
            "SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid",
            "bili_ticket", "bili_ticket_expires", "buvid3", "buvid4"
    };

    private static final Object LOCK = new Object();
    private static Context ctx;
    private static String cookieUser = "";
    private static String refreshToken = "";
    private static long loginAt = 0;
    private static long myMid = 0;
    private static boolean loaded = false;

    private static JSONObject meCache = null;
    private static long meTs = 0;

    private BiliSocial() {}

    /** 由 ProxyServer 构造时调用；读回上次登录态（进程内幂等） */
    public static synchronized void init(Context c) {
        ctx = c.getApplicationContext();
        load();
    }

    // ---------------------------------------------------------------- 持久化
    private static File storeFile() {
        if (ctx == null) return null;
        return new File(ctx.getFilesDir(), "social.json");
    }

    private static void load() {
        if (loaded) return;
        loaded = true;
        File f = storeFile();
        if (f == null || !f.isFile()) return;
        try {
            byte[] b = readAll(new FileInputStream(f));
            JSONObject j = new JSONObject(new String(b, "UTF-8"));
            cookieUser = j.optString("cookie", "");
            refreshToken = j.optString("refresh_token", "");
            loginAt = j.optLong("login_at", 0);
            myMid = j.optLong("mid", 0);
            Log.i(TAG, "social: 已恢复登录态 (" + (cookieUser.isEmpty() ? "空" : "有凭证") + ")");
        } catch (Exception e) {
            Log.w(TAG, "social: 读取凭证失败 " + e.getMessage());
        }
    }

    private static void save() {
        File f = storeFile();
        if (f == null) return;
        try {
            JSONObject j = new JSONObject();
            synchronized (LOCK) {
                j.put("cookie", cookieUser);
                j.put("refresh_token", refreshToken);
                j.put("login_at", loginAt);
                j.put("mid", myMid);
            }
            File tmp = new File(f.getParentFile(), "social.json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(j.toString().getBytes("UTF-8"));
                out.flush();
                out.getFD().sync();
            }
            // 目标已存在时 renameTo 在部分 ROM 上会失败，先删再改名，保证覆盖写入
            if (f.exists() && !f.delete()) {
                Log.w(TAG, "social: 旧凭证文件删除失败，改用直写");
            }
            if (!tmp.renameTo(f)) {
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(j.toString().getBytes("UTF-8"));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "social: 凭证落盘失败 " + e.getMessage());
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        try (InputStream x = in) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = x.read(buf)) > 0) bo.write(buf, 0, n);
        }
        return bo.toByteArray();
    }

    // ---------------------------------------------------------------- HTTP
    private static class Resp {
        int status = 0;
        String body = "";
        final List<String> setCookies = new ArrayList<>();
    }

    /** passport 登录接口专用头：实测带 Origin 会触发风控，与 feed 一样用精简头 */
    private static Map<String, String> passportHeaders(String cookie) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", BiliApi.UA);
        h.put("Referer", "https://www.bilibili.com/");
        h.put("Accept", "application/json, text/plain, */*");
        h.put("Accept-Language", "zh-CN,zh;q=0.9");
        if (cookie != null && !cookie.isEmpty()) h.put("Cookie", cookie);
        return h;
    }

    private static Resp request(String urlStr, String postBody, Map<String, String> headers,
                                int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        Resp r = new Resp();
        try {
            c.setRequestMethod(postBody == null ? "GET" : "POST");
            c.setConnectTimeout(15000);
            c.setReadTimeout(timeoutMs);
            if (headers != null) for (Map.Entry<String, String> e : headers.entrySet())
                c.setRequestProperty(e.getKey(), e.getValue());
            if (postBody != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                OutputStream os = c.getOutputStream();
                os.write(postBody.getBytes("UTF-8"));
                os.close();
            }
            r.status = c.getResponseCode();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                String k = e.getKey();
                if (k != null && k.equalsIgnoreCase("Set-Cookie") && e.getValue() != null)
                    r.setCookies.addAll(e.getValue());
            }
            InputStream in = (r.status >= 200 && r.status < 300) ? c.getInputStream() : c.getErrorStream();
            if (in != null) {
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line).append('\n');
                }
                r.body = sb.toString();
            }
            try { NetMeter.addNetwork(r.body.getBytes("UTF-8").length); } catch (Exception ignore) {}
        } finally {
            try { c.disconnect(); } catch (Exception ignore) {}
        }
        return r;
    }

    private static JSONObject json(String s) {
        try { return new JSONObject(s); } catch (Exception e) { return new JSONObject(); }
    }

    private static Map<String, String> parseSetCookie(List<String> lines) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String line : lines) {
            if (line == null) continue;
            String first = line.split(";", 2)[0].trim();
            int eq = first.indexOf('=');
            if (eq < 1) continue;
            String k = first.substring(0, eq).trim();
            String v = first.substring(eq + 1).trim();
            if (v.isEmpty()) continue;
            for (String want : COOKIE_KEYS) if (want.equals(k)) { out.put(k, v); break; }
        }
        return out;
    }

    private static String cookieString(Map<String, String> ck) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : ck.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append("=").append(e.getValue());
        }
        return sb.toString();
    }

    private static String buvid() {
        try { return BiliApi.buvidCookie(); } catch (Exception e) { return ""; }
    }

    /** 供 /api/resolve、/api/feed 在未显式传 cookie 时兜底 */
    public static String userCookie() {
        load();
        synchronized (LOCK) { return cookieUser == null ? "" : cookieUser; }
    }

    /** API 请求用完整 Cookie = 游客指纹 + 登录凭证 */
    private static String fullCookie() {
        String b = buvid();
        String u = userCookie();
        if (b.isEmpty()) return u;
        if (u.isEmpty()) return b;
        return b + "; " + u;
    }

    private static String csrf() {
        String u = userCookie();
        for (String p : u.split(";")) {
            String s = p.trim();
            if (s.startsWith("bili_jct=")) return s.substring("bili_jct=".length());
        }
        return "";
    }

    /** 登录态变化后旧的匿名 playurl / feed 缓存不能再用 */
    private static void invalidateCaches() {
        try {
            BiliApi.RESOLVE_CACHE.clear();
            BiliApi.RESOLVE_TS.clear();
            BiliApi.FEED_CACHE.clear();
            BiliApi.FEED_TS.clear();
        } catch (Exception e) {
            Log.w(TAG, "social: 清缓存失败 " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- 客户端授权登录
    /** App 授权专用入口：与 qrcode() 同一会话，额外标记 mode=app 便于前端区分。
        授权页 URL 由 JS 桥交给本机 B 站客户端内打开，不渲染二维码。 */
    public static JSONObject auth() {
        JSONObject o = qrcode();
        if (o.optBoolean("ok", false)) {
            try { o.put("mode", "app"); } catch (Exception ignore) {}
        }
        return o;
    }

    // ---------------------------------------------------------------- 扫码登录
    public static JSONObject qrcode() {
        try {
            String u = PASSPORT + "/x/passport-login/web/qrcode/generate"
                    + "?source=main-fe-header&go_url="
                    + URLEncoder.encode("https://www.bilibili.com/", "UTF-8");
            Resp r = request(u, null, passportHeaders(buvid()), 15000);
            JSONObject j = json(r.body);
            JSONObject d = j.optJSONObject("data");
            String url = d == null ? "" : d.optString("url", "");
            String key = d == null ? "" : d.optString("qrcode_key", "");
            if (r.status != 200 || j.optInt("code") != 0 || url.isEmpty() || key.isEmpty()) {
                JSONObject o = new JSONObject();
                o.put("ok", false);
                o.put("error", "申请授权失败：" + j.optString("message", "HTTP " + r.status));
                return o;
            }
            JSONObject o = new JSONObject();
            o.put("ok", true); o.put("url", url); o.put("key", key); o.put("ttl", 180);
            return o;
        } catch (Exception e) {
            return err("申请授权失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    public static JSONObject poll(String key) {
        try {
            if (key == null || !key.matches("[A-Za-z0-9_-]{16,64}"))
                return err("授权 key 无效，请重新获取");
            String u = PASSPORT + "/x/passport-login/web/qrcode/poll?qrcode_key="
                    + URLEncoder.encode(key, "UTF-8") + "&source=main-fe-header";
            Resp r = request(u, null, passportHeaders(buvid()), 15000);
            JSONObject j = json(r.body);
            JSONObject d = j.optJSONObject("data");
            if (d == null) d = new JSONObject();
            int code = d.optInt("code", j.optInt("code", -1));
            if (code == 86101) return status("wait", "等待在 B 站 App 中确认");
            if (code == 86090) return status("scanned", "已在 App 中打开，请点确认");
            if (code == 86038) return status("expired", "授权已失效，请重新获取");
            if (code != 0) return status("unknown", d.optString("message", "等待在 B 站 App 中确认"));

            Map<String, String> ck = parseSetCookie(r.setCookies);
            // 旧版兼容：crossDomain URL 的查询参数里直接带 cookie 键
            String sso = d.optString("url", "");
            if (sso.startsWith("http")) {
                try {
                    String q = sso.contains("?") ? sso.substring(sso.indexOf('?') + 1) : "";
                    for (String pair : q.split("&")) {
                        int eq = pair.indexOf('=');
                        if (eq < 1) continue;
                        String k = java.net.URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                        String v = java.net.URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                        boolean want = false;
                        for (String w : COOKIE_KEYS) if (w.equals(k)) { want = true; break; }
                        if (want && !ck.containsKey(k) && !v.isEmpty()) ck.put(k, v);
                    }
                } catch (Exception ignore) {}
            }
            // 只下发 refresh_token 的场合，访问一次 SSO 地址取 cookie
            if (!ck.containsKey("SESSDATA") && sso.startsWith("https://")) {
                try {
                    Resp s = request(sso, null, passportHeaders(fullCookie()), 15000);
                    for (Map.Entry<String, String> e : parseSetCookie(s.setCookies).entrySet())
                        if (!ck.containsKey(e.getKey())) ck.put(e.getKey(), e.getValue());
                } catch (Exception ignore) {}
            }

            String ckStr = cookieString(ck);
            if (!ckStr.contains("SESSDATA="))
                return err("登录已确认，但没拿到 SESSDATA，请重新授权登录或在设置里手动填写 Cookie");

            synchronized (LOCK) {
                cookieUser = ckStr;
                refreshToken = d.optString("refresh_token", "");
                loginAt = d.optLong("timestamp", System.currentTimeMillis());
                myMid = 0;
                meCache = null; meTs = 0;
            }
            save();
            invalidateCaches();
            Log.i(TAG, "social: App 授权登录成功（凭证已存本机私有目录）");
            JSONObject o = status("done", "登录成功");
            o.put("me", me(true));
            return o;
        } catch (Exception e) {
            return err("登录轮询失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private static JSONObject status(String s, String text) {
        JSONObject o = new JSONObject();
        try { o.put("ok", true); o.put("status", s); o.put("text", text); }
        catch (Exception ignore) {}
        return o;
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try { o.put("ok", false); o.put("error", msg); }
        catch (Exception ignore) {}
        return o;
    }

    // ---------------------------------------------------------------- 账号信息
    public static JSONObject me(boolean force) {
        load();
        if (userCookie().isEmpty()) return anonymous(false);
        synchronized (LOCK) {
            if (!force && meCache != null && System.currentTimeMillis() - meTs < 30000)
                return meCache;
        }
        try {
            Resp r = request(API + "/x/web-interface/nav", null,
                    BiliApi.apiHeaders(fullCookie()), 15000);
            JSONObject j = json(r.body);
            JSONObject d = j.optJSONObject("data");
            if (d == null) d = new JSONObject();
            boolean logged = d.optBoolean("isLogin", false)
                    && r.status == 200 && j.optInt("code", -1) == 0;
            if (!logged) {
                JSONObject o = anonymous(true);
                o.put("text", "登录已过期，请重新授权登录");
                return cacheMe(o);
            }
            int vipStatus = d.optInt("vipStatus", 0);
            int vipType = d.optInt("vipType", 0);
            if (vipStatus == 0) {
                JSONObject vip = d.optJSONObject("vip");
                if (vip != null) {
                    vipStatus = vip.optInt("status", 0);
                    vipType = vip.optInt("type", 0);
                }
            }
            String face = d.optString("face", "");
            if (face.startsWith("//")) face = "https:" + face;
            else if (face.startsWith("http://")) face = "https://" + face.substring(7);
            int level = 0;
            JSONObject li = d.optJSONObject("level_info");
            if (li != null) level = li.optInt("current_level", 0);
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("loggedIn", true);
            o.put("vip", vipStatus == 1 && vipType > 0);
            o.put("vipType", vipType);
            o.put("vipDue", d.optLong("vipDueDate", 0));
            o.put("mid", d.optLong("mid", 0));
            o.put("name", d.optString("uname", ""));
            o.put("face", face);
            o.put("level", level);
            o.put("coins", d.optDouble("money", 0));
            o.put("text", "");
            synchronized (LOCK) { myMid = d.optLong("mid", 0); }
            save();
            return cacheMe(o);
        } catch (Exception e) {
            Log.w(TAG, "social: nav 失败 " + e.getMessage());
            return anonymous(false);
        }
    }

    private static JSONObject anonymous(boolean expired) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true); o.put("loggedIn", false); o.put("vip", false);
            o.put("mid", 0); o.put("name", ""); o.put("face", "");
            o.put("level", 0); o.put("coins", 0); o.put("expired", expired);
            o.put("text", expired ? "登录已过期，请重新授权登录" : "");
        } catch (Exception ignore) {}
        return o;
    }

    private static JSONObject cacheMe(JSONObject o) {
        synchronized (LOCK) { meCache = o; meTs = System.currentTimeMillis(); }
        return o;
    }

    /** 手填 Cookie 兜底：只有一台手机、不方便扫码时用；与扫码登录共用同一份凭证 */
    public static JSONObject setManualCookie(String raw) {
        Map<String, String> ck = new LinkedHashMap<>();
        if (raw != null) for (String p : raw.split(";")) {
            String s = p.trim();
            int eq = s.indexOf('=');
            if (eq < 1) continue;
            String k = s.substring(0, eq).trim();
            String v = s.substring(eq + 1).trim();
            if (v.isEmpty()) continue;
            for (String w : COOKIE_KEYS) if (w.equals(k)) { ck.put(k, v); break; }
        }
        String ckStr = cookieString(ck);
        if (!ckStr.contains("SESSDATA=")) return err("Cookie 里至少要包含 SESSDATA=…");
        if (!ckStr.contains("bili_jct=")) return err("三连还需要 bili_jct=…，请一并粘贴");
        synchronized (LOCK) {
            cookieUser = ckStr;
            refreshToken = "";
            loginAt = System.currentTimeMillis();
            myMid = 0;
            meCache = null; meTs = 0;
        }
        save();
        invalidateCaches();
        Log.i(TAG, "social: 已保存手填 Cookie（凭证只存本机私有目录）");
        JSONObject o = new JSONObject();
        try { o.put("ok", true); o.put("me", me(true)); }
        catch (Exception ignore) {}
        return o;
    }

    public static JSONObject logout() {
        synchronized (LOCK) {
            cookieUser = ""; refreshToken = ""; loginAt = 0; myMid = 0;
            meCache = null; meTs = 0;
        }
        File f = storeFile();
        if (f != null && f.isFile()) { try { f.delete(); } catch (Exception ignore) {} }
        invalidateCaches();
        Log.i(TAG, "social: 已退出登录（仅清本机凭证）");
        return anonymous(false);
    }

    // ---------------------------------------------------------------- 三连
    public static JSONObject triple(String bvid) {
        try {
            bvid = bvid == null ? "" : bvid.trim();
            if (!bvid.matches("BV[0-9A-Za-z]{10}")) return err("视频号无效");
            if (userCookie().isEmpty()) {
                JSONObject o = err("请先登录 B 站账号");
                o.put("needLogin", true);
                return o;
            }
            String csrf = csrf();
            if (csrf.isEmpty()) {
                JSONObject o = err("登录凭证缺少 bili_jct，请重新授权登录");
                o.put("needLogin", true);
                return o;
            }
            String post = "bvid=" + URLEncoder.encode(bvid, "UTF-8")
                    + "&csrf=" + URLEncoder.encode(csrf, "UTF-8");
            Map<String, String> h = BiliApi.apiHeaders(fullCookie());
            h.put("Referer", "https://www.bilibili.com/video/" + bvid);
            h.put("Origin", "https://www.bilibili.com");
            Resp r = request(API + "/x/web-interface/archive/like/triple", post, h, 15000);
            JSONObject j = json(r.body);
            int code = j.optInt("code", -1);
            if (code != 0) {
                String msg = j.optString("message", "HTTP " + r.status);
                if (code == -101) msg = "登录已过期，请重新授权登录";
                else if (code == -111) msg = "CSRF 校验失败，请重新授权登录";
                else if (code == 65006 || code == 65005) msg = "已经三连过啦";
                JSONObject o = err(msg);
                o.put("code", code);
                o.put("needLogin", code == -101 || code == -111);
                return o;
            }
            JSONObject d = j.optJSONObject("data");
            if (d == null) d = new JSONObject();
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("like", d.optBoolean("like", false));
            o.put("coin", d.optBoolean("coin", false));
            o.put("fav", d.optBoolean("fav", false));
            o.put("multiply", d.optInt("multiply", 0));
            o.put("text", "已三连：点赞 + 投币 + 收藏");
            return o;
        } catch (Exception e) {
            return err("三连请求失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }
}
