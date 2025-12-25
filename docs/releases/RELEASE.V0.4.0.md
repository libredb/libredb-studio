# Release V0.4.0 - Mobile-First UX & AI Query Assistant

**Release Date:** 2025-12-23

This release focuses on delivering a premium mobile experience and integrating AI-powered query assistance with multi-provider LLM support.

---

## Highlights

- **Complete Mobile Redesign** - Touch-optimized UI with bottom navigation
- **AI Query Assistant** - Natural language to SQL with Gemini, OpenAI, Ollama support
- **Hybrid Results View** - Card & table views with smart column detection

---

## New Features

### 1. Mobile-First Navigation System

#### Bottom Navigation Bar
- Added fixed bottom navigation with three tabs: **DB**, **Schema**, **SQL**
- Smooth tab transitions with visual active state indicators
- Touch-friendly 16px safe area for gesture navigation

#### Compact Two-Row Header
- **Row 1:** Database dropdown selector, connection status, health toggle, user menu
- **Row 2:** AI assistant button, quick actions menu, RUN button
- Eliminated redundant toolbars for maximum screen real estate

#### Database Quick Switcher
- Dropdown selector for instant database switching
- Visual indicator for active connection
- Add new connection directly from dropdown

### 2. AI Query Assistant (Multi-Provider)

#### Supported Providers
| Provider | Model | Use Case |
|----------|-------|----------|
| **Gemini** | gemini-2.5-flash | Cloud - Fast & accurate |
| **OpenAI** | gpt-4o | Cloud - Advanced reasoning |
| **Ollama** | llama3, codellama | Local - Privacy-first |
| **Custom** | Any OpenAI-compatible | Self-hosted LLMs |

#### Features
- **Natural Language to SQL** - Describe what you need, get executable SQL
- **Schema-Aware Prompting** - AI knows your tables and columns
- **Streaming Responses** - Real-time token streaming
- **Floating Input** - Non-intrusive collapsible interface
- **One-Click Apply** - Insert generated SQL directly into editor

#### Configuration
```env
LLM_PROVIDER=gemini          # gemini | openai | ollama | custom
LLM_API_KEY=your_api_key     # Required for cloud providers
LLM_MODEL=gemini-2.5-flash   # Model name
LLM_API_URL=                 # Required for ollama/custom
```

### 3. Mobile Results View

#### Card View (Default)
- Each row displayed as a touch-friendly card
- **Smart Primary Column Detection** - Automatically identifies name/title/email fields
- Preview of first 4 fields with full data on tap
- Virtualized scrolling for performance with large datasets

#### Table View (Toggle)
- **Sticky First Column** - ID/primary column stays visible while scrolling
- Horizontal scroll with shadow indicator
- Minimum 120px column width for readability
- Tap row to view full details

#### Row Detail Bottom Sheet
- Full-screen sheet (85vh) with all row data
- Field-by-field copy buttons
- **Copy as JSON** - Export entire row
- Smooth gesture-based dismiss

### 4. Mobile Quick Actions

Consolidated toolbar actions into a single dropdown menu:
- **Format SQL** - Auto-format with Shift+Alt+F
- **Copy Query** - Copy current query to clipboard
- **Clear** - Reset editor content
- **Save Query** - Save to local storage

---

## Improvements

### UI/UX Enhancements
- Hidden desktop-only toolbars on mobile for cleaner interface
- Query tabs hidden on mobile (single-tab focus)
- Responsive stats bar with execution time on desktop only
- Type-aware cell coloring (numbers: amber, booleans: green/red, null: gray)

### Performance
- Virtualized card list for thousands of rows
- Optimized re-renders with proper memoization
- Lazy loading for mobile views

---

## Technical Details

### New Components
- `MobileNav` - Bottom navigation component
- `ResultCard` - Card view for result rows
- `RowDetailSheet` - Bottom sheet for row details

### Modified Components
- `Dashboard.tsx` - Mobile header, DB selector, tab routing
- `ResultsGrid.tsx` - Hybrid card/table view with toggle
- `QueryEditor.tsx` - Hidden toolbar on mobile

### New Dependencies
- No new dependencies added

---

## Migration Notes

### Environment Variables
Add the following to `.env.local` for AI features:
```env
LLM_PROVIDER=gemini
LLM_API_KEY=your_gemini_api_key
LLM_MODEL=gemini-2.5-flash
```

### Breaking Changes
- None. Fully backward compatible.

---

## What's Next (V0.5.0)

- [ ] AI-powered query error fixing
- [ ] Query explanation with AI
- [ ] Offline mode with local storage sync
- [ ] PWA support for mobile installation
- [ ] Swipe gestures for card actions

---

## Contributors

- Mobile UX redesign and AI integration by the LibreDB team

---

**Full Changelog:** [V0.3.0...V0.4.0](https://github.com/your-repo/compare/v0.3.0...v0.4.0)
