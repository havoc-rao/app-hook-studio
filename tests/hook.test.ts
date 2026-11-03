import { strict as assert } from "node:assert";
import { test } from "node:test";
import vm from "node:vm";
import { DEFAULT_SETTINGS, CodeBuddySettings } from "../src/apps/codebuddy-cn/settings";
import { renderHook } from "../src/apps/codebuddy-cn/hook";

type Event = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: object;
  defaultPrevented: boolean;
  consumed: boolean;
  repeat: boolean;
  isComposing: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
};

function harness(
  config: CodeBuddySettings = DEFAULT_SETTINGS,
  options: { streaming?: boolean; visible?: boolean; editor?: boolean } = {},
) {
  class FakeNode {}
  const target = new FakeNode();
  let time = 0,
    stopped = 0,
    created = 0,
    freshCallback = 0,
    errors = 0;
  let ref: object | undefined,
    cursor = 0,
    effectCursor = 0;
  const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
  const panelEvents = new Map<string, (event: Event) => void>();
  const inputEvents = new Map<string, (event: Event) => void>();
  const windowEvents = new Map<string, () => void>();
  const node = (events: Map<string, (event: Event) => void>) => ({
    contains: (value: object) => value === target,
    getClientRects: () => (options.visible === false ? [] : [{}]),
    addEventListener: (key: string, listener: (event: Event) => void) => {
      assert.ok(!events.has(key));
      events.set(key, listener);
    },
    removeEventListener: (key: string, listener: (event: Event) => void) => {
      assert.equal(events.get(key), listener);
      events.delete(key);
    },
  });
  const panel = node(panelEvents),
    input = node(inputEvents);
  const context = {
    m: {
      useRef: (value: object) => {
        cursor++;
        return (ref ??= { current: value });
      },
      useEffect: (effect: () => (() => void) | void, next: unknown[]) => {
        const index = effectCursor++,
          previous = effects[index];
        if (!previous || next.some((value, i) => value !== previous.dependencies[i])) {
          previous?.cleanup?.();
          effects[index] = { dependencies: next, cleanup: effect() || undefined };
        }
      },
    },
    Ne: options.editor ?? false,
    Re: { current: input },
    Ae: () => panel,
    le: options.streaming ?? true,
    Ce: () => {
      stopped++;
    },
    r: (id: string) =>
      id === "wGu3"
        ? {
            ContainerUtil: {
              get: () => ({
                startNewChat: () => {
                  created++;
                },
              }),
            },
          }
        : { NewChatViewServie: Symbol() },
    Node: FakeNode,
    performance: { now: () => time },
    console: {
      error: () => {
        errors++;
      },
    },
    window: {
      addEventListener: (key: string, fn: () => void) => windowEvents.set(key, fn),
      removeEventListener: (key: string, fn: () => void) => {
        assert.equal(windowEvents.get(key), fn);
        windowEvents.delete(key);
      },
    },
  };
  const render = () => {
    cursor = 0;
    effectCursor = 0;
    vm.runInNewContext(`(function(){${renderHook(config)}})()`, context);
    assert.equal(cursor, 1);
  };
  render();
  const eventMap = config.scope === "input" ? inputEvents : panelEvents;
  return {
    async key(overrides: Partial<Event> = {}, delta = 0) {
      time += delta;
      const event: Event = {
        target,
        key: "Escape",
        code: "Escape",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        consumed: false,
        repeat: false,
        isComposing: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          this.consumed = true;
        },
        ...overrides,
      };
      eventMap.get("keydown")?.(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return event;
    },
    focusout() {
      eventMap.get("focusout")?.({} as Event);
    },
    blur() {
      windowEvents.get("blur")?.();
    },
    rerender(callback?: () => void, streaming = true) {
      context.Ce =
        callback ??
        (() => {
          freshCallback++;
        });
      context.le = streaming;
      render();
    },
    get stopped() {
      return stopped;
    },
    get created() {
      return created;
    },
    get fresh() {
      return freshCallback;
    },
    get errors() {
      return errors;
    },
    get panelListeners() {
      return panelEvents.size;
    },
    get inputListeners() {
      return inputEvents.size;
    },
    cleanup() {
      for (const effect of effects) effect.cleanup?.();
      assert.equal(panelEvents.size + inputEvents.size + windowEvents.size, 0);
    },
  };
}

test("double Escape calls the existing callback only on a second non-repeated press", async () => {
  const h = harness();
  assert.equal((await h.key()).consumed, false);
  await h.key({ repeat: true }, 100);
  assert.equal(h.stopped, 0);
  assert.equal((await h.key({}, 200)).consumed, true);
  assert.equal(h.stopped, 1);
  assert.equal(h.created, 0);
  h.cleanup();
});

test("custom interval, consumed keys, focus changes, IME and unrelated keys reset the sequence", async () => {
  for (const reset of ["timeout", "consumed", "key", "focus", "blur", "ime"] as const) {
    const h = harness({ ...DEFAULT_SETTINGS, doubleEscapeMs: 350 });
    await h.key();
    if (reset === "timeout") await h.key({}, 351);
    if (reset === "consumed") await h.key({ defaultPrevented: true });
    if (reset === "key") await h.key({ key: "a", code: "KeyA" });
    if (reset === "focus") h.focusout();
    if (reset === "blur") h.blur();
    if (reset === "ime") await h.key({ isComposing: true });
    if (reset !== "timeout") await h.key({}, 100);
    assert.equal(h.stopped, 0, reset);
    h.cleanup();
  }
});

test("streaming rerenders keep the first Escape and use the latest button callback", async () => {
  const h = harness();
  await h.key();
  h.rerender();
  await h.key({}, 200);
  assert.equal(h.stopped, 0);
  assert.equal(h.fresh, 1);
  h.cleanup();
});

test("new-chat chord, alternate stop chord and input-only scope", async () => {
  const h = harness({ ...DEFAULT_SETTINGS, scope: "input", stopMode: "shortcut", stopShortcut: "cmd+alt+." });
  assert.equal(h.panelListeners, 0);
  assert.equal(h.inputListeners, 2);
  await h.key({ key: "n", code: "KeyN", ctrlKey: true, metaKey: true });
  assert.equal(h.created, 1);
  await h.key();
  await h.key({}, 50);
  assert.equal(h.stopped, 0);
  await h.key({ key: ".", code: "Period", metaKey: true, altKey: true });
  assert.equal(h.stopped, 1);
  h.cleanup();
});

test("idle, editor mode, hidden inputs and disabled actions do not cancel", async () => {
  for (const options of [{ streaming: false }, { editor: true }, { visible: false }]) {
    const h = harness(DEFAULT_SETTINGS, options);
    await h.key();
    await h.key({}, 200);
    assert.equal(h.stopped, 0);
    h.cleanup();
  }
  const h = harness({ ...DEFAULT_SETTINGS, newChatEnabled: false, stopMode: "disabled" });
  await h.key();
  await h.key({}, 50);
  await h.key({ key: "n", code: "KeyN", ctrlKey: true, metaKey: true });
  assert.equal(h.stopped + h.created, 0);
  h.cleanup();
});

test("cancellation failures are reported and release the in-flight guard", async () => {
  const h = harness();
  h.rerender(() => {
    throw new Error("cancel failed");
  });
  await h.key();
  await h.key({}, 100);
  assert.equal(h.errors, 1);
  h.rerender();
  await h.key();
  await h.key({}, 100);
  assert.equal(h.fresh, 1);
  h.cleanup();
});
