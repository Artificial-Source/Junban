# Sprint S40 — Timeblocking Core

## Goal

Build the data model, CRUD operations, recurrence engine, and task linking for the timeblocking plugin. Pure logic and storage — no UI in this sprint.

## Items

| ID    | Item                            | Status |
| ----- | ------------------------------- | ------ |
| TB-04 | TimeBlock & TimeSlot data model | ready  |
| TB-05 | TimeBlock CRUD operations       | ready  |
| TB-06 | TimeSlot container logic        | ready  |
| TB-07 | Recurrence engine               | ready  |
| TB-08 | Task ↔ TimeBlock linking        | ready  |

## Dependencies

- S38 (Module Decomposition) — done
- S39 (Plugin React Rendering) — done: `contentType: "react"`, network API, task events

## Prompt

Single prompt covering all 5 items: `prompts/01-timeblocking-core.md`
