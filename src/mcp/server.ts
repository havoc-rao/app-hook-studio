import { listPendingApprovals, respondToApproval } from "../apps/codebuddy-cn/approval-client";
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_ADAPTERS } from "../apps/registry";
import { DATA_ROOT, loadConfig } from "../core/storage";
import { prepareAppInstall } from "../application/app-install";
import { recipeAdapter } from "../recipes/adapter";
import { featureSchema, recipeSchema } from "../recipes/schema";
import {
  getRecipe,
  recipeRevision,
  registeredRecipes,
  registerRecipe,
  validateRecipe,
} from "../recipes/store";

export function createMcpServer(root = DATA_ROOT) {
  const server = new McpServer(
    { name: "app-hook-studio", version: "0.1.0" },
    {
      instructions:
        "Local App Hook Studio registration service. Call get_recipe_schema first. Validate recipes before registering. Registration writes local metadata only, never App resources. Install remains in Raycast. Runtime approval tools query/respond to existing pending requests through private local sockets; responding may execute the requested tool and requires a fresh request ID. Supports one exact-build script resource and dom-keyboard/v1; built-in adapters cannot be extended through this driver. Action code is untrusted target code: never execute it during analysis/registration. Runtime verification is caller-reported, static preflight is not runtime proof.",
    },
  );
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const guarded = async (work: () => Promise<unknown> | unknown) => {
    try {
      return result(await work());
    } catch (error) {
      return { ...result({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  };
  server.registerTool(
    "get_recipe_schema",
    {
      description:
        "Get executable Recipe v2 JSON Schema and driver constraints. Old design-example Recipe v1 is not executable.",
      inputSchema: {},
      annotations: read,
    },
    async () =>
      guarded(() => ({
        schema: z.toJSONSchema(recipeSchema, { target: "draft-7" }),
        driver: "dom-keyboard/v1",
        actionContext: ["event", "root"],
        limits:
          "One UTF-8 classic-script resource per App; exact original SHA-256; unique statement-boundary anchor. No ESM/ASAR/native binaries or React hooks. Existing installed recipe must be restored before implementation/profile updates. Feature IDs preserve enabled/shortcut settings across updates.",
      })),
  );
  server.registerTool(
    "list_apps",
    {
      description:
        "List built-in and registered Apps, revisions, supported versions, feature IDs and catalog errors. Does not claim live compatibility.",
      inputSchema: {},
      annotations: read,
    },
    async () =>
      guarded(async () => {
        const loaded = await registeredRecipes(root);
        return {
          apps: [
            ...APP_ADAPTERS.map((a) => ({
              id: a.id,
              title: a.title,
              source: "built-in",
              appPath: a.defaultAppPath,
              supported: a.versions?.supported,
              items: a.features.map((f) => ({ id: f.id, title: f.title })),
            })),
            ...loaded.recipes.map((r) => ({
              id: r.id,
              title: r.title,
              source: "recipe",
              appPath: r.appPath,
              supportedVersion: r.profile.appVersion,
              revision: recipeRevision(r),
              items: r.features.map((f) => ({ id: f.id, title: f.title })),
            })),
          ],
          errors: loaded.errors,
        };
      }),
  );
  server.registerTool(
    "get_app",
    {
      description:
        "Read App registration and saved settings. Registered recipes include action source and Evidence; not executed.",
      inputSchema: { appId: z.string() },
      annotations: read,
    },
    async ({ appId }) =>
      guarded(async () => {
        const built = APP_ADAPTERS.find((a) => a.id === appId);
        if (built)
          return {
            id: built.id,
            source: "built-in",
            supported: built.versions?.supported,
            features: built.features.map(({ id, title, kind, description }) => ({
              id,
              title,
              kind,
              description,
            })),
            config: await loadConfig(built, path.join(root, "apps", appId)),
          };
        const recipe = await getRecipe(appId, root);
        return {
          recipe,
          revision: recipeRevision(recipe),
          config: await loadConfig(recipeAdapter(recipe), path.join(root, "apps", appId)),
        };
      }),
  );
  const fileInput = {
    recipePath: z
      .string()
      .describe(
        "Absolute path to agent-produced Recipe v2 JSON file; avoids sending bridge source through tool context.",
      ),
  };
  const readFile = async (file: string) => {
    if (!path.isAbsolute(file)) throw new Error("recipePath must be absolute");
    return JSON.parse(await fs.readFile(file, "utf8"));
  };
  server.registerTool(
    "validate_recipe",
    {
      description:
        "Read Recipe file and validate schema, action syntax, target version/digest, unique mount and candidate script. No writes or target code execution.",
      inputSchema: fileInput,
      annotations: read,
    },
    async ({ recipePath }) =>
      guarded(async () => {
        const { recipe, report } = await validateRecipe(await readFile(recipePath), root);
        return {
          id: recipe.id,
          compatible: report.compatible,
          runtimeStatus: recipe.evidence.runtimeStatus,
          checks: report.checks,
        };
      }),
  );
  server.registerTool(
    "register_app",
    {
      description:
        "Register a validated executable recipe (not a draft). Writes local metadata only. Existing IDs require expectedRevision from get_app. Does not install or execute actions.",
      inputSchema: { ...fileInput, expectedRevision: z.string().optional() },
      annotations: write,
    },
    async ({ recipePath, expectedRevision }) =>
      guarded(async () => registerRecipe(await readFile(recipePath), expectedRevision, root)),
  );
  server.registerTool(
    "register_items",
    {
      description:
        "Append features from a JSON array file to an existing registered recipe. Built-in Apps require driver implementation, not this tool. Preserves existing feature definitions and saved settings; no App writes.",
      inputSchema: { appId: z.string(), itemsPath: z.string(), expectedRevision: z.string() },
      annotations: write,
    },
    async ({ appId, itemsPath, expectedRevision }) =>
      guarded(async () => {
        const recipe = await getRecipe(appId, root);
        const features = z
          .array(featureSchema)
          .min(1)
          .parse(await readFile(itemsPath));
        return registerRecipe(
          { ...recipe, features: [...recipe.features, ...features] },
          expectedRevision,
          root,
        );
      }),
  );
  server.registerTool(
    "preflight_app",
    {
      description:
        "Read-only whole-App installation plan using saved enabled/shortcut settings. Fresh compatibility check; no installation authority.",
      inputSchema: { appId: z.string() },
      annotations: read,
    },
    async ({ appId }) =>
      guarded(async () => {
        const adapter =
          APP_ADAPTERS.find((a) => a.id === appId) ?? recipeAdapter(await getRecipe(appId, root));
        const { execute: _execute, ...plan } = await prepareAppInstall(
          adapter,
          path.join(root, "apps", appId),
        );
        return plan;
      }),
  );
  server.registerTool(
    "list_pending_approvals",
    {
      description:
        "List current CodeBuddy tool approval requests across active local windows. Includes tool input, reason, session and a fresh per-confirmation request_id.",
      inputSchema: {},
      annotations: read,
    },
    async () => guarded(() => listPendingApprovals()),
  );
  server.registerTool(
    "respond_to_approval",
    {
      description:
        "Submit an explicit user decision for one pending CodeBuddy confirmation. allow may execute that tool; reject and skip use the original app paths. A submitted response is not proof that tool execution succeeded. Stale IDs are rejected.",
      inputSchema: { requestId: z.string().min(1), action: z.enum(["allow", "reject", "skip"]) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ requestId, action }) => guarded(() => respondToApproval(requestId, action)),
  );
  return server;
}
