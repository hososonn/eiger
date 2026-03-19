"""
マイクで録音して /transcribe エンドポイントに送るデモスクリプト。
使い方: uv run python record_and_transcribe.py [秒数]
"""

import sys
import subprocess
import tempfile
import urllib.request
import urllib.error
import json

API_BASE = "http://localhost:8000"
SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 5


def check_server():
    try:
        with urllib.request.urlopen(f"{API_BASE}/health", timeout=3) as r:
            data = json.loads(r.read())
            print(f"[server] backend={data['backend']}")
    except urllib.error.URLError:
        print("[error] サーバーが起動していません。先に uvicorn を起動してください。")
        sys.exit(1)


def record(path: str, seconds: int):
    print(f"[rec] {seconds}秒間録音します... 話してください")
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "avfoundation",
            "-i", ":1",          # MacBook Air マイク
            "-t", str(seconds),
            "-ar", "16000",
            "-ac", "1",
            path,
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        print("[error] 録音に失敗しました")
        print(result.stderr.decode())
        sys.exit(1)
    print("[rec] 録音完了")


def transcribe(path: str) -> dict:
    print("[api] 文字起こし中...")
    boundary = "----FormBoundary"
    with open(path, "rb") as f:
        audio_bytes = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="recording.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode() + audio_bytes + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{API_BASE}/transcribe",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    check_server()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        record(tmp_path, SECONDS)
        result = transcribe(tmp_path)
    finally:
        import os
        os.unlink(tmp_path)

    print()
    print("=" * 50)
    print(f"テキスト  : {result['text']}")
    if result.get("language"):
        print(f"言語      : {result['language']}")
    print(f"バックエンド: {result.get('backend', '')}")
    print("=" * 50)


if __name__ == "__main__":
    main()
