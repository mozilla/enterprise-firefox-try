/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
const { EnterprisePolicyTesting } = ChromeUtils.importESModule(
  "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
);
const { setupPolicyEngineWithJson } = EnterprisePolicyTesting;
EnterprisePolicyTesting.pathResolver = path => do_get_file(path).path;

updateAppInfo({
  name: "XPCShell",
  ID: "xpcshell@tests.mozilla.org",
  version: "48",
  platformVersion: "48",
});

// This initializes the policy engine for xpcshell tests
let policies = Cc["@mozilla.org/enterprisepolicies;1"].getService(
  Ci.nsIObserver
);
policies.observe(null, "policies-startup", null);

/**
 * Restart the policy engine synchronously through its policies-startup
 * observer: as a console-managed browser when a console policy set is given,
 * served by a stubbed console client (this takes an enterprise build), and as
 * a browser without a console otherwise.
 *
 * @param {object} [consolePolicies] the policy set the console serves
 */
function restartPolicyEngine(consolePolicies = null) {
  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
  if (consolePolicies) {
    EnterprisePolicyTesting.stubRemotePolicies({ policies: consolePolicies });
    Services.prefs.setBoolPref("enterprise.policies.live.enabled", true);
  } else {
    Services.prefs.clearUserPref("enterprise.policies.live.enabled");
  }
  policies.observe(null, "policies-startup", null);
}

registerCleanupFunction(() => {
  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
  Services.prefs.clearUserPref("enterprise.policies.live.enabled");
  if (EnterprisePolicyTesting.remotePoliciesStub) {
    EnterprisePolicyTesting.remotePoliciesStub.restore();
    EnterprisePolicyTesting.remotePoliciesStub = null;
  }
});
