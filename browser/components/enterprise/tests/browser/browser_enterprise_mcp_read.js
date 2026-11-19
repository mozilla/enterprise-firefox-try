/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ACTOR_PATH = "moz-src:///browser/components/enterprise/mcp/";
const ORIGIN = "https://example.com";

function page(origin, html) {
  return `${origin}/document-builder.sjs?html=${encodeURIComponent(html)}`;
}

add_setup(function () {
  ChromeUtils.registerWindowActor("EnterpriseMCP", {
    parent: { esModuleURI: ACTOR_PATH + "EnterpriseMCPParent.sys.mjs" },
    child: { esModuleURI: ACTOR_PATH + "EnterpriseMCPChild.sys.mjs" },
    matches: ["https://example.com/*"],
    remoteTypes: ["web"],
    safeForUntrustedWebProcess: true,
    allFrames: false,
  });
  registerCleanupFunction(() => {
    ChromeUtils.unregisterWindowActor("EnterpriseMCP");
  });
});

add_task(async function test_read_is_document_scoped() {
  const frame = page("https://example.org", "<p>cross-origin text</p>");
  const url = page(
    ORIGIN,
    `<h1>Example report</h1>
     <div hidden>hidden text</div>
     <div style="color: transparent">transparent text</div>
     <div style="opacity: 0">transparent element</div>
     <input type="password" value="password value">
     <div contenteditable>editor value</div>
     <iframe src="${frame}"></iframe>`
  );

  await BrowserTestUtils.withNewTab(url, async browser => {
    const global = browser.browsingContext.currentWindowGlobal;
    const actor = global.getActor("EnterpriseMCP");
    const context = { documentId: global.innerWindowId, origin: ORIGIN };

    Assert.equal(
      await actor.sendQuery("EnterpriseMCP:Read", {
        ...context,
        documentId: context.documentId + 1,
      }),
      null,
      "A mismatched document generation cannot read the page"
    );

    Assert.equal(
      await actor.sendQuery("EnterpriseMCP:Read", {
        ...context,
        origin: "https://example.org",
      }),
      null,
      "A mismatched origin cannot read the page"
    );

    const result = await actor.sendQuery("EnterpriseMCP:Read", context);
    Assert.equal(result.text, "Example report");
    Assert.deepEqual(result.elements, [
      { kind: "heading", text: "Example report" },
    ]);

    const loaded = BrowserTestUtils.browserLoaded(
      browser,
      false,
      page(ORIGIN, "<p>Replacement</p>")
    );
    BrowserTestUtils.startLoadingURIString(
      browser,
      page(ORIGIN, "<p>Replacement</p>")
    );
    await loaded;
    const replacement = browser.browsingContext.currentWindowGlobal;
    Assert.notEqual(replacement.innerWindowId, context.documentId);
    Assert.equal(
      await replacement
        .getActor("EnterpriseMCP")
        .sendQuery("EnterpriseMCP:Read", context),
      null,
      "A replacement document cannot use the old generation"
    );
  });
});
