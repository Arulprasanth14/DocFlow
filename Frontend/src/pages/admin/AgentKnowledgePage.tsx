/**
 * DocFlow Frontend — Admin: Agent Legal Documents (§13.6)
 *
 * Main Administrator only — routed behind requireRole={['admin']} in
 * App.tsx, and the backend enforces the same rule independently (HR is
 * excluded by default per §2.5).
 *
 * Shows, per §12.2/13.6: processing state, extraction errors, index status,
 * source metadata, and the date/version of the last successful indexing —
 * plus a re-embedding path when the embedding model changes.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Upload, FileText, AlertCircle, CheckCircle2, Archive, RefreshCw,
  Loader2, Info, ShieldAlert,
} from 'lucide-react';
import { agentApi, type KnowledgeSource } from '@/lib/api/agent';

const C = {
  card: 'var(--bg-elevated)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  disabled: 'var(--text-disabled)',
};

const STATUS_STYLE: Record<KnowledgeSource['status'], { label: string; color: string }> = {
  pending: { label: 'Pending', color: C.muted },
  extracting: { label: 'Extracting text', color: C.warning },
  chunking: { label: 'Chunking', color: C.warning },
  embedding: { label: 'Embedding', color: C.warning },
  ready: { label: 'Indexed', color: C.success },
  failed: { label: 'Failed', color: C.danger },
  archived: { label: 'Archived', color: C.disabled },
  needs_reembedding: { label: 'Needs re-embedding', color: C.warning },
};

function fmtBytes(n: number | null) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function AgentKnowledgePage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [replaces, setReplaces] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['agent', 'knowledge'],
    queryFn: () => agentApi.listKnowledge(true),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['agent', 'knowledge'] });
    queryClient.invalidateQueries({ queryKey: ['agent', 'status'] });
  };

  const uploadM = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file as File);
      form.append('title', title.trim());
      if (category.trim()) form.append('category', category.trim());
      if (versionLabel.trim()) form.append('version_label', versionLabel.trim());
      if (replaces) form.append('replaces_source_id', replaces);
      return agentApi.uploadKnowledge(form);
    },
    onSuccess: () => {
      setFile(null);
      setTitle('');
      setCategory('');
      setVersionLabel('');
      setReplaces('');
      setFormError(null);
      invalidate();
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const reembedM = useMutation({
    mutationFn: (id: string) => agentApi.reembedKnowledge(id),
    onSuccess: invalidate,
  });

  const archiveM = useMutation({
    mutationFn: (id: string) => agentApi.archiveKnowledge(id, 'Archived by administrator'),
    onSuccess: invalidate,
  });

  const sources = data?.items ?? [];
  const health = data?.index_health;
  const activeSources = sources.filter((s) => !s.archived_at);

  const submit = () => {
    if (!file) return setFormError('Choose a file to upload.');
    if (!title.trim()) return setFormError('Give the document a title.');
    setFormError(null);
    uploadM.mutate();
  };

  return (
    <div style={{ padding: 32, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 26 }}>
        <h1 data-page-title className="font-display" style={{ fontSize: 'clamp(1.75rem, 1.2rem + 2vw, 2.4rem)', fontWeight: 400, lineHeight: 1.1, color: C.heading, marginBottom: 6 }}>
          Agent Legal Documents
        </h1>
        <p style={{ fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
          Documents uploaded here become the Agent's knowledge base. This is
          separate from the Documents module — these are trusted reference
          sources, not documents routed for approval.
        </p>
      </div>

      {/* Index health */}
      {health && (
        <div
          style={{
            background: health.configured
              ? health.needs_reembedding
                ? `color-mix(in srgb, ${C.warning} 8%, transparent)`
                : C.card
              : `color-mix(in srgb, ${C.danger} 8%, transparent)`,
            border: `1px solid ${
              health.configured
                ? health.needs_reembedding
                  ? `color-mix(in srgb, ${C.warning} 28%, transparent)`
                  : C.border
                : `color-mix(in srgb, ${C.danger} 28%, transparent)`
            }`,
            borderRadius: 12, padding: '14px 16px', marginBottom: 22,
          }}
        >
          {!health.configured ? (
            <div style={{ display: 'flex', gap: 9 }}>
              <ShieldAlert size={16} color={C.danger} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: C.heading }}>
                  Embeddings are not configured
                </div>
                <div style={{ fontSize: 12.5, color: C.body, marginTop: 3 }}>
                  {health.reason ||
                    'Set the AI provider API key in Backend/.env to enable indexing.'}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 5 }}>
                  You can still upload documents — their text is extracted and
                  chunked, and you can index them later with “Re-embed”.
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 9 }}>
              {health.needs_reembedding ? (
                <Info size={16} color={C.warning} style={{ flexShrink: 0, marginTop: 1 }} />
              ) : (
                <CheckCircle2 size={16} color={C.success} style={{ flexShrink: 0, marginTop: 1 }} />
              )}
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: C.heading }}>
                  Index: {health.compatible_chunks ?? 0} passage
                  {health.compatible_chunks === 1 ? '' : 's'} searchable
                </div>
                <div style={{ fontSize: 12.5, color: C.body, marginTop: 3 }}>
                  Embedding model <strong>{health.current_model}</strong> (
                  {health.current_dim} dimensions)
                </div>
                {health.needs_reembedding && (
                  <div style={{ fontSize: 12.5, color: C.warning, marginTop: 5 }}>
                    Some passages were embedded with a different model and can't be
                    compared against the current one. Re-embed the affected
                    documents below to make them searchable again.
                    {(health.incompatible_groups ?? []).map((g) => (
                      <div key={`${g.model}-${g.dim}`} style={{ color: C.muted, marginTop: 2 }}>
                        · {g.chunks} passage{g.chunks === 1 ? '' : 's'} from{' '}
                        {g.model ?? 'unknown model'} ({g.dim ?? '?'} dims)
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Upload */}
      <div
        style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 14, padding: 20, marginBottom: 26,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: C.heading, marginBottom: 14 }}>
          Upload a document
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              File (PDF, .docx, .md, .txt)
            </span>
            <input
              type="file"
              accept=".pdf,.docx,.doc,.md,.txt,.csv,.rtf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 12.5, color: C.body, width: '100%' }}
            />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Title *
            </span>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Employee Handbook"
            />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Category
            </span>
            <input
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. HR policy"
            />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Version
            </span>
            <input
              className="input"
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              placeholder="e.g. v2.1"
            />
          </label>

          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Replaces (archives the old one)
            </span>
            <select
              className="input"
              value={replaces}
              onChange={(e) => setReplaces(e.target.value)}
            >
              <option value="">— nothing —</option>
              {activeSources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                  {s.version_label ? ` (${s.version_label})` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        {formError && (
          <div
            style={{
              marginTop: 12, fontSize: 12.5, color: C.danger,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <AlertCircle size={13} /> {formError}
          </div>
        )}

        <button
          onClick={submit}
          disabled={uploadM.isPending}
          className="btn btn-primary btn-sm"
          style={{ marginTop: 14, gap: 7 }}
        >
          {uploadM.isPending ? <Loader2 size={14} className="kspin" /> : <Upload size={14} />}
          {uploadM.isPending ? 'Processing…' : 'Upload & index'}
        </button>
      </div>

      {/* Sources */}
      <div style={{ fontSize: 14, fontWeight: 700, color: C.heading, marginBottom: 12 }}>
        Knowledge sources {sources.length ? `(${sources.length})` : ''}
      </div>

      {isLoading ? (
        <div style={{ padding: 30, textAlign: 'center' }}>
          <Loader2 size={20} color={C.muted} className="kspin" />
        </div>
      ) : isError ? (
        <div style={{ fontSize: 13, color: C.danger }}>
          {(error as Error)?.message || 'Could not load knowledge sources.'}
        </div>
      ) : sources.length === 0 ? (
        <div
          style={{
            background: C.card, border: `1px dashed ${C.border}`,
            borderRadius: 12, padding: 30, textAlign: 'center',
          }}
        >
          <FileText size={26} color={C.disabled} style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 13.5, color: C.body }}>
            No documents yet. Upload a policy or legal document above to give the
            Agent something to answer from.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sources.map((s) => {
            const st = STATUS_STYLE[s.status];
            return (
              <div
                key={s.id}
                style={{
                  background: C.card, border: `1px solid ${C.border}`,
                  borderRadius: 12, padding: '14px 16px',
                  opacity: s.archived_at ? 0.65 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: C.heading }}>
                        {s.title}
                      </span>
                      <span
                        style={{
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: 0.5, color: st.color,
                          background: `color-mix(in srgb, ${st.color} 12%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${st.color} 28%, transparent)`,
                          borderRadius: 20, padding: '2px 8px',
                        }}
                      >
                        {st.label}
                      </span>
                    </div>

                    <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.7 }}>
                      {[
                        s.category,
                        s.version_label && `version ${s.version_label}`,
                        s.filename,
                        fmtBytes(s.size_bytes),
                        `${s.chunk_count} passage${s.chunk_count === 1 ? '' : 's'}`,
                        s.extracted_chars ? `${s.extracted_chars.toLocaleString()} chars` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div style={{ fontSize: 11.5, color: C.muted }}>
                      Last indexed: {fmtDate(s.indexed_at)}
                      {s.embedding_model ? ` · ${s.embedding_model} (${s.embedding_dim}d)` : ''}
                    </div>

                    {s.extraction_error && (
                      <div
                        style={{
                          marginTop: 8, fontSize: 12, color: C.danger,
                          display: 'flex', gap: 6, alignItems: 'flex-start',
                        }}
                      >
                        <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>{s.extraction_error}</span>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                    {!s.archived_at && (
                      <>
                        <button
                          onClick={() => reembedM.mutate(s.id)}
                          disabled={reembedM.isPending}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 12, gap: 6 }}
                          title="Re-extract chunks and embed with the current model"
                        >
                          <RefreshCw size={12} /> Re-embed
                        </button>
                        <button
                          onClick={() => archiveM.mutate(s.id)}
                          disabled={archiveM.isPending}
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: 12, gap: 6, color: C.warning }}
                          title="Stop the Agent using this document"
                        >
                          <Archive size={12} /> Archive
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .kspin { animation: kspin 0.9s linear infinite; }
        @keyframes kspin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
