#!/bin/sh
# Entrypoint: the server, with replication around it when a replica is asked
# for, and exactly as it was before Litestream existed when one is not.
#
# Replication is opt-in through the environment on purpose. Without
# LITESTREAM_BUCKET this script does nothing but exec the server, so local runs,
# the test suite and anybody's existing `docker run` keep working untouched, and
# nothing reaches the network by accident.
#
# When replication IS on, Litestream has to be the parent process, and that is
# the whole reason this file exists rather than a sidecar container:
#
#   * Startup ordering — Litestream restores the database BEFORE the server
#     opens it. On a fresh host with an empty volume that is the difference
#     between "the instance comes back" and "the instance comes back empty and
#     then replicates that emptiness over the backup".
#   * Shutdown ordering — Litestream forwards SIGTERM to the server and waits
#     for it (its `-exec` supervision does this), so `docker stop` still gets
#     the drain-and-checkpoint shutdown the binary performs on SIGTERM. Without
#     that, the container would be killed at the end of Docker's grace period
#     every time.
set -e

# A subcommand — `salt backup`, `salt restore`, `salt version` — is a one-shot
# operation, not a server. Wrapping one in replication would start a server that
# never returns, which is the opposite of what the operator asked for.
if [ "$#" -gt 0 ]; then
  exec salt "$@"
fi

if [ -z "${LITESTREAM_BUCKET}" ]; then
  exec salt
fi

# The bucket is the switch; the rest is the configuration that switch promises.
# Naming what is empty here turns "the container restarts every ten seconds with
# an SDK error about a region" into a sentence that says which variable to set.
missing=
check() {
  [ -n "$2" ] || missing="${missing} $1"
}
check LITESTREAM_BUCKET           "${LITESTREAM_BUCKET}"
check LITESTREAM_ENDPOINT         "${LITESTREAM_ENDPOINT}"
check LITESTREAM_REGION           "${LITESTREAM_REGION}"
check LITESTREAM_PREFIX           "${LITESTREAM_PREFIX}"
check LITESTREAM_ACCESS_KEY_ID    "${LITESTREAM_ACCESS_KEY_ID}"
check LITESTREAM_SECRET_ACCESS_KEY "${LITESTREAM_SECRET_ACCESS_KEY}"
if [ -n "${missing}" ]; then
  echo "litestream: LITESTREAM_BUCKET is set, so replication is on, but these are empty:${missing}" >&2
  echo "litestream: set all of them, or unset LITESTREAM_BUCKET to run without replication." >&2
  exit 1
fi

# /etc/litestream.yml is baked into the image; the bucket, endpoint, region and
# prefix arrive through the environment, so one file serves every instance.
exec litestream replicate -exec "salt"
