/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { dom } from "chrome://remote/content/shared/DOM.sys.mjs";

const MAX_NODES = 2000;
const MAX_TEXT = 8000;
const MAX_ELEMENTS = 64;
const PROTECTED =
  "input, textarea, select, [contenteditable], [hidden], [inert]";
const SEMANTIC_ELEMENTS =
  "a[href], button, h1, h2, h3, h4, h5, h6, [role=link], [role=button], [role=heading]";

function visibleText(window, document, node) {
  const parent = node.parentElement;
  if (
    !parent ||
    parent.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    parent.closest(PROTECTED) ||
    parent.isContentEditable ||
    !parent.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    })
  ) {
    return "";
  }

  const style = window.getComputedStyle(parent);
  const fillColor = style.getPropertyValue("-webkit-text-fill-color");
  const color =
    !fillColor || fillColor === "currentcolor" ? style.color : fillColor;
  if (!InspectorUtils.colorToRGBA(color)?.a) {
    return "";
  }

  const range = document.createRange();
  range.selectNodeContents(node);
  const bounds = range.getClientRects();
  if (!bounds.length || bounds.length > 50) {
    return "";
  }

  for (const rect of bounds) {
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.left < 0 ||
      rect.top < 0 ||
      rect.right > window.innerWidth ||
      rect.bottom > window.innerHeight
    ) {
      return "";
    }
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    if (hit !== parent) {
      return "";
    }
  }
  return node.data.trim();
}

const CONTROL_SELECTOR = "button, input, textarea, select, [tabindex]";
const MAX_OPTIONS = 32;
const MAX_CONTROL_LABEL = 128;
const PROTECTED_AUTOCOMPLETE =
  /(?:^|\s)(?:username|(?:current|new)-password|one-time-code|cc-\S+|webauthn)(?:\s|$)/i;
const FILL_TYPES = new Set(["email", "search", "tel", "text", "url"]);

function protectedControl(element) {
  const isInput = element.localName === "input";
  return (
    element.closest("[hidden], [inert], [contenteditable]") ||
    element.isContentEditable ||
    (isInput && (element.hasBeenTypePassword || element.type === "file")) ||
    PROTECTED_AUTOCOMPLETE.test(element.getAttribute("autocomplete") ?? "")
  );
}

function safeSubmit(element, document) {
  const form = element.form;
  if (
    !form ||
    form.elements.length > 128 ||
    Array.from(form.elements).some(protectedControl) ||
    form.querySelector("input[type=file], input[type=password]")
  ) {
    return false;
  }
  const target =
    element.getAttribute("formtarget") ??
    form.getAttribute("target") ??
    document.querySelector("base[target]")?.getAttribute("target");
  const method = element.getAttribute("formmethod") ?? form.method;
  const url = URL.parse(
    element.getAttribute("formaction") !== null
      ? element.formAction
      : form.action
  );
  return (
    (!target || target.toLowerCase() === "_self") &&
    ["get", "post"].includes(method.toLowerCase()) &&
    url?.origin === document.nodePrincipal.originNoSuffix &&
    !url.username &&
    !url.password
  );
}

function controlKind(document, element) {
  if (
    element.ownerDocument !== document ||
    !element.isConnected ||
    element.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    protectedControl(element) ||
    element.matches(":disabled") ||
    element.closest("[aria-disabled=true]") ||
    !element.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    })
  ) {
    return null;
  }

  const [hit] = dom.getPointerInteractablePaintTree(element);
  if (!element.contains(hit)) {
    return null;
  }

  if (element.localName === "button" || element.localName === "input") {
    if (element.type === "submit" && safeSubmit(element, document)) {
      return "submit";
    }
    if (
      element.type === "button" &&
      !element.hasAttribute("commandfor") &&
      !element.closest("label")
    ) {
      return "button";
    }
  }
  if (
    (element.localName === "textarea" ||
      (element.localName === "input" && FILL_TYPES.has(element.type))) &&
    !element.readOnly
  ) {
    return "input";
  }
  if (element.localName === "select") {
    return !element.multiple && element.options.length <= MAX_OPTIONS
      ? "select"
      : null;
  }
  if (
    (element === document.scrollingElement ||
      element.hasAttribute("tabindex")) &&
    (element.scrollHeight > element.clientHeight ||
      element.scrollWidth > element.clientWidth)
  ) {
    return "scroll";
  }
  return null;
}

function shortLabel(text) {
  return text.trim().slice(0, MAX_CONTROL_LABEL).toWellFormed();
}

function controlLabel(window, document, element) {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel !== null) {
    return shortLabel(ariaLabel);
  }
  const source =
    element.labels?.[0] ?? (element.localName === "button" ? element : null);
  if (!source) {
    return "";
  }
  const walker = document.createTreeWalker(
    source,
    window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT
  );
  let text = "";
  for (let count = 0; count < 128 && text.length < MAX_CONTROL_LABEL; count++) {
    const node = walker.nextNode();
    if (!node) {
      break;
    }
    if (node.nodeType === window.Node.TEXT_NODE && node.length <= MAX_TEXT) {
      const value = visibleText(window, document, node);
      if (value) {
        text += " " + value;
      }
    }
  }
  return shortLabel(text);
}

/** Reads and interacts with the actor's top-level document. */
export class EnterpriseMCPChild extends JSWindowActorChild {
  #controls = new Map();
  #restrictedDocument = null;

  didDestroy() {
    this.#release();
  }

