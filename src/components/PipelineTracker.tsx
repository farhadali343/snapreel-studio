import React from 'react';
import { Check, Loader2, AlertTriangle, RotateCcw } from 'lucide-react';
import type { ClipJob, PipelineStep } from '../types/clip';
import { formatPlatformLabel } from '../lib/clipHelpers';

interface PipelineTrackerProps {
  job: ClipJob | null;
  onRetry: () => void;
}

const DEFAULT_STEPS: PipelineStep[] = [
  {
    key: 'downloading',
    label: 'Downloading Stream',
    toolTag: 'yt-dlp',
    detail: 'Waiting for video source',
    state: 'pending',
  },
  {
    key: 'transcribing',
    label: 'Transcribing Audio',
    toolTag: 'Whisper',
    detail: 'Word-level speech recognition',
    state: 'pending',
  },
  {
    key: 'scoring',
    label: 'AI Virality Scoring',
    toolTag: 'Virality Scorer',
    detail: 'Hook & retention ranking',
    state: 'pending',
  },
  {
    key: 'cropping',
    label: 'Active Speaker 9:16 Crop',
    toolTag: 'MediaPipe',
    detail: 'Vertical face-tracking reframe',
    state: 'pending',
  },
  {
    key: 'burning',
    label: 'Burning Dynamic Captions',
    toolTag: 'FFmpeg',
    detail: '1080x1920 kinetic word highlight',
    state: 'pending',
  },
];

export const PipelineTracker: React.FC<PipelineTrackerProps> = ({ job, onRetry }) => {
  const steps = job?.steps ?? DEFAULT_STEPS;
  const progress = job?.progressPercent ?? 0;
  const activeStepIndex = steps.findIndex((s) => s.state === 'active');
  const resolvedIndex = activeStepIndex !== -1 ? activeStepIndex : (job?.currentStepIndex ?? 0);
  const activeStep = steps[resolvedIndex] ?? steps[0];

  const liveStageBadge = !job
    ? 'Idle'
    : job.status === 'completed'
      ? 'Completed'
      : job.status === 'failed'
        ? 'Failed'
        : `Stage ${resolvedIndex + 1} of ${steps.length} · ${activeStep.label}`;

  const statusHeading = !job
    ? 'Ready to process'
    : job.status === 'completed'
      ? `Completed · ${job.clips.length} vertical clips ready`
      : job.status === 'failed'
        ? `Interrupted at ${activeStep?.label ?? 'Pipeline'}`
        : `${activeStep?.label ?? 'Processing'} (${activeStep?.toolTag ?? 'Pipeline'})`;

  return (
    <section id="pipeline" className="py-4 sm:py-6">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-5">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-semibold text-indigo-600">{liveStageBadge}</span>
                {job && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{formatPlatformLabel(job.platform)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular">{job.targetDuration}s target</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular">{job.numClips} clips</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono-tabular">Job #{job.jobId}</span>
                  </>
                )}
              </div>
              <h2 className="font-display text-lg sm:text-xl font-bold text-slate-900">
                {statusHeading}
              </h2>
              {job && job.status !== 'completed' && job.status !== 'failed' && activeStep?.detail && (
                <p className="text-xs text-slate-600">{activeStep.detail}</p>
              )}
            </div>

            <div className="flex items-center gap-3 w-full md:w-auto">
              <div className="flex-1 md:w-48 h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    job?.status === 'failed'
                      ? 'bg-red-600'
                      : job?.status === 'completed'
                        ? 'bg-emerald-600'
                        : 'bg-indigo-600'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="font-mono-tabular text-sm font-bold text-slate-800 w-11 text-right shrink-0">
                {progress}%
              </span>
            </div>
          </div>

          {job?.status === 'failed' && job.errorMessage && (
            <div
              role="alert"
              className="mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800"
            >
              <div className="flex items-start sm:items-center gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5 sm:mt-0" />
                <span>{job.errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-800 bg-white border border-red-200 rounded-lg hover:bg-red-50 self-start sm:self-auto shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry Job
              </button>
            </div>
          )}

          {/* 5-Stage Responsive Stepper */}
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {steps.map((step, index) => {
              const isCompleted = step.state === 'completed';
              const isActive = step.state === 'active';
              const isFailed = step.state === 'failed';

              return (
                <li
                  key={step.key}
                  className={`relative rounded-xl border p-3.5 transition-colors ${
                    isActive
                      ? 'border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-200'
                      : isCompleted
                        ? 'border-emerald-200 bg-emerald-50/30'
                        : isFailed
                          ? 'border-red-200 bg-red-50/40'
                          : 'border-slate-200 bg-slate-50/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono-tabular text-[11px] font-medium text-slate-500">
                      0{index + 1} · {step.toolTag}
                    </span>
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                        isCompleted
                          ? 'bg-emerald-600 text-white'
                          : isActive
                            ? 'bg-indigo-600 text-white'
                            : isFailed
                              ? 'bg-red-600 text-white'
                              : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {isCompleted ? (
                        <Check className="w-3.5 h-3.5" aria-label="Completed" />
                      ) : isActive ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-label="In progress" />
                      ) : isFailed ? (
                        <AlertTriangle className="w-3.5 h-3.5" aria-label="Failed" />
                      ) : (
                        <span className="font-mono-tabular">{index + 1}</span>
                      )}
                    </span>
                  </div>

                  <p className="text-sm font-semibold text-slate-900 leading-snug">
                    {step.label}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 leading-relaxed">{step.detail}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
};
