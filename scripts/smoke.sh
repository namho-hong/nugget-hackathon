#!/usr/bin/env sh
set -eu

pnpm build
./nugget --help >/dev/null
./nugget logout >/dev/null

printf '%s\n' "smoke ok"
