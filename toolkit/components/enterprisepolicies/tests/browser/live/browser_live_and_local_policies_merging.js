/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// A console-managed browser only reads local policies when the console opts in
// with DisableLocalPolicies: false (see browser_live_disable_local_policies.js),
// so every remote policy set below carries that opt-in.

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
let policy_value1 = POLICY_PARAM_STATE.DEFAULT;

const simple_policy0 = {
  onBeforeUIStartup: (_manager, param) => {
    policy_value0 = param;
  },
  onRemove: (_manager, _oldParam) => {
    policy_value0 = POLICY_PARAM_STATE.REMOVED;
  },
};

const simple_policy1 = {
  onBeforeUIStartup: (_manager, param) => {
    policy_value1 = param;
  },
  onRemove: (_manager, _oldParam) => {
    policy_value1 = POLICY_PARAM_STATE.REMOVED;
  },
};

add_setup(() => {
  Policies.simple_policy0 = simple_policy0;
  Policies.simple_policy1 = simple_policy1;

  registerCleanupFunction(() => {
    delete Policies.simple_policy0;
    delete Policies.simple_policy1;
  });
});

add_task(async function test_remote_policy_overrides_local_policy() {
  policy_value0 = POLICY_PARAM_STATE.DEFAULT;

  const localPolicies = {
    policies: {
      simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    },
  };
  let remotePolicies = {
    policies: { DisableLocalPolicies: false },
  };

  await EnterprisePolicyTesting.setupPolicyEngineWithCombinedPolicyProvider(
    localPolicies,
    remotePolicies,
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {
      DisableLocalPolicies: false,
      simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    },
    "Expected local policy simple_policy0 to be set."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    "Expected local policy simple_policy0 to be set."
  );

  remotePolicies = {
    policies: {
      DisableLocalPolicies: false,
      simple_policy0: POLICY_PARAM_STATE.UPDATED_BY_REMOTE_POLICY,
    },
  };

  await waitForLivePolicyUpdate(remotePolicies.policies);

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {
      DisableLocalPolicies: false,
      simple_policy0: POLICY_PARAM_STATE.UPDATED_BY_REMOTE_POLICY,
    },
    "Expected remote policy update to override local policies."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.UPDATED_BY_REMOTE_POLICY,
    "Expected remote policy update to override local policies."
  );

  // Remove remote policies, re-apply local policy
  await waitForLivePolicyUpdate({ DisableLocalPolicies: false });

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {
      DisableLocalPolicies: false,
      simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    },
    "Expected local policy to be re-applied if the remote policy is removed."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    "Expected local policy to be re-applied if the remote policy is removed."
  );
});

add_task(async function test_remote_and_local_policy_merged() {
  policy_value1 = POLICY_PARAM_STATE.DEFAULT;

  const localPolicies = {
    policies: {
      simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    },
  };
  let remotePolicies = {
    policies: {
      DisableLocalPolicies: false,
      simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
    },
  };

  await EnterprisePolicyTesting.setupPolicyEngineWithCombinedPolicyProvider(
    localPolicies,
    remotePolicies,
    customSchema
  );

  Assert.deepEqual(
    Services.policies.getActivePolicies(),
    {
      DisableLocalPolicies: false,
      simple_policy0: POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
      simple_policy1: POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
    },
    "Expected local and remote policy to be merged."
  );
  Assert.equal(
    policy_value0,
    POLICY_PARAM_STATE.APPLIED_LOCAL_POLICY,
    "Expected local policy to be applied."
  );
  Assert.equal(
    policy_value1,
    POLICY_PARAM_STATE.APPLIED_REMOTE_POLICY,
    "Expected remote policy to be applied."
  );
});
