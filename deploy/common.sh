# Shared helpers for deploy/backup, deploy/deploy, deploy/health and deploy/rollback. Sourced, not executed.
# Never reads or prints runtime.env: that private file is only ever handed to systemd.
umask 077

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

DEPLOY_ROOT="${MYGOV_DEPLOY_ROOT:-$HOME/.local/share/mygov-tracker}"
RELEASES_DIR="${DEPLOY_RELEASES_DIR:-$DEPLOY_ROOT/releases}"
CURRENT_LINK="$RELEASES_DIR/current"
# Private state that survives releases: tracked.json (identifiers) and data/ (baselines, UI settings, browser profile).
PRIVATE_DIR="${DEPLOY_PRIVATE_DIR:-$DEPLOY_ROOT/private}"
SERVICE_NAME="${DEPLOY_SERVICE:-mygov-tracker.service}"
UNIT_FILE_IN_RELEASE="deploy/mygov-tracker.service"
UNIT_DIR="${DEPLOY_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT_PATH="$UNIT_DIR/$SERVICE_NAME"
RELEASE_ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

# A stable default connects separate backup and rollback invocations in the serialized queue.
DEPLOY_BACKUP_DIR="${DEPLOY_BACKUP_DIR-$DEPLOY_ROOT/backups/pre-deploy}"
systemctl_user() { timeout "${DEPLOY_SYSTEMCTL_TIMEOUT_SECONDS:-60}" systemctl --user "$@"; }

# The release the service is serving now: the `current` symlink, else empty (first installation).
active_release() {
  if [ -L "$CURRENT_LINK" ]; then basename "$(readlink "$CURRENT_LINK")"; return; fi
  printf '\n'
}

# Atomically repoint releases/current at a release directory name.
switch_current() {
  local id="$1" tmp="$RELEASES_DIR/.current.$$"
  [[ "$id" =~ $RELEASE_ID_PATTERN ]] || die "invalid release id"
  [ -d "$RELEASES_DIR/$id/app" ] || die "release $id has no app directory"
  if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then die "$CURRENT_LINK exists and is not a symlink"; fi
  rm -f "$tmp"
  ln -s "$id" "$tmp"
  mv -T "$tmp" "$CURRENT_LINK"
}

# Read one key from a key=value record without sourcing it.
record_value() { grep -E "^$2=" "$1" | head -n 1 | cut -d= -f2- || true; }
