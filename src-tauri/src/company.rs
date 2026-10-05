//! Versioned, self-contained company documents. No archive extraction or external includes.
use crate::ledger::{self, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Details {
    pub name: String,
    pub currency: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    format: String,
    version: u32,
    company: Details,
    journal: String,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validate_details(details: &Details) -> Result<()> {
    if details.name.trim().is_empty()
        || details.name.len() > 120
        || details.name.chars().any(char::is_control)
    {
        return Err("Enter a company name of 1–120 characters.".into());
    }
    if details.currency.len() != 3 || !details.currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("Use a three-letter uppercase currency code, such as USD.".into());
    }
    Ok(())
}
fn decode(bytes: &[u8]) -> Result<Document> {
    let document: Document =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid company file: {e}"))?;
    if document.format != "booky-company" && document.format != "wwt-finance-company" {
        return Err("This is not a LedgerTrails company file.".into());
    }
    if document.version != 1 {
        return Err(format!(
            "Company file version {} is not supported. The original file has not been changed.",
            document.version
        ));
    }
    validate_details(&document.company)?;
    Ok(document)
}
fn journal(document: &Document) -> Result<(tempfile::TempDir, PathBuf)> {
    // hledger include directives can reach outside the company file. Never evaluate them.
    if document.journal.lines().any(|line| {
        line.trim_start_matches('\u{feff}')
            .split_whitespace()
            .next()
            == Some("include")
    }) {
        return Err(
            "Company files must be self-contained. External journal includes are not supported."
                .into(),
        );
    }
    let dir = tempfile::tempdir().map_err(err)?;
    let path = dir.path().join("company.journal");
    fs::write(&path, &document.journal).map_err(err)?;
    Ok((dir, path))
}
fn report(path: &Path, bytes: &[u8], document: &Document) -> Result<ledger::Snapshot> {
    let (_temp, journal) = journal(document)?;
    let mut snapshot = ledger::snapshot(&journal)?;
    snapshot.path = path.to_string_lossy().into();
    snapshot.revision = revision(bytes);
    snapshot.company = Some(document.company.clone());
    Ok(snapshot)
}
pub fn snapshot(path: &Path) -> Result<ledger::Snapshot> {
    let bytes = fs::read(path).map_err(err)?;
    let snapshot = report(path, &bytes, &decode(&bytes)?)?;
    if fs::read(path).map_err(err)? != bytes {
        return Err("Company file changed while loading. Refresh and try again.".into());
    }
    Ok(snapshot)
}
fn encode(document: &Document) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(document).map_err(err)?;
    bytes.push(b'\n');
    Ok(bytes)
}
fn new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Choose a destination folder")?)
            .map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist_noclobber(path)
        .map_err(|e| format!("Could not create file. Choose an unused filename: {e}"))?;
    Ok(())
}
pub fn create(
    path: &Path,
    details: Details,
    sample: bool,
    source: Option<&Path>,
) -> Result<ledger::Snapshot> {
    validate_details(&details)?;
    let text = if let Some(source) = source {
        fs::read_to_string(source).map_err(err)?
    } else if sample {
        include_str!("../../examples/sample.journal").into()
    } else {
        "; LedgerTrails company journal\n".into()
    };
    let document = Document {
        format: "booky-company".into(),
        version: 1,
        company: details,
        journal: text,
    };
    let bytes = encode(&document)?;
    let snapshot = report(path, &bytes, &document)?;
    new_file(path, &bytes)?;
    Ok(snapshot)
}
fn lock(path: &Path) -> Result<File> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(format!("{}.bky-lock", path.display()))
        .map_err(err)?;
    lock.try_lock_exclusive().map_err(|_| {
        "Another LedgerTrails operation is using this company file. Try again.".to_string()
    })?;
    Ok(lock)
}
fn current(path: &Path, expected: &str) -> Result<Vec<u8>> {
    let bytes = fs::read(path).map_err(err)?;
    if revision(&bytes) != expected {
        return Err(
            "Company file changed since it was loaded. Refresh before saving or backing up.".into(),
        );
    }
    Ok(bytes)
}
pub fn append(path: &Path, expected: &str, entry: &ledger::Entry) -> Result<()> {
    let text = ledger::entry_text(entry)?;
    update(path, expected, |_| Ok((text, ())))
}
pub(crate) fn journal_text(path: &Path, expected: &str) -> Result<String> {
    Ok(decode(&current(path, expected)?)?.journal)
}
pub(crate) fn update<T>(
    path: &Path,
    expected: &str,
    changes: impl FnOnce(&str) -> Result<(String, T)>,
) -> Result<T> {
    rewrite(path, expected, |journal| {
        let (text, outcome) = changes(journal)?;
        if text.is_empty() {
            return Ok((String::new(), outcome));
        }
        Ok((format!("{journal}{text}"), outcome))
    })
}
pub(crate) fn rewrite<T>(
    path: &Path,
    expected: &str,
    changes: impl FnOnce(&str) -> Result<(String, T)>,
) -> Result<T> {
    let _lock = lock(path)?;
    let original = current(path, expected)?;
    let mut document = decode(&original)?;
    let (text, outcome) = changes(&document.journal)?;
    if text.is_empty() {
        return Ok(outcome);
    }
    let (_temp, journal) = journal(&document)?;

    fs::write(&journal, &text).map_err(err)?;
    ledger::snapshot(&journal)?;
    document.journal = fs::read_to_string(journal).map_err(err)?;
    let bytes = encode(&document)?;
    let parent = path.parent().ok_or("Company file has no parent folder")?;
    let mut candidate = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    candidate.write_all(&bytes).map_err(err)?;
    candidate
        .as_file()
        .set_permissions(fs::metadata(path).map_err(err)?.permissions())
        .map_err(err)?;
    candidate.as_file().sync_all().map_err(err)?;
    let backups = parent.join(format!(
        "{}.backups",
        path.file_name()
            .ok_or("Invalid company filename")?
            .to_string_lossy()
    ));
    fs::create_dir_all(&backups).map_err(err)?;
    let backup = backups.join(format!("{expected}.bkybk"));
    if backup.exists() {
        if fs::read(&backup).map_err(err)? != original {
            return Err("Existing automatic backup is damaged. Save cancelled.".into());
        }
    } else {
        new_file(&backup, &original)?;
    }
    current(path, expected)?;
    candidate.persist(path).map_err(err)?;
    Ok(outcome)
}
/// Transactions save immediately. Explicit Save verifies the on-disk revision and flushes it.
pub fn save(path: &Path, expected: &str) -> Result<ledger::Snapshot> {
    let _lock = lock(path)?;
    let bytes = current(path, expected)?;
    let snapshot = report(path, &bytes, &decode(&bytes)?)?;
    OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(err)?
        .sync_all()
        .map_err(err)?;
    current(path, expected)?;
    Ok(snapshot)
}
pub fn copy(path: &Path, expected: &str, destination: &Path) -> Result<ledger::Snapshot> {
    let _lock = lock(path)?;
    let bytes = current(path, expected)?;
    let snapshot = report(destination, &bytes, &decode(&bytes)?)?;
    current(path, expected)?;
    new_file(destination, &bytes)?;
    Ok(snapshot)
}
pub fn restore(source: &Path, destination: &Path) -> Result<ledger::Snapshot> {
    let bytes = fs::read(source).map_err(err)?;
    let snapshot = report(destination, &bytes, &decode(&bytes)?)?;
    if fs::read(source).map_err(err)? != bytes {
        return Err("Source changed while restoring. Try again.".into());
    }
    new_file(destination, &bytes)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn details() -> Details {
        Details {
            name: "Example Company".into(),
            currency: "USD".into(),
        }
    }
    fn entry() -> ledger::Entry {
        ledger::Entry {
            date: "2026-10-04".into(),
            description: "Company test".into(),
            debit: "expenses:office".into(),
            credit: "assets:bank:checking".into(),
            amount: "12.34".into(),
            commodity: "USD".into(),
        }
    }
    #[test]
    fn portable_backup_restore_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("company.bky");
        let initial = create(&path, details(), true, None).unwrap();
        append(&path, &initial.revision, &entry()).unwrap();
        let saved = snapshot(&path).unwrap();
        assert_eq!(saved.transactions.len(), 6);
        assert_eq!(saved.company.unwrap().name, "Example Company");
        let automatic = dir
            .path()
            .join("company.bky.backups")
            .join(format!("{}.bkybk", initial.revision));
        assert_eq!(snapshot(&automatic).unwrap().transactions.len(), 5);
        let backup = dir.path().join("transfer.bkybk");
        copy(&path, &saved.revision, &backup).unwrap();
        fs::remove_file(&path).unwrap(); // The backup must not depend on the original company or its folder.
        let destination = dir.path().join("restored.bky");
        let restored = restore(&backup, &destination).unwrap();
        assert_eq!(restored.transactions.len(), 6);
        assert_eq!(restored.revision, saved.revision);
        assert!(restore(&backup, &destination).is_err());
        append(&destination, &restored.revision, &entry()).unwrap();
        assert_eq!(snapshot(&backup).unwrap().transactions.len(), 6);
        assert_eq!(snapshot(&destination).unwrap().transactions.len(), 7);
    }
    #[test]
    fn invalid_uploads_do_not_create_or_replace_files() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("bad.bkybk");
        let dest = dir.path().join("new.bky");
        fs::write(&source, b"not a company").unwrap();
        assert!(restore(&source, &dest).is_err());
        assert!(!dest.exists());
        let mut doc = Document {
            format: "booky-company".into(),
            version: 99,
            company: details(),
            journal: String::new(),
        };
        fs::write(&source, encode(&doc).unwrap()).unwrap();
        assert!(restore(&source, &dest)
            .err()
            .unwrap()
            .contains("version 99"));
        doc.version = 1;
        doc.journal = "include /private/data.journal\n".into();
        fs::write(&source, encode(&doc).unwrap()).unwrap();
        assert!(restore(&source, &dest)
            .err()
            .unwrap()
            .contains("self-contained"));
        doc.journal =
            "2026-10-04 Unbalanced\n    assets:bank    3 USD\n    expenses:food    4 USD\n".into();
        fs::write(&source, encode(&doc).unwrap()).unwrap();
        assert!(restore(&source, &dest).is_err());
        assert!(!dest.exists());
    }
    #[test]
    fn stale_writes_backups_and_overwrites_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("books.bky");
        let original = create(&path, details(), false, None).unwrap();
        assert!(create(&path, details(), true, None).is_err());
        append(&path, &original.revision, &entry()).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(append(&path, &original.revision, &entry()).is_err());
        assert!(copy(&path, &original.revision, &dir.path().join("stale.bkybk")).is_err());
        assert!(save(&path, &original.revision).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let current = snapshot(&path).unwrap();
        assert!(copy(&path, &current.revision, &path).is_err());
        assert_eq!(
            save(&path, &current.revision).unwrap().revision,
            current.revision
        );
    }
    #[test]
    fn imports_journal_without_changing_source_and_locks_writers() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.journal");
        let dest = dir.path().join("company.bky");
        let text = include_str!("../../examples/sample.journal");
        fs::write(&source, text).unwrap();
        let company = create(&dest, details(), false, Some(&source)).unwrap();
        assert_eq!(company.transactions.len(), 5);
        assert_eq!(fs::read_to_string(source).unwrap(), text);
        let _lock = lock(&dest).unwrap();
        assert!(append(&dest, &company.revision, &entry())
            .unwrap_err()
            .contains("Another"));
    }
}
