# TFvision

无限画布 + 节点式 AI 工作流 · 以图片为主，视频为辅（o1key 网关）

对标 libTV 的画布交互（双击加节点 / ⊕ 连线 / 节点下方生成栏），接口与模型层复用自 [TVision](https://github.com/lizhongyi1209/TVision)。深色影棚级界面 · 单一暖强调色 · 玻璃面板。

---

## 快速开始

```bash
npm install      # 已安装可跳过
npm run dev      # 开发模式
# 或
npm run build && npm run start   # 生产模式（推荐，更快）
```

打开 http://localhost:3000 。首次进入会自动弹出**设置**，填入你的 o1key 令牌即可开始。

## 核心交互（对齐 libTV ≈80%）

| 操作 | 效果 |
|---|---|
| **双击画布** | 弹出「添加节点」菜单：文本 / 图片 / 视频 + 上传图片 / 从生成历史选择 |
| **悬停节点 → 左右 ⊕** | 点击弹出「引用该节点生成」菜单，或直接拖拽连线到另一节点 |
| **连线** | 图片→图片 = 参考图；文本→图片/视频 = 提示词；图片→文本 = 反推源；图片→视频 = 首帧 |
| **节点内 Ctrl+Enter** | 快速生成 |
| **双击连线** | 删除连线 |
| **拖图片文件到画布** | 直接生成图片节点 |
| **Delete / Backspace** | 删除选中节点或连线 |
| 底部工具坞 | ＋添加节点 · 适配视图 · 缩放 · 快捷键说明 |
| 右上角 | 历史资产（图片/视频 tab，点击放回画布）· 设置 |
| 左上角 | 工作区改名 · 多画布切换/新建/重命名/删除 |

## TFvision 的 20%（图片优先的差异化）

- **风格预设**：生成栏「风格」chip 一键注入电商白底 / 影棚灯光 / 户外实景 / 平铺俯拍 / 胶片 / 极简留白提示词后缀
- **空画布快捷工作流**：商品图精修 / 模特换装（双参考图）/ 反推重绘（图→反推→重生成）/ 首帧图生视频，一键铺好连线的节点链
- **视觉反推**：文本节点连入图片后一键反推出结构化 JSON 提示词（gemini-3.1-pro-preview），可编辑后再生成
- **多图参考**：多个图片节点连入同一生成节点 = 多图参考（底图 + 最多 8 张参考，顺序即「第 N 张图」）
- **批量出图**：单节点 1/2/4 张，胶片条切换选用
- **断点续跑**：刷新页面后仍在运行的任务自动恢复轮询

## 模型（复用 TVision / o1key）

- **图片**：Nano Banana Pro（1K/2K/4K，质量最佳）· Nano Banana 2（512-4K，快速）· Nano Banana（1K）· GPT Image 2（1K-4K，画质档）；计费 特价/官方
- **视频**：可灵 v3 / v2.6 / v3 Omni · Seedance 2.0 / 2.0 Fast（720p-4K，3-15s，音效/固定镜头）
- **反推**：gemini-3.1-pro-preview（/v1/chat/completions）

## 目录结构

```
TFvision/
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx / page.tsx / globals.css     # 壳 + 主题 tokens + React Flow 皮肤
│  │  └─ api/                                    # 本地后端（Route Handlers）
│  │     ├─ jobs/            POST 提交生图 · [id] GET 轮询并落盘 output/
│  │     ├─ video/           jobs 提交 · jobs/[taskId] 轮询 · save 本地保存 · upload 预签名直传
│  │     ├─ reverse-prompt/  视觉反推（chat/completions）
│  │     ├─ settings/        GET/POST 设置 · test 连接探测
│  │     ├─ media/[name]     读取 output/ 下生成的图片/视频
│  │     ├─ history/         历史列表 / 删除
│  │     └─ boards/          工作区（多画布节点图）持久化
│  ├─ components/            # Studio / 节点 / 菜单 / 面板
│  └─ lib/                   # o1key.ts · models.ts · videoGateway.ts · vision.ts · store.ts …
├─ data/                     # settings.json（含令牌，已 gitignore）· boards.json · 元数据侧车
└─ output/                   # 生成结果（已 gitignore）
```

## 架构要点

- **单栈本地应用**：Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v4 + @xyflow/react (React Flow 12) + Zustand + Motion。Route Handlers 即本地后端 —— 令牌不进浏览器、天然绕过 CORS、承接大体积 base64。
- **o1key 异步生图**：`POST /async/v1/generateImage` → `task_id`，轮询 `GET /async/v1/tasks/{id}`，成功后下载到 `output/` 经 `/api/media` 提供，自动进历史。
- **视频**：可灵 `image2video` / `omni-video` + Seedance 统一协议 `/v1/video/generations`；参考图先经网关预签名上传拿公网 URL；成片下载到本地 `output/video-<taskId>.mp4`。
- **画布持久化**：整个工作区（多画布 + 节点 + 连线 + 命名计数）防抖写入 `data/boards.json`，刷新不丢。
