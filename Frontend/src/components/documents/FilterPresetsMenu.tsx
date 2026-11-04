/**
 * DocFlow — Saved filter presets for DocumentListPage (FR-1.10).
 *
 * Persisted in localStorage under a versioned key: `docflow:filter-presets:v1`.
 * Handles quota/private-mode errors gracefully.
 * A preset that references a missing workflow or owner applies cleanly and reports it.
 */
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Plus, Trash2, Edit2, Check, X, AlertCircle } from 'lucide-react';

export interface FilterPreset {
  id: string;
  name: string;
  params: Record<string, string>;
  createdAt: string;
}

const STORAGE_KEY = 'docflow:filter-presets:v1';

export function loadFilterPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFilterPresets(presets: FilterPreset[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

export interface FilterPresetsMenuProps {
  currentParams: URLSearchParams;
  onApply: (params: Record<string, string>, presetName: string, missingRefs?: string[]) => void;
  validWorkflows?: { id: string; name: string }[];
  validMembers?: { id: string; display_name?: string | null; email?: string }[];
}

export function FilterPresetsMenu({
  currentParams,
  onApply,
  validWorkflows = [],
  validMembers = [],
}: FilterPresetsMenuProps) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<FilterPreset[]>(loadFilterPresets);
  const [savingNew, setSavingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Extract active filter params (excluding page)
  const extractActiveParams = (): Record<string, string> => {
    const active: Record<string, string> = {};
    const filterKeys = ['status', 'type', 'dept', 'priority', 'tag', 'q', 'owner', 'workflow', 'from', 'to', 'sort', 'limit'];
    for (const key of filterKeys) {
      const val = currentParams.get(key);
      if (val) active[key] = val;
    }
    return active;
  };

  const handleSaveCurrent = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const params = extractActiveParams();
    const newPreset: FilterPreset = {
      id: `preset_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: trimmed,
      params,
      createdAt: new Date().toISOString(),
    };
    const next = [...presets, newPreset];
    const ok = saveFilterPresets(next);
    if (!ok) {
      setNotice('Could not save preset (storage quota exceeded or private mode).');
      return;
    }
    setPresets(next);
    setNewName('');
    setSavingNew(false);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = presets.filter((p) => p.id !== id);
    saveFilterPresets(next);
    setPresets(next);
  };

  const handleStartRename = (preset: FilterPreset, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(preset.id);
    setEditName(preset.name);
  };

  const handleSaveRename = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    const next = presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
    saveFilterPresets(next);
    setPresets(next);
    setEditingId(null);
  };

  const handleApplyPreset = (preset: FilterPreset) => {
    const missing: string[] = [];
    if (preset.params.workflow) {
      const exists = validWorkflows.some((w) => w.id === preset.params.workflow);
      if (!exists) missing.push(`Workflow (${preset.params.workflow})`);
    }
    if (preset.params.owner && preset.params.owner !== 'me') {
      const exists = validMembers.some((m) => m.id === preset.params.owner);
      if (!exists) missing.push(`Owner (${preset.params.owner})`);
    }
    onApply(preset.params, preset.name, missing.length > 0 ? missing : undefined);
    setOpen(false);
  };

  const activeParamCount = Object.keys(extractActiveParams()).length;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Saved filter presets"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 12px',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          background: open ? 'var(--muted)' : 'var(--card)',
          color: presets.length > 0 ? 'var(--foreground)' : 'var(--muted-foreground)',
          fontSize: '0.8rem',
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <Bookmark size={14} style={{ color: presets.length > 0 ? 'var(--primary)' : 'inherit' }} />
        <span>Presets</span>
        {presets.length > 0 && (
          <span
            style={{
              fontSize: '0.68rem',
              fontWeight: 700,
              minWidth: 16,
              padding: '1px 5px',
              borderRadius: 999,
              background: 'var(--secondary)',
              color: 'var(--secondary-foreground)',
            }}
          >
            {presets.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="group"
          aria-label="Filter presets"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 30,
            width: 280,
            padding: 10,
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            background: 'var(--card-solid)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, padding: '0 4px' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted-foreground)' }}>
              Saved Presets
            </span>
            {!savingNew && (
              <button
                onClick={() => setSavingNew(true)}
                title="Save current filters as a new preset"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: '0.74rem',
                  color: 'var(--primary)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 600,
                  padding: '2px 4px',
                }}
              >
                <Plus size={12} /> Save current
              </button>
            )}
          </div>

          {notice && (
            <div
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                marginBottom: 8,
                borderRadius: 'var(--radius)',
                background: 'var(--status-rejected-bg)',
                color: 'var(--status-rejected-fg)',
                fontSize: '0.74rem',
              }}
            >
              <AlertCircle size={12} />
              <span>{notice}</span>
            </div>
          )}

          {savingNew && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: 8,
                marginBottom: 8,
                borderRadius: 'var(--radius)',
                background: 'var(--muted)',
                border: '1px solid var(--border)',
              }}
            >
              <span style={{ fontSize: '0.74rem', color: 'var(--foreground)', fontWeight: 600 }}>
                Save {activeParamCount} active filter{activeParamCount === 1 ? '' : 's'}:
              </span>
              <input
                type="text"
                autoFocus
                placeholder="Preset name (e.g. My Urgent Docs)…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveCurrent();
                  if (e.key === 'Escape') setSavingNew(false);
                }}
                className="input"
                style={{ fontSize: '0.8rem', padding: '6px 8px', height: 32 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 2 }}>
                <button
                  onClick={() => setSavingNew(false)}
                  style={{
                    fontSize: '0.74rem',
                    padding: '4px 8px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--muted-foreground)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveCurrent}
                  disabled={!newName.trim()}
                  className="btn btn-primary"
                  style={{ fontSize: '0.74rem', padding: '4px 10px', height: 26 }}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          {presets.length === 0 ? (
            <div style={{ padding: '12px 6px', textAlign: 'center', fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
              No presets saved yet. Apply some filters and click &quot;Save current&quot;.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {presets.map((preset) => {
                const isEditing = editingId === preset.id;
                const count = Object.keys(preset.params).length;
                return (
                  <li
                    key={preset.id}
                    onClick={() => !isEditing && handleApplyPreset(preset)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px',
                      borderRadius: 'var(--radius)',
                      cursor: isEditing ? 'default' : 'pointer',
                      background: 'transparent',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isEditing) e.currentTarget.style.background = 'var(--muted)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isEditing) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {isEditing ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        <input
                          type="text"
                          value={editName}
                          autoFocus
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename(preset.id, e as unknown as React.MouseEvent);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="input"
                          style={{ fontSize: '0.78rem', padding: '4px 6px', height: 28, flex: 1 }}
                        />
                        <button
                          onClick={(e) => handleSaveRename(preset.id, e)}
                          title="Save name"
                          style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 2 }}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                          title="Cancel"
                          style={{ background: 'none', border: 'none', color: 'var(--muted-foreground)', cursor: 'pointer', padding: 2 }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {preset.name}
                          </span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
                            {count} filter{count === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
                          <button
                            onClick={(e) => handleStartRename(preset, e)}
                            title="Rename preset"
                            aria-label={`Rename preset ${preset.name}`}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--muted-foreground)',
                              cursor: 'pointer',
                              padding: 4,
                              borderRadius: 'var(--radius)',
                            }}
                          >
                            <Edit2 size={12} />
                          </button>
                          <button
                            onClick={(e) => handleDelete(preset.id, e)}
                            title="Delete preset"
                            aria-label={`Delete preset ${preset.name}`}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--status-rejected-fg)',
                              cursor: 'pointer',
                              padding: 4,
                              borderRadius: 'var(--radius)',
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

