mod company;
mod imports;
mod ledger;
mod review;
mod workspace;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::State;

struct Active {
    path: PathBuf,
    company: bool,
}
impl Active {
    fn snapshot(&self) -> ledger::Result<ledger::Snapshot> {
        if self.company {
            company::snapshot(&self.path)
        } else {
            ledger::snapshot(&self.path)
        }
    }
}
#[derive(Clone, Default)]
struct Books(Arc<Mutex<Option<Active>>>);
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> ledger::Result<T> + Send + 'static,
) -> ledger::Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_journal(path: String, state: State<'_, Books>) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let mut selected = books.0.lock().map_err(|e| e.to_string())?;
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        let active = Active {
            path,
            company: false,
        };
        let snapshot = active.snapshot()?;
        *selected = Some(active);
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn open_company(path: String, state: State<'_, Books>) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let mut selected = books.0.lock().map_err(|e| e.to_string())?;
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("bkybk"))
        {
            return Err("Use Restore backup to create a working company copy.".into());
        }
        let active = Active {
            path,
            company: true,
        };
        let snapshot = active.snapshot()?;
        *selected = Some(active);
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn create_company(
    path: String,
    details: company::Details,
    sample: bool,
    source: Option<String>,
    state: State<'_, Books>,
) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let mut selected = books.0.lock().map_err(|e| e.to_string())?;
        let path = PathBuf::from(path);
        let source = source.map(PathBuf::from);
        let snapshot = company::create(&path, details, sample, source.as_deref())?;
        *selected = Some(Active {
            path,
            company: true,
        });
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn restore_company(
    source: String,
    path: String,
    state: State<'_, Books>,
) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let mut selected = books.0.lock().map_err(|e| e.to_string())?;
        let path = PathBuf::from(path);
        let snapshot = company::restore(&PathBuf::from(source), &path)?;
        *selected = Some(Active {
            path,
            company: true,
        });
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn save_company(
    revision: String,
    state: State<'_, Books>,
) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file first")?;
        company::save(&active.path, &revision)
    })
    .await
}
#[tauri::command]
async fn copy_company(
    path: String,
    revision: String,
    switch: bool,
    state: State<'_, Books>,
) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let mut selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file first")?;
        let destination = PathBuf::from(path);
        let snapshot = company::copy(&active.path, &revision, &destination)?;
        if switch {
            *selected = Some(Active {
                path: destination,
                company: true,
            });
        }
        Ok(snapshot)
    })
    .await
}
#[tauri::command]
async fn refresh_journal(state: State<'_, Books>) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        selected
            .as_ref()
            .ok_or("Open a company or journal first")?
            .snapshot()
    })
    .await
}
#[tauri::command]
async fn add_entry(
    entry: ledger::Entry,
    revision: String,
    state: State<'_, Books>,
) -> ledger::Result<()> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected.as_ref().ok_or("Open a company or journal first")?;
        if active.company {
            company::append(&active.path, &revision, &entry)
        } else {
            ledger::append(&active.path, &revision, &entry)
        }
    })
    .await
}
#[tauri::command]
async fn parse_statement(path: String) -> ledger::Result<imports::Parsed> {
    blocking(move || imports::read(&PathBuf::from(path))).await
}
#[tauri::command]
async fn review_statement(
    path: String,
    file_revision: String,
    revision: String,
    mappings: std::collections::BTreeMap<String, String>,
    currency: String,
    state: State<'_, Books>,
) -> ledger::Result<imports::Preview> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file before importing")?;
        imports::review(
            &active.path,
            &PathBuf::from(path),
            &file_revision,
            &revision,
            &mappings,
            &currency,
        )
    })
    .await
}
#[tauri::command]
async fn import_statement(
    request: imports::Request,
    state: State<'_, Books>,
) -> ledger::Result<imports::Outcome> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file before importing")?;
        imports::commit(&active.path, &request)
    })
    .await
}
#[tauri::command]
async fn list_review(
    revision: String,
    state: State<'_, Books>,
) -> ledger::Result<Vec<review::Row>> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file first")?;
        Ok(review::rows(&company::journal_text(
            &active.path,
            &revision,
        )?))
    })
    .await
}
#[tauri::command]
async fn categorize_review(
    revision: String,
    changes: Vec<review::Change>,
    state: State<'_, Books>,
) -> ledger::Result<()> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file first")?;
        review::commit(&active.path, &revision, changes)
    })
    .await
}
#[tauri::command]
async fn read_workspace(
    revision: String,
    state: State<'_, Books>,
) -> ledger::Result<workspace::Workspace> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file first")?;
        workspace::read(&active.path, &revision)
    })
    .await
}
#[tauri::command]
async fn save_workspace(
    revision: String,
    value: workspace::Workspace,
    state: State<'_, Books>,
) -> ledger::Result<ledger::Snapshot> {
    let books = state.inner().clone();
    blocking(move || {
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected
            .as_ref()
            .filter(|a| a.company)
            .ok_or("Open a company file first")?;
        workspace::save(&active.path, &revision, value)?;
        active.snapshot()
    })
    .await
}
#[tauri::command]
async fn export_document(
    path: String,
    content: String,
    revision: String,
    state: State<'_, Books>,
) -> ledger::Result<()> {
    let books = state.inner().clone();
    blocking(move || {
        use std::io::Write;
        let selected = books.0.lock().map_err(|e| e.to_string())?;
        let active = selected.as_ref().ok_or("Open books first")?;
        if active.snapshot()?.revision != revision {
            return Err("Company changed. Refresh before exporting.".into());
        }
        let path = PathBuf::from(path);
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !["html", "csv"].contains(&ext) || content.len() > 20_000_000 {
            return Err("Choose an HTML or CSV destination (maximum 20 MB)".into());
        }
        let mut temp =
            tempfile::NamedTempFile::new_in(path.parent().ok_or("Choose a destination folder")?)
                .map_err(|e| e.to_string())?;
        temp.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist_noclobber(path)
            .map_err(|e| format!("Export not saved; choose a new filename: {e}"))?;
        Ok(())
    })
    .await
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Books::default())
        .invoke_handler(tauri::generate_handler![
            open_journal,
            open_company,
            create_company,
            restore_company,
            save_company,
            copy_company,
            refresh_journal,
            add_entry,
            parse_statement,
            review_statement,
            import_statement,
            list_review,
            categorize_review,
            read_workspace,
            save_workspace,
            export_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running LedgerTrails");
}
