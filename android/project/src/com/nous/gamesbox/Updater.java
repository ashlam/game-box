package com.nous.gamesbox;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * 应用内升级：读清单 → 下载 APK → 拉起系统安装器。
 *
 * 为什么需要它：这个 App 不上应用商店，没有商店推送升级。但新版 APK 可以放在
 * 一个普通 HTTP 地址上（局域网里的 NAS / 项目站点根都行），App 自己比对版本、
 * 自己下载、自己交给安装器，等于自己造了一条升级通道。
 *
 * 约定：
 *   · 更新源是一个 JSON 清单（build 时由 build-apk.sh 生成，和 APK 放同一目录）
 *   · **必须有网才生效**；没有网就什么都不做，绝不阻塞游戏（离线优先）
 *   · 只会升级到 versionCode 更大的包，降级一律拒绝（防止误操作把数据搞坏）
 *   · 覆盖安装依赖签名一致 —— 所以 private/gamebox-release.jks 绝对不能换
 *
 * 与网页的接口：MainActivity 把 {@link Bridge} 注入成 window.GamesBoxNative，
 * 网页只能调用这些方法（@JavascriptInterface 白名单），拿不到其它任何原生能力。
 */
public final class Updater {

    private static final String TAG = "GamesBox";
    private static final String PREF = "gbox_update";
    private static final String KEY_SOURCE = "source";
    private static final String ASSET_SOURCE = "update_source.txt";

    /** 下载落盘的文件名。固定名 + 固定目录，ApkProvider 只在这一个目录里找文件。 */
    private static final String APK_NAME = "update.apk";

    private static final int TIMEOUT_CONNECT = 8000;
    private static final int TIMEOUT_READ = 20000;

    /** 行分隔符 U+2028 / 段分隔符 U+2029 及其 JS 转义写法 */
    private static final char LS = '\u2028';
    private static final char PS = '\u2029';
    private static final String ESC_LS = String.valueOf((char) 92) + "u2028";
    private static final String ESC_PS = String.valueOf((char) 92) + "u2029";

    private final Activity act;
    private final WebView web;
    private final Bridge bridge = new Bridge();

    private volatile boolean downloading = false;
    private volatile boolean cancel = false;
    private volatile boolean waitingPermission = false;

    /** 最近一次成功读到的清单；没读到就是 null（此时不允许下载） */
    private JSONObject manifest = null;
    private File apkFile = null;

    Updater(Activity activity, WebView webView) {
        this.act = activity;
        this.web = webView;
    }

    Object bridge() {
        return bridge;
    }

    // =========================================================================
    // 给网页用的接口
    // =========================================================================

    /** window.GamesBoxNative 的所有可调用方法都在这里，别往外面加。 */
    public final class Bridge {

        /** 当前版本 + 更新源，网页用它渲染设置面板 */
        @JavascriptInterface
        public String info() {
            JSONObject o = new JSONObject();
            try {
                o.put("versionCode", versionCode());
                o.put("versionName", versionName());
                o.put("source", source());
                o.put("canInstall", !needPermission());
                o.put("sdk", Build.VERSION.SDK_INT);
            } catch (Exception e) {
                Log.w(TAG, "info: " + e);
            }
            return o.toString();
        }

        @JavascriptInterface
        public String source() {
            return Updater.this.source();
        }

        @JavascriptInterface
        public void setSource(String url) {
            String v = url == null ? "" : url.trim();
            if (!v.isEmpty() && !v.startsWith("http://") && !v.startsWith("https://")) {
                emitError("更新源要以 http:// 或 https:// 开头");
                return;
            }
            prefs().edit().putString(KEY_SOURCE, v).apply();
            emit(st("source", "source", v));
        }

