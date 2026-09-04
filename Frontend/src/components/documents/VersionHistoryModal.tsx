/**
 * DocFlow Frontend — Component: VersionHistoryModal
 * Interactive audit trail modal displaying full document version snapshots,
 * change reasons, author attribution, and form data comparisons.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDocumentVersions } from '@/hooks/useDocuments';

export interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  docId: string;
  docTitle: string;
  currentVersionNum: number;
}

export function VersionHistoryModal({
  isOpen,
  onClose,
  docId,
  docTitle,
  currentVersionNum,
}: VersionHistoryModalProps) {
  const { data: versions = [], isLoading } = useDocumentVersions(docId);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const selectedVersion =
    versions.find((v) => v.id === selectedVersionId) || versions[0] || null;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'hsla(220, 50%, 5%, 0.75)',
              backdropFilter: 'blur(6px)',
              zIndex: 300,
            }}
          />

          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '90%',
              maxWidth: '820px',
              maxHeight: '84vh',
              zIndex: 301,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 'var(--radius-xl)',
              overflow: 'hidden',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
            }}
            className="glass-card"
          >
            {/* Header */}
            <div
              style={{
                padding: '20px 28px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.25rem' }}>⏱️</span>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Version History & Audit Trail
                  </h2>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {docTitle} — {versions.length} version(s) recorded
                </p>
              </div>
              <button
                onClick={onClose}
                style={{
                  background: 'var(--bg-overlay)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ✕
              </button>
            </div>

            {/* Split Content: Timeline (Left) + Snapshot Preview (Right) */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: '440px' }}>
              {/* Left Timeline */}
              <div
                style={{
                  width: '320px',
                  borderRight: '1px solid var(--border-subtle)',
                  overflowY: 'auto',
                  padding: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  background: 'var(--bg-card)',
                }}
              >
                {isLoading ? (
                  <div style={{ padding: '32px', textAlign: 'center' }}>
                    <div className="spinner" style={{ width: '24px', height: '24px' }} />
                  </div>
                ) : versions.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', padding: '24px' }}>
                    No version history found.
                  </div>
                ) : (
                  versions.map((ver) => {
                    const isSelected = selectedVersion?.id === ver.id;
                    const isCurrent = ver.version_num === currentVersionNum;

                    return (
                      <div
                        key={ver.id}
                        onClick={() => setSelectedVersionId(ver.id)}
                        style={{
                          padding: '14px',
                          borderRadius: 'var(--radius-lg)',
                          cursor: 'pointer',
                          background: isSelected
                            ? 'hsla(217, 100%, 50%, 0.12)'
                            : 'var(--bg-overlay)',
                          border: isSelected
                            ? '1px solid var(--color-primary-500)'
                            : '1px solid var(--border-subtle)',
                          transition: 'all var(--transition-fast)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '6px',
                          }}
                        >
                          <span
                            style={{
                              fontSize: '0.88rem',
                              fontWeight: 800,
                              color: isSelected ? 'var(--color-primary-400)' : 'var(--text-primary)',
                            }}
                          >
                            Version {ver.version_num}
                          </span>
                          {isCurrent && (
                            <span
                              style={{
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                color: '#fff',
                                background: 'var(--color-primary-600)',
                                padding: '2px 6px',
                                borderRadius: 'var(--radius-full)',
                              }}
                            >
                              Current
                            </span>
                          )}
                        </div>

                        <div
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--text-secondary)',
                            marginBottom: '4px',
                            fontWeight: 600,
                          }}
                        >
                          {ver.change_reason || 'Updated document'}
                        </div>

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            fontSize: '0.72rem',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <span>By {ver.changer_name || 'Member'}</span>
                          <span>
                            {new Date(ver.created_at).toLocaleDateString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Right Snapshot Preview */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '24px 28px',
                  background: 'var(--bg-main)',
                }}
              >
                {selectedVersion ? (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '20px',
                        paddingBottom: '14px',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            color: 'var(--color-primary-400)',
                          }}
                        >
                          Snapshot Preview
                        </span>
                        <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--text-primary)', marginTop: '2px' }}>
                          {selectedVersion.title}
                        </h3>
                      </div>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--text-muted)',
                          background: 'var(--bg-card)',
                          padding: '4px 10px',
                          borderRadius: 'var(--radius-full)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        Version {selectedVersion.version_num}
                      </span>
                    </div>

                    {/* Snapshot Form Data Table */}
                    <div style={{ marginBottom: '24px' }}>
                      <h4
                        style={{
                          fontSize: '0.85rem',
                          fontWeight: 700,
                          color: 'var(--text-secondary)',
                          marginBottom: '12px',
                        }}
                      >
                        Form Field Values
                      </h4>
                      {Object.keys(selectedVersion.form_data || {}).length === 0 ? (
                        <div
                          style={{
                            padding: '16px',
                            background: 'var(--bg-overlay)',
                            borderRadius: 'var(--radius-md)',
                            color: 'var(--text-muted)',
                            fontSize: '0.85rem',
                          }}
                        >
                          No form data recorded for this version.
                        </div>
                      ) : (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px',
                          }}
                        >
                          {Object.entries(selectedVersion.form_data).map(([key, val]) => (
                            <div
                              key={key}
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                justifyContent: 'space-between',
                                padding: '10px 14px',
                                background: 'var(--bg-card)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-md)',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: '0.82rem',
                                  fontWeight: 600,
                                  color: 'var(--text-secondary)',
                                  fontFamily: 'monospace',
                                }}
                              >
                                {key}
                              </span>
                              <span
                                style={{
                                  fontSize: '0.88rem',
                                  fontWeight: 600,
                                  color: 'var(--text-primary)',
                                }}
                              >
                                {Array.isArray(val)
                                  ? val.join(', ')
                                  : typeof val === 'object'
                                  ? JSON.stringify(val)
                                  : String(val)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Metadata summary */}
                    <div
                      style={{
                        padding: '14px 18px',
                        background: 'var(--bg-overlay)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: '0.78rem',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>Created {new Date(selectedVersion.created_at).toLocaleString()}</span>
                      <span>ID: {selectedVersion.id.slice(0, 8)}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px' }}>
                    Select a version from the timeline on the left to inspect its snapshot.
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div
              style={{
                padding: '16px 28px',
                borderTop: '1px solid var(--border-subtle)',
                background: 'var(--bg-card)',
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <button onClick={onClose} className="btn btn-secondary">
                Close Audit Trail
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default VersionHistoryModal;
