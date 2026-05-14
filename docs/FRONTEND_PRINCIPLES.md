# FRONTEND_PRINCIPLES.md — PMPro Design Principles & Guidelines

These are the guiding principles for designing and building the PMPro platform. Follow these in every chat — they apply to all contributors. When in doubt, refer to the existing app for precedent.

---

## 1. VISUAL IDENTITY

- Use the GreenLyne Design System (`colors_and_type.css`) as the single source of truth for colors, fonts, and spacing.
- The palette is intentionally restrained: navy, royal blue, dark teal/emerald, mint/lime, and warm off-white. Never invent new colors.
- Icons are thin-line, stroke-based (Lucide-style). Never use filled icons.
- Avoid AI design tropes: no gratuitous gradients, no emoji, no rounded-corner cards with left-border accents, no generic illustrations.

---

## 2. INTERACTION PHILOSOPHY

- **Every interactive element must give hover feedback.** Buttons, rows, tabs, avatars — nothing should feel dead on mouseover.
- **Buttons default to outline style** (navy border, white background). They fill navy on hover. A button should only appear pre-filled if it represents an active/selected state.
- **Disabled elements** are visually muted (light grey, reduced opacity) and non-interactive. Never allow destructive actions on protected items (e.g., the last admin cannot be deactivated).
- **Dropdowns and autocompletes** must support both mouse and keyboard navigation (arrow keys, Enter, Escape). They should dismiss on blur.
- **Hover bridges**: when a dropdown appears near an icon, ensure the user can move their mouse to the dropdown without it disappearing. Use invisible hover zones.
- **Tab order matters**: utility controls (show/hide password, forgot password links) should not interfere with the primary form flow. Tab should go from the last field straight to the submit button.
- **Phone numbers auto-format** as the user types. Backspace must work smoothly through formatting characters.

---

## 3. LAYOUT PRINCIPLES

- The app has a **global max-width of 1440px**, centered on screen. Beyond that width, the background is white. This applies to every page, including login.
- **Mission Control** is organized as a series of collapsible sections. On login, only the first section (Tools) is expanded — the rest are collapsed. Each section has an eyebrow label with a thin-line icon.
- **Collapsible section extras** (badges, links) are hidden when the section is collapsed — they only appear when expanded.
- **Expand All / Collapse All** buttons sit below the greeting. They intelligently disable when everything is already in the target state.

---

## 4. CONSISTENCY & COMPONENT REUSE

- **If a pattern exists somewhere in the app, replicate it exactly everywhere.** Never introduce variations of an established component or behavior.
- **Before building anything new**, check how similar elements behave elsewhere in the app. Match the implementation, not just the appearance.
- **Be a smart developer**: if a user has already defined a component, interaction, or behavior on one page, reuse it on every subsequent page that needs it. Do not rebuild from scratch. If a dropdown, button style, animation, or form pattern has been established, import and apply the same approach — do not create a second version.
- **At the start of every chat**, read `FRONTEND_PRINCIPLES.md` and commit it to memory before doing any work.

### Button Behavior (reuse everywhere)
- Default: `1px solid var(--gl-navy)` border, white background, navy text.
- Hover: fill `var(--gl-navy)` background, white text. Use `onMouseEnter`/`onMouseLeave`.
- Disabled: `1px solid var(--gl-paper-3)`, grey text, `opacity: 0.5`, `cursor: not-allowed`.
- Transition: `all 120ms` on all interactive elements.
- A button only appears pre-filled navy if it represents a current/active state (e.g., active tab).

### Autocomplete Dropdowns (reuse everywhere)
- **Keyboard navigation**: Arrow Up/Down to highlight, Enter to select, Escape to dismiss.
- **Highlight style**: `background: rgba(0,22,96,0.08)` on the active item.
- **Blur dismiss**: dropdowns close on field blur with a 150ms delay (to allow click-through on items).
- **Tab isolation**: dropdown items have `tabIndex={-1}` so they don't capture Tab key focus.
- **Company autocomplete**: text only — company name + location. No icon badges.
- **Email autocomplete**: headshot avatar (navy border) + name + email address.
- **Hover bridge**: invisible div extending the hover zone to the full dropdown width, only visible when dropdown is open. Prevents dropdown from disappearing when mouse moves diagonally.
- **Animation**: dropdowns appear instantly (no fade-in delay).

### Collapsible Sections (reuse everywhere)
- Component: `CollapsibleSection` with props: `id`, `title`, `eyebrow`, `icon`, `defaultOpen`, `headerRight`.
- State persisted in localStorage as `pmpro-collapse-{id}`.
- `headerRight` content (badges, links like "LIVE" or "Open CRM Dashboard") hidden when collapsed.
- Collapse/expand chevron rotates 90° with `transition: transform 220ms`.

### Table Rows (reuse everywhere)
- Hover: `background: rgba(0,22,96,0.06)` with `transition: background 80ms`.
- Cursor: pointer on hoverable rows.
- Grid layout with consistent column sizing across header and data rows.

