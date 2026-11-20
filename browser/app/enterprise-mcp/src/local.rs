/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::{
    ffi::OsStr,
    fs::{self, DirBuilder},
    io,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn uid() -> libc::uid_t {
    unsafe { libc::geteuid() }
}

fn directory(create: bool) -> io::Result<PathBuf> {
    let path = PathBuf::from(format!("/tmp/firefox-enterprise-mcp-{}", uid()));
    if create {
        match DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
    }
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_dir() || metadata.uid() != uid() || metadata.mode() & 0o777 != 0o700 {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn peer(stream: &UnixStream) -> io::Result<(libc::uid_t, u32)> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of_val(&credentials) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((credentials.uid, credentials.pid as u32))
}

#[cfg(target_os = "macos")]
fn peer(stream: &UnixStream) -> io::Result<(libc::uid_t, u32)> {
    let fd = stream.as_raw_fd();
    let mut uid = 0;
    let mut gid = 0;
    let mut pid = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((uid, pid as u32))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn peer(_: &UnixStream) -> io::Result<(libc::uid_t, u32)> {
    Err(io::ErrorKind::Unsupported.into())
}

pub struct Stream(UnixStream);

impl Stream {
    pub fn peer_pid(&self) -> io::Result<u32> {
        peer(&self.0).map(|(_, pid)| pid)
    }

    pub fn try_clone(&self) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    pub fn close(&self) -> io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
    }
}

impl io::Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}

impl io::Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

pub struct Listener {
    listener: UnixListener,
    path: PathBuf,
}

impl Listener {
    pub fn bind() -> io::Result<Self> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?;
        let path = directory(true)?.join(format!("{}-{}", std::process::id(), stamp.as_nanos()));
        let listener = UnixListener::bind(&path)?;
        let endpoint = Self { listener, path };
        fs::set_permissions(&endpoint.path, fs::Permissions::from_mode(0o600))?;
        endpoint.listener.set_nonblocking(true)?;
        Ok(endpoint)
    }

    pub fn accept(&mut self) -> io::Result<Stream> {
        let (stream, _) = self.listener.accept()?;
        let (user, _) = peer(&stream)?;
        if user != uid() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        stream.set_nonblocking(true)?;
        Ok(Stream(stream))
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn connect_endpoint(path: &Path, pid: u32) -> io::Result<UnixStream> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != uid()
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let stream = UnixStream::connect(path)?;
    if peer(&stream)? != (uid(), pid) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    Ok(stream)
}

fn endpoint_pid(name: &OsStr) -> Option<u32> {
    let (pid, _) = name.to_str()?.split_once('-')?;
    pid.parse().ok()
}

pub fn connect() -> io::Result<Stream> {
    let mut chosen = None;
    for entry in fs::read_dir(directory(false)?)? {
        let entry = entry?;
        let Some(pid) = endpoint_pid(&entry.file_name()) else {
            continue;
        };
        match connect_endpoint(&entry.path(), pid) {
            Ok(stream) if chosen.is_none() => chosen = Some(stream),
            Ok(_) => return Err(io::ErrorKind::AddrInUse.into()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                ) =>
            {
                ()
            }
            Err(error) => return Err(error),
        }
    }
    chosen
        .map(Stream)
        .ok_or_else(|| io::ErrorKind::NotConnected.into())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn endpoint_name_matches_os_attested_peer() {
        let mut listener = Listener::bind().unwrap();
        let pid = endpoint_pid(listener.path.file_name().unwrap()).unwrap();
        assert_eq!(pid, std::process::id());
        let connection = connect_endpoint(&listener.path, pid).unwrap();
        assert!(listener.accept().is_ok());
        assert_eq!(
            connect_endpoint(&listener.path, pid + 1)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        drop(connection);
    }
}
