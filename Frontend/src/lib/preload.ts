/**
 * DocFlow — warm a lazy route's chunk before it is needed.
 *
 * The editor routes are code-split (FR-6.8 / FR-15.5), so the first visit
 * pays for the TipTap + ProseMirror download on top of whatever the click
 * itself has to do. Starting that download on hover or keyboard focus moves
 * it off the critical path: by the time the draft exists, the chunk usually
 * does too.
 *
 * The import specifiers MUST stay identical to the `lazy(() => import(...))`
 * calls in App.tsx. Vite keys chunks by specifier, so a different spelling of
 * the same path would download the module twice instead of reusing it.
 */

export const preloadDocumentEditor = () => import('@/pages/documents/DocumentEditorPage');
export const preloadTemplateEditor = () => import('@/pages/templates/TemplateEditorPage');
export const preloadFormFill = () => import('@/pages/documents/FormFillPage');

/**
 * Props that start a preload on hover, focus or first touch.
 *
 * Fires at most once per spread, and swallows failures: a chunk that cannot
 * be fetched now will be requested again (and its error surfaced properly) by
 * the route's own Suspense boundary.
 */
export function preloadOn(load: () => Promise<unknown>) {
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    void load().catch(() => { started = false; });
  };
  return { onMouseEnter: go, onFocus: go, onTouchStart: go };
}
