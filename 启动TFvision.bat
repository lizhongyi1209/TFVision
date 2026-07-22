@echo off
title TFvision
cd /d "%~dp0"

set PORT=3460

echo [TFvision] 检查端口 %PORT% ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    echo [TFvision] 结束占用端口的旧进程 PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

if not exist "node_modules" (
    echo [TFvision] 首次运行，安装依赖 ...
    call npm install
    if errorlevel 1 goto :fail
)

if not exist ".next\BUILD_ID" (
    echo [TFvision] 未找到构建产物，开始构建 ...
    call npm run build
    if errorlevel 1 goto :fail
)

echo [TFvision] 启动服务：http://localhost:%PORT%
start "" http://localhost:%PORT%
call npm start -- --port %PORT%
goto :eof

:fail
echo.
echo [TFvision] 启动失败，请查看上方错误信息。
pause
