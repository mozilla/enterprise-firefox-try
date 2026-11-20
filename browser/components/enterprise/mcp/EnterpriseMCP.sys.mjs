/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  setInterval,
  clearInterval,
} from "resource://gre/modules/Timer.sys.mjs";
import { guardTab } from "./EnterpriseMCPNavigation.sys.mjs";
import { compilePolicy } from "./EnterpriseMCPPolicy.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProgressListener: "chrome://remote/content/shared/Navigate.sys.mjs",
});

const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;
const SANDBOXED_MODALS = 0x800;
const SANDBOXED_DOWNLOADS = 0x10000;
const SANDBOXED_TOPLEVEL_NAVIGATION_CUSTOM_PROTOCOLS = 0x40000;

const AUTHORIZE = "EnterpriseMCP:Authorize";
const TRANSPORT = "@mozilla.org/enterprise-mcp/transport;1";
const ACTOR_PATH = "moz-src:///browser/components/enterprise/mcp/";
const MANAGED_TOPICS = [
  "felt-firefox-shutdown",
  "felt-firefox-signout-requested",
  "quit-application",
  "EnterprisePolicies:Discarded",
  "EnterprisePolicies:PolicyUpdatesApplied",
];

function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function sameManagementHost(a, b) {
  return a.hostname.replace(/\.$/, "") === b.hostname.replace(/\.$/, "");
}

function currentConsole() {
  try {
    if (Services.felt.hasActiveManagedSession()) {
      const url = new URL(Services.felt.getConsoleUrl());
      if (url.protocol === "https:") {
        return url;
      }
    }
  } catch {}
  return null;
}

function canExportPage() {
  const policies = Services.policies.getActivePolicies();
  if (
    !policies ||
    policies.ContentAnalysis?.Enabled === true ||
    policies.DataLossPrevention
  ) {
    return false;
  }
  const analysis = "@mozilla.org/contentanalysis;1";
  try {
    return (
      !(analysis in Cc) ||
      !Cc[analysis].getService(Ci.nsIContentAnalysis).isActive
    );
  } catch {
    return false;
  }
}

