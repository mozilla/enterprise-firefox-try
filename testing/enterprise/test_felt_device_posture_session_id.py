#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys
import uuid

sys.path.append(os.path.dirname(__file__))

import requests
from felt_tests import FeltTests
from marionette_driver.errors import (
    NoSuchWindowException,
    UnknownException,
)


class FeltDevicePostureSessionId(FeltTests):
    """Every posture carries a clientSessionId that is constant while one
    browser runs and replaced when Felt starts another one, so the console can
    tell a relaunch from a browser that has been up all along.
    """

    # Posture is collected in the Felt process, and its session id must not
    # depend on telemetry, which an admin can turn off.
    EXTRA_PREFS = {
        "toolkit.telemetry.enabled": False,
        "datareporting.healthreport.uploadEnabled": False,
    }

    def test_client_session_id_changes_across_restart(self):
        super().run_felt_base()
        self.connect_child_browser()

        before = self.session_ids()
        assert len(before) == 1, (
            f"One browser run reports one session id, got {sorted(before)}"
        )
        for session_id in before:
            uuid.UUID(session_id)

        self.restart_browser()

        # The relaunched browser's posture differs from the recorded one by its
        # session id alone, which is enough for the monitor to submit it.
        ids = self._wait_for_new_session_id(before)
        new_ids = ids - before
        assert len(new_ids) == 1, (
            f"The relaunched browser reports one new session id, got {sorted(new_ids)}"
        )
        for session_id in new_ids:
            uuid.UUID(session_id)

    def session_ids(self):
        console_addr = f"http://localhost:{self.console_port}"
        r = requests.get(f"{console_addr}/sso/get_device_posture_history")
        return {p["clientSessionId"] for p in r.json()}

    def _wait_for_new_session_id(self, before):
        ids = self._longwait.until(
            lambda _: (self.session_ids() - before) or None,
            message="No posture from the relaunched browser",
        )
        return before | ids

    def restart_browser(self):
        browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._child_driver.set_context("chrome")
        try:
            self._child_driver.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit);"
            )
        except (UnknownException, NoSuchWindowException, OSError):
            # The browser goes away while the command is in flight.
            pass
        self.wait_process_exit(browser_pid)
        self.connect_child_browser()
        assert (
            self._child_driver.session_capabilities["moz:processID"] != browser_pid
        ), "Felt started a new browser process"
