# 底基1.0 · 本地测试版

2026-10-28 主动关心接听更新：测试台增加功能联调区，接听台词原子写入长离当前会话；无会话首次接听再建，拒绝/超时不写聊天。已接听台词可手动播放对应首轮原录音，自动出声遵循原朗读开关；文件缺失或校验失败保留文字，不自动换音源。当前会话按角色保存，历史编辑/删除同步移除失效录音关联；首条主动关心也可重生成。

同源测试台窗口以 BroadcastChannel 和 Web Locks 统一播放，后触发打断前一条，原生播放器重听也参与互斥。实际 Electron 桌宠/真实壁纸的运行端尚未接入，不能据此称为完整桌宠验收。当前完成105项回归和12项隔离Edge检查，使用真实已有录音；聊天续聊另做一次官方GPT账号临时库实测，详见本轮联调记录。

2026-10-28 更新：GPT新增官方Codex客户端的ChatGPT账号模式，已用现有登录真实验证GPT-6.1 Sol回复与记忆；API密钥模式仍保留，其额度限制与账号模式分开。长离本地GPT-SoVITS、回复后自动朗读及独立停止保持；完整Electron/壁纸集成、6秒首响应与文音同步仍未达标。重复启动会复用旧服务，改配置后须重启。

交付范围：Windows 本机智能底基、接口与功能管理台。默认聊天模型 GPT-6.1 Sol，可手动切换 DSH 中的同款 DeepSeek-V4.1-Flash（当前1017，经 DeepSeek API 调用）或 Gemini。真实模型接入按用户选择留到后续。

## 启动

双击 `启动底基.cmd`。包内带 Windows x64 Node.js 24.19.0 和已安装依赖，无需先安装 Node 或联网下载包。

启动器会打开管理台并自动带入本机访问令牌。保持启动窗口打开，按 Ctrl+C 停止服务。默认地址为 `http://127.0.0.1:4317/`。

如果浏览器没有自动打开，手动访问该地址，将 `data/access-token` 文件整行内容填入“本机访问令牌”。该令牌只保护本机管理台，**不是模型 API Key**。不要对外开放端口或分享令牌。

首次启动自动从 `.env.example` 创建 `.env`。模板不含密钥；各通道是否可用以本机实际API凭据或官方账号登录状态为准。角色资料、会话与记忆管理无需模型。

## 之后接入模型

在本机编辑同目录 `.env`，保存后停止并重新启动底基：

双击 **填写模型密钥.cmd** 会用记事本打开唯一生效的 `.env`。`.env.example` 仅为首次启动模板，不在其中填密钥；交付目录已将空模板设为隐藏，避免文件扩展名隐藏时误认成两个ENV。Gemini与GPT/DeepSeek均填写在同一个实际 `.env` 中。

若 Node 直连 GPT 超时而本机已有可用 HTTP 代理，可在 `.env` 显式设置 `NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY=http://代理地址:端口` 和 `NO_PROXY=127.0.0.1,localhost,::1,api.deepseek.com`。启动器在读取 `.env` 后启用 Node 原生代理，本机服务和已验证可直连的官方 DeepSeek 地址按 NO_PROXY 绕行；不修改 Windows 代理或关闭 TLS 校验。更换代理端口后同步修改此配置并重启。便携包自带 Node 24.19，外部 Node 最低 24.14。

| 通道 | 配置项 | 默认模型 |
|---|---|---|
| OpenAI | `OPENAI_API_KEY`，必要时配置 `OPENAI_BASE_URL` | `gpt-6.1-sol` |
| DeepSeek（DSH中同款模型） | `DEEPSEEK_API_KEY`，必要时配置 `DEEPSEEK_BASE_URL` | `deepseek-flash`（2026-10-28 对应 V4.1-Flash-1017） |
| Gemini | `GEMINI_API_KEY`，可配置 `GEMINI_MODEL`、`GEMINI_BASE_URL` | `gemini-3.8-flash` |
| UI-TARS 电脑操作 | `GUI_BASE_URL`、`GUI_API_KEY`、`GUI_MODEL`；模型版本需与动作解析匹配 | 尚未选定/实测 |

