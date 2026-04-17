# Sprint S41 — Timeline UI: Day View

## Goal

Build the core visual timeblocking interface: a vertical day timeline with drag-and-drop. Users can drag tasks from a task list onto the timeline to create time blocks, reposition blocks, resize them, and click to create standalone blocks.

## Items

| ID    | Item                                | Status |
| ----- | ----------------------------------- | ------ |
| TB-09 | Day timeline grid component         | ready  |
| TB-10 | TimeBlock visual component          | ready  |
| TB-11 | Drag task → timeline (create block) | ready  |
| TB-12 | Drag to reposition blocks           | ready  |
| TB-13 | Resize blocks (drag edges)          | ready  |
| TB-14 | Click to create block               | ready  |

## Dependencies

- S40 (Timeblocking Core) — done: types, store, recurrence, slot-helpers, task-linking
- S39 (Plugin React Rendering) — done: contentType "react" in plugin views
- @dnd-kit/core already installed in project

## Prompt

Single prompt: `prompts/01-timeline-day-view.md`
