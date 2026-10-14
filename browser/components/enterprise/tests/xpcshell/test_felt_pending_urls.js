/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests the stored copy of the external URL queue. It mirrors the queue so an
// app restart can carry it over, and only a launch that is itself a restart
// reads it back.

// Imported lazily so FeltStorage doesn't resolve its "UAppData"-based path
// before makeFakeAppDir() runs below.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeltStorage: "resource://gre/modules/enterprise/FeltStorage.sys.mjs",
  FELT_OPEN_WINDOW_DISPOSITION: "resource:///modules/FeltURLHandler.sys.mjs",
  gFeltPendingURLs: "resource:///modules/FeltURLHandler.sys.mjs",
});

const { makeFakeAppDir } = ChromeUtils.importESModule(
  "resource://testing-common/AppData.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const MAX_AGE_MS = 30 * 60 * 1000;

function url(spec, disposition) {
  return {
    url: spec,
    disposition: disposition ?? lazy.FELT_OPEN_WINDOW_DISPOSITION.DEFAULT,
  };
}

/** The raw value FeltStorage holds, bypassing the public accessors. */
function storedQueue() {
  return lazy.FeltStorage._feltStorage.data.pendingURLs;
}

function plantStoredQueue(value) {
  lazy.FeltStorage._feltStorage.data.pendingURLs = value;
}

async function queue(...payloads) {
  for (const payload of payloads) {
    lazy.gFeltPendingURLs.push(payload);
  }
  await lazy.gFeltPendingURLs._writes;
}

/**
 * Stands in for the next launch.
 *
 * @param {object} options
 * @param {boolean} options.restarted Whether it follows an in-app restart.
 * @returns {Promise<Array<object>>} The queue that launch starts with.
 */
async function relaunch({ restarted }) {
  Services.env.set("MOZ_APP_RESTART", restarted ? "1" : "");
  lazy.gFeltPendingURLs._pendingURLs = [];
  lazy.gFeltPendingURLs._ready = false;
  lazy.gFeltPendingURLs._initPromise = null;
  await lazy.gFeltPendingURLs.init();
  await lazy.gFeltPendingURLs._writes;
  return [...lazy.gFeltPendingURLs];
}

add_setup(async function () {
  do_get_profile();
  await makeFakeAppDir();
  await lazy.FeltStorage.init();

  // The queue is only mirrored to disk in the Felt UI process.
  const felt = Services.felt;
  Object.defineProperty(Services, "felt", {
    configurable: true,
    value: { isFeltUI: () => true },
  });

  // Reversible stand-ins so the tests can assert both that the queue is
  // encrypted on the way in and recovered on the way out, without a real
  // keystore. OSKeyStore.decrypt hands back a binary string, so the fake
  // mirrors that too.
  sinon
    .stub(OSKeyStore, "encrypt")
    .callsFake(async plaintext => `enc(${plaintext})`);
  sinon
    .stub(OSKeyStore, "decrypt")
    .callsFake(async ciphertext =>
      unescape(encodeURIComponent(ciphertext.replace(/^enc\((.*)\)$/s, "$1")))
    );

  registerCleanupFunction(() => {
    sinon.restore();
    Object.defineProperty(Services, "felt", {
      configurable: true,
      value: felt,
    });
    Services.env.set("MOZ_APP_RESTART", "");
  });
});

add_task(async function test_nothing_stored_restores_nothing() {
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a restart with nothing stored starts empty"
  );
});

add_task(async function test_queue_is_stored_encrypted() {
  await relaunch({ restarted: false });
  await queue(url("https://example.com/a"));

  Assert.ok(
    storedQueue().startsWith("enc("),
    "the queue is stored as the keystore wrote it, not as plain JSON"
  );
});

add_task(async function test_restart_carries_the_queue_over() {
  await relaunch({ restarted: false });
  await queue(
    url("https://example.com/a"),
    url("https://example.com/b", lazy.FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW)
  );

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [
      url("https://example.com/a"),
      url(
        "https://example.com/b",
        lazy.FELT_OPEN_WINDOW_DISPOSITION.NEW_WINDOW
      ),
    ],
    "both URLs come back in the order they were queued"
  );
  Assert.notStrictEqual(
    storedQueue(),
    undefined,
    "the restored queue is stored again, so a second restart also carries it"
  );
  Assert.equal(
    (await relaunch({ restarted: true })).length,
    2,
    "a second restart carries the queue as well"
  );
});

