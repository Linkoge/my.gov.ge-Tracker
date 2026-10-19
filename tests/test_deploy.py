"""Deploy, backup, health and rollback scripts, run against disposable directories with fake systemctl/curl/npm shims."""

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

pytestmark = pytest.mark.smoke

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"

SYSTEMCTL = """#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
if [ "$2" = "is-active" ]; then [ "${FAKE_ACTIVE:-1}" = 1 ]; exit; fi
exit 0
"""
CURL = """#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--output" ]; then out="$2"; shift; fi
  shift
done
[ -n "$out" ] && printf '%s' "${FAKE_CURL_BODY-<title>Trackings – my.gov.ge tracker</title>}" > "$out"
printf '%s' "${FAKE_CURL_STATUS:-200}"
exit "${FAKE_CURL_EXIT:-0}"
"""
NPM = """#!/usr/bin/env bash
echo "npm $* (in $(basename "$(dirname "$PWD")"))" >> "$FAKE_LOG"
mkdir -p node_modules/playwright
echo '{"version": "1.0.0"}' > node_modules/playwright/package.json
"""
LOCK = {"lockfileVersion": 3, "packages": {"": {}, "node_modules/playwright": {"version": "1.0.0"}}}


def shim(path: Path, text: str):
    path.write_text(text)
    path.chmod(0o755)


@pytest.fixture
def env(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim(bin_dir / "systemctl", SYSTEMCTL)
    shim(bin_dir / "curl", CURL)
    values = dict(os.environ)
    for name in [k for k in values if k.startswith(("DEPLOY_", "FAKE_", "MYGOV_"))]:
        del values[name]
    values.update(
        HOME=str(tmp_path / "home"),
        PATH=f"{bin_dir}:{values['PATH']}",
        FAKE_LOG=str(tmp_path / "calls.log"),
        MYGOV_DEPLOY_ROOT=str(tmp_path / "root"),
        DEPLOY_UNIT_DIR=str(tmp_path / "units"),
        DEPLOY_HEALTH_WINDOW_SECONDS="0",
        DEPLOY_SYSTEMCTL_TIMEOUT_SECONDS="10",
        DEPLOY_PACKAGE_MANAGER="no-such-package-manager",
    )
    (tmp_path / "home").mkdir()
    return values


def run(script, env, **extra):
    return subprocess.run(
        [str(DEPLOY / script)], env={**env, **extra}, capture_output=True, text=True, timeout=60
    )


def calls(env):
    path = Path(env["FAKE_LOG"])
    return path.read_text().splitlines() if path.exists() else []


def make_repo(tmp_path, marker="one", with_modules=True):
    repo = tmp_path / "repo"
    (repo / "deploy").mkdir(parents=True, exist_ok=True)
    shutil.copy(DEPLOY / "mygov-tracker.service", repo / "deploy" / "mygov-tracker.service")
    (repo / "package-lock.json").write_text(json.dumps(LOCK))
    (repo / "ui.mjs").write_text(f"// {marker}\n")
    if not (repo / ".git").exists():
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", marker],
        cwd=repo, check=True,
    )
    if with_modules and not (repo / "node_modules").exists():
        (repo / "node_modules" / "playwright").mkdir(parents=True)
        (repo / "node_modules" / "playwright" / "package.json").write_text('{"version": "1.0.0"}')
    return repo


def deploy(env, repo, **extra):
    return run("deploy", env, DEPLOY_REPO=str(repo), **extra)


def current_release(env):
    link = Path(env["MYGOV_DEPLOY_ROOT"]) / "releases" / "current"
    return link.resolve() if link.is_symlink() else None


def test_deploy_config_is_valid():
    config = json.loads((ROOT / ".linko-deploy.json").read_text())
    for key in ("deploy_command", "backup_command", "health_command", "rollback_command"):
        argv = config[key]
        assert isinstance(argv, list) and all(isinstance(item, str) for item in argv)
        assert (ROOT / argv[0]).is_file() and os.access(ROOT / argv[0], os.X_OK)


def test_unit_file_runs_from_current_release_with_private_state():
    unit = (DEPLOY / "mygov-tracker.service").read_text()
    assert "releases/current/app" in unit
    assert "--config %h/.local/share/mygov-tracker/private/tracked.json" in unit
    assert "--data-dir %h/.local/share/mygov-tracker/private/data" in unit
    assert "--host 127.0.0.1" in unit and "--port 8787" in unit
    assert "EnvironmentFile=-" in unit


