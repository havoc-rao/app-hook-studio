import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  runRemoteInstall,
  parseRemotePreflight,
  discoverRemotePython,
  validateRemoteConnection,
  RemoteConnection,
  RemoteRunner,
} from "../src/application/remote-install";

const { buildRemote } = createRequire(__filename)("../scripts/build-remote.cjs") as {
  buildRemote(target: string): { target: string; files: string[] };
};
const connection: RemoteConnection = { host: "root@example.com", port: "36000", python: "/usr/bin/python3" };
const success = { stdout: '{"ok":true}\n', stderr: "", exitCode: 0 };
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "remote-install-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assetsPath = path.join(root, "assets");
  const built = buildRemote(path.join(assetsPath, "remote-hotkeys"));
  const script = path.join(built.target, "remote_hotkeys.py");
  return { root, assetsPath, built, script };
}

test("preflight parser accepts only fully verified targets and fails closed", () => {
  const target = {
    commit: "22e67e2a976382fdb01b02588226f2cfd9e24dc3",
    appVersion: "1.106.1",
    extensionVersion: "3.10.0",
    base: "/home/test/.codebuddy-server-cn/bin/stable-build",
  };
  const valid = { ok: true, command: "preflight", checksPassed: true, target };
  assert.deepEqual(parseRemotePreflight(JSON.stringify(valid)), target);
  for (const value of [
    null,
    [],
    {},
    { ...valid, ok: false },
    { ...valid, ok: "true" },
    { ...valid, command: "status" },
    { ...valid, checksPassed: undefined },
    { ...valid, checksPassed: "true" },
    { ...valid, target: null },
    ...["commit", "appVersion", "extensionVersion", "base"].map((key) => ({
      ...valid,
      target: { ...target, [key]: undefined },
    })),
    ...["", "abc", "g".repeat(40), ` ${target.commit}`].map((commit) => ({
      ...valid,
      target: { ...target, commit },
    })),
    ...["", "  ", 123].flatMap((version) =>
      ["appVersion", "extensionVersion"].map((key) => ({ ...valid, target: { ...target, [key]: version } })),
    ),
    ...["relative/path", "", "C:\\remote", "/tmp/\0bad"].map((base) => ({
      ...valid,
      target: { ...target, base },
    })),
  ])
    assert.throws(() => parseRemotePreflight(JSON.stringify(value)), /预检查结果无效/);
  for (const output of ["", "not JSON", `warning\n${JSON.stringify(valid)}`, `${JSON.stringify(valid)}\n{}`])
    assert.throws(() => parseRemotePreflight(output), /预检查结果无效/);
});

test("expectedCommit is validated before execution and forwarded as distinct argv", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const expectedCommit = "22e67e2a976382fdb01b02588226f2cfd9e24dc3";
  const runner: RemoteRunner = async ({ args }) => {
    calls++;
    assert.deepEqual(args.slice(-2), ["--expected-commit", expectedCommit]);
    assert.ok(!args.includes("--commit"));
    return success;
  };
  await runRemoteInstall(
    { assetsPath: f.assetsPath, connection, command: "apply", expectedCommit },
    { runner },
  );
  for (const invalid of [
    "",
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    `${expectedCommit}\n`,
    ` ${expectedCommit}`,
    123,
    null,
  ])
    await assert.rejects(
      runRemoteInstall(
        { assetsPath: f.assetsPath, connection, command: "apply", expectedCommit: invalid as string },
        { runner },
      ),
      /40 位/,
    );
  assert.equal(calls, 1);
});

test("automatic Python discovery ignores shell warnings and passes a constant SSH probe", async () => {
  const python = await discoverRemotePython(
    { ...connection, python: "auto" },
    {
      runner: async (request) => {
        assert.equal(request.executable, "ssh");
        assert.deepEqual(request.args.slice(0, 8), [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-p",
          "36000",
          "--",
          connection.host,
        ]);
        assert.ok(request.args.at(-1)!.includes("sys.version_info < (3,9)"));
        assert.ok(!request.args.at(-1)!.includes(connection.host));
        return {
          stdout: 'shell startup noise\nAHS_PYTHON="/data/conda/bin/python3.13"\n',
          stderr: "locale warning",
          exitCode: 0,
        };
      },
    },
  );
  assert.equal(python, "/data/conda/bin/python3.13");
});

test("automatic discovery refuses missing or unsafe interpreters and reports SSH failures", async () => {
  for (const stdout of ["", 'AHS_PYTHON="relative/python"', 'AHS_PYTHON="/tmp/python;id"']) {
    await assert.rejects(discoverRemotePython(connection, { runner: async () => ({ ...success, stdout }) }));
  }
  await assert.rejects(
    discoverRemotePython(connection, {
      runner: async () => ({ stdout: "", stderr: "No Python 3.9+ found", exitCode: 1 }),
    }),
    /No Python 3.9/,
  );
});

