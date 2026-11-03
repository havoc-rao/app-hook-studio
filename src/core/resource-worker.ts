import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type ResourceOperation = "inspect" | "preflight" | "apply" | "restore" | "adopt";
let workerScript: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
export function configureResourceWorker(script: string): void {
  workerScript = script;
}

/** Resource bytes stay in the child. Only compact reports cross this boundary. */
export function resourceOperation<T>(
  adapterId: string,
  operation: ResourceOperation,
  directory: string,
  input: unknown,
): Promise<T> {
  const request = { protocol: 1, adapterId, operation, directory, input };
  const work = queue.then(async () => {
    const script = workerScript ?? path.resolve(__dirname, "../../assets/resource-worker.cjs");
    let stdout: string;
    try {
      ({ stdout } = await execute(
        process.execPath,
        ["--max-old-space-size=256", script, JSON.stringify(request)],
        {
          maxBuffer: 128 * 1024,
          // Read-only work is safe to stop. Mutations retain ownership until their atomic-write cleanup completes.
          timeout: operation === "preflight" || operation === "inspect" ? 30_000 : undefined,
          windowsHide: true,
        },
      ));
    } catch (error) {
      const failure = error as { message?: string; stderr?: string };
      throw new Error(
        `独立资源处理进程失败，保留已有备份；如发生在写入阶段请重新检查状态：${failure.stderr?.slice(-1600) || failure.message || String(error)}`,
      );
    }
    const response: unknown = JSON.parse(stdout);
    if (!response || typeof response !== "object") throw new Error("资源处理进程返回无效协议。");
    const value = response as Record<string, unknown>;
    if (value.protocol !== 1 || typeof value.ok !== "boolean")
      throw new Error("资源处理进程版本不匹配，请重新构建并安装扩展。");
    if (!value.ok) throw new Error(typeof value.error === "string" ? value.error : "资源处理失败。");
    if (!Object.hasOwn(value, "result")) throw new Error("资源处理进程缺少结果。");
    return value.result as T;
  });
  queue = work.then(
    () => undefined,
    () => undefined,
  );
  return work;
}
