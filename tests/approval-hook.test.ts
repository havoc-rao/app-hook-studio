import { test } from "node:test";
import { strict as assert } from "node:assert";
import vm from "node:vm";
import { renderApprovalHook } from "../src/apps/codebuddy-cn/approval-runtime";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  options: {
    failure?: boolean;
    missingSubMethod?: boolean;
    originalThrows?: boolean;
    autoApprove?: boolean;
  } = {},
) {
  const calls: { cwd: string; args: unknown[] }[] = [],
    errors: unknown[] = [];
  const subscriptions: { dispose(): void }[] = [];
  const originalResult = Promise.resolve("original approval result");
  class Main {
    conversationId = "main-session";
    contextManager = { getContext: () => ({ agent: { requestId: "main-generation" } }) };
    onUserConfirmRequired(_manager: unknown, _id: string, tool: { state: string }) {
      if (options.originalThrows) throw new Error("original failure");
      tool.state = options.autoApprove ? "executing" : "pending";
      return originalResult;
    }
    onToolExecutionStart() {
      return "started";
    }
    onToolExecutionComplete() {
      return "completed";
    }
  }
  class Sub {
    modelId = "sub-model";
    onUserConfirmRequired(_manager: unknown, _id: string, tool: { state: string }) {
      tool.state = "pending";
      return originalResult;
    }
    onToolExecutionStart() {
      return "started";
    }
    onToolExecutionComplete() {
      return "completed";
    }
  }
  if (options.missingSubMethod)
    Object.defineProperty(Sub.prototype, "onToolExecutionComplete", { value: undefined });
  const originalMain = Main.prototype.onUserConfirmRequired;
  const originalSub = Sub.prototype.onUserConfirmRequired;
  const hookManager = {};
  class Notifications {
    constructor(
      manager: unknown,
      _logger: unknown,
      private cwd: string,
    ) {
      assert.equal(manager, hookManager);
    }
    async notifyPermissionPrompt(...args: unknown[]) {
      calls.push({ cwd: this.cwd, args });
      if (options.failure) throw new Error("notification failed");
    }
  }
  vm.runInNewContext(renderApprovalHook(), {
    ir: { subscriptions },
    console: { error: (...args: unknown[]) => errors.push(args) },
    container: {
      get: () => {
        throw new Error("Unexpected fallback");
      },
    },
    __webpack_require__(id: number) {
      switch (id) {
        case 73280:
          return { ToolManagerListener: Main };
        case 748749:
          return { SubagentToolListener: Sub };
        case 946785:
          return { normalizeToolName: (name: string) => (name === "execute_command" ? "Bash" : name) };
        case 176998:
          return { NotificationManager: Notifications };
        case 445368:
          return { ToolState: { PENDING: "pending" } };
        default:
          throw new Error(`Unexpected module ${id}`);
      }
    },
  });
  const manager = (session = "session-a") => ({
    sessionId: session,
    transcriptPath: `/transcripts/${session}`,
    generationId: `generation-${session}`,
    model: "model-a",
    client: "codebuddy",
    version: "1.106.1",
    getContext: () => ({ conversationId: session, workingDirectory: `/work/${session}` }),
    toolHookExecutor: { hookManager },
  });
  const tool = (id = "tool-a") => ({
    id,
    name: "execute_command",
    state: "pending",
    confirmRequestedAt: 1,
    safetyConfirmMessage: "Safety rule asks for confirmation",
  });
  return {
    Main,
    Sub,
    calls,
    errors,
    manager,
    tool,
    originalResult,
    originalMain,
    originalSub,
    dispose: () => subscriptions.forEach((item) => item.dispose()),
  };
}

test("approval hook preserves original promise, covers safety confirmation, deduplicates and permits later rounds", async () => {
  const h = fixture(),
    listener = new h.Main(),
    manager = h.manager(),
    tool = h.tool();
  assert.equal(listener.onUserConfirmRequired(manager, tool.id, tool), h.originalResult);
  listener.onUserConfirmRequired(manager, tool.id, tool);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], {
    cwd: "/work/session-a",
    args: [
      "Tool Bash requires user approval (tool-a): Safety rule asks for confirmation",
      "session-a",
      "/transcripts/session-a",
      "generation-session-a",
      "model-a",
      "codebuddy",
      "1.106.1",
    ],
  });
  assert.equal(
    (listener.onToolExecutionStart as (...args: unknown[]) => unknown)(manager, tool.id, tool),
    "started",
  );
  // The real callback receives manager, callId, instance.
  (listener.onToolExecutionComplete as (...args: unknown[]) => unknown)(manager, tool.id, tool);
  listener.onUserConfirmRequired(manager, tool.id, tool);
  await tick();
  assert.equal(h.calls.length, 2);
  tool.confirmRequestedAt++;
  listener.onUserConfirmRequired(manager, tool.id, tool);
  await tick();
  assert.equal(h.calls.length, 3);
  h.dispose();
  assert.equal(h.Main.prototype.onUserConfirmRequired, h.originalMain);
});

test("subagent approvals and concurrent sessions retain their own workspace, transcript and generation", async () => {
  const h = fixture();
  new h.Main().onUserConfirmRequired(h.manager("first"), "a", h.tool("a"));
  new h.Sub().onUserConfirmRequired(h.manager("second"), "b", h.tool("b"));
  await tick();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.calls.map((c) => [c.cwd, c.args[1], c.args[2], c.args[3]]),
    [
      ["/work/first", "first", "/transcripts/first", "generation-first"],
      ["/work/second", "second", "/transcripts/second", "generation-second"],
    ],
  );
  h.dispose();
});

test("notification failures never change approval results; disposal cancels queued notifications", async () => {
  const h = fixture({ failure: true }),
    listener = new h.Main();
  assert.equal(
    await listener.onUserConfirmRequired(h.manager(), "tool-a", h.tool()),
    "original approval result",
  );
  await tick();
  assert.equal(h.errors.length, 1);
  listener.onUserConfirmRequired(h.manager(), "next", h.tool("next"));
  h.dispose();
  await tick();
  assert.equal(h.calls.length, 1);
});

test("forwarded parent-task approvals are not double counted, and missing workspace never uses host cwd", async () => {
  const h = fixture(),
    listener = new h.Main();
  listener.onUserConfirmRequired(h.manager(), "child-id", h.tool("parent-id"));
  const manager = { ...h.manager(), getContext: () => ({}) };
  listener.onUserConfirmRequired(manager, "tool-a", h.tool());
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.errors.length, 1);
  h.dispose();
});

test("missing listener contract rolls back every wrapper; original exceptions propagate unchanged", () => {
  const broken = fixture({ missingSubMethod: true });
  assert.equal(broken.Main.prototype.onUserConfirmRequired, broken.originalMain);
  assert.equal(broken.Sub.prototype.onUserConfirmRequired, broken.originalSub);
  assert.equal(broken.errors.length, 1);
  const h = fixture({ originalThrows: true });
  assert.throws(
    () => new h.Main().onUserConfirmRequired(h.manager(), "tool-a", h.tool()),
    /original failure/,
  );
  assert.equal(h.calls.length, 0);
  h.dispose();
});

test("a tool that no longer awaits approval after the original listener does not notify", async () => {
  const h = fixture({ autoApprove: true });
  await new h.Main().onUserConfirmRequired(h.manager(), "tool-a", h.tool());
  await tick();
  assert.equal(h.calls.length, 0);
  h.dispose();
});
