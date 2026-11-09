#!/usr/bin/env python3
"""Install resource hooks in the verified CodeBuddy Remote SSH server build."""
import argparse
import base64
import json
from pathlib import Path
import subprocess

import hotkeys as h

COMMIT = "8e9c06cb4efccd833fc8edb84123652746908a7d"
HOST_SHA256 = "17595b239ec1ac1e54d2a3bc726745fc8d9c24a49fe1361414c3dccdd3acc919"

# Sent over SSH stdin; no persistent helper or credential files are installed.
WORKER = r'''
import base64, json, os, stat, subprocess, sys
from pathlib import Path
if sys.version_info < (3, 9):
    raise SystemExit("Remote Python 3.9+ required; select an interpreter with --python")
payload = json.load(sys.stdin)
module = {"__name__": "remote_hotkeys_library", "__file__": "/unused/hotkeys.py"}
exec(compile(base64.b64decode(payload["library"]), "hotkeys.py", "exec"), module)
from types import SimpleNamespace
h = SimpleNamespace(**module)
base = (Path.home() / ".codebuddy-server-cn/bin" / ("stable-" + payload["commit"])).resolve()
product = json.loads((base / "product.json").read_text())
package = json.loads((base / "package.json").read_text())
extension = json.loads((base / "extensions/genie/package.json").read_text())
manifest = payload["manifest"]
if product.get("commit") != payload["commit"] or package.get("version") != manifest["appVersion"] or extension.get("version") != manifest["extensionVersion"]:
    raise ValueError("Remote build/version mismatch; no writes")
manifest["host"]["originalSha256"] = payload["hostHash"]
runtime = {}
for name, value in payload["runtime"].items():
    data = base64.b64decode(value, validate=True)
    if h.digest(data) != manifest["files"][name]:
        raise ValueError("Runtime template hash mismatch")
    runtime[name] = data.decode()
directory = base / "app-hook-studio-remote-backup"
paths = {"host": base / "extensions/genie/out/extension/index.js", "webview": base / "extensions/genie/out/webviews/main.942dbf9a.chunk.js"}
for path in paths.values():
    if not path.resolve().is_relative_to(base):
        raise ValueError("Resource escaped server directory")

def plan():
    raw = h.optional_read(directory / "state.json")
    state = json.loads(raw) if raw is not None else None
    if state is not None and (state.get("schema") != 1 or state.get("base") != str(base) or set(state.get("targets", {})) != set(paths)):
        raise ValueError("Invalid remote backup state")
    targets = {}
    for name, path in paths.items():
        current = path.read_bytes()
        original, kind = h.recover(current, name, manifest, runtime)
        if state:
            saved = state["targets"][name]
            if saved["path"] != str(path) or h.digest(current) not in saved["accepted"]:
                raise ValueError(name + " changed outside this installer")
            if h.digest(h.optional_read(directory / (name + ".before"))) != saved["beforeHash"]:
                raise ValueError(name + " backup missing or damaged")
        if payload["command"] == "restore":
            if not state:
                raise ValueError("No remote installation to restore")
            candidate = (directory / (name + ".before")).read_bytes()
        else:
            profile = manifest[name]
            block = (runtime["focus-host-v2.js"] if payload.get("focusEnabled", True) else "") if name == "host" else h.render_webview(payload["config"], 3, runtime)
            if original.count(profile["anchor"]) != 1:
                raise ValueError("Injection anchor is not unique")
            candidate = original.replace(profile["anchor"], block + profile["anchor"], 1)
            if name == "webview":
                anchor = profile["requireAnchor"]
                if original.count(anchor) != 1:
                    raise ValueError("Require alias anchor is not unique")
                candidate = candidate.replace(anchor, runtime["webview-require-v3.js"] + anchor, 1)
            candidate = candidate.encode()
            h.recover(candidate, name, manifest, runtime)
        syntax = subprocess.run([str(base / "node"), "--check"], input=candidate, capture_output=True, timeout=30)
        if syntax.returncode:
            raise ValueError(name + " syntax invalid: " + syntax.stderr.decode())
        targets[name] = {"path": path, "current": current, "candidate": candidate, "kind": kind}
    return state, targets

state, targets = plan()
if payload["command"] == "apply":
    h.require_original_installation(state, targets, directory)
if payload["command"] in ("apply", "restore"):
    with h.lock(directory):
        state, targets = plan()
        if payload["command"] == "apply":
            h.require_original_installation(state, targets, directory)
        if state is None:
            state = {"schema": 1, "base": str(base), "targets": {}}
            for name, target in targets.items():
                before = directory / (name + ".before")
                existing = h.optional_read(before)
                if existing is not None and existing != target["current"]:
                    raise ValueError("Refusing to overwrite orphaned backup")
                h.atomic_write(before, target["current"])
                state["targets"][name] = {"path": str(target["path"]), "beforeHash": h.digest(target["current"]), "accepted": [h.digest(target["current"])]}
        for name, target in targets.items():
            accepted = state["targets"][name]["accepted"]
            if h.digest(target["candidate"]) not in accepted:
                accepted.append(h.digest(target["candidate"]))
        state.update({"config": payload["config"], "phase": "restoring" if payload["command"] == "restore" else "applying"})
        h.atomic_write(directory / "state.json", (h.encoded(state) + "\n").encode())
        for name, target in targets.items():
            if target["candidate"] != target["current"]:
                h.commit(target["path"], h.digest(target["current"]), target["candidate"])
        state["phase"] = "restored" if payload["command"] == "restore" else "applied"
        h.atomic_write(directory / "state.json", (h.encoded(state) + "\n").encode())
print(json.dumps({"ok": True, "command": payload["command"], "base": str(base), "backupDirectory": str(directory), "phase": state.get("phase") if state else None, "targets": {name: {"kind": target["kind"], "changed": target["candidate"] != target["current"], "currentSha256": h.digest(target["current"]), "candidateSha256": h.digest(target["candidate"])} for name, target in targets.items()}}, ensure_ascii=False, indent=2))
'''


