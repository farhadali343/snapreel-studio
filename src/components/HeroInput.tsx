import React, { useRef, useState } from 'react';
import {
  FileVideo,
  Link2,
  Scissors,
  Upload,
  AlertCircle,
  X,
  Server,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import type { TargetDuration } from '../types/clip';
import { detectVideoPlatform, formatPlatformLabel, DEFAULT_BACKEND_URL } from '../lib/clipHelpers';

export type ConnectionStatus = 'idle' | 'testing' | 'connected' | 'error';

interface HeroInputProps {
  sourceMode: 'url' | 'file';
  onSourceModeChange: (mode: 'url' | 'file') => void;
  urlInput: string;
  onUrlInputChange: (val: string) => void;
  selectedFile: File | null;
  onSelectedFileChange: (file: File | null) => void;
  targetDuration: TargetDuration;
  onTargetDurationChange: (duration: TargetDuration) => void;
  numClips: number;
  onNumClipsChange: (count: number) => void;
  colabUrl: string;
  onColabUrlChange: (url: string) => void;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  onTestConnection: () => void;
  isSubmitting: boolean;
  validationError: string | null;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const SAMPLE_LINKS = [
  { label: 'YouTube Podcast', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { label: 'Twitch VOD', url: 'https://www.twitch.tv/videos/2184930210' },
  { label: 'Kick Stream', url: 'https://kick.com/creator/videos/84f2a10c' },
];

const DURATION_OPTIONS: TargetDuration[] = [15, 30, 45, 60];

export const HeroInput: React.FC<HeroInputProps> = ({
  sourceMode,
  onSourceModeChange,
  urlInput,
  onUrlInputChange,
  selectedFile,
  onSelectedFileChange,
  targetDuration,
  onTargetDurationChange,
  numClips,
  onNumClipsChange,
  colabUrl,
  onColabUrlChange,
  connectionStatus,
  connectionError,
  onTestConnection,
  isSubmitting,
  validationError,
  onSubmit,
  inputRef,
}) => {
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Manual entry: any clip count 1-20 and any length 10-180 sec. The text
  // states let the user type freely; the value commits (clamped) on blur
  // or Enter so an intermediate keystroke like "1" of "18" is not forced.
  const [durationText, setDurationText] = useState(String(targetDuration));
  const [clipsText, setClipsText] = useState(String(numClips));

  const clampInt = (value: string, min: number, max: number, fallback: number) => {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  };

  const commitDuration = () => {
    const next = clampInt(durationText, 10, 180, targetDuration);
    setDurationText(String(next));
    if (next !== targetDuration) onTargetDurationChange(next);
  };

  const commitClips = () => {
    const next = clampInt(clipsText, 1, 20, numClips);
    setClipsText(String(next));
    if (next !== numClips) onNumClipsChange(next);
  };

  const handleDurationChip = (sec: number) => {
    setDurationText(String(sec));
    onTargetDurationChange(sec);
  };

  const detectedPlatform = detectVideoPlatform(urlInput);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      onSourceModeChange('file');
      onSelectedFileChange(file);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <section id="clipper" className="pt-10 pb-12 sm:pt-14 sm:pb-14">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center mb-8 sm:mb-10">
        <p className="text-sm font-medium text-indigo-600 mb-3">
          YouTube · Twitch · Kick · Local MP4
        </p>
        <h1 className="font-display text-3xl sm:text-5xl font-bold tracking-tight text-slate-900 balance-text leading-[1.15]">
          Turn long-form videos into viral 9:16 vertical clips
        </h1>
        <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Connect your Google Colab backend, drop a stream link or MP4 file, and render real
          1080×1920 vertical shorts with Whisper captions and active-speaker framing.
        </p>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <form
          onSubmit={handleFormSubmit}
          className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 sm:p-8"
        >
          {/* Top Input Controls Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 mb-6 border-b border-slate-100">
            <div
              role="tablist"
              aria-label="Video source type"
              className="inline-flex items-center p-1 bg-slate-100 rounded-lg self-start"
            >
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === 'url'}
                onClick={() => onSourceModeChange('url')}
                className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  sourceMode === 'url'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Link2 className="w-4 h-4" aria-hidden="true" />
                Paste Video URL
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === 'file'}
                onClick={() => onSourceModeChange('file')}
                className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  sourceMode === 'file'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Upload className="w-4 h-4" aria-hidden="true" />
                Upload MP4
              </button>
            </div>

            {connectionStatus === 'connected' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 self-start sm:self-auto whitespace-nowrap">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                Connected
              </span>
            )}
          </div>

          {/* Colab Backend URL Field */}
          <div className="mb-6 pb-6 border-b border-slate-100 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="colab-backend-url"
                className="flex items-center gap-2 text-sm font-medium text-slate-700"
              >
                <Server className="w-4 h-4 text-indigo-600" aria-hidden="true" />
                Colab backend URL
              </label>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200">
                Permanent URL — no pasting needed
              </span>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                id="colab-backend-url"
                type="url"
                value={colabUrl}
                onChange={(e) => onColabUrlChange(e.target.value)}
                placeholder={DEFAULT_BACKEND_URL}
                className="flex-1 h-11 px-3.5 text-sm font-mono-tabular text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent transition-colors"
              />
              <button
                type="button"
                onClick={onTestConnection}
                disabled={connectionStatus === 'testing'}
                className="inline-flex items-center justify-center gap-2 h-11 px-4 text-sm font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-60 border border-indigo-200 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {connectionStatus === 'testing' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    Testing...
                  </>
                ) : (
                  'Connect & Test'
                )}
              </button>
            </div>

            {connectionStatus === 'error' && connectionError && (
              <div
                role="alert"
                className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2"
              >
                <AlertCircle className="w-4 h-4 shrink-0 text-red-600" aria-hidden="true" />
                <span>{connectionError}</span>
              </div>
            )}
          </div>

          {/* URL Paste Bar or Local MP4 Dropzone */}
          {sourceMode === 'url' ? (
            <div className="space-y-3">
              <label htmlFor="video-url-input" className="block text-sm font-medium text-slate-700">
                Video or VOD Link
              </label>
              <div className="relative flex items-center">
                <Link2
                  className="w-5 h-5 text-slate-400 absolute left-4 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  ref={inputRef}
                  id="video-url-input"
                  type="url"
                  value={urlInput}
                  onChange={(e) => onUrlInputChange(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=... or Twitch / Kick VOD link"
                  className="w-full h-13 pl-12 pr-28 text-sm sm:text-base text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent transition-colors"
                />
                {urlInput && (
                  <button
                    type="button"
                    onClick={() => onUrlInputChange('')}
                    aria-label="Clear URL"
                    className="absolute right-3 p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <div className="flex items-center gap-2">
                  <span>
                    {detectedPlatform
                      ? `${formatPlatformLabel(detectedPlatform)} link recognized`
                      : 'Supports YouTube, Twitch, and Kick URLs'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>1080×1920 MP4 export</span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-slate-400">Sample link:</span>
                  {SAMPLE_LINKS.map((sample) => (
                    <button
                      key={sample.label}
                      type="button"
                      onClick={() => onUrlInputChange(sample.url)}
                      className="text-indigo-600 hover:text-indigo-800 font-medium hover:underline underline-offset-2 whitespace-nowrap cursor-pointer"
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                Local Video File (MP4, MOV, WebM)
              </label>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
                  isDragging
                    ? 'border-indigo-500 bg-indigo-50/50'
                    : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                }`}
              >
                <input
                  ref={filePickerRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    onSelectedFileChange(file);
                  }}
                  className="sr-only"
                />

                {selectedFile ? (
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-left">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                        <FileVideo className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">
                          {selectedFile.name}
                        </p>
                        <p className="text-xs text-slate-500 font-mono-tabular">
                          {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB · Ready to upload to
                          Colab
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => filePickerRef.current?.click()}
                        className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        Replace File
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectedFileChange(null)}
                        aria-label="Remove selected file"
                        className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="py-2">
                    <Upload className="w-7 h-7 text-indigo-600 mx-auto mb-2" aria-hidden="true" />
                    <p className="text-sm font-medium text-slate-800">
                      Drag and drop an MP4 video here, or{' '}
                      <button
                        type="button"
                        onClick={() => filePickerRef.current?.click()}
                        className="text-indigo-600 hover:text-indigo-700 font-semibold underline underline-offset-2 cursor-pointer"
                      >
                        browse from computer
                      </button>
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Uploads directly to your Colab backend for 9:16 crop and caption burn-in
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {validationError && (
            <div
              role="alert"
              className="mt-4 flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl"
            >
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{validationError}</span>
            </div>
          )}

          {/* Duration, Clip Count & Submit Row */}
          <div className="mt-6 pt-5 border-t border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-5">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="text-sm font-medium text-slate-700 whitespace-nowrap">
                  Target Clip Length
                </span>
                <div
                  role="radiogroup"
                  aria-label="Target clip duration"
                  className="inline-flex items-center p-1 bg-slate-100 rounded-lg"
                >
                  {DURATION_OPTIONS.map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      role="radio"
                      aria-checked={targetDuration === sec}
                      onClick={() => handleDurationChip(sec)}
                      className={`px-3 py-1.5 text-xs font-mono-tabular font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        targetDuration === sec
                          ? 'bg-white text-indigo-700 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={10}
                    max={180}
                    value={durationText}
                    onChange={(e) => setDurationText(e.target.value)}
                    onBlur={commitDuration}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    aria-label="Custom clip length in seconds"
                    className="w-16 h-9 px-2 text-xs font-mono-tabular font-semibold text-slate-900 bg-slate-100 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                  <span className="text-xs text-slate-500">sec (10–180)</span>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <label
                  htmlFor="num-clips-input"
                  className="text-sm font-medium text-slate-700 whitespace-nowrap"
                >
                  Number of clips
                </label>
                <input
                  id="num-clips-input"
                  type="number"
                  min={1}
                  max={20}
                  value={clipsText}
                  onChange={(e) => setClipsText(e.target.value)}
                  onBlur={commitClips}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  aria-label="Number of clips (1 to 20)"
                  className="w-16 h-9 px-2 text-xs font-mono-tabular font-semibold text-slate-900 bg-slate-100 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                />
                <span className="text-xs text-slate-500">(1–20)</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || connectionStatus !== 'connected'}
              title={
                connectionStatus === 'connected'
                  ? undefined
                  : 'Connect the backend above first — press Connect & Test.'
              }
              className="inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 disabled:cursor-not-allowed rounded-xl shadow-sm transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 cursor-pointer"
            >
              <Scissors className="w-4 h-4" aria-hidden="true" />
              {isSubmitting ? 'Starting Pipeline...' : 'Generate Viral Clips'}
            </button>
          </div>

          <p className="mt-3 text-xs text-slate-400 text-center lg:text-right">
            Custom values allowed — more clips or longer clips take more time on Colab.
          </p>

          {(connectionStatus === 'idle' || connectionStatus === 'error') && !isSubmitting && (
            <p className="mt-3 text-xs text-slate-500 text-center lg:text-right">
              Connect the backend above to enable Generate.
            </p>
          )}
        </form>
      </div>
    </section>
  );
};
