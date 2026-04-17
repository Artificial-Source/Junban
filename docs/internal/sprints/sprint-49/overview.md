# Sprint S49 — AI Auto-scheduling

## Goal

Implement AI-powered auto-scheduling: given tasks with priorities, deadlines, and estimated durations, the AI places them optimally on the timeblocking timeline. This is the "killer feature" that competitors like Motion and Morgen offer.

## Items

| ID    | Item                                                                       | Status |
| ----- | -------------------------------------------------------------------------- | ------ |
| V2-31 | AI auto-scheduling engine (priority/deadline/duration/energy optimization) | done   |
| A-47  | Auto-schedule AI tool (LLM-powered scheduling via tool call)               | done   |
| TB-33 | Integration with timeblocking plugin (place blocks on timeline)            | done   |

## Constraints

- Depends on S47 A-36 (time estimation field) for duration data
- Depends on existing timeblocking plugin (S38–S44) for block placement
- Must work with any LLM provider
- Should offer "suggest" mode (user reviews) and "auto" mode (one-click schedule)
- Needs to respect existing locked/manual blocks
- Must handle edge cases: no duration estimate, overbooked day, conflicts

## Design Decisions Needed

- Algorithm: pure LLM vs heuristic-first with LLM refinement?
- Reschedule triggers: manual only, or auto-reschedule on task changes?
- How to handle tasks without duration estimates (use defaults? ask user?)

## Prompts

- `prompts/01-auto-scheduling-design.md` — Design doc + architecture decisions
- `prompts/02-auto-scheduling-impl.md` — Implementation
