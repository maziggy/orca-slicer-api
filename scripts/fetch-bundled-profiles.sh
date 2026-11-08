#!/bin/sh
# Give the profile resolver a JSON tree of the slicer's bundled profiles.
#
# Usage: fetch-bundled-profiles.sh <appimage-root> <orca-version> <dest>
#
# The resolver reads BBL.json, BBL/ and OrcaFilamentLibrary(.json|/) from the
# folder BUNDLED_PROFILES_PATH points into. Up to 2.4.x OrcaSlicer ships that
# tree in resources/profiles. From 2.5.0 a release ships each vendor as one
# binary preset cache (<vendor>.opc) and drops the JSON; the slicer reads the
# cache, the resolver cannot. For those releases the JSON comes from the same
# release's source tag, and the build fails unless its version is the one the
# cache was built from, so the resolver and the slicer always see the same
# presets.
#
# <dest> ends up holding BBL.json, BBL/, OrcaFilamentLibrary.json and
# OrcaFilamentLibrary/ either way (a symlink into the AppImage when it still
# ships JSON).
set -eu

ROOT="$1"
VERSION="$2"
DEST="$3"
PROFILES="$ROOT/resources/profiles"
VENDORS="BBL OrcaFilamentLibrary"

if [ -f "$PROFILES/BBL.json" ]; then
    echo "Bundled profiles ship as JSON; resolver reads them in place."
    ln -s "$(cd "$PROFILES" && pwd)" "$DEST"
    exit 0
fi

echo "Bundled profiles ship as preset caches; fetching JSON from v$VERSION source."
SRC="$(mktemp -d)"
git clone --quiet --depth 1 --branch "v$VERSION" --filter=blob:none --sparse \
    https://github.com/OrcaSlicer/OrcaSlicer.git "$SRC"
(cd "$SRC" && git sparse-checkout set resources/profiles/BBL resources/profiles/OrcaFilamentLibrary)

# "02.08.00.16" and "2.8.0.16" are the same version.
normalize() { echo "$1" | awk -F. '{for (i = 1; i <= NF; i++) printf "%s%d", (i > 1 ? "." : ""), $i}'; }

mkdir -p "$DEST"
for vendor in $VENDORS; do
    json="$SRC/resources/profiles/$vendor.json"
    cache="$PROFILES/$vendor.opc"
    [ -f "$json" ] || { echo "ERROR: $vendor.json missing from v$VERSION source" >&2; exit 1; }
    [ -f "$cache" ] || { echo "ERROR: $vendor.opc missing from the AppImage" >&2; exit 1; }
    want="$(normalize "$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9.]*\)".*/\1/p' "$json" | head -1)")"
    # The cache's stamps come first in the file; its vendor version is the
    # first dotted four-part number in it.
    have="$(normalize "$(grep -ao '[0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}' "$cache" | head -1)")"
    if [ -z "$want" ] || [ "$want" != "$have" ]; then
        echo "ERROR: $vendor.json is version '$want', $vendor.opc was built from '$have'" >&2
        exit 1
    fi
    echo "$vendor: JSON and cache both at $want"
    cp "$json" "$DEST/"
    cp -r "$SRC/resources/profiles/$vendor" "$DEST/"
done
rm -rf "$SRC"
