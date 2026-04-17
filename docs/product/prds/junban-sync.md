# PRD: Junban Sync

## Summary

Create an optional paid sync service that lets users keep Junban local-first while adding secure cross-device continuity.

## Status

- Roadmap milestone: v1.5
- Product state: Future
- Internal planning source: promotion from internal backlog / epic planning is still pending

## Problem

Junban is strongest as a private, local-first desktop app, but users who want continuity across devices need a sync path that does not discard the product's privacy and portability principles.

## Goals

- Define an ASF-hosted sync-server architecture
- Add user accounts and authentication for sync customers
- Support end-to-end encrypted task sync
- Resolve concurrent-edit conflicts safely
- Ship a sync client in the desktop app
- Add subscription management and billing

## Non-Goals

- Making accounts mandatory for Junban
- Replacing local-first storage with cloud-primary storage
- Bundling mobile/web clients into this milestone

## Primary Outcome

Users who need multi-device access should be able to opt into sync without changing the local-first character of the core product.

## Dependencies

- Security and key-management design
- Conflict-resolution rules that preserve task integrity
- Billing and account boundaries that stay optional for offline-only users
- This milestone is the foundation for the later mobile and web milestones
