package com.hplayer;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * /api/media 的磁盘缓存：把 B 站视频 / 音频的 Range 响应落到本机，重开 App 直接命中。
 *
 * 【为什么做在代理层】前端只认 /api/media/&lt;token&gt;/v?i=0，token 每次 resolve 都是新的
 * UUID，WebView 自己的 HTTP 缓存因此永远 miss。这里用「bvid|page|qn|v|a」做稳定 key
 * （见 BiliApi.mediaCacheKey），与 token 解耦，所以关掉 App 再进同一场比赛仍能秒开。
 *
 * 【条目粒度】沿用 BiliApi.RANGE_CAP（单次最多 3MB）的有界区间，一条缓存 = 一个
 * [start,end] 字节区间文件。真机日志显示播放器每次 seek 都会发起点不同的 3MB 请求，
 * 且经常读一小段就断开（大量 Broken pipe / Connection reset），因此两条关键设计：
 *   1) 被中断时把已下载的连续前缀照样落盘为 [start, start+written-1]，不整条丢弃；
 *   2) 命中只要求某条目覆盖请求起点，206 只回该条目实际拥有的那一段（Content-Range
 *      写真实范围，HTTP 允许），播放器会自己接着请求后续字节。
 * 实测 N6 强杀重启后 hits=9 / misses=0，缓存占用不增，logcat 无任何上游媒体请求。
 * 未命中时上游仍只发一次请求（tee 到临时文件），不增加对 B 站 CDN 的请求数。
 *
 * 【淘汰】按文件 lastModified 做 LRU，超过上限时一直删到 90% 留余量，
 * 防止刚好卡在阈值上反复抖动。客户端提前断开时临时文件直接丢弃，不落半条。
 */
public final class MediaCache {
    private static final String TAG = "HPlayer";
    public static final int DEFAULT_MB = 600;
    public static final int MIN_MB = 50;
    public static final int MAX_MB = 2048;
    private static final String PREF = "mediacache";
    private static final String KEY_LIMIT = "limit_mb";
    private static final long RANGE_CAP = BiliApi.RANGE_CAP;
    private static final Pattern RANGE_RE = Pattern.compile("bytes=(\\d+)-(\\d*)");
    private static final Pattern CR_RE = Pattern.compile("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)");

    private final Context ctx;
    private final File root;
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();

    private static volatile MediaCache INSTANCE = null;

    private MediaCache(Context c) {
        ctx = c.getApplicationContext();
        File ext = ctx.getExternalFilesDir(null);
        File base = (ext != null) ? ext : ctx.getFilesDir();
        root = new File(base, "mediacache");
        if (!root.isDirectory()) root.mkdirs();
        cleanStaleTmp();
    }

