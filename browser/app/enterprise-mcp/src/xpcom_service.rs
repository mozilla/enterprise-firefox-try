/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::applications::{ApplicationAllowlist, ApplicationPolicy};
use crate::{
    encode,
    local::{BrowserListener, BrowserStream},
    Event, Request, MAX_REQUEST, MAX_RESPONSE,
};
#[cfg(unix)]
use mio::Interest;
use mio::{Events, Poll, Registry, Token, Waker};
use nserror::{nsresult, NS_ERROR_FAILURE, NS_ERROR_INVALID_ARG, NS_ERROR_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc, Mutex,
    },
};
use xpcom::{xpcom, xpcom_method};

const MAX_CONNECTIONS: usize = 8;
const MAX_QUEUED: usize = 64;
const WAKE: Token = Token(0);
const LISTENER: Token = Token(1);
const TRANSPORT_READY: &std::ffi::CStr = c"enterprise-mcp-transport-ready";

#[derive(PartialEq)]
enum Admission {
    AwaitingChallenge,
    AwaitingProof,
    Verifying,
    Admitted,
}

struct Client {
    stream: BrowserStream,
    input: Vec<u8>,
    output: Vec<u8>,
    pending: Option<u32>,
    admission: Admission,
}

impl Client {
    fn flush(&mut self) -> io::Result<()> {
        while !self.output.is_empty() {
            match self.stream.write(&self.output) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    self.output.drain(..count);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn receive(&mut self) -> io::Result<Option<Request>> {
        for _ in 0..MAX_QUEUED {
            let newline = loop {
                if let Some(newline) = self.input.iter().position(|&byte| byte == b'\n') {
                    break newline;
                }
                let mut bytes = [0; 4096];
                let available = (MAX_REQUEST - self.input.len()).min(bytes.len());
                if available == 0 {
                    return Err(io::ErrorKind::InvalidData.into());
                }
                match self.stream.read(&mut bytes[..available]) {
                    Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                    Ok(count) => self.input.extend_from_slice(&bytes[..count]),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            };
            let request: Request = serde_json::from_slice(&self.input[..newline])?;
            if !request.is_valid() {
                return Err(io::ErrorKind::InvalidData.into());
            }
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
                    continue;
                }
                Request::ListTabs { id }
                | Request::ReadPage { id, .. }
                | Request::Wait { id, .. }
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
            return Ok(Some(request));
        }
        Err(io::ErrorKind::InvalidData.into())
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
    ApplicationRejected,
    Failed {
        operation: &'static str,
        error: String,
    },
    Disconnected {
        client: u32,
    },
}

impl Incoming {
    fn failed(operation: &'static str, error: io::Error) -> Self {
        Self::Failed {
            operation,
            error: error.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    capabilities: crate::Capabilities,
    application_policy: Option<ApplicationPolicy>,
}

enum Command {
    Challenge(u32, Vec<u8>),
    Admit(u32),
    Reply(u32, u32, Vec<u8>),
    Disconnect(u32),
}

type Inbox = Arc<Mutex<Vec<Incoming>>>;

struct Worker {
    commands: SyncSender<Command>,
    wake: Arc<Waker>,
    stopping: Arc<AtomicBool>,
    inbox: Inbox,
}

impl Worker {
    fn send(&self, command: Command) -> Result<(), nsresult> {
        self.commands
            .try_send(command)
            .map_err(|_| NS_ERROR_NOT_AVAILABLE)?;
        self.wake.wake().map_err(|_| NS_ERROR_FAILURE)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.wake.wake();
    }
}

fn publish(
    inbox: &Inbox,
    main: &xpcom::interfaces::nsIThread,
    generation: u32,
    incoming: Vec<Incoming>,
) -> io::Result<()> {
    if incoming.is_empty() {
        return Ok(());
    }
    let mut queue = inbox.lock().unwrap();
    let notify = queue.is_empty();
    let overflow = queue.len() + incoming.len() > MAX_QUEUED;
    if overflow {
        queue.clear();
        queue.push(Incoming::Failed {
            operation: "queue browser events",
            error: "Transport event queue is full".into(),
        });
    } else {
        queue.extend(incoming);
    }
    drop(queue);
    if notify {
        moz_task::RunnableBuilder::new("EnterpriseMCP::TransportReady", move || {
            if let Ok(observer) =
                xpcom::components::Observer::service::<xpcom::interfaces::nsIObserverService>()
            {
                let data = nsstring::nsString::from(generation.to_string().as_str());
                unsafe {
                    observer.NotifyObservers(
                        std::ptr::null(),
                        TRANSPORT_READY.as_ptr(),
                        data.as_ptr(),
                    );
                }
            }
        })
        .options(moz_task::DispatchOptions::new().fallible(true))
        .dispatch(main.coerce())
        .map_err(|_| io::ErrorKind::BrokenPipe)?;
    }
    if overflow {
        return Err(io::ErrorKind::OutOfMemory.into());
    }
    Ok(())
}

struct Server {
    listener: BrowserListener,
    clients: BTreeMap<u32, Client>,
    last_client: u32,
    ready: Vec<u8>,
    require_proof: bool,
    applications: Option<ApplicationAllowlist>,
}

fn client_token(id: u32) -> Token {
    Token((id as usize) + 2)
}

impl Server {
    fn accept(&mut self, registry: &Registry, incoming: &mut Vec<Incoming>) -> io::Result<bool> {
        for _ in 0..MAX_QUEUED {
            let id = self
                .last_client
                .checked_add(1)
                .ok_or(io::ErrorKind::Other)?;
            let keep = self.clients.len() < MAX_CONNECTIONS;
            match self.listener.accept(registry, LISTENER, client_token(id)) {
                Ok((mut stream, pid)) if keep => {
                    let application = self
                        .applications
                        .as_ref()
                        .and_then(|applications| applications.approve(pid));
                    if self.applications.is_some() && application.is_none() {
                        incoming.push(Incoming::ApplicationRejected);
                    } else {
                        self.last_client = id;
                        let (admission, output) = if self.require_proof {
                            (Admission::AwaitingChallenge, Vec::new())
                        } else {
                            (Admission::Admitted, self.ready.clone())
                        };
                        #[cfg(unix)]
                        registry.register(
                            &mut stream,
                            client_token(id),
                            Interest::READABLE.add(Interest::WRITABLE),
                        )?;
                        #[cfg(windows)]
                        let _ = &mut stream;
                        incoming.push(Incoming::Connected {
                            client: id,
                            pid,
                            application: application.map(str::to_owned),
                        });
                        self.clients.insert(
                            id,
                            Client {
                                stream,
                                input: Vec::new(),
                                output,
                                pending: None,
                                admission,
                            },
                        );
                        self.service_client(registry, id, incoming);
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::PermissionDenied | io::ErrorKind::ConnectionAborted
                    ) => {}
                Err(error) => return Err(error),
            }
            if cfg!(windows) {
                return Ok(false);
            }
            if incoming.len() >= MAX_QUEUED {
                return Ok(true);
            }
        }
        Ok(true)
    }

    fn service_client(&mut self, registry: &Registry, id: u32, incoming: &mut Vec<Incoming>) {
        let Some(client) = self.clients.get_mut(&id) else {
            return;
        };
        let result = (|| -> io::Result<()> {
            client.flush()?;
            for _ in 0..MAX_QUEUED {
                let Some(request) = client.receive()? else {
                    return Ok(());
                };
                incoming.push(Incoming::Request {
                    client: id,
                    request,
                });
            }
            Err(io::ErrorKind::InvalidData.into())
        })();
        if result.is_err() {
            self.disconnect(registry, id, incoming);
        }
    }

    fn disconnect(&mut self, registry: &Registry, id: u32, incoming: &mut Vec<Incoming>) {
        if let Some(mut client) = self.clients.remove(&id) {
            let _ = registry.deregister(&mut client.stream);
            #[cfg(windows)]
            let _ = client.stream.disconnect();
            incoming.push(Incoming::Disconnected { client: id });
        }
    }

    fn command(&mut self, registry: &Registry, command: Command, incoming: &mut Vec<Incoming>) {
        let id = match &command {
            Command::Challenge(id, _) | Command::Admit(id) | Command::Reply(id, ..) => *id,
            Command::Disconnect(id) => {
                self.disconnect(registry, *id, incoming);
                return;
            }
        };
        let Some(client) = self.clients.get_mut(&id) else {
            return;
        };
        match command {
            Command::Challenge(_, frame) if client.admission == Admission::AwaitingChallenge => {
                client.output.extend_from_slice(&frame);
                client.admission = Admission::AwaitingProof;
            }
            Command::Admit(_) if client.admission == Admission::Verifying => {
                client.output.extend_from_slice(&self.ready);
                client.admission = Admission::Admitted;
            }
            Command::Reply(_, request, frame) if client.pending == Some(request) => {
                client.output.extend_from_slice(&frame);
                client.pending = None;
            }
            _ => return,
        }
        self.service_client(registry, id, incoming);
    }

    fn run(
        mut self,
        poll: &mut Poll,
        commands: Receiver<Command>,
        stopping: &AtomicBool,
        mut publish: impl FnMut(Vec<Incoming>) -> io::Result<()>,
    ) -> Result<(), Incoming> {
        let mut events = Events::with_capacity(MAX_CONNECTIONS * 2 + 2);
        let mut more_work = false;
        let mut more_connections = false;
        loop {
            let timeout = (more_work || more_connections).then_some(std::time::Duration::ZERO);
            if let Err(error) = poll.poll(&mut events, timeout) {
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(Incoming::failed("poll listener", error));
            }
            if stopping.load(Ordering::Acquire) {
                return Ok(());
            }
            let registry = poll.registry();
            let mut incoming = Vec::new();
            more_work = true;
            for _ in 0..MAX_QUEUED {
                match commands.try_recv() {
                    Ok(command) => self.command(registry, command, &mut incoming),
                    Err(TryRecvError::Empty) => {
                        more_work = false;
                        break;
                    }

                    Err(TryRecvError::Disconnected) => return Ok(()),
                }
            }
            for event in events.iter() {
                match event.token() {
                    WAKE | LISTENER => {}
                    Token(token) => {
                        self.service_client(registry, (token - 2) as u32, &mut incoming)
                    }
                }
            }
            if more_connections || events.iter().any(|event| event.token() == LISTENER) {
                more_connections = self
                    .accept(registry, &mut incoming)
                    .map_err(|error| Incoming::failed("accept connection", error))?;
            }
            publish(incoming).map_err(|error| Incoming::failed("publish browser events", error))?;
        }
    }
}

#[cfg(windows)]
impl Drop for Server {
    fn drop(&mut self) {
        for client in self.clients.values() {
            let _ = client.stream.disconnect();
        }
    }
}

#[xpcom(implement(nsIEnterpriseMCPTransport), nonatomic)]
struct EnterpriseMCPTransport {
    worker: RefCell<Option<Worker>>,
}

#[allow(non_snake_case)]
impl EnterpriseMCPTransport {
    xpcom_method!(start => Start(settings: *const nsACString, require_proof: bool, generation: u32));
    fn start(
        &self,
        settings: &nsACString,
        require_proof: bool,
        generation: u32,
    ) -> Result<(), nsresult> {
        let Settings {
            capabilities,
            application_policy,
        } = serde_json::from_slice(settings).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let mut worker = self.worker.borrow_mut();
        if worker.is_some() {
            return Err(NS_ERROR_FAILURE);
        }
        let ready =
            encode(&Event::Ready { capabilities }, MAX_RESPONSE).map_err(|_| NS_ERROR_FAILURE)?;
        let main = moz_task::get_main_thread()?;
        let mut poll = Poll::new().map_err(|_| NS_ERROR_FAILURE)?;
        let wake = Arc::new(Waker::new(poll.registry(), WAKE).map_err(|_| NS_ERROR_FAILURE)?);
        let worker_wake = wake.clone();
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let (sender, receiver) = mpsc::sync_channel(MAX_QUEUED);
        let inbox = Arc::new(Mutex::new(Vec::new()));
        let incoming = inbox.clone();
        std::thread::Builder::new()
            .name("EnterpriseMCP".into())
            .spawn(move || {
                let _wake = worker_wake;
                let publish = |events| publish(&incoming, &main, generation, events);
                let result = (|| {
                    let applications = application_policy
                        .map(ApplicationAllowlist::new)
                        .transpose()
                        .map_err(|error| Incoming::failed("load allowed applications", error))?;
                    let server = Server {
                        listener: BrowserListener::bind(poll.registry(), LISTENER)
                            .map_err(|error| Incoming::failed("bind listener", error))?,
                        clients: BTreeMap::new(),
                        last_client: 0,
                        ready,
                        require_proof,
                        applications,
                    };
                    // Drop the Windows pipes before the poller drains their IOCP completions.
                    server.run(&mut poll, receiver, &worker_stopping, publish)
                })();
                if let Err(failure) = result {
                    let _ = publish(vec![failure]);
                }
            })
            .map_err(|_| NS_ERROR_FAILURE)?;
        *worker = Some(Worker {
            commands: sender,
            wake,
            stopping,
            inbox,
        });
        Ok(())
    }

    fn send(&self, command: Command) -> Result<(), nsresult> {
        self.worker
            .borrow()
            .as_ref()
            .ok_or(NS_ERROR_NOT_AVAILABLE)?
            .send(command)
    }

    xpcom_method!(challenge => Challenge(client: u32, payload: *const nsACString));
    fn challenge(&self, client: u32, payload: &nsACString) -> Result<(), nsresult> {
        let payload = std::str::from_utf8(payload).map_err(|_| NS_ERROR_INVALID_ARG)?;
        let frame = encode(
            &Event::Challenge {
                payload: payload.to_owned(),
            },
            MAX_RESPONSE,
        )
        .map_err(|_| NS_ERROR_INVALID_ARG)?;
        self.send(Command::Challenge(client, frame))
    }

    xpcom_method!(admit => Admit(client: u32));
    fn admit(&self, client: u32) -> Result<(), nsresult> {
        self.send(Command::Admit(client))
    }

    xpcom_method!(stop => Stop());
    fn stop(&self) -> Result<(), nsresult> {
        self.worker.take();
        Ok(())
    }

    xpcom_method!(drain => Drain() -> nsACString);
    fn drain(&self) -> Result<nsCString, nsresult> {
        let worker = self.worker.borrow();
        let worker = worker.as_ref().ok_or(NS_ERROR_NOT_AVAILABLE)?;
        let incoming = std::mem::take(&mut *worker.inbox.lock().unwrap());
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
            | Event::Waited { id, .. }
            | Event::TabOpened { id, .. }
            | Event::Elements { id, .. }
            | Event::Interacted { id, .. }
            | Event::NetworkMetadata { id, .. }
            | Event::ConsoleSummary { id, .. }
            | Event::Screenshot { id, .. }
            | Event::Denied { id } => id,
        };
        let frame = encode(&event, MAX_RESPONSE).map_err(|_| NS_ERROR_INVALID_ARG)?;
        self.send(Command::Reply(client, id, frame))
    }

    xpcom_method!(disconnect => Disconnect(client: u32));
    fn disconnect(&self, client: u32) -> Result<(), nsresult> {
        self.send(Command::Disconnect(client))
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn enterprise_mcp_transport_constructor(
    iid: *const xpcom::nsIID,
    result: *mut *mut std::ffi::c_void,
) -> nsresult {
    let transport = EnterpriseMCPTransport::allocate(InitEnterpriseMCPTransport {
        worker: RefCell::new(None),
    });
    unsafe { transport.QueryInterface(iid, result) }
}
