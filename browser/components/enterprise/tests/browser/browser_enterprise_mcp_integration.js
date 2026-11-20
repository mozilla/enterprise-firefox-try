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
const NAVIGATION_ONLY = "https://test1.example.com";
const NAVIGATION_FIXTURE =
  "/browser/browser/components/enterprise/tests/browser/enterprise_mcp_navigation.sjs";
const POLICY = {
  ClientAccess: "LocalUser",
  Sites: [
    { Origin: ALLOWED, Tools: ["ReadPage", "Navigation", "Interact"] },
    { Origin: NAVIGATION_ONLY, Tools: ["Navigation"] },
  ],
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

async function initializeMCP({ waitForTools = true } = {}) {
  const mcp = await connect();
  registerCleanupFunction(() => mcp.close());
  const initial = await mcp.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "browser-mochitest", version: "1" },
  });
  Assert.equal(initial.protocolVersion, "2025-11-25");
  await mcp.sendNotification("notifications/initialized");
  if (waitForTools) {
    await mcp.waitForChange();
  }
  return mcp;
}

async function testControls(mcp, handle) {
  const call = (name, arguments_) =>
    mcp.request("tools/call", { name, arguments: arguments_ });
  const list = () => call("list_elements", { tab: handle });
  const interact = (element, action) =>
    call("interact", { tab: handle, element, action });
  const { elements } = (await list()).structuredContent;
  const byLabel = new Map(elements.map(element => [element.text, element]));
  for (const protectedLabel of ["Password", "File", "Code", "Hidden", "Pay"]) {
    Assert.ok(!byLabel.has(protectedLabel), protectedLabel + " is protected");
  }
  const click = { type: "click" };
  const apply = byLabel.get("Apply").handle;
  const priority = byLabel.get("Priority");
  Assert.deepEqual(priority.options, ["Low", "High", "Unavailable"]);
  Assert.ok(
    (await interact(priority.handle, { type: "select", index: 2 })).isError,
    "Disabled options cannot be selected"
  );
  Assert.ok(
    (await interact(byLabel.get("Subject").handle, click)).isError,
    "Handles cannot be used with a different action"
  );

  for (const [label, action] of [
    ["Apply", click],
    ["Popup", click],
    ["Subject", { type: "fill", value: "MCP test" }],
    ["Priority", { type: "select", index: 1 }],
    ["Log", { type: "scroll", x: 0, y: 64 }],
    ["Save", { type: "submit" }],
  ]) {
    Assert.ok(
      (await interact(byLabel.get(label).handle, action)).structuredContent
        ?.dispatched,
      "Dispatched " + action.type
    );
  }

  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], () => {
    const doc = content.document;
    Assert.equal(doc.querySelector("button").dataset.clicked, "yes");
    Assert.ok(
      ["false", "blocked"].includes(
        doc.querySelector("[data-opened]")?.dataset.opened
      ),
      "The agent tab could not open a popup"
    );
    Assert.equal(doc.getElementById("subject").value, "MCP test");
    Assert.equal(doc.getElementById("subject").dataset.edited, "yes");
    Assert.equal(doc.getElementById("priority").selectedIndex, 1);
    Assert.equal(doc.getElementById("priority").dataset.edited, "yes");
    Assert.equal(doc.querySelector("form").dataset.submitted, "yes");
    Assert.equal(doc.querySelector("[tabindex]").scrollTop, 64);
    doc.getElementById("subject").type = "password";
    doc.getElementById("subject").type = "text";
  });
  Assert.ok(
    (
      await interact(byLabel.get("Subject").handle, {
        type: "fill",
        value: "denied",
      })
    ).isError,
    "An existing handle cannot fill an input that became protected"
  );
  await list();
  Assert.ok(
    (await interact(apply, click)).isError,
    "Relisting invalidates old handles"
  );
  return (await list()).structuredContent.elements.find(e => e.text === "Apply")
    .handle;
}

