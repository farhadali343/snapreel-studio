import type { VideoPlatform, WordToken } from '../types/clip';

/** Permanent Colab backend URL (ngrok static domain). The site ships with
 *  this pre-filled so the user never has to paste a tunnel URL. */
export const DEFAULT_BACKEND_URL = 'https://frenzy-parmesan-swimsuit.ngrok-free.dev';

/** Headers every backend request must carry. ngrok's free tier serves a
 *  browser-warning interstitial unless this header is present. */
export function backendHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'ngrok-skip-browser-warning': 'true', ...extra };
}

export function normalizeBackendUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

export function detectVideoPlatform(inputUrl: string): VideoPlatform | null {
  const trimmed = inputUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be' ||
      host === 'music.youtube.com'
    ) {
      return 'youtube';
    }
    if (host === 'twitch.tv' || host === 'clips.twitch.tv' || host === 'm.twitch.tv') {
      return 'twitch';
    }
    if (host === 'kick.com') {
      return 'kick';
    }
    // Frame.io share links are NOT supported (no yt-dlp extractor) — only
    // a direct .mp4 link works, which the backend cuts with ffmpeg.
    if (host.includes('frame.io')) {
      return 'frameio';
    }
    // Direct video file links (e.g. Frame.io / S3 / CDN .mp4 URLs).
    if (/\.(mp4|mov|webm|mkv|m4v)(\?|#|$)/i.test(trimmed)) {
      return 'direct-mp4';
    }
    return null;
  } catch {
    return null;
  }
}

export function formatPlatformLabel(platform: VideoPlatform): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube';
    case 'twitch':
      return 'Twitch';
    case 'kick':
      return 'Kick';
    case 'local':
      return 'Local MP4';
    case 'direct-mp4':
      return 'Direct MP4';
    case 'frameio':
      return 'Frame.io';
    case 'upload':
      return 'Upload';
    default:
      return String(platform);
  }
}

/** Parse "SS", "MM:SS" or "HH:MM:SS" into seconds. Returns null when the
 *  text is empty or not a valid time (the caller then treats it as unset). */
export function parseTimeToSeconds(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const v = parseFloat(t);
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  const parts = t.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Format seconds as a plain clock time: 45 -> "0:45", 3600 -> "1:00:00". */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mins}:${ss}`;
}

/** A length of time in plain words: 45 -> "45 seconds", 1800 -> "30 minutes",
 *  5400 -> "1 hour 30 minutes". */
export function formatDurationWords(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  if (safe < 60) return safe === 1 ? '1 second' : `${safe} seconds`;
  if (safe < 3600) {
    const mins = Math.round(safe / 60);
    return mins === 1 ? '1 minute' : `${mins} minutes`;
  }
  const hours = Math.floor(safe / 3600);
  const mins = Math.round((safe % 3600) / 60);
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`;
  if (mins === 0) return hourPart;
  return `${hourPart} ${mins === 1 ? '1 minute' : `${mins} minutes`}`;
}

/** Plain-language summary of a clip range, e.g. "Clips will come from the
 *  first 30 minutes." An empty start means the video start, an empty end
 *  means the video end. */
export function describeRange(startText: string, endText: string): string {
  const start = parseTimeToSeconds(startText);
  const end = parseTimeToSeconds(endText);
  if (start === null && end === null) {
    return 'Clips can come from anywhere in the video.';
  }
  if ((start === null || start === 0) && end !== null) {
    return `Clips will come from the first ${formatDurationWords(end)} of the video.`;
  }
  if (start !== null && end === null) {
    return `Clips will come from ${formatClock(start)} to the end of the video.`;
  }
  if (start !== null && end !== null) {
    return `Clips will come from ${formatClock(start)} to ${formatClock(end)} — that's ${formatDurationWords(end - start)} of video.`;
  }
  return 'Clips can come from anywhere in the video.';
}

export function retokenizeTranscript(transcript: string, totalDurationSec: number): WordToken[] {
  const cleaned = transcript
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (cleaned.length === 0) return [];

  const duration = Math.max(4, totalDurationSec);
  const weights = cleaned.map((word) => Math.max(2, word.replace(/[^a-zA-Z0-9]/g, '').length));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  let cursor = 0.2;
  const usableDuration = Math.max(1, duration - 0.5);

  return cleaned.map((word, index) => {
    const slice = (weights[index] / totalWeight) * usableDuration;
    const start = Number(cursor.toFixed(2));
    const end = Number((cursor + slice).toFixed(2));
    cursor += slice;
    return { word, start, end };
  });
}
