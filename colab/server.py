#!/usr/bin/env python3
"""SnapReel Studio - Colab backend (Google Colab, free T4 GPU).

Paste a stream link in the SnapReel Studio web app, pick how many clips and
how long each one is, and this server does the heavy work on Colab:

    URL -> yt-dlp audio-first -> faster-whisper large-v3-turbo (word timestamps)
      -> chunked transcript -> Gemini 2.5 Flash virality ranking
      -> dedupe + clamp to the requested length
      -> yt-dlp --download-sections for only the chosen segments (<=1080p)
      -> facecam detection + 9:16 stack layout -> .ass karaoke captions
      -> ONE ffmpeg pass -> 1080x1920 MP4, loudnorm -14 LUFS

LAYOUT (the user's GTA VI stream template, 9:16 canvas 1080x1920):
    facecam on TOP    1080x720   (the streamer's picture-in-picture box)
    gameplay BELOW    1080x1200  (the full 16:9 frame, cropped to fill)
    Same split as the approved CarryMinati 9:16 encode. Facecam detection and
    the composite follow the stream-clips skill (scripts/sc/frame.py):
    sample frames at 2 fps, find faces (YuNet, then MediaPipe, then Haar),
    group them into tracks, find the facecam overlay box from persistent
    Canny edges around the face, fall back to a box sized from the face.
    Word-by-word karaoke captions sit on the gameplay area; the hook title
    is a title-bar PNG centred on the seam between the two panels.
    If no facecam box is found, the top band becomes a blurred copy of the
    gameplay frame (never fails the clip) and the job status says so.
    The MediaPipe speaker-follow crop is kept only as a secondary fallback
    for talking-head (non-stream) inputs.

INPUTS (yt-dlp): YouTube, Twitch (VODs/clips), Kick, Streamable, direct .mp4.
Frame.io has NO yt-dlp extractor: paste a DIRECT .mp4 link instead (from the
frame.io Download button, or the <video src> in the browser inspector). A
frame.io share link is rejected with a clear message saying exactly that.

CHECKPOINTS: every stage is written to Google Drive
(MyDrive/SnapReel-Clips/jobs/<job_id>/) so a dead Colab session resumes
instead of restarting from zero.

API KEY: read ONLY from Colab Secrets (google.colab.userdata, secret name
GEMINI_API_KEY). No key is ever written in this file. Without a key the
server uses a deterministic fallback scorer (audio-energy peaks + hook
keywords + questions) and labels those clips as fallback scoring.

Runs on Colab only. No Windows paths, no .bat, no localhost-only
assumptions: binds 0.0.0.0, served to the web app through a cloudflared
tunnel (see notebook cell 3).
"""

import json
import math
import os
import re
import shutil
import subprocess
import threading
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ---------------------------------------------------------------- config ---

BASE_DIR = Path("/content")
WORK_DIR = BASE_DIR / "snapreel-work"          # fast local scratch (ephemeral)
MODELS_DIR = WORK_DIR / "models"
DRIVE_ROOT = Path("/content/drive/MyDrive/SnapReel-Clips")
JOBS_DIR = DRIVE_ROOT / "jobs"                 # checkpoints + finished clips

WHISPER_MODEL_NAME = "large-v3-turbo"
GEMINI_MODEL = "gemini-2.5-flash"

OUT_W, OUT_H = 1080, 1920
CAM_H, GAME_H = 720, 1200                      # facecam top / gameplay bottom
SEAM_Y = CAM_H                                 # y of the seam between panels

TRANSCRIPT_CHUNK_SECONDS = 1200                # ~20 min chunks for the LLM
TRANSCRIPT_CHUNK_OVERLAP = 120                 # 2 min overlap so moments on
                                               # a boundary are not lost
MAX_OVERLAP_KEEP = 0.5                         # dedupe: drop a clip overlapping
                                               # >50% of an already-kept clip
CAPTION_MARGIN_BOTTOM = 560                    # px from bottom edge: captions
                                               # sit in the gameplay area,
                                               # clear of platform UI
CAP_FONT = "DejaVu Sans"
CAP_FONT_SIZE = 56
CAP_ACTIVE_SIZE = 66
CAP_FILL = "FFFFFF"                            # white words
CAP_ACTIVE = "FFD400"                          # yellow active word
TITLE_FONT_SIZE = 56
TITLE_BG = "FFFFFF"
TITLE_FG = "111111"

YUNET_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")

# ------------------------------------------------------------- utilities ---

def log(msg: str) -> None:
    print(f"[snapreel {datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd: List[str], what: str, timeout: int = 3600) -> subprocess.CompletedProcess:
    """Run a command; raise RuntimeError with the tail of stderr on failure."""
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if res.returncode != 0:
        tail = (res.stderr or res.stdout or "")[-2000:]
        raise RuntimeError(f"{what} failed (rc={res.returncode}): {tail}")
    return res


def even(n: float) -> int:
    """Nearest even int (ffmpeg crop/scale need even dimensions)."""
    return int(round(n / 2.0)) * 2


def fmt_hms(seconds: float) -> str:
    """Seconds -> HH:MM:SS.mmm for yt-dlp --download-sections."""
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def fmt_clock(seconds: float) -> str:
    """Seconds -> MM:SS for display."""
    seconds = max(0.0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def has_gpu() -> bool:
    if not shutil.which("nvidia-smi"):
        return False
    try:
        return subprocess.run(["nvidia-smi", "-L"], capture_output=True,
                              timeout=30).returncode == 0
    except Exception:
        return False


def probe_info(path: Path) -> Dict[str, Any]:
    """Video width/height/fps/duration via ffprobe."""
    res = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,r_frame_rate",
               "-show_entries", "format=duration",
               "-of", "json", str(path)], "ffprobe")
    data = json.loads(res.stdout)
    stream = data["streams"][0]
    num, den = stream["r_frame_rate"].split("/")
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": float(num) / float(den) if float(den) else 30.0,
        "duration": float(data["format"]["duration"]),
    }


def detect_platform(url: str) -> str:
    u = url.strip().lower()
    if "frame.io" in u:
        return "frameio"
    if "twitch.tv" in u or "clips.twitch.tv" in u:
        return "twitch"
    if "kick.com" in u:
        return "kick"
    if "youtube.com" in u or "youtu.be" in u or "music.youtube.com" in u:
        return "youtube"
    if "streamable.com" in u:
        return "streamable"
    if u.endswith(".mp4") or ".mp4?" in u:
        return "direct-mp4"
    return "unknown"


def get_gemini_key() -> str:
    """Gemini API key from Colab Secrets ONLY (secret name GEMINI_API_KEY).

    The user adds it once in the Colab Secrets panel (key icon, left sidebar).
    No key value is ever stored in this file or in the notebook.
    """
    try:
        from google.colab import userdata  # only exists inside Colab
        key = userdata.get("GEMINI_API_KEY")
        if key:
            return str(key)
    except Exception:
        pass
    return os.environ.get("GEMINI_API_KEY", "")


# --------------------------------------------------------- audio + text ---

