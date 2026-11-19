use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::ptr::null_mut;
use std::time::{Duration, Instant};

use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY,
};
use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_CONSOLE};

const APP_ID: &str = "1240440";
const ARGUMENTS: [&str; 3] = ["-server", "-pc", "-lan"];
const APP_ENV: [&str; 3] = ["SteamAppId", "SteamGameId", "SteamOverlayGameId"];
/// How long the server gets to open its game port. It usually takes 15 to 30 s.
const START_TIMEOUT: Duration = Duration::from_secs(120);

fn registered_install(root: HKEY, view: u32) -> Option<PathBuf> {
    let key: Vec<u16> = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 1240440"
        .encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = "InstallLocation".encode_utf16().chain(Some(0)).collect();
    let mut length = 0;
    let flags = RRF_RT_REG_SZ | view;
    let status = unsafe { RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, null_mut(), null_mut(), &mut length) };
    if status != 0 || length == 0 || length > 65536 || length % 2 != 0 { return None; }
    let mut value = vec![0u16; length as usize / 2];
    let status = unsafe {
        RegGetValueW(root, key.as_ptr(), name.as_ptr(), flags, null_mut(), value.as_mut_ptr().cast(), &mut length)
    };
    if status != 0 { return None; }
    let end = value.iter().position(|&unit| unit == 0)?;
    (end != 0).then(|| PathBuf::from(OsString::from_wide(&value[..end])))
}

fn installed_game() -> Result<PathBuf, String> {
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
            if let Some(path) = registered_install(root, view) { return Ok(path); }
        }
    }
    Err("Halo Infinite's Steam install was not found. Use cartographer server --game \"<install folder>\"".into())
}

fn executable(root: &Path) -> PathBuf { root.join("game").join(cartographer::EXE) }

fn command(root: &Path) -> Command {
    let mut command = Command::new(executable(root));
    command.current_dir(root).args(ARGUMENTS).creation_flags(CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB);
    for name in APP_ENV { command.env(name, APP_ID); }
    command
}

fn require_free_port(owners: &[u32]) -> Result<(), String> {
    if !owners.is_empty() {
        return Err(format!(
            "UDP {} is already in use (PIDs {owners:?}). Stop the existing LAN server or resolve the port conflict before using cartographer server. No process was started or stopped",
            cartographer::PORT
        ));
    }
    Ok(())
}

fn validate_install(root: &Path) -> Result<(), String> {
    let path = executable(root);
    let mut file = File::open(&path).map_err(|error| format!("cannot open {}: {error}. --game must name the install folder, not the launcher or game subfolder", path.display()))?;
    let mut header = [0u8; 0x400];
    file.read_exact(&mut header).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    cartographer::verify_image_header(&header).map_err(|error| format!("{}: {error}", path.display()))?;
    if !root.join("deploy").join("ds").is_dir() {
        return Err(format!("LAN server content is missing from {}", root.join("deploy").join("ds").display()));
    }
    Ok(())
}

fn next_step(pid: u32) -> String {
    crate::terminal::panel(
        "Dedicated server",
        "Started",
        &[("PID", &pid.to_string()), ("Console", "Separate window")],
        ("Next step: start the viewer", &format!(".\\cartographer.exe {pid} serve --lan")),
        &[
            "Run this in the same terminal. Omit --lan for this PC only.",
            "Keep the Halo console open. Stopping the viewer does not stop Halo.",
        ],
    )
}

