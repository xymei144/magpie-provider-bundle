@echo off
chcp 65001 >nul
cd /d "%~dp0"
where git >/dev/null 2>/dev/null || (echo 未安装 git。 & pause & exit /b 1)
git pull --ff-only
if errorlevel 1 (echo. & echo 更新失败：先把本地改动提交或还原，再试。)
pause
