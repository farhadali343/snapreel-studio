# SnapReel Studio — Colab Backend

The heavy half of the clipping tool. **Zero work on the user's PC.**
The AI Studio site is only the dashboard; this notebook runs the real
pipeline on a free Google Colab T4 GPU.

## Files

| File | What it is |
|---|---|
| `SnapReel-Colab-Backend.ipynb` | The notebook. Upload it to Colab and run the cells. |
| `server.py` | The same server code, as a plain file (the notebook's Cell 2 writes this exact code to `/content/server.py` in Colab). |

## The flow (no PC involved)

1. Open the notebook in Google Colab (signed in as `farhad0official@gmail.com`).
2. Run the cells top to bottom: **Cell 1** installs, **Cell 2** writes
   `server.py`, **Cell 3** starts the server + a public tunnel URL.
3. Copy the public URL Cell 3 prints and paste it into the SnapReel
   Studio site's backend URL field.
4. Open the site, paste a stream link, pick clip count (1–10) + clip
   length (15/30/45/60 s or custom), and clips start generating.
   Finished clips land in Google Drive: `MyDrive/SnapReel-Clips/jobs/<job_id>/`.

## One-time setup: the Gemini API key

In Colab, click the **key icon (Secrets)** in the left sidebar and add a
secret named `GEMINI_API_KEY` with the Gemini API key (AI Studio > Get API
key). The notebook reads it only from Secrets — it is never printed,
never written to a file, never in chat. Without a key the server still
works, but it scores clips with the built-in deterministic fallback
scorer (audio-energy peaks + hook keywords) and labels those clips as
fallback scoring.

## What the pipeline does

```
URL -> yt-dlp audio-first -> faster-whisper large-v3-turbo (word timestamps)
  -> transcript chunked into ~20-min overlapping pieces
  -> Gemini 2.5 Flash ranks moments (hook/flow/value/trend, 0-100)
  -> dedupe (>50% overlap dropped) -> clamp to the requested length
  -> yt-dlp --download-sections for only the chosen segments (<=1080p)
  -> facecam detection -> 9:16 layout -> .ass karaoke captions
  -> ONE ffmpeg pass -> 1080x1920 MP4, loudnorm -14 LUFS
```

## Layout — GTA VI stream template

9:16 canvas, 1080x1920:

- **Facecam on top: 1080x720** — the streamer's picture-in-picture box,
  detected per segment (persistent Canny edges around the face, same
  method as the stream-clips skill; YuNet, then MediaPipe, then Haar).
- **Gameplay below: 1080x1200** — the full 16:9 frame cropped to fill.
- Word-by-word karaoke captions on the gameplay area (active word yellow).
- Hook title as a title-bar PNG centred on the seam between the panels.
- **Fallback:** no facecam found → blurred gameplay still for the top
  band, recorded in the job status (`facecam: "fallback: no facecam"`).
  The clip never fails over a missing facecam.
- Talking-head (non-stream) inputs fall back to a MediaPipe-style
  face-follow crop with a PySceneDetect cut reset.

## Inputs

YouTube, Twitch (VODs/clips), Kick, Streamable via yt-dlp, plus direct
`.mp4` links. **Frame.io has no yt-dlp extractor** — paste a direct
`.mp4` link instead (frame.io Download button, or the `<video src>` from
the browser inspector). A frame.io share link is rejected with a message
explaining exactly that.

## API (served on port 8000, via the cloudflared tunnel)

- `GET /health` — status, GPU present, Drive mounted, key set.
- `POST /api/process-url` — `{url, clip_duration, num_clips, mode, context_notes}` → `202 {jobId, status, platform}`.
- `GET /api/status/{job_id}` — progress, the 5 pipeline steps, clips with
  viral score, hook title, reason, start/end, `layout`, `facecam`,
  `video_path`.
- `GET /api/download/{job_id}/{clip_id}` — the finished 1080x1920 MP4.

## Checkpoints (Drive)

Every stage is written to `MyDrive/SnapReel-Clips/jobs/<job_id>/`
(`transcript.json`, `meta.json`, `ranking.json`, `clips.json`,
`clip-XX.mp4`). If the Colab session dies, the next run resumes from the
last good stage instead of restarting. Cell 4 lists all jobs and clips.

## What was fixed vs the Gemini roadmap

- Transcript **not** truncated at 45,000 chars — chunked into ~20-min
  overlapping pieces, so long streams are fully scored.
- Whisper **large-v3-turbo** on the T4 (not "small").
- Facecam crop path is computed first, then **one ffmpeg pass**
  (no per-frame Python re-encode + second ffmpeg encode).
- Clip **dedupe** (>50% overlap) and exact **duration clamp**.
- LLM JSON **validated, retried (max 2)**, deterministic fallback scorer.
- **Drive checkpointing** at every stage.
- **No Windows** — no `.bat`, no `localhost:8000` assumption; binds
  `0.0.0.0`, served through the tunnel.

## Realistic timings (free Colab T4)

1-hour video → 10 clips: **~35–70 minutes** (rendering is the
bottleneck). A 15-minute video: ~10–15 minutes. Keep the Colab tab open
while a job runs — closing it kills the runtime (free tier has no
background execution; idle timeout ~30–90 min; sessions last 4–6 h in
practice). The tunnel URL changes every session — paste the fresh URL
into the site each time.

## Verification done (static only — no GPU on this VM)

- `python -m py_compile server.py` — OK (1,393 lines, 52 functions).
- Notebook is valid nbformat 4 (`nbformat.validate`, no warnings);
  Cell 2 embeds `server.py` verbatim (asserted byte-for-byte).
- Grep for API key values in both files — clean (only the secret *name*
  `GEMINI_API_KEY` is referenced).
- The video pipeline was **not** executed here — first live run happens
  in Colab.

## Still to do (not this folder)

The AI Studio SnapReel frontend still points at `http://localhost:8000`
and has a fixed 4-clip output with no clip-count selector. It needs:
a backend-URL field (for the tunnel URL) and a clip-count selector
(1–10), wired to `POST /api/process-url` with `{url, clip_duration,
num_clips}`. That is a frontend edit in AI Studio, separate from this
backend.
