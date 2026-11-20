import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Captions,
  ChevronDown,
  ChevronUp,
  Download,
  Edit3,
  Pause,
  Play,
  Check,
  Volume2,
  VolumeX,
  Film,
  Scissors,
} from 'lucide-react';
import type { CaptionStyleId, GeneratedClip } from '../types/clip';
import { backendHeaders, formatTimecode, retokenizeTranscript } from '../lib/clipHelpers';
import { CAPTION_STYLE_OPTIONS } from './HeroInput';

interface ClipCardProps {
  clip: GeneratedClip;
  jobId: string;
  colabBaseUrl: string;
  onUpdateClip: (clipId: string, updates: Partial<GeneratedClip>) => void;
  onRetrim?: (
    clipId: string,
    startSec: number,
    endSec: number,
    captionStyle: CaptionStyleId
  ) => void;
  isRetrimming?: boolean;
}

export const ClipCard: React.FC<ClipCardProps> = ({
  clip,
  jobId,
  colabBaseUrl,
  onUpdateClip,
  onRetrim,
  isRetrimming,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [showCaptions, setShowCaptions] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [isReasoningOpen, setIsReasoningOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(clip.title);
  const [draftTranscript, setDraftTranscript] = useState(clip.transcript);
  const [videoError, setVideoError] = useState(false);
  const [showTrim, setShowTrim] = useState(false);
  const [draftStartSec, setDraftStartSec] = useState(String(clip.startTimeSec));
  const [draftEndSec, setDraftEndSec] = useState(String(clip.endTimeSec));
  const [draftCaptionStyle, setDraftCaptionStyle] = useState<CaptionStyleId>(
    clip.captionStyle ?? 'karaoke'
  );
  const [retrimError, setRetrimError] = useState<string | null>(null);

  // Preview + download fetch the clip as a blob with the ngrok header.
  // A plain <video src> or <a href> cannot send that header, so ngrok's
  // free tier answers with its warning page instead of the MP4 — that is
  // why previews showed "Unable to stream preview" and downloads opened
  // a new tab on the warning page. One shared fetch per clip; the blob
  // URL is reused by both the player and the download button.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const blobPromiseRef = useRef<Promise<Blob> | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const autoPlayRef = useRef(false);

  const ensureClipBlob = () => {
    if (!blobPromiseRef.current) {
      blobPromiseRef.current = fetch(backendClipUrl, {
        headers: backendHeaders(),
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`clip fetch failed (HTTP ${res.status})`);
          }
          return res.blob();
        })
        .catch((err) => {
          blobPromiseRef.current = null; // allow retry
          throw err;
        });
    }
    return blobPromiseRef.current;
  };

  const loadPreview = async (): Promise<string | null> => {
    if (objectUrlRef.current) {
      setPreviewUrl(objectUrlRef.current);
      return objectUrlRef.current;
    }
    setIsLoadingPreview(true);
    setPreviewError(null);
    try {
      const blob = await ensureClipBlob();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPreviewUrl(url);
      return url;
    } catch {
      setPreviewError(
        'Preview could not be loaded. Check the Colab backend is running, then tap play to retry.'
      );
      return null;
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleDownload = async () => {
    if (isPreparingDownload) return;
    setIsPreparingDownload(true);
    try {
      const blob = await ensureClipBlob();
      if (!objectUrlRef.current) {
        objectUrlRef.current = URL.createObjectURL(blob);
      }
      const a = document.createElement('a');
      a.href = objectUrlRef.current;
      a.download = `${downloadSlug || clip.id}-1080x1920.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setPreviewError(
        'Download failed. Check the Colab backend is running, then try again.'
      );
    } finally {
      setIsPreparingDownload(false);
    }
  };

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    []
  );

  useEffect(() => {
    if (!previewUrl || !autoPlayRef.current) return;
    autoPlayRef.current = false;
    const vid = videoRef.current;
    if (!vid) return;
    vid
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => setIsPlaying(false));
  }, [previewUrl]);

  const backendClipUrl = useMemo(() => {
    const cleanBase = colabBaseUrl.trim().replace(/\/+$/, '');
    if (clip.downloadUrl && clip.downloadUrl.startsWith('http')) {
      return clip.downloadUrl;
    }
    if (clip.downloadUrl && clip.downloadUrl.startsWith('/')) {
      return `${cleanBase}${clip.downloadUrl}`;
    }
    return `${cleanBase}/api/download/${encodeURIComponent(jobId)}/${encodeURIComponent(clip.id)}`;
  }, [colabBaseUrl, jobId, clip.id, clip.downloadUrl]);

  const downloadSlug = clip.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);

  useEffect(() => {
    setDraftTitle(clip.title);
    setDraftTranscript(clip.transcript);
  }, [clip.title, clip.transcript]);

  useEffect(() => {
    setDraftStartSec(String(clip.startTimeSec));
    setDraftEndSec(String(clip.endTimeSec));
    setDraftCaptionStyle(clip.captionStyle ?? 'karaoke');
  }, [clip.startTimeSec, clip.endTimeSec, clip.captionStyle]);

  const handleRetrim = () => {
    const s = parseFloat(draftStartSec);
    const e = parseFloat(draftEndSec);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e - s < 5) {
      setRetrimError('Enter a valid range of at least 5 seconds (start < end).');
      return;
    }
    setRetrimError(null);
    onRetrim?.(clip.id, s, e, draftCaptionStyle);
  };

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    const handleTimeUpdate = () => {
      setCurrentTime(vid.currentTime);
    };
    const handleEnded = () => {
      setIsPlaying(false);
    };

    vid.addEventListener('timeupdate', handleTimeUpdate);
    vid.addEventListener('ended', handleEnded);
    return () => {
      vid.removeEventListener('timeupdate', handleTimeUpdate);
      vid.removeEventListener('ended', handleEnded);
    };
  }, [previewUrl]);

  const togglePlay = async () => {
    if (isPlaying) {
      videoRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    if (isLoadingPreview) return;
    if (videoError) {
      // Blob was fetched but the video element could not play it: fetch fresh
      setVideoError(false);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      blobPromiseRef.current = null;
      setPreviewUrl(null);
    }
    if (!previewUrl || videoError) {
      autoPlayRef.current = true;
      await loadPreview();
      return;
    }
    const vid = videoRef.current;
    if (!vid) return;
    try {
      await vid.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextSec = Number(e.target.value);
    setCurrentTime(nextSec);
    if (videoRef.current) {
      videoRef.current.currentTime = nextSec;
    }
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    if (videoRef.current) {
      videoRef.current.muted = next;
    }
  };

  const handleSaveEdits = () => {
    const cleanTitle = draftTitle.trim() || clip.title;
    const cleanTranscript = draftTranscript.trim() || clip.transcript;
    const retokenized = retokenizeTranscript(cleanTranscript, clip.durationSec);
    onUpdateClip(clip.id, {
      title: cleanTitle,
      transcript: cleanTranscript,
      words: retokenized,
    });
    setIsEditing(false);
  };

  const captionChunk = useMemo(() => {
    if (!clip.words.length) return { tokens: [], activeIndex: -1 };
    let idx = clip.words.findIndex((w) => currentTime >= w.start && currentTime <= w.end);
    if (idx === -1) {
      const lastPassed = clip.words.filter((w) => w.start <= currentTime).length - 1;
      idx = Math.max(0, lastPassed);
    }
    const chunkStart = Math.floor(idx / 3) * 3;
    return {
      tokens: clip.words.slice(chunkStart, chunkStart + 3),
      activeIndex: idx - chunkStart,
    };
  }, [clip.words, currentTime]);

  const scoreTone =
    clip.viralityScore >= 90
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : clip.viralityScore >= 80
        ? 'text-indigo-700 bg-indigo-50 border-indigo-200'
        : 'text-amber-700 bg-amber-50 border-amber-200';

  const momentBadge: Record<string, { label: string; classes: string }> = {
    wtf: { label: 'WTF', classes: 'text-amber-700 bg-amber-50 border-amber-200' },
    funny: { label: 'Funny', classes: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    extreme_reaction: {
      label: 'Extreme reaction',
      classes: 'text-rose-700 bg-rose-50 border-rose-200',
    },
    insight: { label: 'Insight', classes: 'text-sky-700 bg-sky-50 border-sky-200' },
    story: { label: 'Story', classes: 'text-violet-700 bg-violet-50 border-violet-200' },
  };
  const moment = clip.momentType ? momentBadge[clip.momentType] : undefined;

  return (
    <article className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
      {/* 9:16 Vertical Video Preview Viewport */}
      <div className="relative aspect-[9/16] bg-slate-900 overflow-hidden select-none group">
        {previewUrl && !videoError ? (
          <video
            ref={videoRef}
            src={previewUrl}
            muted={isMuted}
            playsInline
            loop
            preload="metadata"
            onError={() => setVideoError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-slate-900 flex flex-col items-center justify-center p-6 text-center text-white">
            <Film className="w-10 h-10 text-indigo-400 mb-3" />
            <p className="font-display text-sm font-semibold">{clip.title}</p>
            <p className="mt-1 text-xs text-slate-400">
              {videoError
                ? 'Unable to play this clip in the browser. Try Download below, or tap play to retry.'
                : isLoadingPreview
                  ? 'Loading preview…'
                  : (previewError ?? 'Tap play to load the preview.')}
            </p>
          </div>
        )}

        {/* Measured Gradient Scrim for Legible Controls & Kinetic Captions */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/20 to-slate-950/35 pointer-events-none"
        />

        {/* Top Bar Overlay inside 9:16 Frame */}
        <div className="absolute top-3 inset-x-3 flex items-center justify-between gap-2">
          <span className="font-mono-tabular text-[11px] font-medium text-white/95 bg-slate-950/60 backdrop-blur-sm px-2.5 py-1 rounded-md">
            9:16 · 1080×1920
          </span>

          <button
            type="button"
            onClick={() => setShowCaptions((prev) => !prev)}
            aria-pressed={showCaptions}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
              showCaptions
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-950/60 text-slate-200 hover:bg-slate-950/80'
            }`}
          >
            <Captions className="w-3.5 h-3.5" aria-hidden="true" />
            {showCaptions ? 'Captions On' : 'Captions Off'}
          </button>
        </div>

        {/* Center Play Trigger */}
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause clip preview' : 'Play clip preview'}
          className="absolute inset-0 w-full h-full flex items-center justify-center focus-visible:outline-none cursor-pointer"
        >
          <span
            className={`w-14 h-14 rounded-full bg-white/95 text-slate-900 shadow-lg flex items-center justify-center transition-opacity duration-150 ${
              isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
            }`}
          >
            {isPlaying ? (
              <Pause className="w-6 h-6 fill-current" />
            ) : (
              <Play className="w-6 h-6 fill-current ml-0.5" />
            )}
          </span>
        </button>

        {/* Bold Kinetic Word-Highlight Captions Preview with Indigo Accent */}
        {showCaptions && captionChunk.tokens.length > 0 && (
          <div className="absolute inset-x-4 bottom-16 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 pointer-events-none">
            {captionChunk.tokens.map((token, idx) => {
              const isCurrent = idx === captionChunk.activeIndex;
              return (
                <span
                  key={`${token.word}-${idx}`}
                  className={`font-display text-lg sm:text-xl font-extrabold uppercase tracking-tight px-2 py-0.5 rounded-md transition-transform duration-100 ${
                    isCurrent
                      ? 'bg-indigo-600 text-white scale-105 shadow-md'
                      : 'text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]'
                  }`}
                >
                  {token.word}
                </span>
              );
            })}
          </div>
        )}

        {/* Player Scrubber Controls */}
        <div
          className="absolute bottom-3 inset-x-3 flex items-center gap-2.5 bg-slate-950/70 backdrop-blur-sm px-3 py-2 rounded-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="text-white hover:text-indigo-300 transition-colors cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>

          <input
            type="range"
            min={0}
            max={clip.durationSec}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            aria-label="Seek clip playback"
            className="flex-1 h-1.5 accent-indigo-500 cursor-pointer"
          />

          <span className="font-mono-tabular text-[11px] text-slate-200 whitespace-nowrap">
            {formatTimecode(currentTime)} / {formatTimecode(clip.durationSec)}
          </span>

          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
            className="text-white hover:text-indigo-300 transition-colors cursor-pointer"
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Card Body: Virality Score, Reasoning, Editable Hook & Transcript, Direct MP4 Download */}
      <div className="p-5 flex-1 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold font-mono-tabular ${scoreTone}`}
            >
              <span>{clip.viralityScore}/100</span>
              <span className="font-sans font-medium">Virality Score</span>
            </div>

            {moment && (
              <span
                className={`inline-flex items-center px-2.5 py-1 rounded-lg border text-xs font-semibold ${moment.classes}`}
              >
                {moment.label}
              </span>
            )}
          </div>

          <span className="font-mono-tabular text-xs text-slate-500">
            {formatTimecode(clip.startTimeSec)} – {formatTimecode(clip.endTimeSec)}
          </span>
        </div>

        {/* Expandable AI Hook & Retention Reasoning */}
        <div className="border-y border-slate-100 py-2.5">
          <button
            type="button"
            onClick={() => setIsReasoningOpen((prev) => !prev)}
            aria-expanded={isReasoningOpen}
            className="w-full flex items-center justify-between text-xs font-semibold text-slate-700 hover:text-indigo-600 transition-colors cursor-pointer"
          >
            <span>AI Hook &amp; Retention Reasoning</span>
            {isReasoningOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {isReasoningOpen && (
            <div className="mt-2.5 space-y-2 text-xs text-slate-600 leading-relaxed">
              <p>
                <strong className="text-slate-900 font-semibold">Hook:</strong> {clip.hookReasoning}
              </p>
              <p>
                <strong className="text-slate-900 font-semibold">Retention:</strong>{' '}
                {clip.retentionInsight}
              </p>
              <p>
                <strong className="text-slate-900 font-semibold">Pacing:</strong> {clip.pacingNote}
              </p>
            </div>
          )}
        </div>

        {/* Editable Hook Title & Transcript Snippet */}
        <div className="flex-1 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">
              {isEditing ? 'Editing Hook & Captions' : 'Hook Title & Transcript'}
            </span>
            {isEditing ? (
              <button
                type="button"
                onClick={handleSaveEdits}
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800 cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                Save Changes
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Edit Text
              </button>
            )}
          </div>

          {isEditing ? (
            <div className="space-y-2.5">
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-label="Edit hook title"
                className="w-full px-3 py-2 text-sm font-semibold text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              />
              <textarea
                rows={4}
                value={draftTranscript}
                onChange={(e) => setDraftTranscript(e.target.value)}
                aria-label="Edit transcript snippet"
                className="w-full px-3 py-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 leading-relaxed resize-y"
              />
            </div>
          ) : (
            <>
              <h3 className="font-display text-base font-bold text-slate-900 leading-snug">
                {clip.title}
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">
                {clip.transcript}
              </p>
            </>
          )}
        </div>

        {/* Trim start/end + caption style + re-render (v2) */}
        {onRetrim && (
          <div className="border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setShowTrim((prev) => !prev)}
              aria-expanded={showTrim}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-indigo-600 transition-colors cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
              {showTrim ? 'Hide trim options' : 'Trim & re-render'}
            </button>

            {showTrim && (
              <div className="mt-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500 whitespace-nowrap">Start (sec)</label>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={draftStartSec}
                    onChange={(e) => setDraftStartSec(e.target.value)}
                    aria-label="Trim start in seconds"
                    className="w-20 h-9 px-2 text-xs font-mono-tabular font-semibold text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                  <label className="text-xs text-slate-500 whitespace-nowrap">End (sec)</label>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={draftEndSec}
                    onChange={(e) => setDraftEndSec(e.target.value)}
                    aria-label="Trim end in seconds"
                    className="w-20 h-9 px-2 text-xs font-mono-tabular font-semibold text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  Original video time: {formatTimecode(clip.startTimeSec)} –{' '}
                  {formatTimecode(clip.endTimeSec)}
                </p>
                <div className="flex items-center gap-2">
                  <select
                    value={draftCaptionStyle}
                    onChange={(e) =>
                      setDraftCaptionStyle(e.target.value as CaptionStyleId)
                    }
                    aria-label="Caption style"
                    className="h-9 px-2 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 cursor-pointer"
                  >
                    {CAPTION_STYLE_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleRetrim}
                    disabled={isRetrimming}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
                  >
                    {isRetrimming ? 'Re-rendering…' : 'Re-render clip'}
                  </button>
                </div>
                {retrimError && <p className="text-xs text-red-600">{retrimError}</p>}
              </div>
            )}
          </div>
        )}

        {/* Direct MP4 Download from Colab Backend (blob fetch: same tab, no ngrok warning page) */}
        <button
          type="button"
          onClick={handleDownload}
          disabled={isPreparingDownload}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 rounded-xl transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 cursor-pointer"
        >
          <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
          {isPreparingDownload ? 'Preparing download…' : 'Download 1080x1920 MP4'}
        </button>
      </div>
    </article>
  );
};
