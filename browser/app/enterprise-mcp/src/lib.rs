/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};

#[cfg(all(
    any(target_os = "linux", target_os = "macos", windows),
    any(feature = "gecko", test)
))]
mod applications;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod local;
#[cfg(windows)]
#[path = "windows.rs"]
pub mod local;
#[cfg(all(
    any(target_os = "linux", target_os = "macos", windows),
    feature = "gecko"
))]
mod xpcom_service;

pub const MAX_REQUEST: usize = 16 * 1024;
pub const MAX_RESPONSE: usize = 128 * 1024;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub read_page: bool,
    pub navigation: bool,
    pub interact: bool,
    pub network_metadata: bool,
    pub console_summary: bool,
    pub screenshot: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Authenticate {
        key_id: String,
        signature: String,
    },
    ListTabs {
        id: u32,
    },
    ReadPage {
        id: u32,
        tab: String,
    },
    OpenTab {
        id: u32,
        url: String,
    },
    NavigateTab {
        id: u32,
        tab: String,
        url: String,
    },
    ListElements {
        id: u32,
        tab: String,
    },
    Interact {
        id: u32,
        tab: String,
        element: String,
        action: Action,
    },
    NetworkMetadata {
        id: u32,
        tab: String,
    },
    ConsoleSummary {
        id: u32,
        tab: String,
    },
    Screenshot {
        id: u32,
        tab: String,
    },
    Cancel {
        id: u32,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Challenge {
        payload: String,
    },
    Ready {
        capabilities: Capabilities,
    },
    Tabs {
        id: u32,
        tabs: Vec<Tab>,
    },
    Page {
        id: u32,
        page: Page,
    },
    TabOpened {
        id: u32,
        tab: Tab,
    },
    Elements {
        id: u32,
        elements: Vec<Control>,
    },
    Interacted {
        id: u32,
    },
    NetworkMetadata {
        id: u32,
        requests: Vec<NetworkRequest>,
    },
    ConsoleSummary {
        id: u32,
        counts: ConsoleCounts,
    },
    Screenshot {
        id: u32,
        image: String,
    },
    Denied {
        id: u32,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tab {
    pub handle: String,
    pub origin: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub text: String,
    pub elements: Vec<Element>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Element {
    pub kind: ElementKind,
    pub text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementKind {
    Button,
    Heading,
    Link,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Click {},
    Fill { value: String },
    Select { index: u32 },
    Scroll { x: i16, y: i16 },
    Submit {},
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub handle: String,
    pub kind: ControlKind,
    pub text: String,
    pub options: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlKind {
    Button,
    Input,
    Select,
    Submit,
    Scroll,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkRequest {
    pub method: HttpMethod,
    pub status: u16,
    pub duration_ms: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Other,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConsoleCounts {
    pub debug: u32,
    pub info: u32,
    pub warn: u32,
    pub error: u32,
}

pub fn read_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    loop {
        let data = reader.fill_buf()?;
        if data.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(io::ErrorKind::UnexpectedEof.into())
            };
        }
        let newline = data.iter().position(|&byte| byte == b'\n');
        let count = newline.map_or(data.len(), |index| index + 1);
        if bytes.len() + count > limit {
            return Err(io::ErrorKind::InvalidData.into());
        }
        bytes.extend_from_slice(&data[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(bytes));
        }
    }
}

pub fn encode(message: &impl Serialize, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(bytes)
}
