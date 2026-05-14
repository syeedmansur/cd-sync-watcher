# CLAUDE.md — PMPro Design & Development Guidelines

This file captures all design preferences, interaction patterns, backend assumptions, and coding conventions for the PMPro platform. Follow these in every chat — they apply to all contributors.

---

## 1. BRAND & VISUAL IDENTITY

### Colors (from GreenLyne Design System)
- **Primary navy**: `var(--gl-navy)` / `#001660` — used for text, buttons, headers
- **Royal blue**: `var(--gl-royal)` / `#254BCE` — used sparingly for links, active states
- **Dark teal / emerald**: `var(--gl-emerald)` / `#016163` — used for eyebrow labels, section icons, role chips, success states
- **Mint / lime**: `var(--gl-mint)` / `#93DDBA` — used for accents, tier highlights, CTA on dark backgrounds
- **Off-white**: `var(--gl-off-white)` / `#F5F1EE` — warm paper background
- Never invent new colors. Use oklch only to derive harmonious variants of the existing palette.

### Typography
- **Display font**: `var(--font-display)` — Sharp Sans / system fallback. Used for headings, labels, buttons, badges.
- **Body font**: `var(--font-body)` — Used for paragraphs, descriptions, form fields.
- Eyebrow labels: display font, 11px, weight 700, letter-spacing 0.1em, uppercase, emerald color.
- Section titles: display font, 20px, weight 700, navy.
- Button text: display font, 11-14px, weight 700, letter-spacing 0.04em.

### Icons
- Use thin-line Lucide-style icons (stroke-based, not filled).
- Icons are defined in `components/Atoms.jsx` via the `ICONS` object and rendered with the `<Icon>` component.
- When adding new icons, add them to the ICONS object following the same SVG path pattern.
- Every collapsible section on Mission Control has a small icon next to its eyebrow label (emerald colored, 13px, strokeWidth 2).

---

## 2. INTERACTION PATTERNS

### Buttons
- **Default state**: navy outline (`border: 1px solid var(--gl-navy)`), white background, navy text.
- **Hover state**: fill navy background, white text. Always use `onMouseEnter`/`onMouseLeave` handlers.
- **Disabled state**: light grey border, grey text, `opacity: 0.5`, `cursor: not-allowed`.
- **Never** show a button as pre-filled navy unless it represents the current/active state (like active tabs).
- All interactive elements must have hover feedback.

### Dropdowns & Autocomplete
- Support both mouse click and keyboard navigation (Arrow Up/Down to highlight, Enter to select, Escape to dismiss).
- Highlighted items show `background: rgba(0,22,96,0.08)`.
- Dropdowns dismiss on blur (with 150ms delay to allow click-through).
- No letter badges or house icons in company autocomplete — just company name and location text.
- Email autocomplete shows headshot avatar + name + email address.
- Dropdown items should have `tabIndex={-1}` to not interfere with Tab key navigation.

### Hover Bridges
- When a dropdown appears below an icon/avatar on hover, use an invisible "hover bridge" div that extends the hover zone to the full width of the dropdown. This prevents the dropdown from disappearing when the user moves their mouse diagonally to reach it.
- The bridge should only be visible when the dropdown is open.

### Tab Order
- Form fields should have logical tab order. Utility buttons (show/hide password, forgot password) should have `tabIndex={-1}`.
- After the last form field, Tab should land on the submit button.
- Enter on a focused submit button must trigger the form action.

### Collapsible Sections
- Use the `CollapsibleSection` component with `id`, `title`, `eyebrow`, `icon`, and `defaultOpen` props.
- State is persisted in localStorage as `pmpro-collapse-{id}`.
- `headerRight` content (badges, links) is hidden when the section is collapsed.
- On login, localStorage is reset: only "Tools" (id: `lead-mgmt`) is expanded; all others are collapsed.
- "Expand All" and "Collapse All" buttons appear below the greeting on Mission Control.

### Phone Number Formatting
- Store raw digits internally, compute formatted display as `(XXX) XXX-XXXX`.
- Only show the dash when there are 7+ digits.
- Backspace must work smoothly through all formatting characters.

---

