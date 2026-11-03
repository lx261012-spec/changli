# 桌面程序接口与运行检查

本机运行入口：`打开长离.vbs`（隐藏启动，无命令窗口）；`启动长离.cmd` 保留作备用。使用随包的 Node.js 和 Electron，不依赖 Codex 的应用可执行文件。Electron 43.3.0 来自本机官方缓存，压缩包 SHA256 与 GitHub 官方 `SHASUMS256.txt` 一致，记录在 `runtime/source-verification.json`。

`main.cjs` 从 `server.mjs` 调用 `startDesktopServer({testMode})`；返回 `url`、`close()`、`requestBackend(path,{method,body})`。同源页面只访问本机代理，底基令牌留在服务端。后台状态轮询不发新任务或聊天。

## 渲染接口

`window.desktop` 由隔离的 preload 提供，拒绝未知来源 IPC。方法：

- `getState()`：桌宠可见性、壁纸状态与设置、录音快捷键、进入标记、测试模式。
- `enterChat()`：仅首次返回 `{greet:true}`；由首页入口调用，托盘恢复和新建会话不重播。
- `showChat(page)`、`openSettings(section)`、`minimize()`、`close()`：打开页面、最小化或收托盘。
- `toggleMaximize()`：主窗口最大化/还原，返回`{maximized,minimized,visible}`；`getState().window`与`window-state`事件同步原生状态，按钮标签随之更新。从最小化恢复时先restore再show，保留此前最大化状态。
- `hidePet()`、`showPet()`、`movePet({dx,dy})`、`setPetInteractive(bool)`：桌宠显示、限制在屏幕范围的拖动和透明区鼠标穿透。
- `setWallpaperEnabled(bool)`、`setWallpaperSettings({follow,volume,videoSound,paused})`：启用壁纸和保存显示参数。
- `setPetSettings({scale?,opacity?})`：即时调整并保存桌宠人物显示。scale为0.5—2，opacity为0.2—1；只改人物透明度，文字/按钮清晰度保持。`getState().petSettings`返回实际值，`pet-settings`事件携带`settings`及重新钳制后的`petPosition`，尺寸变化后重新发布命中区域。设置保存在角色程序自己的data/window.json，重启恢复。
- `setRecordingShortcut(string|null)`：注册或清除用户选择的全局录音键，冲突返回错误；无默认键。`setVoiceEnabled(bool)` 只同步托盘勾选状态。
- `quit()`：检查活动任务，用户选择停止后才退出；退出移除壁纸窗口并保留原系统壁纸。
- `onEvent(callback)` 或 `on(type,callback)`：返回取消监听函数。

事件：`navigate`、`settings-section`、`record-toggle`、`audio-toggle`、`shortcut-error`、`shell-state`、`task-complete`、`wallpaper-settings`、`wallpaper-pointer`。

`wallpaper-pointer` 含 `x/y`（显示内容坐标/DIP）、`active`、`click/down`。原生辅助进程使用物理坐标，主进程按显示器 DPI 转换。仅空桌面点击可触发，桌面图标通过 Windows Accessibility 角色检查排除；前台应用覆盖区不触发。渲染适配器必须忽略 `active:false` 并回正视线。

## Windows壁纸与生命周期

原生 PowerShell/C# 接口将窗口嵌入不含桌面图标视图的 WorkerW，验证实际父窗口成功。没有修改系统壁纸路径、样式或注册表；关闭或进程退出会自然露出原壁纸。恢复快照和比对日志在 `data/wallpaper-recovery.json` 与 `logs/shell.log`。恢复失败提示和重试入口由设置页呈现。

单实例重复启动只唤回原窗口。× 收托盘，不改变语音、桌宠或任务；六项托盘菜单沿用已确认列表。任务开始隐藏聊天，需要授权显示任务页，完成通知可查看详情。`lifecycle-watch.mjs` 在主进程意外退出时暂停长离活动任务，正常退出不重复操作，恢复须用户手动决定。`data/task-recovery.json` 保存异常退出检查结果，`getState().recovery` 供界面明确提示；正常退出标记为 `clean:true`，不把旧中断提示反复显示。

## 测试

- `runtime/node.exe --test scripts/shell.test.cjs`：窗口边界、IPC参数、任务退出范围、崩溃暂停逻辑。
- `runtime/electron.exe . --smoke-test --wallpaper-smoke`：隔离配置目录；主窗口/桌宠、隔离桥、单次问候、关闭恢复、六项菜单、真实 WorkerW 嵌入和原壁纸恢复。保存 `qa/shell-smoke.json` 与窗口截图。
- `--ui-check`：隔离配置、关闭任务轮询/主动关心展示，保留窗口用于外观检查；不会自动退出。仍需界面根据 `testMode` 禁止邀请回执。

当前真实原生检查已通过；听感、录音识别、游戏映射和完整模型响应速度的验收应分别查看各模块报告。单个网页截图不等于完整桌面验收。
