@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul || set "PY=python3"
echo 正在启动 VCNC 足球沉浸场（桌面调试版）...
echo 浏览器打开 http://127.0.0.1:8777/
"%PY%" server.py
pause
