# Changes

## 2026-10-17

- Add published multi-step workflows beside the HTTP flows: secret webhook URLs
  with provider signatures, dedup windows and synchronous responses; feed, URL
  poll and schedule triggers on a per-minute Cron pass; flood holds; filters and
  exclusive or parallel paths; built-in transforms, line items and file fetches;
  general HTTP requests; delays, callback waits and delay queues; approval steps
  with editable capped fields; publish authority with opt-in USD caps; auto-pause.
- Add encrypted connections (API keys, bearer, basic, HMAC, OAuth 2.0 with
  refresh) and a Slack connector, a catalog and a coverage report.
- Pin `@runeditrun/rer` 0.2.38.

## 2026-10-16

- Run the hosted demo on rer 0.2.30's native Worker Loader host: each visitor
  gets their own isolate and SQLite storage instead of a container. Pin
  `@runeditrun/rer` 0.2.30 and refresh every verbatim Base copy, Base's
  `run-demo.yml` and DEMO.md together from `rer-v0.2.30`; drop the retired
  `instanceType` and the container-era demo observer.

## 2026-10-15

- Build Crank's picked aluminium and chartreuse design across the run-site
  homepage, shared sign-in/setup theme and workflow workspace.
- Publish repository Markdown guides at `/docs`; keep the installed `/` Lobby
  and shared `/run` instructions. Run-site deployment remains disabled by default.
- Refresh the exact runner pin to 0.2.19. Paused flows now offer the existing
  activate action, and browser timestamps display in the viewer's time zone.
