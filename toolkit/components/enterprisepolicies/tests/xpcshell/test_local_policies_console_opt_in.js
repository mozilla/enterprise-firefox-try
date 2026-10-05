/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Regression test for Bug 2073015. A console-managed browser must not read the
// local policy sources unless the console explicitly sets DisableLocalPolicies
// to false: some local sources (e.g. the macOS user preference domain) can be
// written without administrator rights, so honoring them by default lets a
// user merge any policy the console does not set into the console-managed
// policy set. Only policies.json is exercised here; the platform providers sit
// behind the same gate.

const { FileTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/FileTestUtils.sys.mjs"
);

const LOCAL_POLICIES = { BlockAboutConfig: true };
const CONSOLE_POLICIES = { SecurityLogging: { Download: { Enabled: true } } };

// Point the JSON provider at a policies.json holding the given policies.
async function writeLocalPolicies(localPolicies) {
  const filePath = FileTestUtils.getTempFile("policies.json").path;
  await IOUtils.writeJSON(filePath, { policies: localPolicies });
  Services.prefs.setStringPref("browser.policies.alternatePath", filePath);
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.policies.alternatePath");
});

add_task(async function test_local_policies_ignored_by_default() {
  await writeLocalPolicies(LOCAL_POLICIES);
  restartPolicyEngine(CONSOLE_POLICIES);

  Assert.equal(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "The console policies keep the engine ACTIVE"
  );
  const active = Services.policies.getActivePolicies();
  Assert.ok("SecurityLogging" in active, "The console policy is applied");
  Assert.ok(
    !("BlockAboutConfig" in active),
    "The local policy is ignored when the console does not opt in"
  );
});

add_task(async function test_local_policies_ignored_when_console_disables() {
  await writeLocalPolicies(LOCAL_POLICIES);
  restartPolicyEngine({ DisableLocalPolicies: true, ...CONSOLE_POLICIES });

  const active = Services.policies.getActivePolicies();
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
  await writeLocalPolicies(LOCAL_POLICIES);
  restartPolicyEngine({ DisableLocalPolicies: false, ...CONSOLE_POLICIES });

  const active = Services.policies.getActivePolicies();
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
  await writeLocalPolicies({ DisableLocalPolicies: false, ...LOCAL_POLICIES });
  restartPolicyEngine(CONSOLE_POLICIES);

  const active = Services.policies.getActivePolicies();
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
  await writeLocalPolicies(LOCAL_POLICIES);
  restartPolicyEngine();

  const active = Services.policies.getActivePolicies();
  Assert.ok(
    "BlockAboutConfig" in active,
    "The local policy applies without a console"
  );
  Assert.ok(
    !("SecurityLogging" in active),
    "No console policies are fetched without a console"
  );
});
