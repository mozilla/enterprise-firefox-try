/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod mcp;

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn main() -> std::io::Result<()> {
    mcp::run()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn main() {
    std::process::exit(1);
}