## 3. LAYOUT & RESPONSIVENESS

### Global Max-Width
- The entire app (including nav, banners, login page) is capped at `1440px` and centered.
- Outside the app area, the background is white.
- The app shell has a subtle `box-shadow: 0 0 40px rgba(0,0,0,0.06)` to separate it from the white surround.
- Use the CSS class `.app-shell` on the outermost wrapper.

### Mission Control Page Order
1. Referral Banner (tier-aware)
2. Greeting ("Good [time], [Name].")
3. Expand All / Collapse All buttons
4. **Tools**: Prescreen and Leads management (hammer icon) — expanded by default
5. **Your Pulse**: Pipeline KPI cards (activity icon) — collapsed by default
6. **Local Pulse**: Market activity + map (map-pin icon) — collapsed by default
7. **Performance**: Analytics (trend-up icon) — collapsed by default
8. **Priority**: Take action today (target icon) — collapsed by default
9. **Pipeline**: Pipeline pulse (funnel icon) — collapsed by default

---

## 4. USER ADMIN & MULTI-TENANCY

### Company Structure
- Multi-tenant: companies cannot see each other's data.
- **GreenLyne** (Arlington, VA) is a permanent system company, always Tier 5, unlimited credits. Not a mock — real company with real employees.
- **Acme Construction** (Chicago, IL) is a permanent demo company for demonstration purposes.
- Other companies exist as mock data for the Master Admin view.

### User Roles (hierarchy)
1. **Master Admin** — GreenLyne employees only. Full system visibility across all companies. Never need credits.
2. **Super Admin** — highest role within a customer company. Can do everything.
3. **Sub Admin** — can do everything except purchase credits and set quotas.
4. **Staff** — can only run prescreens and send offers.

### GreenLyne Users (real — never change these)
- Joss Tillard-Gates — joss.tillardgates@greenlyne.ai
- Syeed Mansur — smansur@greenlyne.ai
- Asad Hasan — asad.hasan@greenlyne.ai
- Abheek Sambyal — abheek.sambyal@greenlyne.ai

### Role Chips
- All role chips use emerald/teal color scheme from the design system.
- Super Admin and Master Admin: solid emerald background, white text.
- Sub Admin: light emerald background, emerald text.
- Staff: very light emerald background, emerald text.
- All chips have uniform width (110px), center-aligned in the Role column.

### Last-Admin Protection
- If only one Super Admin (or Master Admin) remains active, their deactivate button must be greyed out and disabled.

### User Avatars
- Use real headshot photos, not initials.
- All avatars have a `2px solid var(--gl-navy)` border.
- The top-right nav avatar dynamically matches the logged-in user.
- Syeed Mansur's headshot is at `assets/syeed-mansur.jpeg`.

### Pending Registrations
- The red badge count on the top-right avatar shows the number of pending registrations for the logged-in company.
- This count updates dynamically when admins approve or decline registrations.

---

## 5. AUTHENTICATION

