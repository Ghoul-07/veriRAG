import React, { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

interface DocumentUploadProps {
  onUploadSuccess: (filename: string, count: number) => void;
}

export const DocumentUpload: React.FC<DocumentUploadProps> = ({ onUploadSuccess }) => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (file: File) => {
    if (!file) return;

    setIsUploading(true);
    setError(null);
    setUploadStatus(null);

    const formData = new FormData();
    formData.append('file', file);

    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

    try {
      const response = await fetch(`${BACKEND_URL}/api/v1/upload`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to upload document.');
      }

      setUploadStatus(`Indexed ${data.chunksIndexed} chunks from ${data.filename}`);
      onUploadSuccess(data.filename, data.chunksIndexed);
    } catch (err: any) {
      setError(err.message || 'An error occurred during upload.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-5 mb-6 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-3">
        <Upload className="w-5 h-5 text-indigo-400" />
        <h2 className="text-base font-semibold text-slate-100">Document Knowledge Ingestion</h2>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-slate-600 hover:border-indigo-400 bg-slate-900/40 rounded-lg p-6 text-center cursor-pointer transition-colors"
      >
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept=".txt,.md"
          onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
        />

        {isUploading ? (
          <div className="flex flex-col items-center gap-2 text-indigo-300">
            <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
            <span className="text-sm font-medium">Embedding & indexing chunks into pgvector...</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-slate-400">
            <FileText className="w-7 h-7 text-slate-500 mb-1" />
            <span className="text-sm font-medium text-slate-200">
              Click or drag a document here (.txt, .md)
            </span>
            <span className="text-xs text-slate-500">Auto-chunked, embedded, and synced with PostgreSQL</span>
          </div>
        )}
      </div>

      {uploadStatus && (
        <div className="mt-3 flex items-center gap-2 text-xs font-medium text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 px-3 py-2 rounded-lg">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{uploadStatus}</span>
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-center gap-2 text-xs font-medium text-rose-400 bg-rose-950/40 border border-rose-800/50 px-3 py-2 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};