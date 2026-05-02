#!/usr/bin/env sh
set -eu

REPO="${JUNBAN_REPO:-Artificial-Source/Junban}"
API_URL="${JUNBAN_RELEASE_API:-https://api.github.com/repos/${REPO}/releases/latest}"
INSTALL_KIND="${JUNBAN_INSTALL_KIND:-auto}"
REQUESTED_INSTALL_KIND="$INSTALL_KIND"
INSTALL_DIR="${JUNBAN_INSTALL_DIR:-}"
OS_RELEASE_FILE="${JUNBAN_OS_RELEASE_FILE:-/etc/os-release}"
ASSET_ARCH="amd64"
DETECTED_ARCH=""
DETECTED_DISTRO_NAME="Linux"
DETECTED_DISTRO_ID="unknown"
DETECTED_DISTRO_ID_LIKE=""

usage() {
  printf '%s\n' 'Usage: install-linux.sh [--auto|--choose|--deb|--appimage]'
  printf '%s\n' ''
  printf '%s\n' 'Installs the latest Junban Linux desktop release.'
  printf '%s\n' ''
  printf '%s\n' 'Options:'
  printf '%s\n' '  --auto       Use .deb on Debian/Ubuntu, AppImage elsewhere (default)'
  printf '%s\n' '  --choose     Ask whether to install the .deb or AppImage'
  printf '%s\n' '  --deb        Force the Debian/Ubuntu .deb installer; may require sudo'
  printf '%s\n' '  --appimage   Force the portable AppImage installer; does not use sudo'
  printf '%s\n' '  -h, --help   Show this help'
  printf '%s\n' ''
  printf '%s\n' 'Environment:'
  printf '%s\n' '  JUNBAN_INSTALL_DIR   AppImage install directory (default: ~/Applications)'
  printf '%s\n' '  JUNBAN_INSTALL_KIND  auto, choose, deb, or appimage'
}

die() {
  printf 'junban installer: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --auto)
      INSTALL_KIND="auto"
      ;;
    --choose | --interactive)
      INSTALL_KIND="choose"
      ;;
    --deb)
      INSTALL_KIND="deb"
      ;;
    --appimage)
      INSTALL_KIND="appimage"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

case "$INSTALL_KIND" in
  auto | choose | deb | appimage) ;;
  *) die "JUNBAN_INSTALL_KIND must be auto, choose, deb, or appimage" ;;
esac
REQUESTED_INSTALL_KIND="$INSTALL_KIND"

[ "$(uname -s)" = "Linux" ] || die "this installer only supports Linux"

DETECTED_ARCH="$(uname -m)"
case "$DETECTED_ARCH" in
  x86_64 | amd64) ;;
  *)
    die "only amd64 Linux release assets are currently published; use the release page or build from source"
    ;;
esac

command_exists curl || die "curl is required"
command_exists sed || die "sed is required"
command_exists head || die "head is required"
command_exists mktemp || die "mktemp is required"
command_exists tr || die "tr is required"

TMP_DIR="$(mktemp -d)"
RELEASE_JSON="${TMP_DIR}/release.json"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

detect_linux_distro() {
  if [ -r "$OS_RELEASE_FILE" ]; then
    PRETTY_NAME=""
    NAME=""
    ID=""
    ID_LIKE=""

    # /etc/os-release is the standard Linux distribution identity file.
    # shellcheck disable=SC1090,SC1091
    . "$OS_RELEASE_FILE"

    DETECTED_DISTRO_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
    DETECTED_DISTRO_ID="${ID:-unknown}"
    DETECTED_DISTRO_ID_LIKE="${ID_LIKE:-}"
  fi
}

is_debian_like() {
  case "${DETECTED_DISTRO_ID} ${DETECTED_DISTRO_ID_LIKE}" in
    *debian* | *ubuntu*) return 0 ;;
  esac

  return 1
}

