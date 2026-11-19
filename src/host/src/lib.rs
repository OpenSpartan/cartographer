//! Access to a running Halo Infinite LAN dedicated server (DS), build 269225.26.04.08.1618 (Steam).
//!
//! Safety model: read-only, and only the DS is ever opened. The game client runs under Easy
//! Anti-Cheat and must never be touched. [`Ds::open`] first opens the pid with
//! `PROCESS_QUERY_LIMITED_INFORMATION` alone (the right Task Manager uses) and refuses unless the
//! command line is readable and contains `-server` and the image is `HaloInfinite.exe`. Only then
//! does it reopen with `VM_READ`, re-check identity on the new handle in case the pid was reused,
//! confirm that Windows actually granted `VM_READ`, and verify the PE header (TimeDateStamp,
//! SizeOfImage) of the module at `PEB.ImageBaseAddress`.
//! [`find_ds`] lists candidates from the UDP table and a ToolHelp snapshot without opening any
//! process. Nothing here writes to the DS.

use std::ffi::{c_void, OsString};
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;

use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessBasicInformation, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER,
    ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, NO_ERROR,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedUdpTable, MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, THREADENTRY32, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, OpenProcess, OpenThread, QueryFullProcessImageNameW, PROCESS_BASIC_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ, THREAD_QUERY_INFORMATION,
    THREAD_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

pub mod assets;
pub mod observer;
pub mod geometry;
pub mod icons;
pub mod limits;
pub mod navmesh;
pub mod objectives;

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
compile_error!("cartographer requires 64-bit x86 Windows");

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationThread(thread: HANDLE, class: u32, buffer: *mut c_void, length: u32, returned: *mut u32) -> i32;
    fn NtQueryObject(handle: HANDLE, class: u32, buffer: *mut c_void, length: u32, returned: *mut u32) -> i32;
}

/// This build's version: the release tag in CI, else the package version marked `-dev`.
pub const VERSION: &str = env!("CARTOGRAPHER_VERSION");

/// A development setting from the environment, `CARTOGRAPHER_<name>`. Empty is unset.
pub fn setting(name: &str) -> Option<OsString> {
    std::env::var_os(format!("CARTOGRAPHER_{name}")).filter(|value| !value.is_empty())
}

pub const EXE: &str = "HaloInfinite.exe";
pub const PORT: u16 = 1343; // DS game port (UDP)
pub const TIMESTAMP: u32 = 0x69d6eb24; // PE header of build 269225.26.04.08.1618
pub const IMAGESIZE: u32 = 0x5b00000;

/// Plain integers that can be read straight out of target memory.
pub trait Pod: Copy {}
impl Pod for u8 {}
impl Pod for u16 {}
impl Pod for u32 {}
impl Pod for i32 {}
impl Pod for u64 {}
impl Pod for i64 {}

/// Little-endian `T` at `off` in a buffer already read from the target.
pub fn get<T: Pod>(buf: &[u8], off: usize) -> T {
    let b = &buf[off..off + size_of::<T>()];
    unsafe { b.as_ptr().cast::<T>().read_unaligned() }
}

pub fn verify_image_header(header: &[u8]) -> Result<(), String> {
    if header.len() < 0x400 || &header[..2] != b"MZ" {
        return Err("refused: no complete PE header at the module base".into());
    }
    let offset = get::<i32>(header, 0x3c);
    if !(0x40..=0x300).contains(&offset) || get::<u32>(header, offset as usize) != 0x4550 {
        return Err("refused: no PE header at the module base".into());
    }
    let offset = offset as usize;
    if get::<u16>(header, offset + 4) != 0x8664 || get::<u16>(header, offset + 24) != 0x20b {
        return Err("refused: image is not an x64 PE32+ executable".into());
    }
    let timestamp = get::<u32>(header, offset + 8);
    let image_size = get::<u32>(header, offset + 24 + 56);
    if timestamp != TIMESTAMP || image_size != IMAGESIZE {
        return Err(format!(
            "refused: different build: TimeDateStamp {timestamp:08x} SizeOfImage {image_size:x} (want {TIMESTAMP:08x} {IMAGESIZE:x})"
        ));
    }
    Ok(())
}

