import { renderApprovalHookV3 } from "../src/apps/codebuddy-cn/approval-runtime-v3";
import { assertSymbolExport } from "../src/apps/codebuddy-cn/bundle-contract";
import { FOCUS_BINDINGS } from "../src/apps/codebuddy-cn/focus-bindings";
import { renderFocusHostV1 } from "../src/apps/codebuddy-cn/focus-host-runtime-v1";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import vm from "node:vm";
import { renderFocusHost } from "../src/apps/codebuddy-cn/focus-host-runtime";
import { renderFocusReceiver } from "../src/apps/codebuddy-cn/focus-receiver";
import { FOCUS_ACK, FOCUS_COMMAND, FOCUS_REQUEST } from "../src/apps/codebuddy-cn/focus-protocol";
import { focusHostAdapter, HOST_PROFILE } from "../src/apps/codebuddy-cn/focus-host";
import { renderHookV1 } from "../src/apps/codebuddy-cn/hook-v1";
import { analyzeBundle, patchBundle, BEGIN } from "../src/apps/codebuddy-cn/hook";
import { DEFAULT_SETTINGS } from "../src/apps/codebuddy-cn/settings";
import { PROFILE } from "../src/apps/codebuddy-cn/profile";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
type Message = { type: string; requestId: string; focused?: boolean };
function host(options: { rejectPost?: boolean; waitReady?: Promise<void>; missingChatToken?: boolean } = {}) {
  const commands = new Map<string, () => Promise<void>>(),
    listeners = new Set<(value: Message) => void>();
  const timeouts = new Map<number, () => void>(),
    intervals = new Map<number, () => void>(),
    subscriptions: { dispose(): void }[] = [];
  const posted: Message[] = [],
    native: string[] = [],
    routes: unknown[] = [],
    errors: string[] = [];
  let timerId = 0,
    ensureCalls = 0;
  const providerToken = Symbol(),
    chatToken = Symbol();
  const provider = {
    getChatService: () => ({ waitWebviewReady: () => options.waitReady ?? Promise.resolve() }),
    ensureRpc: async () => {
      ensureCalls++;
    },
    rpc: {
      getProxy(token: unknown) {
        assert.equal(token, chatToken);
        return {
          activatePage: async (route: unknown) => {
            routes.push(route);
          },
        };
      },
    },
    webview: {
      onDidReceiveMessage(fn: (value: Message) => void) {
        listeners.add(fn);
        return {
          dispose() {
            listeners.delete(fn);
          },
        };
      },
      postMessage(message: Message) {
        posted.push(message);
        return Promise.resolve(!options.rejectPost);
      },
    },
  };
  const api = {
    commands: {
      registerCommand(id: string, fn: () => Promise<void>) {
        assert.equal(id, FOCUS_COMMAND);
        commands.set(id, fn);
        return {
          dispose() {
            commands.delete(id);
          },
        };
      },
      executeCommand: async (id: string) => {
        native.push(id);
      },
    },
    window: { showErrorMessage: (message: string) => errors.push(message) },
  };
  vm.runInNewContext(renderFocusHost(), {
    ir: { subscriptions },
    container: {
      get(token: unknown) {
        assert.equal(token, providerToken);
        return provider;
      },
    },
    __webpack_require__(id: number) {
      if (id === 426850) return api;
      if (id === 328150) return { ActivityBarChatWebviewProvider: providerToken };
      if (id === 637830) return { ChatViewService: options.missingChatToken ? undefined : chatToken };
      throw new Error(`Unexpected module: ${id}`);
    },
    setTimeout(fn: () => void) {
      const id = ++timerId;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout(id: number) {
      timeouts.delete(id);
    },
    setInterval(fn: () => void) {
      const id = ++timerId;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
  });
  return {
    commands,
    posted,
    native,
    routes,
    errors,
    listeners,
    timeouts,
    intervals,
    get ensureCalls() {
      return ensureCalls;
    },
    invoke: () => commands.get(FOCUS_COMMAND)!(),
    ack(focused = true) {
      const request = posted.at(-1)!;
      for (const fn of listeners) fn({ type: FOCUS_ACK, requestId: request.requestId, focused });
    },
    dispose() {
      for (const item of subscriptions) item.dispose();
    },
  };
}

test("native focus command explicitly requests input focus, waits for matching ACK, and releases all listeners/timers", async () => {
  const h = host(),
    first = h.invoke();
  assert.equal(h.invoke(), first);
  await tick();
  assert.deepEqual(h.native, ["coding-copilot.webviews.chat.focus"]);
  assert.equal(JSON.stringify(h.routes), JSON.stringify([{ path: "/" }]));
  assert.equal(h.posted[0].type, FOCUS_REQUEST);
  for (const fn of h.listeners) fn({ type: FOCUS_ACK, requestId: "unrelated", focused: true });
  assert.equal(h.listeners.size, 1);
  h.ack(false);
  assert.equal(h.listeners.size, 1);
  h.ack();
  await first;
  assert.equal(h.listeners.size + h.timeouts.size + h.intervals.size, 0);
  const next = h.invoke();
  await tick();
  h.ack();
  await next;
  h.dispose();
  assert.equal(h.commands.size, 0);
});

test("focus timeout, post failure and extension disposal report failure and leave no owned waiters", async () => {
  for (const mode of ["timeout", "post", "dispose"]) {
    const h = host({ rejectPost: mode === "post" });
    const pending = h.invoke();
    const rejected = assert.rejects(pending, /confirmed|rejected focus|disposed/);
    await tick();
    if (mode === "timeout") for (const fn of [...h.timeouts.values()]) fn();
    if (mode === "dispose") h.dispose();
    await rejected;
    assert.equal(h.listeners.size + h.timeouts.size + h.intervals.size, 0);
    assert.equal(h.errors.length, 0);
    h.dispose();
  }
});

test("disposal while native readiness is pending does not start RPC recovery or send later focus requests", async () => {
  let ready!: () => void;
  const h = host({
    waitReady: new Promise<void>((resolve) => {
      ready = resolve;
    }),
  });
  const pending = h.invoke();
  const rejected = assert.rejects(pending, /disposed/);
  await tick();
  h.dispose();
  ready();
  await rejected;
  assert.equal(h.ensureCalls, 0);
  assert.equal(h.posted.length, 0);
  assert.equal(h.listeners.size + h.timeouts.size + h.intervals.size, 0);
});

test("receiver calls the existing input API only for explicit requests, confirms an editable caret, and cleans up on unmount", async () => {
  const listeners = new Map<string, (value: { data: Message }) => void>(),
    replies: Message[] = [],
    timers = new Map<number, () => void>();
  const input = { contains: (element: unknown) => element === editable, getClientRects: () => [{}] },
    editable = { isContentEditable: true, tagName: "DIV" };
  const document: { activeElement: unknown } = { activeElement: {} };
  let focused = 0,
    timerId = 0,
    cleanup = () => {};
  vm.runInNewContext(renderFocusReceiver(), {
    m: {
      useEffect(fn: () => () => void) {
        cleanup = fn();
      },
    },
    Ne: false,
    Re: { current: input },
    Ue: {
      current: {
        focus() {
          focused++;
          document.activeElement = editable;
        },
      },
    },
    document,
    window: {
      vs: {
        postMessage(message: Message) {
          replies.push(message);
        },
      },
      addEventListener: (type: string, fn: (value: { data: Message }) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    setTimeout(fn: () => void) {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  assert.equal(listeners.has("focus"), false);
  assert.equal(focused, 0);
  listeners.get("message")!({ data: { type: "unrelated", requestId: "x" } });
  assert.equal(focused, 0);
  listeners.get("message")!({ data: { type: FOCUS_REQUEST, requestId: "request-1" } });
  for (const [id, fn] of [...timers]) {
    timers.delete(id);
    fn();
  }
  assert.equal(focused, 1);
  assert.equal(replies[0].focused, true);
  assert.equal(replies[0].requestId, "request-1");
  listeners.get("message")!({ data: { type: FOCUS_REQUEST, requestId: "pending" } });
  cleanup();
  assert.equal(listeners.size + timers.size, 0);
});

const originalPath = process.env.CODEBUDDY_TEST_ORIGINAL;
test(
  "existing v1 chat patch is recognized and upgraded to v2 without changing original bytes/settings",
  { skip: !originalPath },
  async () => {
    const original = await fs.readFile(originalPath!, "utf8");
    const previous = original.replace(PROFILE.anchor, renderHookV1(DEFAULT_SETTINGS) + PROFILE.anchor);
    const known = analyzeBundle(previous);
    assert.deepEqual(known.installedSettings, DEFAULT_SETTINGS);
    const updated = patchBundle(known.original, known.installedSettings!);
    assert.ok(updated.includes(BEGIN));
    assert.ok(updated.includes(FOCUS_REQUEST));
    assert.equal(analyzeBundle(updated).original, original);
  },
);
const hostPath = process.env.CODEBUDDY_TEST_HOST;
test(
  "real shipped extension bridge patch has exact original identity, unique scope, valid full syntax and byte-exact recovery",
  { skip: !hostPath },
  async () => {
    const source = await fs.readFile(hostPath!, "utf8");
    const profile = { ...HOST_PROFILE, label: "test" };
    assert.equal(focusHostAdapter.analyze(source, profile).kind, "original");
    const patched = focusHostAdapter.patch(source, {}, profile);
    focusHostAdapter.verifyPatch(patched, profile);
    assert.equal(focusHostAdapter.analyze(patched, profile).original, source);
    assert.throws(() => focusHostAdapter.analyze(patched + "//changed", profile));
  },
);

test("missing actual service export is caught before native commands or RPC receive undefined", async () => {
  const h = host({ missingChatToken: true });
  await assert.rejects(
    h.invoke(),
    /App Hook Studio.*检查服务导出.*missing provider or ChatViewService Symbol/,
  );
  assert.equal(h.native.length, 0);
  assert.equal(h.ensureCalls, 0);
  assert.equal(h.posted.length + h.listeners.size + h.timeouts.size + h.intervals.size, 0);
  assert.equal(h.errors.length, 0);
  h.dispose();
});

test(
  "selected service token modules are verified against real shipped exports, including the previously wrong module",
  { skip: !hostPath },
  async () => {
    const source = await fs.readFile(hostPath!, "utf8");
    assertSymbolExport(source, FOCUS_BINDINGS.provider, "ActivityBarChatWebviewProvider");
    assertSymbolExport(source, FOCUS_BINDINGS.chatView, "ChatViewService");
    assert.throws(
      () => assertSymbolExport(source, 536827, "ChatViewService"),
      /没有定义 ChatViewService Symbol/,
    );
  },
);

test(
  "already-installed focus host v1 upgrades to v4 while preserving original identity",
  { skip: !hostPath },
  async () => {
    const source = await fs.readFile(hostPath!, "utf8"),
      profile = { ...HOST_PROFILE, label: "test" };
    const oldBlock =
      "/* APP_HOOK_STUDIO_FOCUS_HOST v1 */\n" +
      renderFocusHostV1() +
      "/* APP_HOOK_STUDIO_FOCUS_HOST_END */\n";
    const previous = source.replace(HOST_PROFILE.anchor, oldBlock + HOST_PROFILE.anchor);
    const known = focusHostAdapter.analyze(previous, profile);
    assert.equal(known.kind, "managed");
    assert.equal(known.original, source);
    const updated = focusHostAdapter.patch(known.original, {}, profile);
    assert.ok(updated.includes("APP_HOOK_STUDIO_FOCUS_HOST v4"));
    assert.ok(updated.includes("__webpack_require__(637830).ChatViewService"));
    focusHostAdapter.verifyPatch(updated, profile);
    assert.equal(focusHostAdapter.analyze(updated, profile).original, source);
    assert.equal(focusHostAdapter.analyze(updated, profile).upgradeRequired, false);
  },
);

test(
  "installed v2 focus bridge upgrades to a single v4 focus/approval block and recovers exact bytes",
  { skip: !hostPath },
  async () => {
    const source = await fs.readFile(hostPath!, "utf8"),
      profile = { ...HOST_PROFILE, label: "test" };
    const previous = source.replace(
      HOST_PROFILE.anchor,
      "/* APP_HOOK_STUDIO_FOCUS_HOST v2 */\n" +
        renderFocusHost() +
        "/* APP_HOOK_STUDIO_FOCUS_HOST_END */\n" +
        HOST_PROFILE.anchor,
    );
    const known = focusHostAdapter.analyze(previous, profile);
    assert.equal(known.upgradeRequired, true);
    const upgraded = focusHostAdapter.patch(known.original, {}, profile);
    focusHostAdapter.verifyPatch(upgraded, profile);
    assert.equal(upgraded.split("/* APP_HOOK_STUDIO_FOCUS_HOST v4 */").length, 2);
    assert.ok(upgraded.includes("notifyPermissionPrompt(...args)"));
    assert.equal(focusHostAdapter.analyze(upgraded, profile).original, source);
    assert.equal(focusHostAdapter.analyze(upgraded, profile).upgradeRequired, false);
    assert.throws(() =>
      focusHostAdapter.analyze(
        upgraded.replace("notifyPermissionPrompt(...args)", "notifyPermissionPrompt()"),
        profile,
      ),
    );
  },
);

test("module export verification does not confuse short module IDs with numeric suffixes", () => {
  const source = '{5239:(m,e)=>{e.ToolService=Symbol("ToolService")},175239:(m,e)=>{e.other=1}}';
  assertSymbolExport(source, 5239, "ToolService");
  assert.throws(() =>
    assertSymbolExport('{175239:(m,e)=>{e.ToolService=Symbol("ToolService")}}', 5239, "ToolService"),
  );
});

test(
  "installed v3 notification bridge upgrades to v4 with the same original and single owned block",
  { skip: !hostPath },
  async () => {
    const source = await fs.readFile(hostPath!, "utf8"),
      profile = { ...HOST_PROFILE, label: "test" };
    const previous = source.replace(
      HOST_PROFILE.anchor,
      "/* APP_HOOK_STUDIO_FOCUS_HOST v3 */\n" +
        renderFocusHost() +
        renderApprovalHookV3() +
        "/* APP_HOOK_STUDIO_FOCUS_HOST_END */\n" +
        HOST_PROFILE.anchor,
    );
    const known = focusHostAdapter.analyze(previous, profile);
    assert.equal(known.upgradeRequired, true);
    const updated = focusHostAdapter.patch(known.original, {}, profile);
    focusHostAdapter.verifyPatch(updated, profile);
    assert.equal(focusHostAdapter.analyze(updated, profile).original, source);
    assert.equal(updated.split("APP_HOOK_STUDIO_FOCUS_HOST v4").length, 2);
    assert.ok(updated.includes("respondToPermission(callId"));
  },
);
