# DocFlow — Approvals Page Spec

Reference: Dashboard screenshot (dark theme, indigo accent)
Confirmed decisions: Status tabs (Pending/Approved/Rejected/All) · Stage shown as text badge, no visual tracker · Bulk select + bulk approve/reject · Row click opens full Document Detail page (own route)

---

## 0. Design tokens carried over from Dashboard (use these everywhere)

**Color**
- Background (page): `#0B0D12`
- Surface / card: `#12141C` with `1px` border `rgba(255,255,255,0.06)`
- Surface hover: `#161923`
- Text primary: `#F5F6F8`
- Text secondary/muted: `#8B90A0`
- Accent / primary (indigo): `#6366F1`, hover `#5457E5`
- Success / approve green: `#22C55E` (bg tint `rgba(34,197,94,0.12)`)
- Danger / reject red: `#EF4444` (bg tint `rgba(239,68,68,0.12)`)
- Warning / pending amber: `#F59E0B` (bg tint `rgba(245,158,11,0.12)`)
- Info / in-review blue: `#3B82F6`
- Divider: `rgba(255,255,255,0.06)`

**Type (Inter or similar)**
- Page title: 28px / 700
- Card/section title: 16–18px / 600
- Body: 14px / 400–500
- Small/meta (timestamps, labels): 12–13px / 400, color muted
- Uppercase eyebrow labels ("ADMINISTRATION"-style): 11px / 600, letter-spacing 0.05em, muted

**Shape & elevation**
- Card radius: 16px
- Button/input radius: 10px
- Avatar/badge radius: full (circle) for avatars, 6–8px for badges
- Shadow: soft, `0 4px 16px rgba(0,0,0,0.25)` — cards sit flat mostly, shadow only on hover/elevated elements (dropdowns, popovers, modals)

**Spacing**
- Page padding: 32px sides
- Card internal padding: 24px
- Vertical rhythm between major sections: 24px
- Row height in lists: 72px (comfortable, matches "Pending Approvals" rows on dashboard)

---

## 1. Top-to-bottom page structure

```
[Top Bar — persistent, same as dashboard]
[Page Header: title + subtitle + primary action]
[Stat strip: 4 small summary tiles]
[Status Tabs]
[Toolbar: search + filters + sort + view density]
[Bulk action bar — appears conditionally]
[Approvals Table]
[Pagination footer]
```

---

## 2. Page Header

- Left: **"Approvals"** (28px/700) with subtitle below in muted 14px: *"Review and act on requests waiting for you"*
- Right: primary button **"+ New Approval Request"** (indigo fill, matches "New Workflow" button style from dashboard — icon + label, 10px radius, `#6366F1` bg)
- Layout: flex row, space-between, aligned to same left/right margins as dashboard content area (not sidebar)

---

## 3. Stat strip (4 tiles, same visual language as dashboard's quick-action tiles)

