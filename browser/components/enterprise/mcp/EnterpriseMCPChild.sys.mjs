/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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

/** Reads eligible text from the actor's top-level document. */
export class EnterpriseMCPChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    const window = this.contentWindow;
    const document = window?.document;
    const principal = document?.nodePrincipal;
    if (
      name !== "EnterpriseMCP:Read" ||
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
