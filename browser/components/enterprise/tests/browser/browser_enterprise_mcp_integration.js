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
const DIAGNOSTICS_ONLY = "https://test2.example.com";
const READ_ONLY = "https://www.example.com";
const INTERACT_ONLY = "https://test1.example.org";
const NAVIGATION_FIXTURE =
  "/browser/browser/components/enterprise/tests/browser/enterprise_mcp_navigation.sjs";
const POLICY = {
  ClientAccess: "LocalUser",
  DeniedSites: ["https://example.org"],
  Sites: [
    { Origin: ALLOWED, Tools: ["ReadPage", "Navigation", "Interact"] },
    { Origin: NAVIGATION_ONLY, Tools: ["Navigation"] },
    { Origin: READ_ONLY, Tools: ["Navigation", "ReadPage"] },
    { Origin: INTERACT_ONLY, Tools: ["Navigation", "Interact"] },
    { Origin: "https://example.org", Tools: ["Navigation"] },
    {
      Origin: DIAGNOSTICS_ONLY,
      Tools: ["NetworkMetadata", "ConsoleSummaries", "VisiblePageScreenshots"],
    },
  ],
};

async function connect(externalSigner) {
  const firefox = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  const process = await Subprocess.call({
    command: PathUtils.join(
      firefox.parent.path,
      Services.appinfo.OS === "WINNT"
        ? "firefox-enterprise-mcp.exe"
        : "firefox-enterprise-mcp"
    ),
    arguments: externalSigner ? ["--external-signer"] : [],
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

  async function startRequest(method, params) {
    const id = ++nextId;
    await send(method, params, id);
    return id;
  }

  return {
    startRequest,
    async request(method, params) {
      const id = await startRequest(method, params);
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
    async signChallenge(sign) {
      const challenge = await receive();
      Assert.equal(challenge.method, "firefoxEnterprise/signChallenge");
      const proof = await sign(challenge.params.payload);
      await process.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: challenge.id,
          result: proof,
        }) + "\n"
      );
      return proof;
    },
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

async function initializeMCP({
  externalSigner = false,
  waitForTools = true,
} = {}) {
  const mcp = await connect(externalSigner);
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
  const snapshot = () => call("snapshot", { tab: handle });
  const clickControl = element => call("click", { tab: handle, element });
  const fillControl = (element, value) =>
    call("fill", { tab: handle, element, value });
  const interact = (element, action) =>
    call("interact", { tab: handle, element, action });
  const { page, controls: elements } = (await snapshot()).structuredContent
    .snapshot;
  Assert.ok(page.text.includes("Apply"), "Snapshot includes visible page text");
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
    (await clickControl(byLabel.get("Subject").handle)).isError,
    "Handles cannot be used with a different action"
  );
  Assert.ok((await clickControl(apply)).structuredContent?.dispatched);
  Assert.ok(
    (await fillControl(byLabel.get("Subject").handle, "MCP test"))
      .structuredContent?.dispatched
  );

  for (const [label, action] of [
    ["Popup", click],
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
    (await fillControl(byLabel.get("Subject").handle, "denied")).isError,
    "An existing handle cannot fill an input that became protected"
  );
  await list();
  Assert.ok(
    (await clickControl(apply)).isError,
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
  Assert.ok(tools.some(tool => tool.name === "click"));
  Assert.ok(tools.some(tool => tool.name === "fill"));
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
  const deniedSnapshot = await mcp.request("tools/call", {
    name: "snapshot",
    arguments: { tab: newHandle },
  });
  Assert.ok(
    deniedSnapshot.isError,
    "Navigation alone cannot expose a snapshot"
  );
  await stopAgentTab();

  for (const [origin, readPage] of [
    [READ_ONLY, true],
    [INTERACT_ONLY, false],
  ]) {
    const scopedTab = await openTab(
      approved.replace(ALLOWED, origin) + "&controls"
    );
    const { structuredContent } = await mcp.request("tools/call", {
      name: "snapshot",
      arguments: { tab: scopedTab.structuredContent.tab.handle },
    });
    const { page: snapshotPage, controls: entries } =
      structuredContent.snapshot;
    if (readPage) {
      Assert.ok(
        snapshotPage.text.includes("Apply"),
        "ReadPage supplies the page text"
      );
      Assert.equal(entries, null, "ReadPage grants no control handles");
    } else {
      Assert.ok(entries.some(entry => entry.text === "Apply"));
      Assert.equal(snapshotPage, null, "Interact grants no page text");
    }
    await stopAgentTab();
  }
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
    const framePopup = controls.structuredContent.elements.find(
      element => element.text === "Frame popup"
    );
    Assert.ok(
      (
        await call("interact", {
          tab,
          element: framePopup.handle,
          action: { type: "click" },
        })
      ).structuredContent?.dispatched,
      "The action creating a same-origin frame was dispatched"
    );
    await SpecialPowers.spawn(browser, [], async () => {
      Assert.ok(
        ["false", "blocked"].includes(
          content.document.querySelector("[data-opened]")?.dataset.opened
        ),
        "An existing-tab MCP action could not open a popup"
      );
      Assert.ok(
        ["false", "blocked"].includes(
          content.document.querySelector("[data-frame-popup]")?.dataset
            .framePopup
        ),
        "A same-origin about:blank frame created during MCP control cannot open a popup"
      );
      const iframe = content.document.createElement("iframe");
      const loaded = ContentTaskUtils.waitForEvent(iframe, "load");
      iframe.src = "about:blank";
      content.document.body.append(iframe);
      await loaded;
      Assert.equal(
        SpecialPowers.wrap(iframe.contentDocument).sandboxFlagsAsString,
        SpecialPowers.wrap(content.document).sandboxFlagsAsString,
        "An iframe created during MCP control inherits only the document sandbox"
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

async function testDiagnostics(mcp) {
  const url = DIAGNOSTICS_ONLY + NAVIGATION_FIXTURE;
  await BrowserTestUtils.withNewTab(url, async browser => {
    const discovery = await mcp.request("tools/call", { name: "list_tabs" });
    const [{ handle: tab, origin }] = discovery.structuredContent.tabs;
    Assert.equal(origin, DIAGNOSTICS_ONLY);
    const call = name =>
      mcp.request("tools/call", { name, arguments: { tab } });
    Assert.ok(
      (await call("read_page")).isError,
      "Diagnostic grants do not allow page reads"
    );
    Assert.deepEqual(
      (await call("network_metadata")).structuredContent.requests,
      []
    );
    Assert.deepEqual((await call("console_summary")).structuredContent.counts, {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    });

    await SpecialPowers.spawn(
      browser,
      [DIAGNOSTICS_ONLY, NAVIGATION_FIXTURE],
      async (origin_, path) => {
        content.document.body.style.backgroundColor = "rgb(250, 0, 20)";
        content.console.debug("Actual console text is excluded");
        content.console.warn("Sensitive warning");
        const response = await content.fetch(
          origin_ + path + "?id=private-query",
          {
            method: "POST",
            body: "private request body",
            headers: { "x-private-header": "private header" },
          }
        );
        await response.text();
        const crossOrigin = await content.fetch("https://example.org" + path, {
          mode: "no-cors",
        });
        await crossOrigin.text();
      }
    );
    const summary = await call("console_summary");
    Assert.deepEqual(summary.structuredContent.counts, {
      debug: 1,
      info: 0,
      warn: 1,
      error: 0,
    });
    Assert.ok(!JSON.stringify(summary).includes("Sensitive warning"));

    let requests;
    await TestUtils.waitForCondition(async () => {
      requests = (await call("network_metadata")).structuredContent?.requests;
      return requests?.length > 0;
    }, "The same-origin POST appeared in the network summary");
    Assert.equal(requests.length, 1, "The cross-origin request was excluded");
    Assert.equal(requests[0].method, "POST");
    Assert.equal(requests[0].status, 200);
    Assert.greaterOrEqual(requests[0].duration_ms, 0);
    Assert.deepEqual(Object.keys(requests[0]).sort(), [
      "duration_ms",
      "method",
      "status",
    ]);

    const image = (await call("screenshot")).content[0];
    Assert.equal(image.type, "image");
    Assert.equal(image.mimeType, "image/jpeg");
    const bitmap = new Image();
    bitmap.src = "data:image/jpeg;base64," + image.data;
    await bitmap.decode();
    const canvas = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const [red, green, blue] = context.getImageData(
      Math.floor(bitmap.width / 2),
      Math.floor(bitmap.height / 2),
      1,
      1
    ).data;
    Assert.ok(
      red > 210 && green < 30 && blue < 60,
      "The capture contains the web document"
    );

    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const host = doc.createElement("div");
      host.id = "protected";
      const root = host.attachShadow({ mode: "closed" });
      root.appendChild(doc.createElement("input")).type = "password";
      doc.body.appendChild(host);
    });
    Assert.ok(
      (await call("screenshot")).isError,
      "A closed shadow tree with protected input blocks capture"
    );
    await SpecialPowers.spawn(browser, [NAVIGATION_FIXTURE], async path => {
      const doc = content.document;
      doc.getElementById("protected").remove();
      const frame = doc.createElement("iframe");
      const loaded = new content.Promise(resolve => (frame.onload = resolve));
      frame.src = "https://example.org" + path;
      doc.body.appendChild(frame);
      await loaded;
    });
    Assert.ok(
      (await call("screenshot")).isError,
      "An embedded frame blocks capture"
    );
    const box = gBrowser.getNotificationBox(browser);
    box.currentNotification.buttonContainer
      .querySelector(".notification-button")
      .click();
    await mcp.waitForChange();
    await mcp.waitForChange();
    Assert.deepEqual(
      (await mcp.request("tools/call", { name: "list_tabs" })).structuredContent
        .tabs,
      []
    );
  });
}

async function testSecurityLogging(mcp, updateLogging) {
  const operations = () =>
    Glean.enterpriseMcp.operation.testGetValue("enterprise") ?? [];
  const sessionEvents = () =>
    Glean.enterpriseMcp.sessionEvent.testGetValue("enterprise") ?? [];
  await BrowserTestUtils.withNewTab(
    ALLOWED + "/document-builder.sjs?html=%3Ch1%3EPrivate%20report%3C%2Fh1%3E",
    async browser => {
      await TestUtils.waitForCondition(
        () => !browser.webProgress.isLoadingDocument
      );
      const call = (name, arguments_) =>
        mcp.request("tools/call", { name, arguments: arguments_ });
      const { tabs } = (await call("list_tabs", {})).structuredContent;
      const read = () => call("read_page", { tab: tabs[0].handle });
      Assert.deepEqual(operations(), [], "MCP logging is disabled by default");
      Assert.deepEqual(sessionEvents(), []);

      await updateLogging({ Enabled: true, UrlLogging: "domain" });
      Assert.equal(
        (await read()).structuredContent.page.text,
        "Private report"
      );
      const [allowed] = operations();
      Assert.ok(allowed.extra.session);
      Assert.deepEqual(allowed.extra, {
        session: allowed.extra.session,
        category: "ReadPage",
        operation: "read_page",
        origin: "example.com",
        decision: "allow",
      });
      const bad = Services.uuid.generateUUID().toString().slice(1, -1);
      Assert.ok((await call("read_page", { tab: bad })).isError);
      Assert.equal(operations().at(-1).extra.decision, "deny");
      Assert.ok(
        (await call("click", { tab: tabs[0].handle, element: bad })).isError
      );
      Assert.equal(operations().at(-1).extra.operation, "click");
      Assert.equal(operations().at(-1).extra.category, "Interact");
      Assert.equal(operations().at(-1).extra.decision, "deny");

      await updateLogging({ Enabled: true, UrlLogging: "full" });
      await call("list_tabs", {});
      Assert.equal(operations().at(-1).extra.category, "Discovery");
      Assert.equal(operations().at(-1).extra.origin, ALLOWED);

      await updateLogging({ Enabled: true, UrlLogging: "none" });
      await call("list_tabs", {});
      Assert.ok(!("origin" in operations().at(-1).extra));

      await updateLogging(null);
      const count = operations().length;
      await call("list_tabs", {});
      Assert.equal(operations().length, count, "Removing policy stops logging");

      await updateLogging({ Enabled: true });
      gBrowser
        .getNotificationBox(browser)
        .currentNotification.buttonContainer.querySelector(
          ".notification-button"
        )
        .click();
      Assert.deepEqual(sessionEvents().at(-1).extra, {
        session: allowed.extra.session,
        access_mode: "LocalUser",
        action: "stopped",
      });
      await mcp.waitForChange();
      await mcp.waitForChange();
      Assert.equal(sessionEvents().at(-1).extra.action, "admitted");
      const { recordSession } = ChromeUtils.importESModule(
        "moz-src:///browser/components/enterprise/mcp/EnterpriseMCPAudit.sys.mjs"
      );
      const sessionCount = sessionEvents().length;
      recordSession(null, "AllowedApplications", "rejected");
      recordSession(null, "AllowedApplications", "rejected");
      Assert.equal(sessionEvents().length, sessionCount + 1);
      Assert.equal(sessionEvents().at(-1).extra.action, "rejected");
      await SpecialPowers.pushPrefEnv({
        set: [
          [
            "browser.policies.enterprise.telemetry.testing.disableSubmit",
            false,
          ],
        ],
      });
      try {
        let submitted;
        GleanPings.enterprise.testBeforeNextSubmit(() => {
          submitted = operations().at(-1)?.extra.operation;
        });
        await call("list_tabs", {});
        Assert.equal(submitted, "list_tabs", "MCP submits the enterprise ping");
      } finally {
        await SpecialPowers.popPrefEnv();
      }
      await updateLogging(null);
    }
  );
}

add_task(async function test_managed_mcp_stdio_with_developer_tools_disabled() {
  let body = {
    policies: { DisableDeveloperTools: true, EnterpriseMCP: POLICY },
  };
  let activeSession = true;
  let sessionChecks = 0;
  const originalFelt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: {
      isFeltBrowser: () => true,
      isFeltUI: () => false,
      isManagedAppDisconnectedFromFelt: () => false,
      hasActiveManagedSession() {
        sessionChecks++;
        return activeSession;
      },
      canRefreshManagedSession: () => true,
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
      ["browser.policies.enterprise.telemetry.testing.disableSubmit", true],
    ],
  });
  const applied = EnterprisePolicyTesting.awaitAllPoliciesApplied();
  Services.obs.notifyObservers(null, "EnterprisePolicies:Restart");
  await applied;
  Assert.ok(Services.prefs.prefIsLocked("remote.policy.disabled"));
  Assert.ok(Services.prefs.getBoolPref("remote.policy.disabled"));
  Assert.deepEqual(Services.policies.getActivePolicies().EnterpriseMCP, POLICY);

  const mcp = await initializeMCP();
  const updateLogging = async settings => {
    const updated = EnterprisePolicyTesting.awaitNextPolicyUpdate();
    body = {
      policies: {
        DisableDeveloperTools: true,
        EnterpriseMCP: POLICY,
        ...(settings && { SecurityLogging: { EnterpriseMCP: settings } }),
      },
    };
    await updated;
  };
  await testSecurityLogging(mcp, updateLogging);
  await BrowserTestUtils.withNewTab(
    ALLOWED + "/document-builder.sjs?html=Renewal",
    async browser => {
      await TestUtils.waitForCondition(
        () => !browser.webProgress.isLoadingDocument
      );
      const call = (name, arguments_) =>
        mcp.request("tools/call", { name, arguments: arguments_ });
      const { tabs } = (await call("list_tabs", {})).structuredContent;
      const read = () => call("read_page", { tab: tabs[0].handle });
      Assert.equal((await read()).structuredContent.page.text, "Renewal");
      const indicator =
        gBrowser.getNotificationBox(browser).currentNotification;
      const refresh = Promise.withResolvers();
      const refreshStarted = Promise.withResolvers();
      const getToken = sinon
        .stub(ConsoleClient, "getAccessToken")
        .callsFake(() => {
          refreshStarted.resolve();
          return refresh.promise;
        });
      try {
        activeSession = false;
        await refreshStarted.promise;
        let replied = false;
        const reading = read().then(reply => {
          replied = true;
          return reply;
        });
        const checksAtRead = sessionChecks;
        await TestUtils.waitForCondition(
          () => sessionChecks >= checksAtRead + 2
        );
        Assert.ok(!replied, "The read waits for the managed session refresh");
        Assert.equal(
          gBrowser.getNotificationBox(browser).currentNotification,
          indicator
        );
        activeSession = true;
        refresh.resolve("refreshed");
        Assert.equal((await reading).structuredContent.page.text, "Renewal");
        Assert.equal(
          gBrowser.getNotificationBox(browser).currentNotification,
          indicator
        );
        sinon.assert.calledOnce(getToken);
      } finally {
        activeSession = true;
        refresh.resolve("refreshed");
        getToken.restore();
      }
    }
  );
  await mcp.waitForChange();
  await mcp.waitForChange();
  await testAgentTab(mcp);
  await testExistingTab(mcp);
  await testDiagnostics(mcp);

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
      const wait = (text, timeout_ms) =>
        mcp.request("tools/call", {
          name: "wait",
          arguments: { tab: tabs[0].handle, text, timeout_ms },
        });
      Assert.deepEqual((await wait("Managed report")).structuredContent, {
        matched: true,
      });
      Assert.deepEqual((await wait("missing", 25)).structuredContent, {
        matched: false,
      });
      const box = gBrowser.getNotificationBox(browser);
      Assert.equal(
        box.currentNotification.getAttribute("value"),
        "enterprise-mcp-active",
        "The user's Stop control is shown during the session"
      );

      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("EnterpriseMCP");
      const query = sinon.spy(actor, "sendQuery");
      try {
        const waiting = wait("Report ready", 5000);
        await TestUtils.waitForCondition(() =>
          query.calledWith("EnterpriseMCP:MatchText")
        );
        Assert.equal(await query.firstCall.returnValue, false);
        await SpecialPowers.spawn(browser, [], () => {
          content.document.querySelector("h1").textContent = "Report ready";
        });
        Assert.deepEqual((await waiting).structuredContent, { matched: true });

        query.resetHistory();
        const stopping = wait("Never shown", 10000);
        await TestUtils.waitForCondition(() =>
          query.calledWith("EnterpriseMCP:MatchText")
        );
        box.currentNotification.buttonContainer
          .querySelector(".notification-button")
          .click();
        Assert.ok((await stopping).isError, "Stop ends the wait");
      } finally {
        query.restore();
      }
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
      Assert.equal(permitted.structuredContent.page.text, "Report ready");

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
  const cancelURL = heldURL + "-cancelled";
  const cancelled = await mcp.startRequest("tools/call", {
    name: "open_tab",
    arguments: { url: cancelURL + "&hold" },
  });
  try {
    await TestUtils.waitForCondition(
      async () => (await (await fetch(cancelURL + "&count")).text()) === "1",
      "The navigation reached the held response before cancellation"
    );
    await mcp.sendNotification("notifications/cancelled", {
      requestId: cancelled,
    });
    await mcp.waitForChange();
    await mcp.waitForChange();
    await TestUtils.waitForCondition(
      () => gBrowser.tabs.length === tabCount,
      "An MCP cancellation closes the pending agent tab"
    );
  } finally {
    await fetch(cancelURL + "&release");
  }

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
  for (const tool of [
    "read_page",
    "snapshot",
    "list_elements",
    "network_metadata",
    "console_summary",
    "screenshot",
  ]) {
    const result = await restrictedMCP.request("tools/call", {
      name: tool,
      arguments: { tab },
    });
    Assert.ok(
      result.isError,
      tool + " is denied when called directly under DLP"
    );
  }

  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const keys = await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("spki", keys.publicKey)
  );
  const key_id = "managed-client-a";
  const approved = {
    ...POLICY,
    ClientAccess: "ApprovedClients",
    ApprovedClients: [
      { Id: key_id, PublicKey: btoa(String.fromCharCode(...publicKey)) },
    ],
  };
  const enrollment = EnterprisePolicyTesting.awaitNextPolicyUpdate();
  body = { policies: { DisableDeveloperTools: true, EnterpriseMCP: approved } };
  await enrollment;

  const standard = await initializeMCP({ waitForTools: false });
  Assert.deepEqual((await standard.request("tools/list")).tools, []);
  const signed = await initializeMCP({
    externalSigner: true,
    waitForTools: false,
  });
  const proof = await signed.signChallenge(async payload => {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(payload)
    );
    return {
      key_id,
      signature: ChromeUtils.base64URLEncode(new Uint8Array(signature), {
        pad: false,
      }),
    };
  });
  await signed.waitForChange();
  Assert.ok(
    (await signed.request("tools/list")).tools.some(
      tool => tool.name === "read_page"
    )
  );

  const replay = await initializeMCP({
    externalSigner: true,
    waitForTools: false,
  });
  let replayed;
  await replay.signChallenge(payload => {
    replayed = payload;
    return proof;
  });
  await replay.signChallenge(payload => {
    Assert.notEqual(
      payload,
      replayed,
      "A replay was refused and the new connection has a fresh challenge"
    );
    return proof;
  });
  Assert.deepEqual((await replay.request("tools/list")).tools, []);

  const reportURL =
    ALLOWED + "/document-builder.sjs?html=%3Ch1%3EApproved%20report%3C%2Fh1%3E";
  await BrowserTestUtils.withNewTab(reportURL, async browser => {
    await TestUtils.waitForCondition(
      () => !browser.webProgress.isLoadingDocument
    );
    const { tabs } = (await signed.request("tools/call", { name: "list_tabs" }))
      .structuredContent;
    const read = () =>
      signed.request("tools/call", {
        name: "read_page",
        arguments: { tab: tabs[0].handle },
      });
    Assert.equal((await read()).structuredContent.page.text, "Approved report");

    const revocation = EnterprisePolicyTesting.awaitNextPolicyUpdate();
    body = {
      policies: {
        DisableDeveloperTools: true,
        EnterpriseMCP: { ...approved, ApprovedClients: [] },
      },
    };
    await revocation;
    await signed.waitForChange();
    Assert.deepEqual((await signed.request("tools/list")).tools, []);
    Assert.ok(
      (await read()).isError,
      "The revoked client lost its existing document handle"
    );
    Assert.equal(
      gBrowser
        .getNotificationBox(browser)
        .getNotificationWithValue("enterprise-mcp-active"),
      null
    );
  });

  const executable = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  const connectorPath = PathUtils.join(
    executable.parent.path,
    Services.appinfo.OS === "WINNT"
      ? "firefox-enterprise-mcp.exe"
      : "firefox-enterprise-mcp"
  );
  async function allowApplications(applications) {
    const update = EnterprisePolicyTesting.awaitNextPolicyUpdate();
    body = {
      policies: {
        DisableDeveloperTools: true,
        EnterpriseMCP: {
          ...POLICY,
          ClientAccess: "AllowedApplications",
          AllowedApplications: applications,
        },
      },
    };
    await update;
  }
  await allowApplications([
    { Id: "browser-mochitest", ExecutablePath: connectorPath },
  ]);
  const unmatched = await initializeMCP({ waitForTools: false });
  Assert.deepEqual(
    (await unmatched.request("tools/list")).tools,
    [],
    "An MCP client name that matches the policy ID does not approve its executable"
  );

  await allowApplications([
    { Id: "browser-mochitest", ExecutablePath: executable.path },
  ]);
  const stock = await initializeMCP();
  Assert.ok(
    (await stock.request("tools/list")).tools.some(
      tool => tool.name === "read_page"
    )
  );
  await allowApplications([
    { Id: "browser-mochitest", ExecutablePath: connectorPath },
  ]);
  await stock.waitForChange();
  Assert.deepEqual((await stock.request("tools/list")).tools, []);
});
