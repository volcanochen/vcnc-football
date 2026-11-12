package com.hplayer;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.security.MessageDigest;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * B 站取流核心：view -> nav(wbi) -> playurl，与桌面 server.py 逻辑一致，纯标准库实现。
 * 不依赖任何第三方包（org.json 为 Android 内置）。
 */
public final class BiliApi {
    private static final String TAG = "HPlayer";

// 伪装成PC 端 Chrome：B 站 playurl 会据此分配 CDN 节点池，
// 若伪装移动端会被分到 estgoss/ali 家族节点，这些节点对当前出口 IP 直接返回 403
// （表现为「视频流加载失败」+ video networkState=3 NO_SOURCE）。
static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
+ "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    static final long RANGE_CAP = 3L * 1024 * 1024; // 单次回传上限，避免为一个 seek 拖下整个文件

    // 解析主流程的并行请求池（view/spi/nav/playurl 分片，互不依赖）
    static final ExecutorService POOL = Executors.newFixedThreadPool(4);
    // 评论分页单独一个池：fetchReplies 会在解析池的线程里被调用并阻塞等待分页结果，
    // 若与解析共用一个池会造成嵌套提交->饥饿死锁，故分开。
    static final ExecutorService REPLY_POOL = Executors.newFixedThreadPool(6);

    // 解析结果缓存：key = bvid|qn|page，5 分钟内复用，避免重复拉流/签名（重开同一视频近乎秒开）
    static final Map<String, long[]> RESOLVE_TS = new ConcurrentHashMap<>();
    static final Map<String, JSONObject> RESOLVE_CACHE = new ConcurrentHashMap<>();
    static String resolveKey(String raw, int qn, int page) {
        String[] t = parseTarget(raw);
        return t[0].toLowerCase() + "|" + qn + "|" + page;
    }