pub struct Ds {
    h: Handle,
    pub pid: u32,
    /// HaloInfinite.exe base in the DS.
    pub base: u64,
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

fn open_raw(pid: u32, access: u32) -> Result<Handle, String> {
    let h = unsafe { OpenProcess(access, 0, pid) };
    if h.is_null() {
        // Windows answers ERROR_INVALID_PARAMETER for a PID no process has.
        let error = last_error();
        if error == ERROR_INVALID_PARAMETER {
            return Err("no process has this PID (the server may have exited)".into());
        }
        return Err(format!("OpenProcess failed: {error}"));
    }
    Ok(Handle(h))
}

fn check_read_access(handle: HANDLE) -> Result<(), String> {
    let mut information = [0u32; 14];
    let mut returned = 0;
    let status = unsafe {
        NtQueryObject(handle, 0, information.as_mut_ptr().cast(), size_of_val(&information) as u32, &mut returned)
    };
    if status != 0 {
        return Err(format!("refused: cannot query granted process access (NTSTATUS 0x{:08x})", status as u32));
    }
    let granted = information[1];
    if granted & PROCESS_VM_READ == 0 {
        return Err(format!(
            "refused: Windows did not grant PROCESS_VM_READ (granted access 0x{granted:x}). Process protection may be blocking access to the LAN server"
        ));
    }
    Ok(())
}

/// ProcessCommandLineInformation (60): a UNICODE_STRING followed by the text.
fn command_line(h: HANDLE) -> Option<String> {
    let mut len = 0u32;
    unsafe { NtQueryInformationProcess(h, ProcessCommandLineInformation, null_mut(), 0, &mut len) };
    if len <= 16 || len > 1 << 20 {
        return None;
    }
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    let st = unsafe {
        NtQueryInformationProcess(h, ProcessCommandLineInformation, buf.as_mut_ptr().cast(), len, &mut len)
    };
    if st != 0 {
        return None;
    }
    let chars = (buf[0] & 0xffff) as usize / 2;
    let text = buf[1] as usize;
    let (lo, hi) = (buf.as_ptr() as usize, buf.as_ptr() as usize + buf.len() * 8);
    if text < lo + 16 || text + chars * 2 > hi {
        return None;
    }
    let s = unsafe { std::slice::from_raw_parts(text as *const u16, chars) };
    Some(String::from_utf16_lossy(s))
}

fn has_server_arg(command_line: &str) -> bool {
    let wide: Vec<u16> = command_line.encode_utf16().chain(Some(0)).collect();
    let mut count = 0;
    let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if argv.is_null() {
        return false;
    }
    let found = (1..count as usize).any(|index| {
        let text = unsafe { *argv.add(index) };
        let mut length = 0;
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        let argument = unsafe { std::slice::from_raw_parts(text, length) };
        String::from_utf16_lossy(argument).eq_ignore_ascii_case("-server")
    });
    unsafe { LocalFree(argv.cast()) };
    found
}

/// `-server` on the command line and HaloInfinite.exe as the image. Both work on a query-only handle.
fn check_identity(h: HANDLE) -> Result<(), String> {
    let cmd = command_line(h).filter(|c| !c.is_empty()).ok_or("command line unreadable (not a LAN DS)")?;
    if !has_server_arg(&cmd) {
        return Err("no -server on the command line".into());
    }
    let mut name = [0u16; 1024];
    let mut n = name.len() as u32;
    if unsafe { QueryFullProcessImageNameW(h, 0, name.as_mut_ptr(), &mut n) } == 0 {
        return Err("image name unreadable".into());
    }
    let path = String::from_utf16_lossy(&name[..n as usize]);
    let exe = path.rsplit(['\\', '/']).next().unwrap_or(&path);
    if !exe.eq_ignore_ascii_case(EXE) {
        return Err(format!("main module is {exe}"));
    }
    Ok(())
}

impl Ds {
    /// Opens `pid` after the identity checks described in the crate docs. Errors are complete
    /// messages ("refused: ...", "OpenProcess failed: 5", ...).
    pub fn open(pid: u32) -> Result<Ds, String> {
        let q = open_raw(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        check_identity(q.0).map_err(|e| format!("refused: {e}"))?;

        let h = open_raw(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ)?;
        let mut ds = Ds { h, pid, base: 0 };
        check_identity(ds.h.0).map_err(|e| format!("refused: {e}"))?; // again, in case the pid was reused
        check_read_access(ds.h.0)?;
        ds.check_image()?;
        drop(q);
        Ok(ds)
    }

    /// The module's base, from the PEB, and its PE header checked against the supported build.
    fn check_image(&mut self) -> Result<(), String> {
        let mut pbi: PROCESS_BASIC_INFORMATION = unsafe { zeroed() };
        let mut r = 0u32;
        let st = unsafe {
            NtQueryInformationProcess(
                self.h.0,
                ProcessBasicInformation,
                (&mut pbi as *mut PROCESS_BASIC_INFORMATION).cast(),
                size_of::<PROCESS_BASIC_INFORMATION>() as u32,
                &mut r,
            )
        };
        if st != 0 {
            return Err("refused: ProcessBasicInformation failed".into());
        }
        self.base = self.at(pbi.PebBaseAddress as u64 + 0x10)?;
        verify_image_header(&self.read_abs(self.base, 0x400)?)
    }

    pub fn va(&self, offset: u64) -> u64 {
        self.base + offset
    }

    pub fn read_abs(&self, addr: u64, len: usize) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; len];
        let mut got = 0usize;
        let ok = unsafe {
            ReadProcessMemory(self.h.0, addr as *const c_void, buf.as_mut_ptr().cast(), len, &mut got)
        };
        if ok == 0 || got != len {
            return Err(format!("ReadProcessMemory {addr:x} failed ({})", last_error()));
        }
        Ok(buf)
    }

