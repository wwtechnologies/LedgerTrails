//! Optional authenticated LAN hosting. Remote callers never supply server file paths.
use crate::{company, imports, ledger, review, workspace};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
const LIMIT: usize = 8 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize, Deserialize)]
struct User {
    id: String,
    name: String,
    role: String,
    token_hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Config {
    version: u32,
    enabled: bool,
    #[serde(default)]
    service_mode: bool,
    address: String,
    port: u16,
    company: String,
    certificate: String,
    key: String,
    users: Vec<User>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            service_mode: false,
            address: suggested_address(),
            port: 47831,
            company: String::new(),
            certificate: String::new(),
            key: String::new(),
            users: vec![],
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Peer {
    version: u32,
    address: String,
    port: u16,
    certificate: String,
    token: String,
}
struct Inner {
    config: Config,
    handle: Option<axum_server::Handle>,
    peer: Option<Peer>,
    error: Option<String>,
}
struct Service {
    folder: PathBuf,
    inner: Mutex<Inner>,
    operations: Mutex<()>,
    running: AtomicBool,
    slots: Arc<tokio::sync::Semaphore>,
}
#[derive(Clone)]
pub struct Office(Arc<Service>);
fn suggested_address() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.0.2.1:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}
fn address(value: &str, port: u16) -> Result<SocketAddr> {
    let ip: Ipv4Addr = value
        .parse()
        .map_err(|_| "Enter this computer's private IPv4 address")?;
    if !(ip.is_private() || ip.is_loopback()) || port < 1024 {
        return Err("Use a private office IPv4 address and a port from 1024 to 65535".into());
    }
    Ok(SocketAddr::from((ip, port)))
}
fn secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(err)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}
fn save_json(folder: &Path, name: &str, value: &impl Serialize) -> Result<()> {
    fs::create_dir_all(folder).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(folder, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    let mut temp = tempfile::NamedTempFile::new_in(folder).map_err(err)?;
    temp.write_all(&serde_json::to_vec_pretty(value).map_err(err)?)
        .map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(folder.join(name)).map_err(err)?;
    Ok(())
}
pub(crate) struct FileLease(fs::File);
impl Drop for FileLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
fn lease(folder: &Path, name: &str, wait: bool) -> Result<FileLease> {
    fs::create_dir_all(folder).map_err(err)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(folder.join(name))
        .map_err(err)?;
    if wait {
        file.lock_exclusive().map_err(err)?;
    } else {
        file.try_lock_exclusive().map_err(err)?;
    }
    Ok(FileLease(file))
}
fn read_config(folder: &Path) -> Result<Config> {
    match fs::read(folder.join("server.json")) {
        Ok(bytes) => {
            let config: Config = serde_json::from_slice(&bytes).map_err(err)?;
            if config.version != 1 {
                return Err("Unsupported office settings version".into());
            }
            Ok(config)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(err(e)),
    }
}
impl Office {
    pub fn new(folder: PathBuf) -> Self {
        let loaded = match fs::read(folder.join("server.json")) {
            Ok(bytes) => serde_json::from_slice::<Config>(&bytes)
                .map_err(err)
                .and_then(|c| {
                    if c.version == 1 {
                        Ok(c)
                    } else {
                        Err("Unsupported office settings version".into())
                    }
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(err(e)),
        };
        let (config, error) = match loaded {
            Ok(c) => (c, None),
            Err(e) => (
                Config::default(),
                Some(format!("Could not load office settings: {e}")),
            ),
        };
        let peer = fs::read(folder.join("connection.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        Self(Arc::new(Service {
            folder,
            inner: Mutex::new(Inner {
                config,
                handle: None,
                peer,
                error,
            }),
            operations: Mutex::new(()),
            running: AtomicBool::new(false),
            slots: Arc::new(tokio::sync::Semaphore::new(16)),
        }))
    }
    pub(crate) fn folder(&self) -> &Path {
        &self.0.folder
    }
    fn reload(&self) -> Result<Config> {
        let _settings = lease(&self.0.folder, "settings.lock", true)?;
        let config = read_config(&self.0.folder)?;
        self.0.inner.lock().map_err(err)?.config = config.clone();
        Ok(config)
    }
    pub(crate) fn is_host_running(&self) -> Result<bool> {
        fs::create_dir_all(&self.0.folder).map_err(err)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.0.folder.join("host.lock"))
            .map_err(err)?;
        match file.try_lock_exclusive() {
            Ok(()) => {
                let _ = FileExt::unlock(&file);
                Ok(false)
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                Ok(true)
            }
            Err(e) => Err(err(e)),
        }
    }
    pub(crate) fn set_service_mode(&self, mode: bool, enabled: bool) -> Result<()> {
        let _settings = lease(&self.0.folder, "settings.lock", true)?;
        let mut config = read_config(&self.0.folder)?;
        config.service_mode = mode;
        config.enabled = enabled;
        save_json(&self.0.folder, "server.json", &config)?;
        self.0.inner.lock().map_err(err)?.config = config;
        Ok(())
    }
    pub(crate) fn service_settings(&self) -> Result<(bool, bool, String)> {
        let c = self.reload()?;
        Ok((c.service_mode, c.enabled, c.company))
    }
    pub fn status(&self) -> Result<Value> {
        let config = self.reload()?;
        let running = self.is_host_running()?;
        let service = crate::office_service::status(&self.0.folder);
        let inner = self.0.inner.lock().map_err(err)?;
        Ok(
            json!({"enabled":inner.config.enabled,"running":running,"serviceMode":config.service_mode,"service":service,"address":inner.config.address,"port":inner.config.port,"company":inner.config.company,"error":inner.error,"users":inner.config.users.iter().map(|u|json!({"id":u.id,"name":u.name,"role":u.role})).collect::<Vec<_>>(),"savedConnection":inner.peer.as_ref().map(|p|format!("{}:{}",p.address,p.port))}),
        )
    }
    pub async fn start(&self) -> Result<()> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        self.reload()?;
        let config = {
            let inner = self.0.inner.lock().map_err(err)?;
            if inner.handle.is_some() {
                return Err("Office server is already running".into());
            }
            inner.config.clone()
        };
        if config.company.is_empty() {
            return Err("Choose a company to share first".into());
        }
        let host_lease = lease(&self.0.folder, "host.lock", false)
            .map_err(|_| "Another LedgerTrails host is already running for these settings")?;
        // Validate the selected company without holding any async mutex.
        let company = config.company.clone();
        tauri::async_runtime::spawn_blocking(move || company::snapshot(Path::new(&company)))
            .await
            .map_err(err)??;
        let listener = TcpListener::bind(address(&config.address, config.port)?).map_err(|e| {
            format!(
                "Could not listen on {}:{}: {e}",
                config.address, config.port
            )
        })?;
        listener.set_nonblocking(true).map_err(err)?;
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(
            config.certificate.as_bytes().to_vec(),
            config.key.as_bytes().to_vec(),
        )
        .await
        .map_err(err)?;
        let handle = axum_server::Handle::new();
        let router = Router::new()
            .route("/v1/rpc", post(rpc))
            .layer(DefaultBodyLimit::max(LIMIT))
            .with_state(self.clone());
        {
            let _settings = lease(&self.0.folder, "settings.lock", true)?;
            let fresh = read_config(&self.0.folder)?;
            if fresh.enabled != config.enabled
                || fresh.service_mode != config.service_mode
                || fresh.company != config.company
                || fresh.address != config.address
                || fresh.port != config.port
                || fresh.certificate != config.certificate
            {
                return Err("Host settings changed during startup; try again".into());
            }
            let mut inner = self.0.inner.lock().map_err(err)?;
            inner.config = fresh;
            if inner.handle.is_some() {
                return Err("Office server is already running".into());
            }
            let mut c = inner.config.clone();
            c.enabled = true;
            save_json(&self.0.folder, "server.json", &c)?;
            inner.config = c;
            inner.error = None;
            inner.handle = Some(handle.clone());
        }
        self.0.running.store(true, Ordering::SeqCst);
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = axum_server::from_tcp_rustls(listener, tls)
                .handle(handle)
                .serve(router.into_make_service())
                .await;
            drop(host_lease);
            service.0.running.store(false, Ordering::SeqCst);
            if let Ok(mut inner) = service.0.inner.lock() {
                inner.handle = None;
                if let Err(e) = result {
                    inner.error = Some(format!("Office server stopped: {e}"));
                }
            }
        });
        Ok(())
    }
    pub(crate) fn stop_runtime(&self) -> Result<()> {
        if let Some(handle) = &self.0.inner.lock().map_err(err)?.handle {
            handle.graceful_shutdown(Some(Duration::from_secs(10)));
        }
        Ok(())
    }
    pub fn stop(&self) -> Result<()> {
        let _settings = lease(&self.0.folder, "settings.lock", true)?;
        let mut inner = self.0.inner.lock().map_err(err)?;
        let mut config = read_config(&self.0.folder)?;
        config.enabled = false;
        save_json(&self.0.folder, "server.json", &config)?;
        inner.config = config;
        if let Some(handle) = &inner.handle {
            handle.graceful_shutdown(Some(Duration::from_secs(10)));
        }
        Ok(())
    }
    pub fn configure(&self, company_path: String, host: String, port: u16) -> Result<()> {
        address(&host, port)?;
        let path = fs::canonicalize(company_path).map_err(err)?;
        if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("bky"))
            != Some(true)
        {
            return Err("Choose a working .bky company file".into());
        }
        company::snapshot(&path)?;
        let _settings = lease(&self.0.folder, "settings.lock", true)?;
        let mut inner = self.0.inner.lock().map_err(err)?;
        inner.config = read_config(&self.0.folder)?;
        if self.is_host_running()? || inner.handle.is_some() {
            return Err("Stop hosting before changing the shared company or address".into());
        }
        if inner.error.is_some() && !self.0.folder.join("server.json").exists() {
            inner.error = None;
        }
        let mut config = inner.config.clone();
        if config.company != path.to_string_lossy()
            || config.address != host
            || config.port != port
            || config.certificate.is_empty()
        {
            let cert = rcgen::generate_simple_self_signed(vec![host.clone()]).map_err(err)?;
            config.certificate = cert.cert.pem();
            config.key = cert.key_pair.serialize_pem();
            config.users.clear();
        }
        config.company = path.to_string_lossy().into();
        config.address = host;
        config.port = port;
        config.enabled = false;
        save_json(&self.0.folder, "server.json", &config)?;
        inner.config = config;
        inner.error = None;
        Ok(())
    }
    pub fn invite(&self, name: String, role: String) -> Result<String> {
        if name.trim().is_empty()
            || name.len() > 80
            || name.chars().any(char::is_control)
            || !["reader", "editor"].contains(&role.as_str())
        {
            return Err("Enter a coworker name and choose read-only or editor access".into());
        }
        let token = secret()?;
        let _settings = lease(&self.0.folder, "settings.lock", true)?;
        let mut inner = self.0.inner.lock().map_err(err)?;
        inner.config = read_config(&self.0.folder)?;
        if inner.config.certificate.is_empty() {
            return Err("Set up the host first".into());
        }
        if inner.config.users.len() >= 100 {
            return Err("Remove an existing access code before adding more (100 maximum)".into());
        }
        let mut config = inner.config.clone();
        config.users.push(User {
            id: secret()?,
            name: name.trim().into(),
            role,
            token_hash: digest(&token),
        });
        let code = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Peer {
                version: 1,
                address: config.address.clone(),
                port: config.port,
                certificate: config.certificate.clone(),
                token,
            })
            .map_err(err)?,
        );
        save_json(&self.0.folder, "server.json", &config)?;
        inner.config = config;
        Ok(format!("LT1-{code}"))
    }
    pub fn revoke(&self, id: &str) -> Result<()> {
        let _settings = lease(&self.0.folder, "settings.lock", true)?;
        let mut inner = self.0.inner.lock().map_err(err)?;
        inner.config = read_config(&self.0.folder)?;
        let mut c = inner.config.clone();
        c.users.retain(|u| u.id != id);
        save_json(&self.0.folder, "server.json", &c)?;
        inner.config = c;
        Ok(())
    }
    fn authenticate(&self, token: &str) -> Result<User> {
        self.reload()?;
        let inner = self.0.inner.lock().map_err(err)?;
        if !inner.config.enabled {
            return Err("Office server is stopped".into());
        }
        let hash = digest(token);
        inner
            .config
            .users
            .iter()
            .find(|u| equal(&u.token_hash, &hash))
            .cloned()
            .ok_or("Access code is invalid or revoked".into())
    }
    fn dispatch(&self, user: &User, request: Rpc) -> Result<Value> {
        let _operation = self.0.operations.lock().map_err(err)?;
        // Recheck permissions after waiting, so revocation applies to queued requests too.
        let config = self.reload()?;
        if !config.enabled || !config.users.iter().any(|u| u.id == user.id) {
            return Err("Access has been revoked or hosting stopped".into());
        }
        let path = Path::new(&config.company);
        let a = request.args;
        let rev = || field::<String>(&a, "revision");
        let read_only = [
            "snapshot",
            "save_company",
            "read_workspace",
            "list_review",
            "review_statement",
            "download_company",
            "audit",
        ];
        if user.role != "editor" && !read_only.contains(&request.command.as_str()) {
            return Err("This access code is read-only".into());
        }
        company::as_actor(&user.name, &request.command, || {
            match request.command.as_str() {
                "snapshot" => value(company::snapshot(path)?),
                "save_company" => value(company::save(path, &rev()?)?),
                "add_entry" => {
                    company::append(path, &rev()?, &field::<ledger::Entry>(&a, "entry")?)?;
                    Ok(Value::Null)
                }
                "read_workspace" => value(workspace::read(path, &rev()?)?),
                "save_workspace" => {
                    workspace::save(path, &rev()?, field(&a, "value")?)?;
                    value(company::snapshot(path)?)
                }
                "list_review" => value(review::rows(&company::journal_text(path, &rev()?)?)),
                "categorize_review" => {
                    review::commit(path, &rev()?, field(&a, "changes")?)?;
                    Ok(Value::Null)
                }
                "review_statement" | "import_statement" => {
                    let text: String = field(&a, "csv")?;
                    if text.len() > 5_000_000 {
                        return Err("CSV must be smaller than 5 MB".into());
                    }
                    let mut file = tempfile::NamedTempFile::new().map_err(err)?;
                    file.write_all(text.as_bytes()).map_err(err)?;
                    if request.command == "review_statement" {
                        value(imports::review(
                            path,
                            file.path(),
                            &field::<String>(&a, "fileRevision")?,
                            &rev()?,
                            &field(&a, "mappings")?,
                            &field::<String>(&a, "currency")?,
                        )?)
                    } else {
                        let mut r: imports::Request = field(&a, "request")?;
                        r.path = file.path().to_string_lossy().into();
                        value(imports::commit(path, &r)?)
                    }
                }
                "download_company" => {
                    let dir = tempfile::tempdir().map_err(err)?;
                    let dest = dir.path().join("backup.bkybk");
                    company::copy(path, &rev()?, &dest)?;
                    Ok(json!(URL_SAFE_NO_PAD.encode(fs::read(dest).map_err(err)?)))
                }
                "audit" => {
                    let snapshot = company::snapshot(path)?;
                    let text = company::journal_text(path, &snapshot.revision)?;
                    Ok(json!(text
                        .lines()
                        .filter_map(|l| l.strip_prefix("; ledgertrails-audit: "))
                        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .take(100)
                        .collect::<Vec<_>>()))
                }
                _ => Err("Unsupported office operation".into()),
            }
        })
    }
    pub fn connect(&self, code: Option<String>) -> Result<Value> {
        let peer = if let Some(code) = code.filter(|s| !s.trim().is_empty()) {
            if code.len() > 16000 {
                return Err("Invalid access code".into());
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(
                    code.trim()
                        .strip_prefix("LT1-")
                        .ok_or("Access codes begin with LT1-")?,
                )
                .map_err(|_| "Invalid access code")?;
            serde_json::from_slice::<Peer>(&bytes).map_err(|_| "Invalid access code")?
        } else {
            self.0
                .inner
                .lock()
                .map_err(err)?
                .peer
                .clone()
                .ok_or("Paste an access code from the host computer")?
        };
        let snapshot = call(&peer, "snapshot", json!({}))?;
        save_json(&self.0.folder, "connection.json", &peer)?;
        self.0.inner.lock().map_err(err)?.peer = Some(peer);
        Ok(snapshot)
    }
    pub fn remote(&self, command: String, mut args: Value) -> Result<Value> {
        let peer = self
            .0
            .inner
            .lock()
            .map_err(err)?
            .peer
            .clone()
            .ok_or("Connect to an office server first")?;
        match command.as_str() {
            "refresh_journal" => call(&peer, "snapshot", json!({})),
            "review_statement" | "import_statement" => {
                let path = if command == "import_statement" {
                    field::<String>(&args["request"], "path")?
                } else {
                    field::<String>(&args, "path")?
                };
                let mut text = String::new();
                fs::File::open(path)
                    .map_err(err)?
                    .take(5_000_001)
                    .read_to_string(&mut text)
                    .map_err(err)?;
                if text.len() > 5_000_000 {
                    return Err("CSV must be smaller than 5 MB".into());
                }
                args["csv"] = json!(text);
                call(&peer, &command, args)
            }
            "copy_company" => {
                let data = call(
                    &peer,
                    "download_company",
                    json!({"revision":field::<String>(&args,"revision")?}),
                )?;
                let bytes = URL_SAFE_NO_PAD
                    .decode(data.as_str().ok_or("Invalid backup response")?)
                    .map_err(err)?;
                let mut temp = tempfile::NamedTempFile::new().map_err(err)?;
                temp.write_all(&bytes).map_err(err)?;
                let path: String = field(&args, "path")?;
                value(company::restore(temp.path(), Path::new(&path))?)
            }
            "export_document" => {
                let snapshot = call(&peer, "snapshot", json!({}))?;
                if snapshot["revision"] != args["revision"] {
                    return Err("Company changed. Refresh before exporting.".into());
                }
                crate::write_export(
                    &field::<String>(&args, "path")?,
                    &field::<String>(&args, "content")?,
                )?;
                Ok(Value::Null)
            }
            "add_entry" | "save_company" | "read_workspace" | "save_workspace" | "list_review"
            | "categorize_review" | "audit" => call(&peer, &command, args),
            _ => Err("This operation is available on the host computer only".into()),
        }
    }
}
fn value(v: impl Serialize) -> Result<Value> {
    serde_json::to_value(v).map_err(err)
}
fn field<T: serde::de::DeserializeOwned>(v: &Value, key: &str) -> Result<T> {
    serde_json::from_value(
        v.get(key)
            .cloned()
            .ok_or_else(|| format!("Missing {key}"))?,
    )
    .map_err(|_| format!("Invalid {key}"))
}
#[derive(Deserialize)]
struct Rpc {
    command: String,
    #[serde(default)]
    args: Value,
}
async fn rpc(
    State(office): State<Office>,
    request: axum::extract::Request,
) -> (StatusCode, Json<Value>) {
    let token = request
        .headers()
        .get("authorization")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if token.len() != 64 {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Access code is invalid or revoked"})),
        );
    }
    let user = match office.authenticate(token) {
        Ok(u) => u,
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":e}))),
    };
    let permit = match office.0.slots.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"Server is busy; try again"})),
            )
        }
    };
    // Authenticate and bound concurrency before allocating an uploaded request body.
    let body = match tokio::time::timeout(
        Duration::from_secs(15),
        axum::body::to_bytes(request.into_body(), LIMIT),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({"error":"Request exceeds the 8 MB limit"})),
            )
        }
        Err(_) => {
            return (
                StatusCode::REQUEST_TIMEOUT,
                Json(json!({"error":"Upload timed out"})),
            )
        }
    };
    let request: Rpc = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid office request"})),
            )
        }
    };
    let identity = json!({"name":user.name,"role":user.role});
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        office.dispatch(&user, request)
    })
    .await;
    match result {
        Ok(Ok(data)) => (StatusCode::OK, Json(json!({"data":data,"user":identity}))),
        Ok(Err(e)) => (StatusCode::CONFLICT, Json(json!({"error":e}))),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"Server operation failed"})),
        ),
    }
}
fn call(peer: &Peer, command: &str, args: Value) -> Result<Value> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    address(&peer.address, peer.port)?;
    if peer.version != 1 || peer.token.len() != 64 {
        return Err("Invalid access code version or token".into());
    }
    let cert = reqwest::Certificate::from_pem(peer.certificate.as_bytes())
        .map_err(|_| "Invalid server certificate")?;
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .no_proxy()
        .tls_built_in_root_certs(false)
        .add_root_certificate(cert)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(err)?;
    let response=client.post(format!("https://{}:{}/v1/rpc",peer.address,peer.port)).bearer_auth(&peer.token).json(&json!({"command":command,"args":args})).send().map_err(|_|"Office server could not be reached securely. Check that the host is running and the access code is current. If saving, refresh before retrying to check whether it completed.")?;
    let mut bytes = Vec::new();
    response
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Office response is too large".into());
    }
    let response: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid office server response")?;
    if let Some(e) = response.get("error") {
        return Err(e.as_str().unwrap_or("Office request failed").into());
    }
    let mut data = response
        .get("data")
        .cloned()
        .ok_or("Invalid office server response")?;
    if data.get("revision").is_some() && data.get("accounts").is_some() {
        data["path"] = json!(format!("office://{}:{}/company", peer.address, peer.port));
        data["office"] = json!({"address":format!("{}:{}",peer.address,peer.port),"name":response["user"]["name"],"role":response["user"]["role"]});
    }
    Ok(data)
}
#[tauri::command]
pub async fn office_history(state: tauri::State<'_, Office>) -> Result<Value> {
    let path = state.0.inner.lock().map_err(err)?.config.company.clone();
    crate::blocking(move || {
        let snapshot = company::snapshot(Path::new(&path))?;
        let journal = company::journal_text(Path::new(&path), &snapshot.revision)?;
        Ok(json!(journal
            .lines()
            .filter_map(|line| line.strip_prefix("; ledgertrails-audit: "))
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .take(100)
            .collect::<Vec<_>>()))
    })
    .await
}
#[tauri::command]
pub async fn office_status(state: tauri::State<'_, Office>) -> Result<Value> {
    let s = state.inner().clone();
    crate::blocking(move || s.status()).await
}
#[tauri::command]
pub async fn office_configure(
    path: String,
    address: String,
    port: u16,
    state: tauri::State<'_, Office>,
) -> Result<Value> {
    let s = state.inner().clone();
    crate::blocking(move || {
        s.configure(path, address, port)?;
        s.status()
    })
    .await
}
#[tauri::command]
pub async fn office_start(state: tauri::State<'_, Office>) -> Result<Value> {
    if state.service_settings()?.0 {
        let s = state.inner().clone();
        crate::blocking(move || crate::office_service::control(&s, "start")).await?;
    } else {
        state.start().await?;
    }
    state.status()
}
#[tauri::command]
pub async fn office_stop(state: tauri::State<'_, Office>) -> Result<Value> {
    state.stop()?;
    for _ in 0..60 {
        if !state.is_host_running()? {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    state.status()
}
#[tauri::command]
pub fn office_invite(
    name: String,
    role: String,
    state: tauri::State<'_, Office>,
) -> Result<String> {
    state.invite(name, role)
}
#[tauri::command]
pub fn office_revoke(id: String, state: tauri::State<'_, Office>) -> Result<Value> {
    state.revoke(&id)?;
    state.status()
}
#[tauri::command]
pub async fn office_connect(
    code: Option<String>,
    state: tauri::State<'_, Office>,
) -> Result<Value> {
    let s = state.inner().clone();
    crate::blocking(move || s.connect(code)).await
}
#[tauri::command]
pub async fn office_request(
    command: String,
    args: Value,
    state: tauri::State<'_, Office>,
) -> Result<Value> {
    let s = state.inner().clone();
    crate::blocking(move || s.remote(command, args)).await
}
pub fn setup(app: &mut tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let office = Office::new(app.path().app_config_dir()?.join("office"));
    let config = office.0.inner.lock().map_err(err)?.config.clone();
    let enabled = config.enabled && !config.service_mode;
    app.manage(office.clone());
    if enabled {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = office.start().await {
                if let Ok(mut inner) = office.0.inner.lock() {
                    inner.error = Some(e);
                }
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Host {
        office: Office,
        _dir: tempfile::TempDir,
    }
    impl Drop for Host {
        fn drop(&mut self) {
            let _ = self.office.stop();
        }
    }
    fn host() -> Host {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("company.bky");
        company::create(
            &path,
            company::Details {
                name: "Office Test".into(),
                currency: "USD".into(),
            },
            false,
            None,
        )
        .unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let office = Office::new(dir.path().join("config"));
        office
            .configure(path.to_string_lossy().into(), "127.0.0.1".into(), port)
            .unwrap();
        tauri::async_runtime::block_on(office.start()).unwrap();
        Host { office, _dir: dir }
    }
    fn peer(office: &Office, name: &str, role: &str) -> Peer {
        let code = office.invite(name.into(), role.into()).unwrap();
        serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(code.strip_prefix("LT1-").unwrap())
                .unwrap(),
        )
        .unwrap()
    }
    fn entry(rev: &str) -> Value {
        json!({"revision":rev,"entry":{"date":"2026-10-05","description":"Office sale","debit":"assets:bank","credit":"income:sales","amount":"10.00","commodity":"USD"}})
    }
    #[test]
    fn tls_pinning_authentication_read_only_and_revocation() {
        let h = host();
        let reader = peer(&h.office, "Reader", "reader");
        let snapshot = call(&reader, "snapshot", json!({})).unwrap();
        assert_eq!(snapshot["office"]["role"], "reader");
        assert!(snapshot["path"].as_str().unwrap().starts_with("office://"));
        assert!(!snapshot
            .to_string()
            .contains(h._dir.path().to_str().unwrap()));
        assert!(call(
            &reader,
            "add_entry",
            entry(snapshot["revision"].as_str().unwrap())
        )
        .unwrap_err()
        .contains("read-only"));
        assert!(call(&reader, "save_workspace", json!({}))
            .unwrap_err()
            .contains("read-only"));
        let mut invalid = reader.clone();
        invalid.token = secret().unwrap();
        assert!(call(&invalid, "snapshot", json!({}))
            .unwrap_err()
            .contains("invalid or revoked"));
        invalid = reader.clone();
        invalid.certificate = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()])
            .unwrap()
            .cert
            .pem();
        assert!(call(&invalid, "snapshot", json!({}))
            .unwrap_err()
            .contains("securely"));
        let http = reqwest::blocking::Client::builder()
            .no_proxy()
            .tls_built_in_root_certs(false)
            .add_root_certificate(
                reqwest::Certificate::from_pem(reader.certificate.as_bytes()).unwrap(),
            )
            .build()
            .unwrap();
        let url = format!("https://{}:{}/v1/rpc", reader.address, reader.port);
        assert_eq!(
            http.post(&url)
                .body("invalid JSON")
                .send()
                .unwrap()
                .status()
                .as_u16(),
            401
        );
        assert_eq!(
            http.post(&url)
                .bearer_auth(&reader.token)
                .body("invalid JSON")
                .send()
                .unwrap()
                .status()
                .as_u16(),
            400
        );
        assert_eq!(
            http.post(&url)
                .bearer_auth(&reader.token)
                .body(vec![b' '; LIMIT + 1])
                .send()
                .unwrap()
                .status()
                .as_u16(),
            413
        );
        let capacity = h.office.0.slots.clone().try_acquire_many_owned(16).unwrap();
        assert!(call(&reader, "snapshot", json!({}))
            .unwrap_err()
            .contains("busy"));
        drop(capacity);
        let config = fs::read_to_string(h.office.0.folder.join("server.json")).unwrap();
        assert!(!config.contains(&reader.token));
        let id = h.office.status().unwrap()["users"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        h.office.revoke(&id).unwrap();
        assert!(call(&reader, "snapshot", json!({})).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(h.office.0.folder.join("server.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
    }
    #[test]
    fn concurrent_writes_reject_stale_revision_and_record_identity_atomically() {
        let h = host();
        let alice = peer(&h.office, "Alice", "editor");
        let bob = peer(&h.office, "Bob", "editor");
        let original = call(&alice, "snapshot", json!({})).unwrap();
        let revision = original["revision"].as_str().unwrap();
        let results = std::thread::scope(|scope| {
            let a = scope.spawn(|| call(&alice, "add_entry", entry(revision)));
            let b = scope.spawn(|| call(&bob, "add_entry", entry(revision)));
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(results
            .iter()
            .find_map(|r| r.as_ref().err())
            .unwrap()
            .contains("changed since"));
        let snapshot = call(&alice, "snapshot", json!({})).unwrap();
        assert_eq!(snapshot["transactions"].as_array().unwrap().len(), 1);
        let audit = call(&alice, "audit", json!({})).unwrap();
        assert_eq!(audit.as_array().unwrap().len(), 1);
        assert!(["Alice", "Bob"].contains(&audit[0]["actor"].as_str().unwrap()));
        assert_eq!(audit[0]["action"], "add_entry");
        assert_eq!(audit[0]["previous_revision"], revision);
        assert!(call(&alice, "open_company", json!({"path":"/etc/passwd"}))
            .unwrap_err()
            .contains("Unsupported"));
        assert!(
            call(&alice, "snapshot", json!({"path":"/etc/passwd"})).unwrap()["company"]["name"]
                == "Office Test"
        );
        let backup = call(
            &alice,
            "download_company",
            json!({"revision":snapshot["revision"]}),
        )
        .unwrap();
        let data = URL_SAFE_NO_PAD.decode(backup.as_str().unwrap()).unwrap();
        assert!(String::from_utf8(data)
            .unwrap()
            .contains("ledgertrails-audit"));
    }
    #[test]
    fn remote_workspace_and_csv_import_use_host_company_and_uploaded_content() {
        let h = host();
        let editor = peer(&h.office, "Bookkeeper", "editor");
        let snapshot = call(&editor, "snapshot", json!({})).unwrap();
        let mut workspace = call(
            &editor,
            "read_workspace",
            json!({"revision":snapshot["revision"]}),
        )
        .unwrap();
        workspace["budgets"] = json!([{"id":"one","account":"expenses:office","start":"2026-01-01","end":"2026-12-31","amount":"500","currency":"USD"}]);
        let next = call(
            &editor,
            "save_workspace",
            json!({"revision":snapshot["revision"],"value":workspace}),
        )
        .unwrap();
        let read = call(
            &editor,
            "read_workspace",
            json!({"revision":next["revision"]}),
        )
        .unwrap();
        assert_eq!(read["budgets"].as_array().unwrap().len(), 1);
        let csv="Date,Account,Description,Check #,Category,Credit,Debit\n10/05/2026,Checking,Office supplies,,Miscellaneous,,-10.00\n";
        let parsed = imports::parse(csv.as_bytes()).unwrap();
        let mappings: Value = parsed
            .sources
            .iter()
            .map(|s| (s.clone(), json!("assets:bank")))
            .collect();
        let preview=call(&editor,"review_statement",json!({"csv":csv,"path":"/not/a/server/path","fileRevision":parsed.file_revision,"revision":next["revision"],"mappings":mappings,"currency":"USD"})).unwrap();
        assert_eq!(preview["rows"].as_array().unwrap().len(), 1);
        let result=call(&editor,"import_statement",json!({"csv":csv,"request":{"path":"/not/a/server/path","file_revision":parsed.file_revision,"revision":next["revision"],"mappings":mappings,"currency":"USD","selections":[{"index":0,"category":"expenses:office"}]}})).unwrap();
        assert_eq!(result["imported"], 1);
        let audit = call(&editor, "audit", json!({})).unwrap();
        assert_eq!(audit[0]["action"], "import_statement");
    }
    #[test]
    fn settings_and_pairing_survive_restart_and_stopping_disables_access() {
        let h = host();
        let editor = peer(&h.office, "Alice", "editor");
        let client_dir = tempfile::tempdir().unwrap();
        let client = Office::new(client_dir.path().into());
        let code = format!(
            "LT1-{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&editor).unwrap())
        );
        let connected = client.connect(Some(code)).unwrap();
        let backup = client_dir.path().join("download.bkybk");
        client
            .remote(
                "copy_company".into(),
                json!({"path":backup,"revision":connected["revision"],"switch":false}),
            )
            .unwrap();
        assert_eq!(
            company::snapshot(&backup).unwrap().company.unwrap().name,
            "Office Test"
        );
        let exported = client_dir.path().join("report.html");
        assert!(client
            .remote(
                "export_document".into(),
                json!({"path":exported,"revision":"stale","content":"<p>report</p>"})
            )
            .is_err());
        assert!(!exported.exists());
        client
            .remote(
                "export_document".into(),
                json!({"path":exported,"revision":connected["revision"],"content":"<p>report</p>"}),
            )
            .unwrap();
        assert_eq!(fs::read_to_string(exported).unwrap(), "<p>report</p>");
        let loaded = Office::new(client_dir.path().into());
        assert!(loaded.status().unwrap()["savedConnection"].is_string());
        loaded.connect(None).unwrap();
        let config = Office::new(h.office.0.folder.clone());
        assert_eq!(config.status().unwrap()["enabled"], true);
        assert_eq!(
            config.status().unwrap()["users"].as_array().unwrap().len(),
            1
        );
        h.office.stop().unwrap();
        assert!(call(&editor, "snapshot", json!({})).is_err());
        for _ in 0..100 {
            if !h.office.0.running.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!h.office.0.running.load(Ordering::SeqCst));
        tauri::async_runtime::block_on(config.start()).unwrap();
        assert_eq!(
            call(&editor, "snapshot", json!({})).unwrap()["company"]["name"],
            "Office Test"
        );
        config.stop().unwrap();
        assert_eq!(
            Office::new(h.office.0.folder.clone()).status().unwrap()["enabled"],
            false
        );
    }
    #[test]
    fn office_addresses_are_private_and_configuration_does_not_expose_secrets() {
        assert!(address("0.0.0.0", 47831).is_err());
        assert!(address("8.8.8.8", 47831).is_err());
        assert!(address("192.168.1.2", 443).is_err());
        assert!(address("192.168.1.2", 47831).is_ok());
        let h = host();
        let _ = peer(&h.office, "Editor", "editor");
        let status = h.office.status().unwrap().to_string();
        assert!(!status.contains("PRIVATE KEY"));
        assert!(!status.contains("token_hash"));
        assert!(!status.contains("certificate"));
        assert!(h
            .office
            .configure("/etc/passwd".into(), "127.0.0.1".into(), 47831)
            .is_err());
    }
}
