package com.hplayer;

import com.vcncfootball.R;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.Bundle;
import android.text.Spanned;
import android.text.style.URLSpan;
import android.util.DisplayMetrics;
import android.net.Uri;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final int NATURAL_DPI = 411;
    /**
     * 超过这个值才判定为系统「显示大小」被放大。
     * 取 600 是因为现代旗舰机（含折叠屏内外屏）正常 density 就在 440~560：
     * 实测 N6 内屏展开 442dpi、折叠态 520dpi，都属于正常值，不能动。
     * 而被「显示大小」放到最大时会飙到 ~1300dpi（CSS 视口压到 ~125px，页面全糊）。
     */
    private static final int ABNORMAL_DPI_THRESHOLD = 600;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        // 直接修改全局 Resources / Configuration / DisplayMetrics，覆盖系统的"显示大小"放大。
        // 用 createConfigurationContext 包一层的话 WebView 拿不到，得原地改。
        //
        // 【改为上限钳制的原因】原来是无条件把所有机型强行拉到 411dpi。
        // 折叠屏外屏（cover display）的真实 density 通常明显高于内屏（比如 440~560），
        // 强行改成 411 会让外屏上所有 dp 尺寸缩水一大截，页面元素挤在一起、
        // 文字和按钮互相重叠——这正是「外屏看起来不对」的一部分原因。
        // 现在只在 densityDpi 明显异常高（>480，基本可判定是系统"显示大小"被放大）
        // 时才纠正，正常机型（含折叠屏内外屏）一律尊重系统值。
        try {
            Resources res = base.getResources();
            Configuration cfg = res.getConfiguration();
            if (cfg.densityDpi > ABNORMAL_DPI_THRESHOLD) {
                Log.i("HPlayer", "density 异常(" + cfg.densityDpi + ") → 钳制到 " + NATURAL_DPI);
                cfg.densityDpi = NATURAL_DPI;
                DisplayMetrics dm = res.getDisplayMetrics();
                dm.densityDpi = NATURAL_DPI;
                dm.density = NATURAL_DPI / 160f;
                dm.scaledDensity = dm.density;
                // updateConfiguration 在 API 25 起被标记 deprecated，但仍生效
                res.updateConfiguration(cfg, dm);
            } else {
                Log.i("HPlayer", "density 正常，保持系统值 " + cfg.densityDpi);
            }
        } catch (Exception e) { Log.w("HPlayer", "attachBaseContext density fix: " + e); }
    }

    // 【网络选择交给系统】曾经在这里强制 java.net.preferIPv4Stack=true，
    // 想绕开「IPv6 路由是死的」导致首包超时的机型。后来确认两点：
    //   1) 这种进程级 hack 只对某些 ROM 有效，且会掩盖真实的双栈环境问题；
    //   2) 系统（ConnectivityManager / netd）本身就会按网络能力选路，
    //      WiFi 与蜂窝谁优该由系统判断，应用不该自己拍板。
    // 所以这里不再干预，恢复系统默认行为。

    private WebView wv;
    private Button btnBack, btnTest, btnFull;
    private LinearLayout topbar;
    private ProxyServer server;
    private UpdateChecker updater;
    private String baseUrl;
    private String pendingBv = null;
    private boolean full = false;
    private String sharedTitle = null;
    /** WebView 是否已完成首次加载；false 时 evalJs 的调用会暂存 */
    private volatile boolean pageReady = false;
    /** 折叠/旋转等配置变化是否正在发生：期间抑制"重新解析"，避免进度被重置 */
    private boolean configChanging = false;
    /** 折叠切屏后需要恢复的播放位置（段索引 + 段内秒数），-1 表示无需恢复 */
    private int resumeIdx = -1;
    private double resumeT = -1;

    private static final Pattern BV = Pattern.compile("(BV[0-9A-Za-z]{10})");
    private static final Pattern AVID = Pattern.compile("av(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern B23 = Pattern.compile("(https?://b23\\.tv/[^\"\\s'》\\)]+)");
    private static final Pattern B23BARE = Pattern.compile("\\bb23\\.tv/([^\"\\s'》\\)]+)");
    private static final Pattern BILI = Pattern.compile("(https?://[\\w.-]*bilibili\\.com/video/[^\"\\s'》\\)]+)");
    private static final Pattern BILISCHEME = Pattern.compile("bilibili://video/(BV[0-9A-Za-z]{10}|av\\d+)");

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // 老安卓（Android 9）在部分网络下会优先走 IPv6，而运营商 IPv6 通常不通，
        // 于是连 B 站 API 时 SYN 发到 IPv6 地址后石沉大海，连 20s 连接超时都不触发。
        // 强制只走 IPv4，避免解析/取流卡死。
        try { System.setProperty("java.net.preferIPv4Stack", "true"); } catch (Exception ignore) {}
        setContentView(R.layout.activity_main);
        // 流量计量必须在任何 B 站请求之前初始化（feed 拉取/取流都会来记账）
        NetMeter.init(this);

        wv = findViewById(R.id.wv);
        btnBack = findViewById(R.id.btnBack);
        btnTest = findViewById(R.id.btnTest);
        btnFull = findViewById(R.id.btnFull);
        topbar = findViewById(R.id.topbar);

        wv.getSettings().setJavaScriptEnabled(true);
        wv.getSettings().setDomStorageEnabled(true);
        wv.getSettings().setTextZoom(100);
        wv.getSettings().setMediaPlaybackRequiresUserGesture(false);
        wv.getSettings().setAllowFileAccess(false);
        wv.getSettings().setCacheMode(android.webkit.WebSettings.LOAD_DEFAULT);
        wv.getSettings().setUseWideViewPort(true);
        wv.getSettings().setLoadWithOverviewMode(false);
        wv.getSettings().setSupportZoom(false);
        wv.getSettings().setBuiltInZoomControls(false);
        wv.getSettings().setDisplayZoomControls(false);
        wv.getSettings().setDefaultFontSize(14);
        wv.getSettings().setMinimumFontSize(12);
        wv.getSettings().setLayoutAlgorithm(android.webkit.WebSettings.LayoutAlgorithm.NORMAL);
        // （系统"显示大小"放大会把 WebView 的 density 推到 ~1300，CSS viewport 缩到 ~125 px，
        //   这个事前端用 #appWrap transform: scale() 自己处理，不在 native 层做。）
        wv.getSettings().setUserAgentString(
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
        // 允许混合内容与 file 访问，确保 http://127.0.0.1 本地服务在所有机型上都能加载
        wv.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        wv.getSettings().setAllowFileAccess(true);
        // 部分厂商 ROM（含 OPPO/ColorOS）默认禁用 WebView 调试，开启便于真机排障
        try { android.webkit.WebView.setWebContentsDebuggingEnabled(true); } catch (Throwable ignore) {}

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 页面就绪后才让 evalJs 真正执行，并补发冷启动期间暂存的调用
                // （分享兜底弹窗、全屏切换、续播定位都依赖这条）
                flushPendingJs();
                Log.i("HPlayer", "onPageFinished: " + url);
            }
        });
        // 把前端 console.log/error 转到 logcat， tag=HPlayer-JS，方便真机排查
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                Log.i("HPlayer-JS", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        // JS 桥：前端（手势/全屏按钮）可调用原生能力（横屏、亮度、Toast）
        wv.addJavascriptInterface(new BiliBridge(), "BiliBridge");

        server = ProxyServer.get(this);
        baseUrl = server.baseUrl;
        // 【vcnc-football 方向】沉浸式 feed 应用：不需要原生顶栏（返回/演示/全屏按钮
        // 都在前端极简 chrome 里以更轻的形式提供），直接隐藏，把整块屏幕让给视频流。
        if (topbar != null) topbar.setVisibility(View.GONE);
        // 软件更新：检查本仓库 GitHub Releases 的最新版 APK（v0.2.0 起）
        updater = new UpdateChecker(this, new UpdateChecker.UpdateListener() {
            @Override
            public void onChecked(boolean hasUpdate, String curVersion, String latestVersion,
                                 String latestName, String notes, boolean apkAvailable) {
                StringBuilder sb = new StringBuilder("{");
                sb.append("\"hasUpdate\":").append(hasUpdate ? "true" : "false");
                sb.append(",\"curVersion\":").append(jsonStr(curVersion));
                sb.append(",\"latestVersion\":").append(jsonStr(latestVersion));
                sb.append(",\"latestName\":").append(jsonStr(latestName));
                sb.append(",\"notes\":").append(jsonStr(notes));
                sb.append(",\"apkAvailable\":").append(apkAvailable ? "true" : "false");
                sb.append("}");
                evalJs("onUpdateChecked(" + sb + ")");
            }
            @Override
            public void onProgress(int pct) {
                evalJs("onUpdateProgress(" + pct + ")");
            }
            @Override
            public void onError(String msg) {
                evalJs("onUpdateError(" + jsonStr(msg) + ")");
            }
            @Override
            public void onInstallStarted() {
                evalJs("onUpdateInstalled()");
            }
        });
        // 预热 B 站接口连接：省掉冷启动后第一次解析的 DNS+TCP+TLS 握手时间
        // （蜂窝网下这一步能让首次解析从 30~40s 降到秒级）。失败无害。
        BiliApi.warmUp();

        // 沉浸式：隐藏系统状态栏与导航栏（短视频观感），退出交给系统返回键
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN);

        // 【vcnc-football】原生顶栏已整体隐藏，仅保留返回键兜底
        btnBack.setOnClickListener(v -> finish());

        // 恢复现场优先于解析分享内容：Activity 被系统回收后重建（低内存 / 折叠切屏兜底重建），
        // 此时若先去 handleIntent，会用 bv 参数重新 loadUrl，导致正在播的进度被清零。
        boolean restored = restoreSession(b);
        if (!restored) {
            handleIntent(getIntent());
            loadPlayer();
        }
        Log.i("HPlayer", "onCreate done: baseUrl=" + baseUrl + " pendingBv=" + pendingBv
                + " restored=" + restored + " resumeIdx=" + resumeIdx);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        // launchMode 从 singleTask 改为 singleTop（外屏分享需要能在新 display 上新建实例），
        // 同一实例再次收到分享时先清掉续播标记，否则会串到上一个视频的进度上
        resumeIdx = -1; resumeT = -1;
        handleIntent(i);
        loadPlayer();
    }

    /**
     * 折叠/旋转时由系统回调（manifest 已声明全量 configChanges，Activity 不会被重建）。
     * 这里只做三件事：刷新屏幕尺寸相关的 JS 布局、把状态上报到 logcat 便于真机核对。
     * 播放本身不中断：WebView 实例没被销毁，video/audio 元素继续播。
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        configChanging = true;
        int w = getResources().getConfiguration().screenWidthDp;
        int h = getResources().getConfiguration().screenHeightDp;
        Log.i("HPlayer", "onConfigurationChanged: " + w + "x" + h + "dp"
                + " smallestW=" + newConfig.smallestScreenWidthDp
                + " density=" + newConfig.densityDpi
                + " orientation=" + newConfig.orientation);
        if (wv != null) {
            // WebView 的字号/密度会随屏幕变化，需要重新量一次布局；同时强制触发 resize 事件让前端重算缩放
            wv.getSettings().setTextZoom(100);
            evalJs("applyViewportScale(); reportDiag('config-changed');");
            wv.requestLayout();
        }
        // configChanging 只用来抑制这一拍的重入，延时释放
        new Thread(() -> {
            try { Thread.sleep(600); } catch (InterruptedException ignore) {}
            runOnUiThread(() -> configChanging = false);
        }).start();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        // 让前端先把当前位置吐回来（同步的 evaluateJavascript 拿不到结果，
        // 所以用 BiliBridge 主动上报的缓存值，见 JS 的 reportPos）
        evalJs("savePosNow && savePosNow();");
        out.putString("k_bv", pendingBv);
        out.putString("k_title", sharedTitle);
        out.putInt("k_idx", lastIdx);
        out.putDouble("k_t", lastT);
        Log.i("HPlayer", "onSaveInstanceState: bv=" + pendingBv + " idx=" + lastIdx + " t=" + lastT);
    }

    /** 进程内缓存的播放位置，由前端通过 BiliBridge.reportPos 主动推上来 */
    private volatile int lastIdx = -1;
    private volatile double lastT = -1;

    private boolean restoreSession(Bundle b) {
        if (b == null) return false;
        pendingBv = b.getString("k_bv");
        sharedTitle = b.getString("k_title");
        lastIdx = b.getInt("k_idx", -1);
        lastT = b.getDouble("k_t", -1);
        if (pendingBv == null || pendingBv.isEmpty()) return false;
        resumeIdx = lastIdx;
        resumeT = lastT;
        // 复用同一端口的本地服务，WebView 重新加载后端到端续播
        loadPlayer();
        return true;
    }

    @Override
    protected void onDestroy() {
        NetMeter.flush();   // 把累计流量写盘，强杀/退出不丢统计
        super.onDestroy();
        // 注意：ProxyServer 是进程级单例，这里【不】调用 shutdown()。
        // 折叠屏切屏 / 低内存回收 Activity 时若关掉服务再重启，端口可能变化，
        // 而端口就是 origin —— origin 一变，WebView 的 localStorage（续播记忆）全部取不到，
        // 表现为「切一次屏就要从头播」。真正的释放交给进程退出时 OS 回收。
        if (wv != null) {
            try {
                wv.removeJavascriptInterface("BiliBridge");
                wv.stopLoading();
                wv.loadUrl("about:blank");
            } catch (Exception ignore) {}
        }
    }

    /**
     * 统一的页面加载入口。
     * 每次 loadUrl 前都要把 pageReady 置回 false，否则新文档还没加载完时
     * 后续的 evalJs（如分享兜底弹窗）会被打到【旧文档】上——
     * 表现为"第二次分享打开时提示框不弹"，第一次却正常。
     */
    private void loadUrlSafe(String url) {
        pageReady = false;
        pendingJs = null;
        wv.loadUrl(url);
    }

    private void loadPlayer() {
        if (baseUrl == null) return;
        if (configChanging) return;   // 配置变化这一拍不重新加载，避免打断正在播的内容
        // 【vcnc-football】入口页为 feed.html（沉浸式视频流）；无分享内容时
        // 直接进 VCNC 足球 feed，有分享内容时以该视频作为 feed 第一条。
        StringBuilder u = new StringBuilder(baseUrl + "feed.html");
        boolean hasParam = false;
        if (pendingBv != null && !pendingBv.isEmpty()) {
            u.append("?bv=").append(URLEncoder.encode(pendingBv));
            hasParam = true;
            if (sharedTitle != null && !sharedTitle.isEmpty())
                u.append("&title=").append(URLEncoder.encode(sharedTitle));
        }
        if (resumeIdx >= 0) {
            u.append(hasParam ? "&" : "?").append("ridx=").append(resumeIdx)
             .append("&rt=").append(String.format(java.util.Locale.US, "%.2f", Math.max(0, resumeT)));
        }
        resumeIdx = -1; resumeT = -1;
        loadUrlSafe(u.toString());
    }

    /** 带 BV + querystring 加载（feed 页首条播放指定视频） */
    private void loadPlayerWith(String bv, String qs) {
        if (baseUrl == null) return;
        String u = baseUrl + "feed.html?bv=" + URLEncoder.encode(bv);
        if (qs != null && !qs.isEmpty()) u += "&" + qs;
        loadUrlSafe(u);
    }

    private void toggleFull() {
        if (!full) {
            full = true;
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN);
            if (topbar != null) topbar.setVisibility(View.GONE);
            try { setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE); } catch (Exception ignore) {}
            evalJs("setUiMode('fullscreen')");
        } else {
            full = false;
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            if (topbar != null) topbar.setVisibility(View.VISIBLE);
            try { setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED); } catch (Exception ignore) {}
            evalJs("setUiMode('normal')");
        }
    }

    /**
     * 页面尚未加载完时 evaluateJavascript 会执行在空文档上，函数还不存在。
     * 这时把 JS 暂存起来，等 onPageFinished 再补发——
     * 否则「分享读不到链接 → 弹兜底框」这条链路在冷启动时必然失效
     * （onCreate 里 handleIntent 早于 WebView 首次加载完成）。
     */
    private static String jsonStr(String s) {
        if (s == null) s = "";
        StringBuilder o = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': o.append("\\\""); break;
                case '\\': o.append("\\\\"); break;
                case '\n': o.append("\\n"); break;
                case '\r': o.append("\\r"); break;
                case '\t': o.append("\\t"); break;
                default:
                    if (c < 0x20) o.append(String.format("\\u%04x", (int) c));
                    else o.append(c);
            }
        }
        o.append("\"");
        return o.toString();
    }

    private String pendingJs = null;

    private void evalJs(String js) {
        if (wv == null || js == null) return;
        if (!pageReady) { pendingJs = js; return; }
        runOnUiThread(() -> {
            try { wv.evaluateJavascript(js, null); }
            catch (Exception e) { try { wv.loadUrl("javascript:" + js); } catch (Exception ignore) {} }
        });
    }

    /** WebView.onPageFinished 里置 true 并补发暂存的 JS */
    private void flushPendingJs() {
        pageReady = true;
        String js = pendingJs;
        pendingJs = null;
        if (js != null) {
            try { wv.evaluateJavascript(js, null); }
            catch (Exception e) { try { wv.loadUrl("javascript:" + js); } catch (Exception ignore) {} }
        }
    }

    /** 上次按返回的时间：两秒内按两次才真正退出 */
    private long lastBackAt = 0;

    /**
     * 返回键语义（2026-11-08 反馈）：
     *  1) 设置 / 比赛列表页 → 回播放页（JS handleAndroidBack 返回 1 = 已消费）；
     *  2) 播放页 → 第一次 Toast「再按一次退出」，两秒内再按才真的退出。
     */
    @Override
    public void onBackPressed() {
        if (wv == null || !pageReady) { super.onBackPressed(); return; }
        try {
            final String expr = "typeof handleAndroidBack==='function' ? String(handleAndroidBack()) : '0'";
            wv.evaluateJavascript(expr, value -> {
                String v = value == null ? "0" : value.replace("\"", "").trim();
                if ("1".equals(v)) return;                 // JS 已消费：侧页回播放页
                long now = System.currentTimeMillis();
                if (now - lastBackAt < 2000) {
                    super.onBackPressed();
                } else {
                    lastBackAt = now;
                    Toast.makeText(MainActivity.this, "再按一次退出", Toast.LENGTH_SHORT).show();
                }
            });
        } catch (Exception e) {
            super.onBackPressed();
        }
    }

    /** 当前 Activity 所在的 display id：内屏/外屏不同，用于日志确认分享来自哪块屏 */
    @SuppressWarnings("deprecation")
    private String getDisplayIdSafe() {
        try {
            Display d = getWindowManager().getDefaultDisplay();
            return "d" + d.getDisplayId();
        } catch (Exception e) { return "d?"; }
    }

    /** 去掉 HTML 标签，只留文本与链接（text/html 分享时纯文本里没有 URL） */
    static String stripHtml(String s) {
        if (s == null) return null;
        String noTags = s.replaceAll("<[^>]*>", " ");
        // href="..." 里的地址要保留下来，否则唯一的链接就丢了
        Matcher m = Pattern.compile("(?i)href\\s*=\\s*[\"']([^\"']+)[\"']").matcher(s);
        StringBuilder sb = new StringBuilder(noTags);
        while (m.find()) sb.append("\n").append(m.group(1));
        return sb.toString().trim();
    }

    /** 把任意字符串安全地转成 JS 字面量（含引号/换行/反斜杠转义） */
    static String jsQuote(String s) {
        if (s == null) return "''";
        StringBuilder sb = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'') sb.append("\\'");
            else if (c == '\\') sb.append("\\\\");
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("");
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append("'").toString();
    }

    // ---------------------------------------------------------------- 分享 / 深度链接
    /**
     * 收集分享负载里的所有候选文本。
     *
     * 【为什么不再只认 EXTRA_TEXT / EXTRA_SUBJECT / ClipData.getText()】
     * 折叠屏外屏的分享走的是与内屏不同的系统分享实现（外屏有独立的 display 与
     * Sharesheet 实例），实测它可能把链接放在这些位置中的任意一个：
     *   - EXTRA_TEXT（最常见）
     *   - EXTRA_SUBJECT / EXTRA_TITLE
     *   - ClipData.Item.getText()
     *   - ClipData.Item.getUri()（type=text/uri-list 或 image/* 时）
     *   - type=text/html 时 EXTRA_TEXT 是 Spanned，链接藏在 URLSpan 里，
     *     直接 toString() 取到的纯文本里【没有】链接 —— 这是外屏最典型的失败原因
     *   - 自定义 extras（部分厂商 ROM 分享面板会塞自己的 key）
     * 因此改成"全量扫描 + 逐个尝试抽取"，任何一处命中即可。
     */
    private void handleIntent(Intent it) {
        if (it == null) return;
        String a = it.getAction();
        Log.i("HPlayer-Share", "action=" + a + " type=" + it.getType()
                + " data=" + (it.getData() == null ? null : it.getData().toString())
                + " display=" + getDisplayIdSafe());

        List<String> texts = new ArrayList<>();
        String subject = null;

        // 1) data URI（ACTION_VIEW 必然有；ACTION_SEND 也可能带）
        if (it.getData() != null) texts.add(it.getData().toString());

        // 2) 常见文本 extras
        CharSequence t = it.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (t != null) {
            texts.add(t.toString());
            // text/html：链接在 URLSpan 里，必须单独取
            if (t instanceof Spanned) {
                try {
                    URLSpan[] spans = ((Spanned) t).getSpans(0, t.length(), URLSpan.class);
                    for (URLSpan us : spans) if (us != null && us.getURL() != null) texts.add(us.getURL());
                } catch (Exception ignore) {}
            }
        }
        CharSequence sub = it.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        if (sub != null) { subject = sub.toString(); texts.add(sub.toString()); }
        CharSequence ttl = it.getCharSequenceExtra(Intent.EXTRA_TITLE);
        if (ttl != null) texts.add(ttl.toString());

        // 3) ClipData：文本 / URI / HTML 三种形态
        ClipData cd = it.getClipData();
        if (cd != null) {
            for (int i = 0; i < cd.getItemCount(); i++) {
                ClipData.Item ci = cd.getItemAt(i);
                if (ci == null) continue;
                if (ci.getText() != null) {
                    texts.add(ci.getText().toString());
                    if (ci.getText() instanceof Spanned) {
                        try {
                            URLSpan[] spans = ((Spanned) ci.getText()).getSpans(0, ci.getText().length(), URLSpan.class);
                            for (URLSpan us : spans) if (us != null && us.getURL() != null) texts.add(us.getURL());
                        } catch (Exception ignore) {}
                    }
                }
                if (ci.getHtmlText() != null) texts.add(stripHtml(ci.getHtmlText().toString()));
                if (ci.getUri() != null) texts.add(ci.getUri().toString());
                if (ci.getIntent() != null && ci.getIntent().getData() != null)
                    texts.add(ci.getIntent().getData().toString());
            }
        }

        // 4) text/uri-list 的 EXTRA_STREAM
        if (it.getParcelableExtra(Intent.EXTRA_STREAM) instanceof Uri) {
            texts.add(((Uri) it.getParcelableExtra(Intent.EXTRA_STREAM)).toString());
        }

        // 5) 全量 extras 兜底：任何 String/CharSequence 值都拿来试一次
        try {
            Bundle eb = it.getExtras();
            if (eb != null) {
                for (String k : eb.keySet()) {
                    Object v;
                    try { v = eb.get(k); } catch (Exception e) { continue; }
                    if (v instanceof String) texts.add((String) v);
                    else if (v instanceof CharSequence) texts.add(v.toString());
                }
                Log.i("HPlayer-Share", "extras keys=" + eb.keySet());
            }
        } catch (Exception ignore) {}

        // 去重 + 过滤空串
        List<String> uniq = new ArrayList<>();
        for (String s : texts) if (s != null && !s.trim().isEmpty() && !uniq.contains(s.trim())) uniq.add(s.trim());

        StringBuilder mb = new StringBuilder();
        for (int i = 0; i < uniq.size(); i++) {
            if (i > 0) mb.append("\n");
            mb.append(uniq.get(i));
        }
        String merged = mb.toString();
        Log.i("HPlayer-Share", "candidates=" + uniq.size() + " merged=" + merged.replace("\n", " | "));

        if (subject != null && !subject.isEmpty()) sharedTitle = subject;
        String target = null;
        for (String s : uniq) {
            target = extractTarget(s);
            if (target != null) {
                String title = extractTitle(s, target);
                if (sharedTitle == null) sharedTitle = title;
                break;
            }
        }
        if (target == null && !merged.isEmpty()) {
            target = extractTarget(merged);
            if (sharedTitle == null) sharedTitle = extractTitle(merged, merged);
        }

        if (target == null) {
            Log.w("HPlayer-Share", "no bilibili target found in payload: " + merged);
            // 关键：原来这里只写日志就 return，用户看到的是"什么都没发生"，
            // 完全无法判断是链接没传过来还是解析失败。现在把原始负载回传给页面显示，
            // 并给一个手动粘贴框兜底（外屏分享场景下系统可能根本不给链接）。
            //
            // 只有【真的收到 B 站分享/深链、但解析失败】才提示。
            // VCNC 版本自带 UP 主动态 feed，从桌面图标启动、厂商 ROM 塞的无关 extras、
            // 折叠屏/旋转时系统重发的 intent 都没有链接，属于正常启动；
            // 旧版只看 action != MAIN 就弹「没识别到 B 站链接」，冷启动会误报。
            boolean hasText = !merged.isEmpty();
            boolean looksBili = hasText && merged.matches(
                    "(?is).*(bilibili|b23\\.tv|BV[0-9a-z]{10}|av[0-9]+).*");
            boolean fromShare = !Intent.ACTION_MAIN.equals(a) && hasText && looksBili;
            pendingBv = null;
            if (fromShare) {
                final String rawForUser = merged.length() > 400 ? merged.substring(0, 400) + "…" : merged;
                evalJs("showShareFallback && showShareFallback(" + jsQuote(rawForUser) + ");");
                Toast.makeText(this, "没识别到 B 站链接，可在页面里粘贴", Toast.LENGTH_LONG).show();
            } else {
                Log.i("HPlayer-Share", "MAIN 启动 / 无 B 站分享负载，属正常，不提示");
            }
            return;
        }
        Log.i("HPlayer-Share", "target=" + target + " title=" + sharedTitle);

        if (target.startsWith("b23tv:")) {
            // "b23tv:" 前缀为 6 个字符，必须截掉 6 个，否则会残留 ':' 导致 URL 非法
            final String shortUrl = target.substring(6);
            final String fTitle = sharedTitle;
            new Thread(new Runnable() {
                public void run() {
                    final String real = resolveB23(shortUrl);
                    final String t2 = (real != null) ? extractTarget(real) : null;
                    // 只接受“非 b23.tv 短链”的解析结果：若返回仍是原短链或错误页（extractTarget 又匹配成 b23tv:），
                    // 说明短链未解析出真实视频，应当提示失败，而不是把 b23.tv 链接当目标再次 loadPlayer 造成死循环。
                    final boolean ok = (t2 != null) && !t2.startsWith("b23tv:");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            if (ok) { pendingBv = t2; sharedTitle = fTitle; loadPlayer(); }
                            else Toast.makeText(MainActivity.this, "短链解析失败", Toast.LENGTH_SHORT).show();
                        }
                    });
                }
            }).start();
        } else {
            pendingBv = target;
            loadPlayer();
        }
    }

    /** 从分享文案里抽取标题：优先 EXTRA_SUBJECT，否则取链接前的文字 */
