import { isDeepStrictEqual } from "node:util";
import { CommandArguments, AppFeature } from "../core/contracts";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseTree,
  getNodeValue,
  visit,
  modify,
  applyEdits,
  ParseError,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";
import { sha256 } from "../core/hash";
import { isMissing, writeAtomic } from "../core/storage";

export type IdeBinding = { key: string; command: string; args?: CommandArguments };
type LegacyState = { schema: 1; target: string; binding: IdeBinding; beforeHash: string; afterHash: string };
type State = { schema: 2; target: string; owner: string; command: string; legacy?: LegacyState };
export type BindingInspection = {
  kind: "managed" | "legacy" | "user" | "absent";
  enabled: boolean;
  hasInstallRecord: boolean;
  binding?: IdeBinding;
};

function document(source: string) {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`快捷键 JSONC 无效：${printParseErrorCode(errors[0].error)}，未修改。`);
  if (!root || root.type !== "array") throw new Error("快捷键文件必须是 JSONC 数组。");
  const nodes = root.children ?? [];
  return { nodes, values: nodes.map((node) => getNodeValue(node) as Record<string, unknown>) };
}
function edit(source: string, index: number, value: unknown) {
  return applyEdits(
    source,
    modify(source, [index], value, {
      isArrayInsertion: index === -1,
      formattingOptions: { insertSpaces: true, tabSize: 4, eol: source.includes("\r\n") ? "\r\n" : "\n" },
    }),
  );
}
function parsedArguments(value: unknown): CommandArguments | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return;
  const commands = (value as Record<string, unknown>).commands;
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) return;
  return { commands: [...commands] };
}

function globalBinding(value: unknown, command: string, args?: CommandArguments): IdeBinding | undefined {
  const v = value as Record<string, unknown> | null;
  return v &&
    typeof v.key === "string" &&
    v.command === command &&
    !Object.hasOwn(v, "when") &&
    (args ? isDeepStrictEqual(parsedArguments(v.args), args) : !Object.hasOwn(v, "args"))
    ? { key: v.key, command, ...(args ? { args } : {}) }
    : undefined;
}

export function appendBinding(source: string, binding: IdeBinding): string {
  const { values } = document(source);
  const last = globalBinding(values.at(-1), binding.command, binding.args);
  return last?.key === binding.key ? source : edit(source, -1, binding);
}

/** An explicit JSONC comment owns one parsed rule, not the whole settings file. */
export class IdeKeybindingInstaller {
  private readonly backup: string;
  private readonly stateFile: string;
  private readonly marker: string;
  constructor(
    readonly target: string,
    readonly dataDirectory: string,
    readonly binding: IdeBinding,
    readonly owner = binding.command,
    readonly previousCommands: readonly string[] = [],
  ) {
    if (/[\r\n]/.test(owner)) throw new Error("规则 owner 不能包含换行。");
    this.backup = path.join(dataDirectory, "before.jsonc");
    this.stateFile = path.join(dataDirectory, "state.json");
    this.marker = `// app-hook-studio:${owner}`;
  }

  private acceptsCommand(command: unknown): boolean {
    return (
      typeof command === "string" &&
      (command === this.binding.command || this.previousCommands.includes(command))
    );
  }
  private ownedBinding(value: unknown): IdeBinding | undefined {
    for (const command of [this.binding.command, ...this.previousCommands]) {
      const binding = globalBinding(
        value,
        command,
        command === this.binding.command ? this.binding.args : undefined,
      );
      if (binding) return binding;
    }
  }

