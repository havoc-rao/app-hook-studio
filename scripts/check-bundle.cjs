// Load the exact Raycast artifact without its private host, and reject dependencies left out of the bundle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { builtinModules, createRequire } = require("node:module");
const projectRequire = createRequire(path.join(__dirname, "../package.json"));
const filename =
  process.argv[2] === "--installed"
    ? path.join(os.homedir(), ".config/raycast/extensions/app-hook-studio/manage-hooks.js")
    : path.resolve(process.argv[2] || "dist/manage-hooks.js");
const component = () => null;
const api = {
  environment: { assetsPath: path.join(path.dirname(filename), "assets") },
  List: Object.assign(() => null, { Section: component, Item: component }),
  Action: Object.assign(() => null, { Push: component, SubmitForm: component }),
  ActionPanel: Object.assign(() => null, { Section: component }),
  Form: component,
  Icon: new Proxy({}, { get: (_, name) => String(name) }),
};
const requested = new Set();
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const moduleRecord = { exports: {} };
const sandbox = {
  module: moduleRecord,
  exports: moduleRecord.exports,
  require(id) {
    requested.add(id);
    if (id === "@raycast/api") return api;
    if (id === "react" || id === "react/jsx-runtime") return projectRequire(id);
    if (nodeBuiltins.has(id.replace(/^node:/, ""))) return projectRequire(id);
    throw new Error(`Unbundled runtime dependency: ${id}`);
  },
  __filename: filename,
  __dirname: path.dirname(filename),
  Buffer,
  process,
  console,
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
};
vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename, timeout: 5000 });
assert.equal(typeof moduleRecord.exports.default, "function", "Raycast command export missing");
const tree = moduleRecord.exports.default();
assert.equal(projectRequire("react").isValidElement(tree), true, "Command must return a React element");
const items = projectRequire("react").Children.toArray(tree.props.children);
assert.ok(items.length > 0, "App list must contain applications");
for (const item of items.filter((entry) => entry.props.icon?.fileIcon)) {
  assert.ok(item.props.icon.fileIcon.endsWith(".app"), "Use the actual app icon");
  const actions = projectRequire("react").Children.toArray(item.props.actions.props.children);
  const view = actions.find((action) => action.props.title === "查看功能");
  const install = actions.find((action) => action.props.title === "Install / 安装 App");
  const add = actions.find((action) => action.props.title === "Add App / 新增应用");
  assert.equal(actions[1], install, "Raycast secondary action must be Install, never Add App");
  assert.ok(add && actions.indexOf(add) > 1, "Add App must stay outside default Cmd+Enter slot");
  assert.equal(JSON.stringify(add.props.shortcut), JSON.stringify({ modifiers: ["cmd"], key: "n" }));
  assert.ok(view && install, "App must have distinct view and install actions");
  assert.equal(JSON.stringify(view.props.shortcut), JSON.stringify({ modifiers: [], key: "return" }));
  assert.equal(JSON.stringify(install.props.shortcut), JSON.stringify({ modifiers: ["cmd"], key: "return" }));
  assert.notEqual(
    view.props.target.type,
    install.props.target.type,
    "Cmd+Enter must not open the view-more destination",
  );
}
const workerFile = path.join(api.environment.assetsPath, "resource-worker.cjs");
assert.ok(fs.existsSync(workerFile), "Packaged resource worker missing");
const health = JSON.parse(
  require("node:child_process").execFileSync(
    process.execPath,
    [workerFile, JSON.stringify({ protocol: 1, operation: "health" })],
    { encoding: "utf8", timeout: 10000 },
  ),
);
assert.equal(health.ok, true);
console.log(`PASS: artifact loads and command creates a React element (${path.basename(filename)}).`);
console.log(`External imports: ${[...requested].sort().join(", ")}`);
console.log("Private Raycast APIs are stubbed; this does not replace native UI acceptance.");
