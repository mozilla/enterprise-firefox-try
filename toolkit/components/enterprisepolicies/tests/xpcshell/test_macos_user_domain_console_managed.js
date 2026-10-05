/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Bug 2073015: the user's own macOS preferences domain (~/Library/Preferences,
// where `defaults write` lands without sudo) is the user's to write, so a
// console-managed browser must not take policies from it, even when the
// console allows local policies. It then honors only the managed preferences,
// installed with a configuration profile, and the root-owned system-wide
// domain under /Library/Preferences. Without a console the user domain is
// read as it always was.
//
// A test can write neither a configuration profile nor /Library/Preferences,
// so this covers the user domain being ignored while the two sources an
// administrator controls are verified by hand.

const { macOSPoliciesProvider } = ChromeUtils.importESModule(
  "resource://gre/modules/EnterprisePoliciesParent.sys.mjs"
);
const { PropertyListUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PropertyListUtils.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);

const POLICIES_ENABLED_KEY = "EnterprisePoliciesEnabled";
// The native reader hands booleans over as integers.
const USER_DOMAIN_POLICIES = { BlockAboutConfig: 1 };
// The console allows local policies; the user domain must still be left out.
const CONSOLE_POLICIES = {
  DisableLocalPolicies: false,
  BlockAboutSupport: true,
};

let gDomain;

/**
 * The preferences domain the native reader resolves for this process: the
 * identifier of the application bundle xpcshell runs from, or the process name
 * when it runs from a plain directory.
 *
 * @returns {Promise<string>} the domain
 */
async function preferencesDomain() {
  let exe = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  if (exe.parent.leafName == "MacOS") {
    let infoPlist = exe.parent.parent.clone();
    infoPlist.append("Info.plist");
    if (infoPlist.exists()) {
      let root = await new Promise(resolve =>
        PropertyListUtils.read(infoPlist, resolve)
      );
      let bundleId = root?.get("CFBundleIdentifier");
      if (bundleId) {
        return bundleId;
      }
    }
  }
  return exe.leafName;
}

async function runDefaults(...args) {
  let proc = await Subprocess.call({
    command: "/usr/bin/defaults",
    arguments: args,
    stderr: "stdout",
  });
  let output = await proc.stdout.readString();
  let { exitCode } = await proc.wait();
  return { exitCode, output: output.trim() };
}

add_setup(async () => {
  gDomain = await preferencesDomain();
  info(`Writing the user preferences domain ${gDomain}`);

  let keys = [POLICIES_ENABLED_KEY, ...Object.keys(USER_DOMAIN_POLICIES)];
  for (let key of keys) {
    let { exitCode, output } = await runDefaults("read", gDomain, key);
    Assert.notEqual(
      exitCode,
      0,
      `${key} is not set in ${gDomain} already (found: ${output})`
    );
  }

  registerCleanupFunction(async () => {
    for (let key of keys) {
      await runDefaults("delete", gDomain, key);
    }
  });

  await runDefaults("write", gDomain, POLICIES_ENABLED_KEY, "-bool", "TRUE");
  for (let [key, value] of Object.entries(USER_DOMAIN_POLICIES)) {
    await runDefaults("write", gDomain, key, "-bool", value ? "TRUE" : "FALSE");
  }
});

add_task(function test_provider_reads_user_domain_by_default() {
  Assert.deepEqual(
    new macOSPoliciesProvider().policies,
    USER_DOMAIN_POLICIES,
    "The macOS provider reads the user domain unless limited to admin sources"
  );
});

add_task(function test_admin_only_provider_skips_user_domain() {
  let { policies } = new macOSPoliciesProvider({ adminOnly: true });
  for (let key of Object.keys(USER_DOMAIN_POLICIES)) {
    Assert.ok(
      !(key in policies),
      `The macOS provider limited to admin sources leaves ${key} alone`
    );
  }
});

add_task(function test_console_managed_engine_ignores_user_domain() {
  restartPolicyEngine(CONSOLE_POLICIES);

  Assert.equal(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "The engine is active with the console policies"
  );
  let active = Services.policies.getActivePolicies();
  Assert.ok("BlockAboutSupport" in active, "The console policy is applied");
  Assert.ok(
    !("BlockAboutConfig" in active),
    "The user domain policy is not merged into the console-managed policies"
  );
});

add_task(function test_engine_without_console_reads_user_domain() {
  restartPolicyEngine();

  Assert.equal(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "The engine is active with the user domain policies"
  );
  Assert.ok(
    "BlockAboutConfig" in Services.policies.getActivePolicies(),
    "Without a console the user domain policy is applied as before"
  );
});
