#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

# Runs enterprise-end2end.py, which reads the GitHub token run-task minted into
# $GITHUB_TOKEN from the task's `secrets`.
#
# Keeps xtrace off throughout, including when the caller turned it on, so the
# token in the environment never gets printed into the task log.

set +x
set -eu
set -o pipefail

: "${MOZ_SCM_LEVEL:?}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 -u "${script_dir}/enterprise-end2end.py" "$@"
