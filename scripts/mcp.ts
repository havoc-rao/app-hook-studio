import path from "node:path";
import { configureResourceWorker } from "../src/core/resource-worker";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../src/mcp/server";
import { parseArgs } from "node:util";
configureResourceWorker(path.join(__dirname, "../assets/resource-worker.cjs"));
const { values } = parseArgs({ options: { "data-root": { type: "string" } } });
createMcpServer(values["data-root"])
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