def download_audio(url: str, out_dir: Path) -> Path:
    """Audio-only download, then convert to 16 kHz mono WAV for Whisper."""
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_tpl = str(out_dir / "audio.%(ext)s")
    run(["yt-dlp", "--no-playlist", "-f", "bestaudio/best",
         "-o", raw_tpl, url], "yt-dlp audio download")
    raw = next((p for p in out_dir.glob("audio.*")
                if p.suffix.lower() in (".m4a", ".opus", ".webm", ".mp3",
                                        ".ogg", ".wav", ".aac")), None)
    if raw is None:
        raise RuntimeError("yt-dlp finished but no audio file was produced")
    wav = out_dir / "audio16k.wav"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(raw),
         "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)],
        "ffmpeg audio to 16k mono wav")
    return wav


def audio_energy_per_second(wav_path: Path) -> List[float]:
    """Per-second RMS loudness, normalised 0..1 (peaks = shouting/laughing)."""
    with wave.open(str(wav_path), "rb") as wf:
        n_frames = wf.getnframes()
        rate = wf.getframerate()
        raw = wf.readframes(n_frames)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    per_sec: List[float] = []
    for start in range(0, len(samples), rate):
        chunk = samples[start:start + rate]
        per_sec.append(float(np.sqrt(np.mean(chunk ** 2))) if len(chunk) else 0.0)
    if not per_sec:
        return []
    peak = float(np.percentile(per_sec, 99)) or 1.0
    return [min(1.0, v / peak) for v in per_sec]


_WHISPER_MODEL = None
_WHISPER_LOCK = threading.Lock()


def get_whisper_model():
    """Lazy singleton: large-v3-turbo on the T4 (float16), CPU fallback."""
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        with _WHISPER_LOCK:
            if _WHISPER_MODEL is None:
                from faster_whisper import WhisperModel
                device = "cuda" if has_gpu() else "cpu"
                compute = "float16" if device == "cuda" else "int8"
                log(f"loading Whisper {WHISPER_MODEL_NAME} on {device} ({compute})")
                _WHISPER_MODEL = WhisperModel(WHISPER_MODEL_NAME,
                                              device=device, compute_type=compute)
    return _WHISPER_MODEL


def transcribe_audio(wav_path: Path, language: Optional[str] = None) -> Tuple[List[Dict[str, Any]], str, float]:
    """Transcribe with word timestamps. Returns (segments, language, duration).

    Each segment: {"start", "end", "text", "words": [{"w", "s", "e"}]}.
    """
    model = get_whisper_model()
    segments, info = model.transcribe(
        str(wav_path), language=language, word_timestamps=True,
        vad_filter=True, condition_on_previous_text=False)
    out: List[Dict[str, Any]] = []
    for seg in segments:
        words = [{"w": w.word.strip(), "s": float(w.start), "e": float(w.end)}
                 for w in (seg.words or []) if w.word.strip()]
        out.append({"start": float(seg.start), "end": float(seg.end),
                    "text": seg.text.strip(), "words": words})
    return out, info.language, float(info.duration)


def chunk_transcript(segments: List[Dict[str, Any]],
                     chunk_seconds: int = TRANSCRIPT_CHUNK_SECONDS,
                     overlap_seconds: int = TRANSCRIPT_CHUNK_OVERLAP
                     ) -> List[Dict[str, Any]]:
    """Split the transcript into ~20-minute overlapping chunks.

    The Gemini roadmap's 45,000-character truncation silently dropped
    everything past ~1.5-2 hours of speech. Chunking keeps the whole video
    scorable: each chunk is scored on its own and candidates are merged.
    """
    words: List[Dict[str, Any]] = []
    for seg in segments:
        words.extend(seg["words"])
    if not words:
        return []
    total = words[-1]["e"]
    chunks: List[Dict[str, Any]] = []
    start = 0.0
    step = float(chunk_seconds - overlap_seconds)
    while start < total:
        end = min(total, start + chunk_seconds)
        cw = [w for w in words if start <= w["s"] < end]
        if cw:
            chunks.append({"start": start, "end": end,
                           "text": " ".join(w["w"] for w in cw),
                           "words": cw})
        start += step
    return chunks

# ------------------------------------------------------------- scoring ---

HOOK_WORDS = re.compile(
    r"\b(why|how|secret|never|stop|mistake|percent|million|truth|first|best|"
    r"worst|insane|crazy|amazing|free|warning|nobody|everyone|always|"
    r"actually|real|hidden|broke|exposed|finally|nobody tells|watch this)\b",
    re.IGNORECASE)

GEMINI_SYSTEM = (
    "You are an expert viral short-form editor for YouTube Shorts, TikTok "
    "and Instagram Reels. You pick self-contained moments that work as "
    "standalone vertical clips: the hook must land in the first 3 seconds "
    "and the payoff must happen inside the clip, so a viewer who never saw "
    "the full stream still understands it."
)

GEMINI_PROMPT = """{system}

Transcript chunk [{chunk_start} - {chunk_end}] of a stream (timestamps are
absolute seconds in the full video). The user wants {num_clips} clips of
about {duration} seconds each.

Score every candidate on four pillars, 0-100 total:
- Hook: does the opening grab attention in the first 3 seconds?
- Flow: logical progression with a satisfying ending inside the clip?
- Value: something worth watching, a quotable line, a revelation, a skill,
  a funny moment, a strong opinion?
- Trend: does it match what this audience cares about right now?

{context_notes}

Return a JSON array (no other text) of up to {num_clips} candidates:
[{{"title": "short hook title, max 8 words",
   "start_sec": 123.4, "end_sec": 153.4,
   "virality_score": 87,
   "hook": "the exact opening line that grabs attention",
   "reason": "one line: why this moment works",
   "retention_insight": "one line: why viewers stay to the end",
   "pacing_note": "one line: how the clip is paced"}}]
Rules: start_sec/end_sec are ABSOLUTE seconds in the full video and must
fall inside this chunk [{chunk_start} - {chunk_end}]. end_sec - start_sec
should be close to {duration} seconds. Prefer moments that are
self-contained. Never invent dialogue that is not in the transcript.
"""

GEMINI_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING"},
            "start_sec": {"type": "NUMBER"},
            "end_sec": {"type": "NUMBER"},
            "virality_score": {"type": "NUMBER"},
            "hook": {"type": "STRING"},
            "reason": {"type": "STRING"},
            "retention_insight": {"type": "STRING"},
            "pacing_note": {"type": "STRING"},
        },
        "required": ["title", "start_sec", "end_sec", "virality_score",
                     "hook", "reason"],
    },
}