private static String extractTitle(String s, String target) {
if (s == null) return null;
if (target != null && s.contains(target)) {
String before = s.substring(0, s.indexOf(target)).trim();
before = before.replaceAll("^[\\s【\\[\\(·\\-–—]+", "").replaceAll("[\\s】\\]\\)·\\-–—]+$", "").trim();
if (before.length() >= 1 && before.length() <= 50 && looksLikeTitle(before)) return before;
}
return null;
}

/**
 * 判断候选文本是否真的像标题。
 * 必要原因：deep-link（bilibili://video/BVxxx）里 target 前面只剩 "bilibili://video/"，
 * 原先只按长度判断，会把 scheme 当成标题显示出来。
 */
private static boolean looksLikeTitle(String t) {
// 含协议、域名、斜杠等链接特征 -> 不是标题
if (t.contains("://") || t.contains("//")) return false;
if (t.contains("/") || t.contains("www.") || t.contains(".com") || t.contains(".tv")) return false;
// 纯数字/BV号/av号 -> 不是标题
if (t.matches("(?i)^(bv[0-9a-z]{10}|av\\d+)$")) return false;
if (t.matches("^[0-9:\\s]+$")) return false;
// 全是标点或符号 -> 不是标题
if (!t.matches(".*[\\p{IsHan}A-Za-z0-9].*")) return false;
return true;
}

    /** 解析 b23.tv 短链：跟随 302 跳转；返回 200 页面时读 body 找真实链接；失败兜底读当前 loc */
    private static String resolveB23(String url) {
        if (url == null) return null;
        if (!url.startsWith("http")) url = "https://" + url;
        String loc = null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(12000);
            c.setReadTimeout(12000);
            c.setRequestMethod("GET");
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile");
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*");
            c.connect();
            int code = c.getResponseCode();
            loc = c.getURL().toString();
            Log.i("HPlayer-Share", "b23 code=" + code + " loc=" + loc);
            if (loc != null && loc.indexOf("b23.tv") >= 0) {
                // 没跳走（返回 200 页面），读 body 找真实链接
                java.io.InputStream is = c.getInputStream();
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = is.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
                is.close();
                String body = sb.toString();
                Matcher m = Pattern.compile("(?i)(https?://[\\w.-]*bilibili\\.com/video/[^\"'\\s<>)]+)").matcher(body);
                if (m.find()) loc = m.group(1);
                else {
                    Matcher m2 = Pattern.compile("(?i)(https?://b23\\.tv/[^\"'\\s<>)]+)").matcher(body);
                    if (m2.find()) loc = resolveB23(m2.group(1));
                }
            }
            c.disconnect();
            return loc;
        } catch (Exception e) {
            Log.w("HPlayer-Share", "resolveB23 err: " + e.getMessage());
            if (c != null) try { c.disconnect(); } catch (Exception ignore) {}
            return loc;
        }
    }

    /**
     * 从一段文本里抠出 BV/AV 号或完整 URL。
     * 兼容：b23.tv 短链（带协议/裸串）、bilibili:// 深链、带 query 的 www 链接、
     *      裸 BV/av 号、&amp; 实体化过的 HTML href、以及整段就是一个 URL 的情况。
     * 注意 HTML 场景：a 标签的 href 常被转义成 &#38; / &amp;，这里统一还原，
     * 否则 "?p=2&#38;xxx" 这种拼在后面的分 P 信息会让 BV 号匹配失败。
     */
    public static String extractTarget(String s) {
        if (s == null) return null;
        String in = s.replace("&amp;", "&").replace("&#38;", "&").replace("&quot;", "\"");
        Matcher m = B23.matcher(in);
        if (m.find()) return "b23tv:" + m.group(1);
        m = B23BARE.matcher(in);
        if (m.find()) return "b23tv:https://" + m.group(0);
        m = BILISCHEME.matcher(in);
        if (m.find()) return m.group(1);
        m = BILI.matcher(in);
        if (m.find()) {
            // BILI 正则匹配到的是整条 URL，但下游要的是裸 BV/av 号
            // （BiliApi.parseTarget 也认裸 ID，且裸 ID 能带上 p= 分 P 信息）
            Matcher bvIn = BV.matcher(m.group(1));
            if (bvIn.find()) return bvIn.group(1);
            Matcher avIn = AVID.matcher(m.group(1));
            if (avIn.find()) return "av" + avIn.group(1);
            return m.group(1);
        }
        m = BV.matcher(in);
        if (m.find()) return m.group(1);
        m = AVID.matcher(in);
        if (m.find()) return "av" + m.group(1);
        // 整段就是 URL（含 b23.tv 之外的第三方短链服务，如 v.bilibili.com 等）
        String t = in.trim();
        if (t.startsWith("http://") || t.startsWith("https://")) return t;
        return null;
    }

    // ---------------------------------------------------------------- JS 桥
    public class BiliBridge {
        @JavascriptInterface
        public void diag(String msg) { Log.i("HPlayer-Diag", msg == null ? "" : msg); }
        @JavascriptInterface
        public void toggleFullScreen() {
            runOnUiThread(new Runnable() { public void run() { toggleFull(); } });
        }
        @JavascriptInterface
        public boolean isFullScreen() { return full; }
        @JavascriptInterface
        public void setBrightness(float b) {
            final float v = Math.max(0f, Math.min(1f, b));
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
                        lp.screenBrightness = v;
                        getWindow().setAttributes(lp);
                    } catch (Exception ignore) {}
                }
            });
        }
        @JavascriptInterface
        public float getBrightness() {
            try {
                float b = getWindow().getAttributes().screenBrightness;
                return (b < 0) ? 1f : b;
            } catch (Exception e) { return 1f; }
        }
        @JavascriptInterface
        public void toast(String msg) {
            Toast.makeText(MainActivity.this, msg == null ? "" : msg, Toast.LENGTH_SHORT).show();
        }
        @JavascriptInterface
        public String getSharedTitle() { return sharedTitle == null ? "" : sharedTitle; }
        /**
         * 前端每 2 秒主动上报播放位置。
         * 必须由 JS 主动推上来而不是在 onSaveInstanceState 里同步 evaluateJavascript 取值——
         * 后者是异步的，回调发生时 Activity 已经进入保存流程，拿不到结果。
         */
        @JavascriptInterface
        public void reportPos(int idx, double t) {
            lastIdx = idx;
            lastT = t;
        }
        /** 折叠/旋转后前端重新量完布局会回调一次，用于在 logcat 确认新屏幕下的排版 */
        @JavascriptInterface
        public void reportScreen(String tag) {
            Log.i("HPlayer-Screen", tag);
        }

        // ---- 软件更新（从本仓库 GitHub Releases 获取 APK）----
        @JavascriptInterface
        public void checkUpdate() {
            if (updater != null) updater.check();
        }
        @JavascriptInterface
        public void startUpdate() {
            if (updater != null) updater.downloadAndInstall();
        }
        /** 设置页「分享与支持」：外部链接一律交给系统浏览器，不能让 WebView 自己跳走 */
        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || url.trim().isEmpty()) return;
            try {
                Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                MainActivity.this.startActivity(it);
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "打不开链接", Toast.LENGTH_SHORT).show();
            }
        }
        /**
         * 本机是否装了 B 站客户端（「用 B 站 App 授权登录」的前提）。
         * targetSdk 34 必须在 Manifest 的 <queries> 里声明这些包名，否则查不到。
         */
        @JavascriptInterface
        public boolean biliAppInstalled() { return biliClientPackage() != null; }

        /**
         * 把 B 站授权页交给客户端 App 内打开，用户点「确认」即完成授权。
         * 走的是 B 站官方声明的 bilibili://browser deep link（真机实测打开
         * .ui.webview.MWebActivity，页面含账号卡片 + 确认按钮），全程不需要扫码。
         * 返回 ok / ok-https / noapp / badurl / failed，供前端给出对应提示。
         */
        @JavascriptInterface
        public String biliAuth(String url) {
            String pkg = biliClientPackage();
            if (pkg == null) return "noapp";
            if (url == null || !(url.startsWith("https://account.bilibili.com/")
                    || url.startsWith("https://passport.bilibili.com/"))) return "badurl";
            String enc = Uri.encode(url);
            // 必须 setPackage：本应用也声明了 bilibili scheme，不带包名会弹选择器甚至自跳转
            String[] links = {
                    "bilibili://browser?url=" + enc,
                    "bilibili://browser/" + enc
            };
            for (String link : links) {
                try {
                    Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(link));
                    it.setPackage(pkg);
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    MainActivity.this.startActivity(it);
                    return "ok";
                } catch (Exception ignore) { }
            }
            // 兜底：部分客户端版本直接接 https App Link
            try {
                Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                it.setPackage(pkg);
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                MainActivity.this.startActivity(it);
                return "ok-https";
            } catch (Exception e) { return "failed"; }
        }

        private String biliClientPackage() {
            PackageManager pm = MainActivity.this.getPackageManager();
            String[] pkgs = {"tv.danmaku.bili", "tv.danmaku.bilibilihd", "com.bilibili.app.in"};
            for (String p : pkgs) {
                try { pm.getPackageInfo(p, 0); return p; } catch (Exception ignore) { }
            }
            return null;
        }

        @JavascriptInterface
        public void shareText(String text) {
            try {
                Intent it = new Intent(Intent.ACTION_SEND);
                it.setType("text/plain");
                it.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                Intent chooser = Intent.createChooser(it, "分享 VCNC足球");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                MainActivity.this.startActivity(chooser);
            } catch (Exception ignore) {}
        }
        @JavascriptInterface
        public void copyText(String text) {
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager)
                        MainActivity.this.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("vcnc", text == null ? "" : text));
                Toast.makeText(MainActivity.this, "已复制", Toast.LENGTH_SHORT).show();
            } catch (Exception ignore) {}
        }
        @JavascriptInterface
        public String getVersionName() {
            try {
                PackageManager pm = MainActivity.this.getPackageManager();
                PackageInfo pi = pm.getPackageInfo(MainActivity.this.getPackageName(), 0);
                return pi.versionName != null ? pi.versionName : "";
            } catch (Exception e) { return ""; }
        }
    }
}
