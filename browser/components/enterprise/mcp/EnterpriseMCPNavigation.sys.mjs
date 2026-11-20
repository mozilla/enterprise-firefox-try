/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CONTRACT = "@mozilla.org/enterprise-mcp/navigation-policy;1";
const CLASS_ID = Components.ID("{f182bb58-7524-4bd7-8da1-e88cecb561fc}");
const CATEGORY = "net-channel-event-sinks";
const TOPICS = ["http-on-modify-request", "http-on-before-connect"];

const targets = new Map();
const NO_GUARDS = new Set();

function navigationPolicy(channel) {
  const info = channel.loadInfo;
  if (info?.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT) {
    return targets.get(info.browsingContext?.browserId) ?? NO_GUARDS;
  }
  return NO_GUARDS;
}

const gate = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIChannelEventSink",
    "nsIObserver",
  ]),
  createInstance(iid) {
    return this.QueryInterface(iid);
  },
  observe(subject) {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    for (const guard of navigationPolicy(channel)) {
      if (guard.matches(channel.loadInfo) && !guard.allows(channel)) {
        channel.cancel(Cr.NS_ERROR_BLOCKED_BY_POLICY);
        return;
      }
    }
  },
  asyncOnChannelRedirect(oldChannel, newChannel, _flags, callback) {
    const oldGuards = navigationPolicy(oldChannel);
    const newGuards = navigationPolicy(newChannel);
    if (!oldGuards.size && !newGuards.size) {
      callback.onRedirectVerifyCallback(Cr.NS_OK);
      return;
    }
    const guards = new Set([...oldGuards, ...newGuards]);
    for (const guard of guards) {
      if (
        (guard.matches(oldChannel.loadInfo) ||
          guard.matches(newChannel.loadInfo)) &&
        !guard.allows(newChannel)
      ) {
        oldChannel.cancel(Cr.NS_ERROR_BLOCKED_BY_POLICY);
        callback.onRedirectVerifyCallback(Cr.NS_ERROR_BLOCKED_BY_POLICY);
        return;
      }
    }
    callback.onRedirectVerifyCallback(Cr.NS_OK);
  },
};

export function guardTab(browserId, allows, matches = () => true) {
  if (!browserId) {
    throw new Error("Expected a browser ID");
  }
  if (!targets.size) {
    const registrar = Components.manager.QueryInterface(
      Ci.nsIComponentRegistrar
    );
    registrar.registerFactory(
      CLASS_ID,
      "Firefox Enterprise MCP navigation policy",
      CONTRACT,
      gate
    );
    try {
      Services.catMan.addCategoryEntry(
        CATEGORY,
        CONTRACT,
        CONTRACT,
        false,
        true
      );
      for (const topic of TOPICS) {
        Services.obs.addObserver(gate, topic);
      }
    } catch (error) {
      Services.catMan.deleteCategoryEntry(CATEGORY, CONTRACT, false);
      registrar.unregisterFactory(CLASS_ID, gate);
      throw error;
    }
  }
  const guards = targets.get(browserId) ?? new Set();
  const guard = { matches, allows };
  guards.add(guard);
  targets.set(browserId, guards);
  return () => {
    if (
      guards.delete(guard) &&
      !guards.size &&
      targets.delete(browserId) &&
      !targets.size
    ) {
      for (const topic of TOPICS) {
        Services.obs.removeObserver(gate, topic);
      }
      Services.catMan.deleteCategoryEntry(CATEGORY, CONTRACT, false);
      const registrar = Components.manager.QueryInterface(
        Ci.nsIComponentRegistrar
      );
      registrar.unregisterFactory(CLASS_ID, gate);
    }
  };
}
