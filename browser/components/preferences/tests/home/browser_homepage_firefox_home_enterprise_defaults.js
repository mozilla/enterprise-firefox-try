/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Enterprise builds ship with sponsored content and curated stories disabled and
// the backing prefs locked off (see the MOZ_ENTERPRISE block in firefox.js).

add_task(
  async function test_enterprise_home_preferences_reflect_locked_defaults() {
    let { win, tab } = await openHomePreferences();

    info("The Support Firefox toggle is unchecked and disabled");
    // and Sponsored top sites have no visibility gate, so they
    // stay visible but are locked off (disabled and unchecked).
    let supportFirefox = await settingControlRenders("supportFirefox", win);
    ok(BrowserTestUtils.isVisible(supportFirefox), "Support Firefox is shown");
    ok(supportFirefox.disabled, "Support Firefox is disabled (locked)");
    is(supportFirefox.value, false, "Support Firefox is off");

    info("The Sponsored Shortcuts toggle is unchecked and disabled");
    let sponsoredShortcuts = await settingControlRenders(
      "sponsoredShortcuts",
      win
    );
    ok(sponsoredShortcuts.disabled, "Sponsored top sites is disabled (locked)");
    is(sponsoredShortcuts.value, false, "Sponsored top sites is off");

    // Stories and Sponsored stories are gated on
    // browser.newtabpage.activity-stream.feeds.system.topstories,
    // which is locked off, so they are not rendered.
    let stories = getSettingControl("stories", win);
    ok(
      !stories || !BrowserTestUtils.isVisible(stories),
      "Stories setting is not shown"
    );

    let sponsoredStories = getSettingControl("sponsoredStories", win);
    ok(
      !sponsoredStories || !BrowserTestUtils.isVisible(sponsoredStories),
      "Sponsored stories setting is not shown"
    );

    BrowserTestUtils.removeTab(tab);
  }
);