### Login Page
- Full-bleed background image (`assets/login-bg.jpeg`) with subtle navy gradient overlay.
- Floating translucent card (top-left): `background: rgba(255,255,255,0.42)`, `backdrop-filter: blur(16px)`, width 280px.
- Title: "Login" (no period) in Sharp Sans navy.
- Bottom-right: GreenLyne logo (white) + tagline "Equity delivered." (white) + "Deals closed." (mint color) + vertical divider + "Financing by" + Rate logo (white).
- Company and email fields have autocomplete with keyboard navigation.
- "Forgot password?" link: left-aligned, dark blue (#1E40AF).

### Registration Flow
- Multi-step: Company → (Company Creation if new) → User Profile → 2FA → Done.
- Company field: "What company are you with?" with autocomplete from global company list.
- Whoever creates a new company becomes Super Admin automatically.
- GreenLyne email alias auto-generated as `firstname.companyname@greenlyne.io`.
- Phone number auto-formats as user types.
- Avatar upload opens a crop modal (zoom, pan, circular crop).
- "Back to Login screen" arrow link in upper-left on step 1.
- Passwords: 8+ characters, at least one number, one special character. Show inline validation checks.

### Dynamic Consistency
- The company shown in the top nav must match what was entered on the login page.
- The user's name and avatar must be looked up from the user database based on the email used to log in.
- GreenLyne login automatically enables Master Admin mode.

---

## 6. NAVIGATION

### Top Nav
- Two rows: branding row (logo, financing, company+credits) and nav row (Jump To, tabs, help/bell/avatar).
- Nav tabs: Mission Control, CRM Dashboard, Admin.
- Active tab: highlighted background. Inactive tabs highlight on hover.
- Bell icon: opens notification dropdown on hover or click, with hover bridge.
- Avatar: opens dropdown on hover with gear icon + name/company (clickable → profile page) + Logout button (navy fill on hover). Clicking avatar itself → Admin page.

### Admin Dashboard
- Tabbed: Users | Credits | Permissions | Branding | Email Templates.
- Tab icons: users, coins (stacked circles), layers, pen-nib, mail.
- Tabs highlight to navy on hover.
- Master Admin mode shows a company-switcher bar at the top.
- Tier status badge shown in header.

---

## 7. CREDITS & TIERS

### Credit System
- Purchased in batches of $20 = 100 credits.
- 1 credit = 100 property data fetches.
- 1.5 credits = 1 prescreen credit bureau fetch.
- New users get 10 free credits.

### Tier Structure
| Tier | Label | Free Credits/Mo | Price |
|------|-------|----------------|-------|
| 1 | Starter | 10 | Free |
| 2 | Pro | 40 | $30/mo per user |
| 3 | Expert | 60 | $50/mo per user |
| 4 | Elite | 80 | $70/mo per user (referral only) |
| 5 | Partner | 100 | $90/mo per user (referral only) |

- Tiers 4-5 are only available through referrals, not purchase.
- GreenLyne is always Tier 5.

---

## 8. CODING CONVENTIONS

### React / JSX
- All components use window-global pattern: `Object.assign(window, { ComponentName })`.
- Load with `<script type="text/babel" src="...">`.
- Use pinned React 18.3.1, ReactDOM 18.3.1, Babel 7.29.0.
- Style objects must have unique names (never `const styles = {}`).
- Components don't share scope across Babel script files — export to window.

### File Organization
- `index.html` — main entry point, app shell, view routing.
- `components/` — one JSX file per component.
- `assets/` — images (login background, headshots).
- `colors_and_type.css` — design tokens.
- `tweaks-panel.jsx` — tweaks UI framework.

### Consistency Rules
- When implementing a UI pattern, check how it's done elsewhere in the app and match exactly.
- Autocomplete dropdowns on all pages must behave identically (keyboard nav, hover styles, blur dismiss, no icon badges on company lists).
- All buttons follow the navy-outline + hover-fill pattern unless they represent an active/selected state.
- Row hover on tables: `background: rgba(0,22,96,0.06)`.
- Always use `transition: "all 120ms"` on interactive elements.

---

## 9. BACKEND CONTEXT (for frontend code)

The backend uses Supabase (PostgreSQL + Storage + Auth). Key patterns:
- Multi-tenant RLS: users only see their own company's data (except Master Admins).
- Credits are tracked as a transaction ledger, not a simple balance field.
- Permissions are role-based with per-user overrides.
- Email aliases: `firstname.companyname@greenlyne.io` — duplicates get a number appended.
- Stripe for payments (credit purchases + tier subscriptions).
- Twilio for SMS 2FA.
- SendGrid/Resend for transactional emails.

See `BACKEND_REQUIREMENTS.md` for the full backend specification.

---

## 10. PROJECT EXPORT ("download")

When the user says **"download"**:
1. **Generate / update `BACKEND_REQUIREMENTS.md`** — reflect any new backend requirements introduced since the last download. Include only new or changed sections, not the entire spec if nothing changed.
2. **Package only changed files** — the zip should contain only files (code, assets, images) that are new or modified since the last download. Do not re-export unchanged files.
3. **Always include `CLAUDE.md`** in every export so teammates stay in sync.
4. **Always include `BACKEND_REQUIREMENTS.md`** in every export.
5. Track the last download point mentally. If unsure what changed, ask the user before packaging.