    pub fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        self.read_abs(self.va(offset), len)
    }

    /// `T` at an absolute address.
    pub fn at<T: Pod>(&self, addr: u64) -> Result<T, String> {
        Ok(get(&self.read_abs(addr, size_of::<T>())?, 0))
    }

    pub fn u8(&self, offset: u64) -> Result<u8, String> {
        self.at(self.va(offset))
    }
    pub fn u32(&self, offset: u64) -> Result<u32, String> {
        self.at(self.va(offset))
    }
    pub fn i32(&self, offset: u64) -> Result<i32, String> {
        self.at(self.va(offset))
    }
    pub fn u64(&self, offset: u64) -> Result<u64, String> {
        self.at(self.va(offset))
    }

    pub fn thread_local_blocks(&self) -> Result<Vec<u64>, String> {
        let header = self.read(0, 0x400)?;
        let pe = get::<u32>(&header, 0x3c) as usize;
        let tls = get::<u32>(&header, pe + 24 + 112 + 9 * 8);
        if tls == 0 || tls as u64 + 40 > IMAGESIZE as u64 {
            return Err("invalid thread-local storage directory".into());
        }
        let directory = self.read(tls as u64, 40)?;
        let index_address = get::<u64>(&directory, 16);
        if !(self.base..self.base + IMAGESIZE as u64 - 4).contains(&index_address) {
            return Err("thread-local storage index is outside the verified image".into());
        }
        let index = self.at::<u32>(index_address)?;
        if index > 4096 {
            return Err("unexpected thread-local storage index".into());
        }
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(format!("thread snapshot failed: {}", last_error()));
        }
        let snapshot = Handle(snapshot);
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut blocks = Vec::new();
        let mut more = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == self.pid {
                let query = unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, entry.th32ThreadID) };
                if !query.is_null() {
                    let query = Handle(query);
                    if unsafe { GetProcessIdOfThread(query.0) } == self.pid {
                        let thread = unsafe { OpenThread(THREAD_QUERY_INFORMATION, 0, entry.th32ThreadID) };
                        if !thread.is_null() {
                            let thread = Handle(thread);
                            let mut info = [0u64; 6];
                            let mut returned = 0;
                            let status = unsafe {
                                NtQueryInformationThread(thread.0, 0, info.as_mut_ptr().cast(), 48, &mut returned)
                            };
                            if status == 0 && info[2] == self.pid as u64 && info[3] == entry.th32ThreadID as u64 {
                                let block = info[1].checked_add(0x58)
                                    .and_then(|address| self.at::<u64>(address).ok())
                                    .filter(|array| *array != 0)
                                    .and_then(|array| array.checked_add(index as u64 * 8))
                                    .and_then(|address| self.at::<u64>(address).ok())
                                    .filter(|block| *block != 0);
                                if let Some(block) = block { blocks.push(block); }
                            }
                        }
                    }
                }
            }
            more = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
        }
        if last_error() != ERROR_NO_MORE_FILES {
            return Err(format!("thread enumeration failed: {}", last_error()));
        }
        blocks.sort_unstable();
        blocks.dedup();
        Ok(blocks)
    }
}

