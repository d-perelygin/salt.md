# --- Frontend build (its output is the same for every target arch) ---
FROM --platform=$BUILDPLATFORM node:20-alpine AS web
ARG VERSION=dev
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install
COPY web ./
# `npm run build` runs the whole gate first, and part of that gate reads files
# OUTSIDE web/: check-wiki.mjs compares the wiki against the MCP catalogue and
# the route table. Without these two the image build died on a missing
# directory — the gate is deliberately not skippable, so what it needs has to
# be here.
#
# The cost is honest and worth naming: a change under server/ now busts this
# layer's cache and the frontend rebuilds. That is about thirty seconds on a
# build that only runs on a tag, and the alternative is a check that silently
# does not run in one of the two places we build.
COPY wiki /src/wiki
COPY server /src/server
# Same VERSION the backend is stamped with, so the two never disagree and the
# "reload" banner only fires after an actual deploy.
RUN SALT_VERSION=${VERSION} npm run build

# --- Backend build (cross-compiled to the requested target arch) ---
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
COPY --from=web /src/web/dist ./web/dist
# CGO off + pure-Go SQLite ⇒ a fully static binary, and building on the native
# builder while targeting $TARGETARCH avoids slow QEMU emulation of the compiler.
RUN go mod tidy && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w -X salt/server.Version=${VERSION}" -o /salt .

# --- Litestream (continuous replication of the database) ---
# Downloaded rather than built: it is somebody else's project with its own
# release cadence, and it is pinned here so that nothing upstream can quietly
# change what this instance replicates, or where. The checksum is fetched from
# the same release, so a truncated or substituted download fails the build
# instead of shipping.
FROM --platform=$BUILDPLATFORM alpine:3.20 AS litestream
ARG LITESTREAM_VERSION=0.5.17
ARG TARGETARCH
WORKDIR /tmp
# litestream calls 64-bit x86 "x86_64" where Go calls the same architecture
# "amd64". This mapping is the only place the two vocabularies meet, and without
# it the amd64 build asks the release for an asset that is not there.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) lsarch=x86_64 ;; \
      arm64) lsarch=arm64 ;; \
      *) echo "litestream publishes no build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache curl; \
    base="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}"; \
    asset="litestream-${LITESTREAM_VERSION}-linux-${lsarch}.tar.gz"; \
    curl -fsSL -o "${asset}" "${base}/${asset}"; \
    curl -fsSL -o checksums.txt "${base}/checksums.txt"; \
    grep "  ${asset}\$" checksums.txt | sha256sum -c -; \
    tar -xzf "${asset}" litestream; \
    ./litestream version

# --- Runtime ---
FROM alpine:3.20
RUN adduser -D -H salt && mkdir -p /data && chown salt /data
ENV SALT_ADDR=:8420 SALT_DATA=/data
VOLUME /data
EXPOSE 8420
COPY --from=build /salt /usr/local/bin/salt
# Litestream runs in THIS container rather than beside it, because only the
# parent process can restore the database before the server opens it — the
# ordering that matters on a fresh host. It stays completely out of the way
# unless the LITESTREAM_* variables are set, so the image still runs bare; see
# deploy/docker-entrypoint.sh for the switch and deploy/litestream.yml for what
# is replicated and for how long it is kept.
COPY --from=litestream /tmp/litestream /usr/local/bin/litestream
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Before USER salt, not after: chmod as the unprivileged user cannot touch a
# file that COPY left owned by root.
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
USER salt
ENTRYPOINT ["docker-entrypoint.sh"]
