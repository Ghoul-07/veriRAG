import React, { useState, useRef, useEffect } from 'react';
import { ActionModal } from './ActionModal';
import ReactMarkdown from 'react-markdown';
import { Send, ShieldCheck, ShieldAlert, Loader2, Database } from 'lucide-react';

interface Source {
  id: string;
  document?: string;
  documentName?: string;
  score?: number | string;
}

interface Verification {
  isFaithful?: boolean;
  isGrounded?: boolean;
  confidenceScore: number;
  unsupportedClaims?: string[];
  reasoning: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  sources?: Source[];
  verification?: Verification;
}

export const ChatInterface: React.FC = () => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: 'Hello! I am **VeriRAG**. I provide answers grounded strictly in your indexed documents, verified in real-time by an automated Judge Gate.',
    },
  ]);

  const [modalData, setModalData] = useState<any>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const query = input.trim();
    if (!query || loading) return;

    setInput('');
    setLoading(true);

    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

    try {
      // 1. Check for Action queries (e.g. GitHub issue drafting)
      const isActionQuery = /^(create|open|file|submit|report|draft)\b/i.test(query);

      if (isActionQuery) {
        setMessages((prev) => [...prev, { role: 'user', content: query }]);

        const draftRes = await fetch(`${BACKEND_URL}/api/v1/action/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });

        if (draftRes.ok) {
          const draftData = await draftRes.json();
          if (draftData.isAction) {
            setModalData(draftData);
            setIsModalOpen(true);
            setLoading(false);
            return;
          }
        }
      }

      // 2. Standard Query Flow with Token Streaming via SSE

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: query },
        {
          role: 'assistant',
          content: '',
          isStreaming: true,
          sources: [],
        },
      ]);

      const conversationHistory = messages.
        slice(1).     // skip initial welcome prompt
        filter((m) => m.content && !m.content.startsWith('⚠️')).
        slice(-4).
        map((m) => ({role:m.role, content: m.content}))

      const encodedHistory = encodeURIComponent(JSON.stringify(conversationHistory))
      const response = await fetch(
        `${BACKEND_URL}/api/v1/query/stream?prompt=${encodeURIComponent(query)}&history=${encodedHistory}`
      );

      if (!response.ok || !response.body) {
        throw new Error(`Streaming failed with status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let streamBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const events = streamBuffer.split('\n\n');
        streamBuffer = events.pop() || '';

        for (const rawEvent of events) {
          if (!rawEvent.trim()) continue;

          const eventMatch = rawEvent.match(/^event:\s*(.*)$/m);
          const dataMatch = rawEvent.match(/^data:\s*(.*)$/m);

          const eventType = eventMatch ? eventMatch[1].trim() : 'message';
          const payload = dataMatch ? JSON.parse(dataMatch[1].trim()) : null;

          if (eventType === 'token' && payload?.token) {
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  content: updated[lastIdx].content + payload.token,
                };
              }
              return updated;
            });
          } else if (eventType === 'done' && payload) {
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  isStreaming: false,
                  sources: payload.sources || [],
                  verification: payload.judgeVerdict
                    ? {
                        isFaithful: payload.judgeVerdict.isGrounded ?? payload.judgeVerdict.isFaithful,
                        confidenceScore: payload.judgeVerdict.confidenceScore ?? 0,
                        unsupportedClaims: payload.judgeVerdict.unsupportedClaims || [],
                        reasoning: payload.judgeVerdict.reasoning || '',
                      }
                    : undefined,
                };
              }
              return updated;
            });
          } else if (eventType === 'error') {
            console.error('SSE Error:', payload?.message);
          }
        }
      }
    } catch (err: any) {
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === 'assistant' && updated[lastIdx].isStreaming) {
          updated[lastIdx] = {
            role: 'assistant',
            content: `⚠️ **Error:** ${err.message || 'Unable to connect to the backend stream.'}`,
            isStreaming: false,
          };
          return updated;
        }
        return [
          ...prev,
          {
            role: 'assistant',
            content: `⚠️ **Error:** ${err.message || 'Unable to connect to the backend stream.'}`,
          },
        ];
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[580px] bg-slate-900/80 border border-slate-800 rounded-2xl shadow-2xl backdrop-blur-md overflow-hidden">
      {/* Scrollable Message List */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-5 py-4 text-sm shadow-md transition-all ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-none'
                  : 'bg-slate-800/90 text-slate-200 border border-slate-700/60 rounded-bl-none'
              }`}
            >
              {/* Message Content with Streaming Indicator */}
              <div className="leading-relaxed space-y-2 text-[14px]">
                {msg.content ? (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                ) : (
                  msg.isStreaming && (
                    <span className="inline-flex items-center gap-1.5 text-indigo-400 text-xs py-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Retrieving context & generating response...
                    </span>
                  )
                )}
                {msg.isStreaming && msg.content && (
                  <span className="inline-block w-1.5 h-4 ml-1 bg-indigo-400 animate-pulse align-middle" />
                )}
              </div>

              {/* Judge Gate Verification Banner */}
              {!msg.isStreaming && msg.verification && (
                <div
                  className={`mt-3.5 pt-3 border-t text-xs rounded-lg p-3 ${
                    msg.verification.isFaithful
                      ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'
                      : 'bg-rose-950/30 border-rose-800/50 text-rose-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    {msg.verification.isFaithful ? (
                      <>
                        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Judge Verified Grounded ({Math.round(msg.verification.confidenceScore * 100)}% Confidence)</span>
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>Judge Flagged Hallucination / Low Confidence</span>
                      </>
                    )}
                  </div>
                  <p className="text-slate-400 text-[11px] mt-1.5 leading-snug">
                    {msg.verification.reasoning}
                  </p>
                </div>
              )}

              {/* Source Reference Badges */}
              {!msg.isStreaming && msg.sources && msg.sources.length > 0 && (
                <div className="mt-3 pt-2.5 border-t border-slate-700/50 flex flex-wrap gap-1.5 items-center">
                  <span className="text-[10px] tracking-wider uppercase font-semibold text-slate-400 flex items-center gap-1">
                    <Database className="w-3 h-3 text-indigo-400" /> Sources:
                  </span>
                  {msg.sources.map((s, sIdx) => {
                    const docLabel = s.documentName || s.document || s.id;
                    const scoreLabel = typeof s.score === 'number' ? s.score.toFixed(3) : s.score;
                    return (
                      <span
                        key={sIdx}
                        className="text-[10px] bg-slate-900/90 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-md font-mono"
                      >
                        {docLabel} {scoreLabel ? `(${scoreLabel})` : ''}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Field */}
      <form onSubmit={handleSend} className="p-3 bg-slate-950/70 border-t border-slate-800 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question against your indexed documents..."
          className="flex-1 bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-colors shadow-sm"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </form>

      {modalData && (
        <ActionModal
          isOpen={isModalOpen}
          status={modalData.status}
          draft={modalData.draft}
          verification={modalData.verification}
          onClose={() => setIsModalOpen(false)}
          onExecuted={(url) => {
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: `✅ **Action Dispatched:** Created GitHub issue successfully: [${url}](${url})`,
              },
            ]);
          }}
        />
      )}
    </div>
  );
};