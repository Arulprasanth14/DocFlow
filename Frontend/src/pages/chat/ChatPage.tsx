/**
 * DocFlow Frontend — AI Chat Page
 * Two tabs: AI Chat (Gemini-powered) | Document Templates library
 */

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare, FileText, Sparkles, Send, Plus,
  Trash2, Copy, Check, RotateCcw, Bot, User,
  Search, BookOpen, ChevronRight, Zap, Download
} from 'lucide-react';

const C = {
  card: 'var(--bg-elevated)', surface: 'var(--bg-surface)', overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)', borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)', primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)', warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)', purple: 'var(--color-accent-400)',
  heading: 'var(--text-primary)', body: 'var(--text-secondary)',
  muted: 'var(--text-muted)', disabled: 'var(--text-disabled)',
};

type Tab = 'chat' | 'templates';

// ── Types ──────────────────────────────────────────────────────────────────────
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: Date;
  copying?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  lastMsg: string;
  ts: Date;
  messages: Message[];
}

interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  color: string;
  fields: number;
  uses: number;
}

// ── Mock Data ──────────────────────────────────────────────────────────────────
const TEMPLATES: Template[] = [
  { id: 't1', name: 'Non-Disclosure Agreement', category: 'Legal', description: 'Standard NDA for vendor and partner confidentiality agreements. Covers mutual and unilateral forms.', tags: ['Legal', 'Contract', 'Compliance'], color: C.primary400, fields: 8, uses: 142 },
  { id: 't2', name: 'Project Proposal', category: 'Strategy', description: 'Comprehensive project proposal with scope, timeline, budget breakdown, and success metrics.', tags: ['Strategy', 'Planning'], color: C.purple, fields: 12, uses: 98 },
  { id: 't3', name: 'Employee Onboarding Checklist', category: 'HR', description: 'Step-by-step onboarding document for new hires covering IT setup, policies, and team introductions.', tags: ['HR', 'Onboarding', 'Policy'], color: C.success, fields: 15, uses: 76 },
  { id: 't4', name: 'Budget Request Form', category: 'Finance', description: 'Formal budget request with cost justification, ROI analysis, and approval routing for finance teams.', tags: ['Finance', 'Budget', 'Approval'], color: C.warning, fields: 10, uses: 65 },
  { id: 't5', name: 'Vendor Evaluation Report', category: 'Procurement', description: 'Structured vendor assessment with scoring matrix, risk assessment, and recommendation summary.', tags: ['Procurement', 'Vendor', 'Risk'], color: C.danger, fields: 14, uses: 53 },
  { id: 't6', name: 'Monthly Status Report', category: 'Management', description: 'Executive-ready monthly report covering KPIs, blockers, wins, and next-period objectives.', tags: ['Management', 'Reporting'], color: C.primary400, fields: 9, uses: 119 },
  { id: 't7', name: 'IT Change Request', category: 'IT', description: 'Formal change management document for system/infrastructure modifications with rollback plan.', tags: ['IT', 'Change Management'], color: C.purple, fields: 11, uses: 44 },
  { id: 't8', name: 'Partnership Agreement', category: 'Legal', description: 'Strategic partnership agreement covering roles, revenue sharing, IP rights, and termination clauses.', tags: ['Legal', 'Partnership', 'Business'], color: C.success, fields: 16, uses: 31 },
];

const QUICK_PROMPTS = [
  { icon: '📄', text: 'Summarize a document for me' },
  { icon: '✅', text: 'Draft approval criteria for a policy doc' },
  { icon: '📊', text: 'Explain what an NDA should contain' },
  { icon: '🔍', text: 'Review this contract clause for risks' },
  { icon: '💼', text: 'Create a budget justification template' },
  { icon: '📋', text: 'Write a professional email for document submission' },
];

