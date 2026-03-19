#!/usr/bin/env python3
"""
ローカル開発サーバー
.env から OPENAI_API_KEY を読み込み、index.html に注入して配信します。

使い方:
  1. .env.example をコピーして .env を作成し、APIキーを記入
  2. python server.py
  3. ブラウザで http://localhost:8080 を開く
"""
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8082
HTML_FILE = os.path.join(os.path.dirname(__file__), "index.html")
ENV_FILE  = os.path.join(os.path.dirname(__file__), ".env")
if not os.path.exists(ENV_FILE):
    ENV_FILE = os.path.join(os.path.dirname(__file__), "..", ".env")


def load_env() -> dict:
    env = {}
    if not os.path.exists(ENV_FILE):
        print(f"[警告] .env ファイルが見つかりません: {ENV_FILE}")
        print("  .env.example をコピーして .env を作成し、APIキーを設定してください。")
        return env
    with open(ENV_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, val = line.partition("=")
                env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def build_html(api_key: str) -> bytes:
    with open(HTML_FILE, encoding="utf-8") as f:
        html = f.read()
    # プレースホルダーをインラインスクリプトで置換
    inject = f'<script>window.__OPENAI_API_KEY__ = "{api_key}";</script>'
    html = html.replace("<!-- __API_KEY_INJECT__ -->", inject)
    return html.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"  {self.address_string()} {format % args}")

    def do_GET(self):
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        env = load_env()
        api_key = env.get("OPENAI_API_KEY", "")
        if not api_key:
            self.send_error(500, "OPENAI_API_KEY is not set in .env")
            return
        body = build_html(api_key)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"サーバー起動中 → http://localhost:{PORT}")
    HTTPServer(("", PORT), Handler).serve_forever()
