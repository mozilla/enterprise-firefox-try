/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#[cfg(unix)]
mod mcp;

#[cfg(unix)]
fn main() -> std::io::Result<()> {
    mcp::run()
}

#[cfg(not(unix))]
fn main() {
    std::process::exit(1);
}
