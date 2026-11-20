/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::{
    encode,
    local::{Listener, Stream},
    Event, Request, MAX_REQUEST, MAX_RESPONSE,
};
use nserror::{nsresult, NS_ERROR_FAILURE, NS_ERROR_INVALID_ARG, NS_ERROR_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, Read, Write},
};
use xpcom::{xpcom, xpcom_method};

const MAX_CONNECTIONS: usize = 8;

struct Client {
    stream: Stream,
    input: Vec<u8>,
    output: Vec<u8>,
    pending: Option<u32>,
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

        match &request {
            Request::Cancel { id } => {
                if self.pending == Some(*id) {
                    self.pending = None;
                    return Ok(Some(request));
                }
                return Ok(None);
            }
            Request::ListTabs { id } | Request::ReadPage { id, .. } => {
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
    Request { client: u32, request: Request },
    Disconnected { client: u32 },
}

struct Server {
    listener: Listener,
    clients: BTreeMap<u32, Client>,
    last_client: u32,
}

impl Server {
    fn poll(&mut self) -> io::Result<Vec<Incoming>> {
        if let Ok(stream) = self.listener.accept() {
            if self.clients.len() < MAX_CONNECTIONS {
                self.last_client = self
                    .last_client
                    .checked_add(1)
                    .ok_or_else(|| io::Error::other("MCP identifier exhausted"))?;
                self.clients.insert(
                    self.last_client,
                    Client {
                        stream,
                        input: Vec::new(),
                        output: encode(&Event::Ready, MAX_RESPONSE)?,
                        pending: None,
                    },
                );
            }
        }

        let mut incoming = Vec::new();
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
    xpcom_method!(start => Start());
    fn start(&self) -> Result<(), nsresult> {
        let mut server = self.server.borrow_mut();
        if server.is_none() {
            *server = Some(Server {
                listener: Listener::bind().map_err(|_| NS_ERROR_FAILURE)?,
                clients: BTreeMap::new(),
                last_client: 0,
            });
        }
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
            Event::Ready => return Err(NS_ERROR_INVALID_ARG),
            Event::Tabs { id, .. } | Event::Page { id, .. } | Event::Denied { id } => id,
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
