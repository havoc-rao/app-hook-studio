/** Additive metadata only: never use these fields to route approval actions. */
export interface ApprovalIdentity {
  schema: 1;
  machine: {
    id: string | null;
    source: "vscode.env.machineId" | "unknown";
    scope: "codebuddy-installation";
    display_name?: string | null;
    display_name_source?: string | null;
  };
  workspace: {
    id: string | null;
    source: "vscode.workspace" | "unknown";
    scope: "host-at-request";
    kind: "folder" | "workspace-file" | "untitled" | "roots" | "empty" | "unknown";
    name: string | null;
    workspace_file: string | null;
    roots: { uri: string; path: string | null; name: string | null }[];
  };
  agent: {
    id: string | null;
    kind: "session" | "subagent";
    source: string;
    session_id: string;
    session_source: string;
    parent_agent_id: string | null;
    parent_session_id: string | null;
    task_tool_call_id: string | null;
  };
  cwd_source: "tool-context" | "agent-user-context" | "unknown";
  session?: {
    id: string;
    title: string | null;
    title_source: string | null;
    title_observed_at: number | null;
  };
  observed_at?: number | null;
  diagnostics?: string[];
}

/** Evaluated in the verified extension host; optional API failures never block approval. */
export function renderApprovalIdentity(): string {
  return `(info => {
    const string = value => typeof value === "string" && value.length ? value : null;
    const display = value => typeof value === "string" && value.trim().length ? value : null;
    const now = () => { const value = Date.now(); return Number.isFinite(value) && value >= 0 ? value : null; };
    const identity = {
      schema: 1,
      machine: { id: null, source: "unknown", scope: "codebuddy-installation" },
      workspace: { id: null, source: "unknown", scope: "host-at-request", kind: "unknown",
        name: null, workspace_file: null, roots: [] },
      agent: { id: null, kind: info.subagent ? "subagent" : "session", source: "unknown",
        session_id: info.sessionId, session_source: info.sessionSource,
        parent_agent_id: null, parent_session_id: null, task_tool_call_id: null },
      cwd_source: info.cwdSource,
      observed_at: now(),
      session: { id: info.sessionId, title: null, title_source: null, title_observed_at: null },
      diagnostics: [],
    };
    try {
      const crypto = __webpack_require__(977598), api = __webpack_require__(426850);
      const hash = (kind, value) => "codebuddy:" + kind + ":" + crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
      // A remote UI's machineId must not be mistaken for the local socket host.
      const nativeId = !api.env.remoteName && string(api.env.machineId);
      if (nativeId) identity.machine = { id: hash("machine", nativeId), source: "vscode.env.machineId", scope: "codebuddy-installation" };
      const workspace = api.workspace;
      const roots = (workspace.workspaceFolders || []).map(folder => ({
        uri: folder.uri.toString(), path: folder.uri.scheme === "file" ? string(folder.uri.fsPath) : null,
        name: string(folder.name),
      }));
      const file = workspace.workspaceFile;
      const uri = file ? file.toString() : null;
      const kind = file ? (file.scheme === "untitled" ? "untitled" : "workspace-file") : roots.length === 1 ? "folder" : roots.length ? "roots" : "empty";
      const key = uri ? [kind, uri] : roots.length ? [kind, roots.map(root => root.uri).sort()] : null;
      identity.workspace = { id: identity.machine.id && key ? hash("workspace", [identity.machine.id, key]) : null,
        source: "vscode.workspace", scope: "host-at-request", kind, name: string(workspace.name), workspace_file: uri, roots };
    } catch {}
    identity.machine.display_name = null;
    identity.machine.display_name_source = null;
    try {
      const api = __webpack_require__(426850);
      if (!api.env.remoteName) {
        const name = display(__webpack_require__(370857).hostname());
        if (name) { identity.machine.display_name = name; identity.machine.display_name_source = "node.os.hostname"; }
      }
    } catch { identity.diagnostics.push("MACHINE_DISPLAY_UNAVAILABLE"); }
    try {
      const service = container.get(__webpack_require__(302351).ConversationManagerToken);
      // Same in-memory map used by native getConversation(id); do not query the focused session.
      const metadata = service.initialized === true ? service.conversationMap?.get(info.sessionId) : undefined;
      if (metadata && metadata.id !== info.sessionId) identity.diagnostics.push("SESSION_METADATA_ID_MISMATCH");
      else if (metadata) {
        const title = display(metadata.name);
        if (title) {
          identity.session.title = title;
          identity.session.title_source = "ConversationManager.conversationMap.name";
          identity.session.title_observed_at = now();
        }
      } else identity.diagnostics.push("SESSION_METADATA_UNAVAILABLE");
    } catch { identity.diagnostics.push("SESSION_METADATA_UNAVAILABLE"); }
    try {
      if (info.subagent) {
        const task = info.listener.taskTool;
        const taskId = string(task?.id), agentId = string(info.manager.agentId);
        identity.agent.task_tool_call_id = taskId;
        // Native HookableToolManager.setAgentInfo(name, TaskTool.id).
        identity.agent.id = agentId || taskId;
        identity.agent.source = agentId ? "manager.agentId" : taskId ? "listener.taskTool.id" : "unknown";
        identity.agent.parent_session_id = string(task?.context?.conversationId);
        // Nested tasks share a conversation; parent session is not necessarily parent agent.
      } else {
        identity.agent.id = info.sessionId;
        identity.agent.source = info.sessionSource;
      }
    } catch {}
    return identity;
  })`;
}
