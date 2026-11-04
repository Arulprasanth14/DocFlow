/**
 * DocFlow — document import API (spec FR-9).
 *
 * The file is uploaded through the normal presign/confirm route first, which
 * is where the virus scan and macro stripping happen. This API only ever
 * references the resulting FileAsset id — raw bytes never come through here.
 */
import { apiClient } from './client';

export type ImportStatus =
  | 'pending' | 'extracting' | 'detecting' | 'ready'
  | 'failed' | 'cancelled' | 'applied';

export type Confidence = 'high' | 'medium' | 'low';

/** One proposed blank (FR-9.3). */
export interface Detection {
  /** Character offsets into the extracted text. Identify the detection. */
  start: number;
  end: number;
  original: string;
  key: string;
  label: string;
  type: string;
  confidence: Confidence;
  reason: string;
  /**
   * 'rule'   deterministic pass
   * 'ai'     opt-in LLM pass
   * 'manual' the author selected the text and pressed "Make blank"
   */
  source: 'rule' | 'ai' | 'manual';
}

export interface ImportJob {
  id: string;
  filename: string;
  source_kind: 'docx' | 'odt' | 'rtf' | 'pdf' | 'txt';
  /** FR-9.7 — the stored original, resolved to a short-lived URL on demand. */
  file_asset_id: string | null;
  status: ImportStatus;
  stage: string | null;
  progress: number;
  use_llm: boolean;
  page_count: number | null;
  char_count: number | null;
  content: Record<string, unknown> | null;
  /** Extracted plain text, exactly as detection offsets index it. */
  text: string;
  detections: Detection[];
  warnings: string[];
  error: string | null;
  template_id: string | null;
  created_at: string;
}

export interface StartImportPayload {
  file_asset_id: string;
  filename: string;
  mime_type?: string | null;
  /**
   * Opt-in only. When false (the default) the document text never leaves the
   * server; only the deterministic rule pass runs.
   */
  use_llm?: boolean;
}

/** What the author accepted. Only label/key/type are editable — not the span. */
export interface AcceptedDetection {
  start: number;
  end: number;
  key?: string;
  label?: string;
  type?: string;
}

export const importsApi = {
  start: (data: StartImportPayload) =>
    apiClient.post<ImportJob>('/imports', data),

  get: (jobId: string) => apiClient.get<ImportJob>(`/imports/${jobId}`),

  cancel: (jobId: string) =>
    apiClient.post<{ message: string }>(`/imports/${jobId}/cancel`, {}),

  apply: (jobId: string, name: string, accepted: AcceptedDetection[]) =>
    apiClient.post<{ id: string; name: string }>(`/imports/${jobId}/apply`, {
      name,
      accepted,
    }),
};

export default importsApi;
