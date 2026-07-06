/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

export const FeltCommon = {
  PRIVATE_BROWSING_ID: 1,
  ENTERPRISE_PROFILE: `enterprise-profile-${AppConstants.MOZ_UPDATE_CHANNEL}`,
  POLICY_POLLING_FREQUENCY: 60_000,
};

export async function ProfileName(loggedInUserInfo) {
  if (loggedInUserInfo !== null) {
    return `${FeltCommon.ENTERPRISE_PROFILE}-${await hashTo40bits(loggedInUserInfo.id)}`;
  }
  // lazy.log.error(`loggedInUserInfo not set`);
  return FeltCommon.ENTERPRISE_PROFILE;
}

async function hashTo40bits(s) {
  const msgUint8 = new TextEncoder().encode(s);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", msgUint8);
  const base64 = new Uint8Array(hashBuffer).slice(0, 5).toBase64({
    omitPadding: true,
    alphabet: "base64url",
  });
  return base64;
}
