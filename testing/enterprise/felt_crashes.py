#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os
import sys

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class AppCrashes(FeltTests):
    EXTRA_ENV = {"MOZ_GDB_SLEEP": "1"}
    # Reduce the timeout for faster processing of the tests
    socket_timeout = 10

    def crash_parent(self):
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._logger.info(f"Crashing browser at {self._browser_pid}")
        saved_timeout = self._child_driver.client.socket_timeout
        self._child_driver.client.socket_timeout = self.socket_timeout
        try:
            # This is going to trigger exception for sure
            self._logger.info("Crashing main process")
            self._child_driver.set_context("content")
            self.open_tab_child("about:crashparent")
        except Exception as ex:
            self._logger.info(f"Caught exception {ex}")
        finally:
            self._child_driver.client.socket_timeout = saved_timeout

    def connect_and_crash(self):
        self.connect_child_browser()
        self.crash_parent()

    def run_felt_crash_parent_once(self):
        self._manually_closed_child = True
        self.connect_and_crash()

    def run_felt_proper_restart(self):
        self._manually_closed_child = False
        self.wait_process_exit(self._browser_pid)
        self._logger.info("Connecting to new browser")
        self.connect_child_browser()
        self._browser_pid = self._child_driver.session_capabilities["moz:processID"]
        self._logger.info(f"Connected to {self._browser_pid}")
        self.open_tab_child("about:buildconfig")

        # Firefox and Thunderbird ship their own about:buildconfig, only the
        # heading is common to both.
        build_config_title = self.get_elem_child_text("h1")
        self._logger.info(f"about:buildconfig heading: {build_config_title}")
        assert len(build_config_title) > 0, "Restarted app renders about:buildconfig"

    def run_felt_crash_parent_twice(self):
        self._manually_closed_child = True
        self.crash_parent()
