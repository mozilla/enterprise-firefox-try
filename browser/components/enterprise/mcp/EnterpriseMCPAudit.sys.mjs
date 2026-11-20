/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ENABLED = "browser.enterprise.mcp.securityLogging.enabled";
const URL_LOGGING = "browser.enterprise.mcp.securityLogging.urlLogging";

function record(metric, client, extras, origin) {
  try {
    if (
      !Services.prefs.prefIsLocked(ENABLED) ||
      !Services.prefs.getBoolPref(ENABLED, false)
    ) {
      return;
    }
    if (origin && Services.prefs.prefIsLocked(URL_LOGGING)) {
      const level = Services.prefs.getCharPref(URL_LOGGING, "none");
      if (level === "domain" || level === "full") {
        const url = new URL(origin);
        if (url.protocol === "https:" || url.protocol === "http:") {
          extras.origin = level === "domain" ? url.hostname : url.origin;
        }
      }
    }
    if (client?.auditId) {
      extras.session = client.auditId;
    }
    if (client?.clientIdentity) {
      extras.client_identity = client.clientIdentity;
    }
    Glean.enterpriseMcp[metric].record(extras);
    if (
      !Services.prefs.getBoolPref(
        "browser.policies.enterprise.telemetry.testing.disableSubmit",
        false
      )
    ) {
      GleanPings.enterprise.submit();
    }
  } catch {
    console.warn("Firefox Enterprise could not record an MCP security event.");
  }
}

export function recordOperation(client, operation, category, decision, origin) {
  record("operation", client, { operation, category, decision }, origin);
}

export function recordSession(client, accessMode, action) {
  record("sessionEvent", client, { access_mode: accessMode, action });
}
