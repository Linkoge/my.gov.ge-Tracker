# my.gov.ge-Tracker

Tracks the application/update results shown by [my.gov.ge service 176](https://www.my.gov.ge/ka-ge/services/10/service/176). Each search submits **one** cadastral code, personal ID number, or registration number. Multiple configured identifiers are checked separately.

The first successful, complete search records all current entries and the latest result date, without sending update notifications. Later checks notify for every unseen result or changed application, including additions on the same date and older records that appear later. Results are deduplicated across runs and restarts.

## Setup and usage

Requires Node.js 20.12+, Google Chrome (default `/usr/bin/google-chrome`) and the locked Playwright dependency. With npm available:

```sh
npm ci
```

Copy the empty environment template only on a new checkout; retain an existing local `.env`. Create your private `tracked.json` from the example:

```sh
cp -n .env.example .env
cp -n tracked.example.json tracked.json
```

Example configuration (values must be strings to preserve leading zeros):

```json
{
  "identifiers": [
    { "type": "cadastral", "value": "01.14.16.007.381" }
  ],
  "intervalMinutes": 60
}
```

Supported types are `cadastral`, `id` (personal/organization identification number), and `registration`. Add additional objects to the array to track more identifiers. Each object performs its own independent search and establishes its own baseline. Blank, unknown and duplicate identifiers are rejected.

Run one check:

```sh
node tracker.mjs once --config tracked.json
```

Run immediately, then repeat every 60 minutes (or the configured interval):

```sh
node tracker.mjs loop --config tracked.json
```

Override the data directory or interval:

```sh
node tracker.mjs loop --config tracked.json --data-dir /private/path/mygov-data --interval-minutes 30
```

`npm start` runs once; `npm run track` runs the loop. Direct Node commands also work when npm is unavailable. SIGINT/SIGTERM stop the loop after the active check finishes; the interval is measured from the end of each cycle. Searches run sequentially. No scheduler or service is installed by these commands. `once` exits 1 when any identifier, state operation or notification fails; loop mode reports errors and retries on the next cycle.

## Web UI

A small local web interface manages trackings and settings and runs the scheduler. It uses only Node built-ins (no extra dependencies):

```sh
node ui.mjs                      # http://127.0.0.1:8790, scheduler included
node ui.mjs --port 9000          # another port (or set TRACKER_UI_PORT)
node ui.mjs --no-scheduler       # manage only; checks run via "Check now"
```

`npm run ui` is the same as `node ui.mjs`. Options: `--port`, `--host`, `--config tracked.json`, `--data-dir PATH`, `--no-scheduler`. The server binds to `127.0.0.1` by default and **refuses non-loopback hosts** (`127.0.0.1`, `::1`, `localhost` only) because it has no login; it also rejects foreign `Host`/`Origin` headers and requires a per-start form token on every POST. Do not run `ui.mjs` and `tracker.mjs loop` on the same data directory at the same time (the data-directory lock would make one of them report errors).

The layout is mobile-first and needs no external assets or scripts (inline CSS only): orange header and accent styling with a sticky tab navigation at the top on phones and wider screens, with the active page marked, and no horizontal scrolling down to 320px. Dates are shown compactly in UTC (e.g. `20 Oct 2026, 10:45`).

Pages:

- **Trackings** (`/`): each tracked identifier is a card (a grid on desktop) with the identifier in large text, type, a status pill, last check time, last result or error, latest known entry date and result count, plus full-width touch buttons. Every card has **Check now**, **Pause/Resume**, **Test alert** and **Delete** (with a confirmation page; deleting also removes the saved baseline, so re-adding starts a new silent baseline). Cards show **Queued…** while waiting behind another cycle and **Checking…** during a search; the page refreshes every three seconds until queued and running work finishes. Completion or failure is reported after manual checks. Paused items are skipped by the scheduler; "Check now" still works on them. **Test alert** (confirmation page, then **Simulate old baseline**) proves the update path end to end: it forgets only the newest saved entry (all entries sharing the newest date) and sets the stored latest date to the previous one (an empty baseline dated 2012-01-01 if nothing remains), without re-capturing a baseline. The card shows a **Test pending** marker; the next check (scheduled or Check now) sees that entry as new, sends the normal Telegram notification and clears the marker, after which the baseline is real again. It needs an existing baseline with at least one saved entry and is refused while a test is already pending or a check is queued or running.
- **New tracking** (`/new`): a segmented choice (CSS only, no JavaScript) between three forms for *Cadastral code* (საკადასტრო კოდი, placeholder examples `82.01.44.932` or `01.14.16.007.381`), *Personal ID number* (პირადი ნომერი, 11 digits, or 9 for an organization) and *Application number* (განცხადების ნომერი, 5-25 letters/digits/`-`/`/`), with an optional label. Cadastral values accept any nonempty text after trimming whitespace, including `01.14.16.007.381.01.500`, `01.14.16` and `abc`; the examples impose no format limits. Empty/blank values and duplicates are rejected. Personal IDs and application numbers retain their format validation. Adding saves the identifier and starts a baseline check (current results saved, no alert), exactly like the command-line tracker.
- **Settings** (`/settings`): Telegram bot token, chat ID, check interval in minutes (1-10080) and a **Send test message** button. After saving, the token is shown masked and the token field is write-only: leave it empty to keep the saved token. Either set both token and chat ID or neither. The interval takes effect without a restart (the sleeping scheduler is woken and recalculates its wait).

Storage: identifiers (plus optional `label` and `paused`) stay in `tracked.json`, the same file the CLI reads, and baselines stay in `DATA_DIR/tracker-state.json`. The UI additionally writes `DATA_DIR/ui-settings.json` (settings, mode 0600) and `DATA_DIR/check-status.json` (last check time/result/error and persisted failure-streak alert times per identifier). Each tracking has an independent failure streak. All of these are ignored by Git and are never committed. The scheduler (and `tracker.mjs`) reload `tracked.json` and the UI settings before every cycle, so pausing, adding, deleting and settings changes apply without restarting.

**Precedence** for the Telegram bot token, chat ID and check interval: values saved in the UI, then environment variables, then `.env`, then `tracked.json`, then defaults. The settings page shows the effective value and where it comes from, and the scheduler uses exactly those values, including when `tracker.mjs` is run from the command line (a saved UI interval also overrides `--interval-minutes`). To fall back to `.env` values, tick "Remove Telegram values saved in the UI" or clear the interval field and save. Other variables (login, data directory, timeouts, Chrome path) are not editable in the UI.

## Configuration

Environment variables override local `.env` values (and values saved in the [web UI](#web-ui) override both for Telegram and the interval). The default `.env` is resolved beside the application, regardless of working directory. `TRACKER_ENV_FILE` can select a different environment file. Optional empty settings use their defaults.

| Setting | Purpose / default |
| --- | --- |
| `MYGOV_LOGIN_ID`, `MYGOV_PASSWORD` | Credentials used if the service redirects to login |
| `MYGOV_VERIFICATION_CODE` | Optional current one-time code for unattended login |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Set both for Telegram; leave both empty for console notifications |
| `TRACKER_DATA_DIR` | State and browser profile directory; defaults to `data/` beside the application |
| `TRACKER_INTERVAL_MINUTES` | Poll interval, defaults to 60; must be > 0 and <= 10080 |
| `TRACKER_TIMEOUT_MS` | Timeout per browser/API operation, defaults to 15000; maximum 60000 |
| `CHROME_PATH` | Browser executable, defaults to `/usr/bin/google-chrome` |
| `TRACKER_ENV_FILE` | Alternate local environment-file path |
| `TRACKER_UI_PORT`, `TRACKER_UI_HOST` | Web UI port (default 8790; 8787 belongs to Bot Boss) and loopback host (default `127.0.0.1`) |
| `TRACKER_PUBLIC_ORIGIN` | Optional single external origin of a private reverse proxy, exactly `scheme://hostname[:port]` (e.g. `https://codex-server.tail5ebb9d.ts.net:8791`); also `--public-origin` |

JSON also accepts `dataDir`, `intervalMinutes` and `timeoutMs`; each identifier may also have a `label` string and `"paused": true` (skipped by `once` and `loop`; the UI manages both). Precedence: UI-saved settings (Telegram and interval only), command-line override, environment/local `.env`, JSON, default. Explicit relative config/data paths resolve from the current working directory; default config/data paths resolve beside the application. An absent config is an error; use `--config tracked.example.json` to try the supplied cadastral example.

Telegram messages use plain text and contain the identifier, entry date, description, status and application/document identifier when present. Delivery has a 15-second timeout. HTTP errors, malformed responses and Telegram `ok: false` are failures. A partial Telegram configuration is an error. Every attempted target records its completion time and either success or error, including search deadline failures; one failed or hung search does not skip later targets. Status persistence errors are logged and isolated so the cycle continues. Login/search/parsing failures are logged immediately and remain visible on the tracking card. A failed check never counts as an empty search and does not advance an existing baseline. Each tracking's failure streak is independent and persisted. Failure alerts wait until that tracking has failed continuously for 24 hours; a persistent streak is eligible at most once per 24-hour period. After each check cycle, all newly due failures are sent in one Telegram message with the tracking type, identifier, failing-since time and last error. **Check now** follows the same rule for the selected tracking. A successful check silently clears only that tracking's streak. New-entry alerts and **Send test message** are unaffected.

## Search, dates and persistent state

The browser opens service 176, resets old filters, fills the matching registry iframe field and submits it. The tracker validates the resulting `/api/search` JSON and fetches every remaining page using the same browser session and search payload. Missing or inconsistent pages, changed totals, error envelopes, invalid rows/dates, CAPTCHA/HTML responses and HTTP errors fail the entire identifier check. Search submission waits up to 30 seconds for the upstream response, independently of the normal 15-second browser timeout, and retries once by reopening the service page and refilling the form if no response arrives. Each field (including personal ID and cleared filters) is blurred to commit Angular input changes; submission waits for the button to become enabled. Each identifier search has a hard 90-second total deadline and a maximum of 1000 pages; exceeding either is an explicit failure.

The live search schema uses `appID`, `regNumber`, `webTransact`, `status`, `appRegDate` and `lastActDate`. The effective entry date is the later of registration and last activity; both dates are retained. API epoch seconds are stored as UTC ISO strings. The site's `geodate` formatter displays those epoch values as UTC calendar fields; this can differ from the operating system's local timezone.

A stable SHA-256 key includes application/registration/document identifiers, both dates, description and status. Ordering, applicant names and address formatting do not affect it. A new status or activity date on an existing application creates an update. If the API has no document ID, `documentId` is null; application and registration IDs are still retained. This tracks the **search results and their activity/status changes**. Downloading documents or inspecting CAPTCHA-protected application detail pages is outside this tracker.

`DATA_DIR/tracker-state.json` stores a schema version and, per identifier:

- `baselineAt`: time of the first successful check; `baselineDate`: latest entry date at that check (immutable).
- `latestDate`: newest entry date ever observed; `lastCheckedAt`: last successful search time.
- `seen`: baseline entries and acknowledged updates, keyed by stable hash.
- `pending`: a durable notification outbox, written before sending and acknowledged after delivery.

An empty, valid search can establish a baseline; later entries still notify. A failed first search cannot establish one. Seen entries remain even if they disappear from subsequent searches. Pending messages survive failures/restarts and retry on the next successful check even if the result has disappeared. Successfully acknowledged updates notify once. Telegram has no idempotency key: a crash or network disconnect after Telegram accepts a message but before the acknowledgement is saved can produce a duplicate on retry.

State writes use a private temporary file, file sync and atomic rename. A per-directory lock prevents overlapping checks/login operations. Corrupt or incompatible state fails visibly rather than discarding history. Keep the data directory across restarts and back it up while the tracker is stopped. Choosing a new/empty directory establishes a fresh baseline. After a forced process kill, inspect the PID in `DATA_DIR/tracker.lock`; remove the stale lock only after confirming its process is no longer running. Never remove an active process's lock.

## Login and browser sessions

The registry iframe was publicly searchable during the live check below, so a working government account session is currently unnecessary for this search. If service 176 redirects to login, the tracker uses the prototype's username/password and verification selectors. It reports rejected credentials, verification requirements and expired sessions as failures. It never waits for terminal input or repeatedly clicks send-code during polling.

For an interactive login with the same configured data directory:

```sh
timeout 180s node login.mjs tracked.json
```

The login command can request a verification code and waits up to 60 seconds for terminal input. Alternatively supply a current `MYGOV_VERIFICATION_CODE` privately. A completed login persists browser cookies in `DATA_DIR/browser/` for subsequent checks. The command shares the state lock, so stop the loop before running it. Old `auth/profile` artifacts are retained locally; the tracker uses its own configurable profile instead.

## Permanent tests

```sh
timeout 180s node --test tests/*.test.mjs
# or: npm test (includes the UI tests)
```

For the application's fixed Python smoke command:

```sh
python -m pip install -r requirements-dev.txt
timeout 180s python -m pytest -q -m smoke
```

The Python wrappers run the permanent Node suites, including `tests/ui.test.mjs` (mobile card/tab markup and, when Playwright and Chrome are available, a 320/390/1280px no-horizontal-overflow check, adding each identifier type, invalid input, pause/resume in the scheduler, delete, settings with token masking and a mocked Telegram test send, CLI start on loopback). Fixtures exercise parsing, activity dates, complete pagination, silent baselines, same-date/newer/backfilled additions, same-ID updates, restart deduplication, notification retries, failure reporting, corrupt state, locking, configuration and loop behavior. Browser tests run Chrome against intercepted synthetic pages, verify all three identifier fields and pagination, and block external page requests. CLI tests use an empty environment file. Tests use disposable directories and fake credentials; they do not log in or send Telegram messages.

The repository also retains its credential-path guard: `node scripts/check-secrets.mjs`. It checks the Git index and rejects tracked environment files, browser state, keys, cookies or tokens. `.env.example` contains only empty assignments. Keep `.env`, `tracked.json` and the data directory private; default sensitive paths are ignored. If you choose a data directory within the repository under another name, add that path to `.gitignore` before committing.

## Deployment

`.linko-deploy.json` points the application at the scripts in `deploy/`; the application merges and runs them. The tracker runs as the user systemd unit `mygov-tracker.service` (`node ui.mjs`, UI and scheduler on the dedicated port `127.0.0.1:8790`; Bot Boss keeps 8787).

- `deploy/deploy` exports `DEPLOY_COMMIT` (default `HEAD`) of `DEPLOY_REPO` into `~/.local/share/mygov-tracker/releases/<id>/app`, installs dependencies (previous release if `package-lock.json` is unchanged, else `npm ci --omit=dev`, else a matching `node_modules` from the checkout), installs the unit from the release, switches `releases/current` atomically and restarts the service. It keeps the newest 5 releases.
- `deploy/backup` copies the private state (`private/tracked.json`, `private/data/`) and records the active release in `backups/pre-deploy`.
- `deploy/deploy` also creates `private/tracked.json` as an empty list on a fresh install (the UI opens empty; no example identifiers, no notifications). An existing `tracked.json` or `data/` is never overwritten.
- `deploy/health` requires the service to be active and `http://127.0.0.1:8790/healthz` to answer 200 with exactly `mygov-tracker ok`, so another application's 200 on the port fails (`DEPLOY_HEALTH_URL`, `DEPLOY_HEALTH_WINDOW_SECONDS` to tune).
- `deploy/rollback` repoints `current` at the recorded release and restarts; `DEPLOY_RESTORE_DATA=1` also restores the backed-up private state.

Identifiers and state live in `~/.local/share/mygov-tracker/private/`, outside every release, so the checkout's `tracked.json`/`data/` are not used by the service. Optional Telegram/login settings go in `~/.config/mygov-tracker/runtime.env` (see `deploy/runtime.env.example`; create it privately, never commit it). ### Private HTTPS access (Tailscale)

The service always binds loopback. A private proxy may expose it, and the UI accepts that proxy's Host and HTTPS Origin only after you configure them in `TRACKER_PUBLIC_ORIGIN`. Requests must match the configured scheme, hostname and port exactly. Other hosts and origins are still rejected, as are mismatched scheme/port pairs. Forms still need the CSRF token. `X-Forwarded-*` headers are ignored. Loopback access and `/healthz` work unchanged. Host activation (one time, by the manager/host agent):

1. Add `TRACKER_PUBLIC_ORIGIN=https://codex-server.tail5ebb9d.ts.net:8791` to `~/.config/mygov-tracker/runtime.env` (mode 0600).
2. Remove any temporary unit drop-in that overrides `--port`; the shipped unit already uses 8790. Then run `systemctl --user daemon-reload && systemctl --user restart mygov-tracker.service`, or let the next deploy restart it.
3. Check `curl -s http://127.0.0.1:8790/healthz` prints `mygov-tracker ok`.
4. Route only the tracker's own port: `tailscale serve --bg --https=8791 http://127.0.0.1:8790`. Leave Bot Boss's routes and port 8787 untouched.
5. Open `https://codex-server.tail5ebb9d.ts.net:8791/` from a tailnet device.

Tests: `tests/test_deploy.py` (fake `systemctl`/`curl`/`npm`, disposable directories).

## Live verification — 2026-10-17 (Asia/Tbilisi)

A bounded Chrome search through the actual service 176 page for `01.14.16.007.381` returned HTTP 200 and **9 applications on 1 page**. Parsing succeeded. The latest activity was **22 December 2022, 19:17:35**, represented by the API as `1671736655` and stored as `2022-12-22T19:17:35.000Z`. The most recent application's registration date was 16 December 2022; the activity date is the tracking baseline.

The actual `tracker.mjs once` command established this baseline in a disposable `/tmp` data directory with **0 update notifications**. A repeat command returned the same 9 results and 0 notifications. Loop mode completed two further live cycles at a temporary 0.01-minute interval, each with 0 notifications, then stopped cleanly on SIGTERM with exit code 0. One earlier repeat attempt timed out waiting 15 seconds for the search response; it reported the failure and retained the baseline. The later repeat and both loop searches succeeded.

A separate attempt with the local login credentials reached `/ka-ge/account/login/verification`. Authentication could not complete because a second-factor verification code was required and none was supplied. No explicit send-code click was made. Public service/iframe search still succeeded. This does not establish a fully authenticated account session. Local Telegram variables were empty, so real Telegram delivery was not tested; the delivery protocol and failure paths are covered by permanent fake-response tests.

The final fixed smoke suite passed: **2 Python checks running all 26 permanent Node tests**, including the offline browser tests. Node v22.22.1, Playwright 1.63.0 and `/usr/bin/google-chrome` were used. npm was unavailable on PATH, so direct Node test/run commands were used. No long-running tracker was activated.

The [earlier investigation](docs/investigation-2026-10-13.md) is historical prototype evidence. Earlier security cleanup found no historical Git objects to audit in this checkout; credentials and old browser artifacts remained local and ignored. The exploratory `inspect.mjs`, `search-probe.mjs`, `api-inspect.mjs` and `send-code.mjs` are retained for investigation; use `tracker.mjs` for tracking.