def test_runtime_env_example_holds_no_values():
    lines = [l for l in (DEPLOY / "runtime.env.example").read_text().splitlines() if l and not l.startswith("#")]
    assert lines and all(line.endswith("=") for line in lines)


def test_first_deploy_installs_unit_switches_current_and_restarts(env, tmp_path):
    repo = make_repo(tmp_path)
    result = deploy(env, repo)
    assert result.returncode == 0, result.stderr
    release = current_release(env)
    assert release and (release / "app" / "ui.mjs").read_text() == "// one\n"
    # No npm on the fake PATH of this test: dependencies come from the checkout's matching node_modules.
    assert (release / "app" / "node_modules" / "playwright" / "package.json").is_file()
    assert (Path(env["DEPLOY_UNIT_DIR"]) / "mygov-tracker.service").is_file()
    log = calls(env)
    assert "systemctl --user daemon-reload" in log
    assert "systemctl --user restart mygov-tracker.service" in log
    private = Path(env["MYGOV_DEPLOY_ROOT"]) / "private"
    assert (private / "data").is_dir() and oct(private.stat().st_mode & 0o777) == "0o700"


def test_deploy_uses_package_manager_when_available(env, tmp_path):
    shim(Path(env["PATH"].split(":")[0]) / "npm", NPM)
    repo = make_repo(tmp_path, with_modules=False)
    result = deploy(env, repo, DEPLOY_PACKAGE_MANAGER="npm")
    assert result.returncode == 0, result.stderr
    assert any(line.startswith("npm ci --omit=dev") for line in calls(env))
    assert (current_release(env) / "app" / "node_modules").is_dir()


def test_deploy_fails_without_matching_dependencies_and_leaves_current_untouched(env, tmp_path):
    repo = make_repo(tmp_path, with_modules=False)
    assert deploy(env, repo).returncode != 0
    releases = Path(env["MYGOV_DEPLOY_ROOT"]) / "releases"
    assert current_release(env) is None
    assert [p.name for p in releases.iterdir() if p.is_dir() and not p.is_symlink()] == []
    assert not any("restart" in line for line in calls(env))


def test_deploy_rejects_mismatched_checkout_modules(env, tmp_path):
    repo = make_repo(tmp_path)
    (repo / "node_modules" / "playwright" / "package.json").write_text('{"version": "0.0.1"}')
    result = deploy(env, repo)
    assert result.returncode != 0 and "no matching node_modules" in result.stderr


def test_second_deploy_reuses_dependencies_and_keeps_previous_release(env, tmp_path):
    repo = make_repo(tmp_path)
    assert deploy(env, repo).returncode == 0
    first = current_release(env)
    make_repo(tmp_path, marker="two")
    shutil.rmtree(repo / "node_modules")  # the previous release is the only dependency source now
    result = deploy(env, repo, DEPLOY_COMMIT="HEAD")
    assert result.returncode == 0, result.stderr
    second = current_release(env)
    assert second != first and first.is_dir()
    assert (second / "app" / "ui.mjs").read_text() == "// two\n"
    assert (second / "app" / "node_modules").is_dir()


def test_deploy_rejects_bad_commit(env, tmp_path):
    repo = make_repo(tmp_path)
    assert deploy(env, repo, DEPLOY_COMMIT="--bogus").returncode != 0
    assert deploy(env, repo, DEPLOY_COMMIT="does-not-exist").returncode != 0
    assert current_release(env) is None


def test_deploy_prunes_old_releases(env, tmp_path):
    repo = make_repo(tmp_path)
    releases = Path(env["MYGOV_DEPLOY_ROOT"]) / "releases"
    for i in range(3):
        (releases / f"2020010100000{i}-{str(i) * 12}" / "app").mkdir(parents=True)
    assert deploy(env, repo, DEPLOY_KEEP_RELEASES="2").returncode == 0
    names = sorted(p.name for p in releases.iterdir() if p.is_dir() and not p.is_symlink())
    assert len(names) == 2 and current_release(env).name in names


def test_backup_copies_private_state_and_records_active_release(env, tmp_path):
    repo = make_repo(tmp_path)
    assert deploy(env, repo).returncode == 0
    active = current_release(env).name
    private = Path(env["MYGOV_DEPLOY_ROOT"]) / "private"
    (private / "tracked.json").write_text('{"identifiers": []}')
    (private / "data" / "tracker-state.json").write_text("{}")
    (private / "data" / "tracker.lock").write_text("123")
    backup = tmp_path / "backup"
    result = run("backup", env, DEPLOY_BACKUP_DIR=str(backup))
    assert result.returncode == 0, result.stderr
    assert (backup / "private" / "tracked.json").read_text() == '{"identifiers": []}'
    assert (backup / "private" / "data" / "tracker-state.json").is_file()
    assert not (backup / "private" / "data" / "tracker.lock").exists()
    assert (backup / "unit.service").is_file()
    assert f"previous_release={active}" in (backup / "record.env").read_text()