test("auto install resolves interpreter before invoking Python installer", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  await runRemoteInstall(
    { assetsPath: f.assetsPath, connection: { ...connection, python: "auto" }, command: "preflight" },
    {
      runner: async (request) => {
        calls.push(request.executable);
        if (request.executable === "ssh")
          return { ...success, stdout: 'AHS_PYTHON="/opt/conda/bin/python3"\n' };
        assert.equal(request.args[request.args.indexOf("--python") + 1], "/opt/conda/bin/python3");
        return success;
      },
    },
  );
  assert.deepEqual(calls, ["ssh", "python3"]);
});

test("connection validation normalizes port and supports SSH aliases and IPv6", () => {
  assert.deepEqual(
    validateRemoteConnection({ host: " root@example.com ", port: "00022", python: " python3 " }),
    { host: "root@example.com", port: "22", python: "python3" },
  );
  for (const host of ["my-server", "user@10.0.0.1", "user@[2001:db8::1]", "::1"])
    assert.equal(validateRemoteConnection({ ...connection, host }).host, host);
});

test("connection validation rejects options, shell injection, whitespace and invalid types", () => {
  for (const host of [
    "",
    "-oProxyCommand=id",
    "user@-host",
    "host;id",
    "$(id)",
    "host\nother",
    "host other",
    "ssh://host",
    "user@@host",
    "host\0x",
  ])
    assert.throws(() => validateRemoteConnection({ ...connection, host }), /SSH 主机/);
  for (const port of ["0", "65536", "-1", "22x", "2.2", "22;id", "", "1e2"])
    assert.throws(() => validateRemoteConnection({ ...connection, port }), /SSH 端口/);
  for (const python of ["-c", "python3 -c id", "$(id)", "/tmp/python;id", "./python3", "python\n3", ""])
    assert.throws(() => validateRemoteConnection({ ...connection, python }), /Python/);
  assert.throws(
    () => validateRemoteConnection({ ...connection, port: 22 } as unknown as RemoteConnection),
    /字符串/,
  );
});

test("packager copies verified portable assets, without workspace absolute paths or caches", async (t) => {
  const f = await fixture(t);
  assert.ok(f.built.files.includes("hotkeys.py"));
  assert.ok(f.built.files.includes("runtime/webview-v3.js.template"));
  assert.ok(!f.built.files.some((name) => name.includes("__pycache__")));
  // -h imports hotkeys from the relocated bundle without invoking SSH.
  assert.match(
    execFileSync("python3", ["-B", f.script, "--help"], { cwd: f.root, encoding: "utf8" }),
    /preflight/,
  );
  const source = path.resolve("apps/quickstart/codebuddy-hotkeys-quickstart");
  for (const name of f.built.files) {
    const data = await fs.readFile(path.join(f.built.target, name));
    assert.deepEqual(data, await fs.readFile(path.join(source, name)));
    assert.ok(!data.includes(Buffer.from(source)));
  }
});

test("all commands use local python3 with distinct argv and packaged paths", async (t) => {
  const f = await fixture(t);
  for (const command of ["preflight", "status", "apply", "restore"] as const) {
    const runner: RemoteRunner = async (request) => {
      assert.equal(request.executable, "python3");
      assert.deepEqual(request.args, [
        "-B",
        f.script,
        command,
        "--host",
        connection.host,
        "--port",
        connection.port,
        "--python",
        connection.python,
      ]);
      assert.equal(request.cwd, f.built.target);
      assert.equal(request.timeoutMs, 120_000);
      assert.equal(request.maxOutputBytes, 1024 * 1024);
      return success;
    };
    assert.equal(
      await runRemoteInstall({ assetsPath: f.assetsPath, connection, command }, { runner }),
      success.stdout,
    );
  }
});

test("config is private and never appears in argv; temporary directory is cleaned on success", async (t) => {
  const f = await fixture(t);
  let configPath = "";
  const config = {
    new_chat: "cmd+n",
    focus: "off",
    nested: { arbitrary: '$(touch /tmp/not-executed); "quoted"\n' },
  };
  const runner: RemoteRunner = async ({ args }) => {
    configPath = args[args.indexOf("--config") + 1];
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), config);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
    assert.ok(!args.join(" ").includes("not-executed"));
    return success;
  };
  await runRemoteInstall({ assetsPath: f.assetsPath, connection, command: "apply", config }, { runner });
  await assert.rejects(fs.stat(path.dirname(configPath)), { code: "ENOENT" });
});

test("config cleanup survives runner rejection and nonzero exit", async (t) => {
  const f = await fixture(t);
  for (const fail of [false, true]) {
    let configPath = "";
    await assert.rejects(
      runRemoteInstall(
        { assetsPath: f.assetsPath, connection, command: "apply", config: {} },
        {
          runner: async ({ args }) => {
            configPath = args.at(-1)!;
            if (fail) throw Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" });
            return { stdout: "", stderr: "Permission denied (publickey)", exitCode: 255 };
          },
        },
      ),
      fail ? /本机已安装 python3/ : /退出码 255.*\nPermission denied/,
    );
    await assert.rejects(fs.stat(path.dirname(configPath)), { code: "ENOENT" });
  }
});

