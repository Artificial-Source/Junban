# Sprint S47 — AI Intelligence Tools

## Goal

Add three high-value AI tools: time estimation (track actuals vs estimates), weekly review & analytics, and meeting notes → task extraction. These extend the existing AI tool system in `src/ai/tools/builtin/`.

## Items

| ID   | Item                                                                             | Status |
| ---- | -------------------------------------------------------------------------------- | ------ |
| A-36 | AI time estimation (estimatedMinutes field, track actuals, suggest from history) | done   |
| A-37 | Weekly review & analytics (completion rate, busiest day, neglected projects)     | done   |
| A-39 | Meeting notes to tasks (paste text → AI extracts action items)                   | done   |

## Constraints

- A-36 requires a new `estimatedMinutes` + `actualMinutes` fields on tasks (schema migration)
- All tools register via the existing `ToolRegistry` pattern
- Tools must work with any LLM provider (no provider-specific features)
- A-37 builds on existing `src/ai/tools/builtin/productivity-stats.ts`

## Dependencies

- A-36 needs schema + migration before the tool can be built

## Prompts

- `prompts/01-time-estimation.md` — Schema + AI tool for time estimates
- `prompts/02-weekly-review.md` — Weekly review analytics tool
- `prompts/03-meeting-notes-to-tasks.md` — Text → task extraction tool
