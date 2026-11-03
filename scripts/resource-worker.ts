import { PatchEngine } from "../src/core/engine";
import { focusHostAdapter } from "../src/apps/codebuddy-cn/focus-host";
import { AppConfig } from "../src/core/contracts";

async function main() {
  const value: unknown = JSON.parse(process.argv[2] ?? "null");
  if (!value || typeof value !== "object") throw new Error("Invalid resource request");
  const request = value as Record<string, unknown>;
  if (request.protocol !== 1) throw new Error("Resource protocol mismatch");
  if (request.operation === "health") return { protocol: 1 };
  if (request.adapterId !== focusHostAdapter.id || typeof request.directory !== "string")
    throw new Error("Unknown resource adapter");
  const engine = new PatchEngine(focusHostAdapter, request.directory, { inline: true });
  switch (request.operation) {
    case "preflight":
      return engine.preflight(request.input);
    case "apply":
      return engine.apply(request.input as AppConfig);
    case "inspect":
    case "restore":
    case "adopt": {
      if (typeof request.input !== "string") throw new Error("App path must be a string");
      return engine[request.operation](request.input);
    }
    default:
      throw new Error("Unknown resource operation");
  }
}
main()
  .then((result) => process.stdout.write(JSON.stringify({ protocol: 1, ok: true, result })))
  .catch((error: unknown) => {
    process.stdout.write(
      JSON.stringify({
        protocol: 1,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
