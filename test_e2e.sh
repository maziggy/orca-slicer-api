#!/bin/bash
#
# End-to-end tests. These drive real slicing, so they need a slicer binary --
# which lives only inside the sidecar images. The suite therefore runs in a
# container with this working tree mounted over it, so you test the code you
# are editing rather than whatever was baked into the image.
#
# Both flavours are covered because they are not interchangeable: the bundle
# selector path is BambuStudio-only (the H2D fixture is a dual-nozzle printer
# OrcaSlicer refuses), and `SLICER_FLAVOR` is what lets the suite skip rather
# than fail. Running only one flavour leaves that gap untested.
#
# Usage:
#   ./test_e2e.sh                # both flavours
#   ./test_e2e.sh orca           # OrcaSlicer only
#   ./test_e2e.sh bambu          # BambuStudio only
#   ./test_e2e.sh --build        # build the dedicated test images first
#   ./test_e2e.sh orca -- -t foo # everything after `--` goes to vitest
#
# Scoped to tests/e2e on purpose. The unit tests need no slicer, ./test_unit.sh
# runs them on the host in under a second, and running them in here as well
# only made them provoke slicer errors that logged as noise around a green run.
#
# Image selection: reuses a locally-built sidecar image when one exists
# (fast), otherwise falls back to the images published on GHCR. `--build`
# forces tests/docker/Dockerfile.test* instead, which is what CI does -- that
# path downloads a ~110-220 MB AppImage on a cold cache.

set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

TARGETS=()
DO_BUILD=0
VITEST_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        orca|bambu) TARGETS+=("$1"); shift ;;
        --build)    DO_BUILD=1; shift ;;
        --)         shift; VITEST_ARGS=("$@"); break ;;
        -h|--help)  sed -n '2,26p' "$0"; exit 0 ;;
        *) echo -e "${RED}unknown arg: $1${NC}" >&2; exit 2 ;;
    esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
    TARGETS=(orca bambu)
fi

# Resolve the image to run a flavour in. Prefers a local build so you are not
# silently testing against a published image that predates your changes.
resolve_image() {
    local flavor="$1" repo candidate
    case "$flavor" in
        orca)  repo="orca-slicer-api" ;;
        bambu) repo="bambu-studio-api" ;;
    esac

    if [ "$DO_BUILD" = 1 ]; then
        local dockerfile="tests/docker/Dockerfile.test"
        [ "$flavor" = "bambu" ] && dockerfile="tests/docker/Dockerfile.test.bambu-studio"
        candidate="${repo}:e2e-local"
        echo -e "${BLUE}==> building ${candidate} from ${dockerfile}${NC}" >&2
        docker build -f "$dockerfile" -t "$candidate" . >&2
        echo "$candidate"
        return
    fi

    # Newest local image for this repo, whatever it is tagged.
    candidate=$(docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
        | awk -v r="$repo" -F'\t' '$1 ~ "(^|/)"r":" && $1 !~ ":<none>$" {print $2"\t"$1}' \
        | sort -r | head -1 | cut -f2)

    if [ -n "$candidate" ]; then
        echo "$candidate"
        return
    fi

    candidate="ghcr.io/maziggy/${repo}:latest"
    echo -e "${YELLOW}No local ${repo} image; pulling ${candidate}${NC}" >&2
    docker pull "$candidate" >&2
    echo "$candidate"
}

FAILED=()

for flavor in "${TARGETS[@]}"; do
    image=$(resolve_image "$flavor")

    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  e2e: ${flavor}${NC}"
    echo -e "${BLUE}  image: ${image}${NC}"
    echo -e "${BLUE}========================================${NC}"

    # vitest comes from the mounted tree's node_modules (run "npm ci" first),
    # and starts with node: the sidecar images ship neither npm nor npx.
    # DATA_PATH and the scratch dirs live inside the container so a run never
    # writes into the working tree. ORCASLICER_PATH is the slicer-agnostic var
    # the wrapper reads; in the BambuStudio image it points at BambuStudio.
    if docker run --rm \
        -v "$PWD:/work" \
        -w /work \
        -e ORCASLICER_PATH=/app/squashfs-root/AppRun \
        -e DATA_PATH=/tmp/e2e-data \
        -e OUTPUT_PATH=/tmp/e2e-output \
        -e NODE_ENV=test \
        -e SLICER_FLAVOR="$flavor" \
        -e NPM_CONFIG_UPDATE_NOTIFIER=false \
        -e NPM_CONFIG_FUND=false \
        --entrypoint node \
        "$image" node_modules/vitest/vitest.mjs run tests/e2e "${VITEST_ARGS[@]}"; then
        echo -e "${GREEN}e2e ${flavor}: passed${NC}"
    else
        echo -e "${RED}e2e ${flavor}: FAILED${NC}"
        FAILED+=("$flavor")
    fi
done

echo ""
if [ ${#FAILED[@]} -gt 0 ]; then
    echo -e "${RED}Failed flavours: ${FAILED[*]}${NC}"
    exit 1
fi
echo -e "${GREEN}All e2e flavours passed${NC}"