def test_backup_without_existing_state_succeeds(env, tmp_path):
    backup = tmp_path / "backup"
    assert run("backup", env, DEPLOY_BACKUP_DIR=str(backup)).returncode == 0
    assert "previous_release=\n" in (backup / "record.env").read_text()
    assert not (backup / "unit.service").exists()


def test_rollback_returns_to_previous_release_without_touching_data(env, tmp_path):
    repo = make_repo(tmp_path)
    assert deploy(env, repo).returncode == 0
    first = current_release(env)
    private = Path(env["MYGOV_DEPLOY_ROOT"]) / "private"
    (private / "data" / "state").write_text("before")
    backup = tmp_path / "backup"
    assert run("backup", env, DEPLOY_BACKUP_DIR=str(backup)).returncode == 0
    make_repo(tmp_path, marker="two")
    assert deploy(env, repo).returncode == 0
    assert current_release(env) != first
    (private / "data" / "state").write_text("after")
    result = run("rollback", env, DEPLOY_BACKUP_DIR=str(backup))
    assert result.returncode == 0, result.stderr
    assert current_release(env) == first
    assert (private / "data" / "state").read_text() == "after"
    assert calls(env)[-1] == "systemctl --user restart mygov-tracker.service"


def test_rollback_can_restore_private_state_when_asked(env, tmp_path):
    repo = make_repo(tmp_path)
    assert deploy(env, repo).returncode == 0
    private = Path(env["MYGOV_DEPLOY_ROOT"]) / "private"
    (private / "data" / "state").write_text("before")
    backup = tmp_path / "backup"
    assert run("backup", env, DEPLOY_BACKUP_DIR=str(backup)).returncode == 0
    (private / "data" / "state").write_text("after")
    result = run("rollback", env, DEPLOY_BACKUP_DIR=str(backup), DEPLOY_RESTORE_DATA="1")
    assert result.returncode == 0, result.stderr
    assert (private / "data" / "state").read_text() == "before"
    assert any(p.name.startswith("private.pre-rollback.") for p in private.parent.iterdir())


def test_rollback_of_first_installation_removes_unit_and_current(env, tmp_path):
    backup = tmp_path / "backup"
    assert run("backup", env, DEPLOY_BACKUP_DIR=str(backup)).returncode == 0
    repo = make_repo(tmp_path)
    assert deploy(env, repo).returncode == 0
    result = run("rollback", env, DEPLOY_BACKUP_DIR=str(backup))
    assert result.returncode == 0, result.stderr
    assert current_release(env) is None
    assert not (Path(env["DEPLOY_UNIT_DIR"]) / "mygov-tracker.service").exists()
    assert "systemctl --user stop mygov-tracker.service" in calls(env)


def test_rollback_without_record_fails(env, tmp_path):
    result = run("rollback", env, DEPLOY_BACKUP_DIR=str(tmp_path / "missing"))
    assert result.returncode != 0 and "no backup record" in result.stderr


def test_health_passes_when_service_active_and_ui_answers(env):
    result = run("health", env)
    assert result.returncode == 0, result.stderr
    assert "healthy" in result.stdout
    assert any("http://127.0.0.1:8787/" in line for line in calls(env))


@pytest.mark.parametrize(
    "extra",
    [
        {"FAKE_ACTIVE": "0"},
        {"FAKE_CURL_STATUS": "500"},
        {"FAKE_CURL_STATUS": "000", "FAKE_CURL_EXIT": "7"},
        {"FAKE_CURL_BODY": "<html>some other app</html>"},
    ],
)
def test_health_fails_on_any_bad_signal(env, extra):
    result = run("health", env, **extra)
    assert result.returncode == 1 and "unhealthy" in result.stderr


def test_health_rejects_urls_with_credentials_and_bad_timeouts(env):
    assert run("health", env, DEPLOY_HEALTH_URL="http://user:pw@127.0.0.1:8787/").returncode != 0
    assert run("health", env, DEPLOY_HEALTH_URL="file:///etc/passwd").returncode != 0
    assert run("health", env, DEPLOY_HEALTH_WINDOW_SECONDS="abc").returncode != 0
    assert not calls(env)