test("invalid config, command and limits never call runner", async (t) => {
  const f = await fixture(t);
  const runner: RemoteRunner = async () => {
    throw new Error("must not run");
  };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const config of [
    null,
    [],
    new Date(),
    circular,
    { invalid: undefined },
    { invalid: BigInt(1) },
    { invalid: Infinity },
    { huge: "x".repeat(1024 * 1024) },
  ]) {
    await assert.rejects(
      runRemoteInstall(
        { assetsPath: f.assetsPath, connection, command: "apply", config: config as Record<string, unknown> },
        { runner },
      ),
      /配置/,
    );
  }
  await assert.rejects(
    runRemoteInstall({ assetsPath: f.assetsPath, connection, command: "apply;id" as "apply" }, { runner }),
    /命令无效/,
  );
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { maxOutputBytes: -1 },
    { timeoutMs: 2 ** 31 },
  ])
    await assert.rejects(
      runRemoteInstall({ assetsPath: f.assetsPath, connection, command: "status" }, { runner, ...options }),
      /正整数/,
    );
});

test("missing, escaping and damaged asset paths fail before execution", async (t) => {
  const f = await fixture(t);
  const run = (assetsPath = f.assetsPath) =>
    runRemoteInstall(
      { assetsPath, connection, command: "status" },
      {
        runner: async () => {
          throw new Error("must not run");
        },
      },
    );
  await assert.rejects(run("relative-assets"), /assetsPath 必须为绝对路径/);
  await assert.rejects(run(path.join(f.root, "missing")), /资源不可用/);
  // The intended removal targets are fixture files under the mkdtemp root above.
  await fs.unlink(f.script);
  const outside = path.join(f.root, "outside.py");
  await fs.writeFile(outside, "print('no')");
  await fs.symlink(outside, f.script);
  await assert.rejects(run(), /包内普通文件/);
  await fs.unlink(f.script);
  await fs.writeFile(f.script, "print('no')");
  await fs.writeFile(
    path.join(f.built.target, "runtime/manifest.json"),
    JSON.stringify({ files: { "../../outside.py": "bad" } }),
  );
  await assert.rejects(run(), /文件名无效/);
});

test("runner failures include bounded diagnostic output and signals", async (t) => {
  const f = await fixture(t);
  const input = { assetsPath: f.assetsPath, connection, command: "status" as const };
  await assert.rejects(
    runRemoteInstall(input, { runner: async () => ({ stdout: "fallback error", stderr: "", exitCode: 1 }) }),
    /fallback error/,
  );
  await assert.rejects(
    runRemoteInstall(input, {
      runner: async () => ({ stdout: "", stderr: "", exitCode: null, signal: "SIGTERM" }),
    }),
    /SIGTERM/,
  );
  await assert.rejects(
    runRemoteInstall(input, { maxOutputBytes: 5, runner: async () => success }),
    /输出超过限制/,
  );
});

test("long Python bootstrap errors preserve final exception and stdout diagnostics", async (t) => {
  const f = await fixture(t);
  for (const body of [
    `    import base64;exec(base64.b64decode('${"A".repeat(40000)}'))`,
    "warning\n".repeat(10000),
  ]) {
    await assert.rejects(
      runRemoteInstall(
        { assetsPath: f.assetsPath, connection, command: "apply" },
        {
          runner: async () => ({
            stdout: "partial progress diagnostic",
            stderr: `locale warning\nTraceback (most recent call last):\n${body}\nValueError: must restore before apply`,
            exitCode: 1,
          }),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ValueError: must restore before apply/);
        assert.match(error.message, /partial progress diagnostic/);
        assert.ok(error.message.length < 33500);
        return true;
      },
    );
  }
});

test("real subprocess returns stdout, reports failure, enforces timeout and combined output bound", async (t) => {
  const f = await fixture(t);
  const input = { assetsPath: f.assetsPath, connection, command: "status" as const };
  await fs.writeFile(f.script, "print('actual subprocess')\n");
  assert.equal(await runRemoteInstall(input), "actual subprocess\n");
  await fs.writeFile(f.script, "import sys\nprint('real failure', file=sys.stderr)\nsys.exit(7)\n");
  await assert.rejects(runRemoteInstall(input), /退出码 7.*\nreal failure/);
  await fs.writeFile(f.script, "import time\ntime.sleep(30)\n");
  await assert.rejects(runRemoteInstall({ ...input, config: {} }, { timeoutMs: 100 }), /执行超时/);
  await fs.writeFile(f.script, "import sys\nprint('x' * 5000)\nprint('y' * 5000, file=sys.stderr)\n");
  await assert.rejects(runRemoteInstall(input, { maxOutputBytes: 8000 }), /输出超过限制/);
});