def _validate_candidates(raw: Any, chunk: Dict[str, Any],
                         duration: int) -> List[Dict[str, Any]]:
    """Coerce + validate LLM output. Returns only well-formed candidates."""
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item["start_sec"])
            end = float(item["end_sec"])
            score = int(round(float(item["virality_score"])))
        except (KeyError, TypeError, ValueError):
            continue
        title = str(item.get("title", "")).strip()
        hook = str(item.get("hook", "")).strip()
        reason = str(item.get("reason", "")).strip()
        if not title or not hook or not reason:
            continue
        if not (0.0 <= start < end):
            continue
        # keep the candidate inside its chunk (allow 5 s of slack)
        start = max(chunk["start"] - 5.0, min(start, chunk["end"]))
        end = max(start + 5.0, min(end, chunk["end"] + 5.0))
        out.append({
            "title": title[:90],
            "start_sec": round(start, 2),
            "end_sec": round(end, 2),
            "virality_score": max(0, min(100, score)),
            "hook": hook[:200],
            "reason": reason[:300],
            "retention_insight": str(item.get("retention_insight", ""))[:300],
            "pacing_note": str(item.get("pacing_note", ""))[:300],
        })
    return out


def score_chunk_with_gemini(client: Any, chunk: Dict[str, Any],
                            duration: int, num_clips: int,
                            context_notes: Optional[str]) -> List[Dict[str, Any]]:
    """Score one transcript chunk with Gemini. JSON validation + 2 retries."""
    from google.genai import types
    notes = (f"Creator notes: {context_notes.strip()}"
             if context_notes and context_notes.strip() else "")
    prompt = GEMINI_PROMPT.format(
        system=GEMINI_SYSTEM,
        chunk_start=fmt_clock(chunk["start"]), chunk_end=fmt_clock(chunk["end"]),
        num_clips=num_clips, duration=duration, context_notes=notes)
    last_error: Optional[Exception] = None
    for attempt in range(3):  # 1 try + 2 retries
        try:
            resp = client.models.generate_content(
                model=GEMINI_MODEL, contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=GEMINI_SCHEMA))
            text = (resp.text or "").strip()
            cands = _validate_candidates(json.loads(text), chunk, duration)
            if cands:
                return cands
            last_error = ValueError("Gemini returned valid JSON but no "
                                    "usable candidates")
            prompt += ("\n\nYour previous reply had no usable candidates. "
                       "Return ONLY the JSON array, with all required fields.")
        except Exception as exc:  # noqa: BLE001 - retry, then fall through
            last_error = exc
            prompt += ("\n\nYour previous reply was not valid JSON. "
                       "Return ONLY the JSON array, nothing else.")
    raise RuntimeError(f"Gemini scoring failed after 3 attempts: {last_error}")


def score_with_gemini(chunks: List[Dict[str, Any]], duration: int,
                      num_clips: int,
                      context_notes: Optional[str]) -> Tuple[List[Dict[str, Any]], str]:
    """Score every chunk, merge, dedupe, clamp. Returns (candidates, 'gemini').

    Raises RuntimeError if the key is missing or all chunks fail, so the
    caller can fall back to the deterministic scorer (never silently).
    """
    key = get_gemini_key()
    if not key:
        raise RuntimeError("no GEMINI_API_KEY in Colab Secrets")
    from google import genai
    client = genai.Client(api_key=key)
    all_cands: List[Dict[str, Any]] = []
    for i, chunk in enumerate(chunks):
        log(f"Gemini scoring chunk {i + 1}/{len(chunks)} "
            f"({fmt_clock(chunk['start'])}-{fmt_clock(chunk['end'])})")
        all_cands.extend(score_chunk_with_gemini(client, chunk, duration,
                                                 num_clips, context_notes))
    return all_cands, "gemini"


def fallback_score(segments: List[Dict[str, Any]], energy: List[float],
                   duration: int, num_clips: int) -> Tuple[List[Dict[str, Any]], str]:
    """Deterministic scorer, used when there is no Gemini key or Gemini fails.

    Sliding windows over the transcript; each window is scored from hook
    keywords + questions + how loud the audio is in that window (shouting /
    laughing = energy peaks). Clearly labelled 'fallback' in every clip.
    """
    words: List[Dict[str, Any]] = []
    for seg in segments:
        words.extend(seg["words"])
    if not words:
        return [], "fallback"
    total = words[-1]["e"]
    step = max(5.0, duration / 2.0)
    cands: List[Dict[str, Any]] = []
    t = 0.0
    while t + duration <= total:
        window_words = [w for w in words if t <= w["s"] < t + duration]
        text = " ".join(w["w"] for w in window_words)
        if len(window_words) >= 8:
            keyword_hits = len(HOOK_WORDS.findall(text))
            questions = text.count("?")
            wpm = len(window_words) / (duration / 60.0)
            e_lo, e_hi = int(t), min(len(energy), int(t + duration))
            e_mean = float(np.mean(energy[e_lo:e_hi])) if e_hi > e_lo else 0.0
            e_max = float(np.max(energy[e_lo:e_hi])) if e_hi > e_lo else 0.0
            score = 70
            score += min(12, keyword_hits * 2)
            score += min(6, questions * 3)
            score += int(round(e_mean * 6)) + int(round(e_max * 4))
            score += 2 if 120 <= wpm <= 200 else 0
            first_words = " ".join(w["w"] for w in window_words[:7]).strip()
            cands.append({
                "title": (first_words[:60].rstrip(".,!?") or "Moment").title(),
                "start_sec": round(t, 2), "end_sec": round(t + duration, 2),
                "virality_score": max(0, min(97, score)),
                "hook": first_words[:120],
                "reason": (f"Fallback pick: {keyword_hits} hook words, "
                           f"{questions} question(s), loudness peak "
                           f"{e_max:.2f}."),
                "retention_insight": "",
                "pacing_note": f"{len(window_words)} words in {duration}s.",
            })
        t += step
    return cands, "fallback"


def overlap_fraction(a: Dict[str, Any], b: Dict[str, Any]) -> float:
    """Intersection / shorter clip length."""
    inter = max(0.0, min(a["end_sec"], b["end_sec"])
                - max(a["start_sec"], b["start_sec"]))
    shorter = min(a["end_sec"] - a["start_sec"],
                  b["end_sec"] - b["start_sec"])
    return inter / shorter if shorter > 0 else 0.0


