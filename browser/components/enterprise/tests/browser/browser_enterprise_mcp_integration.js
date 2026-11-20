/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { ConsoleClient } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/enterprise/modules/ConsoleClient.sys.mjs"
);
const { EnterprisePolicyTesting, PoliciesPrefTracker } =
  ChromeUtils.importESModule(
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs"
  );
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const CONSOLE_ORIGIN = "https://console.example.com";
const POLICIES_URL = CONSOLE_ORIGIN + "/api/browser/policies";
const ALLOWED = "https://example.com";
const POLICY = {
  ClientAccess: "LocalUser",
  Sites: [{ Origin: ALLOWED, Tools: ["ReadPage"] }],
};

async function connect() {
  const firefox = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  const process = await Subprocess.call({
    command: PathUtils.join(
      firefox.parent.path,
      Services.appinfo.OS === "WINNT"
        ? "firefox-enterprise-mcp.exe"
        : "firefox-enterprise-mcp"
    ),
  });
  let buffered = "";
  let nextId = 0;
  async function receive() {
    while (!buffered.includes("\n")) {
      const data = await process.stdout.readString();
      if (!data) {
        throw new Error("MCP connector closed stdout");
      }
      buffered += data;
    }
    const newline = buffered.indexOf("\n");
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    return JSON.parse(line);
  }

  function send(method, params, id) {
    return process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
  }

  return {
    async request(method, params) {
      const id = ++nextId;
      await send(method, params, id);
      let response;
      do {
        response = await receive();
      } while (response.id !== id);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.result;
    },
    sendNotification: send,
    async waitForChange() {
      Assert.equal(
        (await receive()).method,
        "notifications/tools/list_changed"
      );
    },
    async close() {
      await process.stdin.close();
      await process.wait();
    },
  };
}

add_task(async function test_managed_mcp_stdio_with_developer_tools_disabled() {
  let body = {
    policies: { DisableDeveloperTools: true, EnterpriseMCP: POLICY },
  };
  const originalFelt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: {
      isFeltBrowser: () => true,
      isFeltUI: () => false,
      isManagedAppDisconnectedFromFelt: () => false,
      hasActiveManagedSession: () => true,
      getConsoleUrl: () => CONSOLE_ORIGIN,
    },
  });
  const fetch = sinon.stub(ConsoleClient, "_fetch").callsFake(async path => {
    Assert.equal(path, "/api/browser/policies");
    return { body, requestedURL: POLICIES_URL, responseURL: POLICIES_URL };
  });

  PoliciesPrefTracker.start();
  registerCleanupFunction(async () => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    fetch.restore();
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: originalFelt,
    });
    await EnterprisePolicyTesting.setupPolicyEngineWithJson("");
    PoliciesPrefTracker.stop();
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["enterprise.policies.live.polling_interval", 250],
      ["security.notification_enable_delay", 0],
    ],
  });
  const applied = EnterprisePolicyTesting.awaitAllPoliciesApplied();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");
  await applied;
  Assert.ok(Services.prefs.prefIsLocked("remote.policy.disabled"));
  Assert.ok(Services.prefs.getBoolPref("remote.policy.disabled"));
  Assert.deepEqual(Services.policies.getActivePolicies().EnterpriseMCP, POLICY);

  const mcp = await connect();
  registerCleanupFunction(() => mcp.close());
  const initial = await mcp.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "browser-mochitest", version: "1" },
  });
  Assert.equal(initial.protocolVersion, "2025-11-25");
  await mcp.sendNotification("notifications/initialized");
  await mcp.waitForChange();

  await BrowserTestUtils.withNewTab(
    "https://example.org/document-builder.sjs?html=Denied",
    async () => {
      const denied = await mcp.request("tools/call", { name: "list_tabs" });
      Assert.deepEqual(denied.structuredContent.tabs, []);
    }
  );

  await BrowserTestUtils.withNewTab(
    ALLOWED + "/document-builder.sjs?html=%3Ch1%3EManaged%20report%3C%2Fh1%3E",
    async browser => {
      await TestUtils.waitForCondition(
        () => !browser.webProgress.isLoadingDocument
      );
      const discovered = await mcp.request("tools/call", { name: "list_tabs" });
      const { tabs } = discovered.structuredContent;
      Assert.equal(tabs.length, 1);
      Assert.equal(tabs[0].origin, ALLOWED);

      const response = await mcp.request("tools/call", {
        name: "read_page",
        arguments: { tab: tabs[0].handle },
      });
      Assert.equal(response.structuredContent.page.text, "Managed report");
      const box = gBrowser.getNotificationBox(browser);
      Assert.equal(
        box.currentNotification.getAttribute("value"),
        "enterprise-mcp-active",
        "The user's Stop control is shown during the session"
      );

      box.currentNotification.buttonContainer
        .querySelector(".notification-button")
        .click();
      await mcp.waitForChange();
      await mcp.waitForChange();

      const stopped = await mcp.request("tools/call", { name: "list_tabs" });
      Assert.deepEqual(stopped.structuredContent.tabs, []);

      const prompt = await TestUtils.waitForCondition(() =>
        box.getNotificationWithValue("enterprise-mcp-stopped")
      );
      prompt.buttonContainer.querySelector(".notification-button").click();
      const reattached = await mcp.request("tools/call", { name: "list_tabs" });
      const handle = reattached.structuredContent.tabs[0].handle;
      const permitted = await mcp.request("tools/call", {
        name: "read_page",
        arguments: { tab: handle },
      });
      Assert.equal(permitted.structuredContent.page.text, "Managed report");

      const updated = EnterprisePolicyTesting.awaitNextPolicyUpdate();
      body = { policies: { DisableDeveloperTools: true } };
      await updated;
      await mcp.waitForChange();
      Assert.ok(!Services.policies.getActivePolicies().EnterpriseMCP);
      Assert.equal(box.getNotificationWithValue("enterprise-mcp-active"), null);
      const afterRemoval = await mcp.request("tools/list");
      Assert.deepEqual(afterRemoval.tools, []);
      const stale = await mcp.request("tools/call", {
        name: "read_page",
        arguments: { tab: handle },
      });
      Assert.ok(stale.isError);
      Assert.ok(Services.prefs.getBoolPref("remote.policy.disabled"));
    }
  );
});