    public static MediaCache get(Context c) {
        if (INSTANCE == null) {
            synchronized (MediaCache.class) {
                if (INSTANCE == null) INSTANCE = new MediaCache(c);
            }
        }
        return INSTANCE;
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public int limitMb() {
        int v = prefs().getInt(KEY_LIMIT, DEFAULT_MB);
        if (v < MIN_MB || v > MAX_MB) return DEFAULT_MB;
        return v;
    }

    public long limitBytes() {
        return (long) limitMb() * 1024L * 1024L;
    }

    public synchronized void setLimitMb(int mb) {
        int v = Math.max(MIN_MB, Math.min(MAX_MB, mb));
        prefs().edit().putInt(KEY_LIMIT, v).apply();
        trim();
    }

    // ---------------------------------------------------------------- 对外主入口

    public interface Upstream {
        /** 按给定的 Range 头向上游取流；返回 null 表示不可用 */
        BiliApi.MediaResult fetch(String rangeHeader);
    }

    /** 一次媒体请求的完整结果，ProxyServer 只需照着写响应头 + writeTo(os) */
    public static final class Response {
        private final MediaCache owner;
        private final String key;
        public long start, end, total, length;
        public String contentType;
        public boolean fromCache;
        public boolean passthrough;          // 上游不给 206 / 流不可用 → 走原来的透传逻辑
        public BiliApi.MediaResult raw;
        private InputStream in;
        private File tmp;
        private FileOutputStream tmpOut;
        private long written;

        Response(MediaCache o, String k) { owner = o; key = k; }

        /** 把 body 写给客户端；顺便 tee 落盘。异常时自动丢弃不完整的临时文件。 */
        public void writeTo(OutputStream os) throws IOException {
            boolean ok = false;
            try {
                byte[] buf = new byte[65536];
                long left = length;
                while (left > 0) {
                    int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n <= 0) break;
                    os.write(buf, 0, n);
                    if (tmpOut != null) tmpOut.write(buf, 0, n);
                    written += n;
                    left -= n;
                }
                ok = (left == 0);
            } finally {
                finish(ok);
            }
        }

        /** 客户端在写响应头之前就断了：关流、丢弃临时文件（幂等） */
        public void abort() { finish(false); }

        private void finish(boolean ok) {
            if (tmpOut != null) {
                try { tmpOut.close(); } catch (IOException ignore) {}
                tmpOut = null;
            }
            try { if (in != null) in.close(); } catch (IOException ignore) {}
            in = null;
            if (fromCache || tmp == null) return;
            // 播放器经常拿到够用的字节就 seek 断开（日志里大量 Broken pipe），
            // 已下载的那一段仍是连续可用的字节区间，照样落盘：commit 到 [start, start+written-1]。
            if (written == length) owner.commit(tmp, key, start, end, total, written);
            else if (written > 0) owner.commit(tmp, key, start, start + written - 1, total, written);
            else tmp.delete();
            tmp = null;
        }
    }

    /**
     * 准备一次响应：能命中就纯本地读，否则向 B 站拉一次并顺手落盘。
     * 返回的 Response 若为 passthrough，ProxyServer 应改用 raw 走原逻辑。
     */
    public Response prepare(String key, String clientRange, String defaultCtype, Upstream up) {
        long[] se = bounded(clientRange);
        long s = se[0], e = se[1];
        Response r = new Response(this, key);
        r.start = s;
        r.end = e;
        r.total = readTotal(key);
        r.contentType = defaultCtype;

        Hit hit = find(keyDir(key, false), s, e);
        if (hit != null) {
            try {
                FileInputStream fin = new FileInputStream(hit.file);
                long off = s - hit.start, skipped = 0;
                while (skipped < off) {
                    long k = fin.skip(off - skipped);
                    if (k <= 0) break;
                    skipped += k;
                }
                if (skipped != off) throw new IOException("skip short");
                hit.file.setLastModified(System.currentTimeMillis());
                r.end = hit.end;                       // 可能短于请求的 e，Content-Range 会写真实值
                r.length = r.end - s + 1;
                r.in = new LimitedInputStream(fin, r.length);
                r.fromCache = true;
                r.contentType = readCtype(key, defaultCtype);
                hits.incrementAndGet();
                return r;
            } catch (Exception ex) {
                Log.w(TAG, "cache read miss (fallback to net): " + ex.getMessage());
                try { if (r.in != null) r.in.close(); } catch (Exception ignore) {}
                r.in = null;
            }
        }

        misses.incrementAndGet();
        BiliApi.MediaResult raw = up.fetch("bytes=" + s + "-" + e);
        r.raw = raw;
        if (raw == null || raw.stream == null || raw.status != 206) {
            r.passthrough = true;
            return r;
        }
        long[] cr = parseContentRange(raw.contentRange);
        long actualEnd = cr != null ? cr[1]
                : (raw.contentLength > 0 ? s + raw.contentLength - 1 : e);
        if (actualEnd < s) actualEnd = e;
        r.end = actualEnd;
        r.length = actualEnd - s + 1;
        if (cr != null && cr[2] > 0) {
            r.total = cr[2];
            writeTotal(key, cr[2]);
        }
        if (raw.contentType != null
                && (raw.contentType.startsWith("video/") || raw.contentType.startsWith("audio/"))) {
            r.contentType = raw.contentType;
        }
        writeCtype(key, r.contentType);

        File tmp = newTmp(key);
        if (tmp == null) { r.passthrough = true; return r; }
        try {
            r.tmp = tmp;
            r.tmpOut = new FileOutputStream(tmp);
        } catch (IOException ex) {
            r.tmp = null;
            r.passthrough = true;
            return r;
        }
        r.in = raw.stream;
        return r;
    }

