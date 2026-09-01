/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shim module for Downloads Telemetry.
 *
 * This module provides a stable import path for downloads telemetry functionality.
 * The actual implementation is conditionally provided at build time:
 * - In MOZ_ENTERPRISE builds: Full enterprise telemetry implementation
 * - In regular builds: No-op implementation (enterprise code completely absent)
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

let DownloadsTelemetryImpl;

// The enterprise module is only packaged in MOZ_ENTERPRISE builds. Gate on
// AppConstants rather than catching an import failure: in automation, loading a
// missing chrome/moz-src URL aborts via CheckForBrokenChromeURL before any
// exception can be caught.
if (AppConstants.MOZ_ENTERPRISE) {
  const { DownloadsTelemetryEnterprise } = ChromeUtils.importESModule(
    "moz-src:///browser/components/downloads/DownloadsTelemetry.enterprise.sys.mjs"
  );
  DownloadsTelemetryImpl = DownloadsTelemetryEnterprise;
} else {
  DownloadsTelemetryImpl = {
    recordFileDownloaded: _download => {},
  };
}

export const DownloadsTelemetry = DownloadsTelemetryImpl;
