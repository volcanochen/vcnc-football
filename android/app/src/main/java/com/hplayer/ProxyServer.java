package com.hplayer;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本机 HTTP 服务：托管前端静态文件 + 提供 /api/resolve 与 /api/media 代理。
 * 与桌面 server.py 一一对应，WebView 直接加载 http://127.0.0.1:PORT/ 即可（同源，前端代码零改动）。
 *
 * 【为什么是进程级单例】折叠屏从内屏切到外屏（或反向）时，如果 configChanges 没覆盖住
 * smallestScreenSize/screenLayout/density，Activity 会被销毁重建，WebView 随之销毁，
 * 原来的 BiliApi 解析缓存（MEDIA token 表）全部丢失、端口也可能变化，
 * 于是「session 断了、进度接不上」。把服务与端口固定在进程上，
 * Activity 重建后仍复用同一个端口 → localStorage / 服务端 token 都保持，续播才有意义。
 */
public class ProxyServer extends Thread {
    private static final String TAG = "HPlayer";
    private static volatile ProxyServer INSTANCE = null;

    private final Context ctx;
    private final MediaCache cache;
    private ServerSocket ss;
    private int port = -1;
    public String baseUrl = null;

    public ProxyServer(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.cache = MediaCache.get(this.ctx);
    }

    /** 进程级单例：首个调用者启动，之后复用（端口不变） */
    public static synchronized ProxyServer get(Context ctx) {
        if (INSTANCE == null) {
            ProxyServer s = new ProxyServer(ctx);
            s.start();
            int tries = 0;
            while (s.baseUrl == null && tries++ < 100) {
                try { Thread.sleep(50); } catch (InterruptedException ignore) {}
            }
            INSTANCE = s;
            Log.i(TAG, "ProxyServer 单例已就绪: " + s.baseUrl);
        }
        return INSTANCE;
    }

    @Override
    public void run() {
        // 优先固定端口：端口变化等于换了 origin，WebView 的 localStorage（续播记忆）就取不到了
        int[] preferred = {8777, 8778, 8779, 8780, 8781, 8782};
        for (int p : preferred) {
            try {
                ss = new ServerSocket(p, 50, InetAddress.getByName("127.0.0.1"));
                port = p;
                break;
            } catch (IOException ignore) { /* 端口被占用，试下一个 */ }
        }
        if (ss == null) { Log.e(TAG, "无法在 8777~8782 绑定本地端口"); return; }
        baseUrl = "http://127.0.0.1:" + port + "/";
        Log.i(TAG, "本地服务已启动：" + baseUrl);
        ExecutorService pool = Executors.newCachedThreadPool();
        while (!isInterrupted()) {
            try {
                Socket s = ss.accept();
                pool.execute(() -> handle(s));
            } catch (IOException e) {
                break;
            }
        }
    }

    /** 进程退出时才真正关闭；Activity 重建不调用本方法，否则端口会释放导致 localStorage 失联 */
    public void shutdown() {
        try { ss.close(); } catch (Exception ignore) {}
        interrupt();
        INSTANCE = null;
    }

