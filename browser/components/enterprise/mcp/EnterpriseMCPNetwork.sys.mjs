/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export function sameDocumentRequest(channel, document, startTime) {
  const { loadInfo } = channel;
  const principal = document.global.documentPrincipal;
  const { TYPE_DOCUMENT, TYPE_SUBDOCUMENT } = Ci.nsIContentPolicy;
  if (
    loadInfo.externalContentPolicyType === TYPE_DOCUMENT ||
    loadInfo.externalContentPolicyType === TYPE_SUBDOCUMENT ||
    !loadInfo.loadingPrincipal?.equals(principal) ||
    !loadInfo.triggeringPrincipal?.equals(principal) ||
    loadInfo.innerWindowID !== document.global.innerWindowId ||
    !loadInfo.browsingContext ||
    loadInfo.browsingContext !== document.browser.browsingContext ||
    URL.parse(channel.URI.spec)?.origin !== document.origin ||
    URL.parse(channel.originalURI.spec)?.origin !== document.origin ||
    loadInfo.redirectChainIncludingInternalRedirects.some(
      entry => !entry.principal.equals(principal)
    )
  ) {
    return null;
  }
  const timed = channel.QueryInterface(Ci.nsITimedChannel);
  const start = timed.asyncOpenTime;
  const end = timed.responseEndTime;
  if (start < startTime * 1000 || end < start) {
    return null;
  }
  const { responseStatus, requestMethod } = channel;
  if (responseStatus < 100 || responseStatus > 599) {
    return null;
  }
  return {
    method: METHODS.has(requestMethod) ? requestMethod : "OTHER",
    status: responseStatus,
    duration_ms: Math.min(3_600_000, Math.round((end - start) / 1000)),
  };
}
