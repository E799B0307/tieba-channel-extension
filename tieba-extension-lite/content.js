(() => {
  if (document.getElementById("tieba-channel-extension")) return;
  const host = document.createElement("div");
  host.id = "tieba-channel-extension";
  host.style.cssText = "position:fixed;right:20px;bottom:100px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    button{display:flex;align-items:center;gap:8px;border:0;border-radius:24px;padding:13px 19px;
      background:#2563eb;color:white;box-shadow:0 5px 20px #173c7833;cursor:pointer;
      font:600 14px/1.4 system-ui,"Microsoft YaHei",sans-serif}
    button:hover{background:#1d4ed8}button:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}
    p{max-width:230px;background:#fff;color:#334155;border-radius:10px;padding:10px;
      box-shadow:0 2px 12px #173c7822;font:13px/1.5 system-ui}
  `;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "💬 频道聊天";
  button.title = "打开贴吧频道聊天室";
  const notice = document.createElement("p");
  notice.hidden = true;
  shadow.append(style, notice, button);
  document.documentElement.append(host);
  button.addEventListener("click", async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: "open-chat" });
      if (!result?.ok) throw new Error(result?.error || "请点击插件图标打开聊天室");
      notice.hidden = true;
    } catch (error) {
      notice.textContent = error.message.includes("invalidated") ? "插件已更新，请刷新贴吧页面" : error.message;
      notice.hidden = false;
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "page-context") return;
    const forumLink = document.querySelector('a.card_title_fname, a.card_title_fname_in, .nav_list a[href*="/f?kw="], .head_content a[href*="/f?kw="]');
    let name = new URL(location.href).searchParams.get("kw") || "";
    if (!name && forumLink) {
      try { name = new URL(forumLink.href, location.href).searchParams.get("kw") || ""; } catch {}
    }
    sendResponse({ name: name.trim().slice(0, 100) });
  });
})();
