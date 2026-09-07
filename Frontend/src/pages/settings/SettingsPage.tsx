/**
 * DocFlow Frontend — Settings Page
 * User preferences: Profile, Notifications, Appearance, Security
 */

import { useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import {
  User, Bell, Palette, Shield, ChevronRight,
  Moon, Sun, Monitor, Check, Eye, EyeOff,
  Save, AlertCircle
} from 'lucide-react';
import { useUIStore } from '@/store/uiStore';

const C = {
  card: 'var(--bg-elevated)', surface: 'var(--bg-surface)', overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)', borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)', primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)', warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)', purple: 'var(--color-accent-400)',
  heading: 'var(--text-primary)', body: 'var(--text-secondary)',
  muted: 'var(--text-muted)', disabled: 'var(--text-disabled)',
};

type SettingsSection = 'profile' | 'notifications' | 'appearance' | 'security';

const sections: { key: SettingsSection; label: string; icon: React.ElementType; desc: string }[] = [
  { key: 'profile', label: 'Profile', icon: User, desc: 'Manage your personal information' },
  { key: 'notifications', label: 'Notifications', icon: Bell, desc: 'Control alerts and emails' },
  { key: 'appearance', label: 'Appearance', icon: Palette, desc: 'Theme and display settings' },
  { key: 'security', label: 'Security', icon: Shield, desc: 'Password and session management' },
];

// ── Toggle Switch ──────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 42, height: 24, borderRadius: 99, border: 'none', cursor: 'pointer',
        background: checked ? C.primary400 : C.overlay,
        position: 'relative', flexShrink: 0, transition: 'background 0.2s',
        boxShadow: checked ? `0 0 10px color-mix(in srgb, ${C.primary400} 40%, transparent)` : 'none',
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: 'white',
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}

// ── Section Components ─────────────────────────────────────────────────────────

