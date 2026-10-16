# Frida 抓包：获取贴吧「管理员撤回消息」的真实请求

> 目的：逆向贴吧 APP 发起「撤回/删除消息」时客户端发出的真实请求（methodId + 请求体），
> 用于补全扩展的「主动删除」功能。

## 为什么需要 Frida

贴吧 APP 做了 **SSL Pinning（证书锁定）**，普通 Charles 代理抓包会被 APP 拒绝
（表现为 CONNECT 后无响应）。Frida 通过 hook 掉证书校验函数，让 Charles 能解密 HTTPS。

## 环境准备

- 电脑：Windows，已装 **Charles**（抓包工具）
- 模拟器：**MuMu 模拟器** 或 **雷电模拟器**（自带 Root，比真机方便）
- 电脑装 **Frida**（命令行工具 + Python 绑定）

## 详细步骤

### 1. 安装 Frida（电脑端）

```bash
pip install frida-tools
# 验证
frida --version
```

### 2. 模拟器里装贴吧 APP + 登录

1. 打开 MuMu/雷电模拟器
2. 应用商店搜「贴吧」安装
3. 用你的**管理员账号**登录

### 3. 下载与模拟器架构匹配的 frida-server

1. 查模拟器架构（MuMu 一般是 x86_64，雷电可选 x86/arm）：
   - 在模拟器里打开终端/或 adb shell 执行 `uname -m`
2. 去 https://github.com/frida/frida/releases 下载对应架构的 `frida-server-<版本>-android-<架构>.xz`
3. 解压得到 `frida-server`

### 4. 把 frida-server 推入模拟器并启动

```bash
adb push frida-server /data/local/tmp/
adb shell chmod 755 /data/local/tmp/frida-server
adb shell /data/local/tmp/frida-server &
```

### 5. 配置 Charles 抓包

1. Charles 开启 SSL Proxying（Proxy → SSL Proxying Settings → 勾选 Enable，Host/Port 填 `*`）
2. 记下 Charles 监听端口（默认 8888）

### 6. 用 Frida 绕过 SSL Pinning

写一个 frida 脚本（`bypass.js`），hook 掉贴吧的证书校验：

```javascript
// bypass.js
Java.perform(function () {
  // 常见 SSL Pinning 绕过：hook TrustManager / OkHttp / 自实现校验
  var TrustManager = Java.use('javax.net.ssl.X509TrustManager');
  var SSLContext = Java.use('javax.net.ssl.SSLContext');
  // ... （完整脚本见 frida 官方 ssl-pinning-bypass 仓库）
});
```

更省事的方式：直接用社区现成的 bypass 脚本：

```bash
frida -U -f com.baidu.tieba -l ssl_pinning_bypass.js --no-pause
```

> 现成脚本可搜「frida ssl-pinning-bypass github」，或用
> `frida-tools` 自带的 `frida --codeshare` 里的 `okhttp_pinning_bypass`。

### 7. 模拟器配代理指向 Charles

模拟器 WiFi/网络设置 → 代理 → 手动 → 主机填电脑局域网 IP，端口 8888。

### 8. 触发撤回并抓包

1. 在模拟器贴吧 APP 里，进频道，长按一条消息 → 撤回/删除
2. 看 Charles：关注 `pim.baidu.com` 和 `common.lcs.baidu.com` 的请求
3. 找撤回那一刻发出的请求（重点看 method 字段、URL 里的 method/op 参数、POST body）

### 9. 导出请求给我

右键请求 → 查看 Overview / Contents，导出：
1. **完整 URL**
2. **请求方法 + 关键请求头**（BDUSS 可打码）
3. **POST 请求体**（最关键的 methodId/op_code/msgid 等字段）

拿到后发我，我照着实现扩展的删除功能。

---

## 备选：如果不想折腾模拟器

另一个更轻量的方案：**用 Root 过的安卓真机** + **JustTrustMe**（Xposed 模块）绕过 Pinning，
流程类似但不需要模拟器。但模拟器整体更可控、更推荐。

## 参考

- Frida 官方文档：https://frida.re/docs/
- SSL Pinning bypass 脚本：https://github.com/httptoolkit/frida-android-unpinning
- HTTP Toolkit（一体化抓包工具，内置 Frida 拦截，对小白更友好）：https://httptoolkit.com
