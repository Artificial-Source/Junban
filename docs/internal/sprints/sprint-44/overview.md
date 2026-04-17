# Sprint S44 — Timeblocking UX Polish + AI Tools

## Goal

Fix sidebar integration issues (drag, context menus), add right-click context menus throughout the timeblocking plugin, make tasks clickable in the plugin sidebar, register AI tools so the assistant can control time blocks, and verify everything via Playwright MCP.

## Items

| ID    | Item                                      | Status |
| ----- | ----------------------------------------- | ------ |
| TB-40 | Plugin sidebar drag + context menu        | done   |
| TB-41 | Right-click empty sidebar space           | done   |
| TB-42 | Timeline grid context menu                | done   |
| TB-43 | Time block context menu                   | done   |
| TB-44 | Click tasks in plugin TaskSidebar to edit | done   |
| TB-45 | Plugin AI tools (block CRUD, scheduling)  | done   |
| TB-46 | E2E Playwright testing + bug fixes        | done   |

## Dependencies

- S43 (Timeblocking Polish + E2E) — done
- Existing context menu system: `src/ui/components/sidebar/SidebarContextMenu.tsx`
- Existing AI tools registry: `src/ai/tools/registry.ts`
- Plugin `ai:tools` permission already defined in types.ts

## Prompt

Single prompt: `prompts/01-ux-polish-and-ai-tools.md`
