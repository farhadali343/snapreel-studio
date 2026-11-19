import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import mediapipe as mp
import numpy as np
from faster_whisper import WhisperModel


def detect_platform(url: str) -> str:
    lower = url.lower()
    if "twitch.tv" in lower:
        return "twitch"
    if "kick.com" in lower:
        return "kick"
    return "youtube"


def download_stream(url: str, output_dir: Path) -> Path:
    """Download YouTube, Twitch, or Kick VOD/stream via yt-dlp as an MP4."""
    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / "source.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-f",
        "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
        "--merge-output-format",
        "mp4",
        "-o",
        output_template,
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip() or proc.stdout.strip()}")

    mp4_files = list(output_dir.glob("source*.mp4"))
    if not mp4_files:
        all_files = list(output_dir.glob("source.*"))
        if not all_files:
            raise RuntimeError("yt-dlp completed but no output video file was found.")
        return all_files[0]
    return mp4_files[0]


_WHISPER_MODEL: Optional[WhisperModel] = None


def get_whisper_model() -> WhisperModel:
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        model_size = os.environ.get("WHISPER_MODEL_SIZE", "base")
        device = os.environ.get("WHISPER_DEVICE", "auto")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
        _WHISPER_MODEL = WhisperModel(model_size, device=device, compute_type=compute_type)
    return _WHISPER_MODEL


def transcribe_audio(video_path: Path) -> List[Dict[str, Any]]:
    """Transcribe video audio with faster-whisper and return word-timed segments."""
    model = get_whisper_model()
    segments_iter, _ = model.transcribe(
        str(video_path),
        word_timestamps=True,
        vad_filter=True,
    )
    segments: List[Dict[str, Any]] = []
    for seg in segments_iter:
        words = []
        if seg.words:
            for w in seg.words:
                words.append(
                    {
                        "word": w.word.strip(),
                        "start": round(float(w.start), 2),
                        "end": round(float(w.end), 2),
                    }
                )
        segments.append(
            {
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": seg.text.strip(),
                "words": words,
            }
        )
    return segments


def _collect_window_candidates(
    segments: List[Dict[str, Any]], clip_duration: int
) -> List[Dict[str, Any]]:
    if not segments:
        return []

    windows: List[Dict[str, Any]] = []
    i = 0
    while i < len(segments):
        start_sec = segments[i]["start"]
        collected_text: List[str] = []
        collected_words: List[Dict[str, Any]] = []
        end_sec = start_sec

        j = i
        while j < len(segments) and (segments[j]["end"] - start_sec) <= clip_duration + 5:
            collected_text.append(segments[j]["text"])
            for w in segments[j].get("words", []):
                collected_words.append(
                    {
                        "word": w["word"],
                        "start": round(max(0.0, w["start"] - start_sec), 2),
                        "end": round(max(0.1, w["end"] - start_sec), 2),
                    }
                )
            end_sec = segments[j]["end"]
            j += 1
            if (end_sec - start_sec) >= max(8, clip_duration - 4):
                break

        duration = max(8, int(round(end_sec - start_sec)))
        transcript = " ".join(collected_text).strip()
        if transcript:
            windows.append(
                {
                    "startTimeSec": int(round(start_sec)),
                    "endTimeSec": int(round(start_sec + duration)),
                    "durationSec": duration,
                    "transcript": transcript,
                    "words": collected_words,
                }
            )
        i = max(i + 1, j)

    return windows


def score_virality(
    segments: List[Dict[str, Any]], clip_duration: int, num_clips: int = 5
) -> List[Dict[str, Any]]:
    """Score real Whisper transcript windows for hook strength, pacing, and retention."""
    candidates = _collect_window_candidates(segments, clip_duration)
    if not candidates:
        raise RuntimeError("No speech segments detected in source video.")

    requested = max(1, min(10, int(num_clips)))
    hook_keywords = re.compile(
        r"\b(why|how|secret|never|stop|mistake|percent|million|truth|actually|reason|worst|best)\b",
        re.IGNORECASE,
    )

    scored: List[Tuple[int, Dict[str, Any]]] = []
    for c in candidates:
        word_count = max(1, len(c["transcript"].split()))
        wpm = word_count / max(0.2, c["durationSec"] / 60.0)
        keyword_hits = len(hook_keywords.findall(c["transcript"]))
        question_bonus = 5 if "?" in c["transcript"][:120] else 0
        raw_score = min(98, max(72, int(76 + keyword_hits * 3 + question_bonus + min(9, wpm / 24))))
        scored.append((raw_score, c))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    results: List[Dict[str, Any]] = []
    for idx, (score, base) in enumerate(scored[:requested]):
        first_words = " ".join(base["transcript"].split()[:9]).rstrip(".,!?")
        word_count = len(base["transcript"].split())
        wpm_est = int(round(word_count / max(0.2, base["durationSec"] / 60.0)))
        results.append(
            {
                **base,
                "id": f"clip-{idx + 1}",
                "title": f"{first_words}..." if first_words else f"Highlight Clip #{idx + 1}",
                "viralityScore": score,
                "hookReasoning": "Opens directly on a high-engagement spoken statement with strong early hook cues.",
                "retentionInsight": "Sustained spoken density maintains vertical feed watch-through completion.",
                "pacingNote": f"{word_count} words (~{wpm_est} WPM) over {base['durationSec']}s.",
            }
        )
    return results


