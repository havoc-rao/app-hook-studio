import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type RemoteConnection = { host: string; port: string; python: string };
export type RemoteCommand = "preflight" | "status" | "apply" | "restore";
export type RemoteVerifiedTarget = {
  commit: string;
  appVersion: string;
  extensionVersion: string;
  base: string;
};

/** Accept only the complete, successful preflight document; never infer verification from logs. */
export function parseRemotePreflight(output: string): RemoteVerifiedTarget {
  try {
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    const record = result as Record<string, unknown>;
    if (record.ok !== true || record.command !== "preflight" || record.checksPassed !== true)
      throw new Error();
    const target = record.target;
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error();
    const { commit, appVersion, extensionVersion, base } = target as Record<string, unknown>;
    if (
      typeof commit !== "string" ||
      !/^[a-fA-F0-9]{40}$/.test(commit) ||
      typeof appVersion !== "string" ||
      !appVersion.trim() ||
      typeof extensionVersion !== "string" ||
      !extensionVersion.trim() ||
      typeof base !== "string" ||
      !path.posix.isAbsolute(base) ||
      base.includes("\0")
    )
      throw new Error();
    return { commit, appVersion, extensionVersion, base };
  } catch {
    throw new Error("远程预检查结果无效：需要完整成功的 preflight、checksPassed 和已验证版本 target。");
  }
}
export type RemoteProcessRequest = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
};
export type RemoteProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
};
export type RemoteRunner = (request: RemoteProcessRequest) => Promise<RemoteProcessResult>;
export type RemoteInstallOptions = { runner?: RemoteRunner; timeoutMs?: number; maxOutputBytes?: number };

/** Validate a single SSH destination (including SSH aliases and IPv6), not an SSH command. */
export function validateRemoteConnection(value: RemoteConnection): RemoteConnection {
  if (
    !value ||
    typeof value.host !== "string" ||
    typeof value.port !== "string" ||
    typeof value.python !== "string"
  )
    throw new Error("远程连接需要 host、port、python 字符串。");
  const host = value.host.trim(),
    port = value.port.trim(),
    python = value.python.trim();
  if (
    host.length > 512 ||
    !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.:-]*|:[A-Fa-f0-9:]+|\[[A-Fa-f0-9:.]+\])$/.test(
      host,
    )
  )
    throw new Error("SSH 主机无效；请填写 host 或 user@host，不能包含选项、空白或命令。");
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("SSH 端口必须为 1–65535 的整数。");
  if (python.length > 1024 || !/^(?:\/[A-Za-z0-9_./+-]+|[A-Za-z0-9_][A-Za-z0-9_.+-]*)$/.test(python))
    throw new Error("远程 Python 必须为可执行文件名或绝对路径，不能包含空白、选项或命令。");
  return { host, port: String(Number(port)), python };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve only packaged assets, and reject symlinks escaping the asset directory. */
async function packagedScript(assetsPath: string): Promise<string> {
  try {
    if (typeof assetsPath !== "string" || !path.isAbsolute(assetsPath))
      throw new Error("assetsPath 必须为绝对路径");
    const assets = await fs.realpath(assetsPath);
    const root = await fs.realpath(path.join(assets, "remote-hotkeys"));
    if (!inside(assets, root)) throw new Error("remote-hotkeys 路径越界");
    const file = async (relative: string) => {
      const target = path.resolve(root, relative);
      if (!inside(root, target)) throw new Error("资源路径越界");
      const resolved = await fs.realpath(target);
      if (!inside(root, resolved) || !(await fs.stat(resolved)).isFile())
        throw new Error("资源不是包内普通文件");
      return resolved;
    };
    const script = await file("remote_hotkeys.py");
    await file("hotkeys.py");
    const manifest = JSON.parse(await fs.readFile(await file("runtime/manifest.json"), "utf8"));
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files))
      throw new Error("runtime 清单无效");
    for (const name of Object.keys(manifest.files)) {
      if (!name || path.basename(name) !== name || name === "." || name === "..")
        throw new Error("runtime 文件名无效");
      await file(`runtime/${name}`);
    }
    return script;
  } catch (error) {
    throw new Error(
      `远程安装资源不可用，请先运行 build-remote 并打包 assets/remote-hotkeys：${message(error)}`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No shell; terminate the Python/SSH process group on timeout or excess combined output. */
const processRunner: RemoteRunner = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONPATH: "", PYTHONIOENCODING: "utf-8" },
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      failure: Error | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = new Error(reason);
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Process may already have exited. */
      }
    };
    const timer = setTimeout(
      () => stop(`执行超时（${request.timeoutMs}ms）；已停止本机 Python/SSH，远程写入状态可能需重新检查。`),
      request.timeoutMs,
    );
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > request.maxOutputBytes)
        stop(`进程输出超过限制（${request.maxOutputBytes} bytes），已停止执行。`);
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
          signal,
        });
    });
  });

// Constant shell code: no user-provided strings are interpolated into this command.
// Probe interpreters rather than trusting names (python3 may still be Python 3.6).
const PYTHON_PROBE = `
probe_python() {
  [ -n "$1" ] || return
  "$1" -c 'import sys,json; sys.exit(1) if sys.version_info < (3,9) else None; print("AHS_PYTHON="+json.dumps(sys.executable))' 2>/dev/null
}
for name in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python3.9; do
  candidate=$(command -v "$name" 2>/dev/null) || continue
  probe_python "$candidate" && exit 0
done
if [ -n "$CONDA_PREFIX" ] && [ -x "$CONDA_PREFIX/bin/python3" ]; then
  probe_python "$CONDA_PREFIX/bin/python3" && exit 0
fi
for candidate in "$HOME"/miniconda3/bin/python3 "$HOME"/anaconda3/bin/python3 "$HOME"/miniforge3/bin/python3 /opt/conda/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  [ -x "$candidate" ] || continue
  probe_python "$candidate" && exit 0
done
printf '%s\\n' 'No Python 3.9+ found in PATH or common Conda locations; specify an absolute interpreter path.' >&2
exit 1
`;

