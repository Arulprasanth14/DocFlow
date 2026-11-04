/**
 * DocFlow Landing v4 — content.
 *
 * Ported from the `D` object in the Claude Design file
 * "DocFlow Landing v4.dc.html". Copy is verbatim from the design with one
 * exception, marked below: the Trust card's database claim, which implied
 * Postgres row-level security that DocFlow does not use.
 *
 * Every claim here is either confirmed in `../facts.ts` or carries a
 * "coming soon" / "In progress" / "Planned" / "Sample data" qualifier.
 */

export interface Stage {
  name: string;
  badge: string;
  summary: string;
  details: string;
}

export interface DocType {
  title: string;
  category: string;
  description: string;
}

export interface Role {
  title: string;
  badge: string;
  tagline: string;
  can: string[];
  cannot: string[];
}

export interface TitledDesc {
  title: string;
  desc: string;
}

export interface CompareRow {
  capability: string;
  typicalTools: string;
  docFlow: string;
  /** Highlighted row. */
  h?: boolean;
}

export interface Faq {
  question: string;
  answer: string;
}

export interface FooterLink {
  label: string;
  href: string;
}

export interface FooterCol {
  title: string;
  links: FooterLink[];
}

export interface Quote {
  text: string;
  sender: string;
}

export interface FlowStep {
  n: string;
  c: string;
}

export interface Metric {
  label: string;
  value: string;
}

export interface JourneyNode {
  n: string;
  r: string;
  i: string;
  x: string;
  y: string;
}

export const pillars = [
  'The right person approves',
  'Documents go person to person',
  'Digital signatures (coming soon)',
  'A full history of every step (coming soon)',
  'An AI that knows your policies (coming soon)',
];

export const marquee = [
  'Leave Requests',
  'Purchase Orders',
  'Reimbursement Claims',
  'Contracts & NDAs',
  'Vendor Invoices',
  'HR & Promotion Letters',
  'Architecture reviews',
  'Signature collection',
  'Budget changes',
  'Team approvals',
];

export const quotes: Quote[] = [
  { text: 'Who has the latest version?', sender: 'Finance team' },
  { text: 'Still waiting since last week…', sender: 'Project lead' },
  { text: 'Where is the signed copy?', sender: 'Legal team' },
  { text: 'Can you send that attachment again?', sender: 'Operations' },
];

export const pains = [
  'Documents get lost in emails and chats. Nobody knows who has them.',
  'Everyone has a different version saved on their own computer.',
  'Approvals sit unseen while people keep chasing their managers.',
  'There is no clear proof of who approved what, and when.',
  'Signed copies end up scattered, and are hard to find later.',
  'Simple requests have to climb a long ladder of bosses.',
  'Teams rebuild the same forms again and again.',
];

export const flowSteps: FlowStep[] = [
  { n: 'Draft', c: '#64748B' },
  { n: 'Submitted', c: '#93C5FD' },
  { n: 'Pending', c: '#FCD34D' },
  { n: 'Decision', c: '#6EE7B7' },
  { n: 'Archived', c: '#C4B5FD' },
];

export const stages: Stage[] = [
  {
    name: 'Draft',
    badge: 'Step 1',
    summary: 'Start from a template, or let AI help you write the first draft.',
    details: 'Pick a ready-made template and fill in the blanks. Your work is saved as you go.',
  },
  {
    name: 'Submitted',
    badge: 'Step 2',
    summary: 'Send it off. DocFlow finds the right people.',
    details:
      'Your document goes to the right approvers, and shows up in their queue straight away.',
  },
  {
    name: 'Pending',
    badge: 'Step 3',
    summary: 'Reviewers check it, chat about it, and ask for changes if needed.',
    details:
      'Each reviewer can see who approved before them. If changes are needed, the document comes back to you with notes, and your earlier versions are kept.',
  },
  {
    name: 'Decision',
    badge: 'Step 4',
    summary: 'Approved, rejected, or sent back for changes.',
    details: 'Every decision is saved with who made it and when.',
  },
  {
    name: 'Archived',
    badge: 'Step 5',
    summary: 'Finished documents are stored safely and are easy to find.',
    details: 'Look back at any past document and see its full history whenever you need it.',
  },
];

export const trail = [
  'Drafted from the Leave Request template',
  'In Karthik’s queue',
  'Karthik added a comment',
  'Approved by Karthik · HR can see it',
  'Archived with its full history',
];

