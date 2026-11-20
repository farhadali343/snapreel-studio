export type VideoPlatform =
  | 'youtube'
  | 'twitch'
  | 'kick'
  | 'local'
  | 'direct-mp4'
  | 'frameio'
  | 'upload';

export type TargetDuration = number;

export type CaptionStyleId = 'karaoke' | 'bold-white' | 'pop';

export type StepState = 'pending' | 'active' | 'completed' | 'failed';

export type PipelineStageKey =
  | 'downloading'
  | 'transcribing'
  | 'scoring'
  | 'cropping'
  | 'burning';

export interface PipelineStep {
  key: PipelineStageKey;
  label: string;
  toolTag: string;
  detail: string;
  state: StepState;
  durationMs?: number;
}

export interface WordToken {
  word: string;
  start: number;
  end: number;
}

export interface GeneratedClip {
  id: string;
  title: string;
  viralityScore: number;
  momentType?: string;
  hookReasoning: string;
  retentionInsight: string;
  pacingNote: string;
  durationSec: number;
  startTimeSec: number;
  endTimeSec: number;
  aspectRatio: '9:16';
  resolution: '1080x1920';
  videoUrl?: string;
  downloadUrl?: string;
  transcript: string;
  words: WordToken[];
  speakerFocusX?: number;
  captionStyle?: CaptionStyleId;
}

export interface ClipJob {
  jobId: string;
  sourceType: 'url' | 'file';
  sourceUrl?: string;
  fileName?: string;
  platform: VideoPlatform;
  targetDuration: TargetDuration;
  numClips: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  currentStepIndex: number;
  progressPercent: number;
  steps: PipelineStep[];
  clips: GeneratedClip[];
  errorMessage?: string;
  createdAt: string;
}
