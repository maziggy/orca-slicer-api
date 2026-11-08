#!/bin/sh
# Download one asset of a GitHub release.
#
# Usage: fetch-release-asset.sh <owner/repo> <tag> <name-regex> <dest>
#
# Goes through the API's asset endpoint, not the release page's
# github.com/<repo>/releases/download/... link: that link answered 504
# (2026-11-08) while the API endpoint served the same file. The asset is the
# first one whose name matches <name-regex> (a JavaScript regex).
set -eu

REPO="$1"
TAG="$2"
PATTERN="$3"
DEST="$4"
RETRY="--retry 5 --retry-all-errors --retry-delay 10"

# shellcheck disable=SC2086
ASSET="$(curl -fsSL $RETRY -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
    | node -e '
        let body = "";
        process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
            const pattern = new RegExp(process.argv[1]);
            const asset = (JSON.parse(body).assets || []).find((a) => pattern.test(a.name));
            if (!asset) process.exit(1);
            console.log(`${asset.url} ${asset.name}`);
        });
    ' "$PATTERN")" || {
    echo "ERROR: no asset matching /$PATTERN/ in $REPO $TAG" >&2
    exit 1
}

echo "Downloading ${ASSET#* } from $REPO $TAG"
# shellcheck disable=SC2086
curl -fL $RETRY -H "Accept: application/octet-stream" -o "$DEST" "${ASSET%% *}"
