# Meru RegOS — Design Guidelines & Brand System

> **Version**: 1.1 | **Status**: Living Document
> **Owner**: Meru Platform Team | **Last Updated**: 2026-05-31
>
> The definitive design system for all Meru products — shared tokens, component patterns, layout conventions, and brand expression across verticals.
>
> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRD.md](./PRD.md) · [DEVELOPMENT_STRATEGY.md](./DEVELOPMENT_STRATEGY.md)

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Brand Architecture](#2-brand-architecture)
3. [Color System](#3-color-system)
4. [Typography](#4-typography)
5. [Spacing & Layout](#5-spacing--layout)
6. [Border Radius & Elevation](#6-border-radius--elevation)
7. [Component Library](#7-component-library)
8. [Layout Patterns](#8-layout-patterns)
9. [Form Design](#9-form-design)
10. [Motion & Animation](#10-motion--animation)
11. [Iconography](#11-iconography)
12. [Data Visualization](#12-data-visualization)
13. [Internationalization & RTL](#13-internationalization--rtl)
14. [Accessibility](#14-accessibility)
15. [Tenant Branding](#15-tenant-branding)
16. [Portal-Specific Patterns](#16-portal-specific-patterns)
17. [Asset & Illustration Guidelines](#17-asset--illustration-guidelines)

---

## 1. Design Principles

### 1.1 "Linear Polish"

All Meru products share these principles:

| Principle | What It Means | Implementation |
|---|---|---|
| **Information-dense but breathable** | Show enough data to be useful, enough whitespace to be readable | Card grids with 1.5rem gap, page padding of 1.5-2rem |
| **Fast, not flashy** | Micro-interactions under 200ms, no heavy animation libraries | CSS transitions + framer-motion `duration: 0.15-0.2` |
| **Dark first** | Dark mode is the default design target, light mode is the adaptation | All colors defined as CSS variables, tested in both modes |
| **Command-native** | Every portal starts with a natural-language command bar | Cmd+K palette on every page; AI chat as the home screen |
| **Accessible by default** | WCAG 2.1 AA minimum, AAA where possible | 44px touch targets, 4.5:1 contrast, keyboard navigation |
| **Vertical-adaptable** | The design system is shared; the brand expression is per-vertical | CSS variables for colors; JSON config for branding |

### 1.2 The 80/20 of Meru Design

```
80% SHARED                         20% PER-VERTICAL
┌──────────────────────────┐      ┌──────────────────┐
│ Layout patterns           │      │ Primary color     │
│ Component structure       │      │ Accent color      │
│ Typography scale          │      │ Font family       │
│ Spacing grid              │      │ Illustration style│
│ Motion language           │      │ Terminology       │
│ Icon set                  │      │ Dashboard widgets │
│ Form patterns             │      │ Vertical-specific │
│ Accessibility rules       │      │ page templates    │
└──────────────────────────┘      └──────────────────┘
```

---

## 2. Brand Architecture

### 2.1 Brand Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    MERU (Parent Brand)                        │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Primary: Navy #1A2B4A  |  Accent: Teal #0D8A8A          ││
│  │ Font: IBM Plex Sans    |  Radius: 12px                   ││
│  └─────────────────────────────────────────────────────────┘│
│                            │                                  │
│         ┌──────────────────┼──────────────────┐              │
│         │                  │                  │              │
│  ┌──────▼──────┐   ┌───────▼──────┐   ┌──────▼──────┐      │
│  │ IMMISTACK   │   │ GOVERNANCEX  │   │  MERU ADMIN │      │
│  │ (Immig.)    │   │ (Banking)    │   │  (God View) │      │
│  │             │   │              │   │             │      │
│  │ Blue        │   │ Navy         │   │ Navy/Teal   │      │
│  │ #1D4ED8     │   │ #1A2B4A      │   │ #1A2B4A     │      │
│  │ Inter       │   │ IBM Plex     │   │ IBM Plex    │      │
│  │ 8px radius  │   │ 12px radius  │   │ 12px radius │      │
│  └─────────────┘   └──────────────┘   └─────────────┘      │
│                                                              │
│  Future: Health (green), Tax (amber), Labour (orange),      │
│  Education (purple) — each inherits Meru base, customizes   │
│  one brand color + font                                      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Vertical Brand Matrix

| Vertical | Primary HSL | Hex | Personality | Font Recommendation |
|---|---|---|---|---|
| **Meru Core** | 214 47% 19% (Navy) | #1A2B4A | Trusted, authoritative | IBM Plex Sans |
| **ImmiStack** | 221 83% 37% (Blue) | #1D4ED8 | Professional, efficient | Inter |
| **GovernanceX** | 214 47% 19% (Navy) | #1A2B4A | Serious, secure | IBM Plex Sans |
| **Health** | 160 84% 39% (Green) | #10B981 | Clinical, precise | Inter |
| **Tax** | 37 95% 54% (Amber) | #F5A623 | Confident, clear | Inter |
| **Labour** | 25 95% 53% (Orange) | #F97316 | Pragmatic, direct | IBM Plex Sans |
| **Education** | 262 83% 58% (Purple) | #8B5CF6 | Academic, structured | Inter |

---

## 3. Color System

### 3.1 Core Palette (Shared)

These HSL-based CSS variables are the foundation. Every vertical customizes the hue/saturation/lightness values but preserves the token names.

```css
:root {
  /* ── Surface Colors ── */
  --background: 220 20% 98%;           /* Page background */
  --foreground: 214 47% 19%;           /* Primary text */
  --card: 0 0% 100%;                   /* Card/container background */
  --card-foreground: 214 47% 19%;      /* Card text */
  --popover: 0 0% 100%;                /* Dropdown/popover background */
  --popover-foreground: 214 47% 19%;   /* Popover text */

  /* ── Brand Colors ── */
  --primary: 214 47% 19%;              /* Primary brand color (navy) */
  --primary-foreground: 0 0% 100%;     /* Text on primary */
  --accent: 180 85% 30%;              /* Accent/interactive color (teal) */
  --accent-foreground: 0 0% 100%;      /* Text on accent */
  --cta: 37 95% 54%;                   /* Call-to-action color (amber) */
  --cta-foreground: 214 47% 19%;       /* Text on CTA */

  /* ── Semantic Colors ── */
  --success: 142 71% 45%;              /* Success states */
  --success-foreground: 0 0% 100%;
  --warning: 37 95% 54%;               /* Warning states */
  --warning-foreground: 214 47% 19%;
  --destructive: 0 84% 60%;            /* Error/destructive states */
  --destructive-foreground: 0 0% 100%;

  /* ── Neutral Colors ── */
  --secondary: 220 20% 95%;            /* Secondary surfaces */
  --secondary-foreground: 214 47% 19%;
  --muted: 220 20% 95%;                /* Muted/de-emphasized surfaces */
  --muted-foreground: 214 20% 50%;     /* De-emphasized text */
  --border: 220 20% 91%;               /* Borders, dividers */
  --input: 220 20% 91%;                /* Input field borders */
  --ring: 180 85% 30%;                 /* Focus rings */

  /* ── Sidebar ── */
  --sidebar-background: 214 47% 19%;   /* Sidebar surface */
  --sidebar-foreground: 214 20% 80%;   /* Sidebar text */
  --sidebar-accent: 214 47% 25%;       /* Active sidebar item */
  --sidebar-accent-foreground: 0 0% 100%;
  --sidebar-border: 214 47% 25%;       /* Sidebar dividers */

  /* ── Border Radius Scale ── */
  --radius: 0.75rem;                   /* Base radius (12px) */
}
```

### 3.2 Dark Mode

```css
.dark {
  --background: 214 47% 6%;            /* Deep navy background */
  --foreground: 220 20% 90%;           /* Light text */
  --card: 214 47% 10%;                 /* Card surface */
  --card-foreground: 220 20% 90%;
  --popover: 214 47% 12%;
  --popover-foreground: 220 20% 90%;

  --primary: 180 85% 45%;              /* Bright teal as primary in dark */
  --primary-foreground: 214 47% 6%;
  --accent: 180 85% 40%;
  --accent-foreground: 214 47% 6%;
  --cta: 37 95% 54%;
  --cta-foreground: 214 47% 6%;

  --secondary: 214 47% 14%;
  --secondary-foreground: 220 20% 90%;
  --muted: 214 47% 14%;
  --muted-foreground: 214 20% 55%;
  --border: 214 47% 18%;
  --input: 214 47% 18%;
  --ring: 180 85% 45%;

  --sidebar-background: 214 47% 8%;
  --sidebar-foreground: 214 20% 70%;
  --sidebar-accent: 214 47% 16%;
  --sidebar-accent-foreground: 220 20% 90%;
  --sidebar-border: 214 47% 16%;
}
```

### 3.3 Semantic Color Usage

| Color | When to Use | Never Use For |
|---|---|---|
| `--primary` | Buttons, links, active states, selected items | Error states, destructive actions |
| `--accent` | Interactive elements, progress indicators, badges | Primary CTAs (use `--cta` for main action) |
| `--cta` | Primary call-to-action button, upgrade prompts | Regular navigation |
| `--success` | Confirmation toasts, approved statuses, completed states | Informational messages |
| `--warning` | Pending reviews, approaching deadlines, medium risk | Critical errors |
| `--destructive` | Delete buttons, error toasts, high risk, overdue items | Warnings or informational messages |
| `--muted` | Secondary text, disabled states, placeholder text | Body copy, labels |

### 3.4 Data Visualization Palette

Accessible, colorblind-friendly chart colors:

```css
--chart-1: 221 83% 37%;    /* Blue */
--chart-2: 180 85% 30%;    /* Teal */
--chart-3: 37 95% 54%;     /* Amber */
--chart-4: 142 71% 45%;    /* Green */
--chart-5: 262 83% 58%;    /* Purple */
--chart-6: 0 84% 60%;      /* Red */
--chart-7: 25 95% 53%;     /* Orange */
--chart-8: 214 20% 50%;    /* Grey */
```

---

## 4. Typography

### 4.1 Font Stack

```css
/* Sans-serif (primary UI font) */
--font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;

/* Arabic (RTL) */
--font-arabic: 'IBM Plex Sans Arabic', 'Noto Naskh Arabic', sans-serif;

/* Display (headings, logo) */
--font-display: 'Calistoga', 'Georgia', serif;

/* Monospace (code, data) */
--font-mono: 'Geist Mono', 'JetBrains Mono', 'Fira Code', monospace;
```

### 4.2 Type Scale

```
┌──────────────┬──────────┬──────────┬──────────────┬──────────────┐
│  Token       │  Size    │  Weight  │  Line Height │  Use         │
├──────────────┼──────────┼──────────┼──────────────┼──────────────┤
│  display     │  30px    │  300     │  1.2         │  Hero pages  │
│  heading-1   │  28px    │  600     │  1.25        │  Page titles │
│  heading-2   │  22px    │  600     │  1.3         │  Section hdrs│
│  heading-3   │  18px    │  500     │  1.35        │  Card titles │
│  heading-4   │  16px    │  500     │  1.4         │  Sub-headers │
│  body-lg     │  15px    │  400     │  1.5         │  Long text   │
│  body        │  14px    │  400     │  1.5         │  Default     │
│  body-sm     │  12px    │  400     │  1.5         │  Meta, help  │
│  label       │  11px    │  500     │  1.4         │  Labels      │
│  caption     │  10px    │  400     │  1.4         │  Captions    │
│  mono        │  14px    │  400     │  1.5         │  Code, data  │
└──────────────┴──────────┴──────────┴──────────────┴──────────────┘
```

### 4.3 Typography Rules

1. **One font stack per product**. Never mix IBM Plex and Inter in the same portal.
2. **Display font is decorative only**. Use Calistoga for logo, hero headings, and onboarding — never for body text or UI labels.
3. **Line height ≥ 1.5 for body text**. For Arabic, line height should be ≥ 1.6 due to taller character forms.
4. **Letter spacing**: Normal for body, `-0.02em` for headings, `+0.05em` for labels (uppercase).
5. **Font weight jumps**: Only use 300, 400, 500, 600, 700. Never 350, 450, etc.

### 4.4 Tailwind Configuration

```typescript
// tailwind.config.ts
export default {
  theme: {
    fontFamily: {
      sans: ['var(--font-sans)', 'IBM Plex Sans', 'sans-serif'],
      arabic: ['var(--font-arabic)', 'IBM Plex Sans Arabic', 'sans-serif'],
      display: ['var(--font-display)', 'Calistoga', 'serif'],
      mono: ['var(--font-mono)', 'Geist Mono', 'monospace'],
    },
    fontSize: {
      display: ['30px', { lineHeight: '1.2', fontWeight: '300' }],
      'heading-1': ['28px', { lineHeight: '1.25', fontWeight: '600' }],
      'heading-2': ['22px', { lineHeight: '1.3', fontWeight: '600' }],
      'heading-3': ['18px', { lineHeight: '1.35', fontWeight: '500' }],
      'heading-4': ['16px', { lineHeight: '1.4', fontWeight: '500' }],
      'body-lg': ['15px', { lineHeight: '1.5', fontWeight: '400' }],
      body: ['14px', { lineHeight: '1.5', fontWeight: '400' }],
      'body-sm': ['12px', { lineHeight: '1.5', fontWeight: '400' }],
      label: ['11px', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.05em' }],
      caption: ['10px', { lineHeight: '1.4', fontWeight: '400' }],
      mono: ['14px', { lineHeight: '1.5', fontFamily: 'var(--font-mono)' }],
    },
  },
};
```

---

## 5. Spacing & Layout

### 5.1 Spacing Scale

Built on Tailwind's default 4px grid:

```
0   = 0px        (nothing)
px  = 1px        (hairline borders)
0.5 = 2px        (icon offsets)
1   = 4px        (tight inline gap)
1.5 = 6px        (badge padding-y)
2   = 8px        (inline gap, card content gap)
2.5 = 10px       (nav item gap)
3   = 12px       (section item gap)
3.5 = 14px       (uncommon)
4   = 16px       (card padding, section gap)
5   = 20px       (card padding, relaxed)
6   = 24px       (page padding, section gap)
8   = 32px       (large section gap)
10  = 40px       (hero spacing)
12  = 48px       (page-top padding)
16  = 64px       (hero sections)
```

### 5.2 Layout Grid

```
┌─────────────────────────────────────────────────────────┐
│                    CONTAINER (max-w 1400px)              │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  page padding: 1.5rem (mobile) / 2rem (desktop)   │ │
│  │                                                    │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │ │
│  │  │  Card    │  │  Card    │  │  Card    │        │ │
│  │  │          │  │          │  │          │        │ │
│  │  └──────────┘  └──────────┘  └──────────┘        │ │
│  │                                                    │ │
│  │  Card grid gap: 1.5rem (6)                         │ │
│  │  Dashboard: 12-column CSS grid                     │ │
│  │  Form: max-w-2xl (672px) centered or max-w-3xl    │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Page Layout Templates

**Dashboard (default)**:
```
┌──────────────────────────────────────────────┐
│  Page Header (flex justify-between)           │
│  ┌──────────┬──────────┬──────────┬────────┐ │
│  │ Stat     │ Stat     │ Stat     │ Stat   │ │
│  │ Card     │ Card     │ Card     │ Card   │ │
│  └──────────┴──────────┴──────────┴────────┘ │
│  ┌─────────────────────┐ ┌──────────────────┐│
│  │ Main content (8col) │ │ Side (4col)      ││
│  │ Charts / Table      │ │ Recent activity  ││
│  └─────────────────────┘ └──────────────────┘│
└──────────────────────────────────────────────┘
```

**Detail page**:
```
┌──────────────────────────────────────────────┐
│  Back button + Page title + Action buttons    │
│  ┌──────────────────────────────────────────┐│
│  │  Tab: Overview | Documents | Tasks | ... ││
│  ├──────────────────────────────────────────┤│
│  │  ┌──────────────────┐ ┌────────────────┐ ││
│  │  │ Detail section   │ │ Metadata panel │ ││
│  │  │                  │ │                │ ││
│  │  │ (8 col)          │ │ (4 col)        │ ││
│  │  └──────────────────┘ └────────────────┘ ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

**List/Table page**:
```
┌──────────────────────────────────────────────┐
│  Page title + Search + Filter + Create btn   │
│  ┌──────────────────────────────────────────┐│
│  │  ┌────────┐ ┌────────┐ ┌────────┐       ││
│  │  │ Filter │ │ Filter │ │ Filter │        ││
│  │  └────────┘ └────────┘ └────────┘        ││
│  ├──────────────────────────────────────────┤│
│  │  Data Table (full width)                  ││
│  │  ─────────────────────────────────────── ││
│  │  ─────────────────────────────────────── ││
│  │  ─────────────────────────────────────── ││
│  ├──────────────────────────────────────────┤│
│  │  Pagination                               ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

---

## 6. Border Radius & Elevation

### 6.1 Border Radius Scale

```
┌───────────────┬──────────┬───────────────────────────────────┐
│  Token        │  Value   │  Usage                             │
├───────────────┼──────────┼───────────────────────────────────┤
│  --radius     │  0.75rem │  Base (12px) — GovernanceX style  │
│  rounded-sm   │  0.5rem  │  Small containers, input groups   │
│  rounded-md   │  0.625rem │  Buttons (default), inputs        │
│  rounded-lg   │  0.75rem │  Buttons (GovernanceX), menu items│
│  rounded-xl   │  1rem     │  Cards, dialogs, dropdowns       │
│  rounded-2xl  │  1rem     │  Stats cards, featured containers │
│  rounded-3xl  │  1.5rem   │  Large containers, hero sections │
│  rounded-full │  9999px   │  Badges, avatars, pills, toggles │
└───────────────┴──────────┴───────────────────────────────────┘
```

**Vertical override**: ImmiStack uses `--radius: 0.5rem` (8px base). GovernanceX uses `--radius: 0.75rem` (12px base). This is the primary visual differentiator between products.

### 6.2 Shadow Scale

```css
/* Elevation levels */
--shadow-xs:   0 1px 2px 0 rgb(0 0 0 / 0.05);
--shadow-sm:   0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06);
--shadow-md:   0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.06);
--shadow-lg:   0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.06);
--shadow-xl:   0 20px 25px -5px rgb(0 0 0 / 0.10), 0 8px 10px -6px rgb(0 0 0 / 0.06);
--shadow-2xl:  0 25px 50px -12px rgb(0 0 0 / 0.15);

/* Brand glows */
--shadow-teal-glow:  0 0 24px hsl(180 85% 30% / 0.2);
--shadow-navy-glow:  0 0 24px hsl(214 47% 19% / 0.15);
--shadow-amber-glow: 0 0 24px hsl(37 95% 54% / 0.3);
```

### 6.3 Elevation Usage

| Element | Shadow | Border |
|---|---|---|
| Page background | None | None |
| Card (default) | `shadow-sm` | `border` |
| Card (hover) | `shadow-md` | `border` |
| Dropdown/Popover | `shadow-lg` | `border` |
| Dialog/Modal | `shadow-xl` | `border` |
| Drawer/Sheet | `shadow-2xl` | `border-l` |
| Toast | `shadow-lg` | `border` |
| Command Palette | `shadow-2xl` | `border` |

### 6.4 Z-Index Scale

```
z-0:    Content (default)
z-10:   Sticky headers, table headers
z-20:   Sidebar
z-30:   Dropdown menus, popovers
z-40:   Dialogs, modals, sheets
z-50:   Toasts, notifications, tooltips
z-60:   Command palette
```

---

## 7. Component Library

### 7.1 Button

**Variants**: `default`, `teal`, `cta`, `destructive`, `outline`, `secondary`, `ghost`, `link`, `success`, `warning`

**Sizes**: `sm` (h-9, text-xs), `default` (h-11, text-sm), `lg` (h-14, text-base), `xl` (h-16, text-lg), `icon` (h-11 w-11)

```html
<!-- Default (Primary action) -->
<button class="inline-flex items-center justify-center rounded-lg h-11 px-4
               bg-primary text-primary-foreground text-sm font-medium
               hover:opacity-90 hover:shadow-md
               active:scale-[0.98]
               focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
               disabled:opacity-50 disabled:pointer-events-none
               transition-all duration-200">
  <Icon class="mr-2 h-4 w-4" />
  Label
</button>
```

**Button with loading state**:
```html
<button disabled class="...">
  <Spinner class="mr-2 h-4 w-4 animate-spin" />
  Processing...
</button>
```

**Rules**:
- Minimum touch target: 44×44px (accessibility)
- Maximum one CTA button per page section (amber)
- Default buttons should be navy/primary, not teal
- Destructive buttons must have a confirmation dialog
- Icon-only buttons always include a `aria-label`
- Loading state disables the button and shows a spinner

### 7.2 Input

```html
<div class="space-y-2">
  <Label htmlFor="email" class="text-sm font-medium">
    Email <span class="text-destructive">*</span>
  </Label>
  <Input
    id="email"
    type="email"
    placeholder="name@example.com"
    class="h-11 rounded-lg border-input bg-background"
  />
  <p class="text-body-sm text-muted-foreground">We'll never share your email.</p>
  <!-- Error state -->
  <p class="text-body-sm text-destructive">Please enter a valid email address.</p>
</div>
```

**Input types**: Text, Email, Password (with show/hide toggle), Number, Search (with search icon + clear button), Phone (with country code selector), Date (with calendar picker), File (with drag-and-drop zone), Textarea (resizable vertically)

**Rules**:
- Always have a visible label
- Required fields marked with red asterisk
- Show character count for limited fields
- Validate on blur, not on every keystroke
- Error messages beneath the input, not as tooltips

### 7.3 Card

```html
<div class="rounded-xl border bg-card text-card-foreground shadow-sm
            transition-shadow duration-150 hover:shadow-md">
  <div class="p-6 pb-0 flex flex-col space-y-1.5">
    <h3 class="text-heading-3 font-semibold leading-none tracking-tight">
      Card Title
    </h3>
    <p class="text-body-sm text-muted-foreground">
      Optional description
    </p>
  </div>
  <div class="p-6">
    <!-- Card content -->
  </div>
  <div class="p-6 pt-0 flex items-center gap-3">
    <!-- Card footer actions -->
  </div>
</div>
```

**Card variants**:
- `default`: Border + shadow-sm + white/neutral bg
- `glass`: `backdrop-blur-md bg-card/80` (for overlays)
- `featured`: `border-accent/30 ring-1 ring-accent/10`
- `interactive`: `cursor-pointer hover:shadow-md hover:scale-[1.005]` (clickable cards)

### 7.4 Badge / Status

```html
<!-- Pill badge -->
<span class="inline-flex items-center rounded-full px-2.5 py-0.5
             text-xs font-semibold transition-colors
             bg-success/10 text-success ring-1 ring-inset ring-success/20">
  <span class="mr-1 h-2 w-2 rounded-full bg-success"></span>
  Approved
</span>
```

**Status badge colors**: `success` (green), `warning` (amber), `destructive` (red), `info` (blue), `neutral` (grey), `teal`, `navy`

**Stage badge colors** (Kanban):
- `lead`: Blue (bg-blue-50 text-blue-700 ring-blue-200)
- `in_progress`: Indigo
- `review`: Amber
- `granted`: Emerald
- `refused`: Red
- `pending`: Grey

### 7.5 Dialog / Modal

```html
<!-- Backdrop -->
<div class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

<!-- Dialog -->
<div class="fixed left-[50%] top-[50%] z-50 rounded-xl border bg-card shadow-xl
            translate-x-[-50%] translate-y-[-50%]
            w-full max-w-[560px]">

  <!-- Header -->
  <div class="flex items-center justify-between p-6 pb-4 border-b">
    <h2 class="text-heading-3 font-semibold">Dialog Title</h2>
    <Button variant="ghost" size="icon-sm" onClick={onClose}>
      <X class="h-4 w-4" />
    </Button>
  </div>

  <!-- Body -->
  <div class="p-6 overflow-y-auto max-h-[70vh]">
    <!-- Scrollable content -->
  </div>

  <!-- Footer -->
  <div class="flex items-center justify-end gap-3 p-6 pt-4 border-t">
    <Button variant="outline" onClick={onClose}>Cancel</Button>
    <Button onClick={onConfirm}>Confirm</Button>
  </div>
</div>
```

**Dialog sizes**: `sm` (max-w-md), `default` (max-w-[560px]), `lg` (max-w-[720px]), `xl` (max-w-[900px]), `full` (max-w-[calc(100vw-2rem)])

### 7.6 Table

```html
<div class="rounded-xl border bg-card shadow-sm overflow-hidden">
  <!-- Table toolbar -->
  <div class="flex items-center justify-between p-4 border-b">
    <div class="flex items-center gap-3">
      <Input placeholder="Search..." class="h-9 w-[250px]" />
      <!-- Filter dropdowns -->
    </div>
    <div class="flex items-center gap-2">
      <!-- Bulk actions, export, column toggle -->
    </div>
  </div>

  <!-- Table -->
  <div class="overflow-x-auto">
    <table class="w-full">
      <thead>
        <tr class="border-b bg-muted/40">
          <th class="h-12 px-4 text-left text-label text-muted-foreground">
            Column Name
            <!-- Sort arrow -->
          </th>
        </tr>
      </thead>
      <tbody>
        <tr class="border-b transition-colors hover:bg-muted/40 h-12">
          <!-- Row content -->
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  <div class="flex items-center justify-between p-4 border-t">
    <p class="text-body-sm text-muted-foreground">Showing 1-20 of 150</p>
    <div class="flex items-center gap-2">
      <!-- Page controls -->
    </div>
  </div>
</div>
```

**Table rules**:
- Row height: 48px (h-12) minimum
- Header: uppercase, muted, 11px, semibold
- Zebra striping: Don't use it. Hover highlight only.
- Empty state: `EmptyState` component in center of table area
- Loading: Skeleton rows matching column count
- Row click: If row is clickable, cursor-pointer + hover highlight

### 7.7 Kanban Board

```html
<div class="flex gap-4 overflow-x-auto pb-4 h-full">
  <!-- Column -->
  <div class="flex-shrink-0 w-[280px] rounded-xl bg-muted/40">
    <!-- Column header -->
    <div class="flex items-center gap-2 p-4 pb-2">
      <span class="h-2.5 w-2.5 rounded-full bg-blue-500"></span>
      <h3 class="text-heading-4 font-medium">In Progress</h3>
      <span class="rounded-full bg-muted px-2 py-0.5 text-caption">4</span>
      <span class="ml-auto text-caption text-muted-foreground">WIP: 4/10</span>
    </div>

    <!-- Card list (drop zone) -->
    <div class="flex flex-col gap-2 p-3 pt-0 min-h-[120px]">
      <!-- Draggable card -->
      <div class="rounded-lg border bg-card p-3 shadow-sm
                  cursor-pointer hover:shadow-md hover:scale-[1.005]
                  active:cursor-grabbing transition-all duration-150">
        <div class="flex items-center gap-2 mb-2">
          <span class="h-2 w-2 rounded-full bg-warning"></span>
          <span class="text-label text-muted-foreground">CASE-0042</span>
        </div>
        <h4 class="text-body-sm font-medium mb-1">482 Visa — John Smith</h4>
        <div class="flex items-center gap-2 text-caption text-muted-foreground">
          <span>Due: 15 Jun</span>
          <span>·</span>
          <span>3 docs</span>
        </div>
      </div>
    </div>
  </div>
</div>
```

**Drag states**:
- Default: `cursor-pointer shadow-sm`
- Hover: `shadow-md scale-[1.005]`
- Dragging: `opacity-50 shadow-xl scale-[1.02] cursor-grabbing z-50`
- Drag overlay: `opacity-90 rotate-2 shadow-2xl`
- Drop zone active: `bg-primary/5 ring-2 ring-inset ring-primary/20`
- Drop zone invalid: `bg-destructive/5 ring-2 ring-inset ring-destructive/20`

---

## 8. Layout Patterns

### 8.1 App Shell

Every Meru portal uses this shell:

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────────┐ ┌────────────────────────────────────────────┐ │
│  │          │ │  Header (h-16)                              │ │
│  │          │ │  ┌──────┐ ┌──────┐ ┌──────┐  ┌──────────┐ │ │
│  │  Sidebar │ │  │Bread │ │Search│ │Theme │  │User Menu │ │ │
│  │  (256px) │ │  │crumb │ │Cmd+K │ │Toggle│  │Avatar+▼ │ │ │
│  │          │ │  └──────┘ └──────┘ └──────┘  └──────────┘ │ │
│  │          │ ├────────────────────────────────────────────┤ │
│  │  Logo    │ │                                             │ │
│  │  Nav     │ │  Main Content Area                          │ │
│  │  Items   │ │  (overflow-y: auto)                        │ │
│  │          │ │                                             │ │
│  │  ─────── │ │  page-container: flex flex-col gap-6 p-6    │ │
│  │  User    │ │                                             │ │
│  │  Info    │ │                                             │ │
│  └──────────┘ └────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Sidebar specs**:
- Expanded width: 256px (GovernanceX) / 240px (ImmiStack)
- Collapsed width: 72px / 56px
- Collapse transition: 200ms ease-out
- Logo: 36×36px, rounded-xl, brand gradient background
- Active nav item: accent background + left border (2px) + bold text
- Nav item: rounded-xl, h-11, gap-2.5, text-sm font-medium
- Group label: text-[10px] font-bold uppercase tracking-widest, muted

**Header specs**:
- Height: 64px (GovernanceX) / 56px (ImmiStack)
- Background: `bg-background/80 backdrop-blur-xl` (translucent)
- Bottom border: `border-b`
- Content: flex, items-center, justify-between

### 8.2 Responsive Breakpoints

| Breakpoint | Width | Layout Behavior |
|---|---|---|
| `xs` | 480px | Extra small devices |
| `sm` | 640px | Sidebar collapses |
| `md` | 768px | Sidebar expandable, two-column layouts stack |
| `lg` | 1024px | Full sidebar, multi-column layouts |
| `xl` | 1280px | Dashboard 12-col grid |
| `2xl` | 1400px | Max container width |

### 8.3 Content Widths

| Content Type | Max Width | Centered |
|---|---|---|
| Dashboard | 1400px | Yes |
| Detail page (two-column) | 1400px | Yes |
| Form page | 672px (2xl) or 768px (3xl) | Yes |
| Full-width table | 1400px | Yes |
| Marketing/landing | 1200px | Yes |
| Legal/docs | 720px | Yes |
| Settings | 960px | Yes |

---

## 9. Form Design

### 9.1 Form Layout

```html
<form class="max-w-2xl mx-auto space-y-8">
  <!-- Section -->
  <div class="space-y-5">
    <div>
      <h3 class="text-heading-3 font-semibold">Personal Information</h3>
      <p class="text-body-sm text-muted-foreground mt-1">
        This information will be used for identity verification.
      </p>
    </div>

    <!-- Two-column field group -->
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2">
        <Label htmlFor="firstName">First Name <span class="text-destructive">*</span></Label>
        <Input id="firstName" placeholder="John" />
      </div>
      <div class="space-y-2">
        <Label htmlFor="lastName">Last Name <span class="text-destructive">*</span></Label>
        <Input id="lastName" placeholder="Smith" />
      </div>
    </div>

    <!-- Full-width field -->
    <div class="space-y-2">
      <Label htmlFor="email">Email Address <span class="text-destructive">*</span></Label>
      <Input id="email" type="email" placeholder="john@example.com" />
      <p class="text-body-sm text-muted-foreground">
        We'll send case updates to this address.
      </p>
    </div>
  </div>

  <!-- Section divider -->
  <Separator />

  <!-- Another section -->
  <div class="space-y-5">
    ...
  </div>

  <!-- Form actions (sticky footer) -->
  <div class="sticky bottom-0 -mx-6 px-6 py-4 bg-background border-t
              flex items-center justify-end gap-3">
    <Button variant="outline">Save Draft</Button>
    <Button type="submit">Submit Application</Button>
  </div>
</form>
```

### 9.2 Form Validation Rules

1. **Validate on blur**, not on keystroke (except for unique field checks like username)
2. **Show errors below the field**, in red, with `text-body-sm`
3. **Highlight the errored field** with a red border (`border-destructive`)
4. **Scroll to first error** on submit
5. **Disable submit button** while submitting (show spinner)
6. **Don't clear the form on error** — preserve all entered values
7. **Success message** after successful submission (toast or inline)

### 9.3 Field States

```
Default:     border-input bg-background
Hover:       border-muted-foreground/30
Focus:       border-ring ring-2 ring-ring/20
Error:       border-destructive ring-1 ring-destructive/20
Disabled:    bg-muted opacity-50 cursor-not-allowed
Read-only:   bg-muted/50 border-transparent cursor-default
```

---

## 10. Motion & Animation

### 10.1 Principles

1. **Purpose, not decoration**: Every animation communicates state change
2. **Under 200ms**: Unless it's a continuous animation (spinner, marquee)
3. **Respect reduced motion**: `prefers-reduced-motion` disables non-essential animation
4. **One animation at a time**: Avoid animating multiple elements simultaneously

### 10.2 Timing Tokens

```css
--duration-instant: 100ms;    /* Button presses, focus rings */
--duration-fast: 150ms;       /* Hover transitions, fade-in */
--duration-normal: 200ms;     /* Page transitions, sidebar */
--duration-slow: 300ms;       /* Dialog open, drawer slide */
--duration-glacial: 500ms;    /* Hero animations, onboarding */

--ease-default: cubic-bezier(0.4, 0, 0.2, 1);     /* Standard */
--ease-in: cubic-bezier(0.4, 0, 1, 1);             /* Enter */
--ease-out: cubic-bezier(0, 0, 0.2, 1);            /* Exit */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);  /* Bouncy (sparingly) */
```

### 10.3 Animation Catalog

| Element | Animation | Duration | Easing |
|---|---|---|---|
| Button hover | `opacity` + `shadow` | 200ms | default |
| Button press | `scale(0.98)` | 100ms | default |
| Card hover | `shadow` + `scale(1.005)` | 150ms | default |
| Sidebar collapse | `width` | 200ms | ease-out |
| Dialog open | `fade-in` + `zoom-in-95` | 200ms | ease-out |
| Dialog close | `fade-out` + `zoom-out-95` | 150ms | ease-in |
| Dropdown open | `fade-in` + `slide-down-2` | 150ms | ease-out |
| Toast enter | `slide-in-from-right` | 200ms | ease-spring |
| Toast exit | `fade-out` + `slide-out-to-right` | 150ms | ease-in |
| Page transition | `fade-in` + `slide-up-4` | 200ms | ease-out |
| Loading spinner | `spin` | 1s | linear infinite |
| Pulse (notifications) | `pulse-subtle` | 2s | ease-in-out infinite |
| Marquee (tickers) | `marquee` | 20s | linear infinite |
| Skeleton | `pulse` | 2s | ease-in-out infinite |

### 10.4 Custom Keyframes

```css
@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes pulse-subtle {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.8; }
}

@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes spin-slow {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
```

### 10.5 Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 11. Iconography

### 11.1 Icon Library

**Primary**: [Lucide Icons](https://lucide.dev) — consistent stroke-width, MIT license
**Fallback**: Custom SVG only when Lucide doesn't have the icon

### 11.2 Icon Sizes

```
sm:  14px  (badges, labels)
md:  16px  (buttons, nav items, inline — DEFAULT)
lg:  20px  (page headers, stat cards)
xl:  24px  (hero sections, empty states)
2xl: 32px  (featured empty states)
```

### 11.3 Icon Usage Rules

1. **Always use the same stroke-width**: `strokeWidth={2}` (Lucide default)
2. **Icons in buttons**: `h-4 w-4 mr-2` (16px)
3. **Standalone icon buttons**: Include `aria-label`
4. **Never use icons without text** unless the meaning is universally understood (×, ✓, +, search, menu)
5. **Status dots**: Custom 8px circles, not Lucide icons
6. **Nav icons**: 20px, muted-foreground color, becomes primary when active

---

## 12. Data Visualization

### 12.1 Chart Type Selection

| Data Type | Chart | Library |
|---|---|---|
| Trend over time | Line / Area | Recharts `<AreaChart>` |
| Comparison | Bar / Column | Recharts `<BarChart>` |
| Part-to-whole | Donut (max 5 segments) | Recharts `<PieChart>` |
| Distribution | Histogram / Box plot | Recharts `<BarChart>` |
| KPI single value | StatsCard with sparkline | Recharts `<Area>` (tiny) |
| Geospatial | Map with markers | Custom SVG (VesselMap) |
| Relationship | Sankey / Network graph | Custom (future) |

### 12.2 Sparkline (StatsCard)

```html
<div class="rounded-2xl bg-card p-6 shadow-sm">
  <div class="flex items-center gap-2">
    <div class="rounded-lg bg-teal-light p-2">
      <Icon class="h-5 w-5 text-teal" />
    </div>
    <span class="text-body-sm text-muted-foreground">Active Cases</span>
  </div>
  <div class="mt-4 flex items-end justify-between">
    <div>
      <p class="text-display font-black tracking-tight">1,247</p>
      <p class="text-body-sm text-success">+12.5%</p>
    </div>
    <!-- Sparkline (120×48px) -->
    <AreaChart width={120} height={48} data={trend}>
      <Area dataKey="value" stroke="currentColor" fill="currentColor" fillOpacity={0.1} />
    </AreaChart>
  </div>
</div>
```

### 12.3 Chart Styling Standards

```typescript
// Recharts theme defaults
const chartConfig = {
  margin: { top: 8, right: 8, bottom: 8, left: 8 },
  colors: [
    'hsl(221, 83%, 37%)',   // blue
    'hsl(180, 85%, 30%)',   // teal
    'hsl(37, 95%, 54%)',    // amber
    'hsl(142, 71%, 45%)',   // green
    'hsl(262, 83%, 58%)',   // purple
  ],
  grid: { stroke: 'hsl(var(--border))', strokeDasharray: '4 4' },
  axis: { stroke: 'hsl(var(--muted-foreground))', fontSize: 12 },
  tooltip: {
    contentStyle: {
      borderRadius: 'var(--radius)',
      border: '1px solid hsl(var(--border))',
      backgroundColor: 'hsl(var(--card))',
    },
  },
};
```

---

## 13. Internationalization & RTL

### 13.1 Language Support

All products must support English as primary and Arabic as secondary language.

```
messages/
├── en.json    # English (default, fallback)
└── ar.json    # Arabic (RTL)
```

### 13.2 RTL Layout

When `dir="rtl"` is set on `<html>` (detected from Arabic locale):

```css
[dir="rtl"] {
  /* Tailwind handles most with logical properties */
  /* Additional overrides: */

  /* Sidebar: right side instead of left */
  .sidebar { border-right: none; border-left: 1px solid; }

  /* Nav item border: right side instead of left */
  .nav-item-active { border-left: none; border-right: 2px solid; }

  /* Icons in buttons: margin on left instead of right */
  .btn-icon { margin-right: 0; margin-left: 0.5rem; }

  /* Dropdown chevrons: flip */
  .chevron { transform: scaleX(-1); }

  /* Numbers stay LTR */
  .number, .currency, .date { direction: ltr; display: inline-block; }
}
```

### 13.3 Arabic Typography Adjustments

```css
[lang="ar"] {
  --font-sans: var(--font-arabic);
  line-height: 1.6;  /* Arabic needs more line height */
  letter-spacing: 0;  /* Arabic doesn't use letter-spacing */
}
```

### 13.4 i18n Rules

1. **No hardcoded strings in components** — use `useTranslations()` from `next-intl`
2. **String interpolation**: Use ICU message format for plurals and variables
3. **Date/time**: Always use `date-fns` with locale-aware formatting
4. **Numbers**: Use `Intl.NumberFormat` with locale
5. **Never concatenate strings** — "Showing 1-20 of 150" must be a single translation key

---

## 14. Accessibility

### 14.1 Minimum Requirements

| Standard | Target |
|---|---|
| WCAG Level | 2.1 AA (minimum), AAA where possible |
| Color contrast (text) | 4.5:1 (normal), 3:1 (large text) |
| Color contrast (UI components) | 3:1 |
| Touch target size | 44×44px minimum |
| Keyboard navigation | All interactive elements reachable via Tab |
| Focus indicators | Visible on all interactive elements |
| Screen reader | Semantic HTML + ARIA labels |

### 14.2 Focus Management

```css
/* Visible focus ring on all interactive elements */
*:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
  border-radius: var(--radius);
}
```

### 14.3 Keyboard Navigation

| Key | Action |
|---|---|
| Tab / Shift+Tab | Move between interactive elements |
| Enter / Space | Activate button/link |
| Escape | Close dialog/dropdown/drawer |
| Arrow keys | Navigate within menu/list/date picker |
| Cmd/Ctrl + K | Open command palette |
| Cmd/Ctrl + Enter | Submit form |

### 14.4 Screen Reader Announcements

```html
<!-- Dynamic content updates -->
<div role="status" aria-live="polite" class="sr-only">
  {statusMessage}
</div>

<!-- Alert (immediate) -->
<div role="alert" aria-live="assertive" class="sr-only">
  {errorMessage}
</div>

<!-- Loading state -->
<div role="progressbar" aria-valuenow={progress} aria-label="Uploading document...">
```

### 14.5 Color & Contrast

- Never use color alone to convey meaning — always pair with text or icon
- Charts must be distinguishable in grayscale (use pattern + color)
- Error states: red border + red text + error icon
- Success states: green border + green text + check icon

---

## 15. Tenant Branding

### 15.1 White-Label Configuration

Each tenant can customize via `tenant_settings.branding` JSONB:

```json
{
  "branding": {
    "logo_url": "https://cdn.meru.com/tenants/acme/logo.png",
    "favicon_url": "https://cdn.meru.com/tenants/acme/favicon.ico",
    "primary_color": "#1D4ED8",
    "accent_color": "#10B981",
    "portal_title": "Acme Immigration Portal",
    "login_background_url": "https://cdn.meru.com/tenants/acme/login-bg.jpg"
  }
}
```

### 15.2 CSS Variable Override

Tenant branding is injected as CSS variables at runtime:

```html
<style id="tenant-branding">
  :root {
    --tenant-primary: #1D4ED8;
    --tenant-accent: #10B981;
  }
</style>
```

Components reference `--tenant-primary` instead of `--primary` when rendering tenant-branded elements (logo, header, login page).

### 15.3 Branding Scope

| Element | Tenant-customizable | Platform-controlled |
|---|---|---|
| Portal logo | Yes | No |
| Primary color | Yes | No |
| Accent color | Yes | No |
| Font | No (platform choice) | Yes |
| Layout structure | No | Yes |
| Component shapes | No | Yes |
| Terminology | No | Yes |
| Feature set | No (plan-based) | Yes |

---

## 16. Portal-Specific Patterns

### 16.1 Admin Portal (Firm Administrator)

**Personality**: Professional, powerful, efficient
**Key pages**: Dashboard, Clients, Cases, Documents, Staff, Settings, Billing
**Layout**: Full app shell with admin sidebar
**Special**: White-label configuration, billing dashboards, staff management

### 16.2 Staff Portal (Case Officers)

**Personality**: Task-focused, fast, clear
**Key pages**: Home (AI command bar), My Cases (Kanban), Tasks, Communications
**Layout**: App shell with staff sidebar (fewer nav items)
**Special**: Kanban board is the primary interface, AI command bar on home

### 16.3 Client Portal (End Customers)

**Personality**: Simple, reassuring, guided
**Key pages**: Home (case status), Documents (upload + view), Messages, Payments
**Layout**: Simplified — header + content, no sidebar. Bottom nav on mobile.
**Special**: Document upload wizard, case progress tracker, payment portal

### 16.4 Platform Portal (God View)

**Personality**: Authoritative, comprehensive, data-dense
**Key pages**: Tenant management, Module registry, Config pack publisher, Global analytics
**Layout**: App shell with platform sidebar (system-level nav items)
**Special**: Cross-tenant views, config pack version management, usage analytics

### 16.5 Login & Onboarding

**Login page**:
```
┌─────────────────────────────────────────────┐
│                   ┌──────────┐              │
│                   │  Logo    │              │
│                   │          │              │
│                   └──────────┘              │
│              Welcome back                   │
│         Sign in to your account             │
│  ┌─────────────────────────────────────┐   │
│  │  Email                               │   │
│  │  ┌─────────────────────────────────┐│   │
│  │  │                                 ││   │
│  │  └─────────────────────────────────┘│   │
│  │  Password                            │   │
│  │  ┌─────────────────────────────────┐│   │
│  │  │                          👁     ││   │
│  │  └─────────────────────────────────┘│   │
│  │  ┌─────────────────────────────────┐│   │
│  │  │         Sign In                 ││   │
│  │  └─────────────────────────────────┘│   │
│  │  ────────── or ──────────           │   │
│  │  [Google]  [SAML SSO]               │   │
│  └─────────────────────────────────────┘   │
│         Forgot password?                   │
│         Don't have an account? Sign up     │
│                                             │
│  ┌─────────────────────────────────────────┐│
│  │  Demo credentials (dev mode only)       ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

**Onboarding wizard** (ImmiStack pattern):
- 7-step wizard: Welcome → Firm Details → Branding → Modules → Users → Payment → Complete
- Progress bar at top
- Step transitions: `framer-motion` slide-left/right, 200ms
- Can save and resume later

---

## 17. Asset & Illustration Guidelines

### 17.1 Logo

| Variant | Size | Usage |
|---|---|---|
| Full logo (horizontal) | 160×40px | Header, login page |
| Icon only | 36×36px | Sidebar (collapsed), favicon |
| Mark only | 24×24px | App icons, meta tags |

**Logo construction**:
- Meru icon: 36×36px, `rounded-xl`, `gradient-teal` background, white "M" letter
- ImmiStack icon: `rounded-lg`, `bg-primary` (blue), white "IS" letters
- GovernanceX icon: `rounded-xl`, `gradient-teal`, white "G" letter

### 17.2 Favicon & App Icons

```
public/
├── favicon.ico
├── icon.svg
├── apple-touch-icon.png      # 180×180px
├── icon-192.png              # PWA
└── icon-512.png              # PWA
```

### 17.3 Empty State Illustrations

- Style: Minimal line art, single brand color + muted strokes
- Size: 200×160px
- Placement: Centered in the content area, with title + description below
- No external illustration library — custom SVG only

### 17.4 Image Guidelines

- **Avatars**: Circular, 2-letter initials fallback, brand-colored background
- **Document thumbnails**: PDF/Word/Excel icons with file extension overlay
- **Country flags**: Emoji-based (`🇦🇪`) or 24×16px SVG
- **Marketing images**: Unsplash with overlay gradient matching brand

---

## Appendix A: Component Checklist for @meru/ui

### Core Primitives (from shadcn/ui)
- [x] Button (10 variants, 6 sizes)
- [x] Input (with icon prefix/suffix, password toggle)
- [x] Textarea
- [x] Label
- [x] Checkbox
- [x] Radio Group
- [x] Switch / Toggle
- [x] Select (with search, multi-select)
- [x] Slider
- [x] Badge (8 variants)
- [x] Card (4 variants)
- [x] Dialog / Modal (5 sizes)
- [x] Sheet / Drawer
- [x] Dropdown Menu
- [x] Context Menu
- [x] Popover
- [x] Tooltip
- [x] Tabs
- [x] Accordion
- [x] Avatar (with fallback initials)
- [x] Progress Bar
- [x] Skeleton
- [x] Separator
- [x] Scroll Area
- [x] Toast / Sonner
- [x] Command Palette (cmdk)
- [x] Calendar / Date Picker
- [x] File Upload Zone

### Layout Components
- [x] AppShell (sidebar + header + main)
- [x] Sidebar (admin, staff, platform variants)
- [x] Header (breadcrumb, search, theme, notifications, user menu)
- [x] PageHeader (title + description + actions)
- [x] PageContainer

### Data Components
- [x] DataTable (sortable, filterable, paginated, selectable)
- [x] StatsCard (with sparkline, trend indicator)
- [x] KanbanBoard (drag-and-drop columns + cards)
- [x] KanbanColumn
- [x] KanbanCard

### Feedback Components
- [x] EmptyState (illustration + title + description + action)
- [x] ErrorState (error message + retry button)
- [x] LoadingSkeleton (matching card/table shape)
- [x] NotificationPanel (slide-over)
- [x] ConfirmationDialog

### Chart Components
- [x] Sparkline (AreaChart, 120×48px)
- [x] VesselMap (SVG world map with animated markers)
- [x] KPI Chart (BarChart)
- [x] Donut Chart

---

## Appendix B: Tailwind Config (Complete)

```typescript
import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: '1.5rem', sm: '2rem', lg: '2rem' },
      screens: { '2xl': '1400px' },
    },
    extend: {
      screens: { xs: '480px' },
      fontFamily: {
        sans: ['var(--font-sans)', 'IBM Plex Sans', 'sans-serif'],
        arabic: ['var(--font-arabic)', 'IBM Plex Sans Arabic', 'sans-serif'],
        display: ['var(--font-display)', 'Calistoga', 'serif'],
        mono: ['var(--font-mono)', 'Geist Mono', 'monospace'],
      },
      fontSize: {
        display: ['30px', { lineHeight: '1.2', fontWeight: '300' }],
        'heading-1': ['28px', { lineHeight: '1.25', fontWeight: '600' }],
        'heading-2': ['22px', { lineHeight: '1.3', fontWeight: '600' }],
        'heading-3': ['18px', { lineHeight: '1.35', fontWeight: '500' }],
        'heading-4': ['16px', { lineHeight: '1.4', fontWeight: '500' }],
        'body-lg': ['15px', { lineHeight: '1.5', fontWeight: '400' }],
        body: ['14px', { lineHeight: '1.5', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '1.5', fontWeight: '400' }],
        '2xs': ['10px', { lineHeight: '0.875rem' }],
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: 'hsl(var(--card))',
        'card-foreground': 'hsl(var(--card-foreground))',
        popover: 'hsl(var(--popover))',
        'popover-foreground': 'hsl(var(--popover-foreground))',
        primary: 'hsl(var(--primary))',
        'primary-foreground': 'hsl(var(--primary-foreground))',
        accent: 'hsl(var(--accent))',
        'accent-foreground': 'hsl(var(--accent-foreground))',
        cta: 'hsl(var(--cta))',
        'cta-foreground': 'hsl(var(--cta-foreground))',
        secondary: 'hsl(var(--secondary))',
        'secondary-foreground': 'hsl(var(--secondary-foreground))',
        muted: 'hsl(var(--muted))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        destructive: 'hsl(var(--destructive))',
        'destructive-foreground': 'hsl(var(--destructive-foreground))',
        success: 'hsl(var(--success))',
        'success-foreground': 'hsl(var(--success-foreground))',
        warning: 'hsl(var(--warning))',
        'warning-foreground': 'hsl(var(--warning-foreground))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        sidebar: {
          background: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
        },
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
        '3xl': 'calc(var(--radius) + 12px)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        'fade-in': { from: { opacity: '0' } },
        'fade-out': { to: { opacity: '0' } },
        'fade-in-up': { from: { opacity: '0', transform: 'translateY(12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(24px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-from-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-from-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'pulse-subtle': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.8' } },
        'spin-slow': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        float: { '0%, 100%': { transform: 'translateY(0px)' }, '50%': { transform: 'translateY(-10px)' } },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.15s ease-out',
        'fade-out': 'fade-out 0.15s ease-in',
        'fade-in-up': 'fade-in-up 0.4s ease-out',
        'slide-up': 'slide-up 0.5s ease-out',
        'slide-in-from-left': 'slide-in-from-left 0.2s ease-out',
        'slide-in-from-right': 'slide-in-from-right 0.2s ease-out',
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
        'spin-slow': 'spin-slow 8s linear infinite',
        shimmer: 'shimmer 1.5s ease infinite',
        float: 'float 3s ease-in-out infinite',
        marquee: 'marquee 20s linear infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config;
```

---

*Last updated: 2026-05-28*
*Document owner: Meru Platform Team*