def dedupe_candidates(cands: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Highest score first; drop any clip overlapping >50% of a kept clip."""
    kept: List[Dict[str, Any]] = []
    for cand in sorted(cands, key=lambda c: -c["virality_score"]):
        if any(overlap_fraction(cand, k) > MAX_OVERLAP_KEEP for k in kept):
            continue
        kept.append(cand)
    return kept


def clamp_to_duration(cand: Dict[str, Any], duration: int,
                      total_duration: float) -> Dict[str, Any]:
    """Enforce the requested clip length exactly (hook at the start is kept).

    The Gemini roadmap asked the LLM for 'around N seconds' but never
    enforced it, so clips came back 20 s or 90 s. Here the length is exact:
    end = start + duration, pulled back inside the video if needed.
    """
    start = float(cand["start_sec"])
    end = start + float(duration)
    if end > total_duration:
        end = total_duration
        start = max(0.0, end - float(duration))
    cand = dict(cand)
    cand["start_sec"] = round(start, 2)
    cand["end_sec"] = round(end, 2)
    cand["duration_sec"] = round(end - start, 2)
    return cand

# ------------------------------------------------- facecam + layout ---

SAMPLE_W = 640
SAMPLE_FPS = 2
MAX_SAMPLES = 90


def sample_frames(path: Path, start: float, length: float,
                  info: Dict[str, Any]) -> Tuple[np.ndarray, float]:
    """Low-res BGR frames from [start, start+length). Returns (frames, scale).

    Frames are pulled with ffmpeg (no OpenCV video decoding), exactly like
    stream-clips frame.py, so behaviour is the same on any machine.
    """
    h = even(info["height"] * SAMPLE_W / info["width"])
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.3f}",
           "-t", f"{length:.3f}", "-i", str(path), "-an",
           "-vf", f"fps={SAMPLE_FPS},scale={SAMPLE_W}:{h}",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    size = SAMPLE_W * h * 3
    n = len(raw) // size
    if not n:
        return np.zeros((0, h, SAMPLE_W, 3), np.uint8), info["width"] / SAMPLE_W
    frames = np.frombuffer(raw[: n * size], np.uint8).reshape(n, h, SAMPLE_W, 3)
    if n > MAX_SAMPLES:
        frames = frames[np.linspace(0, n - 1, MAX_SAMPLES).astype(int)]
    return frames, info["width"] / SAMPLE_W


def _yunet_model_path() -> Optional[Path]:
    """YuNet face model, downloaded once into the work dir (cached)."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
    if model.exists() and model.stat().st_size > 100_000:
        return model
    try:
        import urllib.request
        log("downloading YuNet face model (one-time, ~300 KB)...")
        urllib.request.urlretrieve(YUNET_URL, model)
        if model.stat().st_size > 100_000:
            return model
    except Exception as exc:  # noqa: BLE001 - fall through to other detectors
        log(f"YuNet download failed ({exc}); using the next detector")
    return None


def detect_faces(frames: np.ndarray) -> List[Tuple[int, float, float, float, float]]:
    """[(frame_index, x, y, w, h)] in sample pixels.

    Detector chain, in order: YuNet (OpenCV DNN, the stream-clips choice),
    then MediaPipe FaceDetection, then the Haar cascade. First one that
    works is used for the whole clip.
    """
    import cv2
    if not len(frames):
        return []
    try:
        cv2.setLogLevel(2)  # errors only
    except AttributeError:
        pass
    h, w = frames.shape[1:3]
    model = _yunet_model_path()
    if model is not None and hasattr(cv2, "FaceDetectorYN"):
        try:
            det = cv2.FaceDetectorYN.create(str(model), "", (w, h), 0.65, 0.3, 50)
            out = []
            for i, f in enumerate(frames):
                _, found = det.detect(np.ascontiguousarray(f))
                for row in ([] if found is None else found):
                    x, y, fw, fh = [float(v) for v in row[:4]]
                    if fw > 6 and fh > 6:
                        out.append((i, x, y, fw, fh))
            if out:
                return out
        except Exception as exc:  # noqa: BLE001 - next detector
            log(f"YuNet detect failed ({exc}); trying MediaPipe")
    try:
        import mediapipe as mp
        detector = mp.solutions.face_detection.FaceDetection(
            model_selection=0, min_detection_confidence=0.5)
        out = []
        for i, f in enumerate(frames):
            res = detector.process(cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
            for d in (res.detections or []):
                box = d.location_data.relative_bounding_box
                out.append((i, box.xmin * w, box.ymin * h,
                            box.width * w, box.height * h))
        detector.close()
        if out:
            return out
    except Exception as exc:  # noqa: BLE001 - next detector
        log(f"MediaPipe detect failed ({exc}); trying Haar cascade")
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    out = []
    for i, f in enumerate(frames):
        gray = cv2.equalizeHist(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
        for x, y, fw, fh in cascade.detectMultiScale(gray, 1.1, 5, minSize=(14, 14)):
            out.append((i, float(x), float(y), float(fw), float(fh)))
    return out


def group_tracks(dets: List[Tuple[int, float, float, float, float]],
                 frames: np.ndarray) -> List[Dict[str, Any]]:
    """Group detections that stay in the same place into tracks."""
    if not dets:
        return []
    n, h, w = len(frames), frames.shape[1], frames.shape[2]
    groups: List[Dict[str, Any]] = []
    for d in sorted(dets):
        cx, cy = d[1] + d[3] / 2, d[2] + d[4] / 2
        for g in groups:
            if abs(cx - g["cx"]) < 0.07 * w and abs(cy - g["cy"]) < 0.10 * h:
                g["items"].append(d)
                k = len(g["items"])
                g["cx"] += (cx - g["cx"]) / k
                g["cy"] += (cy - g["cy"]) / k
                break
        else:
            groups.append({"cx": cx, "cy": cy, "items": [d]})
    gray = frames.mean(axis=3)
    out = []
    for g in groups:
        idx = sorted({d[0] for d in g["items"]})
        box = np.median(np.array([d[1:] for d in g["items"]]), axis=0)
        x, y, bw, bh = [int(v) for v in box]
        patch = gray[:, max(0, y):y + max(2, bh), max(0, x):x + max(2, bw)]
        motion = float(np.abs(np.diff(patch, axis=0)).mean()) if len(patch) > 1 else 0.0
        out.append({"box": tuple(float(v) for v in box),
                    "presence": len(idx) / n, "size": box[2] / w,
                    "alive": motion > 1.2, "items": g["items"]})
    return sorted(out, key=lambda t: -t["presence"])


def find_cam_box(frames: np.ndarray,
                 face: Tuple[float, float, float, float]
                 ) -> Tuple[Tuple[float, float, float, float], str]:
    """The facecam overlay box around `face` (sample pixels), and how it
    was found. Persistent Canny edges across the clip reveal the overlay
    border; if no border scores, fall back to a box sized from the face.
    (stream-clips frame.py cam_box, unchanged in logic.)"""
    import cv2
    n, H, W = frames.shape[:3]
    fx, fy, fw, fh = face
    persist = np.zeros((H, W), np.float32)
    for f in frames:
        persist += cv2.Canny(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), 60, 150) > 0
    persist /= max(1, n)
    persist = cv2.dilate(persist, np.ones((3, 3), np.uint8))
    xs = slice(int(max(0, fx - fw)), int(min(W, fx + 2 * fw)))
    ys = slice(int(max(0, fy - 0.5 * fh)), int(min(H, fy + 2 * fh)))
    rows = persist[:, xs].mean(axis=1)
    cols = persist[ys, :].mean(axis=0)

    def strongest(scores, a, b, edge):
        a, b = int(max(0, a)), int(min(len(scores), b))
        if b - a < 2:
            return edge
        seg = scores[a:b]
        k = int(np.argmax(seg))
        return a + k if seg[k] >= 0.6 else edge

    top = strongest(rows, fy - 4.0 * fh, fy - 0.3 * fh, 0 if fy - 4.0 * fh <= 0 else None)
    bottom = strongest(rows, fy + 1.4 * fh, fy + 5.0 * fh, H if fy + 5.0 * fh >= H else None)
    left = strongest(cols, fx - 6.0 * fw, fx - 0.3 * fw, 0 if fx - 6.0 * fw <= 0 else None)
    right = strongest(cols, fx + 1.3 * fw, fx + 7.0 * fw, W if fx + 7.0 * fw >= W else None)
    if None not in (top, bottom, left, right):
        bw, bh = right - left, bottom - top
        if (2.0 * fw <= bw <= 10 * fw and 1.8 * fh <= bh <= 7 * fh
                and bw <= 0.65 * W and bh <= 0.75 * H and 0.6 <= bw / bh <= 2.6):
            return (float(left), float(top), float(bw), float(bh)), "overlay edges"
    bw = min(4.5 * fw, 0.6 * W)
    bh = min(bw * 0.75, 0.7 * H)
    x0 = min(max(fx + fw / 2 - bw / 2, 0), W - bw)
    y0 = min(max(fy + fh / 2 - 0.42 * bh, 0), H - bh)
    return (x0, y0, bw, bh), "face size"


def detect_facecam(source: Path, start: float, length: float,
                   info: Dict[str, Any], memory: Dict[str, Any]
                   ) -> Tuple[Optional[Tuple[float, float, float, float]], str]:
    """Find the streamer's facecam box for one clip segment.

    Returns (cam box in SOURCE pixels, method) or (None, reason). `memory`
    is the job's saved facecam spot: if this segment's face sits inside the
    box another clip of the same stream used, that box is reused (the cam
    does not move mid-stream).
    """
    frames, scale = sample_frames(source, start, length, info)
    if not len(frames):
        return None, "no frames sampled"
    tracks = group_tracks(detect_faces(frames), frames)
    live = [t for t in tracks if t["alive"] and t["presence"] >= 0.3]
    big_face = 0.13  # face wider than this share of the frame = talking head
    small = [t for t in live if t["size"] < big_face]
    if small:
        t = small[0]
        box, how = find_cam_box(frames, t["box"])
        cam = tuple(v * scale for v in box)
        mem = memory.get("cam")
        if how == "face size" and mem:
            fx, fy, fw, fh = t["box"]
            cx, cy = (fx + fw / 2) * scale, (fy + fh / 2) * scale
            if mem[0] <= cx <= mem[0] + mem[2] and mem[1] <= cy <= mem[1] + mem[3]:
                return tuple(mem), "this stream's other clips"
        if how == "overlay edges":
            memory["cam"] = list(cam)
        return cam, how
    mem = memory.get("cam")
    if mem and any(True for t in tracks
                   if mem[0] <= (t["box"][0] + t["box"][2] / 2) * scale <= mem[0] + mem[2]
                   and mem[1] <= (t["box"][1] + t["box"][3] / 2) * scale <= mem[1] + mem[3]):
        return tuple(mem), "this stream's other clips"
    return None, "no facecam found"


def detect_scenes(path: Path, start: float = 0.0,
                  end: Optional[float] = None) -> List[Tuple[float, float]]:
    """Scene boundaries (seconds) via PySceneDetect ContentDetector.

    Used as a CUT RESET for the talking-head crop fallback: the follow
    window restarts at each cut instead of gliding across it. Returns [] if
    detection is unavailable (never fails the job).
    """
    try:
        from scenedetect import ContentDetector, SceneManager, open_video
        video = open_video(str(path))
        manager = SceneManager()
        manager.add_detector(ContentDetector())
        manager.detect_scenes(video, start_time=start,
                              end_time=end, show_progress=False)
        return [(s.get_seconds(), e.get_seconds())
                for s, e in manager.get_scene_list()]
    except Exception as exc:  # noqa: BLE001 - scenes are an enhancement
        log(f"scene detection unavailable ({exc})")
        return []


def stack_filtergraph(info: Dict[str, Any],
                      cam: Tuple[float, float, float, float]) -> Tuple[str, int]:
    """Facecam panel on top (1080x720), gameplay panel below (1080x1200).

    Same composite as the approved CarryMinati 9:16 encode and stream-clips
    stack_graph, with the split fixed at 720/1200. `cam` is in source px.
    The gameplay window slides away if it would cover the facecam box.
    """
    W, TOP, LOW = OUT_W, CAM_H, GAME_H
    sw, sh = info["width"], info["height"]
    x, y, w, h = cam
    aim = W / TOP
    cw, ch = (h * aim, h) if w / h > aim else (w, w / aim)
    cx = min(max(x + (w - cw) / 2, 0), sw - cw)
    cy = min(max(y + (h - ch) / 2, 0), sh - ch)
    gw = min(sw, sh * W / LOW)
    gx = (sw - gw) / 2
    if gx < x + w and gx + gw > x:
        if x + w / 2 < sw / 2:
            gx = min(sw - gw, gx + min(x + w - gx, 0.5 * (sw - gw - gx)))
        else:
            gx = max(0.0, gx - min(gx + gw - x, 0.5 * gx))
    graph = (f"[0:v]split=2[c0][g0];"
             f"[c0]crop={even(cw)}:{even(ch)}:{even(cx)}:{even(cy)},"
             f"scale={W}:{TOP}:flags=lanczos,setsar=1[c1];"
             f"[g0]crop={even(gw)}:{even(sh)}:{even(gx)}:0,"
             f"scale={W}:{LOW}:flags=lanczos,setsar=1[g1];"
             f"[c1][g1]vstack=inputs=2,format=yuv420p[framed]")
    return graph, SEAM_Y


def blur_filtergraph(info: Dict[str, Any]) -> Tuple[str, int]:
    """No-facecam fallback: blurred full frame on top (1080x720),
    gameplay below (1080x1200). Never fails the clip over a missing cam."""
    W, TOP, LOW = OUT_W, CAM_H, GAME_H
    sw, sh = info["width"], info["height"]
    gw = min(sw, sh * W / LOW)
    gx = (sw - gw) / 2
    graph = (f"[0:v]split=2[bg0][g0];"
             f"[bg0]scale={W}:{TOP}:force_original_aspect_ratio=increase,"
             f"crop={W}:{TOP},boxblur=20:2,eq=brightness=-0.08[bg1];"
             f"[g0]crop={even(gw)}:{even(sh)}:{even(gx)}:0,"
             f"scale={W}:{LOW}:flags=lanczos,setsar=1[g1];"
             f"[bg1][g1]vstack=inputs=2,format=yuv420p[framed]")
    return graph, SEAM_Y


def crop_filtergraph(info: Dict[str, Any], track: Dict[str, Any],
                     n_frames: int, scale: float,
                     scenes: List[Tuple[float, float]],
                     clip_start: float) -> Tuple[str, None]:
    """Talking-head fallback: a 9:16 window that follows the face.

    Keyframes once a second with cosine easing (stream-clips crop_graph).
    Scene cuts RESET the window: a new keyframe is forced at each cut so
    the window never glides across a cut to a face in another shot.
    """
    sw, sh = info["width"], info["height"]
    cw = even(min(sw, sh * OUT_W / OUT_H))
    limit = sw - cw
    centre = np.full(n_frames, np.nan)
    for i, x, _, w, _ in track["items"]:
        centre[i] = (x + w / 2) * scale
    known = np.where(~np.isnan(centre))[0]
    if not len(known):
        centre = np.full(n_frames, sw / 2)
    else:
        centre = np.interp(np.arange(n_frames), known, centre[known])
    k = 5
    smooth = np.convolve(np.pad(centre, k // 2, mode="edge"),
                         np.ones(k) / k, mode="valid")
    xs = np.clip(smooth - cw / 2, 0, limit)
    # scene cuts in clip-relative seconds (a cut anywhere between the last
    # keyframe and this one forces a new keyframe: the window restarts
    # instead of gliding across the cut)
    cut_times = sorted(s - clip_start for s, _ in scenes[1:])
    keys = [(0.0, xs[0])]
    for i in range(SAMPLE_FPS, n_frames, SAMPLE_FPS):
        t = i / SAMPLE_FPS
        crossed_cut = any(keys[-1][0] < c <= t for c in cut_times)
        if abs(xs[i] - keys[-1][1]) > 0.04 * sw or crossed_cut:
            keys.append((float(t), xs[i]))
    keys = keys[:40]
    expr = f"{keys[-1][1]:.1f}"
    for (t0, a), (t1, b) in reversed(list(zip(keys, keys[1:]))):
        span = max(t1 - t0, 0.05)
        expr = (f"if(lt(t,{t1:.2f}),{a:.1f}+({b - a:.1f})*"
                f"(1-cos(PI*min(1,(t-{t0:.2f})/{span:.2f})))/2,{expr})")
    graph = (f"[0:v]crop={cw}:{even(sh)}:x='{expr}':y=0,"
             f"scale={OUT_W}:{OUT_H}:flags=lanczos,setsar=1,"
             f"format=yuv420p[framed]")
    return graph, None

# ------------------------------------------------- captions + title ---

ASS_STYLE = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,{font},{size},{fill},{fill},&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,{outline},2,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _ass_colour(hex6: str) -> str:
    """RRGGBB -> ASS &H00BBGGRR&."""
    h = hex6.lstrip("#")
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}".upper()


def _ass_time(sec: float) -> str:
    sec = max(0.0, sec)
    cs = int(round(sec * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _ass_clean(word: str) -> str:
    return word.replace("{", "").replace("}", "").replace("\\", "").strip()


def _phrases(words: List[Dict[str, Any]], size: int = 3) -> List[List[Dict[str, Any]]]:
    """Group words into short phrases (<=3 words, break on gaps/punctuation)."""
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1]["s"] - w["e"] if i + 1 < len(words) else 9.0
        punct = w["w"].endswith((".", "!", "?")) or (
            w["w"].endswith(",") and len(cur) >= 2)
        if len(cur) >= size or nxt > 0.6 or (punct and (len(cur) >= 2 or nxt > 0.25)):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def write_ass(words: List[Dict[str, Any]], duration: float,
              out_path: Path) -> Path:
    """Word-by-word karaoke .ass: one event per word; the spoken word is
    coloured yellow and slightly larger, the rest of the phrase stays white.

    Words are in CLIP time (0 = first frame). Alignment 2 (bottom-centre)
    with a 560 px bottom margin puts the captions in the gameplay area,
    clear of the platform UI that covers the bottom ~20% of a 9:16 frame.
    """
    fill = _ass_colour(CAP_FILL)
    active = _ass_colour(CAP_ACTIVE)
    header = ASS_STYLE.format(w=OUT_W, h=OUT_H, font=CAP_FONT,
                              size=CAP_FONT_SIZE, fill=fill,
                              outline=3, margin_v=CAPTION_MARGIN_BOTTOM)
    events: List[str] = []
    for phrase in _phrases(words):
        p_start = phrase[0]["s"]
        text_words = [_ass_clean(w["w"]) for w in phrase]
        for idx, w in enumerate(phrase):
            parts = []
            for j, tw in enumerate(text_words):
                if j == idx:
                    parts.append(f"{{\\c{active}\\fs{CAP_ACTIVE_SIZE}}}{tw}"
                                 f"{{\\c{fill}\\fs{CAP_FONT_SIZE}}}")
                else:
                    parts.append(tw)
            events.append(
                f"Dialogue: 0,{_ass_time(p_start)},{_ass_time(w['e'])},Word,,0,0,0,,"
                + " ".join(parts))
    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_path


def render_title_png(title: str, out_path: Path,
                     max_width: int = 980) -> Tuple[Path, int]:
    """Hook title as a transparent PNG: white rounded pill, black bold text
    (stream-clips titlecard style: white bg, black text, size 56). Returns
    (path, png height in px) so the caller can centre it on the seam."""
    from PIL import Image, ImageDraw, ImageFont
    font = None
    for candidate in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                      "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        try:
            font = ImageFont.truetype(candidate, TITLE_FONT_SIZE)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    words = title.split()
    lines, cur = [], ""
    probe = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    for word in words:
        trial = f"{cur} {word}".strip()
        if probe.textlength(trial, font=font) <= max_width - 80:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    lines = lines[:2]  # at most two lines on the bar
    line_h = int(TITLE_FONT_SIZE * 1.35)
    pad_x, pad_y = 44, 26
    text_w = max(int(probe.textlength(line, font=font)) for line in lines) if lines else 0
    width = min(max_width, text_w + pad_x * 2)
    height = line_h * len(lines) + pad_y * 2
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, width - 1, height - 1], radius=height // 2,
                           fill=(255, 255, 255, 235))
    y = pad_y
    for line in lines:
        draw.text(((width - probe.textlength(line, font=font)) / 2, y),
                  line, font=font, fill=(17, 17, 17, 255))
        y += line_h
    img.save(out_path)
    return out_path, height


# ------------------------------------------------------- segment + render ---

def download_segment(url: str, start: float, end: float,
                     out_path: Path, platform: str) -> Path:
    """Download ONLY the chosen segment at <=1080p.

    Direct .mp4 links (incl. Frame.io direct links) are cut with ffmpeg over
    HTTP (fast seek). Everything else uses yt-dlp --download-sections.
    """
    if platform in ("direct-mp4", "frameio"):
        run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}",
             "-i", url, "-t", f"{end - start:.3f}",
             "-c", "copy", "-movflags", "+faststart", str(out_path)],
            "ffmpeg direct-mp4 segment cut")
        return out_path
    run(["yt-dlp", "--no-playlist", "--download-sections",
         f"*{fmt_hms(start)}-{fmt_hms(end)}",
         "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]",
         "--merge-output-format", "mp4", "-o", str(out_path), url],
        "yt-dlp segment download")
    return out_path


