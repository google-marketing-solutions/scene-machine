#!/usr/bin/env bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# install.sh - installs the scene-machine skill directory into the skill
# folders of supported agent tools (copy by default, symlink with --link).
# The script never downloads anything: it only copies the directory that
# sits next to it. See README.md ("Install methods") for the target table.

set -euo pipefail

SKILL="scene-machine"
SRC="$(cd "$(dirname "$0")" && pwd)/scene-machine"
PROG="$(basename "$0")"

TARGETS=()
DESTS=()
ALL=0
PROJECT_DIR=""
MODE="copy"
FORCE=0
HOMEDIR="${HOME:-}"
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: ./$PROG (--target NAME [--target NAME ...] | --all) [options]

Installs the $SKILL skill from
  $SRC
into the skill directory of one or more agent tools. The directory is copied
by default (nothing is downloaded). Re-running is safe: an identical existing
copy is left alone, a differing one is refused unless --force is given.

Options:
  --target NAME      Tool to install for (repeatable). NAME is one of:
                     claude antigravity codex gemini cursor windsurf copilot
                     agents all
  --all              Install for every tool above (identical destinations are
                     installed once).
  --project-dir DIR  Install into the project-level skill directory under DIR
                     instead of the global (home) directory. When given, the
                     global directories are skipped.
  --copy             Copy the directory (default).
  --link             Create a symlink to the source instead of a copy (local
                     development only; symlinks break the Copilot coding agent
                     and Windows and change silently under git pull).
  --force            Replace an existing destination that differs from the
                     source.
  --home DIR         Use DIR instead of \$HOME for the global directories
                     (used by the tests).
  --dry-run          Print one line per destination and change nothing.
  -h, --help         Show this help.

Destinations (global ; project-level with --project-dir):
  claude       ~/.claude/skills/$SKILL ; .claude/skills/$SKILL
  antigravity  ~/.gemini/antigravity/skills/$SKILL ;
               .agent/skills/$SKILL and .agents/skills/$SKILL
  codex        \${CODEX_HOME:-~/.agents}/skills/$SKILL ; .agents/skills/$SKILL
  gemini       ~/.gemini/skills/$SKILL ; .gemini/skills/$SKILL
  cursor       ~/.cursor/skills/$SKILL ; .cursor/skills/$SKILL
  windsurf     ~/.codeium/windsurf/skills/$SKILL ; .windsurf/skills/$SKILL
  copilot      ~/.copilot/skills/$SKILL ; .github/skills/$SKILL
  agents       ~/.agents/skills/$SKILL ; .agents/skills/$SKILL

Output: "[dry-run] copy|link <src> -> <dest>" per destination with --dry-run;
otherwise "installed <dest>" or "unchanged <dest>".
Exit codes: 0 ok; 1 a destination was refused or an operation failed; 2 usage.
USAGE
}

die_usage() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

# Lexical absolute path; the directory does not have to exist and symlinks are
# not resolved (keeps printed paths identical to what the caller passed in).
abspath() {
  local p="$1"
  case "$p" in
    /) printf '/\n'; return 0 ;;
    /*) ;;
    *) p="$PWD/$p" ;;
  esac
  printf '%s\n' "${p%/}"
}

add_target() {
  local name="$1"
  case "$name" in
    */*|*..*)
      die_usage "invalid target '$name': target names must not contain '/' or '..'"
      ;;
    claude|antigravity|codex|gemini|cursor|windsurf|copilot|agents)
      TARGETS+=("$name")
      ;;
    all)
      ALL=1
      ;;
    *)
      die_usage "unknown target '$name' (expected one of: claude antigravity codex gemini cursor windsurf copilot agents all)"
      ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || die_usage "--target needs a value"
      add_target "$2"
      shift 2
      ;;
    --target=*)
      add_target "${1#--target=}"
      shift
      ;;
    --all)
      ALL=1
      shift
      ;;
    --project-dir)
      [ $# -ge 2 ] || die_usage "--project-dir needs a value"
      PROJECT_DIR="$(abspath "$2")"
      shift 2
      ;;
    --project-dir=*)
      PROJECT_DIR="$(abspath "${1#--project-dir=}")"
      shift
      ;;
    --link)
      MODE="link"
      shift
      ;;
    --copy)
      MODE="copy"
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --home)
      [ $# -ge 2 ] || die_usage "--home needs a value"
      HOMEDIR="$(abspath "$2")"
      shift 2
      ;;
    --home=*)
      HOMEDIR="$(abspath "${1#--home=}")"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die_usage "unknown option '$1' (try --help)"
      ;;
  esac
done

if [ "$ALL" -eq 0 ] && [ "${#TARGETS[@]}" -eq 0 ]; then
  usage >&2
  die_usage "no target given: use --target NAME or --all"
fi

if [ ! -f "$SRC/SKILL.md" ]; then
  printf '%s: skill source not found at %s (expected SKILL.md there)\n' "$PROG" "$SRC" >&2
  exit 1
fi

if [ -z "$PROJECT_DIR" ] && [ -z "$HOMEDIR" ]; then
  die_usage "HOME is not set: pass --home DIR or --project-dir DIR"
fi

if [ "$ALL" -eq 1 ]; then
  TARGETS=(claude antigravity codex gemini cursor windsurf copilot agents)
fi

# Appends a destination unless an identical one is already planned.
add_dest() {
  local candidate="$1" seen
  for seen in ${DESTS[@]+"${DESTS[@]}"}; do
    [ "$seen" = "$candidate" ] && return 0
  done
  DESTS+=("$candidate")
}

global_dests() {
  case "$1" in
    claude) add_dest "$HOMEDIR/.claude/skills/$SKILL" ;;
    antigravity) add_dest "$HOMEDIR/.gemini/antigravity/skills/$SKILL" ;;
    codex)
      if [ -n "${CODEX_HOME:-}" ]; then
        add_dest "$(abspath "$CODEX_HOME")/skills/$SKILL"
      else
        add_dest "$HOMEDIR/.agents/skills/$SKILL"
      fi
      ;;
    gemini) add_dest "$HOMEDIR/.gemini/skills/$SKILL" ;;
    cursor) add_dest "$HOMEDIR/.cursor/skills/$SKILL" ;;
    windsurf) add_dest "$HOMEDIR/.codeium/windsurf/skills/$SKILL" ;;
    copilot) add_dest "$HOMEDIR/.copilot/skills/$SKILL" ;;
    agents) add_dest "$HOMEDIR/.agents/skills/$SKILL" ;;
  esac
}

