import { useEffect, useRef, useState } from 'react';
import type { ClipJob, GeneratedClip, TargetDuration } from './types/clip';
import { detectVideoPlatform, normalizeBackendUrl } from './lib/clipHelpers';
import { Navbar } from './components/Navbar';
import { HeroInput, type ConnectionStatus } from './components/HeroInput';
import { PipelineTracker } from './components/PipelineTracker';
import { ResultsDashboard } from './components/ResultsDashboard';
import { BackendSetupSection } from './components/BackendSetupSection';

const COLAB_STORAGE_KEY = 'snapreel_colab_backend_url';
const DEFAULT_COLAB_URL = 'https://frenzy-parmesan-swimsuit.ngrok-free.dev';
const OFFLINE_FRIENDLY_MESSAGE =
  "Backend is offline — ask Muse to turn on Colab (say 'Colab on karo'), then press Connect & Test again.";
const NGROK_HEADERS: Record<string, string> = {
  'ngrok-skip-browser-warning': 'true',
};

function isFetchConnectivityFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message.toLowerCase();
  return (
    err.name === 'TypeError' ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed')
  );
}

export default function App() {
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const [sourceMode, setSourceMode] = useState<'url' | 'file'>('url');
  const [urlInput, setUrlInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetDuration, setTargetDuration] = useState<TargetDuration>(45);
  const [numClips, setNumClips] = useState<number>(5);

  const [colabUrl, setColabUrl] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(COLAB_STORAGE_KEY);
      if (saved && saved.trim().length > 0) {
        return saved;
      }
      window.localStorage.setItem(COLAB_STORAGE_KEY, DEFAULT_COLAB_URL);
      return DEFAULT_COLAB_URL;
    } catch {
      return DEFAULT_COLAB_URL;
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
      const valueToStore = colabUrl.trim().length > 0 ? colabUrl : DEFAULT_COLAB_URL;
      window.localStorage.setItem(COLAB_STORAGE_KEY, valueToStore);
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
      setConnectionError(
        `Please enter your Colab backend URL (default: ${DEFAULT_COLAB_URL}).`
      );
      return;
    }

    try {
      new URL(baseUrl);
    } catch {
      setConnectionStatus('error');
      setConnectionError('Invalid URL format. Include https:// at the start of the backend URL.');
      return;
    }

    setConnectionStatus('testing');
    setConnectionError(null);

    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...NGROK_HEADERS,
        },
      });
      if (!response.ok) {
        setConnectionStatus('error');
        setConnectionError(OFFLINE_FRIENDLY_MESSAGE);
        return;
      }
      setConnectionStatus('connected');
      setConnectionError(null);
    } catch {
      setConnectionStatus('error');
      setConnectionError(OFFLINE_FRIENDLY_MESSAGE);
    }
  };

  const startPolling = (jobId: string, apiBase: string) => {
    stopPolling();

    const fetchStatus = async () => {
      try {
        const res = await fetch(`${apiBase}/api/status/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...NGROK_HEADERS,
          },
        });
        if (!res.ok) {
          throw new Error(`Status check failed (${res.status})`);
        }
        const data = (await res.json()) as ClipJob;
        setActiveJob(data);

        if (data.status === 'completed') {
          stopPolling();
          const normalizedClips = (data.clips || []).map((clip) => {
            const downloadPath = `/api/download/${encodeURIComponent(data.jobId)}/${encodeURIComponent(clip.id)}`;
            return {
              ...clip,
              videoUrl: `${apiBase}${downloadPath}`,
              downloadUrl: `${apiBase}${downloadPath}`,
            };
          });
          setClips(normalizedClips);
        } else if (data.status === 'failed') {
          stopPolling();
        }
      } catch (err) {
        stopPolling();
        const message = isFetchConnectivityFailure(err)
          ? OFFLINE_FRIENDLY_MESSAGE
          : err instanceof Error
            ? err.message
            : OFFLINE_FRIENDLY_MESSAGE;
        setActiveJob((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                errorMessage: message,
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

    if (connectionStatus !== 'connected') {
      setValidationError(
        'Please press Connect & Test to verify the backend is ready before generating clips.'
      );
      return;
    }

    if (!apiBase) {
      setValidationError(`Please enter your Colab backend URL (default: ${DEFAULT_COLAB_URL}).`);
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
          'Unsupported URL. Please enter a valid YouTube, Twitch, or Kick video link.'
        );
        return;
      }
    }

    if (sourceMode === 'file' && !selectedFile) {
      setValidationError('Please select or drop a local MP4 video file first.');
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
        response = await fetch(`${apiBase}/api/upload-video`, {
          method: 'POST',
          headers: {
            ...NGROK_HEADERS,
          },
          body: formData,
        });
      } else {
        response = await fetch(`${apiBase}/api/process-url`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...NGROK_HEADERS,
          },
          body: JSON.stringify({
            url: effectiveUrl,
            clip_duration: targetDuration,
            num_clips: numClips,
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
      if (isFetchConnectivityFailure(err)) {
        setConnectionStatus('error');
        setConnectionError(OFFLINE_FRIENDLY_MESSAGE);
        setValidationError(OFFLINE_FRIENDLY_MESSAGE);
      } else {
        setValidationError(
          err instanceof Error ? err.message : OFFLINE_FRIENDLY_MESSAGE
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateClip = (clipId: string, updates: Partial<GeneratedClip>) => {
    setClips((prev) =>
      prev.map((item) => (item.id === clipId ? { ...item, ...updates } : item))
    );
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
        />

        <BackendSetupSection />
      </main>

      <footer className="border-t border-slate-200 bg-white py-5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>SnapReel Studio · 9:16 Vertical Short-Form Clipper</span>
          <span>Supports YouTube, Twitch, Kick, and Local MP4</span>
        </div>
      </footer>
    </div>
  );
}