    // 强制走 IPv4：部分网络环境（如本机测试机）对 api.bilibili.com 的 IPv6 路由是死的，
    // 而 Android 9 的 HttpURLConnection 不会自动回退 IPv4（无 Happy-Eyeballs），
    // 导致每个 API 请求都在 IPv6 上挂满超时 -> 解析极慢。这里自建 SSLSocketFactory，
    // 先把主机解析到 IPv4 地址再建连，SNI/证书校验仍用原始域名，安全且快速。
static InetAddress toV4(String host) throws IOException {
InetAddress[] all = InetAddress.getAllByName(host);
InetAddress firstV4 = null;
for (InetAddress a : all) {
if (a instanceof Inet4Address) { if (firstV4 == null) firstV4 = a; }
}
if (firstV4 != null) return firstV4;
// 只有 IPv6 时退回系统默认（此时不做强制，否则会彻底连不上）
Log.i(TAG, "toV4: " + host + " 无 IPv4 地址，回退系统解析");
return InetAddress.getByName(host);
}

static final SSLSocketFactory FORCE_V4_SF = new SSLSocketFactory() {
private final SSLSocketFactory base = (SSLSocketFactory) SSLSocketFactory.getDefault();
public String[] getDefaultCipherSuites() { return base.getDefaultCipherSuites(); }
public String[] getSupportedCipherSuites() { return base.getSupportedCipherSuites(); }
public Socket createSocket() throws IOException { return base.createSocket(); }
public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
// 诊断：HttpsURLConnection 实际走的是这个「已建好 TCP、只做 TLS 包装」的重载，
// 而不是下面那个 createSocket(String,int)。也就是说 TCP/DNS 阶段根本没经过我们，
// 「强制 IPv4」是否真的生效必须靠这行日志确认。
Log.i(TAG, "forceV4 wrap host=" + host + ":" + port + " peer=" + (s == null ? "null" : s.getInetAddress()));
return base.createSocket(s, host, port, autoClose);
}
public Socket createSocket(String host, int port) throws IOException {
long t0 = System.currentTimeMillis();
Socket plain = new Socket();
InetAddress ip = toV4(host);
plain.connect(new InetSocketAddress(ip, port), 8000);
Socket tls = base.createSocket(plain, host, port, true);
Log.i(TAG, "forceV4 connect " + host + " -> " + ip.getHostAddress()
+ " (" + ip.getClass().getSimpleName() + ") in " + (System.currentTimeMillis() - t0) + "ms");
return tls;
}
public Socket createSocket(String host, int port, InetAddress la, int lp) throws IOException {
return createSocket(host, port);
}
public Socket createSocket(InetAddress host, int port) throws IOException {
return createSocket(host.getHostAddress(), port);
}
public Socket createSocket(InetAddress host, int port, InetAddress la, int lp) throws IOException {
return createSocket(host.getHostAddress(), port);
}
};

    /**
     * 【已停用】原「强制 IPv4」入口。
     *
     * 停用原因（实测确认）：HttpsURLConnection 只在 **TCP 建好之后** 才回调
     * SSLSocketFactory 做 TLS 包装，而「选哪个地址建连」在那之前就由系统决定了。
     * 日志为证：forceV4 wrap ... peer=api.bilibili.com/240e:97d:... —— 连的是 IPv6，
     * 也就是说这个方法从来没起到它名字所声称的作用，只是多包了一层 TLS。
     *
     * 地址/网络的选择交给系统（WiFi 与蜂窝谁优由系统判断），应用不再干预。
     */
    static void forceV4(HttpURLConnection c) {
        // no-op: 见上方说明。保留方法是为了让 httpGetString 的调用点不被误删后无处回溯。
    }

    static final int[] MIXIN_TAB = {
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
            33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
            61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
            36, 20, 34, 44, 52
    };

    static final Map<Integer, String> QUALITY_NAME = new HashMap<>();
    static {
        QUALITY_NAME.put(120, "4K 超清");
        QUALITY_NAME.put(116, "1080P60");
        QUALITY_NAME.put(112, "1080P 高码率");
        QUALITY_NAME.put(80, "1080P 高清");
        QUALITY_NAME.put(74, "720P60");
        QUALITY_NAME.put(64, "720P 高清");
        QUALITY_NAME.put(32, "480P 清晰");
        QUALITY_NAME.put(16, "360P 流畅");
        QUALITY_NAME.put(6, "240P 极速");
        QUALITY_NAME.put(125, "HDR 真彩");
        QUALITY_NAME.put(126, "杜比视界");
        QUALITY_NAME.put(127, "8K 超高清");
    }

    /** 拉取评论，最多 max 页（每页 ps 条），各页并行抓取，返回所有 message 字段构成的数组 */
    static JSONArray fetchReplies(String aid, int maxPages, int ps) {
        JSONArray out = new JSONArray();
        if (aid == null || aid.isEmpty()) return out;
        if (ps > 20) ps = 20;  // B 站 /x/v2/reply 现要求 ps<=20，否则返回 -400 ps out of bounds
        final int fps = ps;
        long t0 = System.currentTimeMillis();
        try {
            List<Future<String>> futs = new ArrayList<>();
            for (int pn = 1; pn <= maxPages; pn++) {
                final int p = pn;
                futs.add(REPLY_POOL.submit(new Callable<String>() {
                    public String call() throws Exception {
                        String url = "https://api.bilibili.com/x/v2/reply?type=1&oid=" + aid
                                + "&pn=" + p + "&ps=" + fps + "&sort=2&web_location=1315875";
                        return httpGetString(url, apiHeaders(lastCookie.isEmpty() ? null : lastCookie));
                    }
                }));
            }
            for (Future<String> f : futs) {
                String body;
                try { body = f.get(15, TimeUnit.SECONDS); }
                catch (Exception e) { continue; }
                JSONObject o = new JSONObject(body);
                if (o.optInt("code") != 0) {
                    Log.w(TAG, "reply code=" + o.optInt("code") + " msg=" + o.optString("message") + " ps=" + fps);
                    break;
                }
                JSONObject data = o.optJSONObject("data");
                if (data == null) break;
                JSONArray replies = data.optJSONArray("replies");
                if (replies == null || replies.length() == 0) break;
                for (int i = 0; i < replies.length(); i++) {
                    JSONObject r = replies.optJSONObject(i);
                    if (r == null) continue;
                    JSONObject c = r.optJSONObject("content");
                    if (c == null) continue;
                    String msg = c.optString("message", "");
                    JSONObject member = r.optJSONObject("member");
                    String uname = member == null ? "" : member.optString("uname", "");
                    JSONObject entry = new JSONObject();
                    entry.put("rpid", r.optLong("rpid"));
                    entry.put("user", uname);
                    entry.put("mid", member == null ? "" : member.optString("mid", ""));
                    entry.put("time", r.optLong("ctime"));
                    entry.put("text", msg);
                    out.put(entry);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "fetchReplies: " + e.getMessage());
        }
        Log.i(TAG, "fetchReplies " + aid + " pages=" + maxPages + " count=" + out.length()
                + " took=" + (System.currentTimeMillis() - t0) + "ms");
        return out;
    }

    /** 视频评论里常见的"时间戳 + 动作" 标记，每条评论只匹配一次 */
static JSONArray extractTimestamps(JSONArray replies) throws JSONException {
JSONArray out = new JSONArray();
if (replies == null) return out;
// 三种时间戳写法：区间(mm:ss - mm:ss) / 时分秒 / 分:秒
java.util.regex.Pattern[] PATS = new java.util.regex.Pattern[] {
java.util.regex.Pattern.compile("(\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)\\s*[~-]\\s*(\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)"),
java.util.regex.Pattern.compile("(\\d{1,2}:\\d{1,2}:\\d{1,2})"),
java.util.regex.Pattern.compile("(?<![\\d:])([0-5]?\\d:[0-5]\\d)(?!\\d)"),
};
for (int i = 0; i < replies.length(); i++) {
JSONObject r = replies.optJSONObject(i);
if (r == null) continue;
// 兼容 Windows(\r\n)、旧 Mac(\r) 换行：统一成 \n，避免时间戳被\r 粘连或截断
String text = r.optString("text", "").replace("\r\n", "\n").replace('\r', '\n');
// 收集该评论里所有时间戳出现位置（start,end,time,endTime），按位置排序
java.util.List<int[]> spans = new ArrayList<>();
java.util.List<String> times = new ArrayList<>();
java.util.List<String> ends = new ArrayList<>();
for (java.util.regex.Pattern p : PATS) {
java.util.regex.Matcher m = p.matcher(text);
while (m.find()) {
int s = m.start(), e = m.end();
// 已被更长（更靠前匹配优先）的模式覆盖则跳过，避免 "0:06:48" 与 "06:48" 重复
boolean covered = false;
for (int[] sp : spans) if (s >= sp[0] && e <= sp[1]) { covered = true; break; }
if (covered) continue;
spans.add(new int[]{s, e});
times.add(m.group(1));
ends.add(m.groupCount() > 1 && m.group(2) != null ? m.group(2) : "");
}
}
// 按出现位置排序，保证片段按视频时间顺序排列
java.util.List<Integer> order = new ArrayList<>();
for (int k = 0; k < times.size(); k++) order.add(k);
final java.util.List<int[]> sp2 = spans;
final java.util.List<String> t2 = times;
java.util.Collections.sort(order, new java.util.Comparator<Integer>() {
public int compare(Integer x, Integer y) { return sp2.get(x)[0] - sp2.get(y)[0]; }
});
for (int k = 0; k < order.size(); k++) {
int idx = order.get(k);
int s = spans.get(idx)[0], e = spans.get(idx)[1];
// 备注只取「本时间戳 到 下一个时间戳」之间的文字，避免把整条评论（含其它时间戳）灌进文本框
int noteEnd = (k + 1 < order.size()) ? spans.get(order.get(k + 1))[0] : text.length();
int from = Math.min(e, text.length());
int to = Math.max(from, Math.min(noteEnd, text.length()));
// 若时间戳后紧跟显式时长（如「0:06:48 9s ...」），把该时长提取为 authDur，
// 并从备注里剔除，避免文本框出现「0:06:48 18s 9s V m」这种重复数值
int explicitDur = -1;
int head = from;
String seg = text.substring(from, to);
String segTrim = seg.replaceAll("^\\s+", "");   // 先去掉前导空白，否则 ^\\d+ 匹配不到
java.util.regex.Matcher dm = java.util.regex.Pattern
.compile("^(\\d+(?:\\.\\d+)?)\\s*(?:s|sec|秒)(?![a-zA-Z])", java.util.regex.Pattern.CASE_INSENSITIVE)
.matcher(segTrim);
if (dm.find() && (ends.get(idx) == null || ends.get(idx).isEmpty())) {
explicitDur = (int) Math.round(Double.parseDouble(dm.group(1)));
from = Math.min(head + (seg.length() - segTrim.length()) + dm.end(), to);
}
String note = text.substring(from, to)
.replaceAll("[\\r\\n]+", " ").replaceAll("\\s+", " ").trim();
JSONObject hit = new JSONObject();
hit.put("time", times.get(idx));
// 有显式时长时补一个 end，让前端用它作为权威时长（不再靠相邻间隔猜）
hit.put("end", ends.get(idx) != null && !ends.get(idx).isEmpty() ? ends.get(idx)
: (explicitDur > 0 ? times.get(idx) + "+" + explicitDur : ""));
hit.put("dur", explicitDur > 0 ? explicitDur : 0);
hit.put("user", r.optString("user"));
hit.put("rpid", r.optLong("rpid"));
hit.put("text", note);
out.put(hit);
}
}
return out;
}

    /** token -> 媒体地址表（单用户应用，进程内即可） */
    static final Map<String, MediaEntry> MEDIA = new ConcurrentHashMap<>();
    static String lastCookie = "";

    static final Object wbiLock = new Object();
    static String[] wbiKey = null;
    static long wbiTs = 0;
    static String buvidCookie = "";
    static long buvidTs = 0;

    static class MediaEntry {
        List<String> v = new ArrayList<>();
        List<String> a = new ArrayList<>();
        long ts = System.currentTimeMillis();
        // 磁盘缓存用的稳定标识：token 每次 resolve 都会变，不能拿它当缓存 key
        String bvid = "";
        int page = 1;
        int qn = 80;
    }

    /** 与 token 解耦的媒体缓存 key；解析失败返回 null（调用方退化为不缓存的纯代理） */
    static String mediaCacheKey(String token, String kind) {
        MediaEntry me = MEDIA.get(token);
        if (me == null || me.bvid == null || me.bvid.isEmpty()) return null;
        return me.bvid + "|" + me.page + "|" + me.qn + "|" + ("a".equals(kind) ? "a" : "v");
    }

    /** 媒体拉流结果 */
    static class MediaResult {
        int status = 200;
        String contentType = "";
        String contentRange = "";
        long contentLength = -1;
        String acceptRanges = "";
        String etag = "";
        InputStream stream = null;
    }

    // ---------------------------------------------------------------- 工具
    static Map<String, String> apiHeaders(String cookie) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", UA);
        h.put("Referer", "https://www.bilibili.com/");
        h.put("Origin", "https://www.bilibili.com");
        h.put("Accept", "application/json, text/plain, */*");
        h.put("Accept-Language", "zh-CN,zh;q=0.9");
        if (cookie != null && !cookie.isEmpty()) h.put("Cookie", cookie);
        return h;
    }

    /**
     * 冷启动连接预热（在 MainActivity.onCreate 里后台调用一次）。
     *
     * 【为什么需要】进程刚起来时，第一次访问 api.bilibili.com 要现做
     * DNS 解析 + TCP 握手 + TLS 握手。蜂窝网下这一步实测能吃掉十几秒，
     * 而用户从分享进来到真正发起解析通常只有 1~3s，正好撞在这段冷连接上
     * —— 表现为「冷启动第一次解析要 30~40s，之后每次都秒开」。
     * 这里提前在后台把这条路走一遍：HttpURLConnection 有 keep-alive 连接池，
     * 预热完成后真实请求直接复用连接，省掉的就是那段握手时间。
     *
     * 预热失败（无网 / 被拦）完全无害，只是退化成原来的行为。
     */
    public static void warmUp() {
        POOL.submit(new Runnable() {
            public void run() {
                long s = System.currentTimeMillis();
                try {
                    // 把 DNS 单独计时：冷启动首次解析慢，必须先分清是
                    // 「DNS 解析慢」还是「TCP/TLS 慢」，两者的修法完全不同。
                    long d0 = System.currentTimeMillis();
                    InetAddress[] all = InetAddress.getAllByName("api.bilibili.com");
                    int v4 = 0;
                    for (InetAddress a : all) if (a instanceof Inet4Address) v4++;
                    Log.i(TAG, "warmup dns " + (System.currentTimeMillis() - d0)
                            + "ms n=" + all.length + " v4=" + v4);
                    // nav 是最轻的公开接口（约 1KB），足够完成 TCP+TLS 全流程
                    long d1 = System.currentTimeMillis();
                    httpGetString("https://api.bilibili.com/x/web-interface/nav", apiHeaders(null));
                    Log.i(TAG, "warmup http " + (System.currentTimeMillis() - d1) + "ms");
                    Log.i(TAG, "warmup ok " + (System.currentTimeMillis() - s) + "ms");
                } catch (Exception e) {
                    Log.w(TAG, "warmup failed " + (System.currentTimeMillis() - s) + "ms: " + e);
                }
            }
        });
    }

    /**
     * 取 GET 文本。
     *
     * 【必须 disconnect 的原因】原来这里读完 body 就不管了，
     * 而 body 不一定被读到 EOF（例如服务端返回错误页、连接被重置），
     * 此时 keep-alive 连接既没被复用也没被归还，
     * HttpURLConnection 的连接池很快被占满（默认每 host 5 个），
     * 后续请求只能排队等新连接 —— 表现为「第一次解析卡满 18s 超时，之后再点又秒开」。
     * 用 try-with-resources 包住 InputStream 并在 finally 里 disconnect，
     * 保证异常路径也能把连接还回去。
     */
    static String httpGetString(String url, Map<String, String> headers) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            forceV4(c);
            c.setRequestMethod("GET");
            // 弱网（尤其蜂窝网）下握手慢，实测单次 view 请求可到 2.8s；
            // 10s 连接超时在基站切换/DNS 重解析时容易被打穿，
            // 放宽到 15s/25s，配合上层的指数退避重试，显著降低误报超时。
            c.setConnectTimeout(15000);
            c.setReadTimeout(25000);
            if (headers != null) for (Map.Entry<String, String> e : headers.entrySet())
                c.setRequestProperty(e.getKey(), e.getValue());
            int code = c.getResponseCode();
            InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"))) {
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line).append('\n');
                }
            }
            String body = sb.toString();
            // 接口 JSON 字节也计入流量（相对视频很小，但「一共用多少」要算上）
            try { NetMeter.addNetwork(body.getBytes("UTF-8").length); } catch (Exception ignore) {}
            return body;
        } finally {
            try { c.disconnect(); } catch (Exception ignore) {}
        }
    }

    static String md5hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] b = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    static String mixinKey(String orig) {
        StringBuilder sb = new StringBuilder();
        for (int i : MIXIN_TAB) sb.append(orig.charAt(i));
        return sb.substring(0, 32);
    }

    static String[] wbiKeys() throws Exception {
        synchronized (wbiLock) {
            if (wbiKey != null && System.currentTimeMillis() - wbiTs < 3600_000) return wbiKey;
            String nav = httpGetString("https://api.bilibili.com/x/web-interface/nav", apiHeaders(null));
            JSONObject j = new JSONObject(nav);
            JSONObject img = j.getJSONObject("data").getJSONObject("wbi_img");
            String ik = img.getString("img_url").replaceAll(".*/", "").replaceAll("\\..*", "");
            String sk = img.getString("sub_url").replaceAll(".*/", "").replaceAll("\\..*", "");
            if (ik.isEmpty() || sk.isEmpty()) throw new RuntimeException("获取 wbi 密钥失败");
            wbiKey = new String[]{ik, sk};
            wbiTs = System.currentTimeMillis();
            return wbiKey;
        }
    }

    static String wbiSign(Map<String, String> params) throws Exception {
        String[] k = wbiKeys();
        String mk = mixinKey(k[0] + k[1]);
        Map<String, String> p = new LinkedHashMap<>(params);
        p.put("wts", String.valueOf(System.currentTimeMillis() / 1000));

        List<Map.Entry<String, String>> list = new ArrayList<>(p.entrySet());
        list.sort(Comparator.comparing(Map.Entry::getKey));

        StringBuilder q = new StringBuilder();
        for (Map.Entry<String, String> e : list) {
            String v = e.getValue().replaceAll("[!'()*]", "");
            try { v = java.net.URLEncoder.encode(v, "UTF-8"); } catch (Exception ignore) {}
            q.append(e.getKey()).append("=").append(v).append("&");
        }
        if (q.length() > 0) q.setLength(q.length() - 1);

        p.put("w_rid", md5hex(q.toString() + mk));

        StringBuilder f = new StringBuilder();
        for (Map.Entry<String, String> e : p.entrySet()) {
            String v = e.getValue().replaceAll("[!'()*]", "");
            try { v = java.net.URLEncoder.encode(v, "UTF-8"); } catch (Exception ignore) {}
            f.append(e.getKey()).append("=").append(v).append("&");
        }
        if (f.length() > 0) f.setLength(f.length() - 1);
        return f.toString();
    }

    static String buvidCookie() {
        synchronized (wbiLock) {
            if (!buvidCookie.isEmpty() && System.currentTimeMillis() - buvidTs < 3600_000) return buvidCookie;
            try {
                String d = httpGetString("https://api.bilibili.com/x/frontend/finger/spi", apiHeaders(null));
                JSONObject o = new JSONObject(d).getJSONObject("data");
                buvidCookie = "buvid3=" + o.optString("b_3", "") + "; buvid4=" + o.optString("b_4", "");
            } catch (Exception e) { buvidCookie = ""; }
            buvidTs = System.currentTimeMillis();
            return buvidCookie;
        }
    }

    /** 从链接/裸 ID 解析出 [bvid, pageStr]
     *
     * 【为什么要在这里也解短链】用户手动粘贴到兜底框的常常是 b23.tv 短链
     * （分享面板复制出来的就是短链）。原来只有 MainActivity.handleIntent 会解短链，
     * 走 /api/resolve 这条路直接进 parseTarget，短链会被判成"没识别出 BV 号"。
     * 命中短链时在服务端展开，这样任何入口（分享/粘贴/deep link）行为一致。
     */
    static String[] parseTarget(String raw) {
        raw = (raw == null) ? "" : raw.trim();
        int page = 1;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("[?&]p=(\\d+)").matcher(raw);
        if (m.find()) page = Math.max(1, Integer.parseInt(m.group(1)));
        m = java.util.regex.Pattern.compile("(BV[0-9A-Za-z]{10})").matcher(raw);
        if (m.find()) return new String[]{m.group(1), String.valueOf(page)};
        m = java.util.regex.Pattern.compile("av(\\d+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(raw);
        if (m.find()) return new String[]{"av" + m.group(1), String.valueOf(page)};

        // 走到这里说明没有 BV/av，可能是 b23.tv（或其它跳转型）短链
        String expanded = expandShortLink(raw);
        if (expanded != null && !expanded.equals(raw)) {
            java.util.regex.Matcher m2 = java.util.regex.Pattern.compile("[?&]p=(\\d+)").matcher(expanded);
            int p2 = page;
            if (m2.find()) p2 = Math.max(1, Integer.parseInt(m2.group(1)));
            java.util.regex.Matcher m3 = java.util.regex.Pattern.compile("(BV[0-9A-Za-z]{10})").matcher(expanded);
            if (m3.find()) return new String[]{m3.group(1), String.valueOf(p2)};
            java.util.regex.Matcher m4 = java.util.regex.Pattern.compile("av(\\d+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(expanded);
            if (m4.find()) return new String[]{"av" + m4.group(1), String.valueOf(p2)};
        }
        throw new RuntimeException("没识别出 BV 号，请粘贴完整视频链接或 BV 号（短链会自动展开）");
    }

    /** 展开短链：跟随 302 拿最终 URL；若返回 200 页面则扫 body 里的真实链接 */
    private static String expandShortLink(String url) {
        if (url == null) return null;
        String u = url.trim();
        if (!u.startsWith("http")) u = "https://" + u;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setRequestMethod("GET");
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile");
            c.connect();
            String loc = c.getURL().toString();
            if (loc != null && (loc.contains("BV") || loc.contains("/av"))) {
                Log.i(TAG, "短链展开: " + loc);
                return loc;
            }
            // 没跳走就读 body
            InputStream is = c.getInputStream();
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = is.read(buf)) > 0 && total < 512 * 1024) {
                sb.append(new String(buf, 0, n, "UTF-8"));
                total += n;
            }
            is.close();
            String body = sb.toString();
            java.util.regex.Matcher mb =
                    java.util.regex.Pattern.compile("(BV[0-9A-Za-z]{10})").matcher(body);
            if (mb.find()) return mb.group(1);
        } catch (Exception e) {
            Log.w(TAG, "短链展开失败: " + e.getMessage());
        } finally {
            if (c != null) try { c.disconnect(); } catch (Exception ignore) {}
        }
        return null;
    }

    static JSONObject pickStream(JSONArray streams, int wantQn) throws JSONException {
        if (streams == null || streams.length() == 0) return null;
        List<JSONObject> cands = new ArrayList<>();
        for (int i = 0; i < streams.length(); i++) {
            JSONObject s = streams.getJSONObject(i);
            if (s.optInt("id") <= wantQn) cands.add(s);
        }
        if (cands.isEmpty()) for (int i = 0; i < streams.length(); i++) cands.add(streams.getJSONObject(i));
        List<JSONObject> avc = new ArrayList<>();
        for (JSONObject s : cands) if (s.optString("codecs", "").startsWith("avc1")) avc.add(s);
        if (!avc.isEmpty()) cands = avc;
        int best = 0;
        for (JSONObject s : cands) best = Math.max(best, s.optInt("id"));
        List<JSONObject> same = new ArrayList<>();
        for (JSONObject s : cands) if (s.optInt("id") == best) same.add(s);
        if (!avc.isEmpty()) for (JSONObject s : same)
            if (s.optString("codecs", "").startsWith("avc1")) return s;
        JSONObject r = same.get(0);
        for (JSONObject s : same) if (s.optInt("bandwidth", 0) > r.optInt("bandwidth", 0)) r = s;
        return r;
    }

    static JSONObject pickAudio(JSONArray audios) throws JSONException {
        if (audios == null || audios.length() == 0) return null;
        List<JSONObject> ok = new ArrayList<>();
        for (int i = 0; i < audios.length(); i++) {
            JSONObject a = audios.getJSONObject(i);
            if (a.optInt("id") != 30250 && a.optInt("id") != 30251) ok.add(a);
        }
        if (ok.isEmpty()) for (int i = 0; i < audios.length(); i++) ok.add(audios.getJSONObject(i));
        JSONObject r = ok.get(0);
        for (JSONObject a : ok) if (a.optInt("bandwidth", 0) > r.optInt("bandwidth", 0)) r = a;
        return r;
    }

