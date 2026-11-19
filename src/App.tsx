import { useEffect, useRef, useState } from 'react';
import type { ClipJob, GeneratedClip, TargetDuration } from './types/clip';
import { detectVideoPlatform, normalizeBackendUrl } from './lib/clipHelpers';
import { Navbar } from './components/Navbar';
import { HeroInput, type ConnectionStatus } from './components/HeroInput';
import { PipelineTracker } from './components/PipelineTracker';
import { ResultsDashboard } from './components/ResultsDashboard';
import { BackendSetupSection } from './components/BackendSetupSection';

const COLAB_STORAGE_KEY = 'snapreel_colab_backend_url';

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
      return window.localStorage.getItem(COLAB_STORAGE_KEY) ?? '';
    } catch {
      return '';
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
      setConnectionError('Please paste your Colab tunnel URL (e.g. https://xxxx.trycloudflare.com).');
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
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Health check returned HTTP ${response.status}`);
      }
      setConnectionStatus('connected');
      setConnectionError(null);
    } catch (err) {
      setConnectionStatus('error');
      setConnectionError(
        err instanceof Error
          ? `Could not connect to ${baseUrl}/health: ${err.message}`
          : `Could not reach ${baseUrl}/health. Make sure the Colab tunnel is running.`
      );
    }
  };

  const startPolling = (jobId: string, apiBase: string) => {
    stopPolling();

    const fetchStatus = async () => {
      try {
        const res = await fetch(`${apiBase}/api/status/${encodeURIComponent(jobId)}`);
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
        'Please enter your Colab backend URL (e.g. https://xxxx.trycloudflare.com) first.'
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
          body: formData,
        });
      } else {
        response = await fetch(`${apiBase}/api/process-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

      <footer className="border-t border-slate-200 bg-white py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <span>SnapReel Studio · 9:16 Vertical Short-Form Clipper</span>
          <span>Supports YouTube, Twitch, Kick, and Local MP4</span>
        </div>
      </footer>
    </div>
  );
}
