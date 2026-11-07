package com.hplayer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 ContentProvider：把下载到「应用私有目录 /updates/」的更新 APK 以 content://
 * 形式暴露给系统安装器。等价于 AndroidX 的 FileProvider，但本项目是免 Gradle 脚本构建、
 * 没有引入任何支持库，所以自己实现一份。
 *
 * 暴露路径：content://com.hplayer.update/H-Player.apk
 *   → getFilesDir()/updates/H-Player.apk
 */
public class UpdateProvider extends ContentProvider {

    private static final String DIR = "updates";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = safeName(uri.getLastPathSegment());
        File f = new File(getContext().getFilesDir(), DIR + "/" + name);
        if (!f.exists()) throw new FileNotFoundException(name);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String sel, String[] selArgs, String sort) {
        MatrixCursor c = new MatrixCursor(new String[]{"_display_name", "_size"});
        String name = safeName(uri.getLastPathSegment());
        File f = new File(getContext().getFilesDir(), DIR + "/" + name);
        if (f.exists()) c.addRow(new Object[]{f.getName(), f.length()});
        return c;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override
    public int delete(Uri uri, String sel, String[] selArgs) { return 0; }

    @Override
    public int update(Uri uri, ContentValues values, String sel, String[] selArgs) { return 0; }

    /** 仅允许文件名本身，杜绝路径穿越（../、子目录等） */
    private static String safeName(String seg) {
        if (seg == null || seg.isEmpty() || seg.contains("/") || seg.contains("\\")
                || seg.contains("..") || seg.indexOf(':') >= 0) {
            return "__invalid__";
        }
        return seg;
    }
}
