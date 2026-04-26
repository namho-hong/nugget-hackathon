#!/usr/bin/env sh
set -eu

SMOKE_HOME="${TMPDIR:-/tmp}/nugget-smoke-home"
mkdir -p "$SMOKE_HOME"

pnpm build
HOME="$SMOKE_HOME" ./nugget --help >/dev/null
HOME="$SMOKE_HOME" ./nugget logout >/dev/null
HOME="$SMOKE_HOME" ./nugget reset-state >/dev/null
HOME="$SMOKE_HOME" ./nugget doctor >/dev/null || true

printf '%s\n' "smoke ok"
