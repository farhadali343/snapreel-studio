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
} from 'lucide-react';
import type { GeneratedClip } from '../types/clip';
import { formatTimecode, retokenizeTranscript } from '../lib/clipHelpers';

interface ClipCardProps {
  clip: GeneratedClip;
  jobId: string;
  colabBaseUrl: string;
  onUpdateClip: (clipId: string, updates: Partial<GeneratedClip>) => void;
}

export const ClipCard: React.FC<ClipCardProps> = ({
  clip,
  jobId,
  colabBaseUrl,
  onUpdateClip,
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

  useEffect(() => {
    setDraftTitle(clip.title);
    setDraftTranscript(clip.transcript);
  }, [clip.title, clip.transcript]);

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
  }, [backendClipUrl]);

  const togglePlay = async () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (isPlaying) {
      vid.pause();
      setIsPlaying(false);
    } else {
      try {
        await vid.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
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

  const downloadSlug = clip.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);

  return (
    <article className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
      {/* 9:16 Vertical Video Preview Viewport */}
      <div className="relative aspect-[9/16] bg-slate-900 overflow-hidden select-none group">
        {!videoError ? (
          <video
            ref={videoRef}
            src={backendClipUrl}
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
              Unable to stream preview. Use Download 1080x1920 MP4 below.
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
          <div
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold font-mono-tabular ${scoreTone}`}
          >
            <span>{clip.viralityScore}/100</span>
            <span className="font-sans font-medium">Virality Score</span>
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

        {/* Direct MP4 Download Link from Colab Backend */}
        <a
          href={backendClipUrl}
          download={`${downloadSlug || clip.id}-1080x1920.mp4`}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-xl transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
        >
          <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
          Download 1080x1920 MP4
        </a>
      </div>
    </article>
  );
};
