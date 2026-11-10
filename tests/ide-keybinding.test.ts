import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { sha256 } from "../src/core/hash";
import { appendBinding, IdeKeybindingInstaller } from "../src/installers/ide-keybinding";
import { FOCUS_INPUT_BINDING } from "../src/apps/codebuddy-cn/focus-keybinding";

const source =
  '// 用户快捷键\n[\n    { "key": "cmd+i", "command": "old.inline", "when": "editorTextFocus" },\n]\n';

test("global focus rule preserves JSONC comments and old rules without a view condition", () => {
  const updated = appendBinding(source, FOCUS_INPUT_BINDING);
  assert.ok(updated.startsWith("// 用户快捷键"));
  const rules = parse(updated);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].command, "old.inline");
  assert.deepEqual(rules[1], FOCUS_INPUT_BINDING);
  assert.equal(Object.hasOwn(rules[1], "when"), false);
  assert.equal(appendBinding(updated, FOCUS_INPUT_BINDING), updated);
});

test("malformed or non-array JSONC is rejected", () => {
  assert.throws(() => appendBinding('[{"key":', FOCUS_INPUT_BINDING), /无效/);
  assert.throws(() => appendBinding("{}", FOCUS_INPUT_BINDING), /数组/);
});

test("install and restore are idempotent and preserve original rules and comments", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-keybinding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "keybindings.json");
  await fs.writeFile(target, source);
  const manager = new IdeKeybindingInstaller(target, path.join(root, "state"), FOCUS_INPUT_BINDING);
  await manager.install();
  const installed = await fs.readFile(target, "utf8");
  assert.equal(parse(installed).length, 2);
  assert.match(await manager.install(), /已经安装/);
  await manager.restore();
  const restored = await fs.readFile(target, "utf8");
  assert.deepEqual(parse(restored), parse(source));
  assert.ok(restored.startsWith("// 用户快捷键"));
  assert.match(await manager.restore(), /没有本工具/);
  await manager.install();
  assert.deepEqual(parse(await fs.readFile(target, "utf8")), parse(installed));
});

test("reconfiguration and removal preserve unrelated later user edits", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-keybinding-edited-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "keybindings.json");
  await fs.writeFile(target, source);
  const data = path.join(root, "state");
  const manager = new IdeKeybindingInstaller(target, data, FOCUS_INPUT_BINDING);
  await manager.install();
  const unrelated = { key: "cmd+k", command: "user.keep" };
  const edited = appendBinding(await fs.readFile(target, "utf8"), unrelated) + "// another user edit\n";
  await fs.writeFile(target, edited);
  const updated = new IdeKeybindingInstaller(target, data, { ...FOCUS_INPUT_BINDING, key: "cmd+shift+i" });
  await updated.install();
  assert.equal((await updated.inspect()).binding?.key, "cmd+shift+i");
  assert.equal(
    parse(await fs.readFile(target, "utf8")).filter(
      (rule: { command: string }) => rule.command === FOCUS_INPUT_BINDING.command,
    ).length,
    1,
  );
  await updated.restore();
  const restored = await fs.readFile(target, "utf8");
  assert.deepEqual(parse(restored), [...parse(source), unrelated]);
  assert.ok(restored.includes("// another user edit"));
  assert.ok(restored.startsWith("// 用户快捷键"));
});

test("preexisting user rule is not taken over or removed", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-keybinding-existing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "keybindings.json");
  const alreadyBound = JSON.stringify([FOCUS_INPUT_BINDING]);
  await fs.writeFile(target, alreadyBound);
  const data = path.join(root, "state");
  const manager = new IdeKeybindingInstaller(target, data, FOCUS_INPUT_BINDING);
  assert.match(await manager.install(), /不接管/);
  assert.match(await manager.restore(), /不修改/);
  await assert.rejects(fs.stat(data), { code: "ENOENT" });
  assert.equal(await fs.readFile(target, "utf8"), alreadyBound);
});

