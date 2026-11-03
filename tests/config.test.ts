import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_SETTINGS, validateSettings } from "../src/apps/codebuddy-cn/settings";
import { parseShortcut } from "../src/core/shortcuts";

test("shortcut parsing preserves exact modifiers and physical keys", () => {
  assert.deepEqual(parseShortcut("control + command + n"), {
    code: "KeyN",
    ctrl: true,
    meta: true,
    alt: false,
    shift: false,
  });
  assert.equal(parseShortcut("cmd+alt+.").code, "Period");
  assert.equal(parseShortcut("esc").code, "Escape");
  assert.throws(() => parseShortcut("cmd+cmd+n"), /重复/);
  assert.throws(() => parseShortcut("cmd+n+m"), /无效/);
  assert.throws(() => parseShortcut("cmd"), /修饰键/);
});

test("configuration rejects typing collisions and ambiguous actions", () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, newChatShortcut: "n" }), /修饰键/);
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, stopMode: "shortcut", stopShortcut: "control+command+n" }),
    /相同/,
  );
  for (const doubleEscapeMs of [0, -1, NaN, 1.5, "500"]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, doubleEscapeMs }));
  }
  assert.equal(
    validateSettings({ ...DEFAULT_SETTINGS, stopMode: "disabled", newChatEnabled: false }).stopMode,
    "disabled",
  );
});