static List<String> urlsOf(JSONObject s) {
List<String> out = new ArrayList<>();
if (s == null) return out;
if (!s.isNull("baseUrl")) out.add(s.optString("baseUrl"));
if (!s.isNull("base_url")) { String u = s.optString("base_url"); if (!out.contains(u)) out.add(u); }
JSONArray bu = s.optJSONArray("backupUrl");
if (bu != null) for (int i = 0; i < bu.length(); i++) {
String u = bu.optString(i);
if (!out.contains(u)) out.add(u);
}
// 节点排序：estgoss/ali 家族对部分出口直接 403，放到最后；
// mcdn / bcache / mirror- 等家族实测可用，排前面，可显著缩短首帧等待。
List<String> good = new ArrayList<>();
List<String> risky = new ArrayList<>();
for (String u : out) {
String h = hostOf(u);
if (h.contains("estgoss") || (h.contains("mirrorali") && h.contains("oss"))) risky.add(u);
else good.add(u);
}
List<String> res = new ArrayList<>(good);
res.addAll(risky);
return res;
}

/** 实测受限的 CDN 节点特征（B 站会对这些节点对部分出口返回 403） */
static boolean isRiskyHost(String host) {
return host != null && (host.contains("estgoss") || host.contains("mirroralib"));
}

    static String boundedRange(String rng) {
        if (rng == null) return "bytes=0-" + (RANGE_CAP - 1);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes=(\\d+)-(\\d*)").matcher(rng.trim());
        if (!m.find()) return "bytes=0-" + (RANGE_CAP - 1);
        long start = Long.parseLong(m.group(1));
        long end = m.group(2).isEmpty() ? start + RANGE_CAP - 1 : Long.parseLong(m.group(2));
        end = Math.min(end, start + RANGE_CAP - 1);
        return "bytes=" + start + "-" + end;
    }

    // ---------------------------------------------------------------- 解析视频
    static JSONObject resolve(String raw, int page, int qn, String cookieUser) throws Exception {
        long t0 = System.currentTimeMillis();
        String[] t = parseTarget(raw);
        String bvid = t[0];
        int bvidPage = Integer.parseInt(t[1]);
        if (page <= 1) page = bvidPage;

        String cacheKey = resolveKey(raw, qn, page);
        long now0 = System.currentTimeMillis();
        JSONObject cached = RESOLVE_CACHE.get(cacheKey);
        if (cached != null && now0 - RESOLVE_TS.getOrDefault(cacheKey, new long[]{0})[0] < 300_000) {
            Log.i(TAG, "resolve " + bvid + " cache HIT (" + (System.currentTimeMillis() - t0) + "ms)");
            return cached;
        }

        String viewUrl = bvid.toLowerCase().startsWith("av")
                ? "https://api.bilibili.com/x/web-interface/view?aid=" + bvid.substring(2)
                : "https://api.bilibili.com/x/web-interface/view?bvid=" + bvid;
        Map<String, String> h = apiHeaders(null);

        // 并行抓取三个互不依赖的请求：view / buvid(spi) / wbi(nav)，把 4 次串行往返压成 2 批
        final long[] ms = new long[3];
        Future<String> fView = POOL.submit(new Callable<String>() {
            public String call() throws Exception {
                long s = System.currentTimeMillis();
                try {
                    return httpGetString(viewUrl, h);
                } catch (Exception e1) {
                    // 弱网/基站切换时握手失败很常见（实测蜂窝网下单次 view 可能要 2.8s，
                    // 抖动时首连直接失败）。只重试一次不够，改为指数退避重试 3 次。
                    Exception last = e1;
                    for (int attempt = 1; attempt <= 3; attempt++) {
                        try { Thread.sleep(300L * attempt); } catch (Exception ignore) {}
                        try { return httpGetString(viewUrl, h); }
                        catch (Exception e2) {
                            last = e2;
                            Log.w(TAG, "view fetch retry " + attempt + " failed: " + e2);
                        }
                    }
                    throw last;
                } finally { ms[0] = System.currentTimeMillis() - s; }
            }
        });
Future<String> fSpi = POOL.submit(new Callable<String>() {
public String call() throws Exception {
long s = System.currentTimeMillis();
try { return httpGetString("https://api.bilibili.com/x/frontend/finger/spi", h); }
catch (Exception e1) {
Log.w(TAG, "spi fetch failed (" + e1 + "), retry once");
try { Thread.sleep(300); } catch (Exception ignore) {}
return httpGetString("https://api.bilibili.com/x/frontend/finger/spi", h);
}
finally { ms[1] = System.currentTimeMillis() - s; }
}
});
Future<String> fNav = POOL.submit(new Callable<String>() {
public String call() throws Exception {
long s = System.currentTimeMillis();
try { return httpGetString("https://api.bilibili.com/x/web-interface/nav", h); }
catch (Exception e1) {
Log.w(TAG, "nav fetch failed (" + e1 + "), retry once");
try { Thread.sleep(300); } catch (Exception ignore) {}
return httpGetString("https://api.bilibili.com/x/web-interface/nav", h);
}
finally { ms[2] = System.currentTimeMillis() - s; }
}
});

String viewBody;
String spiBody = "";
String navBody = "";
try { viewBody = fView.get(30, TimeUnit.SECONDS); }
catch (Exception e) {
            // 明确区分「超时」与「其它失败」，否则用户在弱网下只看到一句
            // 「网络超时」，无法判断是网络真不通、还是被 18s 阈值砍掉了。
            // 这里的 30s 覆盖了 view 请求内部的重试（共 3 次尝试）+ 退避等待。
            Log.w(TAG, "view fetch failed: " + e);
            throw new RuntimeException(e instanceof TimeoutException
                    ? "取视频信息超时（网络太慢或 B 站接口无响应），请稍后重试或切到 WiFi"
                    : "取视频信息失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
        try { spiBody = fSpi.get(15, TimeUnit.SECONDS); } catch (Exception ignore) {}
        try { navBody = fNav.get(15, TimeUnit.SECONDS); } catch (Exception ignore) {}

        JSONObject view = new JSONObject(viewBody);
        if (view.optInt("code") != 0)
            throw new RuntimeException("取视频信息失败：" + view.optString("message"));
        JSONObject v = view.getJSONObject("data");

        // 评论与时间戳：与 playurl 并行抓取（仅依赖 aid），内联进解析结果，省掉前端二次请求
        final String aidStr = String.valueOf(v.optLong("aid"));
        Future<JSONObject> fReplies = POOL.submit(new Callable<JSONObject>() {
            public JSONObject call() throws Exception {
                JSONArray r = fetchReplies(aidStr, 5, 20);
                JSONObject o = new JSONObject();
                o.put("count", r.length());
                o.put("matched", extractTimestamps(r));
                return o;
            }
        });

        JSONArray pages = v.optJSONArray("pages");
        if (page < 1) page = 1;
        if (pages != null && pages.length() > 0) page = Math.min(page, pages.length());
        long cid;
        String part = "";
        if (pages != null && pages.length() > 0) {
            JSONObject pg = pages.getJSONObject(page - 1);
            cid = pg.getLong("cid");
            part = pg.optString("part");
        } else cid = v.getLong("cid");

        // buvid cookie（spi 失败则退化空串，不影响 playurl 基础可用性）
        String buvid = "";
        try {
            JSONObject o = new JSONObject(spiBody).getJSONObject("data");
            buvid = "buvid3=" + o.optString("b_3", "") + "; buvid4=" + o.optString("b_4", "");
            buvidCookie = buvid; buvidTs = System.currentTimeMillis();
        } catch (Exception ignore) {}
        String cookie = (buvid + " " + (cookieUser == null ? "" : cookieUser.trim())).trim();
        lastCookie = cookie;

        // wbi 密钥（优先用本次并发抓到的 nav；失败则退回缓存）
        try {
            JSONObject img = new JSONObject(navBody).getJSONObject("data").getJSONObject("wbi_img");
            String ik = img.getString("img_url").replaceAll(".*/", "").replaceAll("\\..*", "");
            String sk = img.getString("sub_url").replaceAll(".*/", "").replaceAll("\\..*", "");
            if (!ik.isEmpty() && !sk.isEmpty()) { wbiKey = new String[]{ik, sk}; wbiTs = System.currentTimeMillis(); }
        } catch (Exception ignore) {}

Map<String, String> q = new LinkedHashMap<>();
q.put("bvid", v.getString("bvid"));
q.put("cid", String.valueOf(cid));
q.put("qn", String.valueOf(qn));
q.put("fnver", "0");
q.put("fnval", "4048");
q.put("fourk", "1");
// 仅请求高质量源以获取更完整的 CDN 节点候选。
// 注意：不能加 platform=html5/otype=json —— 那会让 B 站改走 durl(单文件) 而不返回 dash，
// 导致「该视频未返回 DASH 流」。节点分配主要取决于 UA 与 high_quality。
q.put("high_quality", "1");
        String signed = wbiSign(q);

        long tp0 = System.currentTimeMillis();
        JSONObject pu = null;
        for (int pa = 0; pa < 2; pa++) {
            // -352 风控时刷新 buvid 再试一次（登录 cookie 已在 cookie 里）
            String playCookie = (pa == 0) ? cookie : (cookie + " " + freshBuvidCookie()).trim();
            pu = new JSONObject(httpGetString(
                    "https://api.bilibili.com/x/player/wbi/playurl?" + signed, apiHeaders(playCookie)));
            if (pu.optInt("code") != -352) break;
            Log.w(TAG, "playurl -352 风控，刷新 buvid 重试");
        }
        long msPu = System.currentTimeMillis() - tp0;
        if (pu.optInt("code") != 0)
            throw new RuntimeException("取播放地址失败：" + pu.optString("message"));
        JSONObject data = pu.getJSONObject("data");
        JSONObject dash = data.optJSONObject("dash");
        if (dash == null) throw new RuntimeException("该视频未返回 DASH 流（可能是番剧/直播/付费内容）");

        JSONObject vs = pickStream(dash.optJSONArray("video"), qn);
        JSONObject as = pickAudio(dash.optJSONArray("audio"));
        if (vs == null) throw new RuntimeException("没有可用的视频流");

        // 收齐并行抓取到的评论/时间戳（失败则降级为空，不阻塞解析）
        JSONObject repObj = new JSONObject();
        repObj.put("count", 0);
        repObj.put("matched", new JSONArray());
        try { repObj = fReplies.get(12, TimeUnit.SECONDS); } catch (Exception ignore) {}

        String token = UUID.randomUUID().toString().replace("-", "");
        MediaEntry me = new MediaEntry();
        me.v = urlsOf(vs);
        me.a = (as != null) ? urlsOf(as) : new ArrayList<>();
        me.bvid = v.optString("bvid");
        me.page = page;
        me.qn = qn;
        MEDIA.put(token, me);
        long now = System.currentTimeMillis();
        for (Iterator<Map.Entry<String, MediaEntry>> it = MEDIA.entrySet().iterator(); it.hasNext(); ) {
            if (now - it.next().getValue().ts > 7200_000) it.remove();
        }

        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("token", token);
        out.put("bvid", v.optString("bvid"));
        out.put("aid", v.optLong("aid"));
        out.put("cid", cid);
        out.put("title", v.optString("title"));
        out.put("owner", v.optJSONObject("owner") == null ? "" : v.optJSONObject("owner").optString("name", ""));
        out.put("pic", v.optString("pic"));
        out.put("duration", dash.optDouble("duration", v.optDouble("duration", 0)));
        out.put("page", page);
        JSONArray pa = new JSONArray();
        if (pages != null) for (int i = 0; i < pages.length(); i++) {
            JSONObject p = pages.getJSONObject(i);
            JSONObject o = new JSONObject();
            o.put("index", p.optInt("page"));
            o.put("cid", p.optLong("cid"));
            o.put("part", p.optString("part"));
            pa.put(o);
        }
        out.put("pages", pa);
        out.put("quality", vs.optInt("id"));
        out.put("qualityName", QUALITY_NAME.getOrDefault(vs.optInt("id"), String.valueOf(vs.optInt("id"))));
        JSONArray ql = new JSONArray();
        JSONArray aq = data.optJSONArray("accept_quality");
        if (aq != null) for (int i = 0; i < aq.length(); i++) {
            int qq = aq.optInt(i);
            JSONObject o = new JSONObject();
            o.put("qn", qq);
            o.put("name", QUALITY_NAME.getOrDefault(qq, String.valueOf(qq)));
            ql.put(o);
        }
        out.put("qualityList", ql);
        JSONObject vid = new JSONObject();
        vid.put("id", vs.optInt("id"));
        vid.put("codecs", vs.optString("codecs"));
        vid.put("width", vs.optInt("width"));
        vid.put("height", vs.optInt("height"));
        vid.put("bandwidth", vs.optInt("bandwidth"));
        out.put("video", vid);
        JSONObject aud = new JSONObject();
        aud.put("id", as != null ? as.optInt("id") : 0);
        aud.put("bandwidth", as != null ? as.optInt("bandwidth") : 0);
        out.put("audio", aud);
        out.put("replyCount", repObj.optInt("count"));
        out.put("matched", repObj.optJSONArray("matched"));
        out.put("loggedIn", cookieUser != null && cookieUser.matches(".*SESSDATA=[^;]+.*"));

        if (RESOLVE_CACHE.size() > 64) { RESOLVE_CACHE.clear(); RESOLVE_TS.clear(); }
        RESOLVE_CACHE.put(cacheKey, out);
        RESOLVE_TS.put(cacheKey, new long[]{System.currentTimeMillis()});
        Log.i(TAG, "resolve " + bvid + " timings(ms): view=" + ms[0] + " buvid=" + ms[1]
                + " wbi=" + ms[2] + " playurl=" + msPu + " total=" + (System.currentTimeMillis() - t0));
        return out;
    }

    // ---------------------------------------------------------------- 空间动态 feed（VCNC 足球账号）
    /** VCNC 的 B 站 UID（mid）：只播放该账号的足球视频 */
    static final long FEED_MID = 432185343L;
    /** feed 缓存：offset -> JSON。动态接口对突发请求会返回 -352 风控，必须缓存降压 */
    static final Map<String, long[]> FEED_TS = new ConcurrentHashMap<>();
    static final Map<String, JSONObject> FEED_CACHE = new ConcurrentHashMap<>();

    /** 标题/简介命中这些词视为足球内容（VCNC 也发科技类视频，需要过滤） */
    static final String[] FOOTBALL_IN = {
            "实况", "集锦", "五人场", "七人场", "八人场", "十一人", "足球", "比赛", "训练",
            "联赛", "杯赛", "友谊赛", "约战", "进球", "扑救", "门将", "球场", "对抗", "射门",
            "过人", "角球", "点球", "红牌", "乌龙", "逆转", "绝杀", "十佳球", "周最佳", "年度",
            "赛季", "欧冠", "世界杯", "欧洲杯", "英超", "西甲", "意甲", "德甲", "法甲", "中超",
            "足协杯", "亚洲杯", "世预赛", "奥运会", "足球场", "看球"};
    /** 标题/简介命中这些词直接排除（账号签名里带的科技/电脑方向） */
    static final String[] FOOTBALL_OUT = {
            "科技", "电脑", "软件", "硬件", "手机", "评测", "开箱", "编程", "代码",
            "路由器", "NAS", "磁盘", "硬盘", "CPU", "显卡", "内存", "显示器", "键盘",
            "鼠标", "笔记本", "科学", "拆机", "装机"};

    static boolean isFootballVideo(String title, String desc) {
        String t = ((title == null) ? "" : title) + " " + ((desc == null) ? "" : desc);
        for (String k : FOOTBALL_OUT) if (t.contains(k)) return false;
        for (String k : FOOTBALL_IN) if (t.contains(k)) return true;
        return false;
    }

    /** 强制刷新 buvid cookie（-352 风控时旧 cookie 可能已失效） */
    static String freshBuvidCookie() {
        try {
            String d = httpGetString("https://api.bilibili.com/x/frontend/finger/spi", apiHeaders(null));
            JSONObject o = new JSONObject(d).getJSONObject("data");
            buvidCookie = "buvid3=" + o.optString("b_3", "") + "; buvid4=" + o.optString("b_4", "");
            buvidTs = System.currentTimeMillis();
        } catch (Exception e) { Log.w(TAG, "freshBuvid failed: " + e); }
        return buvidCookie;
    }

    /**
     * feed 接口专用请求头。
     *
     * 【实测】x/polymer/web-dynamic/v1/feed/space 对 Origin 头敏感：
     * 带 Origin: https://www.bilibili.com 时要么返回 -352，要么返回 code=0 但
     * items 为空（软风控）；去掉 Origin 后正常返回。其它接口（view/reply/playurl）
     * 带 Origin 无此问题，因此只给 feed 用这组精简头。
     */
    static Map<String, String> feedHeaders(String cookie) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("User-Agent", UA);
        h.put("Referer", "https://www.bilibili.com/");
        if (cookie != null && !cookie.isEmpty()) h.put("Cookie", cookie);
        return h;
    }

    /**
     * 拉取 VCNC 的空间动态（投稿视频流）。
     *
     * 【为什么走动态接口而不是 space/wbi/arc/search】实测 arc/search 已加风控：
     * 带 wbi 签名 + buvid + dm_img_list 仍返回 -352 / HTTP 412。而
     * x/polymer/web-dynamic/v1/feed/space 只要 buvid cookie 即可返回（无需 wbi 签名），
     * 且本身就是按时间倒序的投稿流，天然适合做 feed。
     *
     * 分页：offset 为空表示第一页；响应里的 data.offset 是下一页游标（base64），
     * data.has_more 表示是否还有。
     *
     * 风控策略：对 -352 刷新 buvid + 指数退避重试（4 次尝试，间隔 1s/3s/6s）；
     * 5 分钟缓存同一 offset，避免重复请求。userCookie 为用户提供的 SESSDATA
     * （登录态请求风控阈值高得多，设置里可填）。
     */
    static JSONObject fetchSpaceFeed(String offset, String userCookie) throws Exception {
        String off = (offset == null) ? "" : offset.trim();
        String cacheKey = off.isEmpty() ? "first" : off;
        JSONObject cached = FEED_CACHE.get(cacheKey);
        if (cached != null && System.currentTimeMillis() - FEED_TS.getOrDefault(cacheKey, new long[]{0})[0] < 300_000) {
            Log.i(TAG, "feed cache HIT offset=" + cacheKey.substring(0, Math.min(8, cacheKey.length())));
            return cached;
        }
        Exception last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            try {
                // -352 是该接口的 IP 级滑动窗口限流（实测每 2~3 次请求后封锁数分钟），
                // 快速重试只会让窗口持续发热，退避要拉开：1s/3s/6s
                if (attempt > 0) Thread.sleep(new long[]{0, 1000, 3000, 6000}[attempt]);
                JSONObject r = fetchSpaceFeedOnce(off, attempt > 0, userCookie);
                if (r == null) continue;  // -352，已刷新 buvid，进入下一次重试
                if (FEED_CACHE.size() > 32) { FEED_CACHE.clear(); FEED_TS.clear(); }
                FEED_CACHE.put(cacheKey, r);
                FEED_TS.put(cacheKey, new long[]{System.currentTimeMillis()});
                return r;
            } catch (Exception e) {
                last = e;
                Log.w(TAG, "feed attempt " + attempt + " failed: " + e.getMessage());
            }
        }
        throw (last == null) ? new RuntimeException("动态接口风控中（-352），请稍后重试或在设置里填写登录 Cookie") : last;
    }

    /** 单次请求；返回 null 表示 -352 需要重试 */
    private static JSONObject fetchSpaceFeedOnce(String offset, boolean refreshBuvid, String userCookie) throws Exception {
        StringBuilder u = new StringBuilder(
                "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=")
                .append(FEED_MID).append("&platform=web&features=itemOpusStyle");
        if (!offset.isEmpty()) u.append("&offset=").append(java.net.URLEncoder.encode(offset, "UTF-8"));
        String buvid = refreshBuvid ? freshBuvidCookie() : buvidCookie();
        String cookie = (buvid + " " + (userCookie == null ? "" : userCookie.trim())).trim();
        JSONObject d = new JSONObject(httpGetString(u.toString(), feedHeaders(cookie)));
        if (d.optInt("code") == -352) {
            Log.w(TAG, "feed -352 风控（refreshBuvid=" + refreshBuvid + "），重试");
            return null;
        }
        if (d.optInt("code") != 0)
            throw new RuntimeException("动态接口失败：" + d.optString("message"));
        JSONObject data = d.optJSONObject("data");
        if (data == null) throw new RuntimeException("动态接口无数据");

        JSONArray items = data.optJSONArray("items");
        JSONArray all = new JSONArray();     // 原始列表（未过滤）
        JSONArray football = new JSONArray(); // 足球过滤后
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                JSONObject mod = it.optJSONObject("modules");
                if (mod == null) continue;
                JSONObject md = mod.optJSONObject("module_dynamic");
                if (md == null) continue;
                JSONObject major = md.optJSONObject("major");
                if (major == null || !"MAJOR_TYPE_ARCHIVE".equals(major.optString("type"))) continue;
                JSONObject arc = major.optJSONObject("archive");
                if (arc == null) continue;
                String bvid = arc.optString("bvid", "");
                if (bvid.isEmpty()) continue;
                JSONObject o = new JSONObject();
                o.put("bvid", bvid);
                o.put("aid", arc.optLong("aid"));
                o.put("title", arc.optString("title", ""));
                // cover 是协议相对地址（//i0.hdslb.com/...），前端补 https:
                o.put("pic", arc.optString("cover", ""));
                o.put("duration", arc.optString("duration_text", ""));
                long pub = 0;
                JSONObject ma = mod.optJSONObject("module_author");
                if (ma != null) pub = ma.optLong("pub_ts", 0);
                o.put("pubdate", pub);
                o.put("desc", arc.optString("desc", ""));
                // 集锦系列：标题带「集锦」（实况录像+集锦 一体视频，时间戳在置顶评论）
                o.put("hl", o.optString("title", "").contains("集锦"));
                all.put(o);
                if (isFootballVideo(o.getString("title"), o.getString("desc"))) football.put(o);
            }
        }
        // 过滤后为空但原始有内容时不过滤（账号以足球为主，避免误杀）
        JSONArray use = (football.length() > 0) ? football : all;
        // 账号有 454 个视频，返回空只可能是被风控（软封锁：code=0 但 items 为空），
        // 按失败处理，让上层走重试/缓存兜底，而不是给用户看「暂无可播放的视频」
        if (use.length() == 0) {
            Log.w(TAG, "feed 返回为空（疑似软风控），按失败处理");
            return null;
        }
        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("videos", use);
        out.put("offset", data.optString("offset", ""));
        out.put("hasMore", data.optBoolean("has_more", false));
        out.put("filtered", football.length() > 0 && football.length() < all.length());
        Log.i(TAG, "feed ok offset=" + (offset.isEmpty() ? "first" : offset.substring(0, Math.min(8, offset.length())))
                + " all=" + all.length() + " football=" + football.length()
                + " hasMore=" + out.optBoolean("hasMore"));
        return out;
    }

    // ---------------------------------------------------------------- 媒体代理
    static MediaResult openMedia(String token, String kind, int idx, String range) {
        MediaResult res = new MediaResult();
        MediaEntry me = MEDIA.get(token);
        if (me == null) { res.status = 404; return res; }
        List<String> urls = "v".equals(kind) ? me.v : me.a;
        if (urls == null || urls.isEmpty()) { res.status = 404; return res; }
        List<String> rotated = new ArrayList<>(urls.subList(Math.min(idx, urls.size() - 1), urls.size()));
        rotated.addAll(urls.subList(0, Math.min(idx, urls.size() - 1)));
        if (idx >= urls.size()) rotated = new ArrayList<>(urls);

        String upRange = boundedRange(range);
        for (String url : rotated) {
            long tm = System.currentTimeMillis();
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                forceV4(c);
                c.setRequestMethod("GET");
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Referer", "https://www.bilibili.com/");
                c.setRequestProperty("Origin", "https://www.bilibili.com");
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("Accept-Encoding", "identity");
                if (lastCookie != null && !lastCookie.isEmpty()) c.setRequestProperty("Cookie", lastCookie);
                c.setRequestProperty("Range", upRange);
                c.setConnectTimeout(8000);
                c.setReadTimeout(30000);
                int st = c.getResponseCode();
                if (st == 200 || st == 206) {
                    res.status = st;
                    res.stream = c.getInputStream();
                    res.contentType = c.getContentType();
                    res.contentRange = c.getHeaderField("Content-Range");
                    res.contentLength = c.getContentLength();
                    res.acceptRanges = c.getHeaderField("Accept-Ranges");
                    res.etag = c.getHeaderField("ETag");
                    Log.i(TAG, "media ok kind=" + kind + " st=" + st + " host=" + hostOf(url)
                            + " range=" + upRange + " took=" + (System.currentTimeMillis() - tm) + "ms");
                    return res;
                }
// 非 200/206（如403防盗链/404）必须记录，否则整条链路是黑盒
Log.w(TAG, "media upstream HTTP " + st + " kind=" + kind + " host=" + hostOf(url)
+ " range=" + upRange + " ctype=" + c.getContentType()
+ " msg=" + readErr(c) + " url=" + redact(url)
+ " took=" + (System.currentTimeMillis() - tm) + "ms");
                c.disconnect();
            } catch (Exception ex) {
                Log.w(TAG, "media upstream failed kind=" + kind + " host=" + hostOf(url)
                        + " range=" + upRange + " err=" + ex.getClass().getSimpleName() + ": " + ex.getMessage()
                        + " took=" + (System.currentTimeMillis() - tm) + "ms");
            }
        }
        res.status = 502;
        return res;
    }

