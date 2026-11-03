# 长离桌面智能体 · 听雪闲叙

当前本机整合版的源码快照，归档日期：2026-11-03。包含 Electron 桌面壳、首页与聊天界面、透明桌宠、Windows 壁纸承载、录音转文字接口，以及聊天/记忆/任务/软件主动关心的智能底基。

**当前主要难点是语音生成 Agent，以及连接各种软件时的智能操作稳定性。** 详细状态见 [当前难点](docs/CURRENT-BLOCKERS.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `desktop-app/` | 当前成品的 Electron 主进程、渲染页面、透明桌宠、壁纸、识别桥、启动脚本和测试 |
| `foundation/` | 当前部署使用的 Node.js 底基、模型通道、SQLite 存储、语音接口、软件观察器与测试 |
| `docs/ASSETS-MANIFEST.json` | 本机素材的相对路径、大小和 SHA-256；用于恢复未入库资源 |
| `docs/CURRENT-BLOCKERS.md` | 语音生成和软件联动的问题、设备限制与未证实假设 |

这是**源码归档**。本机成品已经运行过，但克隆本仓库后仍需安装依赖并恢复资源，不能直接视为可在任意电脑上一键启动的安装包。

## 已接入的功能与边界

- Electron 首页、聊天/会话/记忆/任务/设置页、窗口回收/最小化/最大化与托盘。
- 透明桌宠的拖动、大小和透明度调节、动态待机、轮廓穿透与录音/文字入口。
- Windows WorkerW 壁纸承载、角色交互，以及程序退出后的壁纸恢复。
- 录音经本地 Whisper 识别、OpenCC 转简体，进入可编辑草稿，由用户手动发送。
- 聊天/软件主动关心使用同一角色会话与共享播放器；GPT-SoVITS 是当前已有语音实现，Breeze-TTS 尚未接通。
- 默认模型、账号认证与其他通道的代码均在底基中；不会随仓库发布凭据。DSH 框架本体尚未集成，直接 DeepSeek API 通道不等于 DSH。
- QQ 音乐的固定本地启动已接入；通用电脑操作的配置和真实联动尚未完成验收，不能视为任意软件均可稳定操作。
- 最新首页重新设计仍处于讨论阶段，本仓库存放当前已交付版本。

## 恢复运行

1. 准备 Windows、Node.js 24.14 或以上、pnpm 和 Python。原版 Electron 运行时为 43.3.0。
2. 在 `foundation/` 安装依赖：`pnpm install --frozen-lockfile`。复制 `.env.example` 为 `.env`，在本机填写配置。密钥不提交 Git。
3. 恢复 `docs/ASSETS-MANIFEST.json` 中资源至对应位置。视频、音频、头像/标题/桌宠图片、模型权重、Electron 与 Python/Node 便携运行时没有入库。
4. 使用 `desktop-app/scripts/安装运行时.ps1` 安装原版 Electron，或恢复本机已有运行时；确认本地模型和 Python 环境可用。
5. 按 `desktop-app/backend/README.md` 配置 `CHANGLI_ASR_PYTHON`、`CHANGLI_ASR_RUNTIME`、`CHANGLI_ASR_MODEL`；按底基配置设置 `CHANGLI_VOICE_ROOT` 和 GPT-SoVITS。
6. 运行 `desktop-app/启动长离.cmd`，或 `node desktop-app/scripts/start.cjs`。

**迁移限制：** 当前代码仍含原机器的安装路径、角色资源和场景映射。桌面服务优先查找原 D 盘已安装底基，找不到才使用相邻 `foundation/`。`prepare-assets.mjs` 也依赖原素材位置；它不是通用下载器。换电脑需检查这些路径及依赖，不应假定代码已经完全通用化。

## 测试与验收

```powershell
node --test desktop-app/scripts/shell.test.cjs desktop-app/backend/server.test.mjs
cd foundation
pnpm test
pnpm check
```

测试不等于物理麦克风、真实软件操作、听感或所有设备性能验收。历史本机真实角色回复约 11 秒；目标为起始响应不超过 6 秒、文音起始差不超过 2 秒，尚未达标。

## 归档范围

仅发布代码、配置空模板、测试和技术说明，不发布 `.env`、访问令牌、账号登录态、聊天历史、记忆库、用户偏好、日志、语音模型权重或个人录音。素材清单仅提供校验信息，不含原始媒体。第三方依赖按各自许可使用，本仓库未另行授予游戏角色素材或第三方模型权重的使用许可。