def render_clip(source: Path, clip: Dict[str, Any], layout: str,
                cam: Optional[Tuple[float, float, float, float]],
                track: Optional[Dict[str, Any]], info: Dict[str, Any],
                words: List[Dict[str, Any]], out_path: Path) -> Path:
    """Render ONE clip in a SINGLE ffmpeg pass.

    The Gemini roadmap's crop re-encoded every frame in Python (mp4v) and
    then again in ffmpeg: slow and lossy. Here the crop path is computed
    first (facecam detection above) and ffmpeg does one pass:
    layout graph -> .ass caption burn-in -> title bar on the seam ->
    libx264 CRF 19 + AAC, loudnorm -14 LUFS.
    """
    start = float(clip["start_sec"])
    duration = float(clip["duration_sec"])
    clip_dir = out_path.parent
    clip_dir.mkdir(parents=True, exist_ok=True)

    if layout == "stack" and cam is not None:
        graph, seam = stack_filtergraph(info, cam)
    elif layout == "crop" and track is not None:
        frames, scale = sample_frames(source, start, duration, info)
        scenes = detect_scenes(source, start, start + duration)
        graph, seam = crop_filtergraph(info, track, len(frames), scale,
                                       scenes, start)
    else:
        graph, seam = blur_filtergraph(info)
        layout = "blur"

    ass_path = write_ass(words, duration, clip_dir / f"{out_path.stem}.ass")
    title_png, title_h = render_title_png(clip["title"],
                                          clip_dir / f"{out_path.stem}.title.png")
    if seam is not None:
        title_y = max(0, seam - title_h // 2)
    else:
        title_y = int(OUT_H * 0.07)
    # the .ass path is relative to the clip dir (ffmpeg runs there, so no
    # escaping problems with special characters in the path)
    chain = (f"{graph};[framed]ass={ass_path.name}[subbed];"
             f"[subbed][1:v]overlay=(W-w)/2:{title_y}[titled]")
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}",
           "-t", f"{duration:.3f}", "-i", str(source), "-i", str(title_png),
           "-filter_complex", chain,
           "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
           "-map", "[titled]", "-map", "0:a?",
           "-c:v", "libx264", "-preset", "fast", "-crf", "19",
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
           str(out_path)]
    res = subprocess.run(cmd, capture_output=True, text=True,
                         cwd=str(clip_dir), timeout=3600)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg render failed: {(res.stderr or '')[-2000:]}")
    if not out_path.exists() or out_path.stat().st_size < 10_000:
        raise RuntimeError("ffmpeg finished but the clip file is missing/tiny")
    return out_path

