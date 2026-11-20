/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SECURITY_LOGGING_PREFS = {
  "extensions.enterprise.telemetry.addonInstall.enabled": true,
  "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.enabled": true,
  "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.urlLogging":
    "domain",
  "browser.download.enterprise.telemetry.enabled": true,
  "browser.download.enterprise.telemetry.urlLogging": "full",
  "browser.download.enterprise.telemetry.fileLogging": "metadata",
  "browser.enterprise.mcp.securityLogging.enabled": true,
  "browser.enterprise.mcp.securityLogging.urlLogging": "domain",
  "print.enterprise.telemetry.printPage.enabled": false,
  "print.enterprise.telemetry.printPage.urlLogging": "none",
  "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled": true,
  "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging":
    "domain",
  "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled": true,
  "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging":
    "full",
};

add_task(async function test_all_events_configured_through_policy_engine() {
  await setupPolicyEngineWithJson({
    policies: {
      SecurityLogging: {
        AddonInstall: { Enabled: true },
        BlocklistDomainBrowsed: { Enabled: true, UrlLogging: "domain" },
        Download: {
          Enabled: true,
          UrlLogging: "full",
          FileLogging: "metadata",
        },
        EnterpriseMCP: { Enabled: true, UrlLogging: "domain" },
        PrintPage: { Enabled: false, UrlLogging: "none" },
        UnsafeDownload: { Enabled: true, UrlLogging: "domain" },
        UnsafeSiteVisit: { Enabled: true, UrlLogging: "full" },
      },
    },
  });

  for (const [pref, value] of Object.entries(SECURITY_LOGGING_PREFS)) {
    checkLockedPref(pref, value);
  }
});
