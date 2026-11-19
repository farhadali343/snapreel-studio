# SnapReel Studio

Opus Clip-style clipping tool — free, unlimited, personal use.

Paste a stream link, pick how many clips and how long each one is, and the tool finds the best viral moments itself.

## How it works

- **Frontend** — Google AI Studio app (`src/`, `server.ts`). Paste a YouTube / Twitch / Kick link (or a Frame.io direct .mp4), pick clip count (1–10) and clip length (15 / 30 / 45 / 60s), hit Generate.
- **Backend** — Google Colab, free T4 GPU (`colab/`). Open `SnapReel-Colab-Backend.ipynb`, add your `GEMINI_API_KEY` in Colab Secrets, Run all, then paste the printed trycloudflare URL into the site's Colab backend URL field.

## Pipeline

yt-dlp (audio first) → faster-whisper large-v3-turbo (word timestamps) → Gemini 2.5 Flash ranking (hook / flow / value / trend) → section downloads only → single ffmpeg pass (layout + karaoke captions + loudnorm).

## Template

Built for GTA VI streams: facecam on **top** (1080×720), gameplay **below** (1080×1200), word-by-word karaoke captions on the gameplay area.

Finished clips are also saved to Google Drive: `MyDrive/SnapReel-Clips/jobs`.
