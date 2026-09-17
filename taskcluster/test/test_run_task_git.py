# Any copyright is dedicated to the public domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import ast
import importlib.util
import os

import pytest
from gecko_taskgraph import GECKO, run_task_git
from mozunit import main
from taskgraph.util import docker

SCRIPTS_DIR = os.path.join(GECKO, "taskcluster", "scripts")
SETUP_CALL = "run_task_python.setup(print_line)"


@pytest.fixture(scope="module")
def run_task_python():
    spec = importlib.util.spec_from_file_location(
        "run_task_python", run_task_git.PYTHON_SETUP_MODULE
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def print_line():
    def inner(prefix, message):
        pass

    return inner


def test_patch_applies():
    """The patch must keep applying as taskcluster-taskgraph is upgraded."""
    with open(run_task_git.patched_run_task()) as fh:
        patched = fh.read()

    assert "import run_task_python" in patched
    assert SETUP_CALL in patched
    ast.parse(patched)


def test_cache_names_track_the_patched_run_task():
    """Cache names must be derived from the `run-task` we actually ship."""
    # `gecko_taskgraph.transforms.job` has to be imported first, as the task
    # transforms import it back.
    import gecko_taskgraph.transforms.job  # noqa: F401
    from gecko_taskgraph.transforms.task import RUN_TASK_GIT
    from gecko_taskgraph.util.hash import hash_path

    assert str(RUN_TASK_GIT) == run_task_git.patched_run_task()
    assert hash_path(str(RUN_TASK_GIT)) != hash_path(
        os.path.join(docker.RUN_TASK_ROOT, "run-task")
    )


def test_run_task_hg_calls_setup():
    """The hg flavour must keep going through the shared module."""
    with open(os.path.join(SCRIPTS_DIR, "run-task")) as fh:
        assert SETUP_CALL in fh.read()


def test_setup_without_fetches(run_task_python, print_line, monkeypatch):
    monkeypatch.delenv("MOZ_PYTHON_HOME", raising=False)
    monkeypatch.delenv("MOZ_UV_HOME", raising=False)
    monkeypatch.setenv("PATH", "/usr/bin")

    run_task_python.setup(print_line)

    assert os.environ["PATH"] == "/usr/bin"


def test_setup_adds_fetches_to_path(run_task_python, print_line, monkeypatch, tmp_path):
    python_home = tmp_path / "python"
    (python_home / "bin").mkdir(parents=True)
    (python_home / "bin" / "python3").touch()
    uv_home = tmp_path / "uv"
    uv_home.mkdir()

    monkeypatch.setenv("MOZ_PYTHON_HOME", str(python_home))
    monkeypatch.setenv("MOZ_UV_HOME", str(uv_home))
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.delenv("MOZPYTHONHOME", raising=False)

    run_task_python.setup(print_line)

    assert os.environ["PATH"] == os.pathsep.join([
        str(uv_home),
        str(python_home / "bin"),
        "/usr/bin",
    ])
    assert os.environ["MOZPYTHONHOME"] == str(python_home)


def test_setup_requires_a_python_binary(
    run_task_python, print_line, monkeypatch, tmp_path
):
    monkeypatch.setenv("MOZ_PYTHON_HOME", str(tmp_path / "python"))
    monkeypatch.delenv("MOZ_UV_HOME", raising=False)

    with pytest.raises(RuntimeError):
        run_task_python.setup(print_line)


if __name__ == "__main__":
    main()
