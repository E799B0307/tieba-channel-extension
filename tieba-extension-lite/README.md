# 贴吧频道聊天室（tieba-extension）

在 Chrome / Edge 侧边栏里使用贴吧频道的非官方扩展。当前版本 `0.2.5`。

本仓库 = **朋友 0.2.5 基线**（图片发送 / 收藏表情 / 表情回应 / 撤回 / 版本握手）+ **我的机器人功能**（命令 / 违禁词 / B站监控 / 独立机器人账号 / 管理员鉴权）。

## 两个版本

| 版本 | 目录 | 说明 |
|------|------|------|
| **完整版（机器人版）** | `tieba-extension/`（本目录） | 聊天室 + 机器人全套功能 |
| **精简版（纯聊天）** | 朋友的 `tieba-channel-extension-0.2.5-local-windows/` | 仅聊天，无机器人，用于分发普通用户 |

精简版也可由 `build-lite.ps1` 从本目录生成（移除机器人文件与 B站/alarms 权限）。

## 功能

### 聊天（来自 0.2.5 基线）

| 功能 | 说明 |
|------|------|
| 💬 频道聊天 | 查看/发送文字消息，支持回复、@成员、表情 |
| 🖼 图片发送 | 上传本地图片 / 粘贴剪贴板图片 |
| 😊 收藏表情 | 同步手机端收藏表情并发送 |
| 👍 表情回应（贴表情） | 给消息贴表情、查看贴表情的人 |
| ↩ 撤回消息 | **按频道权限撤回**（自己消息 or 管理员撤回他人）——已用 REST `withdrawMsg` 端点解决 |
| 🔄 版本握手 | runtime-info 校验前后台版本一致 |

### 机器人（本仓库独有）

| 功能 | 说明 |
|------|------|
| 💬 命令交互 | /help /ping /latest /sub /unsub /status（需 @ 机器人） |
| 🚫 违禁词筛选 | 静默记录 + 管理员命令（/banword /unbanword /listbadwords） |
| 🔴 B站监控 | 每 5 分钟查直播/动态，推送订阅房间 |
| 🤖 独立机器人账号 | 可填独立账号 BDUSS，机器人以独立身份发言 |
| 👑 管理员鉴权 | 管理员 UID 名单（设置页管理），仅管理员能改违禁词 |

详见 **[docs/bot.md](docs/bot.md)**（机器人完整说明）。

## 架构

```
tieba-extension/
 ├── background.js         SW：dispatch（含图片/贴表情/撤回/机器人接线）+ B站 alarm
 ├── tieba.js              TiebaClient：账号/房间/消息/发送/图片上传/贴表情/撤回/机器人发言
 ├── blcp.js               BLCP 协议层（帧/握手/心跳/join/method185/method214）
 ├── protobuf.js / crypto.js / protocol.js   协议与加密（含撤回权限/图片上传/表情解析）
 ├── panel.html/css/js     side panel UI（聊天/图片/收藏表情/贴表情/撤回/机器人日志）
 ├── message-view.js / media.js / reactions.js / runtime-info.js   渲染与辅助
 ├── bot.js / keyword.js / bilibili.js / storage.js   机器人逻辑与存储
 ├── settings.html/js/css  设置页（机器人开关/昵称/BDUSS/B站UID/房间/违禁词/管理员/订阅）
 └── content.js            贴吧网页「频道聊天」悬浮按钮
```

## 安装与运行

### 1. 启动本地代理

BLCP 协议是裸 TCP+TLS，扩展需经本地代理转发。完整版与精简版都依赖它。

```bash
cd proxy
node proxy.js
# 或直接双击 dist/tieba-proxy.exe（免装 Node）
```

### 2. 加载扩展

1. Chrome/Edge 打开 `chrome://extensions`，开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录（`tieba-extension/`）
3. 登录 `tieba.baidu.com`
4. 点工具栏图标打开侧边栏 → 输吧名 → 选频道 → 收发消息

### 3. 启用机器人

- 右键插件图标 → 选项，勾选「启用机器人」、配置昵称 / 独立 BDUSS（可选）/ B站 UID / 违禁词 / 管理员
- 进入频道后点房间标题旁「添加到机器人」
- 聊天室内 `@机器人昵称 /help` 查看命令

## 来源与致谢

- **0.2.5 基线**：朋友的 GitHub 仓库（图片发送、贴表情、表情回应、撤回、版本握手等）
- **原版扩展**：Lotus / [Lostlitus/chrome-tieba-channel-extension](https://github.com/Lostlitus/chrome-tieba-channel-extension)
- **BLCP 协议与加密**：参考 [aiotieba](https://github.com/Starry-OvO/aiotieba)
- **机器人逻辑**：移植自 `py-bot/tieba_bot`

第三方组件与素材说明见朋友的 `THIRD_PARTY_NOTICES.md`。

## 测试

```bash
node diag.mjs                 # parseMessage 消息解析 11 项
node test/crypto_test.mjs     # crc32/xxHash32/base32 标准向量
node test/md5_test.mjs        # MD5 标准向量
node test/cuid_test.mjs       # cuid_galaxy2/c3_aid 结构
node test/blcp_body_test.mjs  # BLCP method185 请求体结构
node test/frame_test.mjs      # BLCP 帧格式
```