GPT支持两种明确选择的方式：`OPENAI_AUTH_MODE=api-key` 使用原OpenAI API密钥；`OPENAI_AUTH_MODE=codex-account` 使用本机已通过ChatGPT登录的官方Codex CLI，`CODEX_EXECUTABLE` 可指定客户端路径。当前本机已按用户授权选账号模式，仍为GPT-6.1 Sol；不会因任何一种方式失败而偷偷换另一种或换模型。账号方式使用对应ChatGPT/Codex额度，不使用.env里的OPENAI_API_KEY；密钥仍保留以便以后手动切回。无需把登录令牌、密码填到.env，也不复制或提取客户端凭据。

账号方式通过官方CLI的`exec --ephemeral`，逐次提供当前角色有效历史。禁用命令、文件变更、插件、技能发现、子Agent和相关工具，使用只读沙箱，不加载项目AGENTS或用户Codex配置、不写Codex会话文件；电脑操作仍须走底基独立任务权限。当前客户端仅提供完整回复事件，所以文字在回复完成后出现，非逐字流式；中性短句实测约8.8秒，6秒目标未达标。每次为独立临时会话，自动记忆另起一次；本机准确字符保护阈值50,000，明确不是模型token上限或消费预估，超限由用户整理，不暗中压缩。OpenAI服务端的数据保留规则不由本机临时会话控制。需要保留官方Codex安装和ChatGPT登录；客户端更新改变路径后同步CODEX_EXECUTABLE。

不要把 API Key 发在聊天里或填进“共享用户资料”。三家凭据独立，角色可分别手动切换通道；额度耗尽时暂停对应通道并提示，不自动换服务。额度恢复后可点“额度恢复后重试模型”。底基不会自行重发失败的生成；官方Codex客户端自身的网络恢复由该客户端管理。Google 返回 HTTP 429（可能是短期限流或配额限制）时显示限流错误，等待用户处理后手动重试，不推断为余额不足。

OpenAI 使用 Responses 流式接口、`store:false` 和手动维护的有效历史。DeepSeek 使用 Chat Completions 流式接口、非思考模式。通道切换会停止旧回复，保留当前角色自己的历史和记忆。`store:false` 不等于撤回服务商已经接收的数据。

Gemini 使用 Google 原生 `streamGenerateContent`（SSE）、`countTokens` 和 JSON 结构化记忆接口；无需安装新 SDK。密钥仅在服务端通过 `x-goog-api-key` 请求头发送，拒绝重定向，不放进 URL/浏览器。Gemini 通道默认采用官方当前稳定的 Gemini 3.8 Flash，当前全局首选仍为 GPT-6.1 Sol。已有 `.env` 只需自行新增一行 `GEMINI_API_KEY=你的密钥`，保存并停止旧服务、重新启动后在测试台手动选择 Gemini；只刷新页面或重复双击启动器会复用旧进程，不能重新读取配置。源模板更新不会覆盖已有 `.env`。更换 Gemini 模型时，同步按官方规格设置 `GEMINI_CONTEXT_LIMIT`（默认输入上限 1,048,576）；这是上下文保护，不是消费预估。当前 Gemini 本地替身测试通过，不代表真实 Google API 已验收。

用户于 2026-10-28 明确：整个底基默认仍为 GPT-6.1 Sol；只有切换到 DSH 对应模型通道时才使用截图中的 DeepSeek-V4.1-Flash（1017），并非更换全局默认。官方 API 模型 ID 为 `deepseek-flash`，当前映射 1017；该名称是滚动别名，不能据此承诺永久锁定 1017。新数据目录默认 GPT，已保存的角色通道选择不会在每次启动被覆盖。API 密钥来自 DeepSeek 开放平台，不是 DSH 登录令牌。DSH（DeepSeek Harness）是独立 Agent 框架，现有直接模型 API 不代表 DSH 框架已接通；用户也接受 API 密钥方式，不限定为复用 DSH 登录态。

## 已实现的底基行为

