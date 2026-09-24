/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A console-managed browser reads the local policy sources (policies.json,
// Windows GPO and macOS plist) only when the console explicitly sets
// DisableLocalPolicies to false (Bug 2073015): some local sources can be
// written without administrator rights, so honoring them by default would let
// a user merge policies the console does not set into the console-managed set.

const customSchema = {
  properties: {
    DisableLocalPolicies: {
      type: "boolean",
      "x-restart-required": true,
    },

    simple_policy0: {
      type: "string",
      "x-restart-required": false,
    },

    simple_policy1: {
      type: "string",
      "x-restart-required": false,
    },
  },
};

let policy_value0 = POLICY_PARAM_STATE.DEFAULT;

const simple_policy0 = {
  onBeforeUIStartup: (_manager, param) => {
    policy_value0 = param;
  },
  onRemove: (_manager, _oldParam) => {
    policy_value0 = POLICY_PARAM_STATE.REMOVED;
  },
};

const simple_policy1 = {
  onBeforeUIStartup: () => {},
  onRemove: () => {},
};

const LOCAL_POLICIES = {
  policies: {
    simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
  },
};

add_setup(() => {
  // DisableLocalPolicies is implemented by the real Policies module.
  Policies.simple_policy0 = simple_policy0;
  Policies.simple_policy1 = simple_policy1;

  registerCleanupFunction(() => {
    delete Policies.simple_policy0;
    delete Policies.simple_policy1;
  });
});

// Restart the engine with a local policies.json and the given remote policy set.
async function startEngine(remotePolicies, localPolicies = LOCAL_POLICIES) {
  policy_value0 = POLICY_PARAM_STATE.DEFAULT;
  await EnterprisePolicyTesting.setupPolicyEngineWithCombinedPolicyProvider(
    localPolicies,
    { policies: remotePolicies },
    customSchema
  );
}

add_task(async function test_remote_disables_local_policies_on_startup() {
  await startEngine({
    DisableLocalPolicies: true,
    simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
  });

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {
      DisableLocalPolicies: true,
      simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
    },
    "Expected the local policy to be suppressed while remote policies apply."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected the local policy callback to never run."
  );
});

add_task(async function test_local_policies_ignored_without_directive() {
  await startEngine({
    simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
  });

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY },
    "Expected the local policy to be ignored when the console does not opt in."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected the local policy callback to never run."
  );
});

add_task(async function test_local_policies_apply_when_remote_opts_in() {
  await startEngine({
    DisableLocalPolicies: false,
    simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
  });

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {
      DisableLocalPolicies: false,
      simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
      simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
    },
    "Expected the local policy to be merged in when the console opts in."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    "Expected the local policy callback to run."
  );
});

add_task(async function test_local_opt_in_is_ignored() {
  await startEngine(
    { simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY },
    {
      policies: {
        DisableLocalPolicies: false,
        simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
      },
    }
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    { simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY },
    "Expected a local source to be unable to opt itself in."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.DEFAULT,
    "Expected the local policy callback to never run."
  );
});