  #release() {
    this.#restrictedDocument?.setEnterpriseMCPRestrictions(false);
    this.#restrictedDocument = null;
    this.#controls.clear();
  }

  receiveMessage({ name, data }) {
    if (name === "EnterpriseMCP:Release") {
      if (this.manager.innerWindowId === data) {
        this.#release();
      }
      return null;
    }
    const window = this.contentWindow;
    const document = window?.document;
    const principal = document?.nodePrincipal;
    if (
      this.browsingContext.parent ||
      !document?.body ||
      document.visibilityState !== "visible" ||
      document.contentType !== "text/html" ||
      !principal.isContentPrincipal ||
      principal.privateBrowsingId ||
      principal.originNoSuffix !== data.origin ||
      this.manager.innerWindowId !== data.documentId
    ) {
      return null;
    }

    switch (name) {
      case "EnterpriseMCP:Read":
        return this.#read(window, document);
      case "EnterpriseMCP:ListElements":
        return this.#list(window, document);
      case "EnterpriseMCP:Interact":
        return this.#interact(window, document, data);
      default:
        return null;
    }
  }

  #list(window, document) {
    this.#controls.clear();
    const controls = [];
    const add = element => {
      const kind = controlKind(document, element);
      if (!kind) {
        return;
      }
      const handle = Services.uuid.generateUUID().toString().slice(1, -1);
      const options = kind === "select" ? Array.from(element.options) : [];
      this.#controls.set(handle, { element, kind, options });
      controls.push({
        handle,
        kind,
        text: controlLabel(window, document, element),
        options: options.map(option =>
          option.hidden ? "" : shortLabel(option.label)
        ),
      });
    };

    if (document.scrollingElement) {
      add(document.scrollingElement);
    }
    const walker = document.createTreeWalker(
      document.body,
      window.NodeFilter.SHOW_ELEMENT
    );
    for (
      let count = 0;
      count < MAX_NODES && controls.length < MAX_ELEMENTS;
      count++
    ) {
      const element = walker.nextNode();
      if (!element) {
        break;
      }
      if (element.matches(CONTROL_SELECTOR)) {
        add(element);
      }
    }
    return controls;
  }

  #interact(
    window,
    document,
    { element: handle, action, ticket, existingTab }
  ) {
    const control = this.#controls.get(handle);
    const element = control?.element;
    const kind = element && controlKind(document, element);
    const { type } = action;
    const expected = {
      click: "button",
      fill: "input",
      select: "select",
      scroll: "scroll",
      submit: "submit",
    }[type];
    if (
      !kind ||
      expected !== kind ||
      control.kind !== kind ||
      document.hasValidTransientUserGestureActivation ||
      (type === "fill" &&
        (action.value.length > 1024 ||
          (element.maxLength >= 0 &&
            action.value.length > element.maxLength))) ||
      (type === "select" &&
        (!element.options[action.index] ||
          element.options[action.index] !== control.options[action.index] ||
          element.options[action.index].matches("[hidden], :disabled"))) ||
      (type === "scroll" &&
        (Math.abs(action.x) > 2048 || Math.abs(action.y) > 2048))
    ) {
      return false;
    }

    const [allowed] = Services.cpmm.sendSyncMessage("EnterpriseMCP:Authorize", {
      ticket,
    });
    if (
      !allowed ||
      !element.isConnected ||
      window.document !== document ||
      document.hasValidTransientUserGestureActivation
    ) {
      return false;
    }

    if (existingTab) {
      document.setEnterpriseMCPRestrictions(true);
      this.#restrictedDocument = document;
    }

    switch (type) {
      case "click":
        element.click();
        break;
      case "fill":
        element.value = action.value;
        element.dispatchEvent(
          new window.InputEvent("input", { bubbles: true })
        );
        break;
      case "select":
        element.selectedIndex = action.index;
        element.dispatchEvent(new window.Event("change", { bubbles: true }));
        break;
      case "scroll":
        element.scrollBy({
          left: action.x,
          top: action.y,
          behavior: "instant",
        });
        break;
      case "submit":
        element.form.requestSubmit(element);
        break;
    }
    return true;
  }

  #read(window, document) {
    const walker = document.createTreeWalker(
      document.body,
      window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT
    );
    const text = [];
    const semantic = new Map();
    let remaining = MAX_TEXT;
    for (let count = 0; count < MAX_NODES && remaining > 0; count++) {
      const node = walker.nextNode();
      if (!node) {
        break;
      }
      if (node.nodeType !== window.Node.TEXT_NODE || node.length > MAX_TEXT) {
        continue;
      }
      const value = visibleText(window, document, node)
        .slice(0, remaining)
        .toWellFormed();
      if (!value) {
        continue;
      }
      text.push(value);
      remaining -= value.length + 1;
      const element = node.parentElement.closest(SEMANTIC_ELEMENTS);
      if (
        !element ||
        (!semantic.has(element) && semantic.size >= MAX_ELEMENTS)
      ) {
        continue;
      }
      const role = element.getAttribute("role");
      let kind = "heading";
      if (role === "button" || element.localName === "button") {
        kind = "button";
      } else if (role === "link" || element.localName === "a") {
        kind = "link";
      }
      const label = [semantic.get(element)?.text, value]
        .filter(Boolean)
        .join(" ");
      semantic.set(element, { kind, text: label.slice(0, 256).toWellFormed() });
    }

    return { text: text.join("\n"), elements: [...semantic.values()] };
  }
}
