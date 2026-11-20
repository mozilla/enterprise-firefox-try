/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export function parseOriginPattern(value) {
  const pattern =
    /^(https?):\/\/(\*\.)?(\[[0-9a-f:.]+\]|[^\s/@?#:*%\\]+)(:\d+)?\/?$/i.exec(
      value
    );
  if (!pattern) {
    throw new Error("Expected an HTTP(S) origin or subdomain pattern");
  }
  const [, scheme, wildcard, host, port = ""] = pattern;
  const url = new URL(`${scheme}://${host}${port}`);
  if (
    wildcard &&
    (url.hostname.startsWith("[") || /^[\d.]+$/.test(url.hostname))
  ) {
    throw new Error("Only DNS hostnames support subdomain patterns");
  }
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    wildcard: !!wildcard,
  };
}

function matches(pattern, url) {
  if (pattern.protocol !== url.protocol || pattern.port !== url.port) {
    return false;
  }
  const host = url.hostname;
  return pattern.wildcard
    ? host.endsWith("." + pattern.hostname)
    : host === pattern.hostname;
}

export function compilePolicy(policy) {
  const denied = (policy.DeniedSites ?? []).map(parseOriginPattern);
  const sites = (policy.Sites ?? []).map(({ Origin, Tools }) => ({
    pattern: parseOriginPattern(Origin),
    tools: new Set(Tools),
  }));
  const defaultTools = new Set(
    policy.SiteMode === "Blocklist" ? policy.DefaultTools : []
  );
  return {
    clientAccess: policy.ClientAccess,
    hasGrant(category) {
      return (
        defaultTools.has(category) ||
        sites.some(({ tools }) => tools.has(category))
      );
    },
    grants(url, category) {
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !denied.some(pattern => matches(pattern, url)) &&
        (defaultTools.has(category) ||
          sites.some(
            ({ pattern, tools }) => tools.has(category) && matches(pattern, url)
          ))
      );
    },
  };
}
