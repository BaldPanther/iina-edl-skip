#!/bin/sh
# Runs the test suites in macOS's own JavaScriptCore — no node, no npm.
# `osascript -l JavaScript` is JXA, which is JavaScriptCore with a Foundation
# bridge, so the tests execute on the same engine family as IINA's plugins.
set -e

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATUS=0

for suite in parser behaviour; do
    printf '%s: ' "$suite"
    if ! osascript -l JavaScript "$REPO/tests/$suite.test.js" "$REPO"; then
        STATUS=1
    fi
done

exit $STATUS
