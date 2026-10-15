# Engineering rules

- Build a small local Manifest V3 overlay for Codex usage on `chatgpt.com`. Keep it loadable without a build step or external runtime dependencies.
- Keep requests and response parsing in `src/usage-client.js`; UI consumes normalized values only. Treat `/backend-api/wham/*` as undocumented and update the parser with evidence from real responses, never assumptions presented as certainty.
- Request only essential browser permissions and the `chatgpt.com` content-script match. Never collect chat content or browser history. A session access token may be used transiently in memory for authenticated usage requests; never persist, message, or log it, cookies, or passwords. Never add telemetry or external data destinations.
- Use safe DOM text APIs for response-derived values. Keep one HUD instance and one set of timers/listeners per page. Handle missing fields, failed requests, and storage errors without breaking ChatGPT.
- Test parser and formatting edge cases with Node's built-in test runner. Before shipping, validate manifest paths and syntax, review the diff for permissions and secret leakage, and manually smoke test in Comet when GUI access exists.
- Done means: usable via Load unpacked, documented installation and limitations, passing available checks, reviewed changes, and a committed result in the connected repository.
