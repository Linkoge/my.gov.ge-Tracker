# Investigation evidence — 2026-10-13

Inspection conducted on 2026-10-13 in Asia/Tbilisi (runtime clock: 2026-10-12 20:50:50 UTC). Repository: `/home/codex/projects/my.gov.ge-Tracker`; configured origin: `git@github.com:Linkoge/my.gov.ge-Tracker.git`.

## Conclusion and verified scope

The local project is a browser/API discovery prototype for my.gov.ge authentication and the registry search embedded in service `176`. The apparent intended direction is document/application tracking with possible Telegram notifications, inferred from the project/package name and unused Telegram configuration names. The implemented scripts perform individual login, inspection and search operations; they do not track changes over time. Readiness: **not ready for automated tracking**.

The exact owner-selected records, filters, polling frequency and notification rules are unknown. Service labels and live API behavior were not independently verified against the current government site. Findings about behavior come from local source inspection, not successful live runs.

## Source evidence

- `login.mjs`: reads `.env`, fills username/password, waits for a verification URL, optionally clicks the Georgian send-code button, reads a code from argv/stdin, submits it and writes storage state. It does not assert successful authentication before saving state. Existing credentials being nonempty is not evidence of validity.
- `send-code.mjs`: explicitly clicks the verification-code button when present. Running it would exceed this investigation's no-message constraint.
- `inspect.mjs`: opens service `176`, prints DOM fields/buttons/links, inspects an iframe at `naprweb.reestri.gov.ge`, logs API paths and takes a screenshot. It accepts an alternate URL as argv.
- `search-probe.mjs`: fills `searchForm.person` with `00000000000`, submits and prints request/response excerpts. No owner identifier or configurable search target is implemented.
- `api-inspect.mjs`: opens the registry search page, downloads `naprweb.min.js?v=v2`, POSTs a page-one search with placeholder `person` and otherwise empty filters to `https://naprweb.reestri.gov.ge/api/search`, then prints response structure. No response fixture or successful search receipt exists in the repository.
- All scripts launch `/usr/bin/google-chrome` with Playwright and `--no-sandbox`. Four share `auth/profile`; the API probe uses a fresh browser context. No script consumes `auth/state.json` or the Telegram variables.
- `package.json` contains only Playwright as a dependency, an absent `index.js` entrypoint and a deliberately failing test placeholder. No start script, tracker, test suite, CI configuration, container build, service unit or scheduler exists among the project files inspected.

These probes can print account/registry data and generate screenshots if run live. They were not executed during this investigation.

## Configuration observations (values suppressed)

