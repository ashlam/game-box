package com.nous.gamesbox;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极小的 FileProvider 替身：把 cacheDir 里的 APK 以 content:// 交给系统安装器。
 *
 * 为什么要自己写：这个工程不用 gradle、不带 AndroidX，`androidx.core.content.FileProvider`
 * 拉不进来。而 Android 7 起 `Uri.fromFile()` 会直接抛 FileUriExposedException
 * （targetSdk 35 更不可能幸免），所以必须有一个能把文件包装成 content:// 的 provider。
 * 自己写一个只读、只认固定文件名的最小实现，比拖进整个 support 库划算。
 *
 * 安全边界（重要）：
 *   · exported=false，别的应用不能直接访问
 *   · 只读打开，且只认 cacheDir 下「字母数字下划线横线 + .apk」的名字，
 *     `../` 之类的路径穿越在正则那一关就被拦掉
 *   · 外部应用能拿到它，只因为安装器收到了 FLAG_GRANT_READ_URI_PERMISSION 的一次性授权
 */
public final class ApkProvider extends ContentProvider {

    /** 必须和 AndroidManifest 里的 android:authorities 一致 */
    public static final String AUTHORITY = "com.nous.gamesbox.apk";

    private static final String SAFE_NAME = "[A-Za-z0-9_.-]+\\.apk";

    public static Uri uriFor(File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(file.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && !mode.startsWith("r")) {
            throw new FileNotFoundException("只读");
        }
        String name = uri.getLastPathSegment();
        if (name == null || !name.matches(SAFE_NAME)) {
            throw new FileNotFoundException("不允许的文件名: " + name);
        }
        if (getContext() == null) throw new FileNotFoundException("no context");
        File f = new File(getContext().getCacheDir(), name);
        if (!f.isFile()) throw new FileNotFoundException("找不到 " + name);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    // ---- 其余方法用不到，返回空实现即可 ----

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