export async function discoverRemotePython(
  value: RemoteConnection,
  options: RemoteInstallOptions = {},
): Promise<string> {
  const connection = validateRemoteConnection(value);
  const result = await (options.runner ?? processRunner)({
    executable: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-p",
      connection.port,
      "--",
      connection.host,
      PYTHON_PROBE,
    ],
    cwd: tmpdir(),
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `自动检测远端 Python 失败：${result.stderr || result.stdout || result.signal || result.exitCode}`,
    );
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("AHS_PYTHON=")) continue;
    const python: unknown = JSON.parse(line.slice("AHS_PYTHON=".length));
    if (typeof python !== "string" || !path.posix.isAbsolute(python)) continue;
    return validateRemoteConnection({ ...connection, python }).python;
  }
  throw new Error("未收到有效的 Python 3.9+ 检测结果；请手动填写远端解释器绝对路径。");
}

/** Runs the existing Python installer. config is a quickstart JSON object, not Raycast settings. */
export async function runRemoteInstall(
  input: {
    assetsPath: string;
    connection: RemoteConnection;
    command: RemoteCommand;
    config?: Record<string, unknown>;
    expectedCommit?: string;
  },
  options: RemoteInstallOptions = {},
): Promise<string> {
  const connection = validateRemoteConnection(input.connection);
  if (!["preflight", "status", "apply", "restore"].includes(input.command))
    throw new Error("远程安装命令无效。");
  if (
    input.expectedCommit !== undefined &&
    (typeof input.expectedCommit !== "string" || !/^[a-fA-F0-9]{40}$/.test(input.expectedCommit))
  )
    throw new Error("expectedCommit 必须为严格 40 位十六进制 commit。");
  const timeoutMs = options.timeoutMs ?? 120_000,
    maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1
  )
    throw new Error("进程超时和输出上限必须为正整数（超时最多 2147483647ms）。");
  let configText: string | undefined;
  if (input.config !== undefined) {
    if (
      !input.config ||
      typeof input.config !== "object" ||
      Array.isArray(input.config) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input.config))
    )
      throw new Error("远程配置必须为 JSON 对象。");
    try {
      configText = JSON.stringify(input.config, (_key, value: unknown) => {
        if (
          ["undefined", "function", "symbol", "bigint"].includes(typeof value) ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          throw new Error("包含非 JSON 值");
        return value;
      });
      if (!configText || !configText.startsWith("{") || Buffer.byteLength(configText) > 1024 * 1024)
        throw new Error("配置无效或超过 1 MiB");
    } catch (error) {
      throw new Error(`远程配置必须为可序列化 JSON 对象：${message(error)}`);
    }
  }
  const script = await packagedScript(input.assetsPath);
  if (connection.python === "auto") connection.python = await discoverRemotePython(connection, options);
  let temporary: string | undefined;
  try {
    const args = [
      "-B",
      script,
      input.command,
      "--host",
      connection.host,
      "--port",
      connection.port,
      "--python",
      connection.python,
    ];
    if (input.expectedCommit !== undefined) args.push("--expected-commit", input.expectedCommit);
    if (configText !== undefined) {
      temporary = await fs.mkdtemp(path.join(tmpdir(), "app-hook-studio-remote-"));
      await fs.chmod(temporary, 0o700);
      const configPath = path.join(temporary, "config.json");
      await fs.writeFile(configPath, configText, { mode: 0o600, flag: "wx" });
      args.push("--config", configPath);
    }
    const result = await (options.runner ?? processRunner)({
      executable: "python3",
      args,
      cwd: path.dirname(script),
      timeoutMs,
      maxOutputBytes,
    });
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes)
      throw new Error(`进程输出超过限制（${maxOutputBytes} bytes）。`);
    if (result.exitCode !== 0) {
      // Python 3.13 tracebacks can echo the entire Base64 bootstrap on one line.
      // Never truncate the head alone: the actual exception is at the end.
      const diagnostic = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n\nstdout:\n");
      const compact = diagnostic.replace(
        /^([ \t]*)import base64;exec\(base64\.b64decode\([^\r\n]*$/gm,
        "$1[Base64 启动代码已省略，后续异常保留]",
      );
      const detail =
        compact.length > 32768
          ? `${compact.slice(0, 4096)}\n[…中间日志已省略，保留末尾异常…]\n${compact.slice(-28672)}`
          : compact;
      throw new Error(
        `进程${result.signal ? `被信号 ${result.signal} 终止` : `退出码 ${result.exitCode}`}。${detail ? `\n${detail}` : ""}`,
      );
    }
    return result.stdout;
  } catch (error) {
    throw new Error(
      `远程 ${input.command} 失败：${message(error)}${(error as NodeJS.ErrnoException)?.code === "ENOENT" ? "；请确认本机已安装 python3 且 Raycast PATH 可用。" : ""}`,
    );
  } finally {
    // This exact directory was returned by mkdtemp above; never derive a cleanup target from user input.
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}