- 长离、爱弥斯各自独立：`changli.sqlite`、`aimisi.sqlite` 分别保存设定、会话、自动记忆和整理提醒；仅 `shared.sqlite` 保存共享用户基础资料。
- 用户维护的源资料对模型只读。角色可自行整理记忆，用户可查看、编辑和删除；每条自动记忆关联源消息。
- 每七天提醒整理；用户勾选删除，不按时间自动清空。程序未运行时不会发系统通知，下次打开管理台展示到期状态。
- 任意历史消息可编辑：成功保存后覆盖后续消息，相关旧记忆在同一事务中清理，不保留隐藏分支。
- 可重新生成历史角色回复：先生成，成功后原子覆盖原回复及其后续；失败/打断时原历史保留。不会再次执行历史电脑操作。
- 删除源消息或会话时，所有依赖这些来源的自动记忆同步失效。用户资料不由模型改写。
- 同一角色的新消息可打断旧回复；打断电脑任务后保留进度，等待用户恢复或取消；恢复前重新观察。
- OpenAI 与 Gemini 的上下文长度通过各自官方服务端接口计数；达到上限暂停，不自动删历史或压缩。DeepSeek 显示准确的本机字符数量，以 200,000 字符作为保守本机保护阈值，**不冒充模型 token 上限，也不做消费预估**。
- 启动时给出一条通用建议；按人物性格与场景细化主动性留待后续。
- 电脑任务有状态、审批、日志、25 步默认上限、5 分钟超时、重启暂停和执行互斥。

## 电脑授权的实际边界

权限引擎支持“仅本次允许”“始终允许”以及撤销。始终授权限定角色、应用和明确能力。受信语义操作器中的普通打开、读取、导航、播放/游戏操作可默认允许，发送、删除、付款、系统设置等需确认。

**当前唯一实际接入的是 UI-TARS 原始 GUI 操作器。** 原始坐标和按键不能可靠证明前台应用，也不能可靠判定是否在发送、删除或付款，因此本版实际 GUI 输入逐次审阅，仅支持“仅本次允许”。普通软件免确认全自动和实际 GUI 的“始终允许”尚未完成实机适配，不能据此视为已验收。

审批后会重新截图核对。画面变化会阻止旧坐标，动画、闪烁光标或审批页面抢焦点也可能触发保守拒绝。当前操作器需要用户查看实际屏幕，不在管理台保存屏幕截图。

打断会阻止后续动作；已经起跑的一次原生输入可能完成。当前同一服务内两个角色及同一数据目录的多个进程互斥；**不要同时启动使用不同数据目录的多个真实电脑执行服务**，系统级多实例全局互斥尚未实现。

这是项目自身的权限实现，不代表复制或自动继承了 ChatGPT 产品的全部条款、审批系统或可靠性保障。

## 功能管理台与接口

测试台提供角色/通道/会话切换、流式聊天、停止、历史编辑、重新生成、消息勾选删除、用户资料与角色设定维护、记忆管理、每周整理确认、任务审批和授权撤销。

这是底基的功能管理台；人物首页、Live2D、动态壁纸与语音识别未加入本版。长离 GPT-SoVITS 语音已接，见《长离实时聊天语音接入说明.md》；目前完整回复保存后再合成。6 秒起始响应与文音相差不超过 2 秒是项目目标，尚未达标和真实模型验收。

接口均在 `/api/` 下，使用 `Authorization: Bearer <本机访问令牌>`：