pub fn run(game: Option<&Path>, dry_run: bool) -> Result<(), String> {
    let owners = cartographer::udp_owners();
    if !dry_run { require_free_port(&owners)?; }
    let root = match game { Some(root) => root.to_owned(), None => installed_game()? };
    let root = if root.is_absolute() { root } else { std::env::current_dir().map_err(|error| error.to_string())?.join(root) };
    validate_install(&root)?;
    let mut launch = command(&root);
    if dry_run {
        println!("Dry run: no process will be started or stopped.");
        println!("Executable: {}", Path::new(launch.get_program()).display());
        println!("Arguments: {}", ARGUMENTS.join(" "));
        println!("Working directory: {}", root.display());
        for name in APP_ENV { println!("Environment: {name}={APP_ID}"); }
        if let Err(error) = require_free_port(&owners) { println!("Launch blocked: {error}"); }
        return Ok(());
    }
    let mut child = launch.spawn().map_err(|error| format!(
        "cannot start an independent LAN server: {error}. If a parent Windows job forbids breakaway, launch from a separate terminal. No attached fallback was attempted"
    ))?;
    println!("Waiting for the LAN server (PID {}) to open UDP {}.", child.id(), cartographer::PORT);
    let pid = wait_until_serving(&mut child, START_TIMEOUT, cartographer::udp_owners)?;
    print!("{}", next_step(pid));
    Ok(())
}

/// Waits until `child` holds the game port, by `owners` (the port's owning PIDs), and returns its
/// PID. A server that exits first is reported with its exit status, never as a PID to watch.
fn wait_until_serving(child: &mut Child, timeout: Duration, owners: impl Fn() -> Vec<u32>) -> Result<u32, String> {
    let pid = child.id();
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "the LAN server (PID {pid}) exited during startup ({status}). If it crashed, its report is in %TEMP%\\crash_report"
            ));
        }
        if owners().contains(&pid) { return Ok(pid); }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "the LAN server (PID {pid}) did not open UDP {} within {} s. It is still running in its own console",
        cartographer::PORT, timeout.as_secs()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn next_step_highlights_a_copyable_powershell_command() {
        let message = console::strip_ansi_codes(&next_step(17292)).into_owned();
        assert!(message.contains("Next step: start the viewer"));
        assert!(message.contains("same terminal"));
        assert!(message.contains("\n    .\\cartographer.exe 17292 serve --lan\n\n"));
        assert!(message.contains("Stopping the viewer does not stop Halo"));
        assert!(!message.contains(';'));
        assert!(!message.contains('\u{1b}'));
    }

    #[test]
    fn standalone_command_uses_the_game_binary_and_install_root() {
        let root = Path::new(r"C:\Steam Library\steamapps\common\Halo Infinite");
        let launch = command(root);
        assert_eq!(launch.get_program(), root.join("game").join("HaloInfinite.exe").as_os_str());
        assert_ne!(launch.get_program(), root.join("HaloInfinite.exe").as_os_str());
        assert_eq!(launch.get_current_dir(), Some(root));
        assert_eq!(launch.get_args().collect::<Vec<_>>(), ARGUMENTS.map(OsStr::new));
        for name in APP_ENV {
            assert!(launch.get_envs().any(|(key, value)| key == name && value == Some(OsStr::new(APP_ID))));
        }
    }

    #[test]
    fn startup_waits_for_the_port_and_reports_a_server_that_exits() {
        let exits = || Command::new("cmd.exe").args(["/c", "exit 3"]).spawn().unwrap();
        let error = wait_until_serving(&mut exits(), Duration::from_secs(10), Vec::new).unwrap_err();
        assert!(error.contains("exited during startup") && error.contains('3'), "{error}");

        let mut serving = Command::new("cmd.exe").args(["/c", "ping -n 30 127.0.0.1 >nul"]).spawn().unwrap();
        let pid = serving.id();
        assert_eq!(wait_until_serving(&mut serving, Duration::from_secs(10), || vec![pid]), Ok(pid));
        let error = wait_until_serving(&mut serving, Duration::from_millis(600), Vec::new).unwrap_err();
        assert!(error.contains("did not open UDP"), "{error}");
        serving.kill().unwrap();
    }

    #[test]
    fn standalone_launch_refuses_an_existing_server() {
        assert_eq!(require_free_port(&[]), Ok(()));
        let error = require_free_port(&[123, 456]).unwrap_err();
        assert!(error.contains("123, 456"));
        assert!(error.contains("No process was started or stopped"));
    }
}