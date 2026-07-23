# TFvision 项目操作指南

本文件供后续 Codex 新对话自动读取。用户要求“启动项目并在右侧浏览器打开”时，直接遵循下面的流程，不要重新试错。

## 固定信息

- 工作目录：`C:\Users\Jony.li\Desktop\TFVision`
- Windows 虽然路径不区分大小写，但 Next.js 构建会区分模块标识。所有启动、构建命令的 `workdir` 必须使用磁盘真实名称 `TFVision`；不要写成 `TFvision`，否则可能出现 React 模块重复和 `/500` 预渲染失败。
- 服务地址：`http://localhost:3460`
- 技术栈：Next.js 15；`package.json` 中提供 `dev`、`build`、`start` 命令。
- 用户所说的“右侧浏览器”指 Codex 内置浏览器。不要用 `start http://...`、系统默认浏览器或批处理自动打开的外部浏览器代替。

## 启动服务的最短可靠流程

### 1. 先复用已有服务

先执行：

```powershell
netstat -ano | findstr ":3460"
```

若看到 `LISTENING`，再执行健康检查：

```powershell
$response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3460' -TimeoutSec 10
"HTTP=$($response.StatusCode) BYTES=$($response.Content.Length)"
```

返回 HTTP 200 就表示服务已经可用，直接进入浏览器步骤，不要重复启动或杀掉进程。

> 不要只依赖 `Get-NetTCPConnection`。本项目实际遇到过端口正在监听、HTTP 也返回 200，但该命令仍返回空结果的情况；以 `netstat` 和 HTTP 健康检查为准。

### 2. 仅在服务未运行时启动

依赖通常已经安装。只有 `node_modules` 不存在时才执行 `npm install`。

普通使用优先运行已有生产构建：

```powershell
npm start -- --port 3460
```

如果 `.next\BUILD_ID` 不存在，先执行：

```powershell
npm run build
```

需要连续修改前端并立即看到结果时，可改用热更新模式：

```powershell
npm run dev -- --port 3460
```

Codex 需要让服务脱离当前命令、在后台持续运行时，不要使用 PowerShell `Start-Process`。当前 Windows 环境可能同时带有 `Path` 与 `PATH`，`Start-Process` 会报“字典中的关键字 Path/PATH”冲突。可使用以下已验证能创建后台进程的方式，并将日志保存在项目内。**该启动命令必须通过 shell 的沙箱外授权执行**；在沙箱内即使短暂返回 HTTP 200，子进程也可能随着命令结束被回收，随后浏览器会出现 `ERR_CONNECTION_REFUSED`。

```powershell
$work = 'C:\Users\Jony.li\Desktop\TFVision'
$stdout = Join-Path $work 'output\tfvision-server.log'
$stderr = Join-Path $work 'output\tfvision-server-error.log'
$npmPath = (Get-Command npm.cmd).Source
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $env:ComSpec
$psi.WorkingDirectory = $work
$psi.Arguments = "/d /c `"`"$npmPath`" start -- --port 3460 1>`"$stdout`" 2>`"$stderr`"`""
$psi.UseShellExecute = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($psi)
"LAUNCHER_PID=$($process.Id)"
```

后台启动后，用 `netstat` 和 HTTP 200 再验证一次。若启动日志出现 `EADDRINUSE`，表示已有服务占用 3460；先重新做健康检查。已有服务健康时直接复用，不要继续启动第二份。

`启动TFvision.bat` 会主动打开系统默认浏览器，并会结束占用 3460 的旧进程。用户要求右侧内置浏览器时，不要直接运行该批处理。

## 在右侧内置浏览器打开

1. 使用会话提供的 Browser / 内置浏览器能力，并先按该技能说明完成连接。
2. 选择 Codex in-app browser（`iab`），将可见性设为 `true`。
3. 先查看已有标签页；若已有 `localhost:3460` 标签，认领并复用，避免重复标签。
4. 否则新建标签并导航到 `http://localhost:3460`。
5. 等待 `domcontentloaded`，确认：
   - URL 为 `http://localhost:3460/`
   - 页面标题为 `TFvision · 无限画布工作流`
   - `document.readyState` 为 `complete`
   - 页面存在“画布 1”“历史资产”“设置”等按钮
   - 控制台没有 error
6. 最终保留该标签为 `deliverable`，让页面继续显示在右侧供用户操作。

该应用主要是画布 UI，浏览器 DOM snapshot 有时只显示 `- alert`，这不等于页面加载失败。此时应通过标题、`document.readyState`、按钮列表和控制台错误做定向验证，不要因为 snapshot 内容少而反复重启服务。

## 后续代码更新

- 运行 `npm run dev -- --port 3460` 时通常可直接热更新；必要时重载当前内置浏览器标签。
- 运行 `npm start -- --port 3460` 时，源码修改不会自动进入已有生产构建。修改后执行 `npm run build`，重启 3460 服务，再重载同一个内置浏览器标签。
- 不要无故关闭用户正在使用的内置浏览器标签，也不要为每次验证创建重复标签。
