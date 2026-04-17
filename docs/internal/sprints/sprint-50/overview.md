# Sprint 50 — "Clean Slate" (Out-of-Box Simplification)

## Goal

Transform the first-run experience from overwhelming (11 nav items, everything ON) to clean and minimal. Users see only what they need, discover advanced features naturally through Settings > Features.

## Scope

### P1 — Default Feature Flags (flip defaults)

Change `DEFAULT_SETTINGS` so advanced features are OFF by default:

- `feature_calendar`: "false"
- `feature_filters_labels`: "false"
- `feature_completed`: "false"
- `feature_cancelled`: "false"
- `feature_matrix`: "false"
- `feature_stats`: "false"
- `feature_someday`: "false"
- `feature_chords`: "false"
- `eat_the_frog_enabled`: "false"
- `nudge_enabled`: "false" (all nudge\_\* follow)
- Add `feature_dopamine_menu` flag (currently missing!) and default to "false"

**Keep ON by default (core experience):**

- `feature_sections`: "true"
- `feature_kanban`: "true"
- `feature_deadlines`: "true"
- `feature_duration`: "true"
- `feature_comments`: "true"

**Default sidebar after change:** Inbox, Today, Upcoming + Projects section. That's it.

### P2 — Enhanced Quick Start Wizard (5-step onboarding)

Replace the 3-step "welcome/NLP/done" with a meaningful 5-step wizard:

1. **Welcome** — "Your task manager. Simple, smart, yours."
2. **Pick your look** — Theme (light/dark/nord) + accent color picker
3. **Choose your style** — 3 presets:
   - **Minimal** (default) — core views only (inbox, today, upcoming)
   - **Standard** — adds calendar, completed, someday, stats
   - **Power User** — everything ON (all features, all views, nudges, eat-the-frog)
4. **AI Assistant** (optional) — "Set up later in Settings" or configure provider now
5. **You're ready!** — "Start adding tasks. Discover more in Settings > Features."

The preset selection applies the feature flags in bulk. Users can always toggle individual features later.

### P3 — Sidebar Cleanup

- Add `feature_dopamine_menu` to `NAV_FEATURE_MAP` so Quick Wins hides when disabled
- Ensure "Tools" section only shows when there are active plugin panels
- Ensure "Favorite Views" section only shows when user has favorites
- Ensure "My Views" section only shows when user has saved filters

### P4 — Features Tab UX Improvement

- Group features into categories: "Views", "Task Features", "Productivity"
- Add brief "what this does" descriptions
- Show a "Recommended" badge on commonly-used features
- Add "Enable All" / "Reset to Defaults" buttons

### P5 — Plugin Safety Model (Obsidian-style)

- Add `community_plugins_enabled` setting (default: "false") — a master toggle
- When OFF, community plugins are listed but cannot be enabled (greyed out with warning)
- When user toggles ON, show a warning dialog: "Community plugins can run arbitrary code. Only enable plugins you trust."
- Built-in plugins (pomodoro, timeblocking) are always available to enable, no warning
- Permission dialog shown BEFORE enabling any plugin (already works for community, extend to built-in)
- Add "Restricted Mode" banner at top of Plugins tab when community plugins are disabled

## Out of Scope

- New plugins or views
- Database changes
- Backend API changes

## Files to Modify

| File                                              | Change                                           |
| ------------------------------------------------- | ------------------------------------------------ |
| `src/ui/context/SettingsContext.tsx`              | Flip DEFAULT_SETTINGS, add feature_dopamine_menu |
| `src/ui/components/OnboardingModal.tsx`           | Complete rewrite — 5-step wizard with presets    |
| `src/ui/components/sidebar/SidebarPrimitives.tsx` | Add dopamine-menu to NAV_FEATURE_MAP             |
| `src/ui/components/sidebar/ViewNavigation.tsx`    | Conditional section rendering                    |
| `src/ui/views/settings/FeaturesTab.tsx`           | Categories, badges, bulk actions                 |
| `src/ui/views/settings/PluginsTab.tsx`            | Community plugins toggle, restricted mode banner |
| `src/ui/components/PermissionDialog.tsx`          | Show for all plugins before enable               |
| `src/ui/App.tsx`                                  | Pass new settings to onboarding                  |

## Acceptance Criteria

- [ ] Fresh install shows only Inbox, Today, Upcoming, Projects in sidebar
- [ ] Onboarding wizard lets user pick theme, preset, and optionally configure AI
- [ ] "Standard" preset enables calendar, completed, someday, stats
- [ ] "Power User" preset enables everything
- [ ] All hidden features discoverable in Settings > Features
- [ ] Community plugins require explicit "I understand the risks" toggle
- [ ] Built-in plugins show permissions before enabling
- [ ] Existing users' settings are NOT affected (only changes defaults for new installs)
- [ ] All tests pass