  private async state(): Promise<State | undefined> {
    let v: unknown;
    try {
      v = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if ((v as { schema?: unknown })?.schema === 1) {
      const legacy = v as LegacyState;
      if (
        legacy.target !== this.target ||
        !this.acceptsCommand(legacy.binding?.command) ||
        typeof legacy.binding?.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(legacy.beforeHash) ||
        !/^[a-f0-9]{64}$/.test(legacy.afterHash) ||
        sha256(await fs.readFile(this.backup)) !== legacy.beforeHash
      )
        throw new Error("旧快捷键安装记录或备份不匹配。");
      return { schema: 2, target: this.target, owner: this.owner, command: this.binding.command, legacy };
    }
    const state = v as State;
    if (
      !state ||
      state.schema !== 2 ||
      state.target !== this.target ||
      state.owner !== this.owner ||
      !this.acceptsCommand(state.command)
    )
      throw new Error("快捷键安装记录不匹配，拒绝覆盖。");
    return state;
  }

  private locate(source: string, state?: State) {
    const parsed = document(source);
    const markers: { offset: number; length: number }[] = [];
    const thisOwner = this.owner;
    visit(source, {
      onComment(offset, length) {
        if (source.slice(offset, offset + length) === `// app-hook-studio:${thisOwner}`)
          markers.push({ offset, length });
      },
    });
    if (markers.length > 1) throw new Error("同一功能出现多个所有权标记，请先检查配置。");
    if (markers.length) {
      const marker = markers[0];
      const index = parsed.nodes.findIndex((node) => node.offset >= marker.offset + marker.length);
      if (index < 0 || !/^\s*$/.test(source.slice(marker.offset + marker.length, parsed.nodes[index].offset)))
        throw new Error("快捷键所有权标记位置异常。");
      return { ...parsed, index, marker, legacy: false };
    }
    if (state?.legacy && sha256(source) === state.legacy.afterHash) {
      const index = parsed.values.length - 1;
      const found = this.ownedBinding(parsed.values[index]);
      if (!found || found.key !== state.legacy.binding.key) throw new Error("旧安装规则与记录不一致。");
      return { ...parsed, index, marker: undefined, legacy: true };
    }
    return { ...parsed, index: -1, marker: undefined, legacy: false };
  }

  private async source(): Promise<string> {
    try {
      return await fs.readFile(this.target, "utf8");
    } catch (error) {
      if (isMissing(error)) return "[]\n";
      throw error;
    }
  }

  async preview(enabled: boolean): Promise<string> {
    return enabled ? this.install(true) : this.restore(true);
  }

  /** Legacy schema 2 has no snapshot hashes. Prove exact reconstruction before importing it. */
  async legacyBaseline() {
    const state = await this.state();
    const source = await this.source();
    const found = this.locate(source, state);
    let exists = true;
    try {
      await fs.stat(this.target);
    } catch (error) {
      if (!isMissing(error)) throw error;
      exists = false;
    }
    if (!state && found.index < 0)
      return {
        original: exists ? this.target : null,
        before: exists ? sha256(source) : null,
        after: exists ? sha256(source) : null,
      };
    const original = await fs.readFile(this.backup, "utf8");
    const before = sha256(original),
      after = exists ? sha256(source) : null;
    if (
      state?.legacy &&
      before === state.legacy.beforeHash &&
      [before, state.legacy.afterHash].includes(after!)
    )
      return { original: this.backup, before, after };
    if (source === original) return { original: this.backup, before, after };
    const binding = found.index >= 0 ? this.ownedBinding(found.values[found.index]) : undefined;
    if (state && binding && found.marker) {
      let candidate = edit(original, -1, binding);
      const node = document(candidate).nodes.at(-1)!;
      const indent =
        candidate.slice(candidate.lastIndexOf("\n", node.offset) + 1, node.offset).match(/^\s*/)?.[0] ?? "";
      candidate =
        candidate.slice(0, node.offset) +
        this.marker +
        (candidate.includes("\r\n") ? "\r\n" : "\n") +
        indent +
        candidate.slice(node.offset);
      if (candidate === source) return { original: this.backup, before, after };
    }
    throw new Error("旧快捷键备份无法精确重建当前安装（可能有后续修改），拒绝完整恢复。请保留现场与备份。");
  }

  async inspect(): Promise<BindingInspection> {
    const source = await this.source();
    const state = await this.state();
    const found = this.locate(source, state);
    if (found.index >= 0) {
      const binding = this.ownedBinding(found.values[found.index]);
      return {
        kind: found.legacy ? "legacy" : "managed",
        enabled: !!binding,
        hasInstallRecord: !!state,
        binding,
      };
    }
    const binding = found.values
      .map((value) => globalBinding(value, this.binding.command, this.binding.args))
      .reverse()
      .find(Boolean);
    return binding
      ? { kind: "user", enabled: true, hasInstallRecord: !!state, binding }
      : { kind: "absent", enabled: false, hasInstallRecord: !!state };
  }

  private async commit(source: string, candidate: string) {
    if (sha256(await this.source()) !== sha256(source))
      throw new Error("快捷键文件发生变化，未覆盖，请重新打开配置。");
    let mode = 0o600;
    try {
      mode = (await fs.stat(this.target)).mode & 0o777;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await fs.mkdir(path.dirname(this.target), { recursive: true });
    await writeAtomic(this.target, candidate, mode);
    if (sha256(await fs.readFile(this.target)) !== sha256(candidate))
      throw new Error("写入后校验失败，请检查配置。");
  }

  async install(preview = false): Promise<string> {
    const source = await this.source();
    const state = await this.state();
    const found = this.locate(source, state);
    const existing =
      found.index >= 0
        ? globalBinding(found.values[found.index], this.binding.command, this.binding.args)
        : undefined;
    if (existing?.key === this.binding.key && !found.legacy)
      return preview ? source : "快捷键已经安装，无需重复写入。";
    if (found.index < 0 && appendBinding(source, this.binding) === source)
      return preview ? source : "已有相同用户规则；不接管用户规则。";
    if (found.index < 0 && state?.legacy && sha256(source) !== state.legacy.beforeHash) {
      // Old snapshots have no per-rule ownership. Only migrate their exact recorded bytes.
      const raw = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as { schema?: number };
      if (raw.schema === 1)
        throw new Error("旧规则尚未迁移且文件已有其他修改，无法证明规则所有权，请手动检查。");
    }
    let candidate = edit(source, found.index >= 0 ? found.index : -1, this.binding);
    if (!found.marker) {
      const index = found.index >= 0 ? found.index : document(candidate).nodes.length - 1;
      const node = document(candidate).nodes[index];
      const indent =
        candidate.slice(candidate.lastIndexOf("\n", node.offset) + 1, node.offset).match(/^\s*/)?.[0] ?? "";
      candidate =
        candidate.slice(0, node.offset) +
        this.marker +
        (candidate.includes("\r\n") ? "\r\n" : "\n") +
        indent +
        candidate.slice(node.offset);
    }
    document(candidate);
    if (preview) return candidate;
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(this.backup, source, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    await writeAtomic(
      this.stateFile,
      JSON.stringify(
        {
          ...(state ?? {}),
          schema: 2,
          target: this.target,
          owner: this.owner,
          command: this.binding.command,
        },
        null,
        2,
      ) + "\n",
    );
    await this.commit(source, candidate);
    return found.index >= 0 ? "已更新此功能的快捷键，其他用户配置保留。" : "已安装此功能的全局快捷键。";
  }

  async restore(preview = false): Promise<string> {
    const state = await this.state();
    const source = await this.source();
    const found = this.locate(source, state);
    if (found.index < 0) return preview ? source : "没有本工具拥有的规则，不修改用户配置。";
    if (found.legacy) {
      const original = await fs.readFile(this.backup, "utf8");
      if (!state?.legacy || sha256(original) !== state.legacy.beforeHash) throw new Error("旧备份不匹配。");
      if (preview) return original;
      await this.commit(source, original);
    } else {
      const marker = found.marker!;
      const unmarked = source.slice(0, marker.offset) + source.slice(marker.offset + marker.length);
      const candidate = edit(unmarked, found.index, undefined);
      if (preview) return candidate;
      await this.commit(source, candidate);
    }
    return "已移除此功能的规则，其他用户配置保留。";
  }
}

/** One owner constructs the full command (including runCommands args and explicit migrations). */
export function featureKeybindingInstaller(
  feature: Extract<AppFeature, { kind: "ide-keybinding" }>,
  directory: string,
  key = feature.defaultShortcut,
) {
  return new IdeKeybindingInstaller(
    feature.targetFile,
    directory,
    {
      key,
      command: feature.command,
      ...(feature.commandArguments ? { args: feature.commandArguments } : {}),
    },
    feature.id,
    feature.previousCommands,
  );
}
