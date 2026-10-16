# 贴吧频道聊天室

在 Chrome / Edge 侧边栏里使用贴吧频道的非官方扩展，支持文字、回复、@、贴表情、查看贴表情的人、图片和收藏表情，以及按频道权限撤回消息。

当前开发版本：`0.2.7-local`。已收到真实反馈：0.2.6 返回发送回执，但网页、手机和其他成员均看不到消息，实际发送问题尚未解决。0.2.7 新增脱敏发送诊断，不代表已恢复送达；本地自动测试使用模拟数据。

## 下载使用

下载 [发布页](https://github.com/E799B0307/tieba-channel-extension/releases) 中标有版本号的 `tieba-channel-extension-*-windows.zip`，解压到固定目录。开发分支可能先于安装包更新，请以侧栏底部版本为准。不要把 GitHub 的 `Source code.zip` 当作完整安装包，它不含配套代理。

1. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中解压后的 `tieba-extension-lite` 文件夹。
2. 启动同一目录下的 `tieba-proxy.exe`，保持它运行。代理使用本机 `127.0.0.1:8765`，消息发送需要它。
3. 在 [贴吧网页版](https://tieba.baidu.com/) 登录自己的账号，点击扩展图标，在侧边栏选择贴吧和频道。

代理是原配套 Windows 二进制，本仓库没有它的源码，也未修改它。发布页提供 SHA-256 校验文件；它未附代码签名，请自行确认来源可信，不要授予不必要的管理员权限。

账号凭据不随安装包分发。每位使用者登录自己的贴吧账号，不需要向维护者提供密码、BDUSS 或 Cookie。详见 [隐私说明](tieba-extension-lite/privacy.html) 和 [详细使用说明](tieba-extension-lite/README.md)。

## 发送诊断

使用 0.2.7 重新加载扩展并打开侧栏后，手动发送一条普通文字。若等待 30 秒仍未送达，点击右上角“下载发送诊断”图标，将 `tieba-send-diagnostics.json` 附在问题反馈中。下载前不要再次重新加载扩展，否则内存记录会清空。

诊断只保留最近 20 条登录、入频道和发送响应的字段类型、数字状态码、发送回执 ID，以及最近一次历史读取的数量和命中情况。不导出聊天正文、服务端提示原文、用户资料、登录凭据或设备标识，不自动上传，也不重发消息。

## 一起开发

- 反馈问题：[Issues](https://github.com/E799B0307/tieba-channel-extension/issues)。请附插件版本、复现步骤和脱敏截图，不要上传 Cookie、Token 或完整私人聊天记录。
- 提交修改：Fork 仓库，新建分支，提交 Pull Request 到 `main`，说明改动和测试结果。
- 直接参与维护：由仓库所有者按具体 GitHub 账号邀请 Collaborator。公开仓库不会让所有人直接覆盖主分支。

参见 [贡献说明](CONTRIBUTING.md)。

## 本地开发

需要 Node.js 22 或更高版本。扩展本身是原生 JavaScript，不需要打包或启动开发服务器。

```sh
git clone https://github.com/E799B0307/tieba-channel-extension.git
cd tieba-channel-extension
npm ci
npm test
npx playwright install chromium
npm run test:ui
```

浏览器开发模式加载 `tieba-extension-lite`，修改后重新加载扩展并重新打开侧边栏。界面测试截图输出到 `artifacts`；测试不会登录真实账号、发送真实消息或撤回别人的消息。

已有 Chrome 可通过环境变量 `CHROME_PATH` 指定完整可执行文件路径，供界面测试使用。手动测试发送功能时，另从 Releases 获取代理。

## 目录

| 路径 | 内容 |
| --- | --- |
| `tieba-extension-lite/` | 扩展代码、图标和隐私说明 |
| `tests/` | 协议单元测试和模拟界面测试 |
| `.github/workflows/test.yml` | 推送与 PR 自动测试 |

## 来源

原版作者为 Lotus，参考项目为 [Lostlitus/chrome-tieba-channel-extension](https://github.com/Lostlitus/chrome-tieba-channel-extension)。本仓库保留来源说明，并整理本地修改供协作维护。第三方组件和素材说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；本次没有新增覆盖第三方代码或素材的统一许可证。
