/** Immutable v4 renderer: recognizes installed bytes for migration only. */
/** A self-contained expression evaluated inside extension activation, never by the installer. */
export function renderApprovalControl(directory?: string): string {
  return `(() => {
    const net = __webpack_require__(777030), fs = __webpack_require__(973024);
    const path = __webpack_require__(176760), crypto = __webpack_require__(977598);
    const entries = new Map(), byTool = new WeakMap(), settled = new Map(), sockets = new Set();
    const windowId = crypto.randomUUID();
    const directory = ${directory ? JSON.stringify(directory) : '"/tmp/ahs-codebuddy-" + process.getuid()'};
    const socketPath = path.join(directory, process.pid + "-" + windowId.slice(0, 8) + ".sock");
    const manifestPath = socketPath + ".json";
    let closed = false, server, timer, enabled = true;
    const failure = (code, message) => Object.assign(new Error(message), { code });
    const valid = entry => entry.tool.state === pending &&
      entry.tool.confirmRequestedAt === entry.stamp && !entry.manager.abortSignal?.aborted &&
      Date.now() < entry.public.expires_at;
    const prune = () => { for (const [id, entry] of entries) if (!valid(entry)) entries.delete(id); };
    const remember = (id, result) => {
      settled.set(id, result);
      if (settled.size > 256) settled.delete(settled.keys().next().value);
    };
    const forget = tool => {
      const id = byTool.get(tool);
      if (id) entries.delete(id);
      byTool.delete(tool);
    };
    const register = info => {
      if (closed || !enabled || info.tool.state !== pending) return;
      prune();
      const previous = byTool.get(info.tool), existing = entries.get(previous);
      if (existing && valid(existing)) return existing.public;
      if (previous) entries.delete(previous);
      let input = {};
      try { input = JSON.parse(JSON.stringify(info.tool.getArgs?.() || {})); } catch {}
      const id = crypto.randomUUID(), stamp = info.tool.confirmRequestedAt;
      const value = {
        request_id: id, session_id: info.sessionId, tool_call_id: info.callId,
        tool_name: info.tool.name, tool_input: input, cwd: info.cwd || "",
        subagent: info.subagent, reason: info.tool.safetyConfirmMessage || info.tool.hookConfirmMessage || "",
        created_at: Date.now(), expires_at: Date.now() + 30 * 60 * 1000,
        approval_channel: { protocol: 1, transport: "unix", socket_path: socketPath, window_id: windowId },
      };
      entries.set(id, { ...info, stamp, public: value });
      byTool.set(info.tool, id);
      return value;
    };
    const respond = async request => {
      if (!["allow", "reject", "skip"].includes(request.action)) throw failure("INVALID_ACTION", "Expected allow, reject or skip");
      if (typeof request.request_id !== "string") throw failure("INVALID_REQUEST", "request_id is required");
      prune();
      if (settled.has(request.request_id)) throw failure("ALREADY_RESOLVED", "This confirmation was already submitted");
      const entry = entries.get(request.request_id);
      if (!entry || !valid(entry)) throw failure("NOT_PENDING", "Confirmation expired or was answered elsewhere");
      const { listener, manager, callId, tool, subagent, sessionId } = entry;
      let apply;
      const acp = !subagent && !tool.safetyConfirmMessage ? listener.getAcpAgentForSession?.(sessionId) : undefined;
      if (acp) {
        // onUserConfirmRequired first persists recovery data. Never bypass ACP during that await.
        if (!acp._pendingPermissionRequests?.has(callId)) throw failure("NOT_READY", "ACP approval is not ready; retry this request");
        apply = () => acp.respondToPermission(callId, request.action === "allow", false, request.action === "skip");
      } else if (!subagent) {
        const currentManager = listener.contextManager?.getContext(sessionId)?.agent?.getToolManager?.();
        if (currentManager !== manager) throw failure("TARGET_CHANGED", "Session no longer owns this tool manager");
        if (manager.getInstance?.(callId) !== tool) throw failure("UNSUPPORTED_TARGET", "Use the app UI for this detached confirmation");
        const service = container.get(__webpack_require__(637830).ToolService);
        const method = { allow: "execute", reject: "cancel", skip: "ignore" }[request.action];
        // Use the same UI service, which restores session state and persists tool status.
        if (manager.getConfirmTarget?.(callId) !== tool) throw failure("TARGET_CHANGED", "Tool manager no longer owns this confirmation");
        apply = () => service[method](callId, sessionId);
      } else {
        // The app's SubagentManager broadcasts by ID; use the captured manager instead.
        if (manager.getConfirmTarget?.(callId) !== tool) throw failure("TARGET_CHANGED", "Subagent manager no longer owns this confirmation");
        if (request.action === "skip") {
          if (manager.getInstance?.(callId) !== tool) throw failure("UNSUPPORTED_TARGET", "Skip is unavailable for this detached target");
          apply = () => manager.skipToolExecution(callId, "User skipped this step. Continue with the next steps.");
        } else apply = () => manager.confirmToolExecution(callId, request.action === "allow", "User rejected");
      }
      // Consume before calling app code: UI events may synchronously re-enter the listeners.
      entries.delete(request.request_id);
      remember(request.request_id, request.action);
      await apply();
      return { status: "submitted", request_id: request.request_id, action: request.action };
    };
    const dispatch = async request => {
      if (closed) throw failure("CLOSED", "Approval channel is closed");
      if (!request || request.protocol !== 1) throw failure("PROTOCOL", "Expected protocol 1");
      if (request.op === "list") {
        prune();
        return { window_id: windowId, requests: [...entries.values()].map(entry => entry.public) };
      }
      if (request.op === "respond") return respond(request);
      throw failure("INVALID_OPERATION", "Expected list or respond");
    };
    const dispose = () => {
      if (closed) return;
      closed = true;
      entries.clear();
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      if (server) server.close();
      try { fs.unlinkSync(manifestPath); } catch (error) { if (error.code !== "ENOENT") report(error); }
    };
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Approval directory must be owned by the current user");
      fs.chmodSync(directory, 0o700);
      server = net.createServer(socket => {
        if (closed || sockets.size >= 32) return socket.destroy();
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.setTimeout(5000, () => socket.destroy());
        let buffer = "", bytes = 0, handled = false;
        socket.setEncoding("utf8");
        socket.on("data", chunk => {
          if (handled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 65536) { handled = true; socket.end(JSON.stringify({ protocol: 1, ok: false, error: { code: "TOO_LARGE" } }) + "\\n"); return; }
          buffer += chunk;
          const at = buffer.indexOf("\\n");
          if (at < 0) return;
          handled = true;
          Promise.resolve().then(() => {
            if (buffer.slice(at + 1).trim()) throw failure("INVALID_REQUEST", "One command per connection");
            return dispatch(JSON.parse(buffer.slice(0, at)));
          }).then(result => socket.end(JSON.stringify({ protocol: 1, ok: true, ...result }) + "\\n"),
            error => socket.end(JSON.stringify({ protocol: 1, ok: false, error: { code: error.code || "FAILED", message: error.message } }) + "\\n"));
        });
      });
      server.on("error", error => { enabled = false; report(error); });
      server.listen(socketPath, () => {
        if (closed) { server.close(); return; }
        try {
          fs.chmodSync(socketPath, 0o600);
          fs.writeFileSync(manifestPath, JSON.stringify({ protocol: 1, window_id: windowId, socket_path: socketPath, pid: process.pid }), { mode: 0o600, flag: "wx" });
        } catch (error) { enabled = false; dispose(); report(error); }
      });
      server.unref();
      timer = setInterval(prune, 10000);
      timer.unref?.();
    } catch (error) { enabled = false; dispose(); report(error); }
    return { register, forget, dispose };
  })()`;
}
