import os
import io
import hashlib
import re
import tempfile
from pathlib import Path
from typing import Optional

import hf_compat

import torch
import soundfile as sf
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from ruaccent import RUAccent

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)
CACHE_MAX_FILES = 400

SAMPLE_RATE = 48000
AVAILABLE_SPEAKERS = ["xenia", "aidar", "eugene", "kseniya", "baya"]


def prune_cache():
    try:
        files = sorted(
            CACHE_DIR.glob("*.wav"),
            key=lambda p: p.stat().st_mtime,
        )
        extra = len(files) - CACHE_MAX_FILES
        if extra <= 0:
            return
        for p in files[:extra]:
            try:
                p.unlink()
            except OSError:
                pass
    except OSError:
        pass

print("AL: RUAccent...", flush=True)
accentizer = RUAccent()
accentizer.load(
    omograph_model_size="turbo3.1",
    use_dictionary=True,
    device="CPU",
)
print("AL: RUAccent ok", flush=True)
print("AL: Silero TTS...", flush=True)
device = torch.device("cpu")
model, _ = torch.hub.load(
    repo_or_dir="snakers4/silero-models",
    model="silero_tts",
    language="ru",
    speaker="v5_ru",
    trust_repo=True,
)
model.to(device)
print("AL: Silero ok", flush=True)

app = FastAPI(title="AlexandriaLib TTS", version="1.0.0")

class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    speaker: str = Field(default="xenia")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)

def get_cache_key(text: str, speaker: str, speed: float) -> str:
    raw = f"{text}|{speaker}|{speed:.2f}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

import re

_ABBR_EXPAND = [
    (re.compile(r"\bт\.\s*е\.", re.I), "то есть"),
    (re.compile(r"\bт\.\s*д\.", re.I), "так далее"),
    (re.compile(r"\bт\.\s*п\.", re.I), "тому подобное"),
    (re.compile(r"\bт\.\s*к\.", re.I), "так как"),
    (re.compile(r"\bт\.\s*н\.", re.I), "так называемый"),
    (re.compile(r"\bи\s+т\.\s*д\.", re.I), "и так далее"),
    (re.compile(r"\bи\s+т\.\s*п\.", re.I), "и тому подобное"),
    (re.compile(r"\bн\.\s*э\.", re.I), "нашей эры"),
    (re.compile(r"\bдо\s+н\.\s*э\.", re.I), "до нашей эры"),
    (re.compile(r"\bпроф\.", re.I), "профессор"),
    (re.compile(r"\bд-р\b", re.I), "доктор"),
    (re.compile(r"\bим\.", re.I), "имени"),
    (re.compile(r"\bруб\.", re.I), "рублей"),
    (re.compile(r"\bкоп\.", re.I), "копеек"),
    (re.compile(r"\bмлн\.", re.I), "миллионов"),
    (re.compile(r"\bмлрд\.", re.I), "миллиардов"),
    (re.compile(r"\bтыс\.", re.I), "тысяч"),
    (re.compile(r"\bстр\.", re.I), "страница"),
    (re.compile(r"\bрис\.", re.I), "рисунок"),
    (re.compile(r"\bсм\.", re.I), "смотри"),
]

def normalize_for_tts(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    for ch in ["\x00", "\ufeff", "\u200b", "\u200c", "\u200d", "\ufeff"]:
        t = t.replace(ch, "")
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    t = t.replace("\u00a0", " ")
    for a, b in [
        ("\u2026", "..."),
        ("\u2022", ","),
        ("\u2014", " — "),
        ("\u2013", " — "),
        ("\u2012", " — "),
        ("\u2212", "-"),
        ("\u00ab", "\""),
        ("\u00bb", "\""),
        ("\u201c", "\""),
        ("\u201d", "\""),
        ("\u201e", "\""),
        ("\u2018", "'"),
        ("\u2019", "'"),
        ("\u00b4", "'"),
        ("`", "'"),
    ]:
        t = t.replace(a, b)
    t = re.sub(r"-{2,}", " — ", t)
    t = re.sub(r"\.{4,}", "...", t)
    t = re.sub(r"!{2,}", "!", t)
    t = re.sub(r"\?{2,}", "?", t)
    for rx, repl in _ABBR_EXPAND:
        def _sub(m, _repl=repl):
            s = m.string
            i = m.start()
            if i == 0 or (i > 0 and s[i - 1] in ".!?…\n"):
                return _repl[:1].upper() + _repl[1:] if _repl else _repl
            return _repl
        t = rx.sub(_sub, t)
    t = re.sub(r"([.!?…])([A-Za-zА-Яа-яЁё])", r"\1 \2", t)
    t = re.sub(r"([,;:])([^\s\d])", r"\1 \2", t)
    t = re.sub(r"\s*—\s*", " — ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\s+([,.;:!?…])", r"\1", t)
    if t and t[-1] not in ".!?…:":
        if re.search(r"[0-9A-Za-zА-Яа-яЁё]$", t):
            t = t + "."
    return t.strip()

def synthesize(text: str, speaker: str = "xenia", speed: float = 1.0) -> bytes:
    if speaker not in AVAILABLE_SPEAKERS:
        raise ValueError(f"Неизвестный голос. Доступны: {AVAILABLE_SPEAKERS}")

    text = normalize_for_tts(text or "")
    if not text:
        raise ValueError("Пустой текст")

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
    normalized = normalize_for_tts(req.text)
    if not normalized:
        raise HTTPException(status_code=400, detail="Пустой текст")
    cache_key = get_cache_key(normalized, req.speaker, req.speed)
    cache_path = CACHE_DIR / f"{cache_key}.wav"

    if cache_path.exists():
        data = cache_path.read_bytes()
        return Response(
            content=data,
            media_type="audio/wav",
            headers={"X-Cache": "HIT", "Content-Disposition": "inline; filename=tts.wav"},
        )

    try:
        data = synthesize(normalized, req.speaker, req.speed)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    cache_path.write_bytes(data)
    prune_cache()

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
    print("AL: TTS server listening :8765", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
