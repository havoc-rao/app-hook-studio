import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { codebuddyAdapter } from "../src/apps/codebuddy-cn/adapter";
import { focusHostAdapter, UPDATED_HOST_PROFILE } from "../src/apps/codebuddy-cn/focus-host";
import { PROFILE, UPDATED_PROFILE } from "../src/apps/codebuddy-cn/profile";
import { renderHook, analyzeBundle, patchBundle } from "../src/apps/codebuddy-cn/hook";
import { DEFAULT_SETTINGS } from "../src/apps/codebuddy-cn/settings";
import { sha256 } from "../src/core/hash";

test("same advertised version selects only an unambiguous verified resource filename", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "codebuddy-builds-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Fixture.app"),
    base = path.join(app, "Contents/Resources/app");
  const webviews = path.join(base, "extensions/genie/out/webviews");
  await fs.mkdir(webviews, { recursive: true });
  await fs.writeFile(path.join(base, "package.json"), JSON.stringify({ version: PROFILE.appVersion }));
  await fs.writeFile(
    path.join(base, "extensions/genie/package.json"),
    JSON.stringify({ version: PROFILE.extensionVersion }),
  );
  await assert.rejects(codebuddyAdapter.identify(app), /构建未知/);
  await assert.rejects(focusHostAdapter.identify(app), /构建未知/);
  for (const profile of [PROFILE, UPDATED_PROFILE]) {
    await fs.writeFile(path.join(app, profile.bundleRelativePath), "unknown bytes");
    if (profile === UPDATED_PROFILE) {
      await assert.rejects(codebuddyAdapter.identify(app), /多个已知入口/);
      await assert.rejects(focusHostAdapter.identify(app), /多个已知入口/);
      // Remove only this test fixture's known old entry.
      await fs.unlink(path.join(app, PROFILE.bundleRelativePath));
    }
    assert.equal((await codebuddyAdapter.identify(app)).originalSha256, profile.originalSha256);
    assert.throws(() => analyzeBundle("unknown bytes"), /不受支持/);
  }
  assert.equal((await focusHostAdapter.identify(app)).originalSha256, UPDATED_HOST_PROFILE.originalSha256);
});

test("updated lexical bindings drive cancellation, new chat and focus without touching strings", async () => {
  const effects: (() => void)[] = [],
    events = new Map<string, (event: any) => void>();
  let cancel = 0,
    created = 0,
    focused = 0;
  class Node {}
  const target = new Node();
  const input = {
    getClientRects: () => [{}],
    contains: () => true,
    addEventListener: (name: string, fn: any) => events.set(name, fn),
    removeEventListener() {},
  };
  const panel = input;
  const context = {
    m: { useRef: (value: any) => ({ current: value }), useEffect: (fn: () => void) => effects.push(fn) },
    Le: false,
    Ae: { current: input },
    je: () => panel,
    se: true,
    ye: () => {
      cancel++;
    },
    Ve: {
      current: {
        focus: () => {
          focused++;
        },
      },
    },
    // Old names deliberately contain incompatible values: using them would fail.
    Ne: true,
    Re: 40,
    le: {},
    Ce: () => {
      throw new Error("wrong callback");
    },
    Ue: { current: null },
    r: () => ({
      ContainerUtil: {
        get: () => ({
          startNewChat: () => {
            created++;
          },
        }),
      },
      NewChatViewServie: {},
    }),
    Node,
    performance: { now: () => 0 },
    console,
    Set,
    window: { addEventListener: (name: string, fn: any) => events.set(name, fn), removeEventListener() {} },
    setTimeout: () => 1,
    clearTimeout() {},
  };
  const source = renderHook(DEFAULT_SETTINGS, UPDATED_PROFILE);
  assert.ok(source.includes("const input=Ae.current,editor=Ve.current;"));
  vm.runInNewContext(`(function(){${source}})()`, context);
  effects.forEach((fn) => fn());
  const event = (key: string, code: string, ctrlKey = false, metaKey = false) => ({
    key,
    code,
    ctrlKey,
    metaKey,
    altKey: false,
    shiftKey: false,
    target,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  events.get("keydown")!(event("Escape", "Escape"));
  events.get("keydown")!(event("Escape", "Escape"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancel, 1);
  events.get("keydown")!(event("n", "KeyN", true, true));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(created, 1);
  const request = /message.type!==("[^"]+")/.exec(source)!;
  events.get("message")!({ data: { type: JSON.parse(request[1]), requestId: "focus" } });
  assert.equal(focused, 1);
});

const originalPath = process.env.CODEBUDDY_TEST_UPDATED_ORIGINAL;
const hostPath = process.env.CODEBUDDY_TEST_UPDATED_HOST;
test(
  "updated real resources round-trip byte-exactly and pass static validation",
  {
    skip:
      !originalPath || !hostPath
        ? "Provide CODEBUDDY_TEST_UPDATED_ORIGINAL and CODEBUDDY_TEST_UPDATED_HOST"
        : false,
  },
  async () => {
    const original = await fs.readFile(originalPath!, "utf8"),
      host = await fs.readFile(hostPath!, "utf8");
    assert.equal(sha256(original), UPDATED_PROFILE.originalSha256);
    assert.equal(sha256(host), UPDATED_HOST_PROFILE.originalSha256);
    const patched = patchBundle(original, DEFAULT_SETTINGS);
    assert.equal(analyzeBundle(patched).original, original);
    assert.equal(analyzeBundle(patched).kind, "managed");
    codebuddyAdapter.verifyPatch(patched, {
      ...UPDATED_PROFILE,
      artifactRelativePath: UPDATED_PROFILE.bundleRelativePath,
      label: "updated",
    });
    assert.throws(() => analyzeBundle(patched.replace("cancel=ye", "cancel=Ce")), /拒绝/);
    const hostProfile = { ...UPDATED_HOST_PROFILE, label: "updated host" };
    const hostPatched = focusHostAdapter.patch(host, {}, hostProfile);
    assert.equal(focusHostAdapter.analyze(hostPatched, hostProfile).original, host);
    focusHostAdapter.verifyPatch(hostPatched, hostProfile);
  },
);