# ------------------------------------------------------------ jobs/API ---

STEP_DEFS = [
    ("download", "Downloading Stream",
     "Fetching the audio track first (video comes later, only for the clips)"),
    ("transcribe", "Transcribing Audio",
     "faster-whisper large-v3-turbo, word-level timestamps"),
    ("virality", "AI Virality Scoring",
     "Ranking scroll-stopping hooks and retention arcs"),
    ("reframe", "Facecam 9:16 Layout",
     "Facecam on top (1080x720), gameplay below (1080x1200)"),
    ("caption", "Burning Dynamic Captions",
     "Word-by-word karaoke captions on the gameplay area"),
]

JOBS: Dict[str, Dict[str, Any]] = {}
EXECUTOR = ThreadPoolExecutor(max_workers=1)  # one job at a time on free Colab
CAM_MEMORY: Dict[str, Dict[str, Any]] = {}    # job_id -> {"cam": [...]} reuse


def job_dir(job_id: str) -> Path:
    return WORK_DIR / job_id


def ckpt_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def save_ckpt(job_id: str, name: str, data: Any) -> Path:
    path = ckpt_dir(job_id) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    return path


def load_ckpt(job_id: str, name: str) -> Optional[Any]:
    path = ckpt_dir(job_id) / name
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def new_job(url: str, clip_duration: int, num_clips: int, mode: str,
            context_notes: Optional[str]) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex[:8]
    job: Dict[str, Any] = {
        "id": job_id, "status": "queued", "progress": 0,
        "source_url": url, "platform": detect_platform(url),
        "target_duration": clip_duration, "num_clips": num_clips,
        "mode": mode, "created_at": datetime.utcnow().isoformat(),
        "steps": [{"id": s, "title": t, "detail": d, "status": "pending"}
                  for s, t, d in STEP_DEFS],
        "clips": [], "scoring": None, "error": None,
    }
    JOBS[job_id] = job
    return job