test("legacy snapshot ownership migrates before changing a shortcut", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-keybinding-legacy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "keybindings.json");
  const data = path.join(root, "state");
  const installed = appendBinding(source, FOCUS_INPUT_BINDING);
  await fs.mkdir(data);
  await fs.writeFile(target, installed);
  await fs.writeFile(path.join(data, "before.jsonc"), source);
  await fs.writeFile(
    path.join(data, "state.json"),
    JSON.stringify({
      schema: 1,
      target,
      binding: FOCUS_INPUT_BINDING,
      beforeHash: sha256(source),
      afterHash: sha256(installed),
    }),
  );
  const manager = new IdeKeybindingInstaller(
    target,
    data,
    { ...FOCUS_INPUT_BINDING, key: "cmd+shift+i" },
    "focus-input",
  );
  assert.equal((await manager.inspect()).kind, "legacy");
  await manager.install();
  assert.equal((await manager.inspect()).kind, "managed");
  assert.equal((await manager.inspect()).binding?.key, "cmd+shift+i");
  assert.equal(JSON.parse(await fs.readFile(path.join(data, "state.json"), "utf8")).schema, 2);
  await manager.restore();
  assert.deepEqual(parse(await fs.readFile(target, "utf8")), parse(source));
});

test("missing legacy backups explain recovery and never mutate shortcut files or records", async (t) => {
  for (const schema of [1, 2]) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-missing-keybinding-backup-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, "keybindings.json");
    const data = path.join(root, "state");
    const manager = new IdeKeybindingInstaller(target, data, FOCUS_INPUT_BINDING);
    await fs.writeFile(target, source);
    const installed = schema === 1 ? appendBinding(source, FOCUS_INPUT_BINDING) : await manager.preview(true);
    const record = JSON.stringify(
      schema === 1
        ? {
            schema,
            target,
            binding: FOCUS_INPUT_BINDING,
            beforeHash: sha256(source),
            afterHash: sha256(installed),
          }
        : { schema, target, owner: FOCUS_INPUT_BINDING.command, command: FOCUS_INPUT_BINDING.command },
    );
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, "state.json"), record);
    await fs.writeFile(target, installed);
    await assert.rejects(manager.legacyBaseline(), (error: Error) => {
      assert.match(error.message, /缺少旧版快捷键原文备份/);
      assert.ok(error.message.includes(path.join(data, "before.jsonc")));
      assert.match(error.message, /不要新建空文件/);
      assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
    assert.equal(await fs.readFile(target, "utf8"), installed);
    assert.equal(await fs.readFile(path.join(data, "state.json"), "utf8"), record);
    await assert.rejects(fs.stat(path.join(data, "before.jsonc")), { code: "ENOENT" });
    // A recovered original backup must still pass the existing reconstruction checks.
    await fs.writeFile(path.join(data, "before.jsonc"), source);
    assert.equal((await manager.legacyBaseline()).before, sha256(source));
    assert.equal(await fs.readFile(target, "utf8"), installed);
  }
});

test("explicit command migration upgrades only the owned focus rule and keeps user edits", async (t) => {
  for (const snapshot of [false, true]) {
    const root = await fs.mkdtemp(path.join(tmpdir(), "app-hook-focus-migration-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, "keybindings.json"),
      directory = path.join(root, "state");
    const oldBinding = { key: "cmd+shift+i", command: "coding-copilot.webviews.chat.focus" };
    await fs.writeFile(target, source);
    if (snapshot) {
      await fs.mkdir(directory);
      const installed = appendBinding(source, oldBinding);
      await fs.writeFile(target, installed);
      await fs.writeFile(path.join(directory, "before.jsonc"), source);
      await fs.writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          schema: 1,
          target,
          binding: oldBinding,
          beforeHash: sha256(source),
          afterHash: sha256(installed),
        }),
      );
    } else {
      await new IdeKeybindingInstaller(target, directory, oldBinding, "focus-input").install();
      await fs.writeFile(target, (await fs.readFile(target, "utf8")) + "// user added comment\n");
    }
    const manager = new IdeKeybindingInstaller(
      target,
      directory,
      { ...FOCUS_INPUT_BINDING, key: oldBinding.key },
      "focus-input",
      [oldBinding.command],
    );
    assert.equal((await manager.inspect()).binding?.command, oldBinding.command);
    await manager.install();
    const migrated = await fs.readFile(target, "utf8");
    assert.equal(
      parse(migrated).filter((v: { command: string }) => v.command === FOCUS_INPUT_BINDING.command).length,
      1,
    );
    assert.equal((await manager.inspect()).binding?.key, oldBinding.key);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8")).command,
      FOCUS_INPUT_BINDING.command,
    );
    assert.match(await manager.install(), /已经安装/);
    await manager.restore();
    assert.deepEqual(parse(await fs.readFile(target, "utf8")), parse(source));
    if (!snapshot) assert.match(await fs.readFile(target, "utf8"), /user added comment/);
  }
});
