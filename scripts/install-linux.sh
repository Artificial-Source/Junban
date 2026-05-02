#!/usr/bin/env sh
set -eu

REPO="${JUNBAN_REPO:-Artificial-Source/Junban}"
API_URL="${JUNBAN_RELEASE_API:-https://api.github.com/repos/${REPO}/releases/latest}"
INSTALL_KIND="${JUNBAN_INSTALL_KIND:-auto}"
INSTALL_DIR="${JUNBAN_INSTALL_DIR:-}"
OS_RELEASE_FILE="${JUNBAN_OS_RELEASE_FILE:-/etc/os-release}"
ASSET_ARCH="amd64"

usage() {
  printf '%s\n' 'Usage: install-linux.sh [--auto|--deb|--appimage]'
  printf '%s\n' ''
  printf '%s\n' 'Installs the latest Junban Linux desktop release.'
  printf '%s\n' ''
  printf '%s\n' 'Options:'
  printf '%s\n' '  --auto       Use .deb on Debian/Ubuntu, AppImage elsewhere (default)'
  printf '%s\n' '  --deb        Force the Debian/Ubuntu .deb installer; may require sudo'
  printf '%s\n' '  --appimage   Force the portable AppImage installer; does not use sudo'
  printf '%s\n' '  -h, --help   Show this help'
  printf '%s\n' ''
  printf '%s\n' 'Environment:'
  printf '%s\n' '  JUNBAN_INSTALL_DIR   AppImage install directory (default: ~/Applications)'
  printf '%s\n' '  JUNBAN_INSTALL_KIND  auto, deb, or appimage'
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
  auto | deb | appimage) ;;
  *) die "JUNBAN_INSTALL_KIND must be auto, deb, or appimage" ;;
esac

[ "$(uname -s)" = "Linux" ] || die "this installer only supports Linux"

case "$(uname -m)" in
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

is_debian_like() {
  if [ -r "$OS_RELEASE_FILE" ]; then
    # /etc/os-release is the standard Linux distribution identity file.
    # shellcheck disable=SC1090,SC1091
    . "$OS_RELEASE_FILE"
    case "${ID:-} ${ID_LIKE:-}" in
      *debian* | *ubuntu*) return 0 ;;
    esac
  fi

  return 1
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

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    die "cannot ask for sudo confirmation without an interactive terminal; rerun as root or use --appimage"
  fi

  printf 'Continue with sudo apt-get install? [y/N] '
  IFS= read -r answer || die "could not read sudo confirmation"
  case "$answer" in
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

  info "Junban installed. Launch it from your app menu."
}

write_desktop_entry() {
  appimage_path="$1"
  escaped_appimage_path="$(printf '%s' "$appimage_path" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  applications_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
  desktop_file="${applications_dir}/junban.desktop"

  mkdir -p "$applications_dir"
  {
    printf '%s\n' '[Desktop Entry]'
    printf '%s\n' 'Type=Application'
    printf '%s\n' 'Name=Junban'
    printf '%s\n' 'Comment=Local-first task manager'
    printf 'Exec="%s"\n' "$escaped_appimage_path"
    printf '%s\n' 'Terminal=false'
    printf '%s\n' 'Categories=Office;Utility;'
    printf '%s\n' 'StartupWMClass=Junban'
  } >"$desktop_file"
  chmod 644 "$desktop_file"

  if command_exists update-desktop-database; then
    update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
  fi
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
  write_desktop_entry "$appimage_path"

  info "Junban AppImage installed. Launch it from your app menu or run: ${appimage_path}"
}

if [ "$INSTALL_KIND" = "auto" ]; then
  if is_debian_like && command_exists apt-get; then
    INSTALL_KIND="deb"
  else
    INSTALL_KIND="appimage"
  fi
fi

info "Fetching latest Junban release metadata"
curl -fsSL "$API_URL" -o "$RELEASE_JSON"

case "$INSTALL_KIND" in
  deb) install_deb ;;
  appimage) install_appimage ;;
esac
