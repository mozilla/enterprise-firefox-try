/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PoliciesUtils: "resource://gre/modules/PoliciesHelpers.sys.mjs",
});

const SECURITY_LOGGING_PREFS = {
  AddonInstall: {
    Enabled: "extensions.enterprise.telemetry.addonInstall.enabled",
  },
  BlocklistDomainBrowsed: {
    Enabled:
      "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.enabled",
    UrlLogging:
      "browser.policies.enterprise.telemetry.blocklistDomainBrowsed.urlLogging",
  },
  Download: {
    Enabled: "browser.download.enterprise.telemetry.enabled",
    UrlLogging: "browser.download.enterprise.telemetry.urlLogging",
    FileLogging: "browser.download.enterprise.telemetry.fileLogging",
  },
  EnterpriseMCP: {
    Enabled: "browser.enterprise.mcp.securityLogging.enabled",
    UrlLogging: "browser.enterprise.mcp.securityLogging.urlLogging",
  },
  PrintPage: {
    Enabled: "print.enterprise.telemetry.printPage.enabled",
    UrlLogging: "print.enterprise.telemetry.printPage.urlLogging",
  },
  UnsafeDownload: {
    Enabled: "browser.safebrowsing.enterprise.telemetry.unsafeDownload.enabled",
    UrlLogging:
      "browser.safebrowsing.enterprise.telemetry.unsafeDownload.urlLogging",
  },
  UnsafeSiteVisit: {
    Enabled:
      "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.enabled",
    UrlLogging:
      "browser.safebrowsing.enterprise.telemetry.unsafeSiteVisit.urlLogging",
  },
};

function forEachSetting(param, callback) {
  for (const [event, settings] of Object.entries(SECURITY_LOGGING_PREFS)) {
    const eventParam = param?.[event];
    if (!eventParam) {
      continue;
    }
    for (const [setting, pref] of Object.entries(settings)) {
      if (Object.hasOwn(eventParam, setting)) {
        callback(pref, eventParam[setting]);
      }
    }
  }
}

export const SecurityLoggingPolicy = {
  apply(param) {
    forEachSetting(param, (pref, value) =>
      lazy.PoliciesUtils.setAndLockPref(pref, value)
    );
  },

  remove(oldParam) {
    forEachSetting(oldParam, pref =>
      lazy.PoliciesUtils.unsetAndUnlockPref(pref)
    );
  },
};
