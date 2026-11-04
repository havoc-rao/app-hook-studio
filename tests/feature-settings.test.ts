import { strict as assert } from "node:assert";
import { test } from "node:test";
import { codebuddyAdapter } from "../src/apps/codebuddy-cn/adapter";
import { defaultConfig, AppFeature } from "../src/core/contracts";
import { mergeFeatureSettings } from "../src/core/feature-settings";
import { toIdeShortcut } from "../src/core/shortcuts";

test("CodeBuddy exposes shortcut features and the shared approval notification resource", () => {
  assert.deepEqual(
    codebuddyAdapter.features.map((feature) => feature.id),
    ["new-chat", "stop-chat", "focus-input", "approval-notification"],
  );
  const fieldIds = new Set(codebuddyAdapter.fields.map((field) => field.id));
  for (const feature of codebuddyAdapter.features) {
    if (feature.kind === "resource") for (const id of feature.fieldIds) assert.ok(fieldIds.has(id));
  }
});

test("editing one feature preserves other features' latest settings", () => {
  const feature = codebuddyAdapter.features.find((feature) => feature.id === "new-chat") as Extract<
    AppFeature,
    { kind: "resource" }
  >;
  const initial = defaultConfig(codebuddyAdapter);
  const latest = {
    ...initial,
    settings: { ...initial.settings, doubleEscapeMs: 900, stopMode: "shortcut", stopShortcut: "cmd+alt+." },
  };
  const staleDraft = { ...initial.settings, newChatShortcut: "cmd+alt+n" };
  const result = mergeFeatureSettings(codebuddyAdapter, feature, latest, staleDraft);
  assert.equal(result.settings.newChatShortcut, "cmd+alt+n");
  assert.equal(result.settings.doubleEscapeMs, 900);
  assert.equal(result.settings.stopMode, "shortcut");
});

test("native key field normalizes aliases and rejects plain typing keys", () => {
  assert.equal(toIdeShortcut("command + shift + i"), "cmd+shift+i");
  assert.equal(toIdeShortcut("ctrl+alt+."), "ctrl+alt+.");
  assert.throws(() => toIdeShortcut("i"), /修饰键/);
});
