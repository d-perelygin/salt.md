#!/bin/bash
# Build the image on this machine, push it to the Forgejo container registry on
# the emotera server, and switch a server deployment to that tag. The server no
# longer builds: it only pulls.
#
#   scripts/deploy-registry.sh                  # docs.emotera.ru
#   scripts/deploy-registry.sh --kbrd           # tasks.kbrdl.ru
#   scripts/deploy-registry.sh --both           # both instances
#   scripts/deploy-registry.sh --list           # tags in the registry
#   scripts/deploy-registry.sh --rollback TAG   # full tag, version or sha
#
# The build is local. The Dockerfile builds the frontend and the Go binary on
# BUILDPLATFORM, so an arm64 Mac produces a linux/amd64 image without emulating
# a compiler; only the alpine runtime stage runs emulated.
#
# One-time setup (already done for git.emotera.ru):
#   docker login git.emotera.ru -u d-perelygin   # token with write:package
#   ssh emotera docker login git.emotera.ru -u d-perelygin
# The server needs its own login because the package is private.
#
# Every deploy prints the tag it installed. The previous one keeps running
# until `docker compose up -d` swaps it, so a failed pull leaves the site up.
set -euo pipefail

REMOTE="emotera"

REGISTRY="git.emotera.ru"
PACKAGE="d-perelygin/salt.md"
IMAGE="${REGISTRY}/${PACKAGE}"
PLATFORM="linux/amd64"

# Local tags kept on the server and tags kept in the registry. The registry
# keeps more: that is the rollback horizon, and layers are shared between tags.
KEEP_IMAGES=5
KEEP_TAGS=10

DOCS_DIR="/opt/docker/salt-wiki"
DOCS_CONTAINER="salt"
DOCS_URL="https://docs.emotera.ru"

KBRD_DIR="/opt/docker/salt-kbrd"
KBRD_CONTAINER="salt-kbrd"
KBRD_URL="https://tasks.kbrdl.ru"

usage() {
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

MODE="deploy"
ARG=""
TARGETS=()

for arg in "$@"; do
    case "$arg" in
        --docs)     TARGETS+=("${DOCS_DIR}|${DOCS_CONTAINER}|${DOCS_URL}") ;;
        --kbrd)     TARGETS+=("${KBRD_DIR}|${KBRD_CONTAINER}|${KBRD_URL}") ;;
        --both)     TARGETS+=("${DOCS_DIR}|${DOCS_CONTAINER}|${DOCS_URL}"
                              "${KBRD_DIR}|${KBRD_CONTAINER}|${KBRD_URL}") ;;
        --list|-l)  MODE="list" ;;
        --rollback|-r) MODE="rollback" ;;
        -h|--help)  usage; exit 0 ;;
        -*)         echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
        *)          ARG="$arg" ;;
    esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
    TARGETS=("${DOCS_DIR}|${DOCS_CONTAINER}|${DOCS_URL}")
fi

# The registry API is on the server's loopback, so pruning and listing do not
# need the registry token on this machine; it already lives there for the
# pull login.
PKG_NAME="${PACKAGE##*/}"
PKG_OWNER="${PACKAGE%%/*}"

registry_request() {
    # $1 = "list" or a tag to delete; prints the JSON body or a status line.
    local action="$1" tag="${2:-}"

    ssh "$REMOTE" "bash -s -- '${action}' '${tag}' '${PKG_OWNER}' '${PKG_NAME}'" <<'REMOTE_EOF'
set -euo pipefail
action=$1
tag=${2:-}
owner=$3
name=$4
token=$(cat /opt/docker/forgejo/.salt-registry-token)
api="http://127.0.0.1:3030/api/v1/packages/${owner}"

case "$action" in
    list)
        curl -fsS -H "Authorization: token ${token}" "${api}?type=container"
        ;;
    delete)
        curl -fsS -o /dev/null -w '%{http_code}' -X DELETE \
            -H "Authorization: token ${token}" "${api}/container/${name}/${tag}"
        ;;
esac
REMOTE_EOF
}

# One line per tag, newest first: "v42-abc1234<TAB>2026-11-26T03:00:00Z".
# Digest versions (sha256:...) are the manifests behind the tags; they are not
# tags and pruning them would break whichever tag still points at that digest.
registry_versions() {
    registry_request list | python3 -c '
import json, sys
name = sys.argv[1]
packages = json.load(sys.stdin) or []
versions = [
    p for p in packages
    if p.get("name") == name and not p.get("version", "").startswith("sha256:")
]
versions.sort(key=lambda v: v.get("created_at") or "", reverse=True)
for v in versions:
    print(v.get("version", "?"), v.get("created_at", ""), sep="\t")
' "$PKG_NAME"
}