Row of 4 equal-width cards, 16px gap, each:
- Small icon chip top-left (colored bg tint matching the stat's meaning)
- Big number (24px/700)
- Label below (13px, muted)
- Optional trend delta top-right (small green/red text with arrow, like "+12%" on Statistics card)

Tiles:
1. **Awaiting You** — amber icon (clock) — count of pending items assigned to current user
2. **Awaiting Others** — blue icon (users) — items you submitted, pending elsewhere
3. **Approved (This Month)** — green icon (check)
4. **Rejected (This Month)** — red icon (x)

This gives the page a "status at a glance" moment before the list, consistent with how the dashboard opens with quick actions.

---

## 4. Status Tabs

- Horizontal tab group directly under the stat strip, left-aligned
- Tabs: **Pending · Approved · Rejected · All**
- Style: underline-indicator tab (not pill) — active tab text `#F5F6F8` with a 2px indigo underline; inactive tabs `#8B90A0` text, no underline
- Each tab shows a small count badge next to the label (e.g. "Pending  8") — badge is just muted text, not a colored pill, to avoid competing with the red "5 new" badge style used for notifications elsewhere
- Tab bar bottom border: 1px full-width divider, `rgba(255,255,255,0.06)`

---

## 5. Toolbar (search + filters + sort)

Single row, 16px below tabs, height ~44px:

- **Left:** search input, 320px wide, placeholder "Search approvals...", same style as dashboard's top search bar (dark fill, subtle border, magnifying glass icon left, `⌘K`-style hint optional)
- **Middle-left:** filter chips/dropdowns — "Requester", "Document Type", "Department", "Date" — each a small dropdown button (icon + label + chevron), 10px radius, border-only style (not filled) so they read as secondary to the primary button
- **Right:** sort dropdown ("Newest first" default) + a density/view toggle icon button (list vs comfortable)

Filter chips that are active turn indigo-tinted (bg `rgba(99,102,241,0.12)`, text `#6366F1`, small "x" to clear) so users can see applied filters at a glance.

---

## 6. Bulk action bar (conditional — appears when ≥1 row selected)

- Replaces or overlays the toolbar row when active (slide-down/fade-in, 150–200ms ease-out)
- Left: "3 selected" text + "Clear" link
- Right: two buttons — **Approve Selected** (green fill) and **Reject Selected** (red outline/fill), plus an overflow "•••" for secondary bulk actions (Reassign, Export, Add to Workflow)
- Bar background: slightly elevated surface (`#161923`) with indigo-tinted left border (4px) to signal "action mode" is active — this is a nice modern touch that differentiates it from the static toolbar without introducing a new color language

---

## 7. Approvals Table

**Structure:** table-style rows inside one continuous card (16px radius, matches Pending Approvals card on dashboard), NOT individual boxed cards per row — rows separated by 1px dividers, full-bleed hover highlight.

**Column layout (left to right):**

| Column | Width | Content |
|---|---|---|
| Checkbox | 40px | Row select (appears on hover if not in bulk mode, always visible once any row is selected) |
| Document | flexible (~30%) | File-type icon + document title (14px/600) + requester name · relative time as sub-line (13px, muted) — same pattern as "Q4 Financial Report / Sarah Chen · 2h ago" on dashboard |
| Type/Department | 140px | e.g. "Finance", "Legal" — plain text or subtle tag |
| Stage | 130px | Text badge only (per your decision) — e.g. "Stage 2 of 3 · Review" as a small pill: neutral gray bg, no strong color unless status is Rejected (red) or fully Approved (green) |
| Requested | 110px | Relative date, muted 13px |
| Status | 110px | Pill badge: Pending (amber), Approved (green), Rejected (red) |
| Quick Actions | 100px | Two icon buttons — green check circle, red x circle — identical style to dashboard's approve/reject icons in Pending Approvals card. Only shown for Pending tab. |

**Row states:**
- Default: transparent bg
- Hover: bg `#161923`, cursor pointer, quick-action icons become fully opaque (subtle: they can sit at 70% opacity at rest, 100% on hover, to reduce visual noise when scanning)
- Selected (checkbox checked): bg `rgba(99,102,241,0.08)`, left 3px indigo accent border
- Clicking anywhere on the row except checkbox/action icons → navigates to Document Detail page (own route, per your decision)

**Empty state** (e.g. "Rejected" tab with nothing): centered icon illustration (simple line icon, muted), "No rejected approvals" text, and if on Pending tab with zero items, a friendly "You're all caught up 🎉" message — keeps tone consistent with the dashboard's casual "Welcome back 👋" voice.

**Loading state:** skeleton rows (shimmer bg blocks matching column shapes) — 5–6 skeleton rows, subtle pulse animation.

---

## 8. Pagination footer

- Bottom of the table card, or just below it
- Left: "Showing 1–10 of 42"
- Right: standard prev/next + page number pills, indigo active state matching tab/button accent

---

## 9. Interactions & modern UI polish (beyond static layout)

- **Row hover:** background fade transition (150ms), not instant — makes scanning feel responsive
- **Tab switch:** content cross-fades (120ms) rather than hard-cutting, avoids jarring reflow
- **Approve/Reject icon click (quick action):** micro-interaction — icon briefly scales up (1.0 → 1.15 → 1.0) and the row fades out/collapses (250ms) if it leaves the current tab (e.g. approving on Pending tab removes it from view), rather than just vanishing instantly
- **Bulk bar:** slide+fade in from top of table area when first checkbox is ticked
- **Filter dropdowns:** open as small elevated popovers with the card shadow token, close on outside click, checkbox-style multi-select inside
- **Status badge:** no animation needed, but on Approved/Rejected transition (if watched live), a brief color flash/pulse (like a toast-adjacent confirmation) reinforces the action succeeded
- **Toast confirmation:** bottom-right toast ("3 items approved") on bulk actions, auto-dismiss 4s, matches dark surface + colored left border pattern used in the bulk bar for consistency

---

## 10. Consistency checklist against Dashboard

- ✅ Same top bar (search, bell, avatar+name+chevron) — unchanged across all pages
- ✅ Same left sidebar, "Approvals" item active/highlighted (indigo bg on nav item, matching how "Dashboard" is highlighted now)
- ✅ Card radius, border, and padding identical to dashboard cards
- ✅ Avatar-with-initials pattern reused for requester identity
- ✅ Green/red icon-button pair for approve/reject reused verbatim from dashboard's Pending Approvals widget — this page is essentially that widget's "expanded" form, so visual continuity should feel intentional
- ✅ Badge/pill style (rounded, small, colored bg tint + colored text, no heavy borders) reused from "5 new" / "Live" / "100%" dashboard badges

---

## Open items for next pass
- Document Detail page (where row clicks land) — separate spec needed
- Exact icon set (Lucide recommended, matches the line-icon style visible on dashboard)
- Mobile/responsive collapse behavior for the table (likely converts to stacked cards under ~768px)