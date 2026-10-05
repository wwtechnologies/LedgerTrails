//! Native boot services and a headless host entry point. No GUI is created in CLI mode.
use crate::{ledger, office::Office};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn id(folder: &Path) -> String {
    let canonical = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    let folder = canonical.as_path();
    format!(
        "ledgertrails-office-{}",
        &format!("{:x}", Sha256::digest(folder.to_string_lossy().as_bytes()))[..12]
    )
}
fn command(program: &str, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().map_err(err)?;
    if !output.status.success() {
        return Err(format!(
            "{program}: {}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
#[derive(Serialize, Deserialize, Clone)]
struct Manifest {
    folder: PathBuf,
    source: PathBuf,
    hledger: PathBuf,
    appimage: bool,
    company_folder: PathBuf,
    user: String,
    uid: String,
    gid: String,
}
fn manifest_path(folder: &Path) -> PathBuf {
    folder.join("service").join("manifest.json")
}
fn manifest(folder: &Path) -> Result<Manifest> {
    serde_json::from_slice(&fs::read(manifest_path(folder)).map_err(err)?).map_err(err)
}
fn executable(m: &Manifest) -> PathBuf {
    m.folder.join("service").join(if m.appimage {
        "ledgertrails.AppImage"
    } else if cfg!(windows) {
        "ledgertrails.exe"
    } else {
        "ledgertrails"
    })
}
fn write_file(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().ok_or("Invalid service file path")?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(mode))
            .map_err(err)?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(err)?;
    Ok(())
}
fn resolve(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() && path.is_file() {
        return Ok(path);
    }
    for folder in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let p = folder.join(&path);
        if p.is_file() {
            return fs::canonicalize(p).map_err(err);
        }
        #[cfg(windows)]
        {
            let p = p.with_extension("exe");
            if p.is_file() {
                return fs::canonicalize(p).map_err(err);
            }
        }
    }
    Err("Could not locate the hledger executable for the background service".into())
}
pub(crate) fn prepare(office: &Office) -> Result<()> {
    let (_, _, company) = office.service_settings()?;
    if company.is_empty() {
        return Err("Choose and configure a company before installing the service".into());
    }
    let folder = fs::canonicalize(office.folder()).map_err(err)?;
    let appimage = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    #[cfg(unix)]
    let (user, uid, gid) = (
        command("id", &["-un"])?,
        command("id", &["-u"])?,
        command("id", &["-g"])?,
    );
    #[cfg(windows)]
    let (user, uid, gid) = (
        std::env::var("USERNAME").unwrap_or_default(),
        String::new(),
        String::new(),
    );
    let m = Manifest {
        folder: folder.clone(),
        source: appimage
            .clone()
            .unwrap_or(std::env::current_exe().map_err(err)?),
        hledger: resolve(ledger::executable())?,
        appimage: appimage.is_some(),
        company_folder: Path::new(&company)
            .parent()
            .ok_or("Company needs a parent folder")?
            .into(),
        user,
        uid,
        gid,
    };
    write_file(
        &manifest_path(&folder),
        &serde_json::to_vec_pretty(&m).map_err(err)?,
        0o600,
    )
}
fn stage(m: &Manifest) -> Result<()> {
    let dest = executable(m);
    if m.source != dest {
        write_file(&dest, &fs::read(&m.source).map_err(err)?, 0o755)?;
    }
    if !m.appimage {
        let dest = m.folder.join("service").join(if cfg!(windows) {
            "ledgertrails-hledger.exe"
        } else {
            "ledgertrails-hledger"
        });
        if m.hledger != dest {
            write_file(&dest, &fs::read(&m.hledger).map_err(err)?, 0o755)?;
        }
    }
    Ok(())
}
fn args(m: &Manifest, windows: bool) -> Vec<String> {
    let mut args = vec![];
    if m.appimage {
        args.push("--appimage-extract-and-run".into());
    }
    args.push(
        if windows {
            "--office-windows-service"
        } else {
            "--office-server"
        }
        .into(),
    );
    args.push("--config-dir".into());
    args.push(m.folder.to_string_lossy().into());
    args
}
#[cfg(any(target_os = "linux", test))]
fn systemd_quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}
#[cfg(any(target_os = "macos", test))]
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(any(target_os = "linux", test))]
fn unit(m: &Manifest) -> Result<String> {
    if !m.uid.bytes().all(|b| b.is_ascii_digit())
        || m.uid.is_empty()
        || !m.gid.bytes().all(|b| b.is_ascii_digit())
        || m.gid.is_empty()
    {
        return Err("Invalid service user identity".into());
    }
    if m.folder.to_string_lossy().chars().any(char::is_control) {
        return Err("Service paths cannot contain control characters".into());
    }
    let cmd = std::iter::once(executable(m).to_string_lossy().into_owned())
        .chain(args(m, false))
        .map(|s| systemd_quote(&s))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!("[Unit]\nDescription=LedgerTrails office server\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser={}\nGroup={}\nExecStart={}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=25\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=multi-user.target\n",m.uid,m.gid,cmd))
}
#[cfg(any(target_os = "macos", test))]
fn plist(m: &Manifest) -> String {
    let arguments = std::iter::once(executable(m).to_string_lossy().into_owned())
        .chain(args(m, false))
        .map(|s| format!("<string>{}</string>", xml(&s)))
        .collect::<String>();
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.ledgertrails.{}</string><key>UserName</key><string>{}</string><key>ProgramArguments</key><array>{}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>25</integer><key>Umask</key><integer>63</integer></dict></plist>\n",id(&m.folder),xml(&m.user),arguments)
}
#[cfg(target_os = "linux")]
fn installed(folder: &Path) -> bool {
    Path::new("/etc/systemd/system")
        .join(format!("{}.service", id(folder)))
        .is_file()
}
#[cfg(target_os = "macos")]
fn installed(folder: &Path) -> bool {
    Path::new("/Library/LaunchDaemons")
        .join(format!("com.ledgertrails.{}.plist", id(folder)))
        .is_file()
}
#[cfg(windows)]
fn installed(folder: &Path) -> bool {
    windows::query(folder).is_ok()
}
pub(crate) fn status(folder: &Path) -> Value {
    let present = installed(folder);
    #[cfg(target_os = "linux")]
    let manager = "systemd";
    #[cfg(target_os = "macos")]
    let manager = "launchd";
    #[cfg(windows)]
    let manager = "Windows Services";
    let running = if !present {
        false
    } else {
        #[cfg(target_os = "linux")]
        let value = command(
            "systemctl",
            &["is-active", &format!("{}.service", id(folder))],
        )
        .map(|s| s == "active")
        .unwrap_or(false);
        #[cfg(target_os = "macos")]
        let value = command(
            "launchctl",
            &["print", &format!("system/com.ledgertrails.{}", id(folder))],
        )
        .map(|s| s.contains("state = running"))
        .unwrap_or(false);
        #[cfg(windows)]
        let value = windows::query(folder)
            .map(|s| s == windows_service::service::ServiceState::Running)
            .unwrap_or(false);
        value
    };
    let runtime = fs::read(folder.join("service-state.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    json!({"installed":present,"running":running,"manager":manager,"name":id(folder),"detail":runtime,"logPath":folder.join("service.log")})
}
#[cfg(target_os = "linux")]
fn admin(m: &Manifest, action: &str) -> Result<()> {
    if command("id", &["-u"])? != "0" {
        return Err("Administrator approval is required".into());
    }
    let name = format!("{}.service", id(&m.folder));
    let path = Path::new("/etc/systemd/system").join(&name);
    match action {
        "install" | "update" => {
            if installed(&m.folder) {
                command("systemctl", &["stop", &name])?;
            }
            stage(m)?;
            write_file(&path, unit(m)?.as_bytes(), 0o644)?;
            command("systemctl", &["daemon-reload"])?;
            command("systemctl", &["enable", "--now", &name])?;
        }
        "remove" => {
            if installed(&m.folder) {
                command("systemctl", &["disable", "--now", &name])?;
                fs::remove_file(path).map_err(err)?;
                command("systemctl", &["daemon-reload"])?;
            }
        }
        "start" => {
            command("systemctl", &["start", &name])?;
        }
        "stop" => {
            command("systemctl", &["stop", &name])?;
        }
        _ => return Err("Unsupported service action".into()),
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn admin(m: &Manifest, action: &str) -> Result<()> {
    if command("id", &["-u"])? != "0" {
        return Err("Administrator approval is required".into());
    }
    let name = format!("com.ledgertrails.{}", id(&m.folder));
    let target = format!("system/{name}");
    let path = Path::new("/Library/LaunchDaemons").join(format!("{name}.plist"));
    match action {
        "install" | "update" => {
            let _ = command("launchctl", &["bootout", &target]);
            stage(m)?;
            write_file(&path, plist(m).as_bytes(), 0o644)?;
            command(
                "chown",
                &["root:wheel", path.to_str().ok_or("Invalid service path")?],
            )?;
            command("launchctl", &["enable", &target])?;
            command(
                "launchctl",
                &["bootstrap", "system", path.to_str().unwrap()],
            )?;
        }
        "remove" => {
            let _ = command("launchctl", &["bootout", &target]);
            if path.exists() {
                fs::remove_file(path).map_err(err)?;
            }
        }
        "start" => {
            command("launchctl", &["enable", &target])?;
            if command("launchctl", &["print", &target]).is_err() {
                command(
                    "launchctl",
                    &["bootstrap", "system", path.to_str().unwrap()],
                )?;
            } else {
                command("launchctl", &["kickstart", &target])?;
            }
        }
        "stop" => {
            let _ = command("launchctl", &["bootout", &target]);
        }
        _ => return Err("Unsupported service action".into()),
    }
    Ok(())
}
#[cfg(windows)]
fn admin(m: &Manifest, action: &str) -> Result<()> {
    windows::admin(m, action)
}
#[cfg(any(target_os = "macos", test))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
#[cfg(any(windows, test))]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn elevate(folder: &Path, action: &str) -> Result<()> {
    let appimage = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    let current = appimage
        .clone()
        .unwrap_or(std::env::current_exe().map_err(err)?);
    let mut arguments = vec![];
    if appimage.is_some() {
        arguments.push("--appimage-extract-and-run".into());
    }
    arguments.extend([
        "--office-service-admin".into(),
        action.into(),
        "--config-dir".into(),
        folder.to_string_lossy().into_owned(),
    ]);
    #[cfg(target_os = "linux")]
    let result = Command::new("pkexec")
        .arg(&current)
        .args(&arguments)
        .status()
        .map_err(err)?;
    #[cfg(target_os = "macos")]
    let result = {
        let line = std::iter::once(current.to_string_lossy().into_owned())
            .chain(arguments)
            .map(|s| shell_quote(&s))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "do shell script \"{}\" with administrator privileges",
            line.replace('\\', "\\\\").replace('"', "\\\"")
        );
        Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map_err(err)?
    };
    #[cfg(windows)]
    let result = {
        let line = arguments
            .iter()
            .map(|s| windows_quote(s))
            .collect::<Vec<_>>()
            .join(" ");
        let script=format!("$ErrorActionPreference='Stop'; $p=Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -PassThru; exit $p.ExitCode",ps_quote(&current.to_string_lossy()),ps_quote(&line));
        use std::os::windows::process::CommandExt;
        Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .map_err(err)?
    };
    if result.success() {
        Ok(())
    } else {
        let detail = fs::read(folder.join("service-action.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["error"].as_str().map(str::to_owned));
        Err(detail.unwrap_or_else(|| {
            "Service change was not completed. Administrator approval may have been canceled."
                .into()
        }))
    }
}
#[cfg(any(windows, test))]
fn windows_quote(s: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in s.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(c);
        }
        slashes = 0;
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}
pub(crate) fn control(office: &Office, action: &str) -> Result<Value> {
    if !["install", "update", "remove", "start", "stop"].contains(&action) {
        return Err("Unsupported service action".into());
    }
    let (mode, enabled, _) = office.service_settings()?;
    if action == "install" || action == "update" {
        office.stop()?;
        for _ in 0..120 {
            if !office.is_host_running()? {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if office.is_host_running()? {
            return Err("Wait for the existing host to finish stopping".into());
        }
        prepare(office)?;
        office.set_service_mode(true, true)?;
    }
    if action == "start" {
        office.set_service_mode(true, true)?;
        if status(office.folder())["running"] == true {
            return Ok(status(office.folder()));
        }
    }
    if action == "remove" || action == "stop" {
        office.stop()?;
    }
    let action_file = office.folder().join("service-action.json");
    if action_file.exists() {
        fs::remove_file(&action_file).map_err(err)?;
    }
    if let Err(e) = elevate(office.folder(), action) {
        if action == "install" || action == "update" || action == "start" {
            office.set_service_mode(mode, enabled)?;
            if !mode && enabled {
                let _ = tauri::async_runtime::block_on(office.start());
            }
        }
        return Err(e);
    }
    if action == "remove" {
        office.set_service_mode(false, false)?;
    }
    Ok(status(office.folder()))
}
fn log(folder: &Path, message: &str) {
    let path = folder.join("service.log");
    if fs::metadata(&path)
        .map(|m| m.len() > 2_000_000)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, folder.join("service.log.old"));
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {message}", chrono::Utc::now().to_rfc3339());
    }
}
pub(crate) fn run_host(folder: PathBuf, shutdown: Arc<AtomicBool>) -> Result<()> {
    fs::create_dir_all(&folder).map_err(err)?;
    #[cfg(unix)]
    {
        signal_hook::flag::register(signal_hook::consts::SIGTERM, shutdown.clone()).map_err(err)?;
        signal_hook::flag::register(signal_hook::consts::SIGINT, shutdown.clone()).map_err(err)?;
    }
    let office = Office::new(folder.clone());
    log(&folder, "Background host started");
    let result = tauri::async_runtime::block_on(async {
        let mut last_error = None;
        let mut count = 0u32;
        while !shutdown.load(Ordering::SeqCst) {
            let state = office.service_settings();
            let mut error = None;
            match state {
                Ok((mode, enabled, _)) if mode && enabled => {
                    if !office.is_host_running()? {
                        if let Err(e) = office.start().await {
                            error = Some(e);
                        }
                    }
                }
                Ok(_) => {
                    office.stop_runtime()?;
                }
                Err(e) => {
                    office.stop_runtime()?;
                    error = Some(e);
                }
            }
            if error != last_error {
                if let Some(e) = &error {
                    log(&folder, e);
                }
                last_error = error.clone();
            }
            if count % 4 == 0 {
                let state = json!({"at":chrono::Utc::now().to_rfc3339(),"pid":std::process::id(),"error":error});
                write_file(
                    &folder.join("service-state.json"),
                    &serde_json::to_vec(&state).map_err(err)?,
                    0o600,
                )?;
            }
            count = count.wrapping_add(1);
            tokio::time::sleep(Duration::from_millis(if error.is_some() {
                2000
            } else {
                250
            }))
            .await;
        }
        office.stop_runtime()?;
        for _ in 0..80 {
            if !office.is_host_running()? {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Ok(())
    });
    log(&folder, "Background host stopped");
    result
}
pub fn cli(arguments: &[String]) -> Option<Result<()>> {
    let command = arguments.get(1)?;
    if !command.starts_with("--office-") {
        return None;
    }
    Some((|| {
        let index = arguments
            .iter()
            .position(|a| a == "--config-dir")
            .ok_or("Supply --config-dir with an absolute office settings directory")?;
        let folder = PathBuf::from(
            arguments
                .get(index + 1)
                .ok_or("Missing configuration directory")?,
        );
        if !folder.is_absolute() {
            return Err("Configuration directory must be absolute".into());
        }
        let office = Office::new(folder.clone());
        match command.as_str() {
            "--office-server" => run_host(folder, Arc::new(AtomicBool::new(false))),
            #[cfg(windows)]
            "--office-windows-service" => windows::dispatch(folder),
            "--office-check" => {
                println!("{}", office.status()?);
                Ok(())
            }
            "--office-configure" => {
                let arg = |key: &str| -> Result<String> {
                    let i = arguments
                        .iter()
                        .position(|a| a == key)
                        .ok_or_else(|| format!("Missing {key}"))?;
                    arguments
                        .get(i + 1)
                        .cloned()
                        .ok_or_else(|| format!("Missing value for {key}"))
                };
                office.configure(
                    arg("--company")?,
                    arg("--address")?,
                    arg("--port")?.parse().map_err(|_| "Invalid port")?,
                )?;
                office.set_service_mode(true, true)
            }
            "--office-invite" => {
                println!("{}", office.invite("Service test".into(), "editor".into())?);
                Ok(())
            }
            "--office-service-prepare" => {
                prepare(&office)?;
                println!("{}", manifest_path(&folder).display());
                Ok(())
            }
            "--office-service-admin" => {
                let action = arguments.get(2).ok_or("Missing service action")?;
                let m = manifest(&folder)?;
                if fs::canonicalize(&folder).map_err(err)? != m.folder {
                    return Err("Service manifest does not match its settings directory".into());
                }
                if m.folder.to_string_lossy().chars().any(char::is_control) {
                    return Err("Service paths cannot contain control characters".into());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let owner = fs::metadata(&m.folder).map_err(err)?.uid();
                    if owner == 0
                        || m.uid != owner.to_string()
                        || command("id", &["-u", &m.user])? != m.uid
                    {
                        return Err("Install the service for the ordinary user who owns its settings directory".into());
                    }
                    if command("id", &["-g", &m.user])? != m.gid {
                        return Err("Service group does not match its owner".into());
                    }
                }
                let result = admin(&m, action);
                let detail = match &result {
                    Ok(()) => json!({"ok":true}),
                    Err(e) => json!({"error":e}),
                };
                let _ = write_file(
                    &folder.join("service-action.json"),
                    &serde_json::to_vec(&detail).map_err(err)?,
                    0o644,
                );
                result
            }
            _ => Err("Unknown office service command".into()),
        }
    })())
}
#[tauri::command]
pub async fn office_service(action: String, state: tauri::State<'_, Office>) -> Result<Value> {
    let s = state.inner().clone();
    crate::blocking(move || {
        control(&s, &action)?;
        s.status()
    })
    .await
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::OsString, sync::OnceLock};
    use windows_service::{
        define_windows_service,
        service::{
            ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl,
            ServiceExitCode, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
        service_manager::{ServiceManager, ServiceManagerAccess},
    };
    static FOLDER: OnceLock<PathBuf> = OnceLock::new();
    define_windows_service!(ffi_main, service_main);
    pub fn dispatch(folder: PathBuf) -> Result<()> {
        let name = id(&folder);
        FOLDER
            .set(folder)
            .map_err(|_| "Service was already initialized")?;
        service_dispatcher::start(name, ffi_main).map_err(err)
    }
    fn service_main(_arguments: Vec<OsString>) {
        let folder = FOLDER.get().unwrap().clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let signal = shutdown.clone();
        let handler = match service_control_handler::register(id(&folder), move |event| match event
        {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                signal.store(true, Ordering::SeqCst);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }) {
            Ok(h) => h,
            Err(e) => {
                log(&folder, &e.to_string());
                return;
            }
        };
        let report = |state, code| {
            handler.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: if state == ServiceState::Running {
                    ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
                } else {
                    ServiceControlAccept::empty()
                },
                exit_code: ServiceExitCode::Win32(code),
                checkpoint: 0,
                wait_hint: Duration::from_secs(20),
                process_id: None,
            })
        };
        let _ = report(ServiceState::Running, 0);
        let result = run_host(folder.clone(), shutdown);
        if let Err(e) = &result {
            log(&folder, e);
        }
        let _ = report(ServiceState::Stopped, if result.is_ok() { 0 } else { 1 });
    }
    pub fn query(folder: &Path) -> Result<ServiceState> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .map_err(err)?;
        manager
            .open_service(id(folder), ServiceAccess::QUERY_STATUS)
            .map_err(err)?
            .query_status()
            .map(|s| s.current_state)
            .map_err(err)
    }
    pub fn admin(m: &Manifest, action: &str) -> Result<()> {
        let name = id(&m.folder);
        let manager = ServiceManager::local_computer(
            None::<&str>,
            ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
        )
        .map_err(err)?;
        let stop = || -> Result<()> {
            if let Ok(s) =
                manager.open_service(&name, ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)
            {
                if s.query_status().map_err(err)?.current_state != ServiceState::Stopped {
                    s.stop().map_err(err)?;
                    for _ in 0..120 {
                        if s.query_status().map_err(err)?.current_state == ServiceState::Stopped {
                            return Ok(());
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    return Err("Service did not stop in time".into());
                }
            }
            Ok(())
        };
        match action {
            "install" | "update" => {
                stop()?;
                stage(m)?;
                if query(&m.folder).is_err() {
                    manager
                        .create_service(
                            &ServiceInfo {
                                name: OsString::from(&name),
                                display_name: OsString::from("LedgerTrails Office Server"),
                                service_type: ServiceType::OWN_PROCESS,
                                start_type: ServiceStartType::AutoStart,
                                error_control: ServiceErrorControl::Normal,
                                executable_path: executable(m),
                                launch_arguments: args(m, true)
                                    .into_iter()
                                    .map(OsString::from)
                                    .collect(),
                                dependencies: vec![],
                                account_name: Some(OsString::from(format!("NT SERVICE\\{name}"))),
                                account_password: None,
                            },
                            ServiceAccess::CHANGE_CONFIG,
                        )
                        .map_err(err)?
                        .set_description(
                            "Encrypted LedgerTrails office hosting without an open app window",
                        )
                        .map_err(err)?;
                }
                command("sc.exe", &["sidtype", &name, "unrestricted"])?;
                let principal = format!("NT SERVICE\\{name}");
                for folder in [&m.folder, &m.company_folder] {
                    command(
                        "icacls.exe",
                        &[
                            folder.to_str().ok_or("Invalid directory")?,
                            "/grant",
                            &format!("{principal}:(OI)(CI)M"),
                            "/T",
                            "/Q",
                        ],
                    )?;
                }
                // Keep the user-controlled configuration readable after atomic replacement.
                command(
                    "sc.exe",
                    &[
                        "failure",
                        &name,
                        "reset=",
                        "86400",
                        "actions=",
                        "restart/10000/restart/30000/restart/60000",
                    ],
                )?;
                manager
                    .open_service(&name, ServiceAccess::START)
                    .map_err(err)?
                    .start::<&str>(&[])
                    .map_err(err)?;
            }
            "remove" => {
                stop()?;
                if let Ok(s) = manager.open_service(&name, ServiceAccess::DELETE) {
                    let principal = format!("NT SERVICE\\{name}");
                    for folder in [&m.folder, &m.company_folder] {
                        command(
                            "icacls.exe",
                            &[
                                folder.to_str().ok_or("Invalid directory")?,
                                "/remove:g",
                                &principal,
                                "/T",
                                "/Q",
                            ],
                        )?;
                    }
                    s.delete().map_err(err)?;
                }
            }
            "start" => {
                if query(&m.folder)? != ServiceState::Running {
                    manager
                        .open_service(&name, ServiceAccess::START)
                        .map_err(err)?
                        .start::<&str>(&[])
                        .map_err(err)?;
                }
            }
            "stop" => stop()?,
            _ => return Err("Unsupported service action".into()),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Manifest {
        Manifest {
            folder: PathBuf::from("/tmp/Office & Books"),
            source: PathBuf::from("/tmp/app"),
            hledger: PathBuf::from("/tmp/hledger"),
            appimage: false,
            company_folder: PathBuf::from("/tmp/books"),
            user: "owner".into(),
            uid: "1000".into(),
            gid: "1000".into(),
        }
    }
    #[test]
    fn native_templates_run_without_a_gui_as_a_non_root_user() {
        let m = sample();
        let service = unit(&m).unwrap();
        assert!(service.contains("User=1000\nGroup=1000\n"));
        assert!(service.contains("\"--office-server\" \"--config-dir\" \"/tmp/Office & Books\""));
        assert!(service.contains("WantedBy=multi-user.target"));
        let daemon = plist(&m);
        assert!(daemon.contains("<key>UserName</key><string>owner</string>"));
        assert!(daemon.contains("Office &amp; Books"));
        assert!(daemon.contains("<key>RunAtLoad</key><true/>"));
        assert!(!daemon.contains("--office-windows-service"));
        assert_eq!(args(&m, true)[0], "--office-windows-service");
        let mut appimage = m.clone();
        appimage.appimage = true;
        assert_eq!(args(&appimage, false)[0], "--appimage-extract-and-run");
    }
    #[test]
    fn native_command_escaping_handles_spaces_quotes_and_expansion() {
        assert_eq!(systemd_quote("a%$\"\\b"), "\"a%%$$\\\"\\\\b\"");
        assert_eq!(shell_quote("it's $safe"), "'it'\\''s $safe'");
        assert_eq!(ps_quote("it's $safe"), "'it''s $safe'");
        assert_eq!(
            windows_quote("C:\\Office Files\\"),
            "\"C:\\Office Files\\\\\""
        );
        assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
        let mut invalid = sample();
        invalid.uid = "1000\nUser=root".into();
        assert!(unit(&invalid).is_err());
        invalid = sample();
        invalid.folder = PathBuf::from("/tmp/books\nExecStart=bad");
        assert!(unit(&invalid).is_err());
    }
    #[test]
    fn service_identity_follows_canonical_directory() {
        let temp = tempfile::tempdir().unwrap();
        let child = temp.path().join("child");
        fs::create_dir(&child).unwrap();
        assert_eq!(id(temp.path()), id(&child.join("..")));
    }
}
