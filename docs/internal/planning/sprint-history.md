# Sprint History

This page preserves the historical execution summary that previously lived in the legacy public roadmap document.

For product-level roadmap and status, use [`../../product/README.md`](../../product/README.md).

## Sprint History

Dozens of sprints completed across roughly two years of development.

| Sprint | Theme                                                                 | Tests |
| ------ | --------------------------------------------------------------------- | ----- |
| S0     | Scaffold                                                              | 171   |
| S1     | First Blood (DB wiring)                                               | 219   |
| S2     | Feel Good (polish)                                                    | 246   |
| S3     | Plugins: Foundation                                                   | 275   |
| S4     | Plugins: UI                                                           | 297   |
| S5     | AI: Foundation                                                        | 321   |
| S6     | AI: Intelligence                                                      | 333   |
| S7     | CI/CD & Release                                                       | 333   |
| S8     | Styling & Desktop App                                                 | 333   |
| S9     | Power User                                                            | 387   |
| S10    | Milestone Closure                                                     | 424   |
| S11    | Markdown Storage                                                      | 528   |
| S12    | Hardening                                                             | 528   |
| S13    | v1.0 Release                                                          | 549   |
| S14    | Design System                                                         | 549   |
| S15    | Sub-tasks & Focus Mode                                                | 574   |
| S16    | Templates & NL Queries                                                | 610   |
| S17    | AI Error Handling                                                     | 620   |
| S18    | Dynamic Model Discovery                                               | 630   |
| S19    | Reminders                                                             | 663   |
| S20    | Pluggable LLM Core                                                    | 682   |
| S21    | Voice Integration                                                     | 735   |
| S22    | AI Intelligence Tools                                                 | 772   |
| S23    | Rebrand (Docket → Junban)                                             | 772   |
| S24    | Local Voice Models                                                    | 813   |
| S25    | Project & Reminder Tools                                              | 857   |
| S26    | Inworld TTS & Mobile UI                                               | 960   |
| S27    | Settings & AI Quick Wins                                              | 960   |
| S28    | Sound Effects                                                         | 988   |
| S29    | Voice Call & Tag Tools                                                | 1018  |
| S30-31 | GitHub Issues batch                                                   | 1018+ |
| S32    | Frontend Enhancements                                                 | 1018+ |
| S33    | QA & Polish                                                           | 1773  |
| S34    | Plugin Slot System                                                    | 1773  |
| S35    | Big Features                                                          | 1774  |
| S36    | Bug Fixes                                                             | 1785  |
| S37    | Core UI Enhancements                                                  | 1796  |
| S38    | Module Decomposition (DX-01–07)                                       | 1956  |
| S39    | Plugin React Rendering                                                | 1956+ |
| S40    | Timeblocking Data Model                                               | 1956+ |
| S41    | Timeblocking Day View                                                 | 1956+ |
| S42    | Timeblocking Week View                                                | 1956+ |
| S43    | Timeblocking Polish + E2E                                             | 2146  |
| S44    | Module Decomposition II (DX-08–14)                                    | 2159  |
| S45    | Lint Cleanup                                                          | 2159  |
| S46    | Housekeeping + Global Quick Capture                                   | 2386  |
| S47    | AI Intelligence Tools (time estimation, weekly review, meeting notes) | 2386  |
| S48    | Motivation Engine (Eat the Frog, Dopamine Menu, Task Jar, animations) | 2386  |
| S49    | AI Auto-scheduling                                                    | 2386  |
| S50    | Clean Slate + 7 New Providers + OAuth                                 | 2455  |
| S51    | Module Decomposition III (DX-15–25)                                   | 2455  |
| S52    | Production Readiness + DevOps Hardening                               | 2613  |

## Known Technical Debt

1. `src/main.ts:24` — TODO: Start UI or CLI based on context (currently assumes UI)
2. E2E tests expanded (33+ Playwright spec files) — continue expanding coverage
3. No `.env` committed — only `.env.example` exists
4. ~~`auto_schedule_day` + `reschedule_day` not available in MCP~~ — Fixed: MCP server now loads plugins
