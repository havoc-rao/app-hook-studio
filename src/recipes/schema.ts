import { z } from "zod";
import path from "node:path";
const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const relative = z
  .string()
  .min(1)
  .refine(
    (v) => !path.isAbsolute(v) && !v.split(/[\\/]/).includes("..") && !v.includes("\\"),
    "Expected package-relative path without traversal",
  );
export const featureSchema = z
  .object({
    id,
    title: z.string().min(1),
    description: z.string(),
    enabled: z.boolean().default(true),
    shortcut: z.string().min(1),
    trigger: z.enum(["shortcut", "double-escape"]).default("shortcut"),
    withinMs: z.number().int().positive().default(500),
    action: z
      .string()
      .min(1)
      .describe(
        "JavaScript function body executed only inside target App on matching keyboard event. Variables: event, root. No execution in MCP/Raycast.",
      ),
  })
  .strict();
export const recipeSchema = z
  .object({
    schemaVersion: z.literal(2),
    id,
    title: z.string().min(1),
    appPath: z.string().refine((v) => path.isAbsolute(v) && v.endsWith(".app")),
    profile: z
      .object({
        id,
        appVersion: z.string().min(1),
        assertions: z
          .array(
            z
              .object({ file: relative, pointer: z.string().regex(/^\//), equals: z.string().min(1) })
              .strict(),
          )
          .min(1),
        resource: z.object({ path: relative, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        mount: z
          .object({
            driver: z.literal("dom-keyboard/v1"),
            anchor: z.string().min(1),
            placement: z.enum(["before", "after"]),
            rootSelector: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    features: z.array(featureSchema).min(1),
    evidence: z
      .object({
        sources: z.array(z.string().min(1)).min(1),
        runtimeStatus: z.enum(["not-tested", "tested"]),
        notes: z.string(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (recipe) => recipe.profile.assertions[0].equals === recipe.profile.appVersion,
    "First version assertion must match appVersion",
  );
export type Recipe = z.infer<typeof recipeSchema>;
