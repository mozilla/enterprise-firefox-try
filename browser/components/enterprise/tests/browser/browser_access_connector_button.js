/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { IPPProxyManager } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPProxyManager.sys.mjs"
);
const { IPPPrincipalRules, IPPSiteRuleManager } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/ipprotection/IPPSiteRuleManager.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

add_task(async function test_access_connector_button() {
  const sandbox = sinon.createSandbox();
  const server = new HttpServer();
  server.registerPathHandler("/page.html", (_, response) => {
    response.setHeader("Content-Type", "text/html");
    response.write("<title>Protected site</title>");
  });
  server.registerPathHandler("/data.json", (_, response) => {
    response.setHeader("Content-Type", "application/json");
    response.write('{"protected":true}');
  });
  server.start(-1);

  const site = `http://localhost:${server.identity.primaryPort}`;
  const button = document.getElementById("access-connector-button");
  let active = true;
  let included = true;

  Assert.ok(button, "AccessConnector button exists");
  sandbox.stub(IPPProxyManager, "active").get(() => active);
  const getRule = sandbox.stub(IPPSiteRuleManager, "getRule").callsFake(principal =>
    included && principal?.origin === site
      ? IPPPrincipalRules.INCLUDED
      : IPPPrincipalRules.EXCLUDED
  );

  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      `${site}/page.html`
    );
    try {
      await TestUtils.waitForCondition(
        () => !button.hidden,
        "AccessConnector button appears for an included site"
      );
      Assert.ok(!button.hasAttribute("error"), "Included site has no error");

      included = false;
      IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
      Assert.ok(button.hidden, "AccessConnector button hides for an excluded site");

      included = true;
      active = false;
      IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
      Assert.ok(button.hidden, "AccessConnector button hides when inactive");

      active = true;
      IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
      Assert.ok(!button.hidden, "AccessConnector button returns when active");

      included = false;
      IPPProxyManager.dispatchEvent(new Event("IPPProxyManager:StateChanged"));
      Assert.ok(button.hidden, "Button hides before navigating to the viewer");
      included = true;
      getRule.resetHistory();
      await BrowserTestUtils.loadURIString({
        browser: tab.linkedBrowser,
        uriString: `${site}/data.json`,
      });
      Assert.equal(
        tab.linkedBrowser.contentPrincipal.origin,
        "resource://devtools",
        "JSON viewer uses an internal content principal"
      );
      await TestUtils.waitForCondition(
        () => !button.hidden,
        "AccessConnector button appears for the site shown in the URL bar"
      );
      Assert.equal(
        getRule.lastCall.args[0].origin,
        site,
        "AccessConnector matches the viewer's site principal"
      );
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  } finally {
    sandbox.restore();
    server.stop();
  }
});
