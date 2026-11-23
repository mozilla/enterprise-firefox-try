# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
from typing import Literal

from taskgraph.transforms.base import TransformSequence
from taskgraph.util.schema import Schema

# enterprise-end2end is pinned to Linux docker workers in its kind, so the
# in-image paths are known here.
WORKDIR = "/builds/worker"

DRIVER = "taskcluster/scripts/misc/enterprise-end2end.sh"

transforms = TransformSequence()

task_transforms = TransformSequence()


class EnterpriseEnd2EndSchema(Schema, kw_only=True):
    """Every field is required: the driver script defines no defaults of its
    own, so the kind is the single place these values are written down."""

    # Which console repository ref to dispatch on: its main branch, the tag of
    # its latest release, or the oldest release Firefox still supports. The
    # driver resolves the name to an actual ref at run time.
    ref: Literal["main", "current", "minimal"]
    # owner/name of the enterprise-console repository holding the workflow.
    owner: str
    repo: str
    # Filename of the active workflow to dispatch.
    workflow: str
    # Scopes the workflow should exercise, passed through as a JSON array.
    affected_scopes: list[str]
    # Seconds between two polls of the dispatched run, and the point at which
    # we give up on it.
    poll_interval: int
    timeout: int


class EnterpriseEnd2EndDescriptionSchema(
    Schema, forbid_unknown_fields=False, kw_only=True
):
    enterprise_end2end: EnterpriseEnd2EndSchema


transforms.add_validate(EnterpriseEnd2EndDescriptionSchema)


@transforms.add
def filter_out_level_3(config, tasks):
    """Dispatching the console workflow never happens from a level 3 tree.

    `mach try fuzzy` builds its list from a local graph that carries the level 3
    defaults, so the tasks also have to survive whenever a try selection is
    being made: both that local generation and a try push set `try_mode`.
    """
    for task in tasks:
        if config.params["try_mode"] or int(config.params["level"]) < 3:
            yield task


@transforms.add
def setup_worker(config, tasks):
    """
    Not expressible in the kind: `worker` and `run-command` are not
    TestDescriptionSchema fields, and it forbids unknown ones.
    """
    for task in tasks:
        # The kind fetches stackwalk and ffmpeg per test platform; nothing here
        # runs the build, and on a Linux worker they would be the wrong
        # platform's binaries anyway.
        task["fetches"] = {}

        end2end = task.pop("enterprise-end2end")
        task["run-command"] = [
            "bash",
            DRIVER,
            "--ref={}".format(end2end["ref"]),
            "--owner={}".format(end2end["owner"]),
            "--repo={}".format(end2end["repo"]),
            "--workflow={}".format(end2end["workflow"]),
            "--affected-scopes={}".format(json.dumps(end2end["affected-scopes"])),
            "--poll-interval={}".format(end2end["poll-interval"]),
            "--timeout={}".format(end2end["timeout"]),
            f"--upload-dir={WORKDIR}/artifacts",
        ]

        worker = task.setdefault("worker", {})
        worker["docker-image"] = task["docker-image"]
        worker["max-run-time"] = task["max-run-time"]
        worker.setdefault("artifacts", []).append({
            "name": "public/test_info",
            "path": f"{WORKDIR}/artifacts",
            "type": "directory",
        })
        worker.setdefault("env", {})["MOZ_UPLOAD_DIR"] = f"{WORKDIR}/artifacts"
        yield task


@task_transforms.add
def add_upstream_tasks(config, tasks):
    for task in tasks:
        task["worker"].setdefault("env", {})["UPSTREAM_TASKIDS"] = {
            "task-reference": " ".join([
                f"<{dep}>" for dep in task["dependencies"] if ("build" in dep)
            ])
        }
        yield task