static String hostOf(String url) {
try { return new URL(url).getHost(); } catch (Exception e) { return "?"; }
}

/** 打印媒体 URL 时把签名类参数打码，避免日志泄露过期签名 */
static String redact(String url) {
try {
java.net.URL u = new URL(url);
StringBuilder sb = new StringBuilder();
sb.append(u.getProtocol()).append("://").append(u.getHost()).append(u.getPath()).append("?");
java.util.Map<String, String[]> q = u.getQuery() != null
? parseQueryMap(u.getQuery()) : new java.util.HashMap<>();
boolean first = true;
for (java.util.Map.Entry<String, String[]> e : new java.util.TreeMap<>(q).entrySet()) {
if (!first) sb.append("&");
first = false;
String k = e.getKey();
String v = e.getValue() != null && e.getValue().length > 0 ? e.getValue()[0] : "";
// 签名/令牌类参数只保留长度，避免日志泄露
if (k.equals("sign") || k.equals("token") || k.equals("access_key_id") || k.equals("hdnts")
|| k.equals("expires") || k.equals("e") || k.equals("oi") || k.equals("platform")
|| k.equals("upsig") || k.equals("uparams") || k.equals("uipk") || k.equals("trid")) {
sb.append(k).append("=").append(v.length() > 8 ? v.substring(0, 6) + "***" : "***");
} else {
sb.append(k).append("=").append(v);
}
}
return sb.toString();
} catch (Exception e) {
return url;
}
}

static java.util.Map<String, String[]> parseQueryMap(String qs) {
java.util.Map<String, String[]> m = new java.util.LinkedHashMap<>();
if (qs == null || qs.isEmpty()) return m;
for (String pair : qs.split("&")) {
int eq = pair.indexOf('=');
String k, v;
try {
if (eq < 0) { k = URLDecoder.decode(pair, "UTF-8"); v = ""; }
else { k = URLDecoder.decode(pair.substring(0, eq), "UTF-8"); v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8"); }
} catch (Exception e) { continue; }
m.put(k, new String[]{v});
}
return m;
}

    static String readErr(HttpURLConnection c) {
        try {
            java.io.InputStream es = c.getErrorStream();
            if (es == null) return "";
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[512];
            int n;
            while ((n = es.read(b)) > 0 && bo.size() < 400) bo.write(b, 0, n);
            es.close();
            return new String(bo.toByteArray(), "UTF-8").replaceAll("\\s+", " ");
        } catch (Exception e) {
            return "";
        }
    }
}
