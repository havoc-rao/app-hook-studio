#!/usr/bin/env python3
"""Standalone CodeBuddy three-hotkey quickstart. Python 3.9+, standard library only."""
from __future__ import annotations
import argparse
import errno
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
MARKER = "// app-hook-studio:focus-input"
NEW_CHAT_MARKER = "// app-hook-studio:new-chat"
NEW_CHAT_COMMAND = "tencentcloud.codingcopilot.chat.startNewChat"
BACKUP_RELATIVE = "Contents/Resources/codebuddy-hotkeys-quickstart-backup"
DEFAULTS = {"app": "/Applications/CodeBuddy CN.app", "new_chat": "ctrl+cmd+n", "stop": "esc,esc", "focus": "cmd+i", "double_escape_ms": 500, "scope": "panel"}
CODES = {"esc": "Escape", "escape": "Escape", "enter": "Enter", "return": "Enter", "tab": "Tab", "space": "Space", "backspace": "Backspace", "delete": "Delete", ".": "Period", "period": "Period", ",": "Comma", "comma": "Comma", "/": "Slash", "slash": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote", "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight"}
ALIASES = {"ctrl": "ctrl", "control": "ctrl", "cmd": "meta", "command": "meta", "meta": "meta", "alt": "alt", "option": "alt", "opt": "alt", "shift": "shift"}


def digest(data):
    return None if data is None else hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def optional_read(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def shortcut(text):
    if not isinstance(text, str):
        raise ValueError("快捷键必须是字符串。")
    key = {"code": "", "ctrl": False, "meta": False, "alt": False, "shift": False}
    for part in text.lower().split("+"):
        part = part.strip()
        if part in ALIASES:
            modifier = ALIASES[part]
            if key[modifier]:
                raise ValueError("修饰键重复：" + part)
            key[modifier] = True
            continue
        code = CODES.get(part)
        if not code and re.fullmatch("[a-z]", part):
            code = "Key" + part.upper()
        if not code and re.fullmatch("[0-9]", part):
            code = "Digit" + part
        if not code and re.fullmatch(r"f([1-9]|1[0-9]|2[0-4])", part):
            code = part.upper()
        if not code or key["code"]:
            raise ValueError("无效快捷键：" + text)
        key["code"] = code
    if not key["code"]:
        raise ValueError("快捷键需要一个物理按键。")
    return key


def ide_key(text):
    key = shortcut(text)
    if not (key["ctrl"] or key["meta"] or key["alt"]):
        raise ValueError("聚焦快捷键至少需要 Cmd、Ctrl 或 Option。")
    code = key["code"]
    reverse = {value: name for name, value in CODES.items()}
    reverse.update({"Escape": "escape", "Enter": "enter", "Period": ".", "Comma": ",", "Slash": "/"})
    physical = code[3:].lower() if code.startswith("Key") else code[5:] if code.startswith("Digit") else reverse.get(code, code.lower())
    return "+".join([name for field, name in [("ctrl", "ctrl"), ("meta", "cmd"), ("alt", "alt"), ("shift", "shift")] if key[field]] + [physical])


def settings(value):
    """Same canonical field order and runtime JSON as the project's TS producer."""
    if not isinstance(value, dict) or type(value.get("newChatEnabled")) is not bool:
        raise ValueError("补丁配置无效。")
    for field in ("newChatShortcut", "stopShortcut"):
        if not isinstance(value.get(field), str):
            raise ValueError("补丁快捷键字段无效。")
    if value.get("stopMode") not in ("double-escape", "shortcut", "disabled") or value.get("scope") not in ("panel", "input"):
        raise ValueError("停止方式或范围无效。")
    interval = value.get("doubleEscapeMs")
    if type(interval) is not int or not 0 < interval <= 9007199254740991:
        raise ValueError("双 Esc 间隔必须为正整数毫秒。")
    result = {"newChatEnabled": value["newChatEnabled"], "newChatShortcut": value["newChatShortcut"].strip(), "stopMode": value["stopMode"], "stopShortcut": value["stopShortcut"].strip(), "doubleEscapeMs": interval, "scope": value["scope"]}
    new = shortcut(result["newChatShortcut"]) if result["newChatEnabled"] else None
    stop = shortcut(result["stopShortcut"]) if result["stopMode"] == "shortcut" else None
    if new and not (new["meta"] or new["ctrl"] or new["alt"]):
        raise ValueError("新建快捷键至少需要 Cmd、Ctrl 或 Option。")
    if new and stop == new:
        raise ValueError("新建与停止快捷键冲突。")
    return result


def render_webview(config, version, runtime):
    config = settings(config)
    payload = {"newChat": shortcut(config["newChatShortcut"]) if config["newChatEnabled"] else None, "stop": shortcut(config["stopShortcut"]) if config["stopMode"] == "shortcut" else None, "stopMode": config["stopMode"], "doubleEscapeMs": config["doubleEscapeMs"], "scope": config["scope"]}
    return runtime[f"webview-v{version}.js.template"].replace("{{AHS_METADATA}}", base64.b64encode(encoded(config).encode()).decode()).replace("{{AHS_RUNTIME}}", encoded(payload))


def runtime_files():
    manifest = json.loads((ROOT / "runtime/manifest.json").read_text())
    if manifest.get("schema") != 1:
        raise ValueError("运行模板版本不支持。")
    files = {}
    for name, expected in manifest["files"].items():
        if Path(name).name != name:
            raise ValueError("运行模板路径无效。")
        data = (ROOT / "runtime" / name).read_bytes()
        if digest(data) != expected:
            raise ValueError("运行模板损坏：" + name)
        files[name] = data.decode("utf-8")
    return manifest, files


def recover(data, kind, manifest, runtime):
    profile = manifest[kind]
    expected = profile["sha256"] if kind == "webview" else profile["originalSha256"]
    if digest(data) == expected:
        return data.decode("utf-8"), "original"
    source = data.decode("utf-8")
    header = None
    if kind == "webview" and digest(data) == manifest["legacy"]["sha256"]:
        start = source.index(manifest["legacy"]["start"])
        end = source.index(manifest["legacy"]["end"], start) + len(manifest["legacy"]["end"])
        block = source[start:end]
    elif kind == "webview":
        header = re.search(r"/\* APP_HOOK_STUDIO_BEGIN v([123]) codebuddy-cn ([A-Za-z0-9+/=]+) \*/\n", source)
        if not header:
            raise ValueError("聊天资源不是已验证的原文或已知补丁。")
        start = header.start()
        end = source.index("/* APP_HOOK_STUDIO_END */\n", start) + len("/* APP_HOOK_STUDIO_END */\n")
        block = render_webview(json.loads(base64.b64decode(header[2], validate=True)), int(header[1]), runtime)
    else:
        hits = [(source.find(runtime[f"focus-host-v{version}.js"]), runtime[f"focus-host-v{version}.js"]) for version in (1, 2)]
        hits = [(at, text) for at, text in hits if at >= 0]
        if len(hits) != 1:
            raise ValueError("命令桥接不是已验证的原文或完整已知补丁。")
        start, block = hits[0]
        end = start + len(block)
    original = source[:start] + source[end:]
    if kind == "webview" and header and header[1] == "3":
        alias = runtime["webview-require-v3.js"]
        anchor = manifest["webview"]["requireAnchor"]
        if original.count(alias + anchor) != 1:
            raise ValueError("模块 require 别名或位置不匹配。")
        original = original.replace(alias + anchor, anchor, 1)
    if source[start:end] != block or digest(original.encode()) != expected or original.find(profile["anchor"]) != start - (len(runtime["webview-require-v3.js"]) if kind == "webview" and header and header[1] == "3" else 0) or original.count(profile["anchor"]) != 1:
        raise ValueError("补丁内容、原文摘要或插入位置不匹配，保留现场。")
    return original, "managed"


def jsonc_document(source):
    """Blank comments/trailing commas without shifting any character offsets."""
    chars = list(source)
    comments = []
    i = 0
    while i < len(source):
        if source[i] == '"':
            i += 1
            while i < len(source):
                if source[i] == "\\":
                    i += 2
                elif source[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
            continue
        if source.startswith("//", i) or source.startswith("/*", i):
            start = i
            if source.startswith("//", i):
                i = source.find("\n", i)
                if i < 0:
                    i = len(source)
            else:
                i = source.find("*/", i + 2)
                if i < 0:
                    raise ValueError("JSONC 注释未闭合。")
                i += 2
            comments.append((start, i))
            chars[start:i] = ["\n" if c == "\n" else " " for c in source[start:i]]
            continue
        i += 1
    if chars and chars[0] == "\ufeff":
        chars[0] = " "
    lexical = "".join(chars)
    i = 0
    while i < len(chars):
        if chars[i] == '"':
            i += 1
            while i < len(chars):
                if chars[i] == "\\":
                    i += 2
                elif chars[i] == '"':
                    i += 1
                    break
                else:
                    i += 1
        elif chars[i] == ",":
            next_at = i + 1
            while next_at < len(chars) and chars[next_at].isspace():
                next_at += 1
            if next_at < len(chars) and chars[next_at] in "]}":
                chars[i] = " "
            i += 1
        else:
            i += 1
    clean = "".join(chars)
    values = json.loads(clean)
    if not isinstance(values, list):
        raise ValueError("keybindings.json 必须是 JSONC 数组。")
    spans = []
    decoder = json.JSONDecoder()
    i = clean.index("[") + 1
    while True:
        while clean[i].isspace() or clean[i] == ",":
            i += 1
        if clean[i] == "]":
            break
        start = i
        _, i = decoder.raw_decode(clean, i)
        spans.append((start, i))
    return values, spans, comments, lexical


def edit_binding(source, rule, command, marker=MARKER):
    values, spans, comments, lexical = jsonc_document(source)
    markers = [(start, end) for start, end in comments if source[start:end].strip() == marker]
    if len(markers) > 1:
        raise ValueError("快捷键存在多个所有权标记。")
    if markers:
        begin, marker_end = markers[0]
        index = next((i for i, (start, _) in enumerate(spans) if start >= marker_end), None)
        if index is None or source[marker_end:spans[index][0]].strip():
            raise ValueError("快捷键所有权标记位置异常。")
        item = values[index]
        known = isinstance(item, dict) and (marker == MARKER and item.get("command") == "coding-copilot.webviews.chat.focus" and "args" not in item or item.get("command") == "runCommands" and item.get("args") == {"commands": [command]})
        if not known or "when" in item:
            raise ValueError("拥有标记的规则被改写，拒绝覆盖。")
        start, end = spans[index]
        if rule is not None:
            indent = re.search(r"[ \t]*$", source[:start]).group()
            lines = json.dumps(rule, ensure_ascii=False, indent=4).splitlines()
            result = source[:start] + ("\n" + indent).join(lines) + source[end:]
        else:
            edits = [(begin, marker_end), (start, end)]
            right = end
            while right < len(lexical) and lexical[right].isspace():
                right += 1
            left = start - 1
            while left >= 0 and lexical[left].isspace():
                left -= 1
            if right < len(lexical) and lexical[right] == ",":
                edits.append((right, right + 1))
            elif left >= 0 and lexical[left] == ",":
                edits.append((left, left + 1))
            result = source
            for first, last in sorted(edits, reverse=True):
                result = result[:first] + result[last:]
    elif rule is None:
        if any(isinstance(item, dict) and item.get("command") == "runCommands" and item.get("args") == {"commands": [command]} for item in values):
            raise ValueError("用户自建快捷键规则仍存在，不能自动禁用；请手动检查。")
        result = source
    else:
        close = lexical.rfind("]")
        edits = [(close, "\n    " + marker + "\n    " + json.dumps(rule, ensure_ascii=False, indent=4).replace("\n", "\n    ") + "\n")]
        if values and "," not in lexical[spans[-1][1]:close]:
            edits.append((spans[-1][1], ","))
        result = source
        for at, text in sorted(edits, reverse=True):
            result = result[:at] + text + result[at:]
    jsonc_document(result)
    return result


def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".codebuddy-hotkeys-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def require_closed(app):
    output = subprocess.run(["/bin/ps", "-axo", "command="], check=True, capture_output=True, text=True, timeout=5).stdout
    prefix = str(app / "Contents/MacOS") + "/"
    if any(line.lstrip().startswith(prefix) for line in output.splitlines()):
        raise ValueError("请保存工作并用 ⌘Q 完全退出 CodeBuddy 后重试。")


@contextlib.contextmanager
def lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / ".lock"
    try:
        fd = os.open(str(file), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError("另一个快速体验操作正在进行；若上次被中断，确认进程已退出再删除 " + str(file))
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(str(os.getpid()))
        yield
    finally:
        file.unlink()


def version_check(app, manifest):
    base = app / "Contents/Resources/app"
    if json.loads((base / "package.json").read_text())["version"] != manifest["appVersion"] or json.loads((base / "extensions/genie/package.json").read_text())["version"] != manifest["extensionVersion"]:
        raise ValueError("仅支持 CodeBuddy " + manifest["appVersion"] + " / genie " + manifest["extensionVersion"] + "；未知版本拒绝写入。")


def read_state(directory):
    data = optional_read(directory / "state.json")
    if data is None:
        return None
    state = json.loads(data)
    if not isinstance(state, dict) or state.get("schema") != 1 or not isinstance(state.get("targets"), dict) or set(state["targets"]) != {"webview", "host", "keybindings"} or not isinstance(state.get("config"), dict):
        raise ValueError("快速体验记录无效，未覆盖。")
    for name, target in state["targets"].items():
        valid_hash = lambda value: isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
        if not isinstance(target, dict) or not isinstance(target.get("path"), str) or not isinstance(target.get("accepted"), list) or not all(value is None or valid_hash(value) for value in target["accepted"]) or not (valid_hash(target.get("beforeHash")) or name == "keybindings" and target.get("beforeHash") is None):
            raise ValueError("快速体验目标或备份记录无效，未覆盖。")
    return state


def check_state(state, targets, directory, app):
    if not state:
        return
    if state.get("app") != str(app):
        raise ValueError("备份属于另一个 App。")
    for name, target in targets.items():
        saved = state["targets"][name]
        if saved.get("path") != str(target["path"]) or digest(target["current"]) not in saved.get("accepted", []):
            raise ValueError(name + " 被其他工具或手工修改，保留当前文件。请先检查或恢复原快速体验记录。")
        backup = optional_read(directory / (name + ".before"))
        if digest(backup) != saved.get("beforeHash"):
            raise ValueError(name + " 备份损坏或缺失，拒绝写入。")


def plan(options, manifest, runtime, state, directory):
    app = Path(options["app"]).expanduser().resolve()
    version_check(app, manifest)
    enabled = lambda value: isinstance(value, str) and value.lower() != "off"
    for key in ("new_chat", "stop", "focus"):
        if not isinstance(options[key], str) or not options[key].strip():
            raise ValueError(key + " 必须是快捷键字符串或 off。")
    sequence = options["stop"].lower().replace(" ", "") in ("esc,esc", "esc+esc", "escape,escape", "escape+escape")
    config = settings({"newChatEnabled": enabled(options["new_chat"]), "newChatShortcut": options["new_chat"] if enabled(options["new_chat"]) else DEFAULTS["new_chat"], "stopMode": "disabled" if not enabled(options["stop"]) else "double-escape" if sequence else "shortcut", "stopShortcut": options["stop"] if enabled(options["stop"]) and not sequence else "cmd+alt+.", "doubleEscapeMs": options["double_escape_ms"], "scope": options["scope"]})
    focus = ide_key(options["focus"]) if enabled(options["focus"]) else None
    if focus and any(shortcut(focus) == key for key in [shortcut(config["newChatShortcut"]) if config["newChatEnabled"] else None, shortcut(config["stopShortcut"]) if config["stopMode"] == "shortcut" else None]):
        raise ValueError("聚焦快捷键与新建或停止冲突。")
    targets = {}
    for kind in ("webview", "host"):
        profile = manifest[kind]
        relative = profile["path"] if kind == "webview" else profile["artifactRelativePath"]
        path = (app / relative).resolve()
        if not path.is_relative_to(app):
            raise ValueError("资源真实路径位于 App 包外，拒绝写入。")
        data = path.read_bytes()
        original, current_kind = recover(data, kind, manifest, runtime)
        block = render_webview(config, 3, runtime) if kind == "webview" else runtime["focus-host-v2.js"]
        if original.count(profile["anchor"]) != 1:
            raise ValueError("注入锚点不唯一。")
        candidate_source = original.replace(profile["anchor"], block + profile["anchor"], 1)
        if kind == "webview":
            anchor = profile["requireAnchor"]
            if original.count(anchor) != 1:
                raise ValueError("模块 require 锚点不唯一。")
            candidate_source = candidate_source.replace(anchor, runtime["webview-require-v3.js"] + anchor, 1)
        candidate = candidate_source.encode()
        recover(candidate, kind, manifest, runtime)
        targets[kind] = {"path": path, "current": data, "candidate": candidate, "kind": current_kind}
    path = Path(options["keybindings"]).expanduser().resolve()
    current = optional_read(path)
    rule = {"key": focus, "command": "runCommands", "args": {"commands": [manifest["focusCommand"]]}} if focus else None
    new_rule = {"key": ide_key(config["newChatShortcut"]), "command": "runCommands", "args": {"commands": [NEW_CHAT_COMMAND]}} if config["newChatEnabled"] else None
    candidate = None
    if current is not None or rule is not None or new_rule is not None:
        source = current.decode("utf-8") if current is not None else "[]\n"
        source = edit_binding(source, rule, manifest["focusCommand"])
        candidate = edit_binding(source, new_rule, NEW_CHAT_COMMAND, NEW_CHAT_MARKER).encode()
    targets["keybindings"] = {"path": path, "current": current, "candidate": candidate, "kind": "user-config"}
    check_state(state, targets, directory, app)
    return app, config, targets


def commit(path, expected, data):
    if digest(optional_read(path)) != expected:
        raise ValueError("写入前文件已发生变化：" + str(path))
    if data is None:
        if path.exists():
            path.unlink()
    else:
        mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
        atomic_write(path, data, mode)
    if digest(optional_read(path)) != digest(data):
        raise ValueError("写后校验失败：" + str(path))


def apply(options, manifest, runtime, directory):
    # Validate before creating an in-App backup directory; then recheck under the lock.
    app, _, initial_targets = plan(options, manifest, runtime, read_state(directory), directory)
    if any(initial_targets[name]["candidate"] != initial_targets[name]["current"] for name in ("webview", "host")):
        require_closed(app)
    with lock(directory):
        state = read_state(directory)
        app, _, targets = plan(options, manifest, runtime, state, directory)
        if any(targets[name]["candidate"] != targets[name]["current"] for name in ("webview", "host")):
            require_closed(app)
        if not state:
            state = {"schema": 1, "app": str(app), "targets": {}}
            for name, target in targets.items():
                data = target["current"]
                backup = directory / (name + ".before")
                if backup.exists() and backup.read_bytes() != data:
                    raise ValueError("已有未归档备份不同，拒绝覆盖：" + str(backup))
                if data is not None:
                    atomic_write(backup, data)
                state["targets"][name] = {"path": str(target["path"]), "beforeHash": digest(data), "accepted": [digest(data)]}
        for name, target in targets.items():
            hashes = state["targets"][name]["accepted"]
            if digest(target["candidate"]) not in hashes:
                hashes.append(digest(target["candidate"]))
        state.update({"config": options, "phase": "applying"})
        atomic_write(directory / "state.json", (encoded(state) + "\n").encode())
        completed = []
        try:
            for name, target in targets.items():
                if target["candidate"] != target["current"]:
                    commit(target["path"], digest(target["current"]), target["candidate"])
                completed.append(name)
        except Exception as error:
            raise RuntimeError(str(error) + "；已完成：" + ", ".join(completed) + "。备份保留，可重试或 restore。") from error
        state["phase"] = "applied"
        atomic_write(directory / "state.json", (encoded(state) + "\n").encode())
        return {"ok": True, "changed": any(item["current"] != item["candidate"] for item in targets.values()), "message": "三个能力已统一安装。重新打开 CodeBuddy 后使用；配置变化也需要重开。", "backupDirectory": str(directory)}


def restore(options, manifest, directory):
    if not read_state(directory):
        raise ValueError("没有快速体验安装记录；不会操作其他工具的备份。")
    app = Path(options["app"]).expanduser().resolve()
    version_check(app, manifest)
    require_closed(app)
    with lock(directory):
        state = read_state(directory)
        if not state:
            raise ValueError("没有快速体验安装记录；不会操作 Raycast 自己的备份。")
        app = Path(options["app"]).expanduser().resolve()
        version_check(app, manifest)
        paths = {"webview": (app / manifest["webview"]["path"]).resolve(), "host": (app / manifest["host"]["artifactRelativePath"]).resolve(), "keybindings": Path(options["keybindings"]).expanduser().resolve()}
        targets = {name: {"path": path, "current": optional_read(path)} for name, path in paths.items()}
        check_state(state, targets, directory, app)
        before = {name: optional_read(directory / (name + ".before")) for name in targets}
        if any(target["current"] != before[name] for name, target in targets.items()):
            require_closed(app)
        completed = []
        try:
            for name, target in targets.items():
                if target["current"] != before[name]:
                    commit(target["path"], digest(target["current"]), before[name])
                completed.append(name)
        except Exception as error:
            raise RuntimeError(str(error) + "；已恢复：" + ", ".join(completed) + "。保留备份，可重试 restore。") from error
        state["phase"] = "restored"
        atomic_write(directory / "state.json", (encoded(state) + "\n").encode())
        return {"ok": True, "message": "已恢复本次快速体验之前的资源与快捷键。重新打开 CodeBuddy 生效。", "backupDirectory": str(directory)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "status", "apply", "restore"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--app")
    parser.add_argument("--keybindings")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--new-chat", dest="new_chat")
    parser.add_argument("--stop")
    parser.add_argument("--focus")
    parser.add_argument("--double-escape-ms", dest="double_escape_ms", type=int)
    parser.add_argument("--scope", choices=["panel", "input"])
    args = parser.parse_args()
    try:
        manifest, runtime = runtime_files()
        file_config = json.loads(args.config.read_bytes()) if args.config else {}
        allowed = set(DEFAULTS) | {"keybindings"}
        if not isinstance(file_config, dict) or set(file_config) - allowed:
            raise ValueError("配置文件字段无效。")
        app = Path(args.app or file_config.get("app", DEFAULTS["app"])).expanduser().resolve()
        directory = args.data_dir.expanduser().resolve() if args.data_dir else app / BACKUP_RELATIVE
        if not args.data_dir and read_state(directory) is None:
            # Do not lose an existing install's original baseline from older releases.
            legacy = Path.home() / "Library/Application Support/CodeBuddy Hotkeys Quickstart" / hashlib.sha256(str(app).encode()).hexdigest()[:16]
            legacy_state = read_state(legacy)
            if legacy_state and legacy_state.get("phase") != "restored":
                directory = legacy
        state = read_state(directory)
        if args.data_dir and not args.app and "app" not in file_config and state:
            app = Path(state["app"]).expanduser().resolve()
        options = {**DEFAULTS, "keybindings": str(Path.home() / "Library/Application Support/CodeBuddy CN/User/keybindings.json"), **(state.get("config", {}) if state else {}), **file_config}
        options.update({key: value for key, value in vars(args).items() if key in allowed and value is not None})
        options["app"] = str(app)
        if args.command in ("preflight", "status"):
            _, config, targets = plan(options, manifest, runtime, state, directory)
            result = {"ok": True, "writes": False, "version": manifest["appVersion"] + " / genie " + manifest["extensionVersion"], "config": options, "chatSettings": config, "backupDirectory": str(directory), "backupLocation": "inside-app" if directory.is_relative_to(app) else "external", "targets": [{"name": name, "path": str(item["path"]), "kind": item["kind"], "currentSha256": digest(item["current"]), "candidateSha256": digest(item["candidate"]), "willChange": item["current"] != item["candidate"]} for name, item in targets.items()], "message": "预检查未写入；apply 前须 ⌘Q 退出。此 Python 模块不在现场解析完整 JS 语法；使用构建时验证的模板和精确原文摘要。"}
        elif args.command == "apply":
            result = apply(options, manifest, runtime, directory)
        else:
            result = restore(options, manifest, directory)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        result = {"ok": False, "error": str(error)}
        cause = error
        while cause is not None:
            if isinstance(cause, PermissionError) or isinstance(cause, OSError) and cause.errno in (errno.EPERM, errno.EACCES):
                result["hint"] = "在系统设置 → 隐私与安全性 → App 管理中授权当前终端，再重试；脚本不自动提权。"
                break
            cause = cause.__cause__
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
