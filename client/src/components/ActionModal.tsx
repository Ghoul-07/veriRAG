import React, { useState } from 'react';
import { GitPullRequest, Check, X, ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react';

interface ActionDraft {
  isActionIntent: boolean;
  actionType: string;
  title: string;
  body: string;
  labels: string[];
}

interface Verification {
  isFaithful: boolean;
  confidenceScore: number;
  unsupportedClaims: string[];
  reasoning: string;
}

interface ActionModalProps {
  isOpen: boolean;
  status: 'VERIFIED_READY' | 'BLOCKED';
  draft: ActionDraft;
  verification: Verification;
  onClose: () => void;
  onExecuted: (issueUrl: string) => void;
}

export const ActionModal: React.FC<ActionModalProps> = ({
  isOpen,
  status,
  draft,
  verification,
  onClose,
  onExecuted,
}) => {
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleExecute = async () => {
    setExecuting(true);
    setError(null);

    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

    try {
      const res = await fetch(`${BACKEND_URL}/api/v1/action/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          body: draft.body,
          labels: draft.labels,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Execution failed');

      onExecuted(data.issueUrl);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to dispatch issue to GitHub.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 top-0 left-0 right-0 bottom-0 z-[9999] flex items-center justify-center bg-slate-950/85 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="relative bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col my-auto max-h-[85vh] overflow-hidden">
        
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-indigo-600/20 border border-indigo-500/30 rounded-lg">
              <GitPullRequest className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-slate-100 leading-tight">Gated Action Execution</h3>
              <p className="text-[11px] text-slate-400">Human-in-the-loop review & verification</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-3.5 text-xs custom-scrollbar flex-1">
          {/* Judge Gate Verification Banner */}
          <div
            className={`p-3.5 rounded-xl border ${
              status === 'VERIFIED_READY'
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-xs">
              {status === 'VERIFIED_READY' ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Action Approved by Judge Gate ({Math.round(verification.confidenceScore * 100)}% Confidence)</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>Action Blocked by Judge Gate</span>
                </>
              )}
            </div>
            <p className="mt-1.5 text-slate-300 text-[11px] leading-relaxed">
              {verification.reasoning}
            </p>
          </div>

          {/* Drafted Details */}
          <div className="space-y-3 bg-slate-950/70 border border-slate-800/80 p-3.5 rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 font-medium text-[11px]">Target Action</span>
              <span className="font-mono text-indigo-300 bg-indigo-950/60 border border-indigo-800/50 px-2 py-0.5 rounded text-[10px] font-semibold uppercase">
                {draft.actionType || 'CREATE_GITHUB_ISSUE'}
              </span>
            </div>

            <div>
              <span className="text-slate-400 font-medium block mb-1 text-[11px]">Issue Title</span>
              <div className="font-semibold text-slate-100 bg-slate-900 border border-slate-800 px-3 py-2 rounded-lg text-xs leading-snug">
                {draft.title}
              </div>
            </div>

            <div>
              <span className="text-slate-400 font-medium block mb-1 text-[11px]">Draft Markdown Body</span>
              <pre className="p-3 bg-slate-900/90 rounded-lg text-slate-300 font-mono whitespace-pre-wrap text-[11px] max-h-36 overflow-y-auto border border-slate-800 leading-relaxed custom-scrollbar">
                {draft.body}
              </pre>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <span className="text-slate-400 font-medium text-[11px]">Labels:</span>
              <div className="flex gap-1.5 flex-wrap">
                {draft.labels.map((lbl, idx) => (
                  <span
                    key={idx}
                    className="bg-indigo-950/80 border border-indigo-700/60 text-indigo-300 px-2 py-0.5 rounded text-[10px] font-mono"
                  >
                    {lbl}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-rose-950/50 border border-rose-800/60 text-rose-300 rounded-xl text-xs">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-end gap-2.5 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          {status === 'VERIFIED_READY' && (
            <button
              onClick={handleExecute}
              disabled={executing}
              className="px-4 py-1.5 rounded-xl text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white flex items-center gap-1.5 transition-colors shadow-sm"
            >
              {executing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Dispatching...
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Approve & Dispatch
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};