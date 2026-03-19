import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv(Path(__file__).parent.parent / ".env")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
USE_API = bool(OPENAI_API_KEY)

if USE_API:
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)
    backend_label = "openai-api/whisper-1"
else:
    import whisper
    MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
    local_model = whisper.load_model(MODEL_SIZE)
    backend_label = f"local/{MODEL_SIZE}"

app = FastAPI(title="Whisper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranscribeResponse(BaseModel):
    text: str
    language: str | None = None
    segments: list[dict] = []
    backend: str = ""


@app.get("/health")
def health():
    return {"status": "ok", "backend": backend_label}


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
        if USE_API:
            with open(tmp_path, "rb") as f:
                kwargs = {"model": "whisper-1", "file": f}
                if language:
                    kwargs["language"] = language
                resp = client.audio.transcriptions.create(**kwargs)
            return TranscribeResponse(
                text=resp.text.strip(),
                backend=backend_label,
            )
        else:
            options: dict = {}
            if language:
                options["language"] = language
            result = local_model.transcribe(tmp_path, **options)
            return TranscribeResponse(
                text=result["text"].strip(),
                language=result.get("language"),
                segments=[
                    {"start": s["start"], "end": s["end"], "text": s["text"]}
                    for s in result.get("segments", [])
                ],
                backend=backend_label,
            )
    finally:
        os.unlink(tmp_path)
