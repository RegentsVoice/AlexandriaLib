"""
AlexandriaLib TTS server
"""

import os
import io
import hashlib
import tempfile
from pathlib import Path
from typing import Optional

import torch
import soundfile as sf
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from ruaccent import RUAccent

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

SAMPLE_RATE = 48000
AVAILABLE_SPEAKERS = ["xenia", "aidar", "eugene", "kseniya", "baya"]

accentizer = RUAccent()
accentizer.load(
    omograph_model_size="turbo3.1",
    use_dictionary=True,
    device="CPU",
)
device = torch.device("cpu")
model, _ = torch.hub.load(
    repo_or_dir="snakers4/silero-models",
    model="silero_tts",
    language="ru",
    speaker="v5_ru",
    trust_repo=True,
)
model.to(device)
print("TTS ready", flush=True)

app = FastAPI(title="AlexandriaLib TTS", version="1.0.0")

class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    speaker: str = Field(default="xenia")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)

def get_cache_key(text: str, speaker: str, speed: float) -> str:
    raw = f"{text}|{speaker}|{speed:.2f}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def synthesize(text: str, speaker: str = "xenia", speed: float = 1.0) -> bytes:
    if speaker not in AVAILABLE_SPEAKERS:
        raise ValueError(f"Неизвестный голос. Доступны: {AVAILABLE_SPEAKERS}")

    text = (text or "").strip()
    if not text:
        raise ValueError("Пустой текст")

    for ch in ["\x00", "\ufeff"]:
        text = text.replace(ch, "")

    try:
        text_with_stress = accentizer.process_all(text)
    except Exception as e:
        print("RUAccent error:", e)
        text_with_stress = text

    if not (text_with_stress or "").strip():
        text_with_stress = text

    try:
        audio = model.apply_tts(
            text=text_with_stress,
            speaker=speaker,
            sample_rate=SAMPLE_RATE,
            put_accent=False,
            put_yo=False,
            put_stress_homo=False,
            put_yo_homo=False,
        )
    except Exception as e:
        print("apply_tts error:", e, "retry plain")
        audio = model.apply_tts(
            text=text[:500],
            speaker=speaker,
            sample_rate=SAMPLE_RATE,
            put_accent=True,
            put_yo=True,
        )

    audio_np = audio.numpy() if torch.is_tensor(audio) else np.asarray(audio)

    if abs(speed - 1.0) > 0.01:
        from scipy import signal
        new_length = int(len(audio_np) / speed)
        audio_np = signal.resample(audio_np, new_length)

    buf = io.BytesIO()
    sf.write(buf, audio_np, SAMPLE_RATE, format="WAV")
    buf.seek(0)
    return buf.read()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "speakers": AVAILABLE_SPEAKERS,
        "sample_rate": SAMPLE_RATE,
    }

@app.post("/tts")
def tts(req: TTSRequest):
    cache_key = get_cache_key(req.text, req.speaker, req.speed)
    cache_path = CACHE_DIR / f"{cache_key}.wav"

    if cache_path.exists():
        data = cache_path.read_bytes()
        return Response(
            content=data,
            media_type="audio/wav",
            headers={"X-Cache": "HIT", "Content-Disposition": "inline; filename=tts.wav"},
        )

    try:
        data = synthesize(req.text, req.speaker, req.speed)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    cache_path.write_bytes(data)

    return Response(
        content=data,
        media_type="audio/wav",
        headers={"X-Cache": "MISS", "Content-Disposition": "inline; filename=tts.wav"},
    )

@app.get("/speakers")
def speakers():
    return {"speakers": AVAILABLE_SPEAKERS}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")
