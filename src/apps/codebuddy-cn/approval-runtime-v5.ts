/** Immutable v5 renderer for installed-resource recognition only. */
import { renderApprovalControl } from "./approval-control-runtime-v5";
import { renderApprovalIdentity } from "./approval-identity-v5";

/** Runs in the existing extension activation scope, alongside the focus bridge. */
export function renderApprovalHookV5(options: { control?: boolean; directory?: string } = {}): string {
  return `;{
  let disposed = false, control;
  const undo = [], waiting = new WeakMap();
  const report = error => { try { console.error("[App Hook Studio: permission_prompt]", error); } catch {} };
  const dispose = () => {
    disposed = true;
    control?.dispose();
    for (const restore of undo.splice(0).reverse()) restore();
  };
  try {
    const main = __webpack_require__(73280).ToolManagerListener.prototype;
    const sub = __webpack_require__(748749).SubagentToolListener.prototype;
    const protocol = __webpack_require__(946785);
    const NotificationManager = __webpack_require__(176998).NotificationManager;
    const pending = __webpack_require__(445368).ToolState.PENDING;
    const identify = ${renderApprovalIdentity()};
    control = ${options.control === false ? "undefined" : renderApprovalControl(options.directory)};
    const notify = (listener, manager, callId, tool, subagent) => {
      if (disposed || tool.state !== pending) return;
      // Forwarded approvals carry a parent task instance; the subagent listener owns that event.
      if (!subagent && tool.id !== callId && manager.getConfirmTarget?.(callId) !== tool) return;
      const stamp = tool.confirmRequestedAt;
      if (waiting.has(tool) && waiting.get(tool) === stamp) return;
      waiting.set(tool, stamp);
      const context = manager.getContext?.() || {};
      const candidates = [[manager.sessionId, "manager.sessionId"], [context.conversationId, "manager.context.conversationId"],
        [listener.conversationId, "listener.conversationId"], [listener.taskTool?.context?.conversationId, "listener.taskTool.context.conversationId"]];
      const [sessionId, sessionSource] = candidates.find(([value]) => typeof value === "string" && value.length) || [];
      if (!sessionId) throw new Error("Missing approval session ID");
      const agent = listener.contextManager?.getContext(sessionId)?.agent;
      const cwd = context.workingDirectory || agent?.getUserContext?.()?.env?.workspace;
      const cwdSource = context.workingDirectory ? "tool-context" : cwd ? "agent-user-context" : "unknown";
      const identity = identify({ listener, manager, sessionId, sessionSource, subagent, cwdSource });
      // Never substitute the extension host's process.cwd() for the user's workspace.
      const request = control?.register({ listener, manager, callId, tool, subagent, sessionId, cwd, identity });
      const hookManager = manager.toolHookExecutor?.hookManager || container.get(protocol.HookManager);
      let transcript = manager.transcriptPath || "";
      if (!transcript) {
        try { transcript = container.get(__webpack_require__(155735).HistoryService).getTranscriptPathSync(sessionId) || ""; } catch {}
      }
      const message = "Tool " + protocol.normalizeToolName(tool.name) + " requires user approval (" + callId + ")" +
        (tool.safetyConfirmMessage || tool.hookConfirmMessage ? ": " + (tool.safetyConfirmMessage || tool.hookConfirmMessage) : "");
      const extendedManager = { executeHooks: (event, payload) => hookManager.executeHooks(event, {
        ...payload, cwd: cwd || "", identity: request?.identity || identity,
        ...(request ? { request_id: request.request_id, tool_call_id: callId,
          tool_name: protocol.normalizeToolName(tool.name), approval_channel: request.approval_channel } : {}),
      }) };
      const notification = new NotificationManager(extendedManager, undefined, cwd || "");
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
          control?.forget(tool);
          return original.call(this, manager, callId, tool, ...rest);
        });
      }
    }
    ir.subscriptions.push({ dispose });
  } catch (error) { dispose(); report(error); }
}
`;
}
