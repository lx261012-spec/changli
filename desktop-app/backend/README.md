# 本机连接与录音识别

桌面程序复用 `D:/GPT/背景项目通用功能/智能底基/底基1.0`，从该目录读取端口和访问令牌。令牌仅在本机服务端向底基发送，不进入页面、网址或日志；模型密钥、历史和配置均不复制。底基已运行则复用，未运行才用其便携Node启动；关闭程序仅结束由本程序启动的底基进程。

桌面服务固定使用 `http://127.0.0.1:4341`，让同源的朗读开关和界面偏好在重启后保留。端口冲突时报告故障，不静默换成会丢失偏好的其他来源。仅接受本机Host、同源Origin和同源浏览器请求。

录音结束后使用本机Faster Whisper small多语种模型识别，结果只进入可编辑草稿，由用户手动发送。音频不上传到云端；临时录音处理完成、取消或失败后删除。最长120秒、最大16MiB；模型CPU首次加载约14秒（既有3.14秒WAV实测），具体随录音长度和负载变化。

语音识别结果统一经当前Python环境已有的OpenCC（t2s）转换为简体中文，再进入主窗口或桌宠的可编辑草稿。保留英文、数字与标点，不改用户手工输入或历史记录，不自动发送。替换Python环境时也需保留OpenCC。

识别运行时依次查找当前项目的 `work` 目录及已安装来源 `D:/UserData/Documents/ChatGPT/爱弥斯agent/work`，复用已有Python3.12、`audio-runtime`和`audio-models/faster-whisper-small`，不重复复制约484MB模型。移动或清理来源目录后，可以在启动本程序的环境中明确设置：

- `CHANGLI_ASR_PYTHON`：Python3.12的python.exe完整路径。
- `CHANGLI_ASR_RUNTIME`：包含faster_whisper等现有包的目录。
- `CHANGLI_ASR_MODEL`：含model.bin、config.json及tokenizer.json的本地模型目录。

资源缺失时 `GET /desktop/health` 返回 `transcription.available=false`，界面保留文字输入；不联网下载模型、不切换云端识别。麦克风权限与真实录音采集需由Electron运行端确认；现有WAV识别通过不能代替麦克风采集验收。

`node --test desktop-app/backend/server.test.mjs` 在临时目录和替身底基验证身份注入、来源/路径限制、视频Range/HEAD、录音限制与SSE取消，不修改正式历史。实际本机回环测试需获得执行环境的网络访问许可。
