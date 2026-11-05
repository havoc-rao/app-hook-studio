import Ajv from "ajv";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import vm from "node:vm";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { renderApprovalIdentity, ApprovalIdentity } from "../src/apps/codebuddy-cn/approval-identity";

const uri = (value: string) => ({ scheme: "file", fsPath: value, toString: () => pathToFileURL(value).href });
function fixture(machine: string | null = "pc-a", roots = ["/work/demo"]) {
  const api = {
    env: { machineId: machine, remoteName: undefined as string | undefined },
    workspace: {
      name: "demo",
      workspaceFile: undefined as ReturnType<typeof uri> | undefined,
      workspaceFolders: roots.map((value) => ({ name: "demo", uri: uri(value) })),
    },
  };
  const identify: (info: unknown) => ApprovalIdentity = vm.runInNewContext(renderApprovalIdentity(), {
    __webpack_require__: (id: number) => (id === 977598 ? crypto : api),
  });
  const info = (session = "session-a", task?: string) => ({
    sessionId: session,
    sessionSource: "manager.sessionId",
    subagent: !!task,
    cwdSource: "tool-context",
    manager: { agentId: task },
    listener: task ? { taskTool: { id: task, context: { conversationId: session } } } : {},
  });
  return { api, identify, info };
}

test("shared identity fixtures distinguish machines, paths and child agents while grouping windows and sessions", () => {
  const data = JSON.parse(readFileSync("tests/fixtures/codebuddy-identity-v1.json", "utf8"));
  const groups = new Map<string, string>();
  const identities = new Map<string, ApprovalIdentity>();
  for (const item of data.cases) {
    const f = fixture(item.machine, item.roots),
      value = f.identify(f.info(item.session, item.task));
    identities.set(item.name, value);
    assert.equal(value.schema, 1);
    assert.equal(value.agent.id, item.task || item.session);
    assert.equal(value.agent.parent_agent_id, null);
    if (item.task) assert.equal(value.agent.parent_session_id, item.session);
    if (!item.workspace_group) assert.equal(value.workspace.id, null);
    else {
      assert.ok(value.workspace.id);
      if (groups.has(item.workspace_group))
        assert.equal(value.workspace.id, groups.get(item.workspace_group));
      else {
        assert.ok(![...groups.values()].includes(value.workspace.id));
        groups.set(item.workspace_group, value.workspace.id);
      }
    }
  }
  assert.notEqual(identities.get("child-a")!.agent.id, identities.get("child-b")!.agent.id);
});

test("workspace snapshot remains unchanged after switching roots; tool cwd does not select host workspace", () => {
  const f = fixture();
  const first = f.identify({ ...f.info(), cwd: "/unrelated/tool/cwd" });
  f.api.workspace.workspaceFolders[0].uri = uri("/work/new");
  const next = f.identify(f.info());
  assert.equal(first.workspace.roots[0].path, "/work/demo");
  assert.notEqual(first.workspace.id, next.workspace.id);
  assert.equal(first.workspace.scope, "host-at-request");
});

test("saved and untitled multi-root workspace identity uses its URI, retaining all roots", () => {
  const f = fixture("pc-a", ["/work/a", "/work/b"]);
  f.api.workspace.workspaceFile = uri("/work/team.code-workspace");
  const saved = f.identify(f.info());
  f.api.workspace.workspaceFolders.reverse();
  assert.equal(f.identify(f.info()).workspace.id, saved.workspace.id);
  assert.equal(saved.workspace.kind, "workspace-file");
  assert.equal(saved.workspace.roots.length, 2);
  f.api.workspace.workspaceFile = { scheme: "untitled", fsPath: "", toString: () => "untitled:123" };
  assert.equal(f.identify(f.info()).workspace.kind, "untitled");
});

test("URI identity preserves case and symbolic path spelling; remote and unavailable APIs yield unknown", () => {
  const lower = fixture("pc-a", ["/work/demo"]),
    upper = fixture("pc-a", ["/work/Demo"]);
  assert.notEqual(lower.identify(lower.info()).workspace.id, upper.identify(upper.info()).workspace.id);
  lower.api.env.remoteName = "ssh-remote";
  assert.equal(lower.identify(lower.info()).machine.id, null);
  const identify = vm.runInNewContext(renderApprovalIdentity(), {
    __webpack_require__: () => {
      throw new Error("missing API");
    },
  });
  assert.equal(identify(lower.info()).workspace.source, "unknown");
  assert.equal(identify(lower.info()).agent.id, "session-a");
});

test("display fixtures read native metadata by ID; rename snapshots and invalid clocks remain honest", () => {
  const samples = JSON.parse(readFileSync("tests/fixtures/codebuddy-display-v1.json", "utf8"));
  const f = fixture();
  const service = { initialized: true, conversationMap: new Map<string, unknown>() };
  const token = Symbol("ConversationManager");
  let time = 1234;
  const identify = vm.runInNewContext(renderApprovalIdentity(), {
    Date: { now: () => time },
    container: {
      get: (value: unknown) => {
        assert.equal(value, token);
        return service;
      },
    },
    __webpack_require__: (id: number) => {
      if (id === 977598) return crypto;
      if (id === 426850) return f.api;
      if (id === 370857) return { hostname: () => "Fixture Mac" };
      if (id === 302351) return { ConversationManagerToken: token };
      throw new Error("Unexpected module");
    },
  });
  const snapshots = [];
  for (const sample of samples.cases) {
    service.conversationMap.set(sample.session, sample.metadata);
    const value: ApprovalIdentity = identify(f.info(sample.session));
    assert.equal(value.session?.id, value.agent.session_id);
    assert.equal(value.session?.title, sample.title);
    assert.equal(value.machine.display_name, "Fixture Mac");
    assert.equal(value.observed_at, 1234);
    assert.equal(value.session?.title_observed_at, sample.title ? 1234 : null);
    if (sample.diagnostic) assert.ok(value.diagnostics?.includes(sample.diagnostic));
    snapshots.push(value);
  }
  assert.equal(snapshots[0].session?.title, "修复登录");
  for (const invalid of [-1, NaN, Infinity]) {
    time = invalid;
    service.conversationMap.set("s-a", { id: "s-a", name: "valid title" });
    assert.equal(identify(f.info("s-a")).observed_at, null);
    assert.equal(identify(f.info("s-a")).session.title_observed_at, null);
  }
  f.api.env.remoteName = "ssh-remote";
  assert.equal(identify(f.info()).machine.display_name, null);
});

test("identity JSON schema accepts v5 and v6 and rejects invalid timestamps", async () => {
  const validate = new Ajv().compile(
    JSON.parse(readFileSync("schemas/codebuddy-identity-v1.schema.json", "utf8")),
  );
  const f = fixture(),
    value = f.identify(f.info());
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  const legacy = JSON.parse(JSON.stringify(value));
  delete legacy.session;
  delete legacy.observed_at;
  delete legacy.diagnostics;
  delete legacy.machine.display_name;
  delete legacy.machine.display_name_source;
  assert.equal(validate(legacy), true);
  assert.equal(validate({ ...value, observed_at: -1 }), false);
  assert.equal(validate({ ...value, schema: 2 }), false);
});
