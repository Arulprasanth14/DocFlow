/**
 * DocFlow Frontend — AI Agent page (§12.5)
 *
 * A conversational interface over the organization's own approved knowledge.
 * Every answer shows its source citations so the user can verify the
 * underlying policy text, and an answer the evidence doesn't support is
 * labelled rather than presented as fact.
 *
 * All data comes from /api/v1/agent/*. There is no mock content here: when
 * the Agent isn't configured, or the org has no indexed documents, the page
 * says so explicitly instead of showing placeholder answers.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot, Send, AlertCircle, FileText, ThumbsUp, ThumbsDown,
  Plus, Loader2, ShieldAlert, Info, ChevronDown, ChevronRight,
} from 'lucide-react';
import { agentApi, type AgentCitation, type AnswerState } from '@/lib/api/agent';
import { IconChip } from '@/components/ui/IconChip';

const C = {
  card: 'var(--bg-elevated)',
  surface: 'var(--bg-surface)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)',
  primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  disabled: 'var(--text-disabled)',
};

const STATE_LABEL: Record<AnswerState, { label: string; color: string; icon: React.ElementType }> = {
  grounded: { label: 'Answered from your documents', color: C.success, icon: FileText },
  insufficient_evidence: { label: 'Not established by your documents', color: C.warning, icon: Info },
  clarification_needed: { label: 'Needs clarification', color: C.warning, icon: Info },
  not_configured: { label: 'Agent not configured', color: C.danger, icon: ShieldAlert },
  error: { label: 'Provider error', color: C.danger, icon: AlertCircle },
};

function Citations({ citations }: { citations: AgentCitation[] }) {
  const [open, setOpen] = useState(false);
  if (!citations.length) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none',
          border: 'none', cursor: 'pointer', color: C.primary400,
          fontSize: 12, fontWeight: 700, padding: 0,
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {citations.length} source{citations.length === 1 ? '' : 's'}
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {citations.map((c) => (
            <div
              key={c.chunk_id}
              style={{
                background: C.overlay, border: `1px solid ${C.borderSubtle}`,
                borderRadius: 10, padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: 10, fontWeight: 800, color: C.primary400,
                    background: `color-mix(in srgb, ${C.primary400} 14%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${C.primary400} 30%, transparent)`,
                    borderRadius: 5, padding: '1px 5px', flexShrink: 0,
                  }}
                >
                  [{c.number}]
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.heading }}>
                  {c.source_title}
                </span>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                {[
                  c.version_label && `version ${c.version_label}`,
                  c.section_label,
                  c.page_number != null && `page ${c.page_number}`,
                  `similarity ${(c.similarity * 100).toFixed(0)}%`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div style={{ fontSize: 12, color: C.body, lineHeight: 1.55, fontStyle: 'italic' }}>
                “{c.excerpt}”
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentPage() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['agent', 'status'],
    queryFn: () => agentApi.getStatus(),
    staleTime: 60_000,
  });

  const { data: conversations } = useQuery({
    queryKey: ['agent', 'conversations'],
    queryFn: () => agentApi.listConversations(),
    staleTime: 30_000,
  });

  const { data: conversation, isFetching: convFetching } = useQuery({
    queryKey: ['agent', 'conversation', conversationId],
    queryFn: () => agentApi.getConversation(conversationId as string),
    enabled: !!conversationId,
  });

  const askM = useMutation({
    mutationFn: (q: string) => agentApi.ask(q, conversationId ?? undefined),
    onSuccess: (answer) => {
      setConversationId(answer.conversation_id);
      queryClient.invalidateQueries({ queryKey: ['agent', 'conversation', answer.conversation_id] });
      queryClient.invalidateQueries({ queryKey: ['agent', 'conversations'] });
    },
  });

  const feedbackM = useMutation({
    mutationFn: ({ id, vote }: { id: string; vote: 'up' | 'down' }) =>
      agentApi.sendFeedback(id, vote),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['agent', 'conversation', conversationId] }),
  });

  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, askM.isPending]);

  const submit = () => {
    const q = input.trim();
    if (!q || askM.isPending) return;
    setInput('');
    askM.mutate(q);
  };

  const disabled = !statusLoading && status && !status.enabled;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 140px)' }}>
      {/* Conversation list */}
      <aside
        style={{
          width: 240, borderRight: `1px solid ${C.borderSubtle}`,
          padding: '20px 14px', flexShrink: 0, overflowY: 'auto',
        }}
      >
        <button
          onClick={() => setConversationId(null)}
          className="btn btn-ghost btn-sm"
          style={{
            width: '100%', justifyContent: 'flex-start', gap: 8,
            marginBottom: 14, fontSize: 13,
          }}
        >
          <Plus size={14} /> New conversation
        </button>

        <div
          style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
            textTransform: 'uppercase', color: C.muted, marginBottom: 8,
          }}
        >
          Recent
        </div>
        {(conversations ?? []).length === 0 ? (
          <div style={{ fontSize: 12, color: C.disabled }}>No conversations yet</div>
        ) : (
          (conversations ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => setConversationId(c.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: c.id === conversationId ? C.overlay : 'none',
                border: `1px solid ${c.id === conversationId ? C.border : 'transparent'}`,
                borderRadius: 8, padding: '8px 10px', marginBottom: 4,
                color: c.id === conversationId ? C.heading : C.body,
                fontSize: 12.5, cursor: 'pointer',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {c.title || 'Untitled'}
            </button>
          ))
        )}
      </aside>

      {/* Chat */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '20px 24px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IconChip tone="violet" size={38}><Bot size={18} /></IconChip>
            <div>
              <h1 className="font-heading" style={{ fontSize: 20, fontWeight: 800, color: 'var(--foreground)', margin: 0, letterSpacing: '-0.01em' }}>
                Agent <span style={{ fontSize: 10, fontWeight: 700, verticalAlign: 'middle', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent-violet)', background: 'var(--accent-violet-soft)', border: '1px solid color-mix(in srgb, var(--accent-violet) 30%, transparent)', borderRadius: 999, padding: '2px 8px', marginLeft: 6 }}>AI</span>
              </h1>
              <p style={{ fontSize: 12, color: 'var(--muted-foreground)', margin: 0 }}>
                Answers from your organization's approved documents, with sources
              </p>
            </div>
          </div>

          {disabled && (
            <div
              style={{
                marginTop: 14, padding: '12px 14px', borderRadius: 10,
                background: `color-mix(in srgb, ${C.danger} 8%, transparent)`,
                border: `1px solid color-mix(in srgb, ${C.danger} 25%, transparent)`,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <ShieldAlert size={15} color={C.danger} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.heading }}>
                    The Agent isn't configured on this server
                  </div>
                  {(status?.notes ?? []).map((n) => (
                    <div key={n} style={{ fontSize: 12, color: C.body, marginTop: 3 }}>
                      {n}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 24px 20px' }}>
          {!conversationId && !askM.isPending && (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: C.muted }}>
              <Bot size={32} color={C.disabled} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 15, fontWeight: 600, color: C.heading, marginBottom: 6 }}>
                Ask about your organization
              </div>
              <div style={{ fontSize: 13, maxWidth: 420, margin: '0 auto', lineHeight: 1.6 }}>
                Questions are answered only from the documents an administrator
                has uploaded for the Agent — and every answer cites them.
              </div>
            </div>
          )}

          {convFetching && !messages.length && (
            <div style={{ textAlign: 'center', padding: 30 }}>
              <Loader2 size={20} color={C.muted} className="spin" />
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 780 }}>
            {messages.map((m) => {
              const isUser = m.role === 'user';
              const state = m.answer_state ? STATE_LABEL[m.answer_state] : null;
              const StateIcon = state?.icon;
              return (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div
                    style={{
                      alignSelf: isUser ? 'flex-end' : 'flex-start',
                      maxWidth: isUser ? '80%' : '100%',
                      background: isUser ? `color-mix(in srgb, ${C.primary} 14%, transparent)` : C.card,
                      border: `1px solid ${isUser ? `color-mix(in srgb, ${C.primary} 28%, transparent)` : C.border}`,
                      borderRadius: 14, padding: '12px 14px',
                    }}
                  >
                    {!isUser && state && StateIcon && (
                      <div
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: 0.5, color: state.color, marginBottom: 7,
                        }}
                      >
                        <StateIcon size={11} /> {state.label}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 13.5, color: C.heading, lineHeight: 1.65,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {m.content}
                    </div>
                    {!isUser && <Citations citations={m.citations} />}

                    {!isUser && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        {(['up', 'down'] as const).map((vote) => (
                          <button
                            key={vote}
                            onClick={() => feedbackM.mutate({ id: m.id, vote })}
                            title={vote === 'up' ? 'Helpful' : 'Not helpful'}
                            style={{
                              background: m.feedback === vote ? C.overlay : 'none',
                              border: `1px solid ${m.feedback === vote ? C.border : 'transparent'}`,
                              borderRadius: 6, padding: '3px 6px', cursor: 'pointer',
                              color: m.feedback === vote ? C.primary400 : C.disabled,
                              display: 'flex',
                            }}
                          >
                            {vote === 'up' ? <ThumbsUp size={12} /> : <ThumbsDown size={12} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {askM.isPending && (
              <div
                style={{
                  alignSelf: 'flex-start', background: C.card,
                  border: `1px solid ${C.border}`, borderRadius: 14,
                  padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                <Loader2 size={14} color={C.primary400} className="spin" />
                <span style={{ fontSize: 13, color: C.muted }}>
                  Searching your documents…
                </span>
              </div>
            )}

            {askM.isError && (
              <div
                style={{
                  background: `color-mix(in srgb, ${C.danger} 8%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${C.danger} 25%, transparent)`,
                  borderRadius: 12, padding: '10px 12px', display: 'flex', gap: 8,
                }}
              >
                <AlertCircle size={14} color={C.danger} style={{ flexShrink: 0, marginTop: 2 }} />
                <span style={{ fontSize: 12.5, color: C.body }}>
                  {(askM.error as Error)?.message || 'The request failed. Please try again.'}
                </span>
              </div>
            )}
          </div>
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <div style={{ padding: '12px 24px 20px', borderTop: `1px solid ${C.borderSubtle}` }}>
          <div
            style={{
              display: 'flex', alignItems: 'flex-end', gap: 10, background: C.card,
              border: `1.5px solid ${C.border}`, borderRadius: 14, padding: '10px 14px',
              maxWidth: 780,
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder={
                disabled
                  ? 'The Agent is not configured on this server'
                  : 'Ask about a policy, benefit, or process…'
              }
              disabled={!!disabled || askM.isPending}
              style={{
                flex: 1, background: 'none', border: 'none', outline: 'none',
                color: C.heading, fontSize: 13.5, resize: 'none',
                fontFamily: 'var(--font-sans)', maxHeight: 120,
              }}
            />
            <button
              onClick={submit}
              disabled={!input.trim() || !!disabled || askM.isPending}
              className="btn btn-primary btn-sm"
              style={{ flexShrink: 0 }}
            >
              <Send size={14} />
            </button>
          </div>
          {status?.enabled && (
            <div style={{ fontSize: 10.5, color: C.disabled, marginTop: 7, maxWidth: 780 }}>
              {status.provider} · {status.chat_model} · answers are grounded in your
              organization's indexed documents and may be incomplete — verify against
              the cited source before relying on them.
            </div>
          )}
        </div>
      </main>

      <style>{`
        .spin { animation: agentspin 0.9s linear infinite; }
        @keyframes agentspin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