function ProfileSection({ user }: { user: any }) {
  const [name, setName] = useState(user?.name || '');
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '20px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16 }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 26, fontWeight: 800, color: 'white' }}>
          {(user?.name || 'U').charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: C.heading, fontWeight: 700, fontSize: 16 }}>{user?.name || 'User'}</div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{user?.email || 'user@company.com'}</div>
          <button style={{ marginTop: 8, padding: '5px 12px', background: C.overlay, border: `1px solid ${C.border}`, borderRadius: 8, color: C.body, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Change Photo
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.body, marginBottom: 7 }}>Full Name</label>
          <input value={name} onChange={e => setName(e.target.value)} className="input" style={{ background: C.surface }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.body, marginBottom: 7 }}>Email Address</label>
          <input value={user?.email || ''} disabled className="input" style={{ background: C.overlay, cursor: 'not-allowed', opacity: 0.7 }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.body, marginBottom: 7 }}>Job Title</label>
          <input placeholder="e.g. Product Manager" className="input" style={{ background: C.surface }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.body, marginBottom: 7 }}>Phone Number</label>
          <input placeholder="+91 98765 43210" className="input" style={{ background: C.surface }} />
        </div>
      </div>
      <div>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.body, marginBottom: 7 }}>Bio</label>
        <textarea placeholder="Tell your team about yourself..." rows={3} className="input" style={{ background: C.surface, resize: 'vertical', fontFamily: 'var(--font-sans)' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={handleSave} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 20px', background: saved ? `color-mix(in srgb, ${C.success} 15%, transparent)` : C.primary, border: saved ? `1px solid color-mix(in srgb, ${C.success} 25%, transparent)` : 'none', borderRadius: 12, color: saved ? C.success : 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer', transition: 'all 0.3s' }}>
          {saved ? <Check size={15} /> : <Save size={15} />}
          {saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const [prefs, setPrefs] = useState({
    emailDocSubmit: true, emailApproval: true, emailRejection: true, emailMention: false,
    pushApproval: true, pushComment: true, pushSLA: true, pushSystem: false,
    digestEmail: false, weeklyReport: true,
  });

  const toggle = (key: keyof typeof prefs) => setPrefs(p => ({ ...p, [key]: !p[key] }));

  const notifGroups = [
    {
      title: 'Email Notifications',
      items: [
        { key: 'emailDocSubmit' as const, label: 'Document Submitted', desc: 'When a document enters your approval queue' },
        { key: 'emailApproval' as const, label: 'Document Approved', desc: 'When a document you submitted is approved' },
        { key: 'emailRejection' as const, label: 'Document Rejected', desc: 'When your document is rejected or returned' },
        { key: 'emailMention' as const, label: 'Mentions', desc: 'When someone mentions you in a comment' },
      ],
    },
    {
      title: 'In-App Notifications',
      items: [
        { key: 'pushApproval' as const, label: 'Approval Required', desc: 'Real-time alerts for pending approvals' },
        { key: 'pushComment' as const, label: 'Comments', desc: 'When someone comments on your document' },
        { key: 'pushSLA' as const, label: 'SLA Warnings', desc: 'When a document SLA is about to breach' },
        { key: 'pushSystem' as const, label: 'System Alerts', desc: 'Maintenance, outages, and system announcements' },
      ],
    },
    {
      title: 'Digest & Reports',
      items: [
        { key: 'digestEmail' as const, label: 'Daily Digest', desc: 'A daily summary of all pending actions' },
        { key: 'weeklyReport' as const, label: 'Weekly Report', desc: 'Your weekly document activity overview' },
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {notifGroups.map(group => (
        <div key={group.title} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.borderSubtle}` }}>
            <div style={{ color: C.heading, fontWeight: 700, fontSize: 14 }}>{group.title}</div>
          </div>
          {group.items.map((item, i) => (
            <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: i < group.items.length - 1 ? `1px solid ${C.borderSubtle}` : 'none' }}>
              <div>
                <div style={{ color: C.heading, fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{item.desc}</div>
              </div>
              <Toggle checked={prefs[item.key]} onChange={() => toggle(item.key)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useUIStore();
  const themes = [
    { key: 'dark' as const, label: 'Dark', icon: Moon, desc: 'Easy on the eyes' },
    { key: 'light' as const, label: 'Light', icon: Sun, desc: 'Classic clean look' },
  ];

  const densities = ['Compact', 'Default', 'Comfortable'];
  const [density, setDensity] = useState('Default');
  const [fontSize, setFontSize] = useState('Medium');
  const fontSizes = ['Small', 'Medium', 'Large'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Theme */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: '20px' }}>
        <div style={{ color: C.heading, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Color Theme</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {themes.map(t => {
            const Icon = t.icon;
            const isActive = theme === t.key;
            return (
              <button key={t.key} onClick={() => setTheme(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 14, border: `2px solid ${isActive ? C.primary400 : C.borderSubtle}`, background: isActive ? `color-mix(in srgb, ${C.primary400} 8%, transparent)` : C.overlay, cursor: 'pointer', transition: 'all 0.2s', position: 'relative' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: t.key === 'dark' ? '#1a2235' : '#f0f4ff', border: `1px solid ${C.borderSubtle}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon size={18} color={t.key === 'dark' ? '#60a5fa' : '#4b72e8'} />
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ color: C.heading, fontWeight: 600, fontSize: 13 }}>{t.label}</div>
                  <div style={{ color: C.muted, fontSize: 11 }}>{t.desc}</div>
                </div>
                {isActive && (
                  <div style={{ position: 'absolute', top: 8, right: 8, width: 18, height: 18, borderRadius: '50%', background: C.primary400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Check size={11} color="white" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Density */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: '20px' }}>
        <div style={{ color: C.heading, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Display Density</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {densities.map(d => (
            <button key={d} onClick={() => setDensity(d)} style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: `1px solid ${density === d ? `color-mix(in srgb, ${C.primary400} 30%, transparent)` : C.borderSubtle}`, background: density === d ? `color-mix(in srgb, ${C.primary400} 10%, transparent)` : C.overlay, color: density === d ? C.primary400 : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}>
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Font Size */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: '20px' }}>
        <div style={{ color: C.heading, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Font Size</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {fontSizes.map(f => (
            <button key={f} onClick={() => setFontSize(f)} style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: `1px solid ${fontSize === f ? `color-mix(in srgb, ${C.primary400} 30%, transparent)` : C.borderSubtle}`, background: fontSize === f ? `color-mix(in srgb, ${C.primary400} 10%, transparent)` : C.overlay, color: fontSize === f ? C.primary400 : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}>
              {f}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SecuritySection() {
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [twoFA, setTwoFA] = useState(false);
  const [sessions] = useState([
    { id: 's1', device: 'Chrome on Windows 11', location: 'Chennai, India', lastActive: 'Now', current: true },
    { id: 's2', device: 'Safari on iPhone 15', location: 'Chennai, India', lastActive: '2 hours ago', current: false },
    { id: 's3', device: 'Chrome on MacBook Pro', location: 'Mumbai, India', lastActive: '3 days ago', current: false },
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Change Password */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: '20px' }}>
        <div style={{ color: C.heading, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Change Password</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { label: 'Current Password', show: showCurrent, toggle: () => setShowCurrent(!showCurrent) },
            { label: 'New Password', show: showNew, toggle: () => setShowNew(!showNew) },
          ].map(field => (
            <div key={field.label}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.body, marginBottom: 7 }}>{field.label}</label>
              <div style={{ position: 'relative' }}>
                <input type={field.show ? 'text' : 'password'} className="input" placeholder="••••••••" style={{ background: C.overlay, paddingRight: 44 }} />
                <button onClick={field.toggle} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: C.muted, display: 'flex' }}>
                  {field.show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={{ padding: '9px 20px', background: C.primary, border: 'none', borderRadius: 12, color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Update Password
          </button>
        </div>
      </div>

      {/* 2FA */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ color: C.heading, fontWeight: 700, fontSize: 14 }}>Two-Factor Authentication</div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Add an extra layer of security to your account using an authenticator app.</div>
          </div>
          <Toggle checked={twoFA} onChange={setTwoFA} />
        </div>
        {twoFA && (
          <div style={{ marginTop: 14, padding: '12px 14px', background: `color-mix(in srgb, ${C.success} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${C.success} 20%, transparent)`, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Check size={15} color={C.success} />
            <span style={{ color: C.success, fontSize: 13, fontWeight: 600 }}>2FA enabled — Your account is more secure</span>
          </div>
        )}
      </div>

      {/* Active Sessions */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.borderSubtle}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ color: C.heading, fontWeight: 700, fontSize: 14 }}>Active Sessions</div>
          <button style={{ padding: '5px 12px', background: `color-mix(in srgb, ${C.danger} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.danger} 20%, transparent)`, borderRadius: 8, color: C.danger, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Revoke All Others
          </button>
        </div>
        {sessions.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: `1px solid ${C.borderSubtle}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: `color-mix(in srgb, ${s.current ? C.success : C.muted} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${s.current ? C.success : C.muted} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Monitor size={17} color={s.current ? C.success : C.muted} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: C.heading, fontSize: 13, fontWeight: 600 }}>{s.device}</span>
                  {s.current && <span style={{ fontSize: 10, padding: '2px 6px', background: `color-mix(in srgb, ${C.success} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.success} 20%, transparent)`, borderRadius: 99, color: C.success, fontWeight: 700 }}>Current</span>}
                </div>
                <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{s.location} · {s.lastActive}</div>
              </div>
            </div>
            {!s.current && (
              <button style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${C.borderSubtle}`, borderRadius: 8, color: C.danger, fontSize: 12, cursor: 'pointer' }}>
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Danger Zone */}
      <div style={{ background: `color-mix(in srgb, ${C.danger} 3%, transparent)`, border: `1px solid color-mix(in srgb, ${C.danger} 20%, transparent)`, borderRadius: 16, padding: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <AlertCircle size={16} color={C.danger} />
          <div style={{ color: C.danger, fontWeight: 700, fontSize: 14 }}>Danger Zone</div>
        </div>
        <div style={{ color: C.muted, fontSize: 13, marginBottom: 14 }}>Once you delete your account, there is no going back. Please be certain.</div>
        <button disabled style={{ padding: '8px 16px', background: 'transparent', border: `1px solid color-mix(in srgb, ${C.danger} 30%, transparent)`, borderRadius: 10, color: C.danger, fontSize: 13, fontWeight: 600, cursor: 'not-allowed', opacity: 0.6 }}>
          Delete My Account
        </button>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile');
  const user = useAuthStore(s => s.user);

  const renderSection = () => {
    switch (activeSection) {
      case 'profile': return <ProfileSection user={user} />;
      case 'notifications': return <NotificationsSection />;
      case 'appearance': return <AppearanceSection />;
      case 'security': return <SecuritySection />;
    }
  };

  return (
    <div style={{ position: 'relative', minHeight: '100%', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', bottom: -150, left: -100, width: 600, height: 600, borderRadius: 9999, background: 'radial-gradient(circle, rgba(37,99,235,0.12) 0%, transparent 68%)', filter: 'blur(200px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, padding: 32 }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: C.heading, margin: 0 }}>Settings</h1>
          <p style={{ color: C.muted, fontSize: 14, marginTop: 4 }}>Manage your account preferences and security</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24, alignItems: 'start' }}>
          {/* Sidebar Nav */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 8, position: 'sticky', top: 24 }}>
            {sections.map(s => {
              const Icon = s.icon;
              const isActive = activeSection === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setActiveSection(s.key)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px',
                    borderRadius: 12, border: `1px solid ${isActive ? `color-mix(in srgb, ${C.primary400} 25%, transparent)` : 'transparent'}`,
                    background: isActive ? `color-mix(in srgb, ${C.primary400} 10%, transparent)` : 'transparent',
                    color: isActive ? C.primary400 : C.muted, fontSize: 13, fontWeight: isActive ? 700 : 500,
                    cursor: 'pointer', textAlign: 'left', transition: 'all 0.2s', marginBottom: 2,
                  }}
                  className="settings-nav-item"
                >
                  <Icon size={16} />
                  <div style={{ flex: 1 }}>
                    <div style={{ lineHeight: 1.2 }}>{s.label}</div>
                    {!isActive && <div style={{ fontSize: 11, color: C.disabled, marginTop: 1 }}>{s.desc}</div>}
                  </div>
                  {isActive && <ChevronRight size={14} />}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div>
            {renderSection()}
          </div>
        </div>
      </div>

      <style>{`
        .settings-nav-item:hover:not([style*="color-mix(in srgb, var(--color-primary-400)"]) {
          background: var(--bg-overlay) !important;
          border-color: var(--border-subtle) !important;
          color: var(--text-primary) !important;
        }
      `}</style>
    </div>
  );
}
