/**
 * DocFlow Frontend — Offline draft cache (spec §24.1, FR-14.7)
 *
 * A tiny IndexedDB-backed backup of in-progress draft edits so a refresh, crash
 * or network drop never loses work. This is a *local convenience only*: the
 * authoritative copy is always the server. Every call is wrapped in try/catch so
 * a private window, blocked storage, or an unavailable IndexedDB degrades to a
 * no-op instead of throwing.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { UpdateDocumentPayload } from '@/lib/api/documents';

const DB_NAME = 'docflow-drafts';
const STORE = 'drafts';
const DB_VERSION = 1;

let _dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!_dbPromise) {
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return _dbPromise;
}

export interface CachedDraft {
  /** Document id (primary key). */
  id: string;
  /** The last edit payload not yet confirmed saved to the server. */
  payload: UpdateDocumentPayload;
  /** Server version this edit was built on (for conflict detection on resume). */
  version: number;
  /** Client timestamp (ISO) of this local backup. */
  savedAt: string;
}

export async function saveDraftLocal(draft: CachedDraft): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE, draft);
  } catch {
    /* storage unavailable — ignore, server remains source of truth */
  }
}

export async function getDraftLocal(id: string): Promise<CachedDraft | undefined> {
  try {
    const db = await getDb();
    return await db.get(STORE, id);
  } catch {
    return undefined;
  }
}

export async function deleteDraftLocal(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE, id);
  } catch {
    /* ignore */
  }
}

/**
 * Wipe every cached draft. Called on sign-out so one user's unsaved document
 * content can never be read by the next person to sign in on this device.
 */
export async function clearAllDraftsLocal(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE);
  } catch {
    /* ignore */
  }
}
