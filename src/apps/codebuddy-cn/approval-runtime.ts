/** Runs in the existing extension activation scope, alongside the focus bridge. */
export function renderApprovalHook(): string {
  return `;{
  let disposed = false;
  const undo = [], waiting = new WeakMap();
  const report = error => { try { console.error("[App Hook Studio: permission_prompt]", error); } catch {} };
  const dispose = () => {
    disposed = true;
    for (const restore of undo.splice(0).reverse()) restore();
  };
  try {
    const main = __webpack_require__(73280).ToolManagerListener.prototype;
    const sub = __webpack_require__(748749).SubagentToolListener.prototype;
    const protocol = __webpack_require__(946785);
    const NotificationManager = __webpack_require__(176998).NotificationManager;
    const pending = __webpack_require__(445368).ToolState.PENDING;
    const notify = (listener, manager, callId, tool, subagent) => {
      if (disposed || tool.state !== pending) return;
      // Forwarded approvals carry a parent task instance; the subagent listener owns that event.
      if (!subagent && tool.id !== callId) return;
      const stamp = tool.confirmRequestedAt;
      if (waiting.has(tool) && waiting.get(tool) === stamp) return;
      waiting.set(tool, stamp);
      const context = manager.getContext?.() || {};
      const sessionId = manager.sessionId || context.conversationId || listener.conversationId || listener.taskTool?.getConversationId?.();
      if (!sessionId) throw new Error("Missing approval session ID");
      const agent = listener.contextManager?.getContext(sessionId)?.agent;
      const cwd = context.workingDirectory || agent?.getUserContext?.()?.env?.workspace;
      // Never substitute the extension host's process.cwd() for the user's workspace.
      if (!cwd) throw new Error("Missing approval workspace");
      const hookManager = manager.toolHookExecutor?.hookManager || container.get(protocol.HookManager);
      let transcript = manager.transcriptPath || "";
      if (!transcript) {
        try { transcript = container.get(__webpack_require__(155735).HistoryService).getTranscriptPathSync(sessionId) || ""; } catch {}
      }
      const message = "Tool " + protocol.normalizeToolName(tool.name) + " requires user approval (" + callId + ")" +
        (tool.safetyConfirmMessage || tool.hookConfirmMessage ? ": " + (tool.safetyConfirmMessage || tool.hookConfirmMessage) : "");
      const notification = new NotificationManager(hookManager, undefined, cwd);
      // Snapshot per-manager context before asynchronous execution; no singleton session state.
      const args = [message, sessionId, transcript, manager.generationId || agent?.requestId,
        manager.model || listener.modelId || agent?.getModel?.()?.id, manager.client, manager.version];
      Promise.resolve().then(() => {
        if (!disposed) return notification.notifyPermissionPrompt(...args);
      }).catch(report);
    };
    const wrap = (prototype, name, factory) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const original = prototype[name];
      if (typeof original !== "function") throw new Error("Missing listener method: " + name);
      const wrapped = factory(original);
      prototype[name] = wrapped;
      undo.push(() => {
        if (prototype[name] !== wrapped) return;
        if (descriptor) Object.defineProperty(prototype, name, descriptor);
        else delete prototype[name];
      });
    };
    for (const [prototype, subagent] of [[main, false], [sub, true]]) {
      wrap(prototype, "onUserConfirmRequired", original => function(manager, callId, tool, ...rest) {
        const result = original.call(this, manager, callId, tool, ...rest);
        try { notify(this, manager, callId, tool, subagent); } catch (error) { report(error); }
        // Preserve the original return value, promise identity, and approval behavior.
        return result;
      });
      for (const name of ["onToolExecutionStart", "onToolExecutionComplete"]) {
        wrap(prototype, name, original => function(manager, callId, tool, ...rest) {
          waiting.delete(tool);
          return original.call(this, manager, callId, tool, ...rest);
        });
      }
    }
    ir.subscriptions.push({ dispose });
  } catch (error) { dispose(); report(error); }
}
`;
}