export const journeyNodes: JourneyNode[] = [
  { n: 'Priya', r: 'Employee', i: 'P', x: '11%', y: '15%' },
  { n: 'Karthik', r: 'Manager', i: 'K', x: '89%', y: '19%' },
  { n: 'HR', r: 'Next in line', i: 'HR', x: '88%', y: '80%' },
  { n: 'Archive', r: 'Full history', i: 'A', x: '12%', y: '80%' },
];

/** Which node is active at each of the five stages. */
export const activeNodeByStage = [0, 1, 1, 2, 3];

export const docTypes: DocType[] = [
  {
    title: 'Leave Requests',
    category: 'HR & People',
    description: 'Ask for time off and follow the answer.',
  },
  {
    title: 'Purchase Orders',
    category: 'Buying',
    description: 'Ask to buy something and get it approved.',
  },
  {
    title: 'Reimbursement Claims',
    category: 'Finance',
    description: 'Claim back what you spent, with a clear approval trail.',
  },
  {
    title: 'Contracts & NDAs',
    category: 'Legal',
    description: 'Send agreements to the right people for review and sign-off.',
  },
  {
    title: 'Vendor Invoices',
    category: 'Accounts',
    description: 'Check supplier bills and send them for approval.',
  },
  {
    title: 'HR & Promotion Letters',
    category: 'HR',
    description: 'Share sensitive letters only with the people who should see them.',
  },
];

export const roles: Role[] = [
  {
    title: 'Employee / Member',
    badge: 'Everyone',
    tagline: 'Sends documents and acts on the ones sent to them, all in one screen.',
    can: [
      'Create and send documents from templates',
      'Track where your document is right now',
      'Act on documents sent to you',
      'Ask the AI assistant about company policy (coming soon)',
    ],
    cannot: ['Create company-wide templates', 'Change anyone’s role'],
  },
  {
    title: 'Manager / Approver',
    badge: 'Reviewer',
    tagline: 'Reviews documents and makes the call.',
    can: [
      'Approve, reject, or send documents back',
      'Take back an approval before the document is closed',
      'See who approved before you',
      'Sign documents (coming soon)',
    ],
    cannot: ['Add or remove team members', 'Change organization settings'],
  },
  {
    title: 'Department Admin',
    badge: 'Team lead',
    tagline: 'Looks after their own department.',
    can: [
      'Manage the people in your department',
      'Create and manage your department’s templates',
      'Send and track documents like any member',
    ],
    cannot: ['See other departments’ settings', 'Change organization settings'],
  },
  {
    title: 'HR',
    badge: 'People team',
    tagline: 'Sets up departments, people and roles.',
    can: [
      'Set up departments',
      'Add workers and trainees',
      'Manage roles and permissions',
      'Add new templates',
    ],
    cannot: ['Add other HR people', 'Delete users'],
  },
  {
    title: 'Main Admin / Super Admin',
    badge: 'Full control',
    tagline: 'Looks after the whole organization.',
    can: [
      'Everything HR can do',
      'Add HR people',
      'Delete users',
      'Upload company documents for the AI assistant',
      'Manage organization settings',
    ],
    cannot: ['See any other organization’s data'],
  },
  {
    title: 'Intern / Trainee',
    badge: 'Limited access',
    tagline: 'Can send documents, with a safe set of limits.',
    can: ['Create and send documents', 'Track your own documents'],
    cannot: ['Open the Approvals queue', 'Approve or sign anything'],
  },
];

export const ladder = ['You', 'Team lead', 'Manager', 'Director', 'Approver'];

export const apFeatures: TitledDesc[] = [
  {
    title: 'See who approved before you',
    desc: 'Every reviewer can see who approved earlier and what they said.',
  },
  {
    title: 'Changed your mind? Take it back.',
    desc: 'If you spot a mistake after approving, you can revoke your approval. The document stays open until you approve it again.',
  },
  {
    title: 'Send it back with notes',
    desc: 'Ask for changes with clear feedback. A new version is made, and the old ones are kept.',
  },
  {
    title: 'Know when something needs you',
    desc: 'A badge shows what is waiting for you. Email, SMS and push alerts are coming soon.',
  },
];

