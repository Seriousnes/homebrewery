#!/bin/sh
# Entrypoint of deploy/e2e-linux/Dockerfile: the working tree arrives on stdin as a tar
# (web/e2e/run-linux.mjs), becomes a main checkout with LF line endings (what actions/checkout
# gives CI), then, from web/ as in the CI jobs:
#   suite <args…>   node e2e/matrix/run-suite.mjs <args…>   (the e2e job)
#   verify          node scripts/verify.mjs web unit        (the web and unit jobs)
set -eu
mode="$1"
shift
tar -x -C /repo
cd /repo
git init -q
git config user.name e2e-linux
git config user.email e2e-linux@localhost
git config core.autocrlf input
git config core.safecrlf false
git add -A
git commit -q --no-verify -m "working tree"
# Rewrite every file from the commit: the host's CRLF files come out with CI's line endings.
git rm -rq --cached .
git reset -q --hard
# node_modules was installed from this package-lock.json (the image is built from it).
touch web/node_modules/.package-lock.json
echo "[e2e-linux] $(git ls-files | wc -l) files, node $(node -v), dotnet $(dotnet --version)"
cd web
case "$mode" in
  suite) exec node e2e/matrix/run-suite.mjs "$@" ;;
  verify) exec node scripts/verify.mjs web unit ;;
  *) echo "[e2e-linux] unknown mode $mode" >&2; exit 2 ;;
esac
