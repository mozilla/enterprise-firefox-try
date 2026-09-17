# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Put the `python` and `uv` fetches of a task on PATH.

This module is shipped next to both `run-task` flavours, so that a task uses the
toolchains it asked for whichever flavour runs it: `run-task-hg` is
`taskcluster/scripts/run-task` and calls this directly, while `run-task-git` is
Taskgraph's own script, which `taskcluster/scripts/run-task-git.patch` teaches to
call it too.
"""

import os
import subprocess
import sys

IS_MACOSX = sys.platform == "darwin"
IS_WINDOWS = os.name == "nt"


def _prepend_path(value):
    """Prepend `value` to PATH and return the new PATH."""
    previous = [os.environ["PATH"]] if "PATH" in os.environ else []
    os.environ["PATH"] = os.pathsep.join([value] + previous)
    return os.environ["PATH"]


def setup(print_line):
    """Add the `python` and `uv` fetches to PATH, when the task has them.

    `print_line` is the `run-task` logging helper, so that both flavours log
    these steps identically.
    """
    # If Python is a fetch dependency, add it to the PATH and setting
    # the mozilla-specific MOZ_PYTHON_HOME to relocate binaries.
    if "MOZ_PYTHON_HOME" in os.environ:
        print_line(b"setup", b"Setting up local python environment\n")

        moz_python_home = os.environ["MOZ_PYTHON_HOME"]
        if IS_WINDOWS:
            ext = ".exe"
            moz_python_bindir = moz_python_home
        else:
            ext = ""
            moz_python_bindir = moz_python_home + "/bin"

        new = _prepend_path(moz_python_bindir)

        # Relocate the python binary. Standard way uses PYTHONHOME, but
        # this conflicts with system python (e.g. used by hg) so we
        # maintain a small patch to use MOZPYTHONHOME instead.
        os.environ["MOZPYTHONHOME"] = moz_python_home

        pyinterp = os.path.join(moz_python_bindir, f"python3{ext}")
        # just a sanity check
        if not os.path.exists(pyinterp):
            raise RuntimeError(
                "Inconsistent Python installation: "
                "archive found, but no python3 binary "
                "detected"
            )

        if IS_MACOSX:
            # On OSX, we may not have access to the system certificate,
            # so use the certifi ones.
            certifi_cert_file = subprocess.check_output(
                [pyinterp, "-c", "import certifi; print(certifi.where())"],
                text=True,
            )
            os.environ["SSL_CERT_FILE"] = certifi_cert_file.strip()
            print_line(b"setup", b"patching ssl certificate\n")

        print_line(
            b"setup", b"updated PATH with python artifact: " + new.encode() + b"\n"
        )

    if "MOZ_UV_HOME" in os.environ:
        print_line(b"setup", b"Adding uv to PATH\n")
        new = _prepend_path(os.environ["MOZ_UV_HOME"])
        print_line(b"setup", b"updated PATH with uv artifact: " + new.encode() + b"\n")
