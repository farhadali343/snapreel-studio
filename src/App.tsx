import { useEffect, useRef, useState } from 'react';
import type {
  CaptionStyleId,
  ClipJob,
  GeneratedClip,
  PipelineStep,
  StepState,
  TargetDuration,
  VideoPlatform,
} from './types/clip';
import {
  detectVideoPlatform,
  normalizeBackendUrl,
  backendHeaders,
  DEFAULT_BACKEND_URL,
  parseTimeToSeconds,
} from './lib/clipHelpers';
import { Navbar } from './components/Navbar';
import { HeroInput, type ConnectionStatus } from './components/HeroInput';
import { PipelineTracker } from './components/PipelineTracker';
import { ResultsDashboard } from './components/ResultsDashboard';
import { BackendSetupSection } from './components/BackendSetupSection';

const COLAB_STORAGE_KEY = 'snapreel_colab_backend_url';

// --- Backend -> frontend shape mapping (v2) ----------------------------
// The Colab backend speaks snake_case (virality_score, start_time_sec,
// steps as {id, title, detail, status}, job "id"/"progress"/"error") while
// the UI speaks camelCase (viralityScore, startTimeSec, steps as
// {key, label, toolTag, detail, state}, jobId/progressPercent). The old
// code passed the backend payload straight through, so the first real
// clip would have rendered an empty score, blank steps and broken
// download links. Everything from /api/status and /api/retrim goes
// through these two functions.
const STEP_MAP: Record<string, { key: PipelineStep['key']; label: string; toolTag: string }> = {
  download: { key: 'downloading', label: 'Downloading Stream', toolTag: 'yt-dlp' },
  transcribe: { key: 'transcribing', label: 'Transcribing Audio', toolTag: 'Whisper' },
  virality: { key: 'scoring', label: 'AI Virality Scoring', toolTag: 'Virality Scorer' },
  reframe: { key: 'cropping', label: 'Active Speaker 9:16 Crop', toolTag: 'MediaPipe' },
  caption: { key: 'burning', label: 'Burning Dynamic Captions', toolTag: 'FFmpeg' },
};

function mapStepState(v: unknown): StepState {
  const s = String(v ?? 'pending');
  return s === 'active' || s === 'completed' || s === 'failed' ? s : 'pending';
}

function normalizeClip(raw: unknown): GeneratedClip {
  const r = (raw ?? {}) as Record<string, unknown>;
  const wordsRaw = Array.isArray(r.words) ? r.words : [];
  const styleRaw = typeof r.caption_style === 'string' ? r.caption_style : r.captionStyle;
  return {
    id: String(r.id ?? ''),
    title: String(r.title ?? 'Untitled clip'),
    viralityScore: Number(r.virality_score ?? r.viralityScore ?? 0),
    hookReasoning: String(r.hook_reasoning ?? r.hookReasoning ?? ''),
    retentionInsight: String(r.retention_insight ?? r.retentionInsight ?? ''),
    pacingNote: String(r.pacing_note ?? r.pacingNote ?? ''),
    durationSec: Number(r.duration_sec ?? r.durationSec ?? 0),
    startTimeSec: Number(r.start_time_sec ?? r.startTimeSec ?? 0),
    endTimeSec: Number(r.end_time_sec ?? r.endTimeSec ?? 0),
    aspectRatio: '9:16',
    resolution: '1080x1920',
    transcript: String(r.transcript ?? ''),
    words: wordsRaw.map((w) => {
      const ww = (w ?? {}) as Record<string, unknown>;
      return {
        word: String(ww.word ?? ww.w ?? ''),
        start: Number(ww.start ?? ww.s ?? 0),
        end: Number(ww.end ?? ww.e ?? 0),
      };
    }),
    captionStyle: (typeof styleRaw === 'string' ? styleRaw : undefined) as
      | CaptionStyleId
      | undefined,
  };
}

