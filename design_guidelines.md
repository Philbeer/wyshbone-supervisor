# Wyshbone Supervisor Suite - Design Guidelines

## Design Approach
**System Selected**: Linear-inspired design system  
**Rationale**: B2B productivity tool requiring data density, efficiency, and professional clarity. Linear's approach excels at information hierarchy, rapid scanning, and decision-making workflows.

## Core Design Principles
1. **Information Clarity**: Every pixel serves the user's need to quickly assess and act on leads
2. **Scannable Hierarchy**: Clear visual weight differentiation for scores, names, and metadata
3. **Workflow Efficiency**: Minimal clicks from suggestion to action
4. **Trust Through Polish**: Professional, bug-free aesthetic builds confidence in AI recommendations

---

## Typography System

**Font Stack**: Inter (via Google Fonts CDN)

**Hierarchy**:
- Dashboard Title: 32px, weight 600, tracking tight (-0.02em)
- Section Headers: 20px, weight 600, tracking tight
- Card Titles: 16px, weight 500, standard tracking
- Lead Names: 15px, weight 500, standard tracking
- Metadata/Labels: 13px, weight 400, tracking wide (0.01em)
- Caption Text: 12px, weight 400, tracking normal

**Reading Width**: Main content max-width of 1400px, text content max-width 65ch

---

## Layout System

**Spacing Primitives**: Tailwind units of 1, 2, 3, 4, 6, 8, 12, 16, 24
- Micro spacing: 1-2 (between related elements)
- Component padding: 4-6 (card interiors)
- Section spacing: 12-16 (between major sections)
- Page margins: 24 (outer containers)

**Grid Structure**:
- Sidebar navigation: 240px fixed width
- Main content area: flex-1 with max-w-7xl
- Suggestions panel: 360px fixed width (right sidebar on desktop, drawer on mobile)
- Card grids: 2 columns on tablet, 3 columns on desktop (gap-6)

---

## Component Library

### Dashboard Layout
- Fixed left sidebar (240px) with navigation, status indicators, settings access
- Main content area with header (user greeting, quick stats, filter controls)
- Right suggestions panel (360px) showing live recommendation cards
- Mobile: Collapsible sidebar, full-width content, bottom drawer for suggestions

### Suggestion Cards
- Compact card design (h-auto, min-h-32)
- Card structure: Lead name (top, weight 500), score badge (top-right corner, rounded-full), address (13px, truncated), rationale text (13px, max 2 lines), action buttons row (bottom)
- Score badge: Circular or pill shape, displays 0-100 score with contextual sizing
- Hover state: Subtle elevation increase (shadow-md to shadow-lg)

### Lead Detail View
- Split layout: Left 60% (lead information, contact details, enrichment data), Right 40% (activity timeline, notes, quick actions)
- Header: Large lead name (28px), domain/website link, primary CTA buttons
- Tabbed sections: Overview, Contact Data, Signal History, Notes
- Email candidates: List view with verification status, confidence indicators

### Data Tables
- Header row: 14px weight 600, sticky positioning
- Row height: 56px with py-4 padding
- Alternating row treatment for scannability
- Sortable columns with icon indicators
- Action column (right-aligned) with icon buttons

### Status Indicators
- Integration health: Dot + label pattern (8px circle, 13px label)
- Signal strength: Progress bar or stacked bars for multi-metric display
- Processing states: Spinner + label for async operations

### Forms & Inputs
- Input height: h-10 or h-12 for text inputs
- Label above input: 13px weight 500, mb-2
- Helper text below: 12px, descriptive guidance
- Error states: Red accent with icon + message

### Navigation
- Sidebar items: h-9, px-3, rounded-md, 14px text
- Active state: Distinct treatment with subtle fill
- Icon + label pattern (20px icons, 3 spacing)
- Collapsible sections for grouped navigation

### Action Buttons
- Primary: h-10 px-6, 14px weight 500, rounded-md
- Secondary: Same sizing, outlined or ghost treatment
- Icon buttons: w-9 h-9 square or circular, centered icon
- Button groups: gap-2 for related actions

### Notifications/Toasts
- Fixed bottom-right positioning (4 from edge)
- Max-width: 380px, p-4 internal spacing
- Icon + message + close button layout
- Auto-dismiss after 5s unless error state

---

## Page-Specific Layouts

### Dashboard Home
- Top bar: Stats cards row (4 cards, grid-cols-4, showing active signals, leads generated today, email matches, integration status)
- Main content: Tabbed view (All Leads, High Priority, Needs Review, Recently Added)
- Right panel: Live suggestions feed with infinite scroll
- Empty state: Centered illustration + helpful text when no suggestions

### Settings/Configuration
- Two-column layout on desktop: Left navigation (integration categories), Right form panels
- Integration cards: Logo + name + status + configure button
- Budget sliders: Visual representation of rate limits with current usage
- Save bar: Sticky footer with cancel/save actions

### Signals Monitor (Admin)
- Real-time event feed: Timeline view with newest at top
- Event cards: Timestamp, user ID, signal type, payload preview, expand for full data
- Filters bar: Time range, signal type, user selector
- Export button for debugging

---

## Responsive Behavior

**Breakpoints**:
- Mobile: < 768px (single column, stacked layout, drawer panels)
- Tablet: 768px - 1024px (2-column grids, collapsible sidebars)
- Desktop: > 1024px (full layout with fixed sidebars)

**Mobile Adaptations**:
- Suggestions panel becomes bottom sheet or separate tab view
- Card grids collapse to single column
- Tables become vertical cards with key data
- Navigation becomes hamburger menu with slide-out drawer

---

## Interactions & Micro-animations

**Minimal Animation Strategy**:
- Card hover: Transform scale(1.01) with shadow transition (150ms ease)
- Loading states: Subtle skeleton screens or spinner (no complex animations)
- Panel transitions: Slide animations at 200ms for drawer open/close
- No page transitions, no scroll effects, no parallax

---

## Accessibility

- All interactive elements minimum 44px touch target
- Keyboard navigation with visible focus states (2px offset ring)
- ARIA labels for icon-only buttons
- Color-independent status indicators (always include icon or text)
- Form inputs with associated labels (not just placeholders)

---

## Images

**No hero images** - This is a data-focused productivity dashboard.

**Supporting imagery**:
- Empty state illustrations: Friendly, minimal line art when no data exists
- Integration logos: 32px square for sidebar, 48px for settings cards
- User avatars: 32px circular in header, 24px in activity feeds