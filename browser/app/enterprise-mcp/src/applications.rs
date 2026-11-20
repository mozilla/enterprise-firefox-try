/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::{fs, io, path::PathBuf};

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Application {
    id: String,
    executable: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApplicationPolicy {
    connector: PathBuf,
    allowed: Vec<Application>,
}

pub(crate) struct ApplicationAllowlist {
    connector: PathBuf,
    allowed: BTreeMap<PathBuf, String>,
}

impl ApplicationAllowlist {
    pub(crate) fn new(policy: ApplicationPolicy) -> io::Result<Self> {
        let connector = fs::canonicalize(policy.connector)?;
        let mut allowed = BTreeMap::new();
        for application in policy.allowed {
            if let Ok(path) = fs::canonicalize(application.executable) {
                if allowed.insert(path, application.id).is_some() {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
            }
        }
        Ok(Self { connector, allowed })
    }

    pub(crate) fn approve(&self, pid: u32) -> Option<&str> {
        let (executable, parent) = process(pid).ok()?;
        if fs::canonicalize(executable).ok()? != self.connector {
            return None;
        }
        let (launcher, _) = process(parent).ok()?;
        let launcher = fs::canonicalize(launcher).ok()?;
        self.allowed.get(&launcher).map(String::as_str)
    }
}

#[cfg(target_os = "linux")]
fn process(pid: u32) -> io::Result<(PathBuf, u32)> {
    let directory = PathBuf::from("/proc").join(pid.to_string());
    let stat = fs::read_to_string(directory.join("status"))?;
    let parent = stat
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))
        .and_then(|id| id.trim().parse().ok())
        .filter(|id| *id != 0)
        .ok_or(io::ErrorKind::InvalidData)?;
    Ok((fs::read_link(directory.join("exe"))?, parent))
}

#[cfg(target_os = "macos")]
fn process(pid: u32) -> io::Result<(PathBuf, u32)> {
    use std::{
        ffi::OsString,
        mem::{size_of, MaybeUninit},
        os::unix::ffi::OsStringExt,
    };

    let mut info = MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let pid = i32::try_from(pid).map_err(|_| io::ErrorKind::InvalidInput)?;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return Err(io::ErrorKind::NotFound.into());
    }
    let parent = unsafe { info.assume_init() }.pbi_ppid;
    let mut path = vec![0; 4096];
    let read = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if read <= 0 || parent == 0 {
        return Err(io::ErrorKind::NotFound.into());
    }
    path.truncate(
        path.iter()
            .position(|byte| *byte == 0)
            .unwrap_or(read as usize),
    );
    Ok((PathBuf::from(OsString::from_vec(path)), parent))
}

#[cfg(windows)]
fn process(pid: u32) -> io::Result<(PathBuf, u32)> {
    crate::local::process(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{self as os, Command};

    #[test]
    fn wait_for_inspection() {
        if std::env::var_os("FIREFOX_MCP_TEST_WAIT").is_some() {
            use std::io::Read;
            let _ = io::stdin().read(&mut [0]);
        }
    }

    #[test]
    fn resolves_actual_launcher_of_a_child() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "applications::tests::wait_for_inspection"])
            .env("FIREFOX_MCP_TEST_WAIT", "1")
            .stdin(os::Stdio::piped())
            .stdout(os::Stdio::null())
            .spawn()
            .unwrap();
        let image = process(child.id());
        let own_path = std::env::current_exe().unwrap();
        let list = |allowed| {
            ApplicationAllowlist::new(ApplicationPolicy {
                connector: own_path.clone(),
                allowed,
            })
            .unwrap()
        };
        assert!(list(vec![Application {
            id: "client".into(),
            executable: std::env::current_dir().unwrap(),
        }])
        .approve(child.id())
        .is_none());
        assert_eq!(
            list(vec![Application {
                id: "client".into(),
                executable: own_path.clone()
            }])
            .approve(child.id()),
            Some("client"),
        );
        drop(child.stdin.take());
        let _ = child.wait();
        let (image, parent) = image.unwrap();
        assert_eq!(parent, os::id());
        assert_eq!(
            fs::canonicalize(image).unwrap(),
            fs::canonicalize(std::env::current_exe().unwrap()).unwrap()
        );
    }
}
