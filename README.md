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

## Configuration

Environment variables override local `.env` values. The default `.env` is resolved beside the application, regardless of working directory. `TRACKER_ENV_FILE` can select a different environment file. Optional empty settings use their defaults.

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

JSON also accepts `dataDir`, `intervalMinutes` and `timeoutMs`. Precedence: command-line override, environment/local `.env`, JSON, default. Explicit relative config/data paths resolve from the current working directory; default config/data paths resolve beside the application. An absent config is an error; use `--config tracked.example.json` to try the supplied cadastral example.

Telegram messages use plain text and contain the identifier, entry date, description, status and application/document identifier when present. Delivery has a 15-second timeout. HTTP errors, malformed responses and Telegram `ok: false` are failures. A partial Telegram configuration is an error. Login/search/parsing failures are logged and sent to Telegram when configured; console fallback reports them locally. Error reports never count as an empty search and do not advance an existing baseline.

## Search, dates and persistent state

The browser opens service 176, resets old filters, fills the matching registry iframe field and submits it. The tracker validates the resulting `/api/search` JSON and fetches every remaining page using the same browser session and search payload. Missing or inconsistent pages, changed totals, error envelopes, invalid rows/dates, CAPTCHA/HTML responses and HTTP errors fail the entire identifier check. Each identifier search has a 55-second total deadline and a maximum of 1000 pages; exceeding either is an explicit failure.

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
# or: npm test
```

For the application's fixed Python smoke command:

```sh
python -m pip install -r requirements-dev.txt
timeout 180s python -m pytest -q -m smoke
```

The Python wrappers run the permanent Node suites. Fixtures exercise parsing, activity dates, complete pagination, silent baselines, same-date/newer/backfilled additions, same-ID updates, restart deduplication, notification retries, failure reporting, corrupt state, locking, configuration and loop behavior. Browser tests run Chrome against intercepted synthetic pages, verify all three identifier fields and pagination, and block external page requests. CLI tests use an empty environment file. Tests use disposable directories and fake credentials; they do not log in or send Telegram messages.

The repository also retains its credential-path guard: `node scripts/check-secrets.mjs`. It checks the Git index and rejects tracked environment files, browser state, keys, cookies or tokens. `.env.example` contains only empty assignments. Keep `.env`, `tracked.json` and the data directory private; default sensitive paths are ignored. If you choose a data directory within the repository under another name, add that path to `.gitignore` before committing.

## Live verification — 2026-10-17 (Asia/Tbilisi)

A bounded Chrome search through the actual service 176 page for `01.14.16.007.381` returned HTTP 200 and **9 applications on 1 page**. Parsing succeeded. The latest activity was **22 December 2022, 19:17:35**, represented by the API as `1671736655` and stored as `2022-12-22T19:17:35.000Z`. The most recent application's registration date was 16 December 2022; the activity date is the tracking baseline.

The actual `tracker.mjs once` command established this baseline in a disposable `/tmp` data directory with **0 update notifications**. A repeat command returned the same 9 results and 0 notifications. Loop mode completed two further live cycles at a temporary 0.01-minute interval, each with 0 notifications, then stopped cleanly on SIGTERM with exit code 0. One earlier repeat attempt timed out waiting 15 seconds for the search response; it reported the failure and retained the baseline. The later repeat and both loop searches succeeded.

A separate attempt with the local login credentials reached `/ka-ge/account/login/verification`. Authentication could not complete because a second-factor verification code was required and none was supplied. No explicit send-code click was made. Public service/iframe search still succeeded. This does not establish a fully authenticated account session. Local Telegram variables were empty, so real Telegram delivery was not tested; the delivery protocol and failure paths are covered by permanent fake-response tests.

The final fixed smoke suite passed: **2 Python checks running all 26 permanent Node tests**, including the offline browser tests. Node v22.22.1, Playwright 1.63.0 and `/usr/bin/google-chrome` were used. npm was unavailable on PATH, so direct Node test/run commands were used. No long-running tracker was activated. No deploy setup; merges only.

The [earlier investigation](docs/investigation-2026-10-13.md) is historical prototype evidence. Earlier security cleanup found no historical Git objects to audit in this checkout; credentials and old browser artifacts remained local and ignored. The exploratory `inspect.mjs`, `search-probe.mjs`, `api-inspect.mjs` and `send-code.mjs` are retained for investigation; use `tracker.mjs` for tracking.