async function testAgentTab(mcp) {
  const path = NAVIGATION_FIXTURE;
  const nonce = Services.uuid.generateUUID().toString();
  const approved = `${ALLOWED}${path}?id=${encodeURIComponent(nonce + "-approved")}`;
  const forbidden = `https://example.org${path}?id=${encodeURIComponent(nonce + "-forbidden")}`;
  const redirectTo = url => `${approved}&redirect=${encodeURIComponent(url)}`;
  const openTab = url =>
    mcp.request("tools/call", { name: "open_tab", arguments: { url } });
  const { tools } = await mcp.request("tools/list");
  Assert.ok(tools.some(tool => tool.name === "open_tab"));
  Assert.ok(tools.some(tool => tool.name === "navigate_tab"));
  Assert.ok(tools.some(tool => tool.name === "interact"));
  const initialTabCount = gBrowser.tabs.length;

  const fixture = await fetch(forbidden + "&count");
  Assert.equal(fixture.status, 200, "The navigation fixture is available");
  Assert.equal(await fixture.text(), "0");
  const redirect = await fetch(redirectTo(forbidden), { redirect: "manual" });
  Assert.equal(
    redirect.type,
    "opaqueredirect",
    "The source responds with a redirect"
  );

  Assert.ok((await openTab(forbidden)).isError);
  Assert.equal(gBrowser.tabs.length, initialTabCount);
  Assert.ok((await openTab(redirectTo(forbidden))).isError);
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length === initialTabCount
  );
  Assert.equal(
    await (await fetch(forbidden + "&count")).text(),
    "0",
    "The forbidden destination received neither a direct nor a redirected request"
  );

  async function stopAgentTab() {
    const tab = gBrowser.selectedTab;
    const box = gBrowser.getNotificationBox(tab.linkedBrowser);
    Assert.equal(
      box.currentNotification.getAttribute("value"),
      "enterprise-mcp-active"
    );
    box.currentNotification.buttonContainer
      .querySelector(".notification-button")
      .click();
    await mcp.waitForChange();
    await mcp.waitForChange();
    Assert.ok(!tab.isConnected, "Stop closed the agent-owned tab");
  }

  const navigationOnly = `${NAVIGATION_ONLY}${path}?id=${encodeURIComponent(nonce + "-navigation")}`;
  const crossOrigin = await openTab(redirectTo(navigationOnly));
  Assert.equal(crossOrigin.structuredContent.tab.origin, NAVIGATION_ONLY);
  const deniedPage = await mcp.request("tools/call", {
    name: "read_page",
    arguments: { tab: crossOrigin.structuredContent.tab.handle },
  });
  Assert.ok(deniedPage.isError, "Navigation grants do not authorize reading");
  await stopAgentTab();

  const opened = await openTab(
    redirectTo(`${approved}&image=${encodeURIComponent(forbidden)}`)
  );
  Assert.equal(opened.structuredContent.tab.origin, ALLOWED);
  Assert.equal(
    await (await fetch(forbidden + "&count")).text(),
    "1",
    "Navigation grants leave ordinary page subresources under existing network policy"
  );
  const other = await initializeMCP();
  const discovery = await other.request("tools/call", { name: "list_tabs" });
  Assert.deepEqual(discovery.structuredContent.tabs, []);
  const page = await mcp.request("tools/call", {
    name: "read_page",
    arguments: { tab: opened.structuredContent.tab.handle },
  });
  Assert.equal(page.structuredContent.page.text, "Agent tab");
  const tab = gBrowser.selectedTab;
  const handle = opened.structuredContent.tab.handle;
  const navigated = await mcp.request("tools/call", {
    name: "navigate_tab",
    arguments: { tab: handle, url: redirectTo(navigationOnly) },
  });
  Assert.equal(gBrowser.selectedTab, tab);
  Assert.equal(navigated.structuredContent.tab.origin, NAVIGATION_ONLY);
  Assert.notEqual(navigated.structuredContent.tab.handle, handle);
  const stale = await mcp.request("tools/call", {
    name: "navigate_tab",
    arguments: { tab: handle, url: approved },
  });
  Assert.ok(stale.isError, "The handle from the previous navigation is stale");
  Assert.equal(
    gBrowser.selectedTab,
    tab,
    "A stale call did not replace the tab"
  );
  await stopAgentTab();

  const controls = await openTab(approved + "&controls");
  const controlsTab = controls.structuredContent.tab.handle;
  const apply = await testControls(mcp, controlsTab);
  const replace = await mcp.request("tools/call", {
    name: "navigate_tab",
    arguments: { tab: controlsTab, url: navigationOnly },
  });
  const newHandle = replace.structuredContent.tab.handle;
  const staleControl = await mcp.request("tools/call", {
    name: "interact",
    arguments: { tab: newHandle, element: apply, action: { type: "click" } },
  });
  Assert.ok(staleControl.isError, "Navigation invalidated the element handle");
  const deniedControls = await mcp.request("tools/call", {
    name: "list_elements",
    arguments: { tab: newHandle },
  });
  Assert.ok(deniedControls.isError, "Navigation alone cannot expose controls");
  await stopAgentTab();
}

