# First release

- An owner signs in, creates and activates a webhook-to-HTTP flow between two apps; agents can prepare flows and runs but cannot approve delivery.
- A person inspects a run's exact inputs and destination, approves or rejects it, and sees the recorded decision and delivery outcome.
- The owner replays a failed run once, with the original approved body and idempotency key; the receiving app records one effect.
- The owner previews a supported n8n workflow export, approves its import, reads the durable journal, and undoes an unused import.
- The owner exports and restores workflow data into an empty installation, and erases a completed run with a fence against restoring its old data.

Not needed: connector catalogue, third-party credential custody, live SaaS calls, scheduling, payments, brand redesign, domain, run site, or release tag. The included Operations inbox is a usable local receiving app. HTTP destinations must implement the documented idempotency contract.
