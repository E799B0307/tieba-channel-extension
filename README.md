# 贴吧频道聊天室

当前主分支使用用户提供的 `tieba-extension` 完整项目，包含频道聊天、图片、收藏表情、贴表情、消息撤回和机器人功能。源码版本为 `0.2.5-local`，保留了提供项目原有的版本号。

2026-10-17 已整体替换插件源码。这个构建与本仓库历史 Releases 中同名版本的内容不同，请以当前 `main` 提交为准，历史安装包尚未同步本次替换。

## 使用

1. 克隆本仓库或下载当前 `main` 的源码。
2. 在 Chrome / Edge 的扩展管理页启用开发者模式，加载 `tieba-extension-lite`。目录名为兼容已有加载路径而保留，里面现在是完整版；已加载此目录的用户重新加载扩展即可。
3. 启动配套 `tieba-proxy.exe`；也可以用 Node.js 运行 `node tieba-extension-lite/proxy/proxy.js`。代理监听本机 `127.0.0.1:8765`。
4. 在贴吧网页版登录账号，打开侧栏并选择频道。机器人配置入口位于侧栏“设置”及扩展选项页。

配套 Windows 代理二进制与提供项目中的文件 SHA-256 一致，未修改，不纳入 Git。现提供项目的代理源码也一并保存在 `tieba-extension-lite/proxy/`，未验证二进制与这份源码的构建对应关系。

完整版使用说明见 [项目说明](tieba-extension-lite/README.md)、[机器人说明](tieba-extension-lite/docs/bot.md) 和 [隐私说明](tieba-extension-lite/privacy.html)。

## 开发与检查

```sh
npm ci
npm test
npx playwright install chromium
npm run test:ui
```

`npm test` 运行提供项目随附的解析、加密、设备标识、BLCP 请求体及帧检查，并检查语法和资源引用。`npm run test:ui` 使用模拟接口检查聊天页、机器人入口和设置页；已有 Chrome 可通过 `CHROME_PATH` 指定可执行文件。

这些检查不登录真实账号，也不发送或撤回频道消息。此前消息未送达的问题需在该基准上重新实测，目前没有确认已修复。

提供项目中的 `build-lite.ps1` 和 `variants/lite/` 一并保留，用于生成纯聊天精简版。生成输出、依赖目录和二进制不纳入 Git。

## 协作

欢迎通过 [Issues](https://github.com/E799B0307/tieba-channel-extension/issues) 反馈问题，或 Fork 后提交 Pull Request。直接维护者由仓库所有者邀请。参见 [贡献说明](CONTRIBUTING.md) 和 [来源说明](THIRD_PARTY_NOTICES.md)。
