import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";

export type ApprovalAction = "allow" | "reject" | "skip";
export type PendingApproval = {
  request_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd: string;
  subagent: boolean;
  reason: string;
  created_at: number;
  expires_at: number;
  approval_channel: { protocol: 1; transport: "unix"; socket_path: string; window_id: string };
};
export const approvalDirectory = () => `/tmp/ahs-codebuddy-${process.getuid!()}`;

/** One newline-delimited request and response per connection. */
export function approvalRequest(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "",
      done = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      socket.destroy();
      error ? reject(error) : resolve(value!);
    };
    socket.setTimeout(5000, () => finish(new Error("Approval channel timed out")));
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("Approval channel closed without a complete response")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024)
        return finish(new Error("Approval response too large"));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, end));
        if (value.protocol !== 1 || typeof value.ok !== "boolean")
          throw new Error("Invalid approval response");
        if (!value.ok)
          throw Object.assign(new Error(value.error?.message || "Approval request failed"), {
            code: value.error?.code,
          });
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function listPendingApprovals(directory = approvalDirectory()) {
  const uid = process.getuid!();
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o077)
      throw new Error("Approval directory must be private and owned by the current user");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { requests: [] as PendingApproval[], windows: [] as string[], unavailable: [] as string[] };
    throw error;
  }
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sock.json"));
  const results = await Promise.allSettled(
    files.map(async (name) => {
      const manifest = path.join(directory, name);
      const stat = await fs.lstat(manifest);
      if (!stat.isFile() || stat.uid !== uid || stat.mode & 0o077)
        throw new Error("Invalid channel manifest");
      const value = JSON.parse(await fs.readFile(manifest, "utf8"));
      const socketPath = path.join(directory, name.slice(0, -5));
      if (value.protocol !== 1 || value.socket_path !== socketPath || typeof value.window_id !== "string")
        throw new Error("Invalid channel identity");
      const socketStat = await fs.lstat(socketPath);
      if (!socketStat.isSocket() || socketStat.uid !== uid || socketStat.mode & 0o077)
        throw new Error("Invalid channel socket permissions");
      const response = await approvalRequest(socketPath, { protocol: 1, op: "list" });
      if (response.window_id !== value.window_id || !Array.isArray(response.requests))
        throw new Error("Channel window mismatch");
      for (const request of response.requests) {
        if (
          typeof request.request_id !== "string" ||
          request.approval_channel?.socket_path !== socketPath ||
          request.approval_channel?.window_id !== value.window_id
        )
          throw new Error("Invalid pending request identity");
      }
      return { windowId: value.window_id as string, requests: response.requests as PendingApproval[] };
    }),
  );
  const requests: PendingApproval[] = [],
    windows: string[] = [],
    unavailable: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      windows.push(result.value.windowId);
      requests.push(...result.value.requests);
    } else unavailable.push(files[index]);
  });
  return { requests, windows, unavailable };
}

export async function respondToApproval(
  requestId: string,
  action: ApprovalAction,
  directory = approvalDirectory(),
) {
  if (!["allow", "reject", "skip"].includes(action)) throw new Error("Expected allow, reject or skip");
  const current = await listPendingApprovals(directory);
  const matches = current.requests.filter((request) => request.request_id === requestId);
  if (matches.length !== 1)
    throw Object.assign(new Error("Request is no longer pending or its window is unavailable"), {
      code: "NOT_PENDING",
    });
  return approvalRequest(matches[0].approval_channel.socket_path, {
    protocol: 1,
    op: "respond",
    request_id: requestId,
    action,
  });
}
