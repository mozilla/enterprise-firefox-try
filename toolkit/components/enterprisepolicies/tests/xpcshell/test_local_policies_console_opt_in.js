/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2073015. A console-managed browser must not read the
// local policy sources unless the console explicitly sets DisableLocalPolicies
// to false: some local sources (e.g. the macOS user preference domain) can be
// written without administrator rights, so honoring them by default lets a
// user merge any policy the console does not set into the console-managed
// policy set. Only policies.json is exercised here; Windows GPO and macOS
// plist sit behind the same gate.

const { FileTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/FileTestUtils.sys.mjs"
);

const LOCAL_POLICIES = { BlockAboutConfig: true };
const CONSOLE_POLICIES = { SecurityLogging: { Download: { Enabled: true } } };

const policiesSvc = Services.policies;
const policiesObs = policiesSvc.QueryInterface(Ci.nsIObserver);

// Restart the engine with the given local policies.json and remote policy set,
// and return the policies that ended up active.
async function startEngine(localPolicies, remotePolicies) {
  const filePath = FileTestUtils.getTempFile("policies.json").path;
  await IOUtils.writeJSON(filePath, { policies: localPolicies });
  Services.prefs.setStringPref("browser.policies.alternatePath", filePath);
  EnterprisePolicyTesting.stubRemotePolicies({ policies: remotePolicies });

  Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
  policiesObs.observe(null, "policies-startup", null);
  return policiesSvc.getActivePolicies();
}

add_setup(() => {
  // The head initialized the engine without remote policies; the tasks below
  // restart it as a console-managed browser.
  Services.prefs.setBoolPref("enterprise.policies.live.enabled", true);

  registerCleanupFunction(() => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    EnterprisePolicyTesting.remotePoliciesStub?.restore();
    EnterprisePolicyTesting.remotePoliciesStub = null;
    Services.prefs.clearUserPref("enterprise.policies.live.enabled");
    Services.prefs.clearUserPref("browser.policies.alternatePath");
  });
});

add_task(async function test_local_policies_ignored_by_default() {
  const active = await startEngine(LOCAL_POLICIES, CONSOLE_POLICIES);

  Assert.equal(
    policiesSvc.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "The console policies keep the engine ACTIVE"
  );
  Assert.ok("SecurityLogging" in active, "The console policy is applied");
  Assert.ok(
    !("BlockAboutConfig" in active),
    "The local policy is ignored when the console does not opt in"
  );
});

add_task(async function test_local_policies_ignored_when_console_disables() {
  const active = await startEngine(LOCAL_POLICIES, {
    DisableLocalPolicies: true,
    ...CONSOLE_POLICIES,
  });

  Assert.equal(
    active.DisableLocalPolicies,
    true,
    "The explicit DisableLocalPolicies policy is applied"
  );
  Assert.ok(
    !("BlockAboutConfig" in active),
    "The local policy is ignored when the console disables local policies"
  );
});

add_task(async function test_local_policies_apply_when_console_opts_in() {
  const active = await startEngine(LOCAL_POLICIES, {
    DisableLocalPolicies: false,
    ...CONSOLE_POLICIES,
  });

  Assert.equal(
    active.DisableLocalPolicies,
    false,
    "The explicit DisableLocalPolicies: false policy is applied"
  );
  Assert.ok("SecurityLogging" in active, "The console policy is applied");
  Assert.ok(
    "BlockAboutConfig" in active,
    "The local policy is merged in when the console opts in"
  );
});

add_task(async function test_local_opt_in_is_ignored() {
  const active = await startEngine(
    { DisableLocalPolicies: false, ...LOCAL_POLICIES },
    CONSOLE_POLICIES
  );

  Assert.ok(
    !("DisableLocalPolicies" in active),
    "A local source cannot opt itself in"
  );
  Assert.ok(
    !("BlockAboutConfig" in active),
    "The local policy stays ignored despite the local opt-in"
  );
});

add_task(async function test_local_policies_apply_without_console() {
  // A browser that is not console-managed reads the local policy sources as
  // Firefox does.
  Services.prefs.setBoolPref("enterprise.policies.live.enabled", false);
  try {
    const active = await startEngine(LOCAL_POLICIES, CONSOLE_POLICIES);

    Assert.ok(
      "BlockAboutConfig" in active,
      "The local policy applies without a console"
    );
    Assert.ok(
      !("SecurityLogging" in active),
      "No console policies are fetched without a console"
    );
  } finally {
    Services.prefs.setBoolPref("enterprise.policies.live.enabled", true);
  }
});