project_dests() {
  case "$1" in
    claude) add_dest "$PROJECT_DIR/.claude/skills/$SKILL" ;;
    antigravity)
      add_dest "$PROJECT_DIR/.agent/skills/$SKILL"
      add_dest "$PROJECT_DIR/.agents/skills/$SKILL"
      ;;
    codex) add_dest "$PROJECT_DIR/.agents/skills/$SKILL" ;;
    gemini) add_dest "$PROJECT_DIR/.gemini/skills/$SKILL" ;;
    cursor) add_dest "$PROJECT_DIR/.cursor/skills/$SKILL" ;;
    windsurf) add_dest "$PROJECT_DIR/.windsurf/skills/$SKILL" ;;
    copilot) add_dest "$PROJECT_DIR/.github/skills/$SKILL" ;;
    agents) add_dest "$PROJECT_DIR/.agents/skills/$SKILL" ;;
  esac
}

if [ -n "$PROJECT_DIR" ]; then
  printf 'note: --project-dir given, global (home) installs are skipped\n' >&2
  for t in "${TARGETS[@]}"; do project_dests "$t"; done
else
  for t in "${TARGETS[@]}"; do global_dests "$t"; done
fi

# Removes __pycache__ directories and *.pyc files below $1 (no find(1)).
prune_caches() {
  local dir="$1" entry
  for entry in "$dir"/* "$dir"/.[!.]*; do
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      case "${entry##*/}" in
        __pycache__) rm -rf "$entry" ;;
        *) prune_caches "$entry" ;;
      esac
    elif [ -e "$entry" ] || [ -L "$entry" ]; then
      case "$entry" in
        *.pyc) rm -f "$entry" ;;
      esac
    fi
  done
  return 0
}

same_content() {
  diff -rq -x __pycache__ -x '*.pyc' "$SRC" "$1" >/dev/null 2>&1
}

# Only ever removes a path whose last component is the skill name.
remove_dest() {
  case "$1" in
    */"$SKILL") ;;
    *)
      printf '%s: refusing to remove unexpected path %s\n' "$PROG" "$1" >&2
      return 1
      ;;
  esac
  rm -rf "$1"
}

do_copy() {
  mkdir -p "$1" && cp -R "$SRC/." "$1" && prune_caches "$1"
}

do_link() {
  mkdir -p "$(dirname "$1")" && ln -s "$SRC" "$1"
}

install_one() {
  local dest="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s %s -> %s\n' "$MODE" "$SRC" "$dest"
    return 0
  fi
  if [ -L "$dest" ]; then
    if [ "$MODE" = "link" ] && [ "$(readlink "$dest")" = "$SRC" ]; then
      printf 'unchanged %s\n' "$dest"
      return 0
    fi
    # Removes the link only, never what it points to.
    rm -f "$dest" || return 1
  elif [ -d "$dest" ]; then
    if same_content "$dest"; then
      if [ "$MODE" = "copy" ]; then
        printf 'unchanged %s\n' "$dest"
        return 0
      fi
      # Identical copy requested as a link: nothing is lost by replacing it.
      remove_dest "$dest" || return 1
    elif [ "$FORCE" -eq 1 ]; then
      remove_dest "$dest" || return 1
    else
      printf '%s: %s exists and differs from %s; re-run with --force to replace it\n' \
        "$PROG" "$dest" "$SRC" >&2
      return 1
    fi
  elif [ -e "$dest" ]; then
    if [ "$FORCE" -eq 1 ]; then
      rm -f "$dest" || return 1
    else
      printf '%s: %s exists and is not a directory; re-run with --force to replace it\n' \
        "$PROG" "$dest" >&2
      return 1
    fi
  fi
  if [ "$MODE" = "link" ]; then
    do_link "$dest" || { printf '%s: failed to create symlink %s\n' "$PROG" "$dest" >&2; return 1; }
  else
    do_copy "$dest" || { printf '%s: failed to copy into %s\n' "$PROG" "$dest" >&2; return 1; }
  fi
  printf 'installed %s\n' "$dest"
}

FAILED=0
for dest in "${DESTS[@]}"; do
  install_one "$dest" || FAILED=1
done
exit "$FAILED"