const MOCK_AI_RESPONSES: Record<string, string> = {
  default: `I'm DocFlow AI, your document workflow assistant powered by Gemini. I can help you:

• **Summarize** complex documents
• **Draft** professional content and templates  
• **Review** contracts and identify key clauses
• **Explain** document requirements and best practices
• **Create** approval criteria and checklists

What document task can I help you with today?`,
  summary: `Here's a concise summary of what I can help you summarize:

**Key Elements I Look For:**
1. **Purpose** — What is the document trying to achieve?
2. **Parties involved** — Who are the stakeholders?
3. **Key terms & obligations** — What are the commitments?
4. **Timelines & deadlines** — When do things need to happen?
5. **Risk factors** — What could go wrong?

Please paste your document text or describe what you'd like summarized, and I'll give you a structured breakdown!`,
};

function getAIResponse(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('summarize') || lower.includes('summary')) return MOCK_AI_RESPONSES.summary;
  return `I understand you're asking about: **"${msg}"**

Based on DocFlow's document management context, here's what I can tell you:

This is a great question for document workflows. In enterprise document management, this typically involves:

• **Document classification** — Categorizing by type, department, and sensitivity
• **Workflow assignment** — Matching documents to the right approval chains
• **Compliance considerations** — Ensuring regulatory requirements are met
• **Audit trail** — Maintaining records of all actions taken

Would you like me to go deeper on any specific aspect, or help you create a document template for this use case? 

> *Note: This is a demo response. Connect the backend AI service (Gemini Flash 2.5) to enable full AI capabilities.*`;
}

let msgId = 1;
const newId = () => `m${msgId++}`;

const initialConversations: Conversation[] = [
  {
    id: 'c1', title: 'NDA Review Help', lastMsg: 'What clauses should an NDA include?',
    ts: new Date(Date.now() - 3600000 * 2),
    messages: [
      { id: 'm0', role: 'assistant', content: MOCK_AI_RESPONSES.default, ts: new Date(Date.now() - 3600000 * 2) },
    ],
  },
];