    /**
     * 主动预取一个字节区间（集锦片段预缓存）：已有条目覆盖就跳过，否则拉一次上游、
     * 完整落盘。与 prepare 的区别是「没有客户端在等这份数据」，纯后台写缓存。
     *
     * @return 实际落盘字节数；0 = 已被现有条目覆盖；-1 = 上游失败
     */
    public long prefetchRange(String key, long s, long e, Upstream up) {
        if (key == null || e < s) return 0;
        Hit hit = find(keyDir(key, false), s, e);
        if (hit != null) return 0;
        BiliApi.MediaResult raw = up.fetch("bytes=" + s + "-" + e);
        if (raw == null || raw.stream == null || raw.status != 206) return -1;
        long[] cr = parseContentRange(raw.contentRange);
        long actualEnd = cr != null ? cr[1]
                : (raw.contentLength > 0 ? s + raw.contentLength - 1 : e);
        if (actualEnd < s) { try { raw.stream.close(); } catch (IOException ignore) {} return -1; }
        long total = cr != null ? cr[2] : 0;
        if (raw.contentType != null
                && (raw.contentType.startsWith("video/") || raw.contentType.startsWith("audio/"))) {
            writeCtype(key, raw.contentType);
        }
        File tmp = newTmp(key);
        if (tmp == null) { try { raw.stream.close(); } catch (IOException ignore) {} return -1; }
        FileOutputStream out = null;
        long written = 0;
        try {
            out = new FileOutputStream(tmp);
            byte[] buf = new byte[65536];
            InputStream in = raw.stream;
            while (written < actualEnd - s + 1) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, actualEnd - s + 1 - written));
                if (n <= 0) break;
                out.write(buf, 0, n);
                written += n;
            }
        } catch (IOException ex) {
            // 中途失败：已写的连续前缀照样有效
        } finally {
            try { if (out != null) out.close(); } catch (IOException ignore) {}
            try { raw.stream.close(); } catch (IOException ignore) {}
        }
        if (written <= 0) { tmp.delete(); return -1; }
        commit(tmp, key, s, s + written - 1, total, written);
        return written;
    }

    // ---------------------------------------------------------------- 区间 / 条目

    static long[] bounded(String rng) {
        long start = 0, end = RANGE_CAP - 1;
        if (rng != null) {
            Matcher m = RANGE_RE.matcher(rng.trim());
            if (m.find()) {
                try {
                    start = Long.parseLong(m.group(1));
                    end = m.group(2).isEmpty() ? start + RANGE_CAP - 1 : Long.parseLong(m.group(2));
                    end = Math.min(end, start + RANGE_CAP - 1);
                } catch (NumberFormatException ignore) {}
            }
        }
        return new long[]{start, end};
    }

    private static long[] parseContentRange(String cr) {
        if (cr == null) return null;
        Matcher m = CR_RE.matcher(cr.trim());
        if (!m.find()) return null;
        try {
            long total = "*".equals(m.group(3)) ? 0 : Long.parseLong(m.group(3));
            return new long[]{Long.parseLong(m.group(1)), Long.parseLong(m.group(2)), total};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static final class Hit {
        File file;
        long start;
        long end;
    }

    /**
     * 找一条覆盖起点 s 的缓存条目，返回实际能提供的末端 end（可能短于请求的 e）。
     * 播放器请求的是 3MB 大区间却常常读一小段就断开，所以「必须完整覆盖」几乎永远不成立；
     * HTTP 206 本来就允许服务器只回请求范围的一部分（Content-Range 写真实范围即可），
     * 播放器拿到后会继续请求剩下的字节，于是重叠/部分条目也能被反复复用。
     */
    private static Hit find(File kd, long s, long e) {
        if (kd == null) return null;
        File[] fs = kd.listFiles();
        if (fs == null) return null;
        Hit best = null;
        for (File f : fs) {
            long[] se = parseEntryName(f.getName());
            if (se == null || se[0] > s || se[1] < s) continue;
            if (f.length() != se[1] - se[0] + 1) continue;
            long availEnd = Math.min(se[1], e);
            if (availEnd < s) continue;
            if (best == null || availEnd > best.end) {
                Hit h = new Hit();
                h.file = f;
                h.start = se[0];
                h.end = availEnd;
                best = h;
            }
        }
        return best;
    }

    private static long[] parseEntryName(String n) {
        if (!n.endsWith(".bin")) return null;
        int u = n.indexOf('_');
        if (u <= 0) return null;
        try {
            return new long[]{
                    Long.parseLong(n.substring(0, u)),
                    Long.parseLong(n.substring(u + 1, n.length() - 4))};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private File keyDir(String key, boolean create) {
        File d = new File(root, md5(key));
        if (create && !d.isDirectory()) d.mkdirs();
        return d;
    }

    private File newTmp(String key) {
        File kd = keyDir(key, true);
        if (!kd.isDirectory()) return null;
        return new File(kd, System.nanoTime() + "_" + (int) (Math.random() * 100000) + ".tmp");
    }

    private long readTotal(String key) {
        return readLongMeta(new File(keyDir(key, false), "total"));
    }

    private void writeTotal(String key, long total) {
        writeMeta(new File(keyDir(key, true), "total"), String.valueOf(total));
    }

    private String readCtype(String key, String dflt) {
        File f = new File(keyDir(key, false), "ctype");
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] b = new byte[128];
            int n = in.read(b);
            if (n > 0) {
                String v = new String(b, 0, n, "UTF-8").trim();
                if (v.startsWith("video/") || v.startsWith("audio/")) return v;
            }
        } catch (Exception ignore) {
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignore) {}
        }
        return dflt;
    }

    private void writeCtype(String key, String ctype) {
        if (ctype == null) return;
        File f = new File(keyDir(key, true), "ctype");
        if (f.isFile() && f.length() > 0) return;      // 只写一次，避免每个请求都落盘
        writeMeta(f, ctype);
    }

    private static long readLongMeta(File f) {
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] b = new byte[32];
            int n = in.read(b);
            if (n > 0) return Long.parseLong(new String(b, 0, n, "UTF-8").trim());
        } catch (Exception ignore) {
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignore) {}
        }
        return 0;
    }

    private static void writeMeta(File f, String v) {
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f);
            out.write(v.getBytes("UTF-8"));
        } catch (Exception ignore) {
        } finally {
            try { if (out != null) out.close(); } catch (Exception ignore) {}
        }
    }

    // ---------------------------------------------------------------- 落盘 / 淘汰

    private synchronized void commit(File tmp, String key, long s, long e, long total, long written) {
        if (tmp == null) return;
        if (written != e - s + 1) { tmp.delete(); return; }
        File kd = keyDir(key, true);
        File dst = new File(kd, s + "_" + e + ".bin");
        File[] fs = kd.listFiles();
        if (fs != null) {
            // 已有更大的完整区间盖住本次 → 不必写小碎片
            for (File f : fs) {
                long[] se = parseEntryName(f.getName());
                if (se != null && se[0] <= s && se[1] >= e
                        && f.length() == se[1] - se[0] + 1) {
                    tmp.delete();
                    return;
                }
            }
            // 反过来：新条目完全覆盖的旧条目删掉，避免重叠区间重复占额度
            for (File f : fs) {
                long[] se = parseEntryName(f.getName());
                if (se != null && !f.equals(dst) && se[0] >= s && se[1] <= e) f.delete();
            }
        }
        if (!tmp.renameTo(dst)) { tmp.delete(); return; }
        dst.setLastModified(System.currentTimeMillis());
        if (total > 0) writeTotal(key, total);
        trim();
    }

    /** LRU 淘汰：超限时按最后访问时间从旧到新删，一直删到 90% 留余量 */
    public synchronized void trim() {
        List<File> all = new ArrayList<>();
        collect(root, all);
        long used = 0;
        for (File f : all) used += f.length();
        long limit = limitBytes();
        if (used <= limit) return;
        final long target = (long) (limit * 0.9);
        Collections.sort(all, new Comparator<File>() {
            @Override public int compare(File a, File b) {
                long d = a.lastModified() - b.lastModified();
                return d < 0 ? -1 : (d > 0 ? 1 : 0);
            }
        });
        for (File f : all) {
            if (used <= target) break;
            long sz = f.length();
            if (f.delete()) used -= sz;
        }
        Log.i(TAG, "media cache trimmed to " + (used / 1048576L) + "MB / limit " + limitMb() + "MB");
    }

    private static void collect(File dir, List<File> out) {
        File[] fs = dir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            if (f.isDirectory()) collect(f, out);
            else if (f.getName().endsWith(".bin")) out.add(f);
        }
    }

    /** 上次被 seek 打断留下的半成品，超过 1 小时就清掉 */
    private void cleanStaleTmp() {
        final long cut = System.currentTimeMillis() - 3600_000L;
        File[] kds = root.listFiles();
        if (kds == null) return;
        for (File d : kds) {
            if (!d.isDirectory()) continue;
            File[] fs = d.listFiles();
            if (fs == null) continue;
            for (File f : fs) {
                if (f.getName().endsWith(".tmp") && f.lastModified() < cut) f.delete();
            }
        }
    }

    public synchronized void clear() {
        File[] kds = root.listFiles();
        if (kds != null) {
            for (File d : kds) {
                File[] fs = d.isDirectory() ? d.listFiles() : null;
                if (fs != null) for (File f : fs) f.delete();
                if (d.isDirectory()) d.delete();
            }
        }
        hits.set(0);
        misses.set(0);
    }

    public synchronized JSONObject stat() throws JSONException {
        List<File> all = new ArrayList<>();
        collect(root, all);
        long used = 0;
        for (File f : all) used += f.length();
        int videos = 0;
        File[] kds = root.listFiles();
        if (kds != null) for (File d : kds) if (d.isDirectory()) videos++;
        long h = hits.get(), m = misses.get();
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("limitMb", limitMb());
        o.put("limitBytes", limitBytes());
        o.put("usedBytes", used);
        o.put("usedMb", Math.round(used / 104857.6) / 10.0);
        o.put("entries", all.size());
        o.put("videos", videos);
        o.put("hits", h);
        o.put("misses", m);
        o.put("hitRate", (h + m) > 0 ? Math.round(h * 1000.0 / (h + m)) / 10.0 : 0);
        return o;
    }

    private static String md5(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.substring(0, 20);
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** 只读前 len 字节，避免命中条目尾部那些本次不需要的字节被写回客户端 */
    private static final class LimitedInputStream extends FilterInputStream {
        private long left;
        LimitedInputStream(InputStream in, long len) { super(in); left = len; }
        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int r = super.read();
            if (r >= 0) left--;
            return r;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int r = super.read(b, off, (int) Math.min(len, left));
            if (r > 0) left -= r;
            return r;
        }
    }
}
