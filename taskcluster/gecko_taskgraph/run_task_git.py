# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Ship Taskgraph's `run-task` with the Gecko specific python setup.

Tasks cloning with git run Taskgraph's `run-task` (as `run-task-git`) rather than
`taskcluster/scripts/run-task` (as `run-task-hg`), and only the latter puts the
`python` and `uv` fetches of a task on PATH. Rather than fork the whole script,
`taskcluster/scripts/run-task-git.patch` makes it call the same
`run_task_python` module as its hg counterpart.
"""

import atexit
import functools
import importlib.metadata
import os
import shutil
import subprocess
import tempfile

from taskgraph.util import docker

# Computed here rather than imported from `gecko_taskgraph`, which imports this
# module.
GECKO = os.path.normpath(os.path.realpath(os.path.join(__file__, "..", "..", "..")))
SCRIPTS_DIR = os.path.join(GECKO, "taskcluster", "scripts")
PATCH = os.path.join(SCRIPTS_DIR, "run-task-git.patch")
PYTHON_SETUP_MODULE = os.path.join(SCRIPTS_DIR, "run_task_python.py")

PATCH_FAILED = """\
{patch} does not apply to the `run-task` of taskcluster-taskgraph {version}.

Refresh the patch so that `run-task-git` keeps setting up the `python` and `uv`
fetches, otherwise tasks cloning with git silently run with the system python and
without `uv`.

{error}"""


@functools.cache
def patched_run_task():
    """Return the path to a patched copy of Taskgraph's `run-task`."""
    source = os.path.join(docker.RUN_TASK_ROOT, "run-task")

    directory = tempfile.mkdtemp(prefix="run-task-git.")
    atexit.register(shutil.rmtree, directory, True)

    destination = os.path.join(directory, "run-task")
    shutil.copyfile(source, destination)
    # The docker image context hash covers the file mode, so don't let the umask
    # of whoever generates the context decide it.
    shutil.copymode(source, destination)

    process = subprocess.run(
        ["git", "apply", PATCH],
        cwd=directory,
        check=False,
        capture_output=True,
        encoding="utf-8",
    )
    if process.returncode:
        raise Exception(
            PATCH_FAILED.format(
                patch=PATCH,
                version=importlib.metadata.version("taskcluster-taskgraph"),
                error=process.stderr,
            )
        )

    return destination
