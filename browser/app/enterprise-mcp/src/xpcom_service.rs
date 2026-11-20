/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::applications::{ApplicationAllowlist, ApplicationPolicy};
use crate::{
    encode,
    local::{Listener, Stream},
    Event, Request, MAX_REQUEST, MAX_RESPONSE,
};
use nserror::{nsresult, NS_ERROR_FAILURE, NS_ERROR_INVALID_ARG, NS_ERROR_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, Read, Write},
};
use xpcom::{xpcom, xpcom_method};

const MAX_CONNECTIONS: usize = 8;

#[derive(PartialEq)]
enum Admission {
    AwaitingChallenge,
    AwaitingProof,
    Verifying,
    Admitted,
}

struct Client {
    stream: Stream,
    input: Vec<u8>,
    output: Vec<u8>,
    pending: Option<u32>,
    admission: Admission,
}

impl Client {
    fn flush(&mut self) -> io::Result<()> {
        if !self.output.is_empty() {
            match self.stream.write(&self.output) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    self.output.drain(..count);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn receive(&mut self) -> io::Result<Option<Request>> {
        let mut bytes = [0; 4096];
        match self.stream.read(&mut bytes) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => self.input.extend_from_slice(&bytes[..count]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
            Err(error) => return Err(error),
        }

        let Some(newline) = self.input.iter().position(|&byte| byte == b'\n') else {
            if self.input.len() >= MAX_REQUEST {
                return Err(io::ErrorKind::InvalidData.into());
            }
            return Ok(None);
        };
        if newline >= MAX_REQUEST {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let request = serde_json::from_slice(&self.input[..newline])?;
        self.input.drain(..=newline);

        if self.admission == Admission::AwaitingProof && self.output.is_empty() {
            if matches!(&request, Request::Authenticate { .. }) {
                self.admission = Admission::Verifying;
                return Ok(Some(request));
            }
        }
        if self.admission != Admission::Admitted {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        match &request {
            Request::Authenticate { .. } => return Err(io::ErrorKind::PermissionDenied.into()),
            Request::Cancel { id } => {
                if self.pending == Some(*id) {
                    self.pending = None;
                    return Ok(Some(request));
                }
                return Ok(None);
            }
            Request::ListTabs { id }
            | Request::ReadPage { id, .. }
            | Request::OpenTab { id, .. }
            | Request::NavigateTab { id, .. }
            | Request::ListElements { id, .. }
            | Request::Interact { id, .. }
            | Request::NetworkMetadata { id, .. }
            | Request::ConsoleSummary { id, .. }
            | Request::Screenshot { id, .. } => {
                if self.pending.is_some() || !self.output.is_empty() {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                self.pending = Some(*id);
            }
        }
        Ok(Some(request))
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Incoming {
    Connected {
        client: u32,
        pid: u32,
        application: Option<String>,
    },
    Request {
        client: u32,
        request: Request,
    },
    Disconnected {
        client: u32,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    capabilities: crate::Capabilities,
    application_policy: Option<ApplicationPolicy>,
}

struct Server {
    listener: Listener,
    clients: BTreeMap<u32, Client>,
    last_client: u32,
    ready: Vec<u8>,
    require_proof: bool,
    applications: Option<ApplicationAllowlist>,
}

impl Server {
    fn poll(&mut self) -> io::Result<Vec<Incoming>> {
        let mut incoming = Vec::new();
        if self.clients.len() < MAX_CONNECTIONS {
            if let Ok(stream) = self.listener.accept() {
                let pid = stream.peer_pid()?;
                let application = self
                    .applications
                    .as_ref()
                    .and_then(|applications| applications.approve(pid));
                if self.applications.is_none() || application.is_some() {
                    self.last_client = self
                        .last_client
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("MCP identifier exhausted"))?;
                    let (admission, output) = if self.require_proof {
                        (Admission::AwaitingChallenge, Vec::new())
                    } else {
                        (Admission::Admitted, self.ready.clone())
                    };
                    incoming.push(Incoming::Connected {
                        client: self.last_client,
                        pid,
                        application: application.map(str::to_owned),
                    });
                    self.clients.insert(
                        self.last_client,
                        Client {
                            stream,
                            input: Vec::new(),
                            output,
                            pending: None,
                            admission,
                        },
                    );
                }
            }
        }

        self.clients.retain(|&client, connection| {
            match connection.flush().and_then(|()| connection.receive()) {
                Ok(Some(request)) => incoming.push(Incoming::Request { client, request }),
                Ok(None) => (),
                Err(_) => {
                    incoming.push(Incoming::Disconnected { client });
                    return false;
                }
            }
            true
        });
        Ok(incoming)
    }
}

#[xpcom(implement(nsIEnterpriseMCPTransport), nonatomic)]
struct EnterpriseMCPTransport {
    server: RefCell<Option<Server>>,
}

#[allow(non_snake_case)]
impl EnterpriseMCPTransport {
    xpcom_method!(start => Start(settings: *const nsACString, require_proof: bool));
    fn start(&self, settings: &nsACString, require_proof: bool) -> Result<(), nsresult> {
        let Settings {
            capabilities,
            application_policy,
        } = serde_json::from_slice(settings).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let applications = application_policy
            .map(ApplicationAllowlist::new)
            .transpose()
            .map_err(|_| NS_ERROR_INVALID_ARG)?;
        let mut server = self.server.borrow_mut();
        if server.is_none() {
            *server = Some(Server {
                listener: Listener::bind().map_err(|_| NS_ERROR_FAILURE)?,
                clients: BTreeMap::new(),
                last_client: 0,
                require_proof,
                applications,
                ready: encode(&Event::Ready { capabilities }, MAX_RESPONSE)
                    .map_err(|_| NS_ERROR_FAILURE)?,
            });
        }
        Ok(())
    }

    xpcom_method!(challenge => Challenge(client: u32, payload: *const nsACString));
    fn challenge(&self, client: u32, payload: &nsACString) -> Result<(), nsresult> {
        let payload = std::str::from_utf8(payload).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let mut server = self.server.borrow_mut();
        let connection = server
            .as_mut()
            .and_then(|server| server.clients.get_mut(&client))
            .filter(|connection| connection.admission == Admission::AwaitingChallenge)
            .ok_or(NS_ERROR_NOT_AVAILABLE)?;
        connection.output = encode(
            &Event::Challenge {
                payload: payload.to_owned(),
            },
            MAX_RESPONSE,
        )
        .map_err(|_| NS_ERROR_INVALID_ARG)?;
        connection.admission = Admission::AwaitingProof;
        Ok(())
    }

    xpcom_method!(admit => Admit(client: u32));
    fn admit(&self, client: u32) -> Result<(), nsresult> {
        let mut server = self.server.borrow_mut();
        let server = server.as_mut().ok_or(NS_ERROR_NOT_AVAILABLE)?;
        let connection = server
            .clients
            .get_mut(&client)
            .filter(|connection| connection.admission == Admission::Verifying)
            .ok_or(NS_ERROR_NOT_AVAILABLE)?;
        connection.output = server.ready.clone();
        connection.admission = Admission::Admitted;
        Ok(())
    }

    xpcom_method!(stop => Stop());
    fn stop(&self) -> Result<(), nsresult> {
        self.server.take();
        Ok(())
    }

    xpcom_method!(poll => Poll() -> nsACString);
    fn poll(&self) -> Result<nsCString, nsresult> {
        let incoming = self
            .server
            .borrow_mut()
            .as_mut()
            .ok_or(NS_ERROR_NOT_AVAILABLE)?
            .poll()
            .map_err(|_| NS_ERROR_FAILURE)?;
        let json = serde_json::to_string(&incoming).map_err(|_| NS_ERROR_FAILURE)?;
        Ok(nsCString::from(json.as_str()))
    }

    xpcom_method!(reply => Reply(client: u32, payload: *const nsACString));
    fn reply(&self, client: u32, payload: &nsACString) -> Result<(), nsresult> {
        let event: Event = serde_json::from_slice(payload).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let id = match event {
            Event::Ready { .. } | Event::Challenge { .. } => return Err(NS_ERROR_INVALID_ARG),
            Event::Tabs { id, .. }
            | Event::Page { id, .. }
            | Event::TabOpened { id, .. }
            | Event::Elements { id, .. }
            | Event::Interacted { id }
            | Event::NetworkMetadata { id, .. }
            | Event::ConsoleSummary { id, .. }
            | Event::Screenshot { id, .. }
            | Event::Denied { id } => id,
        };
        let mut server = self.server.borrow_mut();
        let clients = &mut server.as_mut().ok_or(NS_ERROR_NOT_AVAILABLE)?.clients;
        let connection = clients.get_mut(&client).ok_or(NS_ERROR_NOT_AVAILABLE)?;
        if connection.pending != Some(id) {
            return Err(NS_ERROR_NOT_AVAILABLE);
        }
        connection.output = encode(&event, MAX_RESPONSE).map_err(|_| NS_ERROR_INVALID_ARG)?;
        connection.pending = None;
        if connection.flush().is_err() {
            clients.remove(&client);
            return Err(NS_ERROR_NOT_AVAILABLE);
        }
        Ok(())
    }

    xpcom_method!(disconnect => Disconnect(client: u32));
    fn disconnect(&self, client: u32) -> Result<(), nsresult> {
        if let Some(server) = self.server.borrow_mut().as_mut() {
            server.clients.remove(&client);
        }
        Ok(())
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn enterprise_mcp_transport_constructor(
    iid: *const xpcom::nsIID,
    result: *mut *mut std::ffi::c_void,
) -> nsresult {
    let transport = EnterpriseMCPTransport::allocate(InitEnterpriseMCPTransport {
        server: RefCell::new(None),
    });
    unsafe { transport.QueryInterface(iid, result) }
}
