import { codexCliRule } from "./rule";
export const CLI_ADAPTERS = [
  { ...codexCliRule, id: "codex-cli", title: "Codex CLI", description: "终端与 CoLink 双入口审批" },
] as const;