export const EnterpriseMCP = new (class {
  #policy = null;
  #transport = null;
  #timer = null;
  #generation = 0;
  #clients = new Map();
  #owners = new Map();
  #tickets = new Map();
  #cancelledLoads = new WeakSet();
  #stoppedBrowsers = new WeakSet();
  #initialized = false;
  #listening = false;
  #capabilities = null;

  apply(policy) {
    this.remove();
    let compiled;
    try {
      compiled = compilePolicy(policy);
    } catch {
      return;
    }
    if (
      compiled.clientAccess !== "LocalUser" ||
      !["ReadPage", "Navigation", "Interact"].some(category =>
        compiled.hasGrant(category)
      ) ||
      !(TRANSPORT in Cc)
    ) {
      return;
    }
    if (!this.#initialized) {
      this.#initialized = true;
      ChromeUtils.registerWindowActor("EnterpriseMCP", {
        parent: { esModuleURI: ACTOR_PATH + "EnterpriseMCPParent.sys.mjs" },
        child: { esModuleURI: ACTOR_PATH + "EnterpriseMCPChild.sys.mjs" },
        matches: ["http://*/*", "https://*/*"],
        remoteTypes: ["web"],
        safeForUntrustedWebProcess: true,
        allFrames: false,
      });
      Services.ppmm.addMessageListener(AUTHORIZE, this);
      for (const topic of MANAGED_TOPICS) {
        Services.obs.addObserver(this, topic);
      }
    }
    this.#policy = compiled;
    this.#transport = Cc[TRANSPORT].createInstance(
      Ci.nsIEnterpriseMCPTransport
    );
    this.#timer = setInterval(() => this.#poll(), 100);
  }

  remove() {
    this.#reset();
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#policy = null;
    this.#transport = null;
    if (this.#initialized) {
      this.#initialized = false;
      Services.ppmm.removeMessageListener(AUTHORIZE, this);
      ChromeUtils.unregisterWindowActor("EnterpriseMCP");
      for (const topic of MANAGED_TOPICS) {
        Services.obs.removeObserver(this, topic);
      }
    }
  }

  observe(subject, topic) {
    if (topic === "EnterprisePolicies:PolicyUpdatesApplied") {
      this.#reset();
    } else {
      this.remove();
    }
  }

  receiveMessage({ sync, data, target }) {
    const ticket = this.#tickets.get(data?.ticket);
    if (
      !sync ||
      !ticket ||
      target?.processParent?.childID !== ticket.global.contentParentId
    ) {
      return false;
    }
    this.#tickets.delete(data.ticket);
    this.#poll();
    ticket.authorized = ticket.check();
    return ticket.authorized;
  }

  #reset() {
    this.#generation++;
    this.#tickets.clear();
    this.#transport?.stop();
    this.#listening = false;
    for (const client of this.#clients.keys()) {
      this.#forget(client);
    }
  }

  #forget(id, disconnect = false) {
    const client = this.#clients.get(id);
    if (!client) {
      return;
    }
    this.#clients.delete(id);
    if (client.owner) {
      const { browser, box, notification, unwatch } = client.owner;
      this.#releaseInteraction(client.owner);
      this.#owners.delete(browser);
      unwatch();
      if (notification?.isConnected) {
        box.removeNotification(notification, true);
      }
    }
    this.#cancelAttachedLoad(client);
    this.#closeAgentTab(client);
    if (disconnect) {
      this.#transport?.disconnect(id);
    }
  }

  #closeAgentTab(client) {
    const agentTab = client.agentTab;
    if (!agentTab) {
      return;
    }
    client.agentTab = null;
    const { tab, browser, gBrowser, progress, unguard, onClose } = agentTab;
    tab.removeEventListener("TabClose", onClose);
    this.#stoppedBrowsers.add(browser);
    try {
      if (progress?.isStarted) {
        progress.stop({
          error: new Error("Enterprise MCP navigation cancelled"),
        });
      }
    } finally {
      Services.tm.dispatchToMainThread(() => {
        try {
          if (tab.isConnected && !tab.closing) {
            browser.stop();
            gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
          }
        } finally {
          unguard?.();
        }
      });
    }
  }

  #poll() {
    try {
      const managed =
        Services.policies.status === Ci.nsIEnterprisePolicies.ACTIVE &&
        !!currentConsole();
      const navigation = managed && this.#policy.hasGrant("Navigation");
      const mayExport = managed && canExportPage();
      const capabilities = {
        read_page: mayExport && this.#policy.hasGrant("ReadPage"),
        navigation,
        interact: mayExport && this.#policy.hasGrant("Interact"),
      };
      if (!Object.values(capabilities).some(Boolean)) {
        if (this.#listening) {
          this.#reset();
        }
        return;
      }
      if (
        this.#listening &&
        Object.keys(capabilities).some(
          key => capabilities[key] !== this.#capabilities[key]
        )
      ) {
        this.#reset();
      }
      if (!this.#listening) {
        this.#transport.start(JSON.stringify(capabilities));
        this.#capabilities = capabilities;
        this.#listening = true;
      }
      for (const [id, client] of this.#clients) {
        if (
          client.owner &&
          ((!client.owner.navigating &&
            !this.#loadingFromInteraction(client.owner) &&
            !this.#checkedDocument(client.owner, client.owner.category)) ||
            (client.owner.notification &&
              client.owner.box.currentNotification !==
                client.owner.notification))
        ) {
          this.#forget(id, true);
        }
      }

      const generation = this.#generation;
      for (const incoming of JSON.parse(this.#transport.poll())) {
        const { client, type, request } = incoming;
        if (type === "connected") {
          this.#connected(client);
        } else if (type === "disconnected") {
          this.#forget(client);
        } else if (request.operation === "cancel") {
          const state = this.#clients.get(client);
          if (state?.pending?.id === request.id) {
            state.pending = null;
            if (
              state.agentTab?.requestId === request.id ||
              state.attachedLoad?.requestId === request.id
            ) {
              this.#forget(client, true);
            }
          }
        } else {
          this.#run(client, request, generation);
        }
      }
    } catch {
      this.#reset();
    }
  }

  #connected(id) {
    this.#clients.set(id, {
      auditId: uuid(),
      handle: null,
      pending: null,
      owner: null,
    });
  }

  #documentFor(browser, category = "ReadPage") {
    const foreground = category !== "Navigation";
    const consoleURL = currentConsole();
    if (
      !consoleURL ||
      Services.policies.status !== Ci.nsIEnterprisePolicies.ACTIVE ||
      !browser?.isConnected ||
      this.#stoppedBrowsers.has(browser)
    ) {
      return null;
    }
    const window = browser.documentGlobal;
    if (
      !window ||
      window.closed ||
      (foreground &&
        (window.fullScreen ||
          window.document.fullscreenElement ||
          window.gBrowser?.selectedBrowser !== browser)) ||
      browser.webProgress?.isLoadingDocument
    ) {
      return null;
    }
    const context = browser.browsingContext;
    const global = context?.currentWindowGlobal;
    const principal = global?.documentPrincipal;
    if (
      !context ||
      context.parent ||
      (foreground && !context.isActive) ||
      !global?.isCurrentGlobal ||
      global.isInitialDocument ||
      !principal?.isContentPrincipal ||
      (!global.documentURI?.schemeIs("http") &&
        !global.documentURI?.schemeIs("https")) ||
      principal.isAddonPrincipal ||
      principal.privateBrowsingId
    ) {
      return null;
    }
    const origin = principal.originNoSuffix;
    const url = new URL(origin);
    if (
      new URL(global.documentURI.spec).origin !== url.origin ||
      sameManagementHost(url, consoleURL) ||
      !this.#policy?.grants(url, category) ||
      (foreground && !canExportPage())
    ) {
      return null;
    }
    return { browser, global, origin };
  }

  #checkedDocument(document, category) {
    const current = this.#documentFor(document.browser, category);
    return (
      current?.global === document.global && current.origin === document.origin
    );
  }

  async #indicate(clientId, client, document, category = "ReadPage") {
    const { browser } = document;
    const existing = this.#owners.get(browser);
    if (existing) {
      return existing === client.owner && !!existing.notification;
    }
    if (client.owner) {
      return false;
    }

    const { gBrowser } = browser.documentGlobal;
    const watch = {
      onStateChange: (changedBrowser, progress, _request, flags) => {
        const { STATE_START, STATE_IS_DOCUMENT } = Ci.nsIWebProgressListener;
        if (
          changedBrowser === browser &&
          !owner.navigating &&
          !owner.effect &&
          progress.isTopLevel &&
          flags & STATE_START &&
          flags & STATE_IS_DOCUMENT
        ) {
          this.#forget(clientId, true);
        }
      },
      onLocationChange: (changedBrowser, progress) => {
        if (
          changedBrowser === browser &&
          !owner.navigating &&
          progress.isTopLevel
        ) {
          this.#forget(clientId, true);
        }
      },
    };
    const tabChanged = () => {
      if (
        (!client.agentTab && gBrowser.selectedBrowser !== browser) ||
        (!owner.navigating && !this.#checkedDocument(owner, owner.category))
      ) {
        this.#forget(clientId, true);
      }
    };
    gBrowser.addTabsProgressListener(watch);
    gBrowser.tabContainer.addEventListener("TabSelect", tabChanged);
    const box = gBrowser.getNotificationBox(browser);
    const owner = {
      ...document,
      category,
      box,
      navigating: false,
      notification: null,
      unwatch() {
        gBrowser.removeTabsProgressListener(watch);
        gBrowser.tabContainer.removeEventListener("TabSelect", tabChanged);
      },
    };
    client.owner = owner;
    this.#owners.set(browser, owner);
    const stop = () => {
      if (this.#owners.get(browser) !== owner) {
        return;
      }
      if (client.agentTab) {
        this.#forget(clientId, true);
      } else {
        this.#stoppedBrowsers.add(browser);
        this.#forget(clientId, true);
        this.#offerReattachment(browser, box);
      }
    };
    const notification = await box.appendNotification(
      "enterprise-mcp-active",
      {
        label: {
          "l10n-id": client.agentTab
            ? "enterprise-mcp-agent-tab"
            : "enterprise-mcp-active",
        },
        priority: box.PRIORITY_CRITICAL_HIGH,
        eventCallback: event => {
          if (event === "dismissed" || event === "removed") {
            stop();
          }
        },
      },
      [
        {
          "l10n-id": "enterprise-mcp-stop",
          callback() {
            stop();
            return true;
          },
        },
      ],
      true,
      false
    );
    if (
      this.#clients.get(clientId) !== client ||
      this.#owners.get(browser) !== owner
    ) {
      box.removeNotification(notification, true);
      return false;
    }
    owner.notification = notification;
    notification.timeout = Infinity;
    return box.currentNotification === notification;
  }

  async #offerReattachment(browser, box) {
    try {
      const prompt = await box.appendNotification(
        "enterprise-mcp-stopped",
        {
          label: { "l10n-id": "enterprise-mcp-stopped" },
          priority: box.PRIORITY_INFO_MEDIUM,
        },
        [
          {
            "l10n-id": "enterprise-mcp-allow",
            callback: () => {
              this.#stoppedBrowsers.delete(browser);
            },
          },
        ],
        false,
        false
      );
      prompt.timeout = Infinity;
    } catch {}
  }

  #navigationURL(spec) {
    const consoleURL = currentConsole();
    const url = URL.parse(spec);
    if (
      !consoleURL ||
      Services.policies.status !== Ci.nsIEnterprisePolicies.ACTIVE ||
      !url ||
      url.username ||
      url.password ||
      sameManagementHost(url, consoleURL) ||
      !this.#policy?.grants(url, "Navigation")
    ) {
      return null;
    }
    return url;
  }

  async #openTab(clientId, client, request, stillPending) {
    const url = request.url.length <= 4096 && this.#navigationURL(request.url);
    const window = Services.wm.getMostRecentWindow("navigator:browser");
    if (
      !url ||
      client.owner ||
      client.agentTab ||
      !window?.gBrowser ||
      window.fullScreen ||
      window.document.fullscreenElement ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return null;
    }

    const { gBrowser } = window;
    const principal = Services.scriptSecurityManager.createNullPrincipal({});
    const tab = gBrowser.addTab("about:blank", {
      triggeringPrincipal: principal,
      skipLoad: true,
    });
    const browser = tab.linkedBrowser;
    const onClose = () => this.#forget(clientId, true);
    const agentTab = { browser, tab, gBrowser, onClose, requestId: request.id };
    client.agentTab = agentTab;
    tab.addEventListener("TabClose", onClose, { once: true });
    try {
      const context = browser.browsingContext;
      context.sandboxFlags |=
        SANDBOXED_AUXILIARY_NAVIGATION |
        SANDBOXED_MODALS |
        SANDBOXED_DOWNLOADS |
        SANDBOXED_TOPLEVEL_NAVIGATION_CUSTOM_PROTOCOLS;
      agentTab.unguard = guardTab(context.browserId, channel => {
        const allowed =
          this.#clients.get(clientId) === client &&
          client.agentTab === agentTab &&
          !!this.#navigationURL(channel.URI.spec);
        agentTab.blocked ||= !allowed;
        return allowed;
      });
      if (!stillPending()) {
        return null;
      }
      gBrowser.selectedTab = tab;
      const document = await this.#loadTab(agentTab, url);
      if (
        !stillPending() ||
        agentTab.blocked ||
        !document ||
        !(await this.#indicate(clientId, client, document, "Navigation")) ||
        !stillPending() ||
        !this.#checkedDocument(document, "Navigation")
      ) {
        return null;
      }
      return this.#agentTabResult(client, document);
    } finally {
      if (
        agentTab.requestId !== null &&
        this.#clients.get(clientId) === client
      ) {
        this.#closeAgentTab(client);
      }
    }
  }

  async #loadTab(load, url) {
    const { browser } = load;
    const uri = Services.io.newURI(url.href);
    const context = browser.browsingContext;
    const progress = new lazy.ProgressListener(browser.webProgress, {
      expectNavigation: true,
      targetURI: uri,
      waitForExplicitStart: true,
    });
    load.blocked = false;
    load.progress = progress;
    const loaded = progress.start();
    try {
      context.loadURI(uri, {
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL,
        schemelessInput: Ci.nsILoadInfo.SchemelessInputTypeSchemeful,
        triggeringPrincipal:
          load.principal ??
          Services.scriptSecurityManager.createNullPrincipal(
            context.originAttributes
          ),
      });
    } catch (error) {
      progress.stop({ error });
    }
    try {
      await loaded;
    } finally {
      progress.destroy();
      load.progress = null;
    }
    return this.#documentFor(browser, "Navigation");
  }

  #agentTabResult(client, document) {
    const handle = uuid();
    client.handle = { ...document, token: handle };
    client.controls = null;
    if (client.agentTab) {
      client.agentTab.requestId = null;
    }
    return { handle, origin: document.origin };
  }

  async #navigateAgentTab(clientId, client, request, stillPending) {
    const { agentTab, owner, handle } = client;
    const url = request.url.length <= 4096 && this.#navigationURL(request.url);
    if (
      !url ||
      !agentTab ||
      !owner?.notification ||
      handle?.token !== request.tab ||
      owner.browser !== handle.browser ||
      !this.#checkedDocument(handle, "Navigation")
    ) {
      return null;
    }

    owner.navigating = true;
    agentTab.requestId = request.id;
    client.handle = null;
    try {
      const document = await this.#loadTab(agentTab, url);
      if (
        !stillPending() ||
        agentTab.blocked ||
        !document ||
        owner.box.currentNotification !== owner.notification ||
        !this.#checkedDocument(document, "Navigation")
      ) {
        return null;
      }
      Object.assign(owner, document);
      return this.#agentTabResult(client, document);
    } finally {
      owner.navigating = false;
      if (
        agentTab.requestId !== null &&
        this.#clients.get(clientId) === client
      ) {
        this.#forget(clientId, true);
      }
    }
  }

  #cancelAttachedLoad(client) {
    const load = client.attachedLoad;
    if (!load) {
      return;
    }
    load.cancelled = true;
    load.channel?.cancel(Cr.NS_ERROR_BLOCKED_BY_POLICY);
    if (load.progress?.isStarted) {
      load.progress.stop({
        error: new Error("Enterprise MCP navigation cancelled"),
      });
    }
  }

  async #navigateExistingTab(clientId, client, request, stillPending) {
    const handle = client.handle;
    const url = request.url.length <= 4096 && this.#navigationURL(request.url);
    if (
      !url ||
      handle?.token !== request.tab ||
      !this.#checkedDocument(handle, "Navigation") ||
      this.#cancelledLoads.has(handle.browser) ||
      client.attachedLoad ||
      !this.#foreground(handle.browser) ||
      handle.browser.hasAttribute("tabDialogShowing") ||
      !(await this.#indicate(clientId, client, handle, "Navigation")) ||
      !stillPending() ||
      !this.#foreground(handle.browser) ||
      !this.#checkedDocument(handle, "Navigation")
    ) {
      return null;
    }
    const { owner } = client;
    if (owner.box.currentNotification !== owner.notification) {
      return null;
    }
    const { browser } = owner;
    const { gBrowser } = browser.documentGlobal;
    const tab = gBrowser.getTabForBrowser(browser);
    const context = browser.browsingContext;
    const principal = Services.scriptSecurityManager.createNullPrincipal(
      context.originAttributes
    );
    const load = { browser, principal, requestId: request.id };
    const clearGuard = () => {
      load.unguard();
      this.#cancelledLoads.delete(browser);
      tab.removeEventListener("TabClose", clearGuard);
    };
    load.unguard = guardTab(
      context.browserId,
      channel => {
        load.channel = channel;
        const allowed =
          stillPending() &&
          !load.cancelled &&
          !!this.#navigationURL(channel.URI.spec);
        load.blocked ||= !allowed;
        if (load.cancelled) {
          Services.tm.dispatchToMainThread(clearGuard);
        }
        return allowed;
      },
      info => info.triggeringPrincipal?.equals(principal)
    );
    tab.addEventListener("TabClose", clearGuard);
    client.attachedLoad = load;
    client.handle = null;
    owner.navigating = true;
    let completed = false;
    try {
      const document = await this.#loadTab(load, url);
      if (
        !stillPending() ||
        load.blocked ||
        !document ||
        !this.#foreground(browser) ||
        owner.box.currentNotification !== owner.notification ||
        !this.#checkedDocument(document, "Navigation") ||
        !(
          load.channel?.URI.equalsExceptRef(document.global.documentURI) ||
          (document.global === handle.global &&
            browser.currentURI.equals(Services.io.newURI(url.href)))
        )
      ) {
        return null;
      }
      completed = true;
      this.#releaseInteraction(owner);
      Object.assign(owner, document, { category: "Navigation" });
      return this.#agentTabResult(client, document);
    } finally {
      owner.navigating = false;
      client.attachedLoad = null;
      if (!load.cancelled || load.channel || !tab.isConnected) {
        clearGuard();
      } else {
        this.#cancelledLoads.add(browser);
      }
      if (!completed && stillPending()) {
        this.#forget(clientId, true);
      }
    }
  }

  #loadingFromInteraction(owner) {
    return (
      owner.effect &&
      owner.browser.webProgress?.isLoadingDocument &&
      owner.browser.browsingContext?.currentWindowGlobal === owner.global
    );
  }

  #restrictInteraction(owner) {
    if (owner.effect) {
      return;
    }
    const { browser, global } = owner;
    const effect = { global, documentId: global.innerWindowId };
    effect.unguard = guardTab(
      browser.browsingContext.browserId,
      channel => {
        effect.channel = channel;
        return (
          !effect.cancelled &&
          this.#owners.get(browser) === owner &&
          !!this.#navigationURL(channel.URI.spec)
        );
      },
      info =>
        info.triggeringWindowId === effect.documentId &&
        !info.hasValidUserGestureActivation
    );
    owner.effect = effect;
  }

  #releaseInteraction(owner) {
    const { effect } = owner;
    if (!effect) {
      return;
    }
    owner.effect = null;
    effect.cancelled = true;
    if (owner.browser.browsingContext?.currentWindowGlobal === effect.global) {
      effect.channel?.cancel(Cr.NS_ERROR_BLOCKED_BY_POLICY);
    }
    try {
      const actor = effect.global.getExistingActor("EnterpriseMCP");
      if (actor) {
        actor
          .sendQuery("EnterpriseMCP:Release", effect.documentId)
          .finally(effect.unguard)
          .catch(() => {});
        return;
      }
    } catch {}
    effect.unguard();
  }

  async #interact(clientId, client, request, stillPending) {
    const document = client.handle;
    const existingTab = !client.agentTab;
    if (
      document?.token !== request.tab ||
      !this.#checkedDocument(document, "Interact") ||
      !(await this.#indicate(clientId, client, document, "Interact"))
    ) {
      return null;
    }
    const owner = client.owner;
    const check = () =>
      stillPending() &&
      document?.token === request.tab &&
      owner?.browser === document.browser &&
      owner.box.currentNotification === owner.notification &&
      !!owner.notification &&
      this.#checkedDocument(document, "Interact") &&
      !document.browser.hasAttribute("tabDialogShowing");

    if (!check()) {
      return null;
    }

    const actor = document.global.getActor("EnterpriseMCP");
    const scope = {
      origin: document.origin,
      documentId: document.global.innerWindowId,
    };
    const { id } = request;
    if (request.operation === "list_elements") {
      client.controls = null;
      const elements = await actor.sendQuery(
        "EnterpriseMCP:ListElements",
        scope
      );
      if (Array.isArray(elements) && check()) {
        client.controls = new Set(elements.map(element => element.handle));
        return { event: "elements", id, elements };
      }
      return null;
    }

    if (!client.controls?.has(request.element)) {
      return null;
    }
    const ticket = uuid();
    const approval = {
      check: () => {
        if (!check()) {
          return false;
        }
        if (existingTab) {
          this.#restrictInteraction(owner);
        }
        return true;
      },
      global: document.global,
      authorized: false,
    };
    this.#tickets.set(ticket, approval);
    try {
      const acted = await actor.sendQuery("EnterpriseMCP:Interact", {
        ...scope,
        ticket,
        existingTab,
        element: request.element,
        action: request.action,
      });
      if (acted && approval.authorized && check()) {
        return { event: "interacted", id };
      }
    } finally {
      this.#tickets.delete(ticket);
    }
    return null;
  }

  #foreground(browser) {
    const window = browser?.documentGlobal;
    return (
      !!window &&
      !window.fullScreen &&
      !window.document.fullscreenElement &&
      window.gBrowser?.selectedBrowser === browser
    );
  }

  #discover(browser) {
    if (!this.#foreground(browser)) {
      return null;
    }
    if (this.#capabilities.read_page) {
      const document = this.#documentFor(browser);
      if (document) {
        return document;
      }
    }
    for (const [tool, category] of [
      ["interact", "Interact"],
      ["navigation", "Navigation"],
    ]) {
      if (this.#capabilities[tool]) {
        const document = this.#documentFor(browser, category);
        if (document) {
          return document;
        }
      }
    }
    return null;
  }

  async #run(clientId, request, generation) {
    const { id, operation } = request;
    let category = "read_page";
    if (operation === "open_tab" || operation === "navigate_tab") {
      category = "navigation";
    } else if (operation === "list_elements" || operation === "interact") {
      category = "interact";
    }
    const client = this.#clients.get(clientId);
    if (!client) {
      this.#forget(clientId, true);
      return;
    }
    client.pending = request;
    let response = { event: "denied", id };
    let origin = "";
    const stillPending = () =>
      generation === this.#generation &&
      this.#clients.get(clientId) === client &&
      client.pending === request &&
      !!currentConsole();
    try {
      if (stillPending() && category === "navigation") {
        let tab;
        if (operation === "open_tab") {
          tab = await this.#openTab(clientId, client, request, stillPending);
        } else if (client.agentTab) {
          tab = await this.#navigateAgentTab(
            clientId,
            client,
            request,
            stillPending
          );
        } else {
          tab = await this.#navigateExistingTab(
            clientId,
            client,
            request,
            stillPending
          );
        }
        if (tab) {
          origin = tab.origin;
          response = { event: "tab_opened", id, tab };
        }
      } else if (
        stillPending() &&
        category === "interact" &&
        this.#capabilities.interact
      ) {
        origin = client.handle?.origin ?? "";
        response =
          (await this.#interact(clientId, client, request, stillPending)) ??
          response;
      } else if (stillPending() && operation === "list_tabs") {
        const browser =
          Services.wm.getMostRecentWindow("navigator:browser")?.gBrowser
            ?.selectedBrowser;
        const document = this.#discover(browser);
        const owner = this.#owners.get(browser);
        const tabs = [];
        client.controls = null;
        if (document && (!owner || owner === client.owner)) {
          client.handle = { ...document, token: uuid() };
          origin = document.origin;
          tabs.push({ handle: client.handle.token, origin });
        } else {
          client.handle = null;
        }
        response = { event: "tabs", id, tabs };
      } else if (
        stillPending() &&
        operation === "read_page" &&
        this.#capabilities.read_page
      ) {
        const document = client.handle;
        if (
          document?.token === request.tab &&
          this.#checkedDocument(document)
        ) {
          origin = document.origin;
          if (
            (await this.#indicate(clientId, client, document)) &&
            stillPending() &&
            this.#checkedDocument(document)
          ) {
            const actor = document.global.getActor("EnterpriseMCP");
            const page = await actor.sendQuery("EnterpriseMCP:Read", {
              origin,
              documentId: document.global.innerWindowId,
            });
            if (
              page &&
              stillPending() &&
              this.#checkedDocument(document) &&
              client.owner.box.currentNotification === client.owner.notification
            ) {
              response = { event: "page", id, page };
            }
          }
        }
      }

      if (stillPending()) {
        Glean.enterpriseMcp.operation.record({
          session: client.auditId,
          category,
          operation,
          origin,
          decision: response.event === "denied" ? "deny" : "allow",
        });
        this.#transport.reply(clientId, JSON.stringify(response));
      }
    } catch {
      if (stillPending()) {
        try {
          this.#transport.reply(
            clientId,
            JSON.stringify({ event: "denied", id })
          );
        } catch {
          this.#forget(clientId, true);
        }
      }
    } finally {
      if (client.pending === request) {
        client.pending = null;
      }
    }
  }
})();
