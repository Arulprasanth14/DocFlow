/**
 * DocFlow — /documents/new/from-template/:templateId (spec §7.1 route map)
 *
 * FR-12.1: "Use template" opens the wizard; the draft is created on the
 * **first answer**. Opening a template and walking away must leave nothing
 * behind — previously this page created a draft on mount, so browsing three
 * templates left three empty documents for the purge job to clean up.
 *
 * So the questions are read from the template's published version
 * (`GET /templates/:id/fill-schema`), the wizard renders against a stand-in
 * document with no id, and the first answer is what writes the row. From that
 * moment the author is on the ordinary `/documents/:id/fill` route with the
 * ordinary autosave, and nothing downstream knows the difference.
 *
 * The created document and its schema are written into the query cache before
 * navigating, so the hand-off renders immediately instead of flashing a
 * spinner for a document we are already holding.
 */
import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { useCreateDocument, useDocumentTypes, useTemplateFillSchema } from '@/hooks/useDocuments';
import { useTemplate } from '@/hooks/useTemplates';
import { documentsApi } from '@/lib/api/documents';
// Lazy, not static. FormFillPage is a lazy route in App.tsx; importing it
// statically here collapsed it into this page's chunk and the bundler said so
// ("dynamic import will not move module into another chunk"). The fill surface
// is only reached once an author actually opens a template.
const FillSurface = lazy(() =>
  import('@/pages/documents/FormFillPage').then((m) => ({ default: m.FillSurface })),
);
import type { Document } from '@/types';

export default function StartFromTemplatePage() {
  const { templateId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: docTypes = [], isLoading: typesLoading } = useDocumentTypes(true);
  const { data: template, isLoading: templateLoading, isError } = useTemplate(templateId);
  const { data: schema, isLoading: schemaLoading, isError: schemaError } =
    useTemplateFillSchema(templateId);
  const createDoc = useCreateDocument();

  const [error, setError] = useState('');
  /** Guards against two answers racing each other into two draft rows. */
  const creatingRef = useRef(false);

  const blankType = docTypes.find((dt) => !dt.form_schema || dt.form_schema.length === 0) || null;
  const loading = typesLoading || templateLoading || schemaLoading;

  const createFromAnswers = useCallback(async (answers: Record<string, unknown>) => {
    if (!template) throw new Error('Template not loaded');
    if (!blankType) {
      const message = 'No general-purpose document type exists yet. Ask an admin to add one.';
      setError(message);
      throw new Error(message);
    }
    // An autosave and a Continue can both land in the same tick. Only the
    // first may create; the second would otherwise produce a duplicate draft.
    if (creatingRef.current) throw new Error('Already creating');
    creatingRef.current = true;

    try {
      const doc = await createDoc.mutateAsync({
        doc_type_id: blankType.id,
        title: template.name,
        priority: 'normal', tags: [], form_data: {}, metadata: {},
        submit_immediately: false, source: 'template', template_id: template.id,
      });

      // The answers typed before the row existed are saved as part of the
      // hand-off, not left for the next autosave to notice.
      try {
        await documentsApi.saveContent(doc.id, { answers });
      } catch {
        // The draft exists either way; the next autosave on the real route
        // will carry the answers. Losing the row would be the real failure.
      }

      // Seed the cache so the next route paints from what we already have.
      // Keys copied from documentKeys.detail and useDocumentFillSchema — a
      // mismatch here is invisible, it just costs a spinner.
      qc.setQueryData(['documents', 'detail', doc.id], doc);
      if (schema) {
        qc.setQueryData(['documents', doc.id, 'fill-schema'], {
          ...schema,
          document_id: doc.id,
          answers,
        });
      }

      navigate(`/documents/${doc.id}/fill`, { replace: true });
      return doc.id;
    } catch (err) {
      creatingRef.current = false;
      if (err instanceof Error && err.message === 'Already creating') throw err;
      setError(err instanceof Error ? err.message : 'Could not start a document from this template.');
      throw err;
    }
  }, [template, blankType, createDoc, qc, schema, navigate]);

  if (isError || schemaError) {
    return (
      <Centered>
        <p style={{ fontWeight: 700, color: 'var(--foreground)' }}>This template isn&rsquo;t available</p>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: 18 }}>
          It may have been deleted, archived, never published, or it isn&rsquo;t shared with you.
        </p>
        <button className="btn btn-primary" onClick={() => navigate('/documents/new')}>Browse templates</button>
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <span style={{
          width: 48, height: 48, borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
          marginBottom: 12,
        }}><AlertTriangle size={22} /></span>
        <p role="alert" style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--status-rejected)' }}>{error}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { setError(''); creatingRef.current = false; }}>
            <RotateCw size={13} /> Try again
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/documents/new')}>Back to hub</button>
        </div>
      </Centered>
    );
  }

  if (loading || !template || !schema) {
    return (
      <Centered>
        <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto 14px' }} />
        <p style={{ fontSize: '0.9rem', color: 'var(--muted-foreground)' }}>
          {template ? `Opening “${template.name}”…` : 'Opening the template…'}
        </p>
      </Centered>
    );
  }

  // A template with no questions has nothing to fill in, so it behaves as it
  // always did: create the draft and send the author to the freeform editor.
  if (schema.fields.length === 0) {
    return <NoQuestions templateName={template.name} onStart={createFromAnswers} />;
  }

  // The stand-in: a draft-shaped object with no id. `FillSurface` treats an
  // empty id as "not saved yet" and routes its first save through `onCreate`.
  const pendingDoc = {
    id: '',
    public_id: '',
    title: template.name,
    status: 'draft',
    priority: 'normal',
    source: 'template',
    tags: [],
  } as unknown as Document;

  return (
    <Suspense fallback={
      <Centered>
        <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto 14px' }} />
        <p style={{ fontSize: '0.9rem', color: 'var(--muted-foreground)' }}>Opening the questions&hellip;</p>
      </Centered>
    }>
      <FillSurface doc={pendingDoc} schema={schema} onCreate={createFromAnswers} />
    </Suspense>
  );
}

function NoQuestions({ templateName, onStart }: {
  templateName: string;
  onStart: (answers: Record<string, unknown>) => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Centered>
      <p style={{ fontWeight: 700, color: 'var(--foreground)' }}>
        &ldquo;{templateName}&rdquo; has no questions
      </p>
      <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: 18 }}>
        Nothing to fill in &mdash; it opens straight in the editor.
      </p>
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={() => { setBusy(true); void onStart({}).catch(() => setBusy(false)); }}
      >
        {busy ? 'Opening…' : 'Open in the editor'}
      </button>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-content" style={{ paddingTop: 72, maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
      {children}
    </div>
  );
}