The local `.env` contains exactly the four expected names: `MYGOV_LOGIN_ID` and `MYGOV_PASSWORD` are nonempty; `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are empty. Corresponding inherited process variables are absent/empty, which does not block the current login parser because it reads the file directly. No credentials were printed or remotely validated.

`auth/profile` exists with directory mode `0700`; `auth/` contains 293 files. Contents, cookies and tokens were not examined. `auth/state.json` does not exist. Neither a populated profile nor the missing state file establishes whether authentication currently works. Verification-code access may be necessary for a future login; the script implements no unattended renewal or expiry recovery.

Telegram configuration is missing for a future Telegram integration. The missing tracking implementation, target configuration and scheduler are separate blockers; a bot token alone cannot resolve them. No evidence establishes a separate government API key requirement in these scripts.

## Git and documentation baseline

- Branch is unborn `main`: `git log` reports no commits; `git for-each-ref`, `git reflog --all` and `git ls-files` produce no entries.
- Initial visible untracked files: `.gitignore`, the five `.mjs` scripts, `package.json`, `package-lock.json`. `.env`, `auth/` and `node_modules/` are ignored.
- Origin is configured, but no local remote refs exist. No fetch, push, commit or remote repository inspection was performed; remote content and GitHub deployment history are unknown.
- No applicable `AGENTS.md` was found in the repository or its ancestor directories. No project documentation was present initially.
- `.gitignore` has valid sensitive-path exclusions plus a literal `*** Add File: .../.env.example` patch fragment and four empty configuration assignments. The fragment was preserved; a real `.env.example` was added as documentation. Its existing negation permits this example file while keeping `.env` ignored.
- The manager's local `PROJECT.md`, `HANDOFF.md`, `STATE.md`, `TASKS.md`, `DECISIONS.md` and `MASTER_SPEC.md` yielded no my.gov.ge/tracker references in a focused search. They were not changed because they document the manager project. The connected document tool reported no document sessions.

## Safe validation and runtime evidence

| Check | Observed result | What it establishes |
| --- | --- | --- |
| `node --version` | `v22.22.1` | Compatible with dependency's Node >=20 requirement |
| `npm --version` | Command not found | Dependency installation workflow unavailable on current PATH |
| `node --check` on each of the five `.mjs` files | All exit 0 | JavaScript syntax only |
| Import installed `playwright` / inspect package metadata | Version `1.63.0` | Dependency available locally; clean install not tested |
| Chrome path metadata | `/usr/bin/google-chrome` exists, mode `0755` | Hardcoded executable present |
| Separate offline Playwright launch / local `setContent` / fill and Georgian button selector | `OFFLINE_BROWSER_CHECK PASS` | Browser and basic selectors work on a synthetic page; no live site validation |
| `/proc` process names and working-directory metadata | No Node/Chrome/tracker process observed; only investigation shell/Python had project cwd | No local running tracker observed at inspection time |
| System and user systemd unit inventories; system timer inventory | Exit 0; no matches for mygov/my.gov/tracker/document | No matching named service/timer found; arbitrary names and other hosts not ruled out |
| `/etc/cron.d` | One entry; no tracker-name/content references | No matching system cron entry in that directory |
| `/var/spool/cron/crontabs` | Absent | No inventory possible there; other scheduler locations not checked |
| Docker inventory | Socket permission denied | Container deployment/running state cannot be confirmed |
| Manager local deployment directory | 36 entries; no mygov/my.gov/tracker-named entries | No tracker-named local receipt found; not an exhaustive content audit |

The offline browser check used a fresh temporary profile, blocked context network requests and service workers, disabled background-networking features, and only synthetic HTML. It did not use `.env` or `auth/profile`. No government or Telegram request was intentionally made.

The cloud runtime skill was read. Its `environment_status` tool is unavailable in this tool set and `/etc/codex/network-policy.json` is absent; managed credential/network readiness cannot be established. No remote calls were needed for the safe validation. Existing screenshots and `/tmp/naprweb.min.js` at the scripts' output paths were absent when checked.

No succeeded deployment receipt for this tracker was supplied or discovered. The `chat-ui-rich-red-v1-20261012` receipt mentioned in task context concerns another project and is not tracker deployment evidence. No deployment or restart was requested or performed. External deployments and current government API/session compatibility remain unverified.

## Durable source fingerprints

SHA-256 of pre-existing scripts inspected (unchanged by this task):

```text
9c5f49128a66fd9349ff4215bc59be3cd49078b95920421fa93cc65e9ade93dc  api-inspect.mjs
de19ff8fd9fc1fbfba510d7d944a88c1d84fe008b59e4dc79cee49817f4def03  inspect.mjs
0306bbd418ab3770c980c89d6006f2e5c8c02cc6063bdf585b6701c4517d1e6b  login.mjs
366dc2651e4f1268d014f242a9e877becb8327a30dc9418075a3050258407220  search-probe.mjs
778d051de6f2e2e6fd4df5cfccf3e24f967868c43d96b4db80f8a7e3f2f17220  send-code.mjs
```

## Manager routine brief / recent-delivery handoff

Established facts: investigation complete; discovery probes implemented; syntax and offline browser checks verified; automated tracking not implemented; live account/search/notification behavior untested; no local running tracker observed; deployment unconfirmed and no tracker succeeded receipt available.

Lasting effects of this task: added `README.md`, `.env.example` and this authoritative dated evidence report. Existing code, credentials, browser profile, Git history and deployment state were preserved. No functional change, tracking activation, external message or deployment occurred. No manager assignment/result identifier was provided; this section is a prepared handoff, not evidence that manager memory was updated.

Final artifact validation passed: all five source fingerprints still match; the three new documentation artifacts exist and are visible as untracked Git files; the example has only empty values; `.env`, `auth/profile` and `node_modules` remain ignored. No commit or publication was made.

Pending work, in order: confirm tracking scope and Telegram choice; restore npm and verify a clean install; obtain authorization for live login/search/code requests and verify current selectors/API and session handling; implement configurable targets, polling, persisted baselines/change comparison, error/expiry recovery and notification deduplication; validate repeated tracking and notification behavior; only then prepare deployment and retain its exact succeeded activation receipt. Credentials should be configured through the appropriate private mechanism when the implementation is ready, without copying values into documentation.
