# SnapReel Studio — Google Colab Python FastAPI Backend

This `backend/` directory runs the full video clipping pipeline in Google Colab using `yt-dlp`, `faster-whisper`, `mediapipe`, and `ffmpeg` to produce `1080x1920` H.264 vertical MP4 clips with active speaker cropping and burned-in kinetic indigo captions.

## Quick Start in Google Colab

```python
!pip install -q -r backend/requirements.txt
!apt-get -qq install -y ffmpeg
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
!dpkg -i cloudflared-linux-amd64.deb

import subprocess, threading, time
threading.Thread(
    target=lambda: subprocess.run(["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"], cwd="backend"),
    daemon=True,
).start()
time.sleep(2)
!cloudflared tunnel --url http://127.0.0.1:8000
```

Copy the public `https://xxxx.trycloudflare.com` URL printed by `cloudflared` and paste it into the **Colab backend URL** field in SnapReel Studio.

## Endpoints

- `GET /health` — Health check used by the **Connect & Test** button
- `POST /api/process-url` — Accepts `{ "url": "...", "clip_duration": 15 | 30 | 45 | 60, "num_clips": 1..10 }`
- `POST /api/upload-video` — Multipart MP4 upload (`video`, `clip_duration`, `num_clips`)
- `GET /api/status/{job_id}` — Returns 5-stage pipeline status and clip metadata
- `GET /api/download/{job_id}/{clip_id}` — Streams rendered `1080x1920` MP4
