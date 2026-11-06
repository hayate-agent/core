#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Run inside the built runtime image as its normal uid1000 user.
# Downloads pinned user-owned tooling/browser; no apt, sudo or cluster credentials.
set -eu
[ "$(id -u)" != 0 ]
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
# Global user tooling and native build prerequisites must work without root.
command -v cc
python3 -m venv "$work/venv"
"$work/venv/bin/python" -m pip --version
npm install --global --no-audit --no-fund --ignore-scripts @playwright/cli@0.1.22
playwright-cli --help >/dev/null
npm install --no-audit --no-fund --save-exact agent-browser@0.39.2
./node_modules/.bin/agent-browser install
# Container smoke only; deployment sandbox policy must be assessed separately.
export AGENT_BROWSER_ARGS='--no-sandbox'
./node_modules/.bin/agent-browser open 'data:text/html,<title>Harness browser smoke</title><h1>Browser works</h1>'
./node_modules/.bin/agent-browser get title | grep -F 'Harness browser smoke'
./node_modules/.bin/agent-browser close