def set_step(job: Dict[str, Any], step_id: str, status: str,
             detail: Optional[str] = None) -> None:
    for step in job["steps"]:
        if step["id"] == step_id:
            step["status"] = status
            if detail:
                step["detail"] = detail
            break
    progress = {"download": 10, "transcribe": 30, "virality": 50,
                "reframe": 70, "caption": 90}
    job["progress"] = progress.get(step_id, job["progress"]) if status in (
        "active", "completed") else job["progress"]


def _clip_words(segments: List[Dict[str, Any]], start: float,
                end: float) -> List[Dict[str, Any]]:
    """Words inside [start, end), retimed to clip time (0 = first frame)."""
    out = []
    for seg in segments:
        for w in seg["words"]:
            if start <= w["s"] < end:
                out.append({"w": w["w"], "s": round(w["s"] - start, 3),
                            "e": round(w["e"] - start, 3)})
    return out


def run_job(job: Dict[str, Any]) -> None:
    """Full pipeline for one job, with Drive checkpoints at every stage so a
    dead session resumes instead of restarting."""
    job_id = job["id"]
    url = job["source_url"]
    duration = int(job["target_duration"])
    num_clips = int(job["num_clips"])
    work = job_dir(job_id)
    work.mkdir(parents=True, exist_ok=True)
    job["status"] = "processing"
    try:
        # --- frame.io share links cannot be downloaded at all ------------
        if job["platform"] == "frameio" and not (
                url.lower().endswith(".mp4") or ".mp4?" in url.lower()):
            raise RuntimeError(
                "Frame.io has no yt-dlp extractor, so a frame.io share link "
                "cannot be downloaded. Open the frame in frame.io, use its "
                "Download button (or copy the direct .mp4 URL from the "
                "browser inspector <video src>) and paste THAT link instead.")

        # --- stage 1+2: audio + transcript (resumable from checkpoint) ----
        segments = load_ckpt(job_id, "transcript.json")
        meta = load_ckpt(job_id, "meta.json")
        total_duration: float
        energy: List[float] = []
        if segments and meta:
            log(f"job {job_id}: transcript checkpoint found, resuming")
            total_duration = float(meta["total_duration"])
            energy = [float(v) for v in meta.get("energy_per_second", [])]
            set_step(job, "download", "completed",
                     "Resumed from Drive checkpoint")
            set_step(job, "transcribe", "completed",
                     "Resumed from Drive checkpoint")
        else:
            set_step(job, "download", "active")
            wav = download_audio(url, work)
            set_step(job, "download", "completed")
            set_step(job, "transcribe", "active")
            segments, language, total_duration = transcribe_audio(wav)
            energy = audio_energy_per_second(wav)
            save_ckpt(job_id, "transcript.json", segments)
            save_ckpt(job_id, "meta.json", {
                "language": language, "total_duration": total_duration,
                "energy_per_second": energy,
                "source_url": url, "platform": job["platform"]})
            set_step(job, "transcribe", "completed",
                     f"{len(segments)} segments, {language}, "
                     f"{fmt_clock(total_duration)} total")
            wav.unlink(missing_ok=True)

        # --- stage 3: virality ranking (resumable) -----------------------
        ranked = load_ckpt(job_id, "ranking.json")
        scoring = load_ckpt(job_id, "scoring.json")
        if ranked and scoring:
            log(f"job {job_id}: ranking checkpoint found, resuming")
            set_step(job, "virality", "completed",
                     f"Resumed from Drive checkpoint ({scoring})")
        else:
            set_step(job, "virality", "active")
            chunks = chunk_transcript(segments)
            if not energy:
                # only when resuming a very old checkpoint without energy
                energy = [0.0] * max(1, int(total_duration))
            try:
                if job["mode"] == "fallback":
                    raise RuntimeError("fallback mode requested")
                ranked, scoring = score_with_gemini(chunks, duration,
                                                    num_clips,
                                                    job.get("context_notes"))
            except Exception as exc:  # noqa: BLE001 - deterministic fallback
                log(f"Gemini scoring unavailable ({exc}); using fallback scorer")
                ranked, scoring = fallback_score(segments, energy, duration,
                                                 num_clips)
            ranked = dedupe_candidates(ranked)
            ranked = [clamp_to_duration(c, duration, total_duration)
                      for c in ranked][:num_clips]
            for cand in ranked:
                cand["scoring"] = scoring
            save_ckpt(job_id, "ranking.json", ranked)
            save_ckpt(job_id, "scoring.json", scoring)
            job["scoring"] = scoring
            set_step(job, "virality", "completed",
                     f"{len(ranked)} candidates ({scoring} scoring)")
        job["scoring"] = scoring

        # --- stage 4+5: one segment + one render per clip ----------------
        set_step(job, "reframe", "active")
        set_step(job, "caption", "active")
        memory = CAM_MEMORY.setdefault(job_id, {})
        done_ids = {c["id"] for c in job["clips"]}
        for idx, cand in enumerate(ranked):
            clip_id = f"clip-{idx + 1:02d}"
            drive_mp4 = ckpt_dir(job_id) / f"{clip_id}.mp4"
            if clip_id in done_ids and drive_mp4.exists():
                continue  # already rendered before the session died
            seg_path = work / f"{clip_id}_source.mp4"
            if not seg_path.exists():
                download_segment(url, cand["start_sec"], cand["end_sec"],
                                 seg_path, job["platform"])
            info = probe_info(seg_path)
            cam, cam_how = detect_facecam(seg_path, 0.0,
                                          cand["duration_sec"], info, memory)
            # talking-head fallback needs the face track, not the cam box
            track = None
            layout = "stack"
            if cam is not None:
                layout = "stack"
            else:
                frames, scale = sample_frames(seg_path, 0.0,
                                              cand["duration_sec"], info)
                tracks = group_tracks(detect_faces(frames), frames)
                live = [t for t in tracks if t["alive"] and t["presence"] >= 0.5]
                big = [t for t in live if t["size"] >= 0.13]
                if len(big) == 1:
                    layout, track = "crop", big[0]
                else:
                    layout = "blur"
            words = _clip_words(segments, cand["start_sec"], cand["end_sec"])
            out_path = work / f"{clip_id}.mp4"
            render_clip(seg_path, cand, layout, cam, track, info, words,
                        out_path)
            shutil.copy2(out_path, drive_mp4)
            clip_record = {
                "id": clip_id,
                "title": cand["title"],
                "virality_score": cand["virality_score"],
                "start_time_sec": cand["start_sec"],
                "end_time_sec": cand["end_sec"],
                "duration_sec": cand["duration_sec"],
                "transcript": " ".join(w["w"] for w in words),
                "hook_reasoning": cand.get("reason", ""),
                "retention_insight": cand.get("retention_insight", ""),
                "pacing_note": cand.get("pacing_note", ""),
                "video_path": f"/api/download/{job_id}/{clip_id}",
                "layout": layout,
                "facecam": cam_how if cam is not None else "fallback: no facecam",
                "scoring": scoring,
                "source_type": "colab",
            }
            job["clips"] = [c for c in job["clips"] if c["id"] != clip_id]
            job["clips"].append(clip_record)
            save_ckpt(job_id, "clips.json", job["clips"])
            seg_path.unlink(missing_ok=True)
            log(f"job {job_id}: {clip_id} done "
                f"({cand['title'][:40]}... layout={layout})")
        set_step(job, "reframe", "completed")
        set_step(job, "caption", "completed")
        job["status"] = "completed"
        job["progress"] = 100
        save_ckpt(job_id, "clips.json", job["clips"])
        log(f"job {job_id}: COMPLETED, {len(job['clips'])} clips")
    except Exception as exc:  # noqa: BLE001 - surfaced in job status
        job["status"] = "failed"
        job["error"] = str(exc)[:1000]
        log(f"job {job_id}: FAILED - {exc}")


