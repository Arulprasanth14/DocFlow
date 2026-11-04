/**
 * DocFlow — Template Studio entry (/documents/templates/new)
 * Spec §8.5 FR-5.1: two large choices. "Create from scratch" creates the draft
 * immediately and opens the editor. "Import an existing document" goes to the
 * conversion pipeline (FR-9), which converts the file server-side and asks the
 * author to confirm the blanks it found.
 */
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PenLine, FileUp, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EditorSkeleton } from '@/components/ui/EditorSkeleton';
import { useStartScratchTemplate } from '@/hooks/useStartDraft';
import { preloadOn, preloadTemplateEditor } from '@/lib/preload';

export default function TemplateStudioEntryPage() {
  const navigate = useNavigate();
  // B: the POST and the editor chunk used to happen one after the other
  // behind a "Creating…" label. Now the frame goes up first and both run
  // behind it; hovering the card starts the chunk earlier still.
  const scratch = useStartScratchTemplate();
  const error = scratch.error;

  if (scratch.starting) return <EditorSkeleton label="Opening the template editor" />;

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 900, margin: '0 auto' }}>
      <button onClick={() => navigate('/documents/new')} className="btn btn-ghost btn-sm" style={{ marginBottom: 12, paddingLeft: 0 }}>← Back</button>
      <PageHeader
        breadcrumbs={[{ label: 'Documents' }, { label: 'Templates' }, { label: 'New' }]}
        title="Create your own template"
        description="Turn a document you use often into a reusable, fillable template that is private to you."
      />
      <div style={{ height: 24 }} />

      {error && (
        <div role="alert" style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 'var(--radius)',
          background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
          fontSize: '0.85rem', fontWeight: 600,
        }}>{error}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
        <motion.button
          whileHover={{ y: -2 }}
          onClick={scratch.start}
          {...preloadOn(preloadTemplateEditor)}
          className="glass-interactive"
          style={{
            textAlign: 'left', padding: 24, minHeight: 200, borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font-sans)',
          }}>
          <span style={{
            width: 48, height: 48, borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', background: 'color-mix(in srgb, var(--primary) 12%, transparent)', color: 'var(--primary)',
          }}><PenLine size={22} /></span>
          <span style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--foreground)' }}>
            Create from scratch
          </span>
          <span style={{ fontSize: '0.86rem', color: 'var(--muted-foreground)', lineHeight: 1.5, flex: 1 }}>
            Write the document in a Word-like editor and mark the blanks yourself.
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.84rem', fontWeight: 700, color: 'var(--primary)' }}>
            Start writing <ArrowRight size={15} />
          </span>
        </motion.button>

        <motion.button
          whileHover={{ y: -2 }}
          onClick={() => navigate('/documents/templates/import')}
          {...preloadOn(() => import('@/pages/templates/ImportTemplatePage'))}
          className="glass-interactive"
          style={{
            textAlign: 'left', padding: 24, minHeight: 200, borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font-sans)',
          }}>
          <span style={{
            width: 48, height: 48, borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', background: 'color-mix(in srgb, var(--accent-violet) 12%, transparent)',
            color: 'var(--accent-violet)',
          }}><FileUp size={22} /></span>
          <span style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--foreground)' }}>Import an existing document</span>
          <span style={{ fontSize: '0.86rem', color: 'var(--muted-foreground)', lineHeight: 1.5, flex: 1 }}>
            Upload a Word or PDF file and we&apos;ll find the blanks for you to
            confirm. Word keeps headings, lists and tables.
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.84rem', fontWeight: 700, color: 'var(--accent-violet)' }}>
            Upload a file <ArrowRight size={15} />
          </span>
        </motion.button>
      </div>
    </div>
  );
}
