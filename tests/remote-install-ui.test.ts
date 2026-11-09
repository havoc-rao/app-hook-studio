import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

const requireModule = createRequire(__filename);
const code = buildSync({
  entryPoints: ["src/ui/remote-install.tsx"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "@raycast/api"],
}).outputFiles[0].text;

function fixture() {
  const state: unknown[] = [];
  let index = 0;
  const component = () => null;
  const api = {
    Action: { Push: component, SubmitForm: component, CopyToClipboard: component },
    ActionPanel: component,
    Form: Object.assign(component, {
      Description: component,
      TextField: component,
      Checkbox: component,
      Separator: component,
      Dropdown: Object.assign(component, { Item: component }),
    }),
    Icon: {},
  };
  const react = {
    useState(initial: unknown) {
      const at = index++;
      if (!(at in state)) state[at] = initial;
      return [
        state[at],
        (value: unknown) => {
          state[at] = typeof value === "function" ? value(state[at]) : value;
        },
      ];
    },
    useRef(value: unknown) {
      return { current: value };
    },
    useEffect() {},
  };
  const module = { exports: {} as { RemoteInstall(): any } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    Buffer,
    process,
    console,
    setTimeout,
    clearTimeout,
    require(id: string) {
      if (id === "@raycast/api") return api;
      if (id === "react") return react;
      return requireModule(id);
    },
  });
  const render = () => {
    index = 0;
    return module.exports.RemoteInstall();
  };
  const children = (tree: any): any[] =>
    requireModule("react")
      .Children.toArray(tree.props.children)
      .filter((child: any) => child?.props);
  const actions = (tree: any) => children(tree.props.actions);
  return { state, render, children, actions };
}

test("remote form defaults to auto, exposes manual input only when off, and hides install before verification", () => {
  const f = fixture();
  let tree = f.render();
  assert.ok(!f.actions(tree).some((action) => action.props.title === "安装远程补丁"));
  assert.ok(f.actions(tree).some((action) => action.props.title === "检测目标版本与兼容性"));
  let fields = f.children(tree);
  const automatic = fields.find((field) => field.props.id === "automaticPython");
  assert.equal(automatic.props.value, true);
  assert.ok(!fields.some((field) => field.props.id === "python"));
  automatic.props.onChange(false);
  tree = f.render();
  fields = f.children(tree);
  assert.ok(fields.some((field) => field.props.id === "python"));
});

test("install is available only for matching verification and edits invalidate it", () => {
  const f = fixture();
  f.render();
  // useState order: values, automaticPython, loading, busy, error, output, summary, verified.
  const target = {
    commit: "2".repeat(40),
    appVersion: "1.106.1",
    extensionVersion: "3.10.0",
    base: "/remote/build",
  };
  f.state[7] = {
    target,
    connection: { host: "example", port: "22", python: "/usr/bin/python3" },
    fingerprint: JSON.stringify({ values: f.state[0], automaticPython: f.state[1] }),
  };
  let tree = f.render();
  assert.ok(f.actions(tree).some((action) => action.props.title === "安装远程补丁"));
  assert.ok(f.children(tree).some((field) => field.props.title === "版本门禁 · 已通过"));
  f.children(tree)
    .find((field) => field.props.id === "host")
    .props.onChange("another-host");
  tree = f.render();
  assert.ok(!f.actions(tree).some((action) => action.props.title === "安装远程补丁"));
  assert.ok(f.children(tree).some((field) => field.props.title === "版本门禁 · 待检测"));
});