def load_config(path):
    value = json.loads(path.read_text()) if path else {}
    if not isinstance(value, dict):
        raise ValueError("配置必须为 JSON 对象。")
    if "newChatEnabled" in value:
        return h.settings(value), True
    if set(value) - (set(h.DEFAULTS) | {"keybindings"}):
        raise ValueError("配置文件字段无效。")
    options = h.feature_options({**h.DEFAULTS, **value})
    for feature in ("new_chat", "stop", "focus"):
        if not isinstance(options[feature], str) or not options[feature].strip():
            raise ValueError(feature + " 必须是快捷键字符串或 off。")
    return h.chat_config(options), options["focus"].lower() != "off"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "status", "apply", "restore"])
    parser.add_argument("--host", required=True, help="SSH destination, e.g. root@example.com")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--python", default="python3", help="Remote Python 3.9+ executable")
    parser.add_argument("--config", type=Path, help="Shared config.example.json or legacy chat runtime settings")
    args = parser.parse_args()
    manifest, runtime = h.runtime_files()
    config, focus_enabled = load_config(args.config)
    payload = {"command": args.command, "commit": COMMIT, "hostHash": HOST_SHA256, "manifest": manifest, "config": config, "focusEnabled": focus_enabled, "library": base64.b64encode((h.ROOT / "hotkeys.py").read_bytes()).decode(), "runtime": {name: base64.b64encode(data.encode()).decode() for name, data in runtime.items()}}
    # Only constant Python code is in the shell command; all configuration uses stdin.
    bootstrap = "import base64;exec(base64.b64decode(" + repr(base64.b64encode(WORKER.encode()).decode()) + "))"
    import shlex
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", str(args.port), "--", args.host, shlex.quote(args.python) + " -c " + shlex.quote(bootstrap)], input=json.dumps(payload), text=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
