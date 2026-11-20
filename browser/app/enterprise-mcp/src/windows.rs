/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::{
    ffi::c_void,
    io::{self, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        GetLastError, LocalFree, SetLastError, ERROR_ALREADY_EXISTS, ERROR_BROKEN_PIPE,
        ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, GENERIC_READ, GENERIC_WRITE,
        HANDLE, INVALID_HANDLE_VALUE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, SetNamedPipeHandleState, PIPE_NOWAIT,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES,
        },
        Threading::{
            CreateMutexW, GetCurrentProcess, OpenProcess, OpenProcessToken,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn process_sid(process: HANDLE) -> io::Result<String> {
    let mut token = null_mut();
    check(unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) })?;
    let token = owned(token)?;
    let mut size = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
    if size == 0 || size > 65536 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut user = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            user.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    })?;
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut string = null_mut();
    check(unsafe { ConvertSidToStringSidW(sid, &mut string) })?;
    let _allocation = LocalAllocation(string.cast());
    let length = (0..)
        .take_while(|i| unsafe { *string.add(*i) } != 0)
        .count();
    String::from_utf16(unsafe { std::slice::from_raw_parts(string, length) })
        .map_err(|_| io::ErrorKind::InvalidData.into())
}

fn pipe_name(sid: &str) -> Vec<u16> {
    wide(&format!(r"\\.\pipe\FirefoxEnterpriseMCP-{sid}"))
}

fn peer(handle: HANDLE, server_side: bool, expected_sid: &str) -> io::Result<u32> {
    let mut pid = 0;
    check(unsafe {
        if server_side {
            GetNamedPipeClientProcessId(handle, &mut pid)
        } else {
            GetNamedPipeServerProcessId(handle, &mut pid)
        }
    })?;
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    if process_sid(process.as_raw_handle())? != expected_sid {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(pid)
}

struct Pipe {
    handle: OwnedHandle,
    closed: AtomicBool,
}

pub struct Stream {
    pipe: Arc<Pipe>,
    peer_pid: u32,
    blocking: bool,
}

impl Stream {
    fn new(handle: OwnedHandle, peer_pid: u32, blocking: bool) -> Self {
        Self {
            pipe: Arc::new(Pipe {
                handle,
                closed: AtomicBool::new(false),
            }),
            peer_pid,
            blocking,
        }
    }

    pub fn peer_pid(&self) -> io::Result<u32> {
        Ok(self.peer_pid)
    }

    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            pipe: self.pipe.clone(),
            peer_pid: self.peer_pid,
            blocking: self.blocking,
        })
    }

    pub fn close(&self) -> io::Result<()> {
        self.pipe.closed.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn transfer(
        &self,
        is_read: bool,
        mut operation: impl FnMut(HANDLE, &mut u32) -> i32,
    ) -> io::Result<usize> {
        let end = Instant::now() + Duration::from_secs(2);
        while !self.pipe.closed.load(Ordering::Relaxed) {
            let mut count = 0;
            match check(operation(self.pipe.handle.as_raw_handle(), &mut count)) {
                Ok(()) if count > 0 => return Ok(count as usize),
                Ok(()) => (),
                Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => (),
                Err(error) if is_read && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => {
                    return Ok(0);
                }
                Err(error) => return Err(error),
            }
            if !self.blocking {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            if !is_read && Instant::now() >= end {
                return Err(io::ErrorKind::TimedOut.into());
            }
            let retry_ms = if is_read { 100 } else { 10 };
            thread::sleep(Duration::from_millis(retry_ms));
        }
        Err(io::ErrorKind::NotConnected.into())
    }
}

impl Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.transfer(true, |handle, count| unsafe {
            ReadFile(
                handle,
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                count,
                null_mut(),
            )
        })
    }
}

impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.transfer(false, |handle, count| unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len() as u32,
                count,
                null_mut(),
            )
        })
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct Listener {
    handle: Option<OwnedHandle>,
    sid: String,
    name: Vec<u16>,
    descriptor: LocalAllocation,
    _endpoint_lock: OwnedHandle,
}

