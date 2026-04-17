# Sprint S48 — Motivation Engine

## Goal

Add four motivation/fun features that make task management more engaging: Eat the Frog (dread-based prioritization), Dopamine Menu (quick wins filter), Task Jar (random pick), and joyful micro-animations via Framer Motion.

## Items

| ID    | Item                                                                 | Status |
| ----- | -------------------------------------------------------------------- | ------ |
| V2-22 | Eat the Frog — dread level rating, surface highest-dread tasks first | done   |
| V2-24 | Dopamine Menu — filtered list of short/easy tasks for low motivation | done   |
| V2-25 | Task Jar — random task selection from today's list                   | done   |
| V2-39 | Joyful micro-animations — Framer Motion for completions, transitions | done   |

## Constraints

- V2-22 needs a `dreadLevel` field on tasks (1-5 scale, schema migration)
- V2-24 and V2-25 are UI-only features (filter/pick from existing tasks)
- V2-39 adds `framer-motion` as a new dependency
- Animations must respect `prefers-reduced-motion`
- All features should be toggleable in settings

## Prompts

- `prompts/01-eat-the-frog.md` — Dread level field + morning frog surfacing
- `prompts/02-dopamine-menu-and-task-jar.md` — Quick wins filter + random picker
- `prompts/03-micro-animations.md` — Framer Motion integration