| 接口 | 用途 |
|---|---|
| `GET /api/state?character=changli` | 当前角色状态、会话、记忆、通道、任务与授权 |
| `PUT /api/profile` | 用户维护共享资料，JSON `{ "profile": {} }` |
| `PUT /api/characters/:id` | 用户维护角色设定，JSON `{ "instructions": "..." }` |
| `POST /api/characters/:id/provider` | 手动切换，JSON `{ "provider": "openai" }`，也支持 `deepseek`、`gemini` |
| `POST /api/characters/:id/sessions` | 新会话 |
| `PUT /api/characters/:id/active-session` | JSON `{ "sessionId": "..." }`，保存当前会话；状态接口返回 `activeSessionId` |
| `GET /api/characters/changli/care` | 软件关心状态及有效邀请 |
| `POST .../care/present` | `{ "invitationId": "...", "consumerId": "窗口UUID" }`，独占显示回执，才开始10秒倒计时 |
| `POST .../care/respond` | `{ "invitationId": "...", "consumerId": "窗口UUID", "choice": "accept", "sessionId": "..." }`；接听返回 `delivery.sessionId/message`，重复/过期拒绝。会话缺省则用已保存当前会话；reject不加消息 |
| `GET .../care/audio/:messageId` | 当前角色现存主动关心消息的原录音，沿用Bearer/Host/Origin校验；编辑/删除后不返回旧关联 |
| `GET/DELETE /api/characters/:id/sessions/:session` | 读取/删除会话 |
| `POST .../sessions/:session/messages` | JSON `{ "content": "..." }`，返回 SSE |
| `PATCH .../sessions/:session/messages/:message` | 修改历史并覆盖后续 |
| `POST .../sessions/:session/regenerate` | JSON `{ "messageId": "..." }`，返回 SSE |
| `POST .../sessions/:session/messages/delete` | JSON `{ "ids": [] }` |
| `GET .../sessions/:session/context` | 当前有效上下文长度 |
| `PATCH .../memories/:memory` / `POST .../memories/delete` | 修改/删除自动记忆 |
| `POST .../review` / `POST .../interrupt` | 确认本周整理/打断 |
| `POST .../tasks` | JSON `{ "appId": "notepad", "instruction": "..." }` |
| `GET .../tasks/:task` | 任务状态 |
| `POST .../tasks/:task/interrupt`、`resume`、`cancel` | 任务控制 |
| `POST .../tasks/:task/approve` | JSON `{ "approvalId": "...", "mode": "once" }`，受信明确能力可用 `always` |
| `DELETE .../grants/:grant` | 撤销始终授权 |
| `POST /api/model/retry` | JSON `{ "provider": "openai" }`，仅恢复指定通道 |

其中 `...` 表示 `/api/characters/:id`。SSE 事件包括 `context`、`started`、`latency`、`delta`、`saved`、`memory`、`warning`、`interrupted`、`done`、`error`。用户资料和角色设定没有暴露给模型的写入工具。

## 测试与后续维护

双击 `运行测试.cmd`，或执行 `runtime/node.exe --test test/*.test.mjs`。语法与已安装依赖检查：`runtime/node.exe scripts/check.mjs`。详情见 `验收报告.md` 和 `test-results.tap`。

开发使用 [Ponytail full 技能](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md) 及其 review 指导，以项目指令方式使用，未安装全局生命周期插件。复用 Node.js 标准库、SQLite、UI-TARS SDK；`uuid` 为补齐上游 SDK 漏声明的运行依赖。依赖版本锁在 `pnpm-lock.yaml`。

源码在 `src/`，管理台在 `public/`，测试在 `test/`。需要重装依赖时使用 pnpm 11，执行 `pnpm install --frozen-lockfile`。安装源和复制方式在 `.npmrc` 中；无需重装即可使用交付目录。

本地数据在 `data/`；`.env` 与此目录不进入源码交付清单。SQLite 开启安全删除，不创建隐蔽历史副本；不承诺擦除系统备份、文件恢复软件或外部服务的既有记录。

## 官方参考

- [UI-TARS SDK](https://github.com/bytedance/UI-TARS-desktop/blob/main/docs/sdk.md)
- [OpenAI Responses 流式接口](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI 长度计数接口](https://developers.openai.com/api/docs/guides/token-counting)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Gemini 原生生成接口](https://ai.google.dev/api/generate-content)
- [Gemini 上下文计数接口](https://ai.google.dev/api/tokens)
- [Gemini 3.8 Flash 模型规格](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [官方Codex账号与API认证方式](https://learn.chatgpt.com/docs/auth)
- [Ponytail 技能](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md)

Node.js 运行时许可证见 `runtime/LICENSE`，各依赖许可证保留在 `node_modules` 各包中。
