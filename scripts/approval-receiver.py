#!/usr/bin/env python3
"""Local CodeBuddy hook demo: receive stdin-forwarded JSON and show recent events."""

import argparse
from collections import deque
from datetime import datetime, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--log", type=Path, default=Path("/private/tmp/app-hook-studio-approval-demo/events.jsonl"))
    args = parser.parse_args()
    args.log.parent.mkdir(parents=True, exist_ok=True)
    events = deque(maxlen=100)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body, kind="application/json; charset=utf-8"):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            with lock:
                recent = list(events)
            if self.path == "/health":
                return self.reply(200, json.dumps({"ok": True, "events": len(recent)}))
            if self.path == "/events":
                return self.reply(200, json.dumps(recent, ensure_ascii=False, indent=2))
            if self.path != "/":
                return self.reply(404, '{"error":"not found"}')
            cards = []
            for event in reversed(recent):
                label = "模拟自检事件" if event["payload"].get("_app_hook_studio_demo") else "收到的 hook 事件"
                cards.append("<article><h2>" + label + " · " + escape(event["received_at"]) +
                             "</h2><pre>" + escape(json.dumps(event["payload"], ensure_ascii=False, indent=2)) + "</pre></article>")
            page = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="refresh" content="2"><title>CodeBuddy 批准通知接收器</title>
<style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 24px;background:#f5f6f8;color:#17212b}
article{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin:20px 0}
h2{font-size:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}</style>
<h1>CodeBuddy 批准通知</h1><p>等待 Notification / permission_prompt。页面每 2 秒刷新，最多显示最近 100 条。</p>"""
            self.reply(200, page + ("".join(cards) or "<article>还没有收到事件。</article>") + "</html>", "text/html; charset=utf-8")

        def do_POST(self):
            if self.path != "/events":
                return self.reply(404, '{"error":"not found"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    raise ValueError("Expected JSON body up to 1 MiB")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Expected a JSON object")
            except (ValueError, UnicodeError) as error:
                return self.reply(400, json.dumps({"error": str(error)}))
            event = {"received_at": datetime.now(timezone.utc).isoformat(), "payload": payload}
            with lock:
                with args.log.open("a", encoding="utf-8") as output:
                    output.write(json.dumps(event, ensure_ascii=False) + "\n")
                events.append(event)
            print(json.dumps(event, ensure_ascii=False), flush=True)
            self.reply(200, '{"ok":true}')

        def log_message(self, _format, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Receiver: http://127.0.0.1:{args.port}/\nEvent log: {args.log}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