/// Owners of an IPv4/IPv6 UDP endpoint on [`PORT`].
pub fn udp_owners() -> Vec<u32> {
    fn table(af: u16) -> Vec<u64> {
        let mut size = 0u32;
        let mut buf: Vec<u64> = Vec::new();
        loop {
            let r = unsafe {
                GetExtendedUdpTable(buf.as_mut_ptr().cast(), &mut size, 0, af as u32, UDP_TABLE_OWNER_PID, 0)
            };
            match r {
                NO_ERROR => return buf,
                ERROR_INSUFFICIENT_BUFFER => buf = vec![0; (size as usize).div_ceil(8)],
                _ => return Vec::new(),
            }
        }
    }
    // Both tables are { dwNumEntries, pad?, rows[] }. The rows start at the row type's
    // alignment (4).
    fn rows<R: Copy>(t: &[u64]) -> &[R] {
        if t.is_empty() {
            return &[];
        }
        let n = (t[0] & 0xffff_ffff) as usize;
        let max = (t.len() * 8 - 4) / size_of::<R>();
        unsafe { std::slice::from_raw_parts(t.as_ptr().cast::<u8>().add(4).cast::<R>(), n.min(max)) }
    }
    let port = |p: u32| u16::from_be(p as u16);
    let v4 = table(AF_INET);
    let v6 = table(AF_INET6);
    let mut pids: Vec<u32> = rows::<MIB_UDPROW_OWNER_PID>(&v4)
        .iter()
        .filter(|r| port(r.dwLocalPort) == PORT)
        .map(|r| r.dwOwningPid)
        .chain(rows::<MIB_UDP6ROW_OWNER_PID>(&v6).iter().filter(|r| port(r.dwLocalPort) == PORT).map(|r| r.dwOwningPid))
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Pids of processes named HaloInfinite.exe that own UDP [`PORT`]. Opens no process.
pub fn find_ds() -> Vec<u32> {
    let owners = udp_owners();
    if owners.is_empty() {
        return owners;
    }
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let snap = Handle(snap);
    let mut pe: PROCESSENTRY32W = unsafe { zeroed() };
    pe.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = Vec::new();
    let mut more = unsafe { Process32FirstW(snap.0, &mut pe) } != 0;
    while more {
        let len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
        if owners.contains(&pe.th32ProcessID) && String::from_utf16_lossy(&pe.szExeFile[..len]).eq_ignore_ascii_case(EXE) {
            found.push(pe.th32ProcessID);
        }
        more = unsafe { Process32NextW(snap.0, &mut pe) } != 0;
    }
    found
}

/// The pid given on the command line, or the single DS found by [`find_ds`].
pub fn pick_pid(arg: Option<u32>) -> Result<u32, String> {
    if let Some(pid) = arg {
        return Ok(pid);
    }
    let found = find_ds();
    match found[..] {
        [pid] => Ok(pid),
        [] => Err(format!("no DS found ({EXE} owning UDP {PORT}). Pass a PID")),
        ref many => Err(format!("several DS candidates {many:?}. Pass a PID")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_access_guard_checks_the_granted_handle_rights() {
        let query = open_raw(std::process::id(), PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        let error = check_read_access(query.0).unwrap_err();
        assert!(error.contains("did not grant PROCESS_VM_READ"), "{error}");
        let read = open_raw(std::process::id(), PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ).unwrap();
        assert_eq!(check_read_access(read.0), Ok(()));
    }

    #[test]
    fn a_pid_no_process_has_is_said_plainly() {
        // PIDs are multiples of 4 well below this one.
        let error = Ds::open(0xffff_fffc).err().unwrap();
        assert_eq!(error, "no process has this PID (the server may have exited)");
    }

    #[test]
    fn server_switch_is_a_complete_windows_argument() {
        assert!(has_server_arg(r#""C:\Halo Infinite\game\HaloInfinite.exe" -server -lan"#));
        assert!(has_server_arg(r#"HaloInfinite.exe "-SERVER" -lan"#));
        assert!(!has_server_arg(r#"HaloInfinite.exe -override_working_dir "C:\a -server b""#));
        assert!(!has_server_arg("HaloInfinite.exe -serverish -lan"));
        assert!(!has_server_arg(r#""C:\a -server b\HaloInfinite.exe" -lan"#));
        assert!(!has_server_arg("-server"));
        assert!(!has_server_arg(""));
    }

    #[test]
    fn image_guard_rejects_truncated_headers_wrong_architecture_and_builds() {
        let mut header = vec![0u8; 0x400];
        header[..2].copy_from_slice(b"MZ");
        header[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        header[0x80..0x84].copy_from_slice(&0x4550u32.to_le_bytes());
        header[0x84..0x86].copy_from_slice(&0x8664u16.to_le_bytes());
        header[0x88..0x8c].copy_from_slice(&TIMESTAMP.to_le_bytes());
        header[0x98..0x9a].copy_from_slice(&0x20bu16.to_le_bytes());
        header[0xd0..0xd4].copy_from_slice(&IMAGESIZE.to_le_bytes());
        assert!(verify_image_header(&header).is_ok());
        assert!(verify_image_header(&header[..100]).is_err());
        header[0x88] ^= 1;
        assert!(verify_image_header(&header).is_err());
        header[0x88] ^= 1;
        header[0x84] = 0;
        assert!(verify_image_header(&header).is_err());
        header[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(verify_image_header(&header).is_err());
    }
}