impl Listener {
    pub fn bind() -> io::Result<Self> {
        let mut listener = Self::new()?;
        listener.handle = Some(listener.instance(FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_NOWAIT)?);
        Ok(listener)
    }

    fn new() -> io::Result<Self> {
        let sid = process_sid(unsafe { GetCurrentProcess() })?;
        let name = pipe_name(&sid);
        let policy = wide(&format!("D:P(A;;GA;;;{sid})"));
        let mut descriptor = null_mut();
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                policy.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        })?;
        let descriptor = LocalAllocation(descriptor);
        let mut security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let mutex_name = wide(&format!(r"Global\FirefoxEnterpriseMCP-{sid}"));
        unsafe { SetLastError(0) };
        let handle = unsafe { CreateMutexW(&mut security, 0, mutex_name.as_ptr()) };
        let status = unsafe { GetLastError() };
        let endpoint_lock = owned(handle)?;
        if status == ERROR_ALREADY_EXISTS {
            return Err(io::ErrorKind::AddrInUse.into());
        }
        Ok(Self {
            handle: None,
            sid,
            name,
            descriptor,
            _endpoint_lock: endpoint_lock,
        })
    }

    fn instance(&self, flags: u32, mode: u32) -> io::Result<OwnedHandle> {
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        };
        owned(unsafe {
            CreateNamedPipeW(
                self.name.as_ptr(),
                PIPE_ACCESS_DUPLEX | flags,
                mode | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                65536,
                16384,
                0,
                &security,
            )
        })
    }

    pub fn accept(&mut self) -> io::Result<Stream> {
        let handle = self.handle.as_ref().ok_or(io::ErrorKind::NotConnected)?;
        let raw = handle.as_raw_handle();
        if let Err(error) = check(unsafe { ConnectNamedPipe(raw, null_mut()) }) {
            match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_PIPE_CONNECTED) => (),
                Some(ERROR_PIPE_LISTENING) => return Err(io::ErrorKind::WouldBlock.into()),
                Some(ERROR_NO_DATA) => {
                    self.handle = Some(self.instance(0, PIPE_NOWAIT)?);
                    return Err(io::ErrorKind::WouldBlock.into());
                }
                _ => return Err(error),
            }
        }
        let next = self.instance(0, PIPE_NOWAIT)?;
        let connected = self.handle.replace(next).unwrap();
        let pid = peer(connected.as_raw_handle(), true, &self.sid)?;
        Ok(Stream::new(connected, pid, false))
    }
}

#[cfg(feature = "browser-transport")]
pub(crate) use mio::windows::NamedPipe as BrowserStream;

#[cfg(feature = "browser-transport")]
pub(crate) struct BrowserListener {
    endpoint: Listener,
    pipe: BrowserStream,
}

#[cfg(feature = "browser-transport")]
impl BrowserListener {
    fn pipe(
        endpoint: &Listener,
        flags: u32,
        registry: &mio::Registry,
        token: mio::Token,
    ) -> io::Result<BrowserStream> {
        use std::os::windows::io::IntoRawHandle;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;

        let handle = endpoint.instance(FILE_FLAG_OVERLAPPED | flags, 0)?;
        let mut pipe = unsafe { BrowserStream::from_raw_handle(handle.into_raw_handle()) };
        registry.register(&mut pipe, token, mio::Interest::READABLE)?;
        match pipe.connect() {
            Ok(()) => Ok(pipe),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(pipe),
            Err(error) => Err(error),
        }
    }

    pub fn bind(registry: &mio::Registry, token: mio::Token) -> io::Result<Self> {
        let endpoint = Listener::new()?;
        let pipe = Self::pipe(&endpoint, FILE_FLAG_FIRST_PIPE_INSTANCE, registry, token)?;
        Ok(Self { endpoint, pipe })
    }