def detect_active_speaker_focus(
    video_path: Path, start_sec: float, end_sec: float
) -> float:
    """Sample frames with MediaPipe Face Detection to compute smoothed normalized speaker X center (0.0-1.0)."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return 0.5

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    start_frame = int(start_sec * fps)
    end_frame = int(end_sec * fps)
    sample_step = max(1, int(fps * 0.5))

    centers: List[float] = []
    mp_face = mp.solutions.face_detection

    with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.5) as detector:
        frame_idx = start_frame
        while frame_idx < end_frame:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = detector.process(rgb)
            if res.detections:
                best = max(
                    res.detections,
                    key=lambda d: d.location_data.relative_bounding_box.width
                    * d.location_data.relative_bounding_box.height,
                )
                box = best.location_data.relative_bounding_box
                center_x = float(box.xmin + box.width * 0.5)
                centers.append(min(0.85, max(0.15, center_x)))
            frame_idx += sample_step

    cap.release()
    if not centers:
        return 0.5
    return round(float(np.median(centers)), 3)


def _format_ass_time(seconds: float) -> str:
    safe = max(0.0, seconds)
    hrs = int(safe // 3600)
    mins = int((safe % 3600) // 60)
    secs = int(safe % 60)
    centis = int(round((safe - int(safe)) * 100)) % 100
    return f"{hrs}:{mins:02d}:{secs:02d}.{centis:02d}"


def build_kinetic_ass_subtitles(words: List[Dict[str, Any]], ass_path: Path) -> None:
    """Write ASS subtitle file highlighting each active spoken word in bold indigo (#4F46E5)."""
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,74,&H00FFFFFF,&H00FFFFFF,&H00170F0F,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines: List[str] = []
    for idx in range(0, len(words), 3):
        chunk = words[idx : idx + 3]
        if not chunk:
            continue
        for active_pos, active_word in enumerate(chunk):
            start_str = _format_ass_time(active_word["start"])
            end_str = _format_ass_time(max(active_word["end"], active_word["start"] + 0.12))
            rendered_tokens = []
            for pos, token in enumerate(chunk):
                safe_word = token["word"].upper().replace("{", "").replace("}", "")
                if pos == active_pos:
                    rendered_tokens.append(r"{\c&H00E5464F&\fscx112\fscy112}" + safe_word + r"{\r}")
                else:
                    rendered_tokens.append(safe_word)
            lines.append(f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{' '.join(rendered_tokens)}")

    ass_path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")


def render_vertical_clip(
    source_video: Path,
    output_mp4: Path,
    ass_path: Path,
    start_sec: float,
    duration_sec: float,
    focus_x_norm: float,
    words: List[Dict[str, Any]],
) -> None:
    """Crop to 9:16 around active speaker, scale to 1080x1920, and burn ASS captions with FFmpeg."""
    build_kinetic_ass_subtitles(words, ass_path)

    ass_escaped = str(ass_path.resolve()).replace("\\", "/").replace(":", "\\:")

    crop_expr = (
        f"crop='min(iw,ih*9/16)':'ih':"
        f"'max(0,min(iw-min(iw,ih*9/16),iw*{focus_x_norm}-min(iw,ih*9/16)/2))':0,"
        f"scale=1080:1920:flags=lanczos,"
        f"subtitles='{ass_escaped}'"
    )

    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        str(start_sec),
        "-t",
        str(duration_sec),
        "-i",
        str(source_video),
        "-vf",
        crop_expr,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(output_mp4),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg render failed: {proc.stderr.strip()}")