async function testExistingTab(mcp) {
  const uri = ALLOWED + NAVIGATION_FIXTURE + "?controls";
  await BrowserTestUtils.withNewTab(uri, async browser => {
    await TestUtils.waitForCondition(
      () => !browser.webProgress.isLoadingDocument
    );
    const call = (name, args) =>
      mcp.request("tools/call", { name, arguments: args });
    const [{ handle: tab }] = (await call("list_tabs")).structuredContent.tabs;
    const controls = await call("list_elements", { tab });
    const popup = controls.structuredContent.elements.find(
      element => element.text === "Popup"
    );
    Assert.ok(popup, "An existing tab lists approved controls");
    const result = await call("interact", {
      tab,
      element: popup.handle,
      action: { type: "click" },
    });
    Assert.ok(
      result.structuredContent?.dispatched,
      "The existing-tab action was dispatched"
    );
    await SpecialPowers.spawn(browser, [], () => {
      Assert.ok(
        ["false", "blocked"].includes(
          content.document.querySelector("[data-opened]")?.dataset.opened
        ),
        "An existing-tab MCP action could not open a popup"
      );
    });
    const blocked = await call("navigate_tab", {
      tab,
      url: "https://example.org/",
    });
    Assert.ok(blocked.isError);
    Assert.equal(browser.currentURI.spec, uri);

    const destination = NAVIGATION_ONLY + NAVIGATION_FIXTURE + "?existing";
    const moved = await call("navigate_tab", { tab, url: destination });
    Assert.equal(moved.structuredContent?.tab.origin, NAVIGATION_ONLY);
    Assert.equal(
      browser,
      gBrowser.selectedBrowser,
      "Navigated the existing tab in place"
    );
    Assert.equal(browser.currentURI.spec, destination);
    Assert.ok(
      (await call("read_page", { tab })).isError,
      "Navigation dropped the previous document handle"
    );
    Assert.ok(
      (await call("list_elements", { tab: moved.structuredContent.tab.handle }))
        .isError
    );

    const box = gBrowser.getNotificationBox(browser);
    box.currentNotification.buttonContainer
      .querySelector(".notification-button")
      .click();
    await mcp.waitForChange();
    await mcp.waitForChange();
    Assert.ok(browser.isConnected, "Stopping MCP leaves the user's tab open");
  });

  const nonce = encodeURIComponent(Services.uuid.generateUUID().toString());
  const forbidden = "https://example.org" + NAVIGATION_FIXTURE + "?id=" + nonce;
  await BrowserTestUtils.withNewTab(uri, async browser => {
    await TestUtils.waitForCondition(
      () => !browser.webProgress.isLoadingDocument
    );
    const { tabs } = (await mcp.request("tools/call", { name: "list_tabs" }))
      .structuredContent;
    const result = await mcp.request("tools/call", {
      name: "navigate_tab",
      arguments: {
        tab: tabs[0].handle,
        url: uri + "&redirect=" + encodeURIComponent(forbidden),
      },
    });
    Assert.ok(
      result.isError,
      "A forbidden redirect was refused in an existing tab"
    );
    Assert.equal(await (await fetch(forbidden + "&count")).text(), "0");
    await mcp.waitForChange();
    await mcp.waitForChange();
    Assert.ok(browser.isConnected);
  });

  const held = ALLOWED + NAVIGATION_FIXTURE + "?id=held-" + nonce;
  await BrowserTestUtils.withNewTab(uri, async browser => {
    await TestUtils.waitForCondition(
      () => !browser.webProgress.isLoadingDocument
    );
    const { tabs } = (await mcp.request("tools/call", { name: "list_tabs" }))
      .structuredContent;
    const loading = mcp.request("tools/call", {
      name: "navigate_tab",
      arguments: { tab: tabs[0].handle, url: held + "&hold" },
    });
    try {
      await TestUtils.waitForCondition(
        async () => (await (await fetch(held + "&count")).text()) === "1",
        "The existing-tab request reached the held response"
      );
      const box = gBrowser.getNotificationBox(browser);
      box.currentNotification.buttonContainer
        .querySelector(".notification-button")
        .click();
      Assert.ok(
        (await loading).isError,
        "Stop aborted the pending existing-tab operation"
      );
      await mcp.waitForChange();
      await mcp.waitForChange();
      Assert.ok(browser.isConnected, "Stop preserved the existing tab");
    } finally {
      await fetch(held + "&release");
    }
  });
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
  const consoleFetch = sinon
    .stub(ConsoleClient, "_fetch")
    .callsFake(async path => {
      Assert.equal(path, "/api/browser/policies");
      return { body, requestedURL: POLICIES_URL, responseURL: POLICIES_URL };
    });

  PoliciesPrefTracker.start();
  registerCleanupFunction(async () => {
    Services.obs.notifyObservers(null, "EnterprisePolicies:Reset");
    consoleFetch.restore();
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
      ["dom.disable_open_during_load", false],
    ],
  });
  const applied = EnterprisePolicyTesting.awaitAllPoliciesApplied();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");
  await applied;
  Assert.ok(Services.prefs.prefIsLocked("remote.policy.disabled"));
  Assert.ok(Services.prefs.getBoolPref("remote.policy.disabled"));
  Assert.deepEqual(Services.policies.getActivePolicies().EnterpriseMCP, POLICY);

  const mcp = await initializeMCP();
  await testAgentTab(mcp);
  await testExistingTab(mcp);

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

  const restored = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  body = { policies: { DisableDeveloperTools: true, EnterpriseMCP: POLICY } };
  await restored;
  await mcp.waitForChange();

  const heldURL =
    ALLOWED +
    NAVIGATION_FIXTURE +
    "?id=" +
    encodeURIComponent(Services.uuid.generateUUID().toString());
  const tabCount = gBrowser.tabs.length;
  const opening = mcp.request("tools/call", {
    name: "open_tab",
    arguments: { url: heldURL + "&hold" },
  });
  try {
    await TestUtils.waitForCondition(
      async () => (await (await fetch(heldURL + "&count")).text()) === "1",
      "The agent navigation reached the response held open by the server"
    );
    const withdrawn = EnterprisePolicyTesting.awaitNextPolicyUpdate();
    body = { policies: { DisableDeveloperTools: true } };
    await withdrawn;
    Assert.ok(
      (await opening).isError,
      "Withdrawal aborted in-flight navigation"
    );
    await TestUtils.waitForCondition(() => gBrowser.tabs.length === tabCount);
  } finally {
    await fetch(heldURL + "&release");
  }

  const managedDLP = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  body = {
    policies: {
      DisableDeveloperTools: true,
      EnterpriseMCP: POLICY,
      DataLossPrevention: { FallbackResult: "block" },
    },
  };
  await managedDLP;
  Assert.ok(Services.policies.getActivePolicies().DataLossPrevention);
  const restrictedMCP = await initializeMCP();
  const { tools } = await restrictedMCP.request("tools/list");
  Assert.deepEqual(
    tools.map(tool => tool.name),
    ["list_tabs", "open_tab", "navigate_tab"],
    "DLP leaves navigation available and withdraws reads and interaction"
  );
  const opened = await restrictedMCP.request("tools/call", {
    name: "open_tab",
    arguments: { url: heldURL + "&controls" },
  });
  const tab = opened.structuredContent.tab.handle;
  for (const tool of ["read_page", "list_elements"]) {
    const result = await restrictedMCP.request("tools/call", {
      name: tool,
      arguments: { tab },
    });
    Assert.ok(
      result.isError,
      tool + " is denied when called directly under DLP"
    );
  }
});
