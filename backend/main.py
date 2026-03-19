import os
import tempfile
import json
from pathlib import Path

import whisper
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel

app = FastAPI(title="Whisper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load model once at startup (tiny/base/small/medium/large)
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
model = whisper.load_model(MODEL_SIZE)
OPENAI_MODEL = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o")
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


class TranscribeResponse(BaseModel):
    text: str
    language: str | None = None
    segments: list[dict] = []

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    system_prompt: str
    messages: list[ChatMessage]


class ChatResponse(BaseModel):
    status: str
    assistant_message: str
    record: dict | None = None


@app.get("/health")
def health():
    return {"status": "ok", "whisper_model": MODEL_SIZE, "chat_model": OPENAI_MODEL}


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = None,
):
    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Audio file required")

    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        options: dict = {}
        if language:
            options["language"] = language

        result = model.transcribe(tmp_path, **options)
        return TranscribeResponse(
            text=result["text"].strip(),
            language=result.get("language"),
            segments=[
                {"start": s["start"], "end": s["end"], "text": s["text"]}
                for s in result.get("segments", [])
            ],
        )
    finally:
        os.unlink(tmp_path)


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured on backend")

    try:
        response = openai_client.chat.completions.create(
            model=OPENAI_MODEL,
            temperature=0.2,
            messages=[
                {"role": "system", "content": req.system_prompt},
                *[{"role": m.role, "content": m.content} for m in req.messages],
            ],
            response_format={"type": "json_object"},
        )
        content = (response.choices[0].message.content or "").strip()
        parsed = json.loads(content)
        status = parsed.get("status")
        assistant_message = parsed.get("assistant_message")
        record = parsed.get("record")
        if status not in {"in_progress", "complete"} or not isinstance(assistant_message, str):
            raise HTTPException(status_code=502, detail="Invalid JSON returned from LLM")
        return ChatResponse(status=status, assistant_message=assistant_message, record=record)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat generation failed: {exc}") from exc
