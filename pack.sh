#!/bin/sh
# Builds the .iinaplgz archive attached to a GitHub release.
#
# Two quirks of `iina-plugin pack` make this wrapper necessary:
#   - it refuses any folder whose name does not end in .iinaplugin;
#   - it archives everything the folder holds, .git and working notes included.
# So we stage just the files that ship, under the name the tool insists on.
set -e

NAME="edl-skip"
SRC=$(cd "$(dirname "$0")" && pwd)
PACK="/Applications/IINA.app/Contents/MacOS/iina-plugin"
STAGE=$(mktemp -d)

trap 'rm -rf "$STAGE"' EXIT

mkdir "$STAGE/$NAME.iinaplugin"
for f in Info.json index.js preferences.html README.md LICENSE; do
    cp "$SRC/$f" "$STAGE/$NAME.iinaplugin/$f"
done

(cd "$STAGE" && "$PACK" pack "$NAME.iinaplugin" >/dev/null)

mv "$STAGE"/*.iinaplgz "$SRC/"
echo "built $(ls "$SRC"/*.iinaplgz)"