### Avatars (reuse everywhere)
- Always use real headshot photos, never initials (unless no photo exists as fallback).
- Border: `2px solid var(--gl-navy)`.
- Circular (`border-radius: 50%`, `object-fit: cover`).
- The top-right nav avatar always dynamically matches the logged-in user.

### Role Chips (reuse everywhere)
- Uniform width: 110px, center-aligned.
- Color scheme: emerald/teal from design system.
- Super Admin / Master Admin: solid emerald background, white text.
- Sub Admin: light emerald background (`rgba(1,97,99,0.15)`), emerald text.
- Staff: very light emerald background (`rgba(1,97,99,0.08)`), emerald text.
- Font: display font, 10px, weight 700, letter-spacing 0.06em, uppercase.

### Phone Number Input (reuse everywhere)
- Store raw digits internally; display formatted as `(XXX) XXX-XXXX`.
- Dash only appears when 7+ digits are entered.
- Backspace works smoothly through all formatting characters (no cursor sticking).

### Modal Dialogs (reuse everywhere)
- Overlay: `rgba(0,22,96,0.5)` or `rgba(0,22,96,0.6)`.
- Card: white, `border-radius: 12px`, `padding: 28-32px`, `box-shadow: 0 20px 60px rgba(0,0,0,0.2)`.
- Close button: top-right, uses `ICONS.close`.
- Click outside the card to dismiss.
- Action buttons follow the standard navy outline + hover fill pattern.

### Tab Bars (reuse everywhere)
- Active tab: navy text, `2px solid var(--gl-navy)` bottom border, subtle background `rgba(0,22,96,0.06)`.
- Inactive tab: muted text, transparent bottom border.
- Hover on inactive: background fills to `rgba(0,22,96,0.06)`, text + icon color change to navy.

### Notification Badge (reuse everywhere)
- Red circle (`#dc2626`), white text, display font weight 800, 9px.
- Positioned `top: -4px, right: -6px` relative to the parent icon.
- Bordered with `2px solid var(--gl-navy)` to separate from the nav background.

---

## 5. MULTI-TENANCY & USER MODEL

- This is a multi-tenant app. Companies cannot see each other's data.
- **GreenLyne** (Arlington, VA) is the system company — real, not mock. Its users are Master Admins with unlimited credits and full cross-company visibility. Never change their names or emails.
- **Acme Construction** is a permanent demo company used for demonstrations.
- The role hierarchy is: Master Admin > Super Admin > Sub Admin > Staff. Each level inherits downward permissions.
- When a GreenLyne user logs in, Master Admin mode activates automatically.
- The data shown throughout the app (users, pending registrations, credits, notifications) must reflect the company the user logged in as. Dynamic consistency must be preserved across the entire app.

---

## 6. AUTHENTICATION UX

- The login page is the app's front door — it should feel inviting. Full-bleed background image, translucent floating card, brand presence.
- Registration is a multi-step flow: Company lookup → User profile → 2FA → Done.
- Whoever creates a new company is automatically the Super Admin.
- Every user gets a GreenLyne email alias (`firstname.companyname@greenlyne.io`) that cannot be changed.
- Passwords require 8+ characters, at least one number, one special character. Show inline validation.
- 2FA via SMS is required for registration and password reset.

---

## 7. CREDITS & TIERS

- Credits are purchased in $20 batches (100 credits each). New users get 10 free.
- Property data fetches cost 1 credit per 100 fetches. Prescreen bureau fetches cost 1.5 credits each.
- There are 5 tiers. Tiers 1-3 can be purchased; tiers 4-5 are referral-only.
- GreenLyne is always Tier 5 with unlimited credits.
- The referral banner on Mission Control dynamically reflects the company's actual tier.

---

## 8. NOTIFICATION PATTERNS

- The bell icon opens a notification dropdown with All/Unread tabs, mark-as-read, and a link to full notifications.
- Notifications are generated server-side for events like: pending registrations, credit deposits, offers opened, prescreens completed, role changes, low credit warnings, referral milestones.
- The pending registration count badge on the user avatar updates in real time when admins approve or decline.

---

## 9. EXPORT & HANDOFF

- When the user says **"download"**, package only files that changed since the last download.
- Always include `FRONTEND_PRINCIPLES.md` and `BACKEND_REQUIREMENTS.md` in every export.
- `BACKEND_REQUIREMENTS.md` should be updated to reflect any new backend requirements introduced since the last download.
- The export zip is designed to be handed directly to Claude Code for backend implementation. Frontend files should be used as-is — Claude Code should never rebuild the UI.

---

## 10. BACKEND CONTEXT

The backend uses Supabase (PostgreSQL + Storage + Auth), Stripe (payments), Twilio (SMS 2FA), and SendGrid/Resend (transactional email). See `BACKEND_REQUIREMENTS.md` for full specifications.

Key architectural points:
- Multi-tenant row-level security: users only see their own company's data (except Master Admins).
- Credits are tracked as a transaction ledger.
- Permissions are role-based with per-user overrides.
- Email aliases follow the pattern `firstname.companyname@greenlyne.io` with numeric suffixes for duplicates.
- Companies are never deleted, only deactivated.
