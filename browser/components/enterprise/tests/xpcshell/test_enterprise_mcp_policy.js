/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { compilePolicy } = ChromeUtils.importESModule(
  "moz-src:///browser/components/enterprise/mcp/EnterpriseMCPPolicy.sys.mjs"
);
const { CombinedProvider } = ChromeUtils.importESModule(
  "resource://gre/modules/EnterprisePoliciesParent.sys.mjs"
);

add_task(function test_policy_origins() {
  const policy = compilePolicy({
    ClientAccess: "LocalUser",
    Sites: [
      { Origin: "https://bücher.example", Tools: ["ReadPage"] },
      { Origin: "https://*.example.net:443", Tools: ["ReadPage"] },
      { Origin: "https://input.example", Tools: ["Interact"] },
    ],
    DeniedSites: ["https://*.blocked.example.net"],
  });
  const canRead = url => policy.grants(new URL(url), "ReadPage");

  Assert.ok(canRead("https://xn--bcher-kva.example/reports"));
  Assert.ok(canRead("https://reports.example.net/"));
  Assert.ok(!canRead("https://example.net/"));
  Assert.ok(!canRead("https://reports.example.net./"));
  Assert.ok(!canRead("http://reports.example.net/"));
  Assert.ok(!canRead("https://reports.example.net:444/"));
  Assert.ok(!canRead("https://reports.example.net.attacker.example/"));
  Assert.ok(!canRead("https://reports.blocked.example.net/"));
  Assert.ok(!canRead("https://input.example/"));
});

add_task(function test_blocklist_with_default_tools() {
  const policy = compilePolicy({
    ClientAccess: "LocalUser",
    SiteMode: "Blocklist",
    DefaultTools: ["ReadPage"],
    DeniedSites: ["https://forbidden.example", "https://*.denied.example."],
    Sites: [{ Origin: "https://forbidden.example", Tools: ["ReadPage"] }],
  });
  Assert.ok(policy.grants(new URL("https://allowed.example"), "ReadPage"));
  Assert.ok(!policy.grants(new URL("https://forbidden.example"), "ReadPage"));
  Assert.ok(!policy.grants(new URL("https://forbidden.example."), "ReadPage"));
  Assert.ok(
    !policy.grants(new URL("https://reports.denied.example"), "ReadPage")
  );
  Assert.ok(
    !policy.grants(new URL("https://reports.denied.example."), "ReadPage")
  );
  Assert.ok(!policy.grants(new URL("file:///tmp/report"), "ReadPage"));
  Assert.ok(!policy.grants(new URL("https://allowed.example"), "Interact"));
});

add_task(function test_malformed_denial_fails_policy() {
  Assert.throws(
    () =>
      compilePolicy({
        ClientAccess: "LocalUser",
        SiteMode: "Blocklist",
        DefaultTools: ["ReadPage"],
        DeniedSites: ["https://example.com/path"],
      }),
    /HTTP\(S\) origin/
  );
});

add_task(function test_local_sources_cannot_grant_mcp() {
  const provider = new CombinedProvider();
  provider.push({
    policies: { EnterpriseMCP: { ClientAccess: "LocalUser" } },
    userPolicies: { EnterpriseMCP: { ClientAccess: "LocalUser" } },
  });
  provider.mergePolicies();
  Assert.ok(!Object.hasOwn(provider.policies, "EnterpriseMCP"));
});

add_task(function test_enrollment_requires_unique_identities() {
  const approved = { Id: "installation-1", PublicKey: "YQ==" };
  const compile = ApprovedClients =>
    compilePolicy({ ClientAccess: "ApprovedClients", ApprovedClients });
  Assert.equal(
    compile([approved]).approvedKeys.get(approved.Id),
    approved.PublicKey
  );
  Assert.throws(
    () => compile([approved, approved]),
    /Invalid MCP client enrollment/
  );
  Assert.throws(
    () => compile([approved, { ...approved, Id: "installation-2" }]),
    /Invalid MCP client enrollment/
  );
});
