import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import vm from "node:vm";
import { renderApprovalControl } from "../src/apps/codebuddy-cn/approval-control-runtime";
import {
  approvalRequest,
  listPendingApprovals,
  respondToApproval,
  PendingApproval,
  ApprovalAction,
} from "../src/apps/codebuddy-cn/approval-client";

type Control = { register(info: unknown): PendingApproval; forget(tool: object): void; dispose(): void };
async function fixture(directory?: string) {
  const root = directory ?? (await fs.mkdtemp("/private/tmp/ahs-control-test-"));
  const errors: unknown[] = [],
    actions: unknown[][] = [];
  const token = Symbol("ToolService");
  const service = Object.fromEntries(
    ["execute", "cancel", "ignore"].map((method) => [
      method,
      (id: string, session: string) => {
        actions.push([method, id, session]);
      },
    ]),
  );
  const control: Control = vm.runInNewContext(renderApprovalControl(root), {
    pending: "pending",
    report: (error: unknown) => errors.push(error),
    process,
    Buffer,
    setInterval,
    clearInterval,
    container: {
      get: (value: unknown) => {
        assert.equal(value, token);
        return service;
      },
    },
    __webpack_require__(id: number) {
      switch (id) {
        case 777030:
          return net;
        case 973024:
          return require("node:fs");
        case 176760:
          return path;
        case 977598:
          return crypto;
        case 637830:
          return { ToolService: token };
        default:
          throw new Error(`Unexpected module ${id}`);
      }
    },
  });
  for (let i = 0; i < 100; i++) {
    const current = await listPendingApprovals(root);
    if (current.windows.length) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(errors.length, 0);
  const tool = {
    id: crypto.randomUUID(),
    name: "execute_command",
    state: "pending",
    confirmRequestedAt: 10,
    safetyConfirmMessage: "Safety asks",
    getArgs: () => ({ command: "echo demo" }),
  };
  const abort = new AbortController();
  const manager = {
    abortSignal: abort.signal,
    getConfirmTarget: (id: string) => (id === tool.id ? tool : undefined),
    getInstance: (id: string) => (id === tool.id ? tool : undefined),
    confirmToolExecution: (id: string, approved: boolean, reason: string) => {
      actions.push(["confirm", id, approved, reason]);
      tool.state = approved ? "executing" : "cancelled";
    },
    skipToolExecution: (id: string, reason: string) => {
      actions.push(["skip", id, reason]);
      tool.state = "skipped";
    },
  };
  const listener: {
    getAcpAgentForSession?: (session: string) => unknown;
    contextManager: { getContext: (session: string) => { agent: { getToolManager(): typeof manager } } };
  } = { contextManager: { getContext: () => ({ agent: { getToolManager: () => manager } }) } };
  const register = (subagent = false, session = "session-a") =>
    control.register({
      listener,
      manager,
      callId: tool.id,
      tool,
      subagent,
      sessionId: session,
      cwd: "/workspace/demo",
    });
  return {
    root,
    control,
    tool,
    manager,
    listener,
    register,
    actions,
    errors,
    abort,
    async close() {
      control.dispose();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("private real Unix socket discovers requests and dispatches all three safety actions through UI services", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  for (const [action, method] of [
    ["allow", "execute"],
    ["reject", "cancel"],
    ["skip", "ignore"],
  ] as const) {
    f.tool.confirmRequestedAt++;
    const request = f.register();
    assert.equal(f.register().request_id, request.request_id);
    assert.equal((await fs.stat(f.root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(request.approval_channel.socket_path)).mode & 0o777, 0o600);
    const current = await listPendingApprovals(f.root);
    assert.equal(current.requests[0].request_id, request.request_id);
    assert.deepEqual(current.requests[0].tool_input, { command: "echo demo" });
    const result = await respondToApproval(request.request_id, action, f.root);
    assert.equal(result.status, "submitted");
    assert.deepEqual(f.actions.at(-1), [method, f.tool.id, "session-a"]);
    await assert.rejects(
      approvalRequest(request.approval_channel.socket_path, {
        protocol: 1,
        op: "respond",
        request_id: request.request_id,
        action,
      }),
      { code: "ALREADY_RESOLVED" },
    );
    assert.equal((await listPendingApprovals(f.root)).requests.length, 0);
  }
  await f.close();
  assert.equal((await listPendingApprovals(f.root)).windows.length, 0);
});

test("ACP readiness race never bypasses permission wait; allow/reject/skip map to original response flags", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  f.tool.safetyConfirmMessage = "";
  const pending = new Map<string, object>();
  f.listener.getAcpAgentForSession = () => ({
    _pendingPermissionRequests: pending,
    respondToPermission: (...args: unknown[]) => {
      f.actions.push(args);
      pending.delete(f.tool.id);
    },
  });
  for (const action of ["allow", "reject", "skip"] as ApprovalAction[]) {
    f.tool.confirmRequestedAt++;
    const request = f.register();
    await assert.rejects(respondToApproval(request.request_id, action, f.root), { code: "NOT_READY" });
    assert.equal((await listPendingApprovals(f.root)).requests[0].request_id, request.request_id);
    pending.set(f.tool.id, {});
    await respondToApproval(request.request_id, action, f.root);
    assert.deepEqual(f.actions.at(-1), [f.tool.id, action === "allow", false, action === "skip"]);
  }
});

test("subagent decisions use only the captured manager and preserve reject versus skip", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  for (const action of ["allow", "reject", "skip"] as ApprovalAction[]) {
    f.tool.state = "pending";
    f.tool.confirmRequestedAt++;
    const request = f.register(true);
    await respondToApproval(request.request_id, action, f.root);
    assert.equal(f.tool.state, { allow: "executing", reject: "cancelled", skip: "skipped" }[action]);
  }
  assert.deepEqual(
    f.actions.map((args) => args[0]),
    ["confirm", "confirm", "skip"],
  );
});

test("UI decisions, new confirmation rounds, cancellation and invalid actions cannot approve stale tools", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  const first = f.register();
  const send = (id: string, action = "allow") =>
    approvalRequest(first.approval_channel.socket_path, {
      protocol: 1,
      op: "respond",
      request_id: id,
      action,
    });
  await assert.rejects(send(first.request_id, "allow_always"), { code: "INVALID_ACTION" });
  f.tool.confirmRequestedAt++;
  const next = f.register();
  assert.notEqual(next.request_id, first.request_id);
  await assert.rejects(send(first.request_id), { code: "NOT_PENDING" });
  f.tool.state = "executing";
  await assert.rejects(send(next.request_id), { code: "NOT_PENDING" });
  f.tool.state = "pending";
  f.tool.confirmRequestedAt++;
  const cancelled = f.register();
  f.abort.abort();
  await assert.rejects(send(cancelled.request_id), { code: "NOT_PENDING" });
  assert.equal(f.actions.length, 0);
});

test("multiple windows are independently routed and one window closing leaves the other usable", async (t) => {
  const first = await fixture(),
    second = await fixture(first.root);
  t.after(async () => {
    await first.close();
    await second.close();
    await fs.rm(first.root, { recursive: true, force: true });
  });
  const a = first.register(),
    b = second.register(false, "session-b");
  const current = await listPendingApprovals(first.root);
  assert.equal(current.windows.length, 2);
  assert.equal(current.requests.length, 2);
  assert.notEqual(a.approval_channel.window_id, b.approval_channel.window_id);
  await respondToApproval(b.request_id, "allow", first.root);
  assert.equal(first.actions.length, 0);
  assert.deepEqual(second.actions, [["execute", second.tool.id, "session-b"]]);
  await first.close();
  assert.equal((await listPendingApprovals(first.root)).windows.length, 1);
});

test("protocol errors and changed routing are rejected; stale discovery records are harmless", async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  const request = f.register();
  await assert.rejects(approvalRequest(request.approval_channel.socket_path, { protocol: 2, op: "list" }), {
    code: "PROTOCOL",
  });
  f.manager.getConfirmTarget = () => undefined;
  await assert.rejects(respondToApproval(request.request_id, "allow", f.root), { code: "TARGET_CHANGED" });
  assert.equal(f.actions.length, 0);
  const stalePath = path.join(f.root, "stale.sock");
  await fs.writeFile(
    stalePath + ".json",
    JSON.stringify({ protocol: 1, socket_path: stalePath, window_id: "stale" }),
    { mode: 0o600 },
  );
  assert.deepEqual((await listPendingApprovals(f.root)).unavailable, ["stale.sock.json"]);
});
