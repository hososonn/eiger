# eiger — Whisper 音声認識システム

OpenAI Whisper を使った音声文字起こしシステムです。
Python バックエンド（FastAPI）と Expo iOS アプリ（TypeScript）で構成されています。

## 構成

```
eiger/
├── backend/     # Python + uv + FastAPI + openai-whisper
└── ios-app/     # Expo (React Native) + TypeScript
```

## 動作フロー

```
[iOS アプリ]  --録音 (m4a)--> [POST /transcribe]
[バックエンド] --Whisper推論--> { text, language, segments }
[iOS アプリ]  <--結果表示--
```

---

## バックエンド

### 必要条件

- Python 3.13+
- [uv](https://docs.astral.sh/uv/)
- ffmpeg（Whisper の音声デコードに使用）

```bash
brew install ffmpeg
```

### セットアップ & 起動

```bash
cd backend
uv run uvicorn main:app --reload
```

初回起動時に Whisper の `base` モデル（約 140MB）が自動ダウンロードされます。

### モデルの変更

`WHISPER_MODEL` 環境変数で切り替えられます。

| モデル | サイズ | 精度 |
|--------|--------|------|
| tiny   | 39MB   | 低   |
| base   | 74MB   | 中（デフォルト） |
| small  | 244MB  | 高   |
| medium | 769MB  | より高 |
| large  | 1.5GB  | 最高 |

```bash
WHISPER_MODEL=small uv run uvicorn main:app --reload
```

### API

#### `GET /health`

```json
{ "status": "ok", "model": "base" }
```

#### `POST /transcribe`

| フィールド | 説明 |
|---|---|
| `file` (multipart) | 音声ファイル（wav / m4a / flac など） |
| `language` (query, optional) | 言語コード（例: `ja`）。省略時は自動検出 |

**レスポンス例:**

```json
{
  "text": "And so my fellow Americans...",
  "language": "en",
  "segments": [
    { "start": 0.0, "end": 7.6, "text": " And so my fellow Americans..." }
  ]
}
```

**curl での確認:**

```bash
curl -X POST http://localhost:8000/transcribe \
  -F "file=@sample.wav;type=audio/wav"
```

---

## iOS アプリ

### 必要条件

- Node.js 18+
- Expo CLI
- Xcode（シミュレーター使用時）または Expo Go アプリ（実機使用時）

### セットアップ & 起動

```bash
cd ios-app
npm install
npx expo start --ios
```

### 実機で動かす場合

`App.tsx` の `API_BASE` をバックエンドが動いている Mac の LAN IP に変更してください。

```ts
// App.tsx
const API_BASE = 'http://192.168.x.x:8000';  // Mac の IP に変更
```

> シミュレーターはマイクが使えないため、**実機または Expo Go** を推奨します。

### アプリの使い方

1. 「● 録音開始」ボタンをタップ
2. マイクに向かって話す
3. 「■ 停止して文字起こし」ボタンをタップ
4. 文字起こし結果・検出言語・タイムスタンプ付きセグメントが表示される

---

## ローカル動作確認

バックエンドのみで Whisper の動作確認をする場合:

```bash
cd backend
uv run python -c "
import whisper
model = whisper.load_model('base')
result = model.transcribe('sample.wav')
print(result['text'])
"
```
