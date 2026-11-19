/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  setInterval,
  clearInterval,
} from "resource://gre/modules/Timer.sys.mjs";
import { compilePolicy } from "./EnterpriseMCPPolicy.sys.mjs";

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
  return (
    !(analysis in Cc) ||
    !Cc[analysis].getService(Ci.nsIContentAnalysis).isActive
  );
}

export const EnterpriseMCP = new (class {
  #policy = null;
  #transport = null;
  #timer = null;
  #generation = 0;
  #clients = new Map();
  #owners = new Map();
  #stoppedBrowsers = new WeakSet();
  #initialized = false;
  #listening = false;

  apply(policy) {
    this.remove();
    const compiled = compilePolicy(policy);
    if (
      compiled.clientAccess !== "LocalUser" ||
      !compiled.hasReadGrant ||
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
      ChromeUtils.unregisterWindowActor("EnterpriseMCP");
      for (const topic of MANAGED_TOPICS) {
        Services.obs.removeObserver(this, topic);
      }
    }
  }

  observe(_subject, topic) {
    if (topic === "EnterprisePolicies:PolicyUpdatesApplied") {
      this.#reset();
    } else {
      this.remove();
    }
  }

  #reset() {
    this.#generation++;
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
      this.#owners.delete(browser);
      unwatch();
      if (notification?.isConnected) {
        box.removeNotification(notification, true);
      }
    }
    if (disconnect) {
      this.#transport?.disconnect(id);
    }
  }

  #poll() {
    try {
      if (!currentConsole() || !canExportPage()) {
        if (this.#listening) {
          this.#reset();
        }
        return;
      }
      if (!this.#listening) {
        this.#transport.start();
        this.#listening = true;
      }
      for (const [id, client] of this.#clients) {
        if (
          client.owner &&
          (!this.#checkedDocument(client.owner) ||
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
        if (type === "disconnected") {
          this.#forget(client);
        } else if (request.operation === "cancel") {
          const state = this.#clients.get(client);
          if (state?.pending === request.id) {
            state.pending = null;
          }
        } else {
          this.#run(client, request, generation);
        }
      }
    } catch {
      this.#reset();
    }
  }

  #documentFor(browser) {
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
      window.fullScreen ||
      window.document.fullscreenElement ||
      window.gBrowser?.selectedBrowser !== browser ||
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
      !context.isActive ||
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
      !this.#policy?.grants(url, "ReadPage") ||
      !canExportPage()
    ) {
      return null;
    }
    return { browser, global, origin };
  }

  #checkedDocument(document) {
    const current = this.#documentFor(document.browser);
    return (
      current?.global === document.global && current.origin === document.origin
    );
  }

  async #indicate(clientId, client, document) {
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
          progress.isTopLevel &&
          flags & STATE_START &&
          flags & STATE_IS_DOCUMENT
        ) {
          this.#forget(clientId, true);
        }
      },
      onLocationChange: (changedBrowser, progress) => {
        if (changedBrowser === browser && progress.isTopLevel) {
          this.#forget(clientId, true);
        }
      },
    };
    const tabChanged = () => {
      if (!this.#checkedDocument(document)) {
        this.#forget(clientId, true);
      }
    };
    gBrowser.addTabsProgressListener(watch);
    gBrowser.tabContainer.addEventListener("TabSelect", tabChanged);
    const box = gBrowser.getNotificationBox(browser);
    const owner = {
      ...document,
      box,
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
      this.#stoppedBrowsers.add(browser);
      this.#forget(clientId, true);
      this.#offerReattachment(browser, box);
    };
    const notification = await box.appendNotification(
      "enterprise-mcp-active",
      {
        label: { "l10n-id": "enterprise-mcp-active" },
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

  async #run(clientId, request, generation) {
    const { id, operation } = request;
    let client = this.#clients.get(clientId);
    if (!client) {
      client = { auditId: uuid(), handle: null, pending: null, owner: null };
      this.#clients.set(clientId, client);
    }
    client.pending = id;
    let response = { event: "denied", id };
    let origin = "";
    const stillPending = () =>
      generation === this.#generation &&
      this.#clients.get(clientId) === client &&
      client.pending === id &&
      !!currentConsole();
    try {
      if (stillPending() && operation === "list_tabs") {
        const browser =
          Services.wm.getMostRecentWindow("navigator:browser")?.gBrowser
            ?.selectedBrowser;
        const document = this.#documentFor(browser);
        const owner = this.#owners.get(browser);
        const tabs = [];
        if (document && (!owner || owner === client.owner)) {
          client.handle = { ...document, token: uuid() };
          origin = document.origin;
          tabs.push({ handle: client.handle.token, origin });
        } else {
          client.handle = null;
        }
        response = { event: "tabs", id, tabs };
      } else if (stillPending() && operation === "read_page") {
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
          category: "read_page",
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
      if (client.pending === id) {
        client.pending = null;
      }
    }
  }
})();