export const sigs: TitledDesc[] = [
  {
    title: 'Digital signatures',
    desc: 'Planned: a signature that is tied to who signed, which version they signed, and when.',
  },
  {
    title: 'Spot changes after approval',
    desc: 'Planned: DocFlow will flag a document that was changed after it was approved.',
  },
  {
    title: 'Chats saved with the document',
    desc: 'Comments and decisions are stored safely, so you can look back at what was said.',
  },
  {
    title: 'See the full chain',
    desc: 'See who reviewed and approved each step before the document was closed.',
  },
];

export const kb = [
  'Leave Policy',
  'Travel Policy',
  'HR Handbook',
  'Expense Rules',
  'Contract Templates',
  'Code of Conduct',
];

/** Which knowledge-base orb each prompt reads from. */
export const aiSrc = [0, 4, 1];

export const aiAnswers = [
  'I checked your company’s Leave Policy. Your balance and the rules behind it come only from that document, and I’ll point you to the exact section I used.',
  'Here are the key points, taken only from this contract and your company’s own contract templates. Nothing comes from outside your organization.',
  'Let’s start from your reimbursement template. I’ll fill in the blanks and follow your company’s Travel Policy, then you review it and send it.',
];

export const aiNotes = [
  'Your company documents',
  'Your private knowledge base',
  'Docky answers you',
  'Only your organization',
];

export const prompts = [
  'How many leave days do I have this quarter?',
  'Summarize the key points of this contract.',
  'Help me write a travel reimbursement request.',
];

/** Sample figures. The section carries a visible "Sample data" label. */
export const metrics: Metric[] = [
  { label: 'Documents handled', value: '1,420+' },
  { label: 'Average time to approve', value: '3.4 hrs' },
  { label: 'Documents in progress', value: '86' },
  { label: 'Waiting for review', value: '12' },
];

export const bars = [34, 46, 40, 58, 52, 66, 60, 74, 68, 82, 77, 90];

export const callouts = [
  'Each company’s data is kept apart',
  'Files are kept in S3-compatible storage',
  'Each company has its own people and roles',
  'Each company has its own templates',
];

export const tenants = [
  { name: 'Acme Corporation', dot: '#0284C7', edge: 'rgb(2 132 199 / 0.4)', tint: 'rgb(224 242 254 / 0.8)', chip: '#E0F2FE' },
  { name: 'Nexus Logistics', dot: '#4F46E5', edge: 'rgb(79 70 229 / 0.38)', tint: 'rgb(219 234 254 / 0.8)', chip: '#E0E7FF' },
  { name: 'Starlight Technologies', dot: '#9333EA', edge: 'rgb(147 51 234 / 0.35)', tint: 'rgb(237 233 254 / 0.85)', chip: '#F3E8FF' },
];

export const compare: CompareRow[] = [
  {
    capability: 'Where documents go',
    typicalTools: 'Up a fixed ladder of bosses',
    docFlow: 'Straight to the right person',
    h: true,
  },
  {
    capability: 'Templates',
    typicalTools: 'Basic forms or custom code',
    docFlow: 'Reusable templates with AI help',
  },
  {
    capability: 'Signatures',
    typicalTools: 'Pasted signature pictures or paid add-ons',
    docFlow: 'Built-in digital signatures (coming soon)',
    h: true,
  },
  {
    capability: 'History',
    typicalTools: 'A “last edited” date in a spreadsheet',
    docFlow: 'A step-by-step history, with chats saved as records',
  },
  {
    capability: 'AI help',
    typicalTools: 'A generic public AI, or none at all',
    docFlow: 'An AI that answers only from your company’s documents',
    h: true,
  },
  {
    capability: 'Ease of use',
    typicalTools: 'Separate screens for requesters and approvers',
    docFlow: 'One simple screen for everyone',
  },
];

export const trust: TitledDesc[] = [
  { title: 'Secure sign-in', desc: 'Sign-in is handled by Firebase Authentication.' },
  {
    title: 'Separate company data',
    // DEVIATION FROM THE DESIGN. v4 reads: "PostgreSQL keeps each company's
    // data apart, right at the database level." That implies Postgres
    // row-level security, which DocFlow does not use — isolation is enforced
    // in the query layer. This is the wording already approved for facts.ts.
    desc: 'Every query is scoped to the organization, so each tenant’s documents, members and templates stay isolated.',
  },
  { title: 'Safe file storage', desc: 'Documents and files are kept in S3-compatible storage.' },
  {
    title: 'Dependable records',
    desc: 'Approvals, revisions and chats are saved in a database built for reliable records (ACID).',
  },
  {
    title: 'AI that stays optional',
    desc: 'If the AI is ever offline, your documents and approvals keep working.',
  },
  { title: 'Access by role', desc: 'Each person sees and does only what their role allows.' },
];

