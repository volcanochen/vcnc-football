@echo off
setlocal
set "ROOT=%~dp0"
if not defined ANDROID_SDK set "ANDROID_SDK=C:\Users\volcano\AppData\Local\Android\Sdk"
if not defined JBR set "JBR=C:\Program Files\Android\Android Studio\jbr"
if not defined PY set "PY=python"
set "BT=%ANDROID_SDK%\build-tools\37.0.0"
set "PLAT=%ANDROID_SDK%\platforms\android-34"

set "APP=%ROOT%app\src\main"
set "BUILD=%ROOT%build"
set "WWW=%APP%\assets\www"
set "SRC=%APP%\java\com\hplayer"
set "STATIC=%ROOT%..\static"

if not exist "%BUILD%\dex" mkdir "%BUILD%\dex"
if not exist "%BUILD%\gen" mkdir "%BUILD%\gen"
if not exist "%BUILD%\apk" mkdir "%BUILD%\apk"
if not exist "%BUILD%\classes" mkdir "%BUILD%\classes"
if not exist "%BUILD%\gen_R" mkdir "%BUILD%\gen_R"
if not exist "%WWW%" mkdir "%WWW%"

echo [1/8] 复制前端静态文件（沉浸场 feed 页 + 默认首页跳转）
copy /Y "%STATIC%\index.html" "%WWW%\index.html" >nul || goto :err
copy /Y "%STATIC%\feed.html"  "%WWW%\feed.html"  >nul || goto :err
copy /Y "%STATIC%\feed.js"    "%WWW%\feed.js"    >nul || goto :err
copy /Y "%STATIC%\feed.css"   "%WWW%\feed.css"   >nul || goto :err

echo [2/8] aapt2 compile 资源
"%BT%\aapt2.exe" compile --dir "%APP%\res" -o "%BUILD%\gen\res.zip" || goto :err

echo [3/8] aapt2 link 资源 + 生成 R.java
"%BT%\aapt2.exe" link -o "%BUILD%\apk\base.apk" -I "%PLAT%\android.jar" ^
  --manifest "%APP%\AndroidManifest.xml" "%BUILD%\gen\res.zip" ^
  --java "%BUILD%\gen_R" --no-version-vectors || goto :err

echo [4/8] javac 编译
"%JBR%\bin\javac.exe" -encoding UTF-8 -source 1.8 -target 1.8 -cp "%PLAT%\android.jar" -d "%BUILD%\classes" ^
  "%SRC%\*.java" "%BUILD%\gen_R\com\vcncfootball\R.java" || goto :err

echo [5/8] d8 生成 classes.dex
"%JBR%\bin\jar.exe" cf "%BUILD%\classes.jar" -C "%BUILD%\classes" . || goto :err
"%JBR%\bin\java.exe" -cp "%BT%\lib\*" com.android.tools.r8.D8 --release --min-api 24 ^
  --output "%BUILD%\dex" "%BUILD%\classes.jar" || goto :err

echo [6/8] 注入 dex + assets
"%PY%" "%ROOT%make_apk.py" "%BUILD%\apk\base.apk" "%BUILD%\dex" "%APP%\assets" "%BUILD%\apk\unsigned.apk" || goto :err

echo [7/8] zipalign 对齐
"%BT%\zipalign.exe" -p 4 "%BUILD%\apk\unsigned.apk" "%BUILD%\apk\aligned.apk" || goto :err

echo [8/8] apksigner 签名
if not exist "%ROOT%keystore.jks" (
  "%JBR%\bin\keytool.exe" -genkeypair -v -keystore "%ROOT%keystore.jks" -alias bilihl ^
    -keyalg RSA -keysize 2048 -validity 10000 ^
    -storepass bilihl123 -keypass bilihl123 ^
    -dname "CN=BiliHl, OU=Dev, O=BiliHl, L=CN, S=CN, C=CN" || goto :err
)
"%JBR%\bin\java.exe" -cp "%BT%\lib\*" com.android.apksigner.ApkSignerTool sign ^
  --ks "%ROOT%keystore.jks" --ks-key-alias bilihl ^
  --ks-pass pass:bilihl123 --key-pass pass:bilihl123 ^
  --out "%ROOT%VCNC-Football.apk" "%BUILD%\apk\aligned.apk" || goto :err

echo.
echo ========== BUILD OK ==========
echo APK: %ROOT%VCNC-Football.apk
goto :eof

:err
echo.
echo ========== BUILD FAILED ==========
exit /b 1
