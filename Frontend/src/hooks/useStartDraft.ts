/**
 * DocFlow — start a blank document or a from-scratch template.
 *
 * Both used to show a waiting screen of their own ("Preparing your blank
 * document…", a "Creating…" button) while a POST and a lazy chunk download
 * happened one after the other. The screen the author asked for is the
 * editor, so these hooks put the editor frame up immediately and do the
 * creation behind it:
 *
 *   - the editor chunk starts downloading in the same tick as the POST, so
 *     the two overlap instead of queueing;
 *   - the caller renders <EditorSkeleton /> as soon as `starting` is true;
 *   - navigation replaces the history entry, so Back goes to the hub rather
 *     than to a screen that would immediately create a second draft.
 *
 * If the types the draft needs have not arrived yet, the click is remembered
 * and runs the moment they do — pressing the card can never do nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useCreateDocument, useDocumentTypes } from '@/hooks/useDocuments';
import { useCreateTemplate } from '@/hooks/useTemplates';
import { preloadDocumentEditor, preloadTemplateEditor } from '@/lib/preload';

export interface StartDraft {
  start: () => void;
  /** True from the click until the editor route takes over, or an error. */
  starting: boolean;
  error: string;
  /** Set when the thing can never work here, so the caller can say why. */
  blocked: string;
}

export function useStartBlankDocument(): StartDraft {
  const navigate = useNavigate();
  const { data: docTypes = [], isLoading } = useDocumentTypes(true);
  const createDoc = useCreateDocument();

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const queued = useRef(false);
  const fired = useRef(false);

  // A type with no custom fields: a blank document must not inherit someone
  // else's schema-driven form.
  const blankType = docTypes.find((dt) => !dt.form_schema || dt.form_schema.length === 0) || null;

  const run = useCallback(async () => {
    if (fired.current || !blankType) return;
    fired.current = true;
    try {
      const doc = await createDoc.mutateAsync({
        doc_type_id: blankType.id,
        title: 'Untitled document',
        priority: 'normal', tags: [], form_data: {}, metadata: {},
        submit_immediately: false, source: 'blank',
      });
      navigate(`/documents/${doc.id}/edit`, { replace: true });
    } catch (err) {
      fired.current = false;
      setStarting(false);
      setError(err instanceof Error ? err.message : 'Could not create a blank document.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blankType, navigate]);

  const start = useCallback(() => {
    setError('');
    setStarting(true);
    void preloadDocumentEditor();      // overlaps the POST below
    if (!blankType) { queued.current = true; return; }
    void run();
  }, [blankType, run]);

  // The click landed before the document types did.
  useEffect(() => {
    if (queued.current && blankType) {
      queued.current = false;
      void run();
    }
  }, [blankType, run]);

  const blocked = !isLoading && !blankType
    ? 'Blank documents need a general-purpose document type (one with no custom fields). Ask an admin to add one.'
    : '';

  return { start, starting: starting && !blocked, error, blocked };
}

export function useStartScratchTemplate(): StartDraft {
  const navigate = useNavigate();
  const createTemplate = useCreateTemplate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const fired = useRef(false);

  const start = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    setError('');
    setStarting(true);
    void preloadTemplateEditor();
    void (async () => {
      try {
        const t = await createTemplate.mutateAsync({ name: 'Untitled template', scope: 'user' });
        navigate(`/documents/templates/${t.id}/edit`, { replace: true });
      } catch (err) {
        fired.current = false;
        setStarting(false);
        // Includes the quota message from the server (spec §27).
        setError(err instanceof Error ? err.message : 'Could not create a template.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  return { start, starting, error, blocked: '' };
}
