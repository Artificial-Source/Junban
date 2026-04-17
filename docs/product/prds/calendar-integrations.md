# PRD: Calendar Integrations

## Summary

Enable Junban's timeblocking workflow to interoperate with external calendars through automation-friendly connectors before attempting native OAuth calendar clients.

## Status

- Roadmap milestone: v1.2
- Epic status: Backlog
- Internal planning source: [`../../internal/planning/epics.md`](../../internal/planning/epics.md)

## Problem

Junban can schedule work locally, but users who also live in calendar ecosystems still need a practical bridge between time blocks and external calendars.

## Goals

- Expose time block CRUD events through a webhook/API surface
- Document connector flows for n8n, Activepieces, and Pipedream
- Support ICS export for time blocks
- Let users lock a block into a calendar-event shape (`public`, `private`, or `busy`)
- Support two-way sync via an automation platform that can pull external events back in

## Non-Goals

- Native Google/Apple/Microsoft calendar OAuth in this phase
- A full Junban-hosted sync service
- Team collaboration workflows

## Primary Outcome

Users should be able to keep Junban as the planning source of truth while still reflecting timeblocked work into external calendar systems.

## Dependencies

- Stable timeblock CRUD/event model
- Clear connector examples and docs
- A migration path toward future sync work without coupling this phase to Junban Sync