add_task(async function test_cold_start_discards_the_queue() {
  await relaunch({ restarted: false });
  await queue(url("https://example.com/cold-start"));

  Assert.deepEqual(
    await relaunch({ restarted: false }),
    [],
    "a launch that is not a restart does not reopen queued URLs"
  );
  Assert.equal(
    storedQueue(),
    undefined,
    "and the stored copy is dropped rather than left for a later restart"
  );
});

add_task(async function test_draining_the_queue_clears_the_stored_copy() {
  await relaunch({ restarted: false });
  await queue(url("https://example.com/drained"));

  lazy.gFeltPendingURLs.clear();
  await lazy.gFeltPendingURLs._writes;

  Assert.equal(
    storedQueue(),
    undefined,
    "URLs that have been forwarded are no longer stored"
  );
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "so a restart has nothing to reopen"
  );
});

add_task(async function test_restored_urls_precede_newly_queued_ones() {
  await relaunch({ restarted: false });
  await queue(url("https://example.com/before-restart"));

  Services.env.set("MOZ_APP_RESTART", "1");
  lazy.gFeltPendingURLs._pendingURLs = [];
  lazy.gFeltPendingURLs._ready = false;
  lazy.gFeltPendingURLs._initPromise = null;
  // Arrives on the command line before init() finishes, as it would on a launch
  // that is handed a URL straight away.
  lazy.gFeltPendingURLs.push(url("https://example.com/after-restart"));
  await lazy.gFeltPendingURLs.init();

  Assert.deepEqual(
    [...lazy.gFeltPendingURLs].map(entry => entry.url),
    ["https://example.com/before-restart", "https://example.com/after-restart"],
    "the restored URL is opened ahead of the one that arrived after it"
  );
});

add_task(async function test_stale_stored_queue_is_discarded() {
  await relaunch({ restarted: false });
  plantStoredQueue(
    `enc(${JSON.stringify({
      version: 1,
      createdAt: Date.now() - MAX_AGE_MS - 1000,
      urls: [url("https://example.com/stale")],
    })})`
  );

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a queue past its age cap is dropped"
  );
  Assert.equal(storedQueue(), undefined, "and it is still consumed");
});

add_task(async function test_future_dated_stored_queue_is_discarded() {
  await relaunch({ restarted: false });
  plantStoredQueue(
    `enc(${JSON.stringify({
      version: 1,
      createdAt: Date.now() + MAX_AGE_MS,
      urls: [url("https://example.com/future")],
    })})`
  );

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a future-dated queue is dropped"
  );
});

add_task(async function test_unknown_version_is_discarded() {
  await relaunch({ restarted: false });
  plantStoredQueue(
    `enc(${JSON.stringify({
      version: 2,
      createdAt: Date.now(),
      urls: [url("https://example.com/v2")],
    })})`
  );

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "an unrecognized version is dropped"
  );
});

add_task(async function test_unreadable_stored_queue_is_discarded() {
  await relaunch({ restarted: false });
  // What a file-write primitive alone could leave behind: it is not something
  // the keystore wrote, so it must be dropped rather than opened.
  plantStoredQueue(
    JSON.stringify({ urls: [url("https://example.com/planted")] })
  );

  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "a value the keystore did not write is dropped"
  );
  Assert.equal(
    storedQueue(),
    undefined,
    "and it is consumed rather than retried on every launch"
  );
});

add_task(async function test_restored_urls_are_sanitized() {
  await relaunch({ restarted: false });
  plantStoredQueue(
    `enc(${JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      urls: [
        url("chrome://browser/content/browser.xhtml"),
        url("https://example.com/kept"),
        url("not a url at all"),
      ],
    })})`
  );

  Assert.deepEqual(
    (await relaunch({ restarted: true })).map(entry => entry.url),
    ["https://example.com/kept"],
    "chrome: and unparseable URLs do not survive being restored"
  );
});

add_task(async function test_signout_drops_the_stored_queue() {
  await relaunch({ restarted: false });
  await queue(url("https://example.com/signed-out"));

  await lazy.FeltStorage.endSession();

  Assert.equal(
    storedQueue(),
    undefined,
    "ending the session removes the stored queue"
  );
  Assert.deepEqual(
    await relaunch({ restarted: true }),
    [],
    "URLs queued by the session that ended are not reopened"
  );
});