export const faqs: Faq[] = [
  {
    question: 'What kinds of documents can I use DocFlow for?',
    answer:
      'Almost anything that needs writing, review or approval: leave requests, purchase orders, claims, contracts, invoices, HR letters, architecture reviews and everyday approvals.',
  },
  {
    question: 'Who can approve a document?',
    answer:
      'Managers and other approvers can approve, reject or send documents back. Interns and trainees can send documents, but they cannot approve them.',
  },
  {
    question: 'Can I take back an approval?',
    answer:
      'Yes. If you spot a mistake after approving, you can take your approval back before the document is closed, and the document stays open until you approve it again. This is in progress.',
  },
  {
    question: 'What happens when a document is sent back?',
    answer:
      'The person who sent it gets your notes and can make changes. A new version is created, and the old versions are kept, so nothing is lost.',
  },
  {
    question: 'Is my company data private when I use the AI assistant?',
    answer:
      'Docky is designed to answer only from the documents and policies your own organization uploads. Other organizations never see your documents. The AI assistant is coming soon.',
  },
  {
    question: 'What roles are there?',
    answer:
      'Employee or Member, Manager or Approver, Department Admin, HR, Main Admin or Super Admin, and Intern or Trainee. Each role has its own limits.',
  },
  {
    question: 'Can interns or trainees approve documents?',
    answer:
      'No. Interns and trainees can create and send documents, but they cannot open the Approvals queue or sign anything.',
  },
  {
    question: 'How do I get started?',
    answer:
      'Click Get started. Then set up your departments, add your team, give people their roles, and pick a template to send your first document.',
  },
];

export const navLinks: FooterLink[] = [
  { label: 'How it works', href: '#journey' },
  { label: 'Features', href: '#features' },
  { label: 'Roles', href: '#roles' },
  { label: 'AI Assistant', href: '#ai' },
  { label: 'Security', href: '#security' },
  { label: 'FAQ', href: '#faq' },
];

export const footer: FooterCol[] = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '#journey' },
      { label: 'Document templates', href: '#features' },
      { label: 'Approvals', href: '#approvals' },
      { label: 'Digital signatures', href: '#signatures' },
      { label: 'AI assistant', href: '#ai' },
    ],
  },
  {
    title: 'Control',
    links: [
      { label: 'Roles and access', href: '#roles' },
      { label: 'Step-by-step history', href: '#security' },
      { label: 'Separate company spaces', href: '#tenants' },
      { label: 'Security', href: '#security' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'FAQ', href: '#faq' },
      { label: 'What is live and what is coming', href: '#features' },
      { label: 'Contact us', href: 'mailto:demo@docflow.app' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About DocFlow', href: '#top' },
      { label: 'Privacy Policy', href: '#' },
      { label: 'Terms of Service', href: '#' },
    ],
  },
];

/** Status chip palettes, keyed to the CSS tokens. */
export const stageChips = [
  { label: 'Draft', bg: 'var(--lp-draft-bg)', fg: 'var(--lp-draft-fg)' },
  { label: 'Submitted', bg: 'var(--lp-submitted-bg)', fg: 'var(--lp-submitted-fg)' },
  { label: 'Pending', bg: 'var(--lp-pending-bg)', fg: 'var(--lp-pending-fg)' },
  { label: 'Approved', bg: 'var(--lp-approved-bg)', fg: 'var(--lp-approved-fg)' },
  { label: 'Archived', bg: 'var(--lp-archived-bg)', fg: 'var(--lp-archived-fg)' },
];

export const approvalChips = {
  pending: { label: 'Pending', bg: 'var(--lp-pending-bg)', fg: 'var(--lp-pending-fg)' },
  approved: { label: 'Approved', bg: 'var(--lp-approved-bg)', fg: 'var(--lp-approved-fg)' },
  changes: {
    label: 'Changes requested',
    bg: 'var(--lp-changes-bg)',
    fg: 'var(--lp-changes-fg)',
  },
} as const;

/** Zero-padded index label, e.g. "01". */
export const pad = (i: number) => String(i + 1).padStart(2, '0');

/** Path to the hero/CTA video. Falls back gracefully when absent. */
export const HERO_VIDEO = '/hero-camera-pan.mp4';