resolve_tag() {
    local target="$1" bare="${1#v}" matched

    matched=$(registry_versions | cut -f1 | while read -r tag; do
        [ -z "$tag" ] && continue
        version=${tag#v}
        version=${version%%-*}
        sha=${tag##*-}
        if [ "$tag" = "$target" ] ||
           [ "$tag" = "v${bare}" ] ||
           [ "$version" = "$bare" ] ||
           [ "$sha" = "$bare" ]; then
            echo "$tag"
            break
        fi
    done)

    if [ -z "$matched" ]; then
        echo "Tag '${target}' not found in ${IMAGE}" >&2
        list_tags >&2
        return 1
    fi
    echo "$matched"
}

list_tags() {
    local docs_tag kbrd_tag mark

    docs_tag=$(ssh "$REMOTE" "grep '^IMAGE_TAG=' ${DOCS_DIR}/.env 2>/dev/null | cut -d= -f2 || true")
    kbrd_tag=$(ssh "$REMOTE" "grep '^IMAGE_TAG=' ${KBRD_DIR}/.env 2>/dev/null | cut -d= -f2 || true")

    printf '%-22s %-12s %s\n' "TAG" "CREATED" "DEPLOYED"
    registry_versions | while IFS=$'\t' read -r tag created; do
        [ -z "$tag" ] && continue
        mark=""
        [ "$tag" = "$docs_tag" ] && mark="${mark} docs"
        [ "$tag" = "$kbrd_tag" ] && mark="${mark} kbrd"
        printf '%-22s %-12s%s\n' "$tag" "${created%%T*}" "$mark"
    done
}

# The compose files interpolate ${SALT_IMAGE} and ${IMAGE_TAG} from .env, so a
# switch is one line, not an edit of the compose file.
write_server_env() {
    local dir="$1" tag="$2"

    ssh "$REMOTE" bash -s -- "$dir" "$IMAGE" "$tag" <<'REMOTE_EOF'
set -euo pipefail
dir=$1
image=$2
tag=$3

cd "$dir"
touch .env

set_var() {
    if grep -q "^$1=" .env; then
        sed -i "s|^$1=.*|$1=$2|" .env
    else
        echo "$1=$2" >> .env
    fi
}

set_var SALT_IMAGE "$image"
set_var IMAGE_TAG "$tag"
REMOTE_EOF
}

deploy_target() {
    local spec="$1" tag="$2"
    local dir container url

    IFS='|' read -r dir container url <<<"$spec"

    echo "==> ${container} (${dir}) -> ${tag}"

    # Pull before switching: the old container keeps serving while this runs,
    # and a registry problem fails here instead of during the swap.
    ssh "$REMOTE" "docker pull ${IMAGE}:${tag}"
    write_server_env "$dir" "$tag"

    ssh "$REMOTE" "cd ${dir} && docker compose up -d --wait --wait-timeout 120"

    echo "    container: $(ssh "$REMOTE" "docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' ${container}")"

    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${url}/api/health" || true)
    if [ "$code" != "200" ]; then
        echo "    ${url}/api/health returned ${code:-no answer}" >&2
        return 1
    fi
    echo "    ${url} ok"
}

# Layers are shared between tags, so the registry cost of a tag is far below
# the image size; keeping ten still leaves room for rollback.
prune_registry() {
    local tags
    tags=$(registry_versions | cut -f1 | grep -v '^latest$' | tail -n +$((KEEP_TAGS + 1)) || true)

    [ -z "$tags" ] && { echo "==> registry: ${KEEP_TAGS} tags or fewer, nothing to prune"; return 0; }

    echo "==> registry: dropping $(echo "$tags" | wc -l | tr -d ' ') old tag(s)"
    while read -r tag; do
        [ -z "$tag" ] && continue
        echo "    ${tag}: $(registry_request delete "$tag")"
    done <<<"$tags"
}

# The server keeps local copies for instant rollback; the same tag can always
# be pulled again from the registry.
prune_local_images() {
    ssh "$REMOTE" bash -s -- "$IMAGE" "$KEEP_IMAGES" <<'REMOTE_EOF'
set -euo pipefail
image=$1
keep=$2

in_use=$(docker ps -aq | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null | sort -u || true)

removed=0
while IFS='|' read -r repo tag id created; do
    if [ "$tag" = "latest" ]; then
        continue
    fi
    if echo "$in_use" | grep -qx "$id"; then
        echo "    in use, kept: ${tag}"
        continue
    fi
    if docker rmi "${repo}:${tag}" >/dev/null 2>&1; then
        echo "    removed: ${tag}"
        removed=$((removed + 1))
    fi
done < <(
    docker images --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.CreatedAt}}' |
        awk -F'|' -v img="$image" '$1 == img { print }' |
        sort -t'|' -k4 -r |
        tail -n +$((keep + 1))
)

echo "    kept the newest ${keep} local tag(s), removed ${removed}"
REMOTE_EOF
}

build_and_push() {
    local count sha

    if [ -n "$(git status --porcelain)" ]; then
        echo "Working tree is dirty: the image will not match the tag." >&2
    fi

    count=$(git rev-list --count HEAD)
    sha=$(git rev-parse --short HEAD)
    TAG="v${count}-${sha}"

    echo "==> Building ${IMAGE}:${TAG} (${PLATFORM})"
    docker buildx build \
        --platform "$PLATFORM" \
        --build-arg VERSION="$TAG" \
        -t "${IMAGE}:${TAG}" \
        -t "${IMAGE}:latest" \
        --push \
        .

    echo "==> Pushed ${IMAGE}:${TAG}"
}

case "$MODE" in
    list)
        list_tags
        ;;
    rollback)
        if [ -z "$ARG" ]; then
            echo "Usage: $0 --rollback <tag|version|sha>" >&2
            exit 1
        fi
        TAG=$(resolve_tag "$ARG")
        echo "==> Resolved '${ARG}' to ${TAG}"
        for spec in "${TARGETS[@]}"; do
            deploy_target "$spec" "$TAG"
        done
        ;;
    deploy)
        build_and_push
        for spec in "${TARGETS[@]}"; do
            deploy_target "$spec" "$TAG"
        done
        prune_local_images
        prune_registry
        echo "==> Deployed ${TAG}"
        ;;
esac
