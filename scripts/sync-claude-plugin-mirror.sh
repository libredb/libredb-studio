#!/usr/bin/env bash
# Mirrors plugins/libredb-studio and the repository's LICENSE from the commit a
# LibreDB Studio checkout has out to the root of the plugin's read-only copy,
# libredb/libredb-studio-claude-plugin, the repository Anthropic's plugin
# directory reads. .github/workflows/claude-plugin-mirror.yml runs it.
#
# Usage: sync-claude-plugin-mirror.sh <studio checkout> <scratch dir> <copy url>
#
# The copy's tree is built from the checkout's committed objects, never from
# files on disk: the plugin folder's entries as they are, and LICENSE beside
# them, so no other path of the repository, and nothing uncommitted, can reach
# the copy. When that tree differs from the copy's main, one commit, authored
# as github-actions[bot] and naming the source commit, is pushed on top of it
# without force; when it does not, a dry-run push still proves that the
# credentials can push. The checkout is only read, and the scratch directory,
# which must not exist yet, is the only place written. The URL carries no
# credentials: git asks its credential helper when the push needs them.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: sync-claude-plugin-mirror.sh <studio checkout> <scratch dir> <copy url>" >&2
  exit 2
fi
SOURCE="$1"
WORK="$2"
COPY_URL="$3"
PLUGIN_DIR="plugins/libredb-studio"
SOURCE_REPOSITORY="libredb/libredb-studio"
BOT_NAME="github-actions[bot]"
BOT_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
# A missing credential fails the push instead of waiting for someone to type one.
export GIT_TERMINAL_PROMPT=0

case "$COPY_URL" in
  *://*@*)
    echo "error: give the copy's URL without credentials; git's credential helper supplies them" >&2
    exit 2
    ;;
esac
if [ -e "$WORK" ]; then
  echo "error: $WORK already exists; give a scratch directory that does not" >&2
  exit 1
fi

SHA=$(git -C "$SOURCE" rev-parse --verify "HEAD^{commit}")
# Everything after the colon of <commit>:<path> is the path, so a ^{tree}
# suffix would be read as part of it; the object's type is asked for instead.
if [ "$(git -C "$SOURCE" cat-file -t "$SHA:$PLUGIN_DIR" 2> /dev/null || true)" != "tree" ]; then
  echo "error: $SOURCE_REPOSITORY@$SHA has no $PLUGIN_DIR folder" >&2
  exit 1
fi
if [ "$(git -C "$SOURCE" cat-file -t "$SHA:LICENSE" 2> /dev/null || true)" != "blob" ]; then
  echo "error: $SOURCE_REPOSITORY@$SHA has no LICENSE file" >&2
  exit 1
fi
# The copy's LICENSE is the repository's; a plugin LICENSE of its own would
# have to lose to it without a word, so the run stops instead.
if git -C "$SOURCE" cat-file -e "$SHA:$PLUGIN_DIR/LICENSE" 2> /dev/null; then
  echo "error: $PLUGIN_DIR has a LICENSE of its own, which would collide with the repository's" >&2
  exit 1
fi

# A bare scratch repository that reads the checkout's objects in place
# (objects/info/alternates) rather than copying them. It lists none of the
# checkout's refs as history it has: the checkout is shallow, and a fetch that
# walked one of its branches would read parents that were never fetched.
OBJECTS=$(git -C "$SOURCE" rev-parse --path-format=absolute --git-path objects)
git init --quiet --bare "$WORK"
git -C "$WORK" config core.alternateRefsCommand true
printf '%s\n' "$OBJECTS" > "$WORK/objects/info/alternates"

PARENT=""
if git ls-remote --exit-code "$COPY_URL" refs/heads/main > /dev/null; then
  git -C "$WORK" fetch --quiet --no-tags "$COPY_URL" "refs/heads/main:refs/remotes/copy/main"
  PARENT=$(git -C "$WORK" rev-parse --verify "refs/remotes/copy/main^{commit}")
else
  STATUS=$?
  # 2 is ls-remote's answer for a copy with no main yet; anything else means it could not be read.
  if [ "$STATUS" -ne 2 ]; then
    echo "error: could not read $COPY_URL (git ls-remote exited $STATUS)" >&2
    exit 1
  fi
fi

# The plugin folder's tree as it is, with the repository's LICENSE beside it,
# each a step of its own so that set -e stops on any of them.
git -C "$WORK" read-tree "$SHA:$PLUGIN_DIR"
LICENSE_ENTRY=$(git -C "$SOURCE" ls-tree --format='%(objectmode),%(objectname)' "$SHA" -- LICENSE)
git -C "$WORK" update-index --add --cacheinfo "$LICENSE_ENTRY,LICENSE"
TREE=$(git -C "$WORK" write-tree)

if [ -n "$PARENT" ] && [ "$(git -C "$WORK" rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  git -C "$WORK" push --dry-run --quiet "$COPY_URL" "$PARENT:refs/heads/main"
  echo "$COPY_URL main already holds $PLUGIN_DIR and LICENSE of $SOURCE_REPOSITORY@$SHA; nothing to push."
  exit 0
fi

# The copy's first commit has no parent; every later one has the copy's main.
COMMIT=$(
  GIT_AUTHOR_NAME="$BOT_NAME" GIT_AUTHOR_EMAIL="$BOT_EMAIL" \
    GIT_COMMITTER_NAME="$BOT_NAME" GIT_COMMITTER_EMAIL="$BOT_EMAIL" \
    git -C "$WORK" commit-tree "$TREE" ${PARENT:+-p "$PARENT"} \
    -m "Sync $PLUGIN_DIR from $SOURCE_REPOSITORY@$SHA" \
    -m "A read-only copy of https://github.com/$SOURCE_REPOSITORY/tree/$SHA/$PLUGIN_DIR and the repository's LICENSE. Change the plugin there, not here."
)
git -C "$WORK" push --quiet "$COPY_URL" "$COMMIT:refs/heads/main"
echo "Pushed $COMMIT to $COPY_URL main: $PLUGIN_DIR and LICENSE of $SOURCE_REPOSITORY@$SHA."
git -C "$WORK" diff-tree --root --no-commit-id --name-status -r "$COMMIT"