describe_detection() {
  info "Detected Linux distro: ${DETECTED_DISTRO_NAME} (${DETECTED_DISTRO_ID})"
  [ -z "$DETECTED_DISTRO_ID_LIKE" ] || info "Detected distro family: ${DETECTED_DISTRO_ID_LIKE}"
  info "Detected CPU architecture: ${DETECTED_ARCH}; using ${ASSET_ARCH} release assets"
}

describe_install_choice() {
  case "$INSTALL_KIND" in
    deb)
      if [ "$REQUESTED_INSTALL_KIND" = "auto" ]; then
        info "Selected .deb install because this looks like Debian/Ubuntu and apt-get is available"
      elif [ "$REQUESTED_INSTALL_KIND" = "choose" ]; then
        info "Selected .deb install from your choice"
      else
        info "Selected .deb install because it was requested explicitly"
      fi
      ;;
    appimage)
      if [ "$REQUESTED_INSTALL_KIND" = "auto" ]; then
        if is_debian_like; then
          info "Selected AppImage install because apt-get is not available"
        else
          info "Selected AppImage install because this distro is not Debian/Ubuntu-like"
        fi
      elif [ "$REQUESTED_INSTALL_KIND" = "choose" ]; then
        info "Selected AppImage install from your choice"
      else
        info "Selected AppImage install because it was requested explicitly"
      fi
      ;;
  esac
}

read_terminal_answer() {
  prompt="$1"
  TERMINAL_ANSWER=""

  if [ -t 0 ] && [ -t 1 ]; then
    printf '%s' "$prompt"
    IFS= read -r TERMINAL_ANSWER || return 1
  elif [ -t 1 ] && { : </dev/tty >/dev/tty; } 2>/dev/null; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -r TERMINAL_ANSWER </dev/tty || return 1
  else
    return 2
  fi
}

choose_install_kind() {
  recommended_kind="$1"
  default_choice="2"
  if [ "$recommended_kind" = "deb" ]; then
    default_choice="1"
  fi

  info "Choose what to install:"
  info "  1) .deb system package - best for Debian/Ubuntu; may require sudo"
  info "  2) AppImage portable app - installs under your home directory; no sudo"
  if [ "$recommended_kind" = "deb" ]; then
    info "Recommended: .deb because this looks like Debian/Ubuntu and apt-get is available"
  else
    info "Recommended: AppImage because this distro is not Debian/Ubuntu-like or apt-get is unavailable"
  fi

  if ! read_terminal_answer "Select install type [${default_choice}]: "; then
    die "cannot ask for install choice without an interactive terminal; rerun with --deb or --appimage"
  fi

  case "$TERMINAL_ANSWER" in
    "") TERMINAL_ANSWER="$default_choice" ;;
  esac

  case "$TERMINAL_ANSWER" in
    1 | deb | DEB | .deb) INSTALL_KIND="deb" ;;
    2 | appimage | AppImage | APPIMAGE) INSTALL_KIND="appimage" ;;
    *) die "unknown install choice: ${TERMINAL_ANSWER}; expected 1, 2, deb, or appimage" ;;
  esac
}

find_asset_url() {
  suffix="$1"
  tr -d '\n\r' <"$RELEASE_JSON" \
    | tr '{' '\n' \
    | sed -n "s/.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*${ASSET_ARCH}\\.${suffix}\)\".*/\1/p" \
    | head -n 1
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  command_exists sudo || die "sudo is required for .deb installation; rerun with --appimage to avoid sudo"
  info ".deb installation requires administrator privileges."
  info "Reason: apt-get installs Junban as a system package and registers it with dpkg."
  info "No-sudo alternative: rerun this installer with --appimage to install under your home directory."

  if ! read_terminal_answer 'Continue with sudo apt-get install? [y/N] '; then
    die "cannot ask for sudo confirmation without an interactive terminal; rerun as root or use --appimage"
  fi

  case "$TERMINAL_ANSWER" in
    y | Y | yes | YES | Yes) ;;
    *) die "installation cancelled; rerun with --appimage to install without sudo" ;;
  esac

  if ! sudo "$@"; then
    die ".deb installation failed"
  fi
}

