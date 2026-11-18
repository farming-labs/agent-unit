# Event inbox storage

## Problem

Concurrent sends with the same ID both pass the inbox existence check. Valid event names and IDs
also expand beyond Farm.js Infra's 512-byte storage-key limit.

## Decisions

Use SHA-256 segments for event names and IDs, including the waiting-run index. Keep original
strings in records. Reuse the existing conditional-write backend to accept one canonical event
per ID. Conditional writes accept versioned records, not only run records.

Write the name/time index before claiming the ID. Readers resolve index entries through the
canonical record, so an unfinished or losing send cannot expose its payload. A failed index write
does not reserve an ID; a failed claim leaves an index entry that retention removes. Cloudflare
event sends use the index object's atomic conditional writes, as run updates already do.

## Alternatives

Increasing Infra's key limit leaves other bounded stores exposed. A process-local lock cannot
coordinate serverless requests. A separate event service duplicates the existing store.

## Consequences

No new Infra endpoint or store operation is required. Stores without atomic coordination retain
their documented single-process guarantee. Event lookup adds a canonical-record read. These inbox
records are unreleased; existing run and journal keys retain their formats.

## Verification plan

Reproduce concurrent duplicate acceptance and oversized keys before the fix. Verify single-winner
acceptance, canonical payloads, retries after storage failure, retention and ID reuse, and maximum
ASCII/Unicode inputs. Exercise Infra's actual SQLite operations and the existing clock callback.
