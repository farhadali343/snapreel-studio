import React, { useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

const COLAB_COMMANDS = `!pip install -q -r backend/requirements.txt pyngrok
!apt-get -qq install -y ffmpeg

import subprocess, threading, time
from pyngrok import ngrok

threading.Thread(
    target=lambda: subprocess.run(["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"], cwd="backend"),
    daemon=True,
).start()
time.sleep(2)
tunnel = ngrok.connect(8000)
print("SnapReel Backend URL:", tunnel.public_url)`;

export const BackendSetupSection: React.FC = () => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(COLAB_COMMANDS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section id="backend-setup" className="py-6 sm:py-8 pb-14">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-7 shadow-sm">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
            <div className="lg:col-span-6 space-y-3">
              <p className="text-xs font-medium text-indigo-600">
                Google Colab Backend · FastAPI + ngrok
              </p>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900">
                Run the video pipeline on Google Colab GPU
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                Start the FastAPI backend in Google Colab using your permanent ngrok endpoint{' '}
                <code className="font-mono-tabular text-xs bg-slate-100 px-1.5 py-0.5 rounded text-slate-800 break-all">
                  https://frenzy-parmesan-swimsuit.ngrok-free.dev
                </code>
                , then press <strong>Connect &amp; Test</strong> above.
              </p>

              <dl className="grid grid-cols-2 gap-3.5 pt-2 text-xs">
                <div className="border-t border-slate-100 pt-2.5">
                  <dt className="font-semibold text-slate-900">01. yt-dlp</dt>
                  <dd className="text-slate-500 mt-0.5">YouTube, Twitch &amp; Kick VOD capture</dd>
                </div>
                <div className="border-t border-slate-100 pt-2.5">
                  <dt className="font-semibold text-slate-900">02. faster-whisper</dt>
                  <dd className="text-slate-500 mt-0.5">Word-level timestamps &amp; transcripts</dd>
                </div>
                <div className="border-t border-slate-100 pt-2.5">
                  <dt className="font-semibold text-slate-900">03. MediaPipe</dt>
                  <dd className="text-slate-500 mt-0.5">Active-speaker 9:16 smooth crop</dd>
                </div>
                <div className="border-t border-slate-100 pt-2.5">
                  <dt className="font-semibold text-slate-900">04. FFmpeg</dt>
                  <dd className="text-slate-500 mt-0.5">1080×1920 H.264 ASS caption burn-in</dd>
                </div>
              </dl>
            </div>

            <div className="lg:col-span-6">
              <div className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-white">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
                    <Terminal className="w-4 h-4 text-indigo-600" aria-hidden="true" />
                    <span>Google Colab Notebook Cell</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy Snippet
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-4 text-xs font-mono-tabular text-slate-800 overflow-x-auto leading-relaxed">
                  {COLAB_COMMANDS}
                </pre>
              </div>
              <p className="mt-2.5 text-xs text-slate-500">
                Exposes <code className="font-mono-tabular">GET /health</code>,{' '}
                <code className="font-mono-tabular">POST /api/process-url</code>,{' '}
                <code className="font-mono-tabular">GET /api/status/:jobId</code>, and{' '}
                <code className="font-mono-tabular">GET /api/download/:jobId/:clipId</code>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
