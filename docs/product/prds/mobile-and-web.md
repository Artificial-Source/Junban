# PRD: Mobile and Web Expansion

## Summary

Extend Junban beyond desktop once optional sync exists, first through mobile surfaces and then through a fuller browser client.

## Status

- Roadmap milestones: v2.0 and v3.0
- Product state: Future
- Internal planning source: depends on future sync planning; no internal execution epic is active yet

## Problem

Junban's core experience is already broad on desktop, but users eventually expect access away from their primary machine. Mobile and browser access depend on a sync foundation that preserves the current product principles.

## Mobile Goals (v2.0)

- Ship a React Native iOS app
- Ship a React Native Android app
- Support a browser-based PWA path for mobile access
- Add push notifications for reminders
- Deliver a mobile-optimized UI

## Web Goals (v3.0)

- Ship a web client using the shared React codebase where possible
- Add collaborative features such as shared projects and team sync
- Define an enterprise tier with SSO, admin controls, and audit logs

## Non-Goals

- Shipping mobile or web before sync exists
- Treating the browser client as a separate product with unrelated behavior
- Pulling enterprise concerns into the desktop-first core before the broader platform exists

## Primary Outcome

Users should be able to access Junban across devices and contexts without abandoning the local-first desktop product that already exists.

## Dependencies

- Junban Sync as the enabling layer
- Shared UI/service abstractions that can cross desktop, mobile, and web surfaces safely
- Clear decisions about where collaboration starts and where single-user local-first remains the default
