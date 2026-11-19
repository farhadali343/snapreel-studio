import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from pipeline import (
    detect_active_speaker_focus,
    detect_platform,
    download_stream,
    render_vertical_clip,
    score_virality,
    transcribe_audio,
)

app = FastAPI(title="SnapReel Studio Colab API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORKSPACE_DIR = Path(__file__).parent / "jobs"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

EXECUTOR = ThreadPoolExecutor(max_workers=2)
JOBS: Dict[str, Dict[str, Any]] = {}


class ProcessUrlRequest(BaseModel):
    url: str
    clip_duration: int = 45
    num_clips: int = 5


def _initial_steps() -> List[Dict[str, str]]:
    return [
        {
            "key": "downloading",
            "label": "Downloading Stream",
            "toolTag": "yt-dlp",
            "detail": "Fetching 1080p source via yt-dlp",
            "state": "active",
        },
        {
            "key": "transcribing",
            "label": "Transcribing Audio",
            "toolTag": "Whisper",
            "detail": "Extracting word-level timestamps with faster-whisper",
            "state": "pending",
        },
        {
            "key": "scoring",
            "label": "AI Virality Scoring",
            "toolTag": "Virality Scorer",
            "detail": "Ranking viral hooks & retention windows",
            "state": "pending",
        },
        {
            "key": "cropping",
            "label": "Active Speaker 9:16 Crop",
            "toolTag": "MediaPipe",
            "detail": "Tracking active speaker face bounding box",
            "state": "pending",
        },
        {
            "key": "burning",
            "label": "Burning Dynamic Captions",
            "toolTag": "FFmpeg",
            "detail": "Rendering 1080x1920 MP4 with kinetic indigo captions",
            "state": "pending",
        },
    ]


def _set_step(job_id: str, step_idx: int, progress: int) -> None:
    job = JOBS[job_id]
    job["currentStepIndex"] = step_idx
    job["progressPercent"] = progress
    for idx, step in enumerate(job["steps"]):
        if idx < step_idx:
            step["state"] = "completed"
        elif idx == step_idx:
            step["state"] = "active"
        else:
            step["state"] = "pending"


def _run_video_pipeline(job_id: str, video_url: Optional[str], local_file: Optional[Path]) -> None:
    job = JOBS[job_id]
    job_dir = WORKSPACE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    job["status"] = "processing"

    try:
        _set_step(job_id, 0, 12)
        if local_file is not None:
            source_video = local_file
        elif video_url:
            source_video = download_stream(video_url, job_dir)
        else:
            raise RuntimeError("No video URL or file provided.")

        _set_step(job_id, 1, 32)
        segments = transcribe_audio(source_video)

        _set_step(job_id, 2, 54)
        scored_clips = score_virality(
            segments,
            clip_duration=job["targetDuration"],
            num_clips=job["numClips"],
        )

        _set_step(job_id, 3, 72)
        for clip in scored_clips:
            clip["speakerFocusX"] = detect_active_speaker_focus(
                source_video, clip["startTimeSec"], clip["endTimeSec"]
            )

        _set_step(job_id, 4, 86)
        final_clips: List[Dict[str, Any]] = []
        for clip in scored_clips:
            clip_id = clip["id"]
            out_mp4 = job_dir / f"{clip_id}_1080x1920.mp4"
            ass_file = job_dir / f"{clip_id}.ass"
            render_vertical_clip(
                source_video=source_video,
                output_mp4=out_mp4,
                ass_path=ass_file,
                start_sec=clip["startTimeSec"],
                duration_sec=clip["durationSec"],
                focus_x_norm=clip["speakerFocusX"],
                words=clip["words"],
            )
            final_clips.append(
                {
                    **clip,
                    "aspectRatio": "9:16",
                    "resolution": "1080x1920",
                    "videoUrl": f"/api/download/{job_id}/{clip_id}",
                    "downloadUrl": f"/api/download/{job_id}/{clip_id}",
                }
            )

        for step in job["steps"]:
            step["state"] = "completed"
        job["currentStepIndex"] = 4
        job["progressPercent"] = 100
        job["status"] = "completed"
        job["clips"] = final_clips

    except Exception as exc:
        idx = job["currentStepIndex"]
        job["status"] = "failed"
        job["errorMessage"] = str(exc)
        if 0 <= idx < len(job["steps"]):
            job["steps"][idx]["state"] = "failed"


@app.get("/health")
@app.get("/api/health")
def health_check() -> Dict[str, str]:
    return {"status": "ok", "service": "SnapReel Studio Colab FastAPI"}


@app.post("/api/process-url", status_code=202)
def process_url(payload: ProcessUrlRequest) -> Dict[str, Any]:
    url = payload.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="Video URL is required.")

    duration = payload.clip_duration if payload.clip_duration in (15, 30, 45, 60) else 45
    num_clips = max(1, min(10, int(payload.num_clips)))
    job_id = str(uuid.uuid4())[:8]
    platform = detect_platform(url)

    JOBS[job_id] = {
        "jobId": job_id,
        "sourceType": "url",
        "sourceUrl": url,
        "platform": platform,
        "targetDuration": duration,
        "numClips": num_clips,
        "status": "queued",
        "currentStepIndex": 0,
        "progressPercent": 5,
        "steps": _initial_steps(),
        "clips": [],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    EXECUTOR.submit(_run_video_pipeline, job_id, url, None)
    return {"jobId": job_id, "status": "queued", "platform": platform}


@app.post("/api/upload-video", status_code=202)
async def upload_video(
    video: UploadFile = File(...),
    clip_duration: int = Form(45),
    num_clips: int = Form(5),
) -> Dict[str, Any]:
    job_id = str(uuid.uuid4())[:8]
    job_dir = WORKSPACE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    target_path = job_dir / (video.filename or "uploaded.mp4")

    with target_path.open("wb") as buffer:
        shutil.copyfileobj(video.file, buffer)

    safe_duration = clip_duration if clip_duration in (15, 30, 45, 60) else 45
    safe_num_clips = max(1, min(10, int(num_clips)))
    JOBS[job_id] = {
        "jobId": job_id,
        "sourceType": "file",
        "fileName": video.filename,
        "platform": "local",
        "targetDuration": safe_duration,
        "numClips": safe_num_clips,
        "status": "queued",
        "currentStepIndex": 0,
        "progressPercent": 5,
        "steps": _initial_steps(),
        "clips": [],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    EXECUTOR.submit(_run_video_pipeline, job_id, None, target_path)
    return {"jobId": job_id, "status": "queued", "platform": "local"}


@app.get("/api/status/{job_id}")
def get_job_status(job_id: str) -> Dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/api/download/{job_id}/{clip_id}")
def download_clip(job_id: str, clip_id: str) -> FileResponse:
    mp4_path = WORKSPACE_DIR / job_id / f"{clip_id}_1080x1920.mp4"
    if not mp4_path.exists():
        raise HTTPException(status_code=404, detail="Rendered clip file not found.")
    return FileResponse(
        path=mp4_path,
        media_type="video/mp4",
        filename=f"snapreel_{job_id}_{clip_id}_1080x1920.mp4",
    )
