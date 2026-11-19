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
import { detectVideoPlatform, formatPlatformLabel } from '../lib/clipHelpers';

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

const CLIP_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
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

  const detectedPlatform = detectVideoPlatform(urlInput);
  const hasSourceInput =
    sourceMode === 'url' ? urlInput.trim().length > 0 : selectedFile !== null;
  const isGenerateDisabled =
    isSubmitting || connectionStatus !== 'connected' || !hasSourceInput;

  const disabledHint =
    connectionStatus !== 'connected'
      ? 'Press Connect & Test to verify the backend before generating.'
      : !hasSourceInput
        ? sourceMode === 'url'
          ? 'Paste a video URL above to enable generation.'
          : 'Select an MP4 file above to enable generation.'
        : null;

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
    if (!isGenerateDisabled) {
      onSubmit();
    }
  };

  return (
    <section id="clipper" className="pt-7 pb-8 sm:pt-11 sm:pb-10">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center mb-6 sm:mb-8">
        <p className="text-xs sm:text-sm font-medium text-indigo-600 mb-2">
          YouTube · Twitch · Kick · Local MP4
        </p>
        <h1 className="font-display text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-slate-900 balance-text leading-[1.14]">
          Turn long-form videos into viral 9:16 vertical clips
        </h1>
        <p className="mt-3 text-sm sm:text-base text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Test your Colab backend connection, paste a stream link or upload an MP4, and export
          1080×1920 shorts with Whisper captions and active-speaker framing.
        </p>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <form
          onSubmit={handleFormSubmit}
          className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-6"
        >
          {/* Top Input Controls Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 mb-5 border-b border-slate-100">
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

            {connectionStatus === 'connected' ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 self-start sm:self-auto whitespace-nowrap">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
                Connected — backend ready
              </span>
            ) : (
              <span className="text-xs text-slate-500 self-start sm:self-auto">
                {connectionStatus === 'testing'
                  ? 'Checking backend health...'
                  : 'Connect backend below to start'}
              </span>
            )}
          </div>

          {/* Colab Backend URL Field */}
          <div className="mb-5 pb-5 border-b border-slate-100 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="colab-backend-url"
                className="flex items-center gap-2 text-sm font-semibold text-slate-800"
              >
                <Server className="w-4 h-4 text-indigo-600 shrink-0" aria-hidden="true" />
                Colab backend URL
              </label>
              <span className="text-xs text-slate-500">Saved in localStorage</span>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <input
                id="colab-backend-url"
                type="url"
                value={colabUrl}
                onChange={(e) => onColabUrlChange(e.target.value)}
                placeholder="https://frenzy-parmesan-swimsuit.ngrok-free.dev"
                className="flex-1 h-11 px-3.5 text-sm font-mono-tabular text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent transition-colors min-w-0"
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

            {connectionStatus === 'connected' && (
              <div className="flex items-center gap-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                <span>Connected — backend ready</span>
              </div>
            )}

            {connectionStatus === 'error' && connectionError && (
              <div
                role="alert"
                className="flex items-start sm:items-center gap-2 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5"
              >
                <AlertCircle className="w-4 h-4 shrink-0 text-red-600 mt-0.5 sm:mt-0" aria-hidden="true" />
                <span>{connectionError}</span>
              </div>
            )}
          </div>

          {/* URL Paste Bar or Local MP4 Dropzone */}
          {sourceMode === 'url' ? (
            <div className="space-y-2.5">
              <label htmlFor="video-url-input" className="block text-sm font-semibold text-slate-800">
                Video or VOD Link
              </label>
              <div className="relative flex items-center">
                <Link2
                  className="w-5 h-5 text-slate-400 absolute left-3.5 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  ref={inputRef}
                  id="video-url-input"
                  type="url"
                  value={urlInput}
                  onChange={(e) => onUrlInputChange(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=... or Twitch / Kick VOD link"
                  className="w-full h-12 pl-11 pr-11 text-sm sm:text-base text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent transition-colors"
                />
                {urlInput && (
                  <button
                    type="button"
                    onClick={() => onUrlInputChange('')}
                    aria-label="Clear URL"
                    className="absolute right-2.5 p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-500">
                <div className="flex items-center gap-2">
                  <span>
                    {detectedPlatform
                      ? `${formatPlatformLabel(detectedPlatform)} link recognized`
                      : 'Supports YouTube, Twitch, and Kick URLs'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>1080×1920 MP4 export</span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
            <div className="space-y-2.5">
              <label className="block text-sm font-semibold text-slate-800">
                Local Video File (MP4, MOV, WebM)
              </label>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-xl p-5 text-center transition-colors ${
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
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-left">
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
                  <div className="py-1.5">
                    <Upload className="w-6 h-6 text-indigo-600 mx-auto mb-2" aria-hidden="true" />
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
          <div className="mt-5 pt-5 border-t border-slate-100 flex flex-col gap-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-4 sm:gap-5">
                <div className="flex flex-wrap items-center gap-2.5">
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
                        onClick={() => onTargetDurationChange(sec)}
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
                </div>

                <div className="flex items-center gap-2.5">
                  <label
                    htmlFor="num-clips-select"
                    className="text-sm font-medium text-slate-700 whitespace-nowrap"
                  >
                    Number of clips
                  </label>
                  <select
                    id="num-clips-select"
                    value={numClips}
                    onChange={(e) => onNumClipsChange(Number(e.target.value))}
                    className="h-9 px-3 text-xs font-mono-tabular font-semibold text-slate-900 bg-slate-100 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 cursor-pointer"
                  >
                    {CLIP_COUNT_OPTIONS.map((count) => (
                      <option key={count} value={count}>
                        {count} {count === 1 ? 'clip' : 'clips'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={isGenerateDisabled}
                className="w-full lg:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed rounded-xl shadow-sm transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 cursor-pointer"
              >
                <Scissors className="w-4 h-4" aria-hidden="true" />
                {isSubmitting ? 'Starting Pipeline...' : 'Generate Viral Clips'}
              </button>
            </div>

            {disabledHint && !isSubmitting && (
              <p className="text-xs text-slate-500 lg:text-right">{disabledHint}</p>
            )}
          </div>
        </form>
      </div>
    </section>
  );
};
