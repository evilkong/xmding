@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  set "NODE=%LOCALAPPDATA%\Programs\WhaleGirl\runtime\node\node.exe"
  if not exist "%NODE%" (
    echo.
    echo   找不到 Node.js，请先安装或在 PATH 里加上 node。
    echo.
    pause
    exit /b 1
  )
) else (
  set "NODE=node"
)

echo.
echo   发布 xmding 到 Gitea
echo   ====================
echo.
echo   直接回车 = 自动生成提交信息
echo   输入文字 = 作为提交信息
echo.

set "MSG="
set /p MSG=提交信息（可留空）:

echo.
if "%MSG%"=="" (
  "%NODE%" publish.js
) else (
  "%NODE%" publish.js -m "%MSG%"
)

echo.
if errorlevel 1 (
  echo   发布失败，请查看上面的输出。
) else (
  echo   完成。
)
echo.
pause