    pub fn accept(
        &mut self,
        registry: &mio::Registry,
        listener_token: mio::Token,
        client_token: mio::Token,
    ) -> io::Result<(BrowserStream, u32)> {
        let error = self.pipe.take_error()?;
        let replacement = Self::pipe(&self.endpoint, 0, registry, listener_token)?;
        let mut connected = std::mem::replace(&mut self.pipe, replacement);
        if error.is_some() {
            return Err(io::ErrorKind::ConnectionAborted.into());
        }
        let pid = peer(connected.as_raw_handle(), true, &self.endpoint.sid)
            .map_err(|_| io::ErrorKind::PermissionDenied)?;
        registry.reregister(&mut connected, client_token, mio::Interest::READABLE)?;
        Ok((connected, pid))
    }
}

pub fn connect() -> io::Result<Stream> {
    let sid = process_sid(unsafe { GetCurrentProcess() })?;
    let name = pipe_name(&sid);
    let handle = owned(unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            SECURITY_IDENTIFICATION | SECURITY_SQOS_PRESENT,
            null_mut(),
        )
    })?;
    let pid = peer(handle.as_raw_handle(), false, &sid)?;
    check(unsafe {
        SetNamedPipeHandleState(handle.as_raw_handle(), &PIPE_NOWAIT, null(), null())
    })?;
    Ok(Stream::new(handle, pid, true))
}

#[cfg(any(feature = "browser-transport", test))]
pub(crate) fn process(pid: u32) -> io::Result<(std::path::PathBuf, u32)> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
    use windows_sys::Win32::System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::QueryFullProcessImageNameW,
    };

    let handle = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    check(unsafe {
        QueryFullProcessImageNameW(handle.as_raw_handle(), 0, path.as_mut_ptr(), &mut length)
    })?;
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    check(unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) })?;
    loop {
        if entry.th32ProcessID == pid && entry.th32ParentProcessID != 0 {
            return Ok((
                PathBuf::from(OsString::from_wide(&path[..length as usize])),
                entry.th32ParentProcessID,
            ));
        }
        check(unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) })?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_pipe_exchanges_bytes_and_attests_peers() {
        let mut listener = Listener::bind().unwrap();
        assert!(Listener::bind().is_err());
        let mut client = connect().unwrap();
        let mut server = listener.accept().unwrap();
        assert_eq!(client.peer_pid().unwrap(), std::process::id());
        assert_eq!(server.peer_pid().unwrap(), std::process::id());
        client.write_all(b"hello").unwrap();
        let mut received = [0; 5];
        server.read_exact(&mut received).unwrap();
        assert_eq!(&received, b"hello");

        #[cfg(feature = "browser-transport")]
        {
            drop(server);
            drop(client);
            drop(listener);
            let mut poll = mio::Poll::new().unwrap();
            let mut events = mio::Events::with_capacity(8);
            let accept = mio::Token(1);
            let readable = mio::Token(2);
            let mut listener = BrowserListener::bind(poll.registry(), accept).unwrap();
            let mut client = connect().unwrap();
            let timeout = Duration::from_secs(2);
            poll.poll(&mut events, Some(timeout)).unwrap();
            assert!(events.iter().any(|event| event.token() == accept));
            let (mut server, pid) = listener.accept(poll.registry(), accept, readable).unwrap();
            assert_eq!(pid, std::process::id());
            client.write_all(b"hello").unwrap();
            let deadline = Instant::now() + timeout;
            let mut bytes = Vec::new();
            while bytes.len() < 5 && Instant::now() < deadline {
                poll.poll(
                    &mut events,
                    Some(deadline.saturating_duration_since(Instant::now())),
                )
                .unwrap();
                let mut buffer = [0; 5];
                match server.read(&mut buffer) {
                    Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => panic!("Overlapped read failed: {error}"),
                }
            }
            assert_eq!(bytes, b"hello");
        }
    }
}
