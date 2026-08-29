import React, { useEffect, useState } from 'react';
import { Files, Trash2, RefreshCw, X, FileText, CheckCircle2, AlertCircle } from 'lucide-react';

export interface DocumentSummary {
  documentname?: string;
  documentName?: string;
  chunkcount?: number;
  chunkCount?: number;
}

interface DocumentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onDocumentDeleted?: () => void;
  refreshTrigger?: number;
}

export const DocumentDrawer: React.FC<DocumentDrawerProps> = ({
  isOpen,
  onClose,
  onDocumentDeleted,
  refreshTrigger = 0,
}) => {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [deletingDoc, setDeletingDoc] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

  // Fetch indexed documents from PostgreSQL
  const fetchDocuments = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/v1/documents`);
      const data = await res.json();
      if (res.ok && data.documents) {
        setDocuments(data.documents);
      } else {
        throw new Error(data.error || 'Failed to fetch documents');
      }
    } catch (err: any) {
      setFeedback({ message: err.message || 'Error connecting to database', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDocuments();
    }
  }, [isOpen, refreshTrigger]);

  // Handle document deletion
  const handleDelete = async (docName: string) => {
    if (!confirm(`Are you sure you want to delete "${docName}" and all associated embeddings?`)) {
      return;
    }

    setDeletingDoc(docName);
    setFeedback(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/v1/documents/${encodeURIComponent(docName)}`, {
        method: 'DELETE',
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete document');
      }

      setFeedback({ message: `Deleted ${docName} (${data.deletedChunks} chunks removed)`, type: 'success' });
      await fetchDocuments();
      if (onDocumentDeleted) {
        onDocumentDeleted();
      }
    } catch (err: any) {
      setFeedback({ message: err.message || 'Deletion failed', type: 'error' });
    } finally {
      setDeletingDoc(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-slate-900 border-l border-slate-800 h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
        
        {/* Drawer Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-indigo-600/20 border border-indigo-500/30 rounded-lg">
              <Files className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h3 className="font-semibold text-sm text-slate-100 leading-tight">Indexed Knowledge Base</h3>
              <p className="text-[11px] text-slate-400">Manage vector embeddings & documents</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={fetchDocuments}
              disabled={loading}
              title="Refresh list"
              className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              title="Close drawer"
              className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Feedback Message */}
        {feedback && (
          <div
            className={`mx-4 mt-3 p-3 rounded-xl border text-xs flex items-center gap-2 ${
              feedback.type === 'success'
                ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            )}
            <span className="leading-snug">{feedback.message}</span>
          </div>
        )}

        {/* Documents List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 custom-scrollbar">
          {loading && documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500 gap-2 text-xs">
              <RefreshCw className="w-5 h-5 animate-spin text-indigo-400" />
              <span>Loading indexed documents...</span>
            </div>
          ) : documents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500 gap-2 text-xs border border-dashed border-slate-800 rounded-xl p-4 text-center">
              <FileText className="w-6 h-6 text-slate-600" />
              <span>No documents indexed in pgvector yet.</span>
            </div>
          ) : (
            documents.map((doc, idx) => {
              const name = doc.documentName || doc.documentname || 'Unknown Document';
              const count = doc.chunkCount ?? doc.chunkcount ?? 0;
              const isDeleting = deletingDoc === name;

              return (
                <div
                  key={idx}
                  className="bg-slate-950/60 border border-slate-800 hover:border-slate-700/80 rounded-xl p-3.5 flex items-center justify-between gap-3 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 bg-slate-900 border border-slate-800 rounded-lg shrink-0">
                      <FileText className="w-4 h-4 text-slate-300" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-200 truncate" title={name}>
                        {name}
                      </p>
                      <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                        {count} {count === 1 ? 'chunk' : 'chunks'} stored
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(name)}
                    disabled={isDeleting}
                    title={`Delete ${name}`}
                    className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                  >
                    <Trash2 className={`w-4 h-4 ${isDeleting ? 'animate-pulse' : ''}`} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Total Documents: {documents.length}</span>
          <span>
            Total Chunks:{' '}
            {documents.reduce((acc, d) => acc + (d.chunkCount ?? d.chunkcount ?? 0), 0)}
          </span>
        </div>
      </div>
    </div>
  );
};