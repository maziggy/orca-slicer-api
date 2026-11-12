FROM node:22-bookworm AS build

ARG ORCA_VERSION=2.5.0
ARG TARGETARCH

WORKDIR /app

# Download OrcaSlicer based on architecture
# AMD64: Use official AppImage from SoftFever/OrcaSlicer
# ARM64: Use custom-built AppImage from kldzj/orca-slicer-arm64
# set -e: a failed download or extraction stops this step instead of
# surfacing later as missing presets. curl -f: an HTTP error page is an
# error, not a file saved as the AppImage. GitHub's release downloads answer
# 504 at times, for minutes; the retries ride that out.
# The AppImages since OrcaSlicer 2.5.0 / BambuStudio 02.09 unpack with 700
# directories; chmod opens them so the image also runs as a non-root user
# (bambuddy#3524), and the check stops a build that would not.
RUN set -e; \
	if [ "$TARGETARCH" = "arm64" ]; then \
	echo "Downloading ARM64 AppImage from kldzj/orca-slicer-arm64..."; \
	URL="https://github.com/kldzj/orca-slicer-arm64/releases/download/v${ORCA_VERSION}-arm64/OrcaSlicer-${ORCA_VERSION}-arm64-linux.AppImage"; \
	else \
	echo "Downloading AMD64 AppImage from SoftFever/OrcaSlicer..."; \
	URL="https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage"; \
	fi; \
	curl -fL --retry 10 --retry-all-errors --retry-delay 30 -o orca.AppImage "$URL"; \
	chmod +x orca.AppImage; \
	./orca.AppImage --appimage-extract > /dev/null; \
	rm orca.AppImage; \
	chmod -R a+rX squashfs-root; \
	if [ -n "$(find squashfs-root -type d ! -perm -o=rx)" ]; then \
	echo "ERROR: squashfs-root has directories other users cannot enter" >&2; \
	exit 1; \
	fi; \
	if [ ! -f squashfs-root/resources/profiles/BBL.json ] && [ ! -f squashfs-root/resources/profiles/BBL.opc ]; then \
	echo "ERROR: the extracted AppImage has no resources/profiles/BBL.json or BBL.opc" >&2; \
	exit 1; \
	fi

# The profile resolver's JSON tree (OrcaSlicer 2.5.0+ ships binary preset
# caches only; see the script).
COPY scripts/fetch-bundled-profiles.sh /tmp/
RUN /tmp/fetch-bundled-profiles.sh /app/squashfs-root "${ORCA_VERSION}" /app/bundled-profiles

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM ubuntu:24.04

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends \
	curl ca-certificates gnupg \
	&& mkdir -p /etc/apt/keyrings \
	&& curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
	&& echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
	nodejs \
	libgl1 libgl1-mesa-dri libegl1 libopengl0 libglu1-mesa \
	libsm6 libice6 libmspack0 \
	libgtk-3-0 \
	libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
	libwebkit2gtk-4.1-0 \
	&& update-ca-certificates \
	&& rm -rf /var/lib/apt/lists/*


COPY --from=build /app/dist/src /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/squashfs-root /app/squashfs-root
COPY --from=build /app/bundled-profiles /app/bundled-profiles

ENV PORT=3000
ENV ORCASLICER_PATH=/app/squashfs-root/AppRun
ENV BUNDLED_PROFILES_PATH=/app/bundled-profiles/BBL
ENV DATA_PATH=/app/data
ENV NODE_ENV=production
# Which slicer this image wraps. The wrapper itself is slicer-agnostic;
# tests use this to skip coverage that only applies to one of them.
ENV SLICER_FLAVOR=orca

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "app/dist/index.js"]