    /**
     * 解析带整体重试。
     *
     * 为什么需要：蜂窝网/弱网下 B 站接口会瞬时无响应。BiliApi 内部已对单个请求
     * 做过指数退避重试，但 playurl / 评论那一批仍可能整体失败。
     * 这里再包一层「只对超时/IO 类失败重试」，最多再试 3 次：
     *  - 「视频不存在」「没识别出 BV」这类确定性错误直接抛出，不浪费时间；
     *  - 超时/连接异常才重试，因为重试确实能救回来（实测同一秒重试即成功）。
     */
    private static JSONObject resolveWithRetry(String raw, int page, int qn, String cookie)
            throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                return BiliApi.resolve(raw, page, qn, cookie);
            } catch (Exception e) {
                String msg = e.getMessage() == null ? "" : e.getMessage();
                boolean retriable = msg.contains("超时") || msg.contains("网络")
                        || e instanceof java.io.IOException;
                Log.w(TAG, "resolve attempt " + (attempt + 1) + " failed: " + msg);
                if (!retriable) throw e;
                last = e;
                try { Thread.sleep(600L * (attempt + 1)); } catch (InterruptedException ignore) {}
            }
        }
        throw last == null ? new RuntimeException("解析失败") : last;
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(35000);
            BufferedReader br = new BufferedReader(new InputStreamReader(s.getInputStream(), "ISO-8859-1"));
            String reqLine = br.readLine();
            if (reqLine == null) { s.close(); return; }
            String[] parts = reqLine.split(" ");
            if (parts.length < 2) { s.close(); return; }
            String method = parts[0];
            String full = parts[1];
            int q = full.indexOf('?');
            String path = (q < 0) ? full : full.substring(0, q);
            String query = (q < 0) ? "" : full.substring(q + 1);
            Map<String, String> headers = new LinkedHashMap<>();
            String h;
            while ((h = br.readLine()) != null && !h.isEmpty()) {
                int c = h.indexOf(':');
                if (c > 0) headers.put(h.substring(0, c).trim(), h.substring(c + 1).trim());
            }
            OutputStream os = s.getOutputStream();
            if ("GET".equals(method) || "HEAD".equals(method)) {
                route(path, query, headers, os, "HEAD".equals(method));
            }
            os.flush();
        } catch (Exception e) {
            Log.w(TAG, "handle: " + e.getMessage());
        } finally {
            try { s.close(); } catch (Exception ignore) {}
        }
    }

    private static Map<String, String> parseQuery(String qs) {
        Map<String, String> m = new LinkedHashMap<>();
        if (qs == null || qs.isEmpty()) return m;
        for (String pair : qs.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) m.put(URLDecoder.decode(pair, "UTF-8"), "");
                else m.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                           URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
            } catch (Exception ignore) {}
        }
        return m;
    }

    private void route(String path, String query, Map<String, String> headers, OutputStream os, boolean head)
            throws IOException {
        if ("/api/ping".equals(path)) {
            sendJson(os, 200, "{\"ok\":true,\"t\":" + System.currentTimeMillis() + "}");
        } else if ("/api/cache/config".equals(path)) {
            // 带不带 mb 都能读当前配置；但**只有显式带 mb 才写**——
            // 无参读取曾把上限静默重置回默认 600（回归测试抓到）
            Map<String, String> q = parseQuery(query);
            String mb = q.get("mb");
            if (mb != null && !mb.trim().isEmpty()) {
                cache.setLimitMb(parseInt(mb, cache.limitMb()));
            }
            sendCacheStat(os);
        } else if ("/api/cache/stat".equals(path)) {
            sendCacheStat(os);
        } else if ("/api/cache/clear".equals(path)) {
            cache.clear();
            sendCacheStat(os);
        } else if ("/api/cache/prefetch".equals(path)) {
            handlePrefetch(query, os);
        } else if ("/api/resolve".equals(path)) {
            Map<String, String> q = parseQuery(query);
            String raw = q.getOrDefault("url", "");
            int page = parseInt(q.get("p"), 1);
            int qn = parseInt(q.get("qn"), 80);
            String cookie = q.getOrDefault("cookie", "");
            try {
                if (raw.trim().isEmpty()) throw new RuntimeException("请填写视频链接或 BV 号");
                JSONObject j = resolveWithRetry(raw, page, qn, cookie);
                sendJson(os, 200, j.toString());
            } catch (Exception e) {
                sendJson(os, 200, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
            }
        } else if ("/api/feed".equals(path)) {
            // VCNC 空间动态 feed：offset 为空取第一页，否则用上一页返回的游标翻页
            Map<String, String> q = parseQuery(query);
            String offset = q.getOrDefault("offset", "");
            String cookie = q.getOrDefault("cookie", "");
            try {
                JSONObject j = BiliApi.fetchSpaceFeed(offset, cookie);
                sendJson(os, 200, j.toString());
            } catch (Exception e) {
                sendJson(os, 200, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
            }
        } else if ("/api/replies".equals(path)) {
            Map<String, String> q = parseQuery(query);
            String aid = q.getOrDefault("aid", "");
            int maxPages = parseInt(q.get("pages"), 5);
            int ps = parseInt(q.get("ps"), 20);
            try {
                if (aid.isEmpty()) throw new RuntimeException("缺少 aid");
                JSONArray replies = BiliApi.fetchReplies(aid, maxPages, ps);
                JSONArray hits = BiliApi.extractTimestamps(replies);
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("count", replies.length());
                out.put("matched", hits);
                out.put("replies", replies);
                sendJson(os, 200, out.toString());
            } catch (Exception e) {
                sendJson(os, 200, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
            }
        } else if (path.startsWith("/api/tracks/")) {
            // 外部预计算跟焦轨迹（PC 端 YOLO 管线产出）：
            // adb push tracks.json /sdcard/Android/data/<pkg>/files/tracks/<bvid>.json 即生效
            String bvid = path.substring("/api/tracks/".length());
            if (!bvid.matches("[A-Za-z0-9]{4,32}\\.json")) {
                sendJson(os, 400, "{\"ok\":false,\"error\":\"bad bvid\"}");
                return;
            }
            String body = readTrackFile(bvid);
            if (body != null) sendJson(os, 200, body);
            else sendJson(os, 404, "{\"ok\":false,\"error\":\"no ext tracks\"}");
        } else if (path.startsWith("/api/media/")) {
            String[] seg = path.split("/");
            if (seg.length < 4) { sendJson(os, 400, "{\"ok\":false,\"error\":\"bad media path\"}"); return; }
            String token = seg[3];
            String kind = seg.length > 4 ? seg[4] : "v";
            Map<String, String> q = parseQuery(query);
            int idx = parseInt(q.get("i"), 0);
            String range = headers.get("Range");
            handleMedia(os, token, kind, idx, range);
        } else {
            serveStatic(os, path, head);
        }
    }

    private void sendCacheStat(OutputStream os) throws IOException {
        try {
            sendJson(os, 200, cache.stat().toString());
        } catch (Exception e) {
            sendJson(os, 200, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
        }
    }

    /**
     * 媒体请求：优先走磁盘缓存（命中时一个字节都不用去 B 站拿）。
     * key 用 bvid|page|qn|kind，与每次 resolve 都会变的 token 解耦，所以进程重启仍命中。
     */
    private void handleMedia(OutputStream os, String token, String kind, final int idx, String range)
            throws IOException {
        final String ctype = "v".equals(kind) ? "video/mp4" : "audio/mp4";
        final String tk = token;
        final String kd = kind;
        String key = BiliApi.mediaCacheKey(token, kind);
        MediaCache.Response cr = null;
        if (key != null) {
            try {
                cr = cache.prepare(key, range, ctype, new MediaCache.Upstream() {
                    @Override public BiliApi.MediaResult fetch(String rangeHeader) {
                        return BiliApi.openMedia(tk, kd, idx, rangeHeader);
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "media cache prepare failed, passthrough: " + e.getMessage());
                cr = null;
            }
        }
        if (cr != null && !cr.passthrough) {
            writeCached(os, cr);
            return;
        }
        BiliApi.MediaResult r = (cr != null) ? cr.raw : BiliApi.openMedia(tk, kd, idx, range);
        if (r == null) {
            sendJson(os, 502, "{\"ok\":false,\"error\":\"流地址不可用\"}");
            return;
        }
        writeProxied(os, r, ctype);
    }

    /** 缓存路径：本地磁盘读（或第一次的 tee 落盘） */
    private void writeCached(OutputStream os, MediaCache.Response r) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 206 Partial Content\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Content-Type: ").append(r.contentType).append("\r\n");
        head.append("Content-Range: bytes ").append(r.start).append('-').append(r.end)
                .append('/').append(r.total > 0 ? r.total : "*").append("\r\n");
        head.append("Content-Length: ").append(r.length).append("\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        head.append("Cache-Control: public, max-age=86400\r\n");
        head.append("Connection: close\r\n\r\n");
        try {
            os.write(head.toString().getBytes("UTF-8"));
            os.flush();
            r.writeTo(os);
        } catch (IOException e) {
            r.abort();
            Log.w(TAG, "cache write aborted (client seek/stop): " + e.getMessage());
        }
    }

    /** 原始透传路径：上游不给 206、token 无稳定 key、或缓存异常时的兜底 */
    private void writeProxied(OutputStream os, BiliApi.MediaResult r, String defaultCtype)
            throws IOException {
        if (r.stream == null) {
            int code = (r.status == 502) ? 502 : 404;
            sendJson(os, code, "{\"ok\":false,\"error\":" +
                    (r.status == 404 ? "\"token 已失效，请重新解析视频\"" : "\"流地址不可用\"") + "}");
            return;
        }
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(r.status).append(r.status == 206 ? " Partial Content" : " OK").append("\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        String ctype = r.contentType;
        if (ctype == null || (!ctype.startsWith("video/") && !ctype.startsWith("audio/")))
            ctype = defaultCtype;
        head.append("Content-Type: ").append(ctype).append("\r\n");
        if (r.contentRange != null) head.append("Content-Range: ").append(r.contentRange).append("\r\n");
        if (r.contentLength >= 0) head.append("Content-Length: ").append(r.contentLength).append("\r\n");
        if (r.acceptRanges != null) head.append("Accept-Ranges: ").append(r.acceptRanges).append("\r\n");
        else head.append("Accept-Ranges: bytes\r\n");
        if (r.etag != null) head.append("ETag: ").append(r.etag).append("\r\n");
        head.append("Cache-Control: public, max-age=86400\r\n");
        head.append("Connection: close\r\n\r\n");
        os.write(head.toString().getBytes("UTF-8"));
        os.flush();
        byte[] buf = new byte[65536];
        int n;
        try {
            while ((n = r.stream.read(buf)) > 0) os.write(buf, 0, n);
        } catch (IOException e) {
            Log.w(TAG, "media write aborted (client seek/stop): " + e.getMessage());
        } finally {
            try { r.stream.close(); } catch (Exception ignore) {}
        }
    }

    private void serveStatic(OutputStream os, String path, boolean head) throws IOException {
        String asset = path.equals("/") ? "/index.html" : path;
        if (asset.contains("..")) { send404(os); return; }
        String name = "www" + asset;
        InputStream in;
        try {
            in = ctx.getAssets().open(name);
        } catch (IOException e) {
            send404(os); return;
        }
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) baos.write(buf, 0, n);
        in.close();
        byte[] body = baos.toByteArray();
        String ctype = "text/html; charset=utf-8";
        if (name.endsWith(".js")) ctype = "text/javascript; charset=utf-8";
        else if (name.endsWith(".css")) ctype = "text/css; charset=utf-8";
        else if (name.endsWith(".json")) ctype = "application/json; charset=utf-8";
        else if (name.endsWith(".svg")) ctype = "image/svg+xml";
        else if (name.endsWith(".png")) ctype = "image/png";
        else if (name.endsWith(".ico")) ctype = "image/x-icon";

        StringBuilder hdr = new StringBuilder();
        hdr.append("HTTP/1.1 200 OK\r\n");
        hdr.append("Content-Type: ").append(ctype).append("\r\n");
        hdr.append("Content-Length: ").append(body.length).append("\r\n");
        hdr.append("Cache-Control: no-cache\r\n");
        hdr.append("Connection: close\r\n\r\n");
        os.write(hdr.toString().getBytes("UTF-8"));
        if (!head) os.write(body);
        os.flush();
    }

    /** 读外部轨迹文件：先外部存储 files/tracks/，再内部存储 files/tracks/；无则 null */
    private String readTrackFile(String bvid) {
        java.io.File[] dirs = {
                ctx.getExternalFilesDir(null),
                ctx.getFilesDir()
        };
        for (java.io.File dir : dirs) {
            if (dir == null) continue;
            java.io.File f = new java.io.File(dir, "tracks/" + bvid);
            if (!f.isFile()) continue;
            try {
                java.io.FileInputStream fin = new java.io.FileInputStream(f);
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = fin.read(buf)) > 0) bo.write(buf, 0, n);
                fin.close();
                return bo.toString("UTF-8");
            } catch (Exception e) {
                Log.w(TAG, "readTrackFile fail: " + e.getMessage());
            }
        }
        return null;
    }

    private void sendJson(OutputStream os, int code, String json) throws IOException {
        byte[] body = json.getBytes("UTF-8");
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(" OK\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Content-Type: application/json; charset=utf-8\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n\r\n");
        os.write(head.toString().getBytes("UTF-8"));
        os.write(body);
        os.flush();
    }

    private void send404(OutputStream os) throws IOException {
        sendJson(os, 404, "{\"ok\":false,\"error\":\"not found\"}");
    }

    private static int parseInt(String s, int def) {
        try { return s == null ? def : Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    // ---------------------------------------------------------------- 集锦预取

    /** 预取下载专用单线程：与播放争抢带宽时自动排队，不影响正在播的段 */
    private final ExecutorService prefetchPool = Executors.newSingleThreadExecutor();
    /** 预取按 4MB 切块：一块 = 一条缓存条目，也方便「已有条目覆盖就跳过」的增量判断 */
    private static final long PREFETCH_CHUNK = 4L * 1024 * 1024;
    /** 单次预取请求的块数上限：防止前端算错区间把整个视频拖下来 */
    private static final int PREFETCH_MAX_CHUNKS = 400;

    /**
     * GET /api/cache/prefetch?token=..&kind=v&i=0&ranges=123-4567,890-12345
     * ranges 是字节区间（前端按时长线性映射算出来），后台逐块落盘，立即返回排队摘要。
     */
    private void handlePrefetch(String query, OutputStream os) throws IOException {
        Map<String, String> q = parseQuery(query);
        final String token = q.getOrDefault("token", "");
        final String kind = "a".equals(q.get("kind")) ? "a" : "v";
        final int idx = parseInt(q.get("i"), 0);
        String ranges = q.getOrDefault("ranges", "");
        if (token.isEmpty() || ranges.isEmpty()) {
            sendJson(os, 200, "{\"ok\":false,\"error\":\"缺少 token 或 ranges\"}");
            return;
        }
        final String key = BiliApi.mediaCacheKey(token, kind);
        final long[][] list = parseRanges(ranges);
        if (key == null || list.length == 0) {
            sendJson(os, 200, "{\"ok\":true,\"queued\":0,\"bytes\":0}");
            return;
        }
        // 先算出计划字节数（同步），实际下载丢给后台线程
        long planned = 0;
        int chunks = 0;
        outer:
        for (long[] re : list) {
            for (long s = re[0]; s <= re[1]; s += PREFETCH_CHUNK) {
                long e = Math.min(re[1], s + PREFETCH_CHUNK - 1);
                planned += e - s + 1;
                if (++chunks >= PREFETCH_MAX_CHUNKS) break outer;
            }
        }
        final long fPlanned = planned;
        prefetchPool.execute(new Runnable() {
            @Override public void run() {
                long written = 0;
                int done = 0;
                outer:
                for (long[] re : list) {
                    for (long s = re[0]; s <= re[1]; s += PREFETCH_CHUNK) {
                        long e = Math.min(re[1], s + PREFETCH_CHUNK - 1);
                        long n = cache.prefetchRange(key, s, e, new MediaCache.Upstream() {
                            @Override public BiliApi.MediaResult fetch(String range) {
                                return BiliApi.openMedia(token, kind, idx, range);
                            }
                        });
                        if (n > 0) written += n;
                        if (++done >= PREFETCH_MAX_CHUNKS) break outer;
                    }
                }
                Log.i(TAG, "cache prefetch kind=" + kind + " written=" + (written / 1048576L)
                        + "MB / planned " + (fPlanned / 1048576L) + "MB");
            }
        });
        sendJson(os, 200, "{\"ok\":true,\"queued\":" + chunks + ",\"bytes\":" + fPlanned + "}");
    }

    private static long[][] parseRanges(String s) {
        ArrayList<long[]> out = new ArrayList<>();
        for (String part : s.split(",")) {
            String[] se = part.trim().split("-");
            if (se.length != 2) continue;
            try {
                long a = Long.parseLong(se[0].trim()), b = Long.parseLong(se[1].trim());
                if (b >= a && a >= 0 && b - a < 512L * 1024 * 1024) out.add(new long[]{a, b});
            } catch (NumberFormatException ignore) {}
        }
        return out.toArray(new long[0][]);
    }

    private static String jsonEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", " ");
    }
}
