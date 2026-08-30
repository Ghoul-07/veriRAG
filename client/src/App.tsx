import { useState } from 'react';
import { DocumentUpload } from './components/DocumentUpload';
import { ChatInterface } from './components/ChatInterface';
import { DocumentDrawer } from './components/DocumentDrawer';
import { Shield } from 'lucide-react';

export default function App() {
  const [recentUpload, setRecentUpload] = useState<{ filename: string; count: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0)

  // Trigger when a new upload succeeds
  

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-3xl">
        {/* Header */}
        <header className="flex items-center justify-between pb-6 mb-6 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-600/20 border border-indigo-500/30 rounded-xl">
              <Shield className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">VeriRAG Control Plane</h1>
              <p className="text-xs text-slate-400">Grounded Hybrid RAG & Automated Judge Gate</p>
            </div>
          </div>
          {recentUpload && (
            <span className="text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded-full">
              Synced: {recentUpload.filename} ({recentUpload.count} chunks)
            </span>
          )}

          {/* Open Drawer Button */}
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
        >
          <span>Manage Documents</span>
        </button>
        </header>

        {/* Upload Box */}
        <DocumentUpload onUploadSuccess={(filename, count) => setRecentUpload({ filename, count })} />

        {/* Chat Interface */}
        <ChatInterface />

        {/* Document Management Drawer */}
        <DocumentDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          refreshTrigger={refreshCount}
        />
      </div>
    </div>
  );
}