# ------------------------------------------------------------------ API ---

class ProcessUrlRequest(BaseModel):
    url: str
    clip_duration: int = 30       # seconds per clip: 10-180 (custom allowed)
    num_clips: int = 5            # 1-20
    mode: str = "gemini"          # "gemini" or "fallback"
    context_notes: Optional[str] = None


app = FastAPI(title="SnapReel Studio Colab Backend", version="2.0.0")

# CORS: the SnapReel Studio web app (Google AI Studio origin) calls this
# server cross-origin from the browser. Without these headers the browser
# blocks every response and Connect & Test fails with "Failed to fetch"
# even though the server and tunnel are healthy. Added 2026-11-19 after
# Connect & Test failed from every browser while Colab-side checks
# returned 200.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok",
            "service": "SnapReel Studio Colab Backend",
            "gpu": has_gpu(),
            "drive_mounted": DRIVE_ROOT.exists(),
            "gemini_key_set": bool(get_gemini_key())}


@app.post("/api/process-url", status_code=202)
def process_url(req: ProcessUrlRequest) -> Dict[str, Any]:
    url = (req.url or "").strip()
    if not url or not url.startswith("http"):
        raise HTTPException(400, "A video URL is required.")
    duration = max(10, min(180, int(req.clip_duration)))
    num_clips = max(1, min(20, int(req.num_clips)))
    mode = req.mode if req.mode in ("gemini", "fallback") else "gemini"
    job = new_job(url, duration, num_clips, mode, req.context_notes)
    EXECUTOR.submit(run_job, job)
    return {"jobId": job["id"], "status": job["status"],
            "platform": job["platform"]}


@app.get("/api/status/{job_id}")
def job_status(job_id: str) -> Dict[str, Any]:
    job = JOBS.get(job_id)
    if job is None:
        # a resumed session may have the checkpoint but not the memory job
        ckpts = load_ckpt(job_id, "clips.json")
        if ckpts is None:
            raise HTTPException(404, "Job not found.")
        return {"id": job_id, "status": "completed", "progress": 100,
                "clips": ckpts,
                "note": "Restored from Drive checkpoint (server restarted)."}
    return job


@app.get("/api/download/{job_id}/{clip_id}")
def download_clip(job_id: str, clip_id: str) -> FileResponse:
    local = job_dir(job_id) / f"{clip_id}.mp4"
    if local.exists():
        path = local
    else:
        path = ckpt_dir(job_id) / f"{clip_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Clip not found.")
    return FileResponse(
        path, media_type="video/mp4",
        filename=f"snapreel_{job_id}_{clip_id}_1080x1920.mp4")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