// ── Chat Sub-components ────────────────────────────────────────────────────────
function MessageBubble({ msg, onCopy }: { msg: Message; onCopy: (id: string, text: string) => void }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, flexDirection: isUser ? 'row-reverse' : 'row', alignItems: 'flex-start', marginBottom: 18 }}>
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        background: isUser ? `color-mix(in srgb, ${C.primary400} 15%, transparent)` : `color-mix(in srgb, ${C.purple} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${isUser ? C.primary400 : C.purple} 25%, transparent)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isUser ? <User size={16} color={C.primary400} /> : <Bot size={16} color={C.purple} />}
      </div>

      {/* Bubble */}
      <div style={{ maxWidth: '75%', display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
        <div style={{
          padding: '11px 15px', borderRadius: isUser ? '18px 4px 18px 18px' : '4px 18px 18px 18px',
          background: isUser ? `color-mix(in srgb, ${C.primary400} 15%, transparent)` : C.card,
          border: `1px solid ${isUser ? `color-mix(in srgb, ${C.primary400} 25%, transparent)` : C.border}`,
          color: C.heading, fontSize: 14, lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
        }}>
          {msg.content}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.disabled, fontSize: 11 }}>
            {msg.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {!isUser && (
            <button onClick={() => onCopy(msg.id, msg.content)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.disabled, display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '2px 4px', borderRadius: 4 }}>
              {msg.copying ? <Check size={11} color={C.success} /> : <Copy size={11} />}
              {msg.copying ? 'Copied!' : 'Copy'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Template Card ──────────────────────────────────────────────────────────────
function TemplateCard({ t, onUse }: { t: Template; onUse: (t: Template) => void }) {
  return (
    <div className="template-card" style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 18,
      padding: 20, display: 'flex', flexDirection: 'column', gap: 12,
      transition: 'all 0.2s', cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: `color-mix(in srgb, ${t.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${t.color} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <FileText size={18} color={t.color} />
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, padding: '3px 8px', borderRadius: 99, background: `color-mix(in srgb, ${t.color} 10%, transparent)`, color: t.color, border: `1px solid color-mix(in srgb, ${t.color} 20%, transparent)` }}>
          {t.category}
        </span>
      </div>
      <div>
        <div style={{ color: C.heading, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{t.name}</div>
        <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.55 }}>{t.description}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {t.tags.map(tag => (
          <span key={tag} style={{ fontSize: 11, padding: '2px 7px', background: C.overlay, border: `1px solid ${C.borderSubtle}`, borderRadius: 99, color: C.muted }}>{tag}</span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, borderTop: `1px solid ${C.borderSubtle}` }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <span style={{ color: C.disabled, fontSize: 11 }}>{t.fields} fields</span>
          <span style={{ color: C.disabled, fontSize: 11 }}>Used {t.uses}x</span>
        </div>
        <button
          onClick={() => onUse(t)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: `color-mix(in srgb, ${C.primary400} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.primary400} 20%, transparent)`, borderRadius: 8, color: C.primary400, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          Use <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function ChatPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeChatId, setActiveChatId] = useState<string>('c1');
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateCategory, setTemplateCategory] = useState('All');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeChat = conversations.find(c => c.id === activeChatId);
  const categories = ['All', ...Array.from(new Set(TEMPLATES.map(t => t.category)))];
  const filteredTemplates = TEMPLATES.filter(t =>
    (templateCategory === 'All' || t.category === templateCategory) &&
    (templateSearch === '' || t.name.toLowerCase().includes(templateSearch.toLowerCase()) || t.category.toLowerCase().includes(templateSearch.toLowerCase()))
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeChat?.messages]);

  const sendMessage = async () => {
    if (!input.trim() || !activeChat) return;
    const userMsg: Message = { id: newId(), role: 'user', content: input.trim(), ts: new Date() };
    const userInput = input.trim();
    setInput('');

    setConversations(prev => prev.map(c =>
      c.id === activeChatId
        ? { ...c, messages: [...c.messages, userMsg], lastMsg: userInput, title: c.title === 'New Conversation' ? userInput.slice(0, 32) : c.title }
        : c
    ));

    setIsTyping(true);
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));

    const aiMsg: Message = { id: newId(), role: 'assistant', content: getAIResponse(userInput), ts: new Date() };
    setIsTyping(false);
    setConversations(prev => prev.map(c =>
      c.id === activeChatId ? { ...c, messages: [...c.messages, aiMsg] } : c
    ));
  };

  const newConversation = () => {
    const id = `c${Date.now()}`;
    const newConv: Conversation = {
      id, title: 'New Conversation', lastMsg: '',
      ts: new Date(),
      messages: [{ id: newId(), role: 'assistant', content: MOCK_AI_RESPONSES.default, ts: new Date() }],
    };
    setConversations(prev => [newConv, ...prev]);
    setActiveChatId(id);
  };

  const deleteConversation = (id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeChatId === id) {
      const remaining = conversations.filter(c => c.id !== id);
      if (remaining.length > 0) setActiveChatId(remaining[0].id);
      else newConversation();
    }
  };

  const copyMessage = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setConversations(prev => prev.map(c => ({
      ...c,
      messages: c.messages.map(m => m.id === id ? { ...m, copying: true } : m),
    })));
    setTimeout(() => {
      setConversations(prev => prev.map(c => ({
        ...c,
        messages: c.messages.map(m => m.id === id ? { ...m, copying: false } : m),
      })));
    }, 2000);
  };

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - var(--header-height))', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Ambient */}
      <div style={{ position: 'absolute', top: -150, right: -100, width: 600, height: 600, borderRadius: 9999, background: 'radial-gradient(circle, rgba(124,58,237,0.12) 0%, transparent 65%)', filter: 'blur(180px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Page Header + Tabs */}
        <div style={{ padding: '20px 28px 0', borderBottom: `1px solid ${C.borderSubtle}`, background: 'var(--bg-surface)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: `color-mix(in srgb, ${C.purple} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${C.purple} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={17} color={C.purple} />
              </div>
              <div>
                <h1 style={{ fontSize: 20, fontWeight: 800, color: C.heading, margin: 0 }}>AI Assistant</h1>
                <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>Powered by Gemini Flash 2.5</p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: `color-mix(in srgb, ${C.success} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.success} 20%, transparent)`, borderRadius: 99 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.success, boxShadow: `0 0 5px ${C.success}` }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: C.success }}>Online</span>
            </div>
          </div>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0 }}>
            {([['chat', MessageSquare, 'AI Chat'], ['templates', BookOpen, 'Templates']] as const).map(([key, Icon, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '10px 20px',
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
                  color: activeTab === key ? C.primary400 : C.muted,
                  borderBottom: `2px solid ${activeTab === key ? C.primary400 : 'transparent'}`,
                  transition: 'all 0.2s', marginBottom: -1,
                }}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {/* ── CHAT TAB ── */}
          {activeTab === 'chat' && (
            <div style={{ display: 'flex', height: '100%' }}>
              {/* Sidebar: Conversation List */}
              <div style={{ width: 240, borderRight: `1px solid ${C.borderSubtle}`, display: 'flex', flexDirection: 'column', background: C.surface, flexShrink: 0 }}>
                <div style={{ padding: '12px' }}>
                  <button onClick={newConversation} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: `color-mix(in srgb, ${C.primary400} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.primary400} 20%, transparent)`, borderRadius: 12, color: C.primary400, fontSize: 13, fontWeight: 600, cursor: 'pointer', justifyContent: 'center' }}>
                    <Plus size={15} /> New Chat
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
                  {conversations.map(c => (
                    <div
                      key={c.id}
                      onClick={() => setActiveChatId(c.id)}
                      className="conv-item"
                      style={{
                        padding: '10px 12px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                        background: activeChatId === c.id ? `color-mix(in srgb, ${C.primary400} 10%, transparent)` : 'transparent',
                        border: `1px solid ${activeChatId === c.id ? `color-mix(in srgb, ${C.primary400} 20%, transparent)` : 'transparent'}`,
                        transition: 'all 0.15s', display: 'flex', alignItems: 'flex-start', gap: 8,
                      }}
                    >
                      <MessageSquare size={13} color={activeChatId === c.id ? C.primary400 : C.disabled} style={{ marginTop: 2, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: activeChatId === c.id ? C.primary400 : C.body, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</div>
                        <div style={{ color: C.disabled, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{c.lastMsg || 'Start a conversation'}</div>
                      </div>
                      <button onClick={e => { e.stopPropagation(); deleteConversation(c.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.disabled, padding: 2, flexShrink: 0, opacity: 0, transition: 'opacity 0.15s' }} className="conv-delete">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chat Main */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Messages */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                  {activeChat?.messages.map(msg => (
                    <MessageBubble key={msg.id} msg={msg} onCopy={copyMessage} />
                  ))}
                  {isTyping && (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 18 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: `color-mix(in srgb, ${C.purple} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${C.purple} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Bot size={16} color={C.purple} />
                      </div>
                      <div style={{ padding: '11px 15px', borderRadius: '4px 18px 18px 18px', background: C.card, border: `1px solid ${C.border}`, display: 'flex', gap: 5, alignItems: 'center' }}>
                        {[0, 1, 2].map(i => (
                          <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: C.purple, animation: `typingDot 1.2s ${i * 0.2}s ease infinite` }} />
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Quick prompts when empty */}
                  {activeChat && activeChat.messages.length === 1 && !isTyping && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ color: C.disabled, fontSize: 12, marginBottom: 10, textAlign: 'center' }}>Or try a quick prompt</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {QUICK_PROMPTS.map(qp => (
                          <button key={qp.text} onClick={() => { setInput(qp.text); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, color: C.body, fontSize: 12, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}
                            className="quick-prompt"
                          >
                            <span style={{ fontSize: 16 }}>{qp.icon}</span> {qp.text}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div style={{ padding: '12px 20px 16px', borderTop: `1px solid ${C.borderSubtle}`, flexShrink: 0 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '10px 14px', transition: 'border-color 0.2s' }} className="chat-input-box">
                    <textarea
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                      placeholder="Ask anything about your documents... (Enter to send, Shift+Enter for new line)"
                      rows={1}
                      style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: C.heading, fontSize: 14, resize: 'none', fontFamily: 'var(--font-sans)', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' }}
                    />
                    <button
                      onClick={sendMessage}
                      disabled={!input.trim() || isTyping}
                      style={{ width: 36, height: 36, borderRadius: 10, background: input.trim() && !isTyping ? C.primary : C.overlay, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: input.trim() && !isTyping ? 'pointer' : 'not-allowed', flexShrink: 0, transition: 'all 0.2s' }}
                    >
                      <Send size={16} color={input.trim() && !isTyping ? 'white' : C.disabled} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                    <span style={{ color: C.disabled, fontSize: 11 }}>DocFlow AI may produce inaccurate information. Review important documents carefully.</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TEMPLATES TAB ── */}
          {activeTab === 'templates' && (
            <div style={{ height: '100%', overflowY: 'auto' }}>
              <div style={{ padding: '20px 28px' }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h2 style={{ color: C.heading, fontSize: 18, fontWeight: 700, margin: 0 }}>Document Templates</h2>
                    <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>{TEMPLATES.length} templates available · Start with a professional template</p>
                  </div>
                  <button onClick={() => navigate('/documents/new')} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: C.primary, border: 'none', borderRadius: 12, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    <Plus size={15} /> Create from Template
                  </button>
                </div>

                {/* Filters */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '8px 14px', flex: 1, maxWidth: 320 }}>
                    <Search size={14} color={C.muted} />
                    <input value={templateSearch} onChange={e => setTemplateSearch(e.target.value)} placeholder="Search templates..." style={{ background: 'none', border: 'none', outline: 'none', color: C.heading, fontSize: 13, flex: 1 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {categories.map(cat => (
                      <button key={cat} onClick={() => setTemplateCategory(cat)} style={{ padding: '7px 12px', borderRadius: 99, border: `1px solid ${templateCategory === cat ? `color-mix(in srgb, ${C.primary400} 30%, transparent)` : C.borderSubtle}`, background: templateCategory === cat ? `color-mix(in srgb, ${C.primary400} 10%, transparent)` : C.card, color: templateCategory === cat ? C.primary400 : C.muted, fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' }}>
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Templates Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
                  {filteredTemplates.map(t => (
                    <TemplateCard key={t.id} t={t} onUse={() => navigate('/documents/new')} />
                  ))}
                </div>

                {filteredTemplates.length === 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 20px', gap: 12 }}>
                    <BookOpen size={40} color={C.disabled} style={{ opacity: 0.4 }} />
                    <div style={{ color: C.heading, fontWeight: 600 }}>No templates found</div>
                    <div style={{ color: C.muted, fontSize: 13 }}>Try a different category or search term</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .conv-item:hover { background: var(--bg-elevated) !important; border-color: var(--border-subtle) !important; }
        .conv-item:hover .conv-delete { opacity: 1 !important; }
        .chat-input-box:focus-within { border-color: var(--color-primary-500) !important; box-shadow: 0 0 0 3px hsla(217, 100%, 50%, 0.1); }
        .quick-prompt:hover { border-color: var(--border-strong) !important; color: var(--text-primary) !important; transform: translateY(-1px); }
        .template-card:hover { transform: translateY(-3px); border-color: var(--border-strong) !important; box-shadow: 0 16px 50px rgba(0,0,0,0.35); }
        @keyframes typingDot {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
