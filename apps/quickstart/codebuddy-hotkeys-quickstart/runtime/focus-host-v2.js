/* APP_HOOK_STUDIO_FOCUS_HOST v2 */
;{
  const api = __webpack_require__(426850);
  const providerToken = __webpack_require__(328150).ActivityBarChatWebviewProvider;
  const chatViewToken = __webpack_require__(637830).ChatViewService;
  let disposed = false, sequence = 0, active, stage = "命令初始化";
  const pending = new Set();
  ir.subscriptions.push({ dispose() { disposed = true; for (const cancel of [...pending]) cancel(); } });
  ir.subscriptions.push(api.commands.registerCommand("app-hook-studio.codebuddy.focusInput", () => {
    if (active) return active;
    active = (async () => {
      if (disposed) throw new Error("Focus command disposed");
      stage = "检查服务导出";
      if (typeof providerToken !== "symbol" || typeof chatViewToken !== "symbol") throw new Error("Bridge contract mismatch: missing provider or ChatViewService Symbol");
      stage = "聚焦聊天视图";
      await api.commands.executeCommand("coding-copilot.webviews.chat.focus");
      if (disposed) throw new Error("Focus command disposed");
      stage = "等待聊天桥接";
      const provider = container.get(providerToken);
      await provider.getChatService().waitWebviewReady();
      if (disposed) throw new Error("Focus command disposed");
      await provider.ensureRpc();
      if (disposed) throw new Error("Focus command disposed");
      if (!provider.rpc || !provider.webview) throw new Error("CodeBuddy chat bridge is not ready");
      stage = "激活当前聊天页面";
      await provider.rpc.getProxy(chatViewToken).activatePage({ path: "/" });
      if (disposed) throw new Error("Focus command disposed");
      const webview = provider.webview, requestId = Date.now() + ":" + (++sequence);
      if (!webview) throw new Error("CodeBuddy chat Webview is unavailable");
      stage = "确认输入框焦点";
      await new Promise((resolve, reject) => {
        let finished = false, retry, deadline, subscription;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          clearInterval(retry); clearTimeout(deadline);
          if (subscription) subscription.dispose();
          pending.delete(cancel);
          error ? reject(error) : resolve();
        };
        const cancel = () => finish(new Error("Focus command disposed"));
        pending.add(cancel);
        try {
          subscription = webview.onDidReceiveMessage((message) => {
            if (message && message.type === "app-hook-studio:codebuddy:focus-input-result" && message.requestId === requestId && message.focused === true) finish();
          });
          const send = () => {
            if (finished) return;
            try { Promise.resolve(webview.postMessage({ type: "app-hook-studio:codebuddy:focus-input", requestId })).then((sent) => { if (sent === false) finish(new Error("Chat Webview rejected focus message")); }, finish); }
            catch (error) { finish(error); }
          };
          deadline = setTimeout(() => finish(new Error("Input focus was not confirmed. Reinstall the whole App and restart CodeBuddy.")), 2000);
          retry = setInterval(send, 100);
          send();
        } catch (error) { finish(error); }
      });
    })().catch((error) => {
      // runCommands already reports rejected commands through the IDE notification service.
      throw new Error("App Hook Studio [" + stage + "]: " + (error instanceof Error ? error.message : String(error)));
    }).finally(() => { active = undefined; });
    return active;
  }));
}
/* APP_HOOK_STUDIO_FOCUS_HOST_END */
