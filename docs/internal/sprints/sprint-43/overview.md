# Sprint S43 — Polish + E2E Testing

## Goal

Add recurring block management, Replan Undone Tasks, conflict indicators, plugin settings panel, focus mode integration, keyboard shortcuts. Then run the entire app with Playwright MCP to test the full timeblocking flow end-to-end and fix any bugs found.

## Items

| ID    | Item                               | Status |
| ----- | ---------------------------------- | ------ |
| TB-20 | Recurring block management UI      | done   |
| TB-21 | Replan Undone Tasks                | done   |
| TB-22 | Conflict detection & indicators    | done   |
| TB-23 | Plugin settings panel              | done   |
| TB-24 | Focus mode integration             | done   |
| TB-25 | Keyboard shortcuts                 | done   |
| TB-26 | E2E Playwright testing + bug fixes | done   |

## Dependencies

- S42 (Week View + Slots) — done
- Playwright MCP server configured in ~/.claude/mcp.json
- Existing E2E helpers in tests/e2e/helpers.ts

## Prompt

Single prompt: `prompts/01-polish-and-e2e.md`
