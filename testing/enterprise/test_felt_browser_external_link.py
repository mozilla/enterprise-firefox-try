#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import json
import os
import subprocess
import sys
import time

sys.path.append(os.path.dirname(__file__))

from felt_tests import FeltTests


class FeltStartsBrowserExternalLink(FeltTests):
    def test_browser_external_link(self):
        self.run_felt_base()
        self._external_link = f"http://localhost:{self.console_port}/ping"
        self.run_felt_browser_started()
        self.run_felt_open_external_link()

    def run_felt_browser_started(self):
        self.connect_child_browser()

    def third_party_open_external_link(self):
        args = [
            f"{self._driver.instance.binary}",
            "-profile",
            self._driver.profile,
            self._external_link,
        ]
        subprocess.check_call(args, shell=False)

    def check_no_external_link_tab(self):
        tabs = self._child_driver.window_handles
        self._logger.info(f"Tabs before opening external link: {tabs}")

        has_tab = False
        for tab in tabs:
            self._child_driver.switch_to_window(tab)
            self._logger.info(f"Checking: {tab} => {self._child_driver.get_url()}")
            if self._child_driver.get_url().startswith(self._external_link):
                has_tab = True
                break

        assert not has_tab, f"Should not have {self._external_link} opened"
        return tabs

    def check_has_external_link_tab(self, tabs=None):
        if tabs:
            self._child_wait.until(lambda mn: len(mn.window_handles) > len(tabs))

        has_new_tab = False
        loops = 0
        while not has_new_tab and loops < 30:
            for tab in self._child_driver.window_handles:
                self._child_driver.switch_to_window(tab)
                self._logger.info(
                    f"Checking new tabs: {tab} => {self._child_driver.get_url()}"
                )
                if self._child_driver.get_url().startswith(self._external_link):
                    has_new_tab = True
                    break
            loops += 1
            time.sleep(0.5)

        assert has_new_tab, f"Should have {self._external_link} opened"

    def run_felt_open_external_link(self):
        tabs = self.check_no_external_link_tab()
        self.third_party_open_external_link()
        self.check_has_external_link_tab(tabs)

    def test_browser_pending_external_link(self):
        self._external_link = "about:welcome"
        urls_file = os.path.join(self._driver.profile, "pendingURLs.json")

        assert not os.path.exists(urls_file), (
            f"Pending URLs file should not exists: {urls_file}"
        )
        self.third_party_open_external_link()

        self._logger.info(f"Waiting for pending URLs file to be populated: {urls_file}")
        self._wait.until(lambda mn: os.path.exists(urls_file))

        with open(urls_file) as pending:
            parsed = json.loads(pending.read())
            assert len(parsed["pendingURLs"]) == 1, (
                "There should be only one pending URL"
            )
            parsed_url = parsed["pendingURLs"][0]["url"]
            assert parsed_url == self._external_link, (
                f"Pending URL should be '{self._external_link}', found '{parsed_url}'"
            )

        self._driver.set_pref("enterprise.felt_tests.is_blocking_shutdown", True)
        self.run_felt_base()
        self.run_felt_browser_started()
        self.check_has_external_link_tab()

        self._logger.info(f"Waiting for pending URLs file to be cleared: {urls_file}")

        def has_no_pending_url(file):
            with open(urls_file) as pending:
                parsed = json.loads(pending.read())
                return len(parsed["pendingURLs"]) == 0

        self._wait.until(lambda mn: has_no_pending_url(urls_file))
        self._logger.info(f"Pending URLs cleared from {urls_file}!")

        self._manually_closed_child = False
        self._child_driver.set_context("chrome")
        self._child_driver.execute_script(
            """
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit)
            """
        )

        self._logger.info("Closing Felt")
        self._driver.quit(in_app=True, clean=False)

        # Write new content to the file, close the browser, wait for FELT and re-do everything
        with open(urls_file, "w") as pending:
            pending.write(
                json.dumps({
                    "pendingURLs": [
                        {
                            "url": "about:buildconfig",
                            "disposition": 0,
                        },
                        {
                            "url": "about:logo",
                            "disposition": 0,
                        },
                    ]
                })
            )
        self._logger.info(f"New pending URLs file: {urls_file}")

        self._driver.start_session(timeout=60)
        new_urls_file = os.path.join(self._driver.profile, "pendingURLs.json")
        assert os.path.exists(new_urls_file), (
            f"Pending URLs file should exists: {new_urls_file}"
        )

        self._driver.set_context("chrome")
        self._driver.execute_script(
            """
            console.debug(`Felt: Test: started new FELT`);
            """
        )

        self.run_felt_base()
        self.run_felt_browser_started()

        self._external_link = "about:buildconfig"
        self.check_has_external_link_tab()
        self._external_link = "about:logo"
        self.check_has_external_link_tab()