install_deb() {
  command_exists apt-get || die ".deb installation requires apt-get; rerun with --appimage for portable install"

  deb_url="$(find_asset_url deb)"
  [ -n "$deb_url" ] || die "could not find an amd64 .deb asset in the latest release"

  deb_file="${TMP_DIR}/junban-latest-amd64.deb"
  info "Downloading Junban .deb"
  curl -fL "$deb_url" -o "$deb_file"
  [ -s "$deb_file" ] || die "downloaded .deb asset is empty"

  info "Installing Junban with apt-get"
  run_as_root apt-get install -y "$deb_file"
  configure_user_launcher "asf-junban"

  info "Junban installed. Launch it from your app menu."
}

refresh_desktop_database() {
  applications_dir="$1"
  if command_exists update-desktop-database; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
  fi
}

write_legacy_hidden_desktop_entry() {
  applications_dir="$1"
  legacy_desktop_file="${applications_dir}/ASF Junban.desktop"

  {
    printf '%s\n' '[Desktop Entry]'
    printf '%s\n' 'Type=Application'
    printf '%s\n' 'Name=ASF Junban'
    printf '%s\n' 'Hidden=true'
  } >"$legacy_desktop_file"
  chmod 644 "$legacy_desktop_file"
}

write_desktop_entry() {
  applications_dir="$1"
  exec_command="$2"
  escaped_exec_command="$(printf '%s' "$exec_command" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  desktop_file="${applications_dir}/Junban.desktop"

  rm -f "${applications_dir}/junban.desktop"
  {
    printf '%s\n' '[Desktop Entry]'
    printf '%s\n' 'Type=Application'
    printf '%s\n' 'Name=Junban'
    printf '%s\n' 'Comment=Junban - Open-source local-first task management'
    printf 'Exec="%s"\n' "$escaped_exec_command"
    printf '%s\n' 'Icon=asf-junban'
    printf '%s\n' 'Terminal=false'
    printf '%s\n' 'Categories=Office;ProjectManagement;'
    printf '%s\n' 'StartupWMClass=asf-junban'
  } >"$desktop_file"
  chmod 644 "$desktop_file"
}

configure_user_launcher() {
  exec_command="$1"
  [ -n "${HOME:-}" ] || return 0

  applications_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
  mkdir -p "$applications_dir"
  write_desktop_entry "$applications_dir" "$exec_command"
  write_legacy_hidden_desktop_entry "$applications_dir"
  refresh_desktop_database "$applications_dir"
}

install_appimage() {
  [ -n "${HOME:-}" ] || die "HOME must be set for AppImage installation"
  appimage_dir="${INSTALL_DIR:-${HOME}/Applications}"

  appimage_url="$(find_asset_url AppImage)"
  [ -n "$appimage_url" ] || die "could not find an amd64 AppImage asset in the latest release"

  mkdir -p "$appimage_dir"
  appimage_path="${appimage_dir}/Junban.AppImage"

  info "Downloading Junban AppImage to ${appimage_path}"
  curl -fL "$appimage_url" -o "$appimage_path"
  [ -s "$appimage_path" ] || die "downloaded AppImage asset is empty"
  chmod +x "$appimage_path"
  configure_user_launcher "$appimage_path"

  info "Junban AppImage installed. Launch it from your app menu or run: ${appimage_path}"
}

detect_linux_distro
describe_detection

RECOMMENDED_INSTALL_KIND="appimage"
if is_debian_like && command_exists apt-get; then
  RECOMMENDED_INSTALL_KIND="deb"
fi

if [ "$INSTALL_KIND" = "choose" ]; then
  choose_install_kind "$RECOMMENDED_INSTALL_KIND"
elif [ "$INSTALL_KIND" = "auto" ]; then
  if is_debian_like && command_exists apt-get; then
    INSTALL_KIND="deb"
  else
    INSTALL_KIND="appimage"
  fi
fi
describe_install_choice

info "Fetching latest Junban release metadata"
curl -fsSL "$API_URL" -o "$RELEASE_JSON"

case "$INSTALL_KIND" in
  deb) install_deb ;;
  appimage) install_appimage ;;
esac