function normalizeJob(
  data: unknown,
  fallback: { sourceMode: 'url' | 'file'; targetDuration: number; numClips: number }
): ClipJob {
  const d = (data ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(d.steps) ? d.steps : [];
  const steps: PipelineStep[] = rawSteps.map((s) => {
    const st = (s ?? {}) as Record<string, unknown>;
    const mapped = STEP_MAP[String(st.id ?? '')] ?? {
      key: 'downloading' as PipelineStep['key'],
      label: String(st.title ?? 'Step'),
      toolTag: '',
    };
    return {
      key: mapped.key,
      label: String(st.title ?? mapped.label),
      toolTag: mapped.toolTag,
      detail: String(st.detail ?? ''),
      state: mapStepState(st.status ?? st.state),
    };
  });
  const activeIdx = steps.findIndex((s) => s.state === 'active');
  const status = String(d.status ?? 'queued');
  return {
    jobId: String(d.id ?? d.jobId ?? ''),
    sourceType: fallback.sourceMode,
    sourceUrl: typeof d.source_url === 'string' ? d.source_url : undefined,
    platform: (typeof d.platform === 'string' ? d.platform : 'youtube') as VideoPlatform,
    targetDuration: Number(d.target_duration ?? fallback.targetDuration),
    numClips: Number(d.num_clips ?? fallback.numClips),
    status:
      status === 'queued' || status === 'processing' || status === 'completed' || status === 'failed'
        ? status
        : 'queued',
    currentStepIndex:
      activeIdx >= 0 ? activeIdx : steps.filter((s) => s.state === 'completed').length,
    progressPercent: Number(d.progress ?? d.progressPercent ?? 0),
    steps,
    clips: (Array.isArray(d.clips) ? d.clips : []).map(normalizeClip),
    errorMessage:
      typeof d.error === 'string'
        ? d.error
        : typeof d.errorMessage === 'string'
          ? d.errorMessage
          : undefined,
    createdAt: typeof d.created_at === 'string' ? d.created_at : new Date().toISOString(),
  };
}

export default function App() {
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const [sourceMode, setSourceMode] = useState<'url' | 'file'>('url');
  const [urlInput, setUrlInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetDuration, setTargetDuration] = useState<TargetDuration>(45);
  const [numClips, setNumClips] = useState<number>(5);
  const [rangeStartText, setRangeStartText] = useState('');
  const [rangeEndText, setRangeEndText] = useState('');
  const [captionStyle, setCaptionStyle] = useState<CaptionStyleId>('karaoke');
  const [musicUrl, setMusicUrl] = useState('');
  const [retrimmingClipId, setRetrimmingClipId] = useState<string | null>(null);

  const [colabUrl, setColabUrl] = useState<string>(() => {
    try {
      const stored = window.localStorage.getItem(COLAB_STORAGE_KEY);
      // A stored trycloudflare URL dies with every Colab restart — fall back
      // to the permanent ngrok URL instead of showing a dead tunnel.
      if (stored && !stored.includes('trycloudflare.com')) return stored;
      return DEFAULT_BACKEND_URL;
    } catch {
      return DEFAULT_BACKEND_URL;
    }
  });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ClipJob | null>(null);
  const [clips, setClips] = useState<GeneratedClip[]>([]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLAB_STORAGE_KEY, colabUrl);
    } catch {
      // Ignore storage quota / privacy errors
    }
  }, [colabUrl]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleColabUrlChange = (nextUrl: string) => {
    setColabUrl(nextUrl);
    setConnectionStatus('idle');
    setConnectionError(null);
    setValidationError(null);
  };

  const handleTestConnection = async () => {
    const baseUrl = normalizeBackendUrl(colabUrl);
    if (!baseUrl) {
      setConnectionStatus('error');
      setConnectionError('Please enter your Colab backend URL — the permanent URL is already filled in above.');
      return;
    }

    try {
      new URL(baseUrl);
    } catch {
      setConnectionStatus('error');
      setConnectionError('Invalid URL format. Include https:// at the start of the tunnel URL.');
      return;
    }

    setConnectionStatus('testing');
    setConnectionError(null);

    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers: backendHeaders({ Accept: 'application/json' }),
      });
      if (!response.ok) {
        setConnectionStatus('error');
        setConnectionError(
          `Backend replied with HTTP ${response.status}. Try Connect & Test again, or ask Muse to restart Colab.`
        );
        return;
      }
      setConnectionStatus('connected');
      setConnectionError(null);
    } catch {
      setConnectionStatus('error');
      setConnectionError(
        'Backend is offline — ask Muse to turn on Colab (say "Colab on karo"), then press Connect & Test again.'
      );
    }
  };

  // The backend URL is pre-filled with the permanent ngrok address, so test
  // the connection once on load — the user should see "Connected" without
  // having to press anything.
  const didAutoTestRef = useRef(false);
  useEffect(() => {
    if (!didAutoTestRef.current && colabUrl) {
      didAutoTestRef.current = true;
      void handleTestConnection();
    }
    // Runs once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = (jobId: string, apiBase: string) => {
    stopPolling();

    const fetchStatus = async () => {
      try {
        const res = await fetch(`${apiBase}/api/status/${encodeURIComponent(jobId)}`, {
          headers: backendHeaders(),
        });
        if (!res.ok) {
          throw new Error(`Status check failed (${res.status})`);
        }
        const rawData = (await res.json()) as unknown;
        const normalized = normalizeJob(rawData, {
          sourceMode,
          targetDuration,
          numClips,
        });
        setActiveJob(normalized);

        if (normalized.status === 'completed') {
          stopPolling();
          const normalizedClips = normalized.clips.map((clip) => {
            const downloadPath = `/api/download/${encodeURIComponent(normalized.jobId)}/${encodeURIComponent(clip.id)}`;
            return {
              ...clip,
              videoUrl: `${apiBase}${downloadPath}`,
              downloadUrl: `${apiBase}${downloadPath}`,
            };
          });
          setClips(normalizedClips);
        } else if (normalized.status === 'failed') {
          stopPolling();
        }
      } catch (err) {
        stopPolling();
        setActiveJob((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                errorMessage:
                  err instanceof Error
                    ? err.message
                    : 'Lost connection to Colab backend server.',
              }
            : null
        );
      }
    };

    void fetchStatus();
    pollTimerRef.current = window.setInterval(fetchStatus, 1000);
  };

  const launchJob = async () => {
    setValidationError(null);
    const apiBase = normalizeBackendUrl(colabUrl);

    if (!apiBase) {
      setValidationError(
        'Please enter your Colab backend URL first — the permanent URL is already filled in above.'
      );
      return;
    }

    try {
      new URL(apiBase);
    } catch {
      setValidationError('Please enter a valid Colab backend URL starting with https://.');
      return;
    }

    const effectiveUrl = urlInput.trim();

    if (sourceMode === 'url') {
      if (!effectiveUrl) {
        setValidationError('Please paste a YouTube, Twitch, or Kick video URL.');
        return;
      }
      const platform = detectVideoPlatform(effectiveUrl);
      if (!platform) {
        setValidationError(
          'Unsupported URL. Please enter a valid YouTube, Twitch, Kick, Frame.io or direct MP4 video link.'
        );
        return;
      }
    }

    if (sourceMode === 'file' && !selectedFile) {
      setValidationError('Please select or drop a local MP4 video file first.');
      return;
    }

    const startSec = parseTimeToSeconds(rangeStartText);
    const endSec = parseTimeToSeconds(rangeEndText);
    if (
      (rangeStartText.trim() && startSec === null) ||
      (rangeEndText.trim() && endSec === null)
    ) {
      setValidationError('Start/end time not understood — use MM:SS or HH:MM:SS.');
      return;
    }
    if (startSec !== null && endSec !== null && endSec <= startSec) {
      setValidationError('End time must be after start time.');
      return;
    }

    setIsSubmitting(true);
    setClips([]);
    stopPolling();

    try {
      let response: Response;

      if (sourceMode === 'file' && selectedFile) {
        const formData = new FormData();
        formData.append('video', selectedFile);
        formData.append('clip_duration', String(targetDuration));
        formData.append('num_clips', String(numClips));
        formData.append('start_sec', String(startSec ?? 0));
        if (endSec !== null) formData.append('end_sec', String(endSec));
        formData.append('caption_style', captionStyle);
        if (musicUrl.trim()) formData.append('music_url', musicUrl.trim());
        response = await fetch(`${apiBase}/api/upload-video`, {
          method: 'POST',
          headers: backendHeaders(),
          body: formData,
        });
      } else {
        response = await fetch(`${apiBase}/api/process-url`, {
          method: 'POST',
          headers: backendHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            url: effectiveUrl,
            clip_duration: targetDuration,
            num_clips: numClips,
            start_sec: startSec ?? 0,
            end_sec: endSec,
            caption_style: captionStyle,
            music_url: musicUrl.trim() || null,
          }),
        });
      }

      const payload = (await response.json()) as { jobId?: string; error?: string; detail?: string };

      if (!response.ok || !payload.jobId) {
        throw new Error(
          payload.error || payload.detail || `Failed to start job (${response.status})`
        );
      }

      document.getElementById('pipeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      startPolling(payload.jobId, apiBase);
    } catch (err) {
      setValidationError(
        err instanceof Error
          ? `${err.message} (Check that your Colab backend is active at ${apiBase})`
          : `Could not reach Colab backend at ${apiBase}.`
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateClip = (clipId: string, updates: Partial<GeneratedClip>) => {
    setClips((prev) =>
      prev.map((item) => (item.id === clipId ? { ...item, ...updates } : item))
    );
  };

  const handleRetrim = async (
    clipId: string,
    startSec: number,
    endSec: number,
    style: CaptionStyleId
  ) => {
    const apiBase = normalizeBackendUrl(colabUrl);
    if (!apiBase || !activeJob) return;
    setRetrimmingClipId(clipId);
    try {
      const response = await fetch(`${apiBase}/api/retrim`, {
        method: 'POST',
        headers: backendHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          job_id: activeJob.jobId,
          clip_id: clipId,
          start_sec: startSec,
          end_sec: endSec,
          caption_style: style,
        }),
      });
      const payload = (await response.json()) as { clip?: unknown; detail?: string };
      if (!response.ok || !payload.clip) {
        throw new Error(payload.detail || `Re-render failed (${response.status})`);
      }
      const updated = normalizeClip(payload.clip);
      const downloadPath = `/api/download/${encodeURIComponent(activeJob.jobId)}/${encodeURIComponent(clipId)}`;
      const withUrls = {
        ...updated,
        videoUrl: `${apiBase}${downloadPath}`,
        downloadUrl: `${apiBase}${downloadPath}`,
      };
      handleUpdateClip(clipId, withUrls);
      setActiveJob((prev) =>
        prev
          ? { ...prev, clips: prev.clips.map((c) => (c.id === clipId ? withUrls : c)) }
          : prev
      );
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Re-render failed.');
    } finally {
      setRetrimmingClipId(null);
    }
  };

  const handleNewClipClick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => urlInputRef.current?.focus(), 300);
  };

  return (
    <div id="top" className="min-h-screen flex flex-col bg-[#F8FAFC] text-slate-900">
      <Navbar onNewClipClick={handleNewClipClick} />

      <main className="flex-1">
        <HeroInput
          sourceMode={sourceMode}
          onSourceModeChange={(mode) => {
            setSourceMode(mode);
            setValidationError(null);
          }}
          urlInput={urlInput}
          onUrlInputChange={(val) => {
            setUrlInput(val);
            setValidationError(null);
          }}
          selectedFile={selectedFile}
          onSelectedFileChange={(file) => {
            setSelectedFile(file);
            setValidationError(null);
          }}
          targetDuration={targetDuration}
          onTargetDurationChange={setTargetDuration}
          numClips={numClips}
          onNumClipsChange={setNumClips}
          rangeStartText={rangeStartText}
          onRangeStartChange={setRangeStartText}
          rangeEndText={rangeEndText}
          onRangeEndChange={setRangeEndText}
          captionStyle={captionStyle}
          onCaptionStyleChange={setCaptionStyle}
          musicUrl={musicUrl}
          onMusicUrlChange={setMusicUrl}
          colabUrl={colabUrl}
          onColabUrlChange={handleColabUrlChange}
          connectionStatus={connectionStatus}
          connectionError={connectionError}
          onTestConnection={handleTestConnection}
          isSubmitting={isSubmitting}
          validationError={validationError}
          onSubmit={launchJob}
          inputRef={urlInputRef}
        />

        <PipelineTracker job={activeJob} onRetry={launchJob} />

        <ResultsDashboard
          job={activeJob}
          clips={clips}
          colabBaseUrl={normalizeBackendUrl(colabUrl)}
          onUpdateClip={handleUpdateClip}
          onRetrim={handleRetrim}
          retrimmingClipId={retrimmingClipId}
        />

        <BackendSetupSection />
      </main>

      <footer className="border-t border-slate-200 bg-white py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <span>SnapReel Studio · 9:16 Vertical Short-Form Clipper</span>
          <span>Supports YouTube, Twitch, Kick, and Local MP4</span>
        </div>
      </footer>
    </div>
  );
}
