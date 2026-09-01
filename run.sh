#!/usr/bin/env bash

# Exit on errors, unset variables, and failed pipeline commands.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Print the supported launch modes and examples.
usage() {
  printf '%s\n' \
    'SoundGuildManager (SGM)' \
    '' \
    'Usage: ./run.sh [docker|install|local|check|logs]' \
    '' \
    '  docker  Build and start the bot with Docker (default)' \
    '  install Install Docker and application requirements' \
    '  local   Install missing npm packages and run with Node.js' \
    '  check   Run syntax checks and tests without starting the bot' \
    '  logs    Follow logs from the Docker container' \
    '' \
    'Examples:' \
    '  ./run.sh' \
    '  ./run.sh local' \
    '  ./run.sh check'
}

# Return success when running from a Windows Bash environment.
is_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Return the privilege command needed for system package installation.
admin_command() {
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  require_command sudo
  printf '%s' sudo
}

# Install Docker Desktop on Windows using Microsoft's Windows Package Manager.
install_docker_windows() {
  if ! command -v winget.exe >/dev/null 2>&1; then
    printf '%s\n' \
      'Windows Package Manager (winget) is required to install Docker Desktop.' \
      'Install App Installer from the Microsoft Store, then run this script again:' \
      'https://apps.microsoft.com/detail/9nblggh4nns1' >&2
    exit 1
  fi

  printf '%s\n' \
    'Docker Desktop is missing. Downloading and installing it with winget...' \
    'Windows may display an administrator approval prompt.'
  winget.exe install --exact --id Docker.DockerDesktop \
    --accept-package-agreements --accept-source-agreements
}

# Install Docker Engine and Compose from Docker's official convenience script.
install_docker_linux() {
  if [[ ! -r /etc/os-release ]]; then
    printf '%s\n' 'Cannot identify this Linux distribution.' >&2
    exit 1
  fi

  # The official installer supports these distributions directly and safely.
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
    printf '%s\n' \
      "Automatic installation does not support ${PRETTY_NAME:-this distribution}." \
      'Use an Ubuntu 24.04 or Debian 12 host, or install Docker manually:' \
      'https://docs.docker.com/engine/install/' >&2
    exit 1
  fi

  local admin
  admin="$(admin_command)"
  if ! command -v curl >/dev/null 2>&1; then
    $admin apt-get update
    $admin apt-get install -y ca-certificates curl
  fi

  local install_dir install_script
  install_dir="$(mktemp -d)"
  install_script="$install_dir/get-docker.sh"
  printf '%s\n' 'Docker is missing. Downloading the official Docker installer...'
  curl --fail --silent --show-error --location https://get.docker.com --output "$install_script"
  $admin sh "$install_script"
  rm -rf -- "$install_dir"

  # Docker group membership takes effect after login; sudo works immediately.
  if [[ "$(id -u)" -ne 0 ]]; then
    $admin usermod -aG docker "$USER"
    printf '%s\n' 'Added your user to the docker group. Log out and back in to use Docker without sudo.'
  fi
}

# Install the Docker distribution appropriate for this operating system.
install_docker() {
  if is_windows; then
    install_docker_windows
  elif [[ "$(uname -s)" == "Linux" ]]; then
    install_docker_linux
  else
    printf '%s\n' \
      'Automatic Docker installation is supported on Windows, Ubuntu, and Debian.' \
      'Install Docker Desktop from: https://docs.docker.com/desktop/' >&2
    exit 1
  fi
}

# Locate Docker even when Windows has not refreshed Git Bash's PATH after install.
set_docker_command() {
  if command -v docker >/dev/null 2>&1; then
    DOCKER_COMMAND=(docker)
    return 0
  fi

  if is_windows; then
    local docker_desktop_cli='/c/Program Files/Docker/Docker/resources/bin/docker.exe'
    if [[ -x "$docker_desktop_cli" ]]; then
      DOCKER_COMMAND=("$docker_desktop_cli")
      return 0
    fi
  fi

  return 1
}

# Start Docker Desktop and wait until its Linux container engine is ready.
start_docker_desktop() {
  local docker_desktop='/c/Program Files/Docker/Docker/Docker Desktop.exe'
  if [[ ! -f "$docker_desktop" ]]; then
    printf '%s\n' \
      'Docker Desktop was installed, but its executable could not be found.' \
      'Start Docker Desktop manually, then run this script again.' >&2
    exit 1
  fi

  printf '%s\n' 'Starting Docker Desktop and waiting for its engine...'
  powershell.exe -NoProfile -NonInteractive -Command \
    "Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe'" >/dev/null

  local attempt
  for attempt in {1..90}; do
    if "${DOCKER_COMMAND[@]}" info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  printf '%s\n' \
    'Docker Desktop did not become ready within three minutes.' \
    'Finish any setup shown in Docker Desktop, then run this script again.' >&2
  exit 1
}

# Ensure Docker and the Compose plugin exist, installing them when necessary.
ensure_docker() {
  if ! set_docker_command; then
    install_docker
    if ! set_docker_command; then
      printf '%s\n' \
        'Docker was installed, but the command is not available yet.' \
        'Open a new terminal and run this script again.' >&2
      exit 1
    fi
  fi

  if is_windows && ! "${DOCKER_COMMAND[@]}" info >/dev/null 2>&1; then
    start_docker_desktop
  fi

  if "${DOCKER_COMMAND[@]}" compose version >/dev/null 2>&1; then
    return 0
  elif ! is_windows && command -v sudo >/dev/null 2>&1 && sudo docker compose version >/dev/null 2>&1; then
    DOCKER_COMMAND=(sudo docker)
  else
    printf '%s\n' 'Docker is installed, but the daemon or Compose plugin is unavailable.' >&2
    exit 1
  fi
}

# Stop early with a clear message when a required command is unavailable.
require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
}

# Ensure configuration exists without printing or otherwise exposing secrets.
validate_env() {
  if [[ ! -f .env ]]; then
    printf '%s\n' 'Missing .env file.' 'Create it with: cp .env.example .env' >&2
    exit 1
  fi

  if ! grep -Eq '^DISCORD_TOKEN=.+$' .env || ! grep -Eq '^DISCORD_CLIENT_ID=.+$' .env; then
    printf '%s\n' 'Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env before starting.' >&2
    exit 1
  fi
}

# Build the image, start the bot in the background, and show recent logs.
run_docker() {
  validate_env
  ensure_docker
  printf '%s\n' 'Building the image and installing application requirements...'
  "${DOCKER_COMMAND[@]}" compose up --build -d
  "${DOCKER_COMMAND[@]}" compose logs --tail=30
}

# Install dependencies when needed and start the bot in the current terminal.
run_local() {
  require_command node
  require_command npm
  require_command yt-dlp
  validate_env
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  npm start
}

# Select a launch mode; Docker is the default for the simplest setup.
case "${1:-docker}" in
  docker) run_docker ;;
  install)
    ensure_docker
    printf '%s\n' 'Building the image and installing application requirements...'
    "${DOCKER_COMMAND[@]}" compose build
    "${DOCKER_COMMAND[@]}" --version
    "${DOCKER_COMMAND[@]}" compose version
    ;;
  local) run_local ;;
  check)
    require_command npm
    npm run check
    npm test
    ;;
  logs)
    ensure_docker
    "${DOCKER_COMMAND[@]}" compose logs -f
    ;;
  -h|--help|help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
