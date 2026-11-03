export type Shortcut = {
  code: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

const codes: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  ".": "Period",
  period: "Period",
  ",": "Comma",
  comma: "Comma",
  "/": "Slash",
  slash: "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

export function parseShortcut(text: string): Shortcut {
  const shortcut: Shortcut = { code: "", ctrl: false, meta: false, alt: false, shift: false };
  const parts = text
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const aliases: Record<string, "ctrl" | "meta" | "alt" | "shift"> = {
    ctrl: "ctrl",
    control: "ctrl",
    cmd: "meta",
    command: "meta",
    meta: "meta",
    alt: "alt",
    option: "alt",
    opt: "alt",
    shift: "shift",
  };
  for (const part of parts) {
    const modifier = aliases[part];
    if (modifier) {
      if (shortcut[modifier]) throw new Error(`修饰键重复：${part}`);
      shortcut[modifier] = true;
      continue;
    }
    const code =
      codes[part] ??
      (/^[a-z]$/.test(part)
        ? `Key${part.toUpperCase()}`
        : /^\d$/.test(part)
          ? `Digit${part}`
          : /^f([1-9]|1[0-9]|2[0-4])$/.test(part)
            ? part.toUpperCase()
            : undefined);
    if (!code || shortcut.code) throw new Error(`无效快捷键：${text}。例如 ctrl+cmd+n、cmd+alt+.。`);
    shortcut.code = code;
  }
  if (!shortcut.code) throw new Error("快捷键需要一个按键，不能只有修饰键。");
  return shortcut;
}

export function toIdeShortcut(text: string): string {
  const key = parseShortcut(text);
  if (!key.meta && !key.ctrl && !key.alt) throw new Error("请使用 Cmd、Ctrl、Option 中至少一个修饰键。");
  const special: Record<string, string> = {
    Period: ".",
    Comma: ",",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
    Space: "space",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };
  const letter = key.code.startsWith("Key")
    ? key.code.slice(3).toLowerCase()
    : key.code.startsWith("Digit")
      ? key.code.slice(5)
      : (special[key.code] ?? key.code.toLowerCase());
  return [
    ...(key.ctrl ? ["ctrl"] : []),
    ...(key.meta ? ["cmd"] : []),
    ...(key.alt ? ["alt"] : []),
    ...(key.shift ? ["shift"] : []),
    letter,
  ].join("+");
}
