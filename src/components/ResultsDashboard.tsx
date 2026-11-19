import React, { useMemo, useState } from 'react';
import { ArrowUpDown, Clapperboard } from 'lucide-react';
import type { ClipJob, GeneratedClip } from '../types/clip';
import { ClipCard } from './ClipCard';

interface ResultsDashboardProps {
  job: ClipJob | null;
  clips: GeneratedClip[];
  colabBaseUrl: string;
  onUpdateClip: (clipId: string, updates: Partial<GeneratedClip>) => void;
}

export const ResultsDashboard: React.FC<ResultsDashboardProps> = ({
  job,
  clips,
  colabBaseUrl,
  onUpdateClip,
}) => {
  const [sortBy, setSortBy] = useState<'virality' | 'timeline'>('virality');

  const sortedClips = useMemo(() => {
    const copy = [...clips];
    if (sortBy === 'virality') {
      return copy.sort((a, b) => b.viralityScore - a.viralityScore);
    }
    return copy.sort((a, b) => a.startTimeSec - b.startTimeSec);
  }, [clips, sortBy]);

  const isLoading = job?.status === 'queued' || job?.status === 'processing';

  return (
    <section id="results" className="py-6 sm:py-9">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-5">
          <div>
            <p className="text-xs font-medium text-slate-500 mb-1">
              {clips.length > 0
                ? `${clips.length} vertical clips · 9:16 Aspect Ratio · 1080×1920 MP4`
                : 'Generated 9:16 Vertical Shorts'}
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
              Results Dashboard
            </h2>
          </div>

          {clips.length > 0 && (
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 ml-2 mr-1" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setSortBy('virality')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  sortBy === 'virality'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Top Virality
              </button>
              <button
                type="button"
                onClick={() => setSortBy('timeline')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  sortBy === 'timeline'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Timeline Order
              </button>
            </div>
          )}
        </div>

        {/* Loading Skeleton State */}
        {isLoading && clips.length === 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[0, 1, 2].map((skeletonIdx) => (
              <div
                key={skeletonIdx}
                className="bg-white border border-slate-200 rounded-2xl overflow-hidden animate-pulse"
              >
                <div className="aspect-[9/16] bg-slate-200" />
                <div className="p-4 sm:p-5 space-y-3">
                  <div className="h-5 w-32 bg-slate-200 rounded" />
                  <div className="h-5 w-4/5 bg-slate-200 rounded" />
                  <div className="h-12 w-full bg-slate-100 rounded" />
                  <div className="h-10 w-full bg-indigo-100 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && clips.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 sm:p-12 text-center">
            <div className="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-3.5">
              <Clapperboard className="w-5 h-5" aria-hidden="true" />
            </div>
            <h3 className="font-display text-lg font-bold text-slate-900">
              No vertical clips generated yet
            </h3>
            <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              Press Connect &amp; Test on your Colab backend URL, paste a YouTube, Twitch, or Kick
              link (or upload an MP4), and click Generate Viral Clips.
            </p>
          </div>
        )}

        {/* 3-Column 9:16 Clips Grid */}
        {sortedClips.length > 0 && job && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {sortedClips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                jobId={job.jobId}
                colabBaseUrl={colabBaseUrl}
                onUpdateClip={onUpdateClip}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