        /** 检查更新（网络请求在后台线程，结果通过 window.__gboxUpdate 回调） */
        @JavascriptInterface
        public void check() {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    doCheck();
                }
            }, "gbox-check").start();
        }

        /** 下载最近一次检查到的那个版本 */
        @JavascriptInterface
        public void download() {
            if (downloading) return;
            if (manifest == null || apkFile == null) {
                emitError("请先检查更新");
                return;
            }
            downloading = true;
            cancel = false;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    doDownload();
                }
            }, "gbox-download").start();
        }

        /** 下载完了 → 交给系统安装器 */
        @JavascriptInterface
        public void install() {
            Updater.this.install();
        }

        @JavascriptInterface
        public void cancelDownload() {
            cancel = true;
        }

        /** 兜底：用系统浏览器打开下载页（个别 ROM 的安装器叫不起来时用） */
        @JavascriptInterface
        public void openInBrowser() {
            String url = manifest == null ? "" : resolve(source(), manifest.optString("file", ""));
            if (url.isEmpty()) url = source();
            if (url.isEmpty()) {
                emitError("还没有可用的下载地址");
                return;
            }
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
            } catch (Exception e) {
                emitError("打不开浏览器：" + e.getMessage());
            }
        }

        /** 把上次加上的 APK 清掉（安装成功后再进 App 时调用，省点空间） */
        @JavascriptInterface
        public void cleanup() {
            if (apkFile != null && apkFile.exists()) apkFile.delete();
            apkFile = null;
            manifest = null;
        }
    }

    // =========================================================================
    // 检查
    // =========================================================================

    private void doCheck() {
        emit(state("checking"));
        String src = source();
        if (src.isEmpty()) {
            emitError("还没设置更新源\n点「更新源」填一个地址，比如 http://192.168.1.10:4321/update.json");
            return;
        }
        try {
            JSONObject m = fetchManifest(src);
            int remote = m.optInt("versionCode", 0);
            int cur = versionCode();
            if (remote <= 0) {
                emitError("更新清单格式不对（缺少 versionCode）");
                return;
            }
            if (remote <= cur) {
                emit(st("latest",
                        "current", cur,
                        "remote", remote,
                        "versionName", m.optString("versionName", ""),
                        "notes", notes(m)));
                return;
            }
            String file = m.optString("file", "");
            if (file.isEmpty()) {
                emitError("更新清单里没写 file（新包的下载地址）");
                return;
            }
            // 校验新包能不能装：minSdk 太高的包装上去也白搭，提前拒掉
            int minSdk = m.optInt("minSdk", 0);
            if (minSdk > Build.VERSION.SDK_INT) {
                emitError("新版本要求 Android " + minSdk + " 以上，这台机器是 "
                        + Build.VERSION.SDK_INT);
                return;
            }

            manifest = m;
            apkFile = new File(act.getCacheDir(), APK_NAME);
            if (apkFile.exists()) apkFile.delete();   // 旧包先扔掉，免得 sha 对不上

            emit(st("found",
                    "current", cur,
                    "remote", remote,
                    "versionName", m.optString("versionName", ""),
                    "size", m.optLong("size", 0),
                    "notes", notes(m),
                    "url", resolve(src, file)));
        } catch (Exception e) {
            emitError(friendly(e));
        }
    }

    private JSONArray notes(JSONObject m) {
        JSONArray arr = m.optJSONArray("notes");
        if (arr != null) return arr;
        JSONArray one = new JSONArray();
        String s = m.optString("notes", "");
        if (!s.isEmpty()) one.put(s);
        return one;
    }

    private JSONObject fetchManifest(String src) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(src).openConnection();
            c.setConnectTimeout(TIMEOUT_CONNECT);
            c.setReadTimeout(TIMEOUT_READ);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setRequestProperty("User-Agent", "GamesBox/" + versionName());
            int code = c.getResponseCode();
            if (code / 100 == 3) {
                String loc = c.getHeaderField("Location");
                if (loc != null && !loc.isEmpty()) {
                    c.disconnect();
                    c = (HttpURLConnection) new URL(new URL(src), loc).openConnection();
                    c.setConnectTimeout(TIMEOUT_CONNECT);
                    c.setReadTimeout(TIMEOUT_READ);
                    c.setRequestProperty("User-Agent", "GamesBox/" + versionName());
                    code = c.getResponseCode();
                }
            }
            if (code != 200) throw new IOException("服务器返回 HTTP " + code);
            String body = readText(c.getInputStream());
            return new JSONObject(body);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // =========================================================================
    // 下载
    // =========================================================================

    private void doDownload() {
        long total = manifest.optLong("size", 0);
        String sha = manifest.optString("sha256", "");
        long got = 0;
        HttpURLConnection c = null;
        OutputStream out = null;
        try {
            String url = resolve(source(), manifest.optString("file", ""));
            emit(st("progress", "percent", 0, "got", 0L, "total", total));

            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(TIMEOUT_CONNECT);
            c.setReadTimeout(TIMEOUT_READ);
            c.setRequestProperty("User-Agent", "GamesBox/" + versionName());
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("下载失败：HTTP " + code);
            long len = c.getContentLength();
            if (len > 0) total = len;

            InputStream in = c.getInputStream();
            out = new FileOutputStream(apkFile);
            byte[] buf = new byte[16 * 1024];
            int n;
            int lastPct = -1;
            long lastEmit = 0;
            while ((n = in.read(buf)) > 0) {
                if (cancel) throw new IOException("已取消");
                out.write(buf, 0, n);
                got += n;
                int pct = total > 0 ? (int) (got * 100 / total) : -1;
                long now = System.currentTimeMillis();
                // 别刷爆 JS：每 1% 或每 250ms 报一次
                if (pct != lastPct || now - lastEmit > 250) {
                    lastPct = pct;
                    lastEmit = now;
                    emit(st("progress", "percent", pct, "got", got, "total", total));
                }
            }
            out.flush();
            out.close();
            out = null;
            in.close();

            if (total > 0 && got < total) throw new IOException("下载不完整（" + got + "/" + total + "）");
            if (!sha.isEmpty()) {
                String real = sha256(apkFile);
                if (!real.equalsIgnoreCase(sha)) {
                    apkFile.delete();
                    throw new IOException("文件校验失败，可能下载断了或被改过");
                }
            }
            // 包名对不上就装不进去，提前说清楚，别让用户白等一场安装失败
            downloading = false;
            emit(st("ready", "size", got, "name", apkFile.getAbsolutePath()));
        } catch (Exception e) {
            downloading = false;
            if (apkFile != null && apkFile.exists()) apkFile.delete();
            if (cancel) {
                emit(state("cancelled"));
            } else {
                emitError(friendly(e));
            }
        } finally {
            if (out != null) try { out.close(); } catch (Exception ignored) { }
            if (c != null) c.disconnect();
            downloading = false;
            cancel = false;
        }
    }

    // =========================================================================
    // 安装
    // =========================================================================

    void install() {
        if (needPermission()) {
            waitingPermission = true;
            emit(state("needPermission"));
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + act.getPackageName()));
                act.startActivity(i);
            } catch (Exception e) {
                waitingPermission = false;
                emitError("请到「设置 → 应用 → 特殊权限」里允许本应用安装未知应用");
            }
            return;
        }
        doInstall();
    }

    /** 从「允许安装未知应用」的设置页回来，自动接着装 */
    void onResume() {
        if (!waitingPermission) return;
        waitingPermission = false;
        if (needPermission()) {
            emitError("没有打开「允许安装未知应用」，升级要先允一下");
        } else {
            doInstall();
        }
    }

    private void doInstall() {
        if (apkFile == null || !apkFile.exists()) {
            emitError("没有下载好的安装包，请重新下载");
            return;
        }
        Uri uri = ApkProvider.uriFor(apkFile);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        // Android 14 起部分 ROM 靠 ClipData 才认这份授权，补上不亏
        i.setClipData(ClipData.newRawUri("apk", uri));
        try {
            act.startActivity(i);
            emit(state("installing"));
        } catch (Exception e) {
            emitError("系统安装器没响应，试试下面「用浏览器打开下载页」");
        }
    }

    private boolean needPermission() {
        if (Build.VERSION.SDK_INT < 26) return false;
        try {
            return !act.getPackageManager().canRequestPackageInstalls();
        } catch (Exception e) {
            return false;
        }
    }

    // =========================================================================
    // 杂项
    // =========================================================================

    private SharedPreferences prefs() {
        return act.getSharedPreferences(PREF, Activity.MODE_PRIVATE);
    }

    private String source() {
        String s = prefs().getString(KEY_SOURCE, null);
        if (s == null) s = assetSource();
        return s == null ? "" : s.trim();
    }

    /**
     * 打包时由 build_apk.sh 写进 assets/update_source.txt 的默认更新源。
     * 换机器打包会自动换掉，所以它不进版本库（见 .gitignore）。
     */
    private String assetSource() {
        InputStream in = null;
        try {
            in = act.getAssets().open(ASSET_SOURCE);
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            String line = r.readLine();
            r.close();
            return line == null ? "" : line.trim();
        } catch (Exception e) {
            return "";
        } finally {
            if (in != null) try { in.close(); } catch (Exception ignored) { }
        }
    }

    int versionCode() {
        try {
            return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    String versionName() {
        try {
            return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    /** 相对路径按清单所在目录解析；清单里写绝对地址也认 */
    private static String resolve(String base, String file) {
        if (file == null || file.isEmpty()) return "";
        if (file.contains("://")) return file;
        try {
            return new URL(new URL(base), file).toString();
        } catch (Exception e) {
            return file;
        }
    }

    private static String readText(InputStream in) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.toString();
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        InputStream in = new java.io.FileInputStream(f);
        try {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        } finally {
            in.close();
        }
        byte[] d = md.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : d) {
            String h = Integer.toHexString(b & 0xff);
            if (h.length() == 1) sb.append('0');
            sb.append(h);
        }
        return sb.toString();
    }

    private static String friendly(Exception e) {
        String m = e.getMessage();
        if (m == null) m = e.getClass().getSimpleName();
        if (e instanceof java.net.UnknownHostException) return "连不上更新源（地址写错了，或者不在同一个局域网）";
        if (e instanceof java.net.ConnectException) return "连不上更新源（地址对但服务没开）";
        if (e instanceof java.net.SocketTimeoutException) return "更新源没响应，超时了";
        if (m.contains("Cleartext") || m.contains("cleartext")) return "这个地址是 http 明文，系统不让连";
        return m;
    }

    // =========================================================================
    // 回调网页：window.__gboxUpdate(state)
    // =========================================================================

    private JSONObject state(String type) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", type);
        } catch (Exception ignored) { }
        return o;
    }

    /** state + 若干键值对。JSONObject.put 抛受检异常，链式写不通，统一从这里走。 */
    private JSONObject st(String type, Object... kv) {
        JSONObject o = state(type);
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) {
                o.put(String.valueOf(kv[i]), kv[i + 1]);
            }
        } catch (Exception ignored) { }
        return o;
    }

    private void emitError(String msg) {
        emit(st("error", "message", msg == null ? "出错了" : msg));
    }

    private void emit(final JSONObject payload) {
        // U+2028 / U+2029 在 JSON 里合法、在 JS 源码里却是换行符，不转义会把脚本切成两半。
        // 反斜杠刻意用 (char) 92 拼：源码里直接写那两个字符会被 javac 的 Unicode 转义预处理吃掉。
        String json = payload.toString()
                .replace(String.valueOf(LS), ESC_LS)
                .replace(String.valueOf(PS), ESC_PS);
        final String js = "window.__gboxUpdate&&window.__gboxUpdate(" + json + ")";
        web.post(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript(js, null);
                } catch (Exception e) {
                    Log.w(TAG, "evaluateJavascript: " + e);
                }
            }
        });
    }
}
