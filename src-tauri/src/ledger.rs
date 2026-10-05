use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize)]
pub struct Amount {
    pub quantity: String,
    pub commodity: String,
}
#[derive(Serialize)]
pub struct Account {
    pub name: String,
    pub amounts: Vec<Amount>,
}
#[derive(Serialize)]
pub struct Posting {
    pub account: String,
    pub amounts: Vec<Amount>,
}
#[derive(Serialize)]
pub struct Transaction {
    pub date: String,
    pub description: String,
    pub postings: Vec<Posting>,
    pub source_line: Option<usize>,
    pub source_end: Option<usize>,
    pub editable: bool,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub company: Option<crate::company::Details>,
    pub path: String,
    pub revision: String,
    pub version: String,
    pub accounts: Vec<Account>,
    pub transactions: Vec<Transaction>,
}
#[derive(Deserialize)]
pub struct Entry {
    pub date: String,
    pub description: String,
    pub debit: String,
    pub credit: String,
    pub amount: String,
    pub commodity: String,
}
fn plain_posting(line: &str) -> bool {
    if !line.starts_with("    ") || line.contains(';') {
        return false;
    }
    let parts: Vec<_> = line.split_whitespace().collect();
    if !matches!(parts.len(), 1 | 3)
        || !parts[0].split(':').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        })
    {
        return false;
    }
    if parts.len() == 3 {
        let amount = parts[1].trim_start_matches('-');
        amount.len() <= 40
            && amount.split('.').count() <= 2
            && amount
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
            && !parts[2].is_empty()
            && parts[2].len() <= 12
            && parts[2].bytes().all(|c| c.is_ascii_uppercase())
    } else {
        true
    }
}
fn editable_span(text: &str, start: usize, end: usize) -> Result<(usize, usize, String)> {
    let offsets: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    if start == 0 || end <= start || end > offsets.len() {
        return Err("This transaction cannot be edited in LedgerTrails.".into());
    }
    let from = offsets[start - 1];
    let to = offsets[end - 1];
    let lines: Vec<_> = text[from..to].lines().collect();
    let first = lines
        .first()
        .ok_or("This transaction cannot be edited in LedgerTrails.")?;
    let comments: Vec<_> = lines
        .iter()
        .skip(1)
        .take_while(|line| line.starts_with("    ;"))
        .copied()
        .collect();
    let postings = &lines[1 + comments.len()..];
    let header = first.get(11..).unwrap_or("");
    if postings.len() != 2
        || chrono::NaiveDate::parse_from_str(first.get(..10).unwrap_or(""), "%Y-%m-%d").is_err()
        || !first.get(10..11).is_some_and(|s| s == " ")
        || header.starts_with("* ")
        || header.starts_with("! ")
        || header.contains(';')
        || header.contains('|')
        || postings.iter().any(|line| !plain_posting(line))
    {
        return Err(
            "This transaction has journal details that require editing in the journal file.".into(),
        );
    }
    let comments = comments.iter().map(|line| format!("{line}\n")).collect();
    Ok((from, to, comments))
}
pub fn replace_entry(text: &str, start: usize, end: usize, entry: &Entry) -> Result<String> {
    let (from, to, comments) = editable_span(text, start, end)?;
    let replacement = entry_text(entry)?;
    let header_end = replacement[1..].find('\n').ok_or("Invalid entry")? + 2;
    let replacement = format!(
        "{}{}{}",
        &replacement[..header_end],
        comments,
        &replacement[header_end..]
    );
    Ok(format!(
        "{}{}{}",
        &text[..from],
        replacement.trim_start_matches('\n'),
        &text[to..]
    ))
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub(crate) fn executable() -> PathBuf {
    // Release bundles put the platform-specific sidecar beside the application.
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name(if cfg!(windows) {
            "ledgertrails-hledger.exe"
        } else {
            "ledgertrails-hledger"
        });
        if sibling.is_file() {
            return sibling;
        }
    }
    std::env::var_os("LEDGERTRAILS_HLEDGER")
        .or_else(|| std::env::var_os("BOOKY_HLEDGER"))
        .map(PathBuf::from)
        .unwrap_or_else(|| "hledger".into())
}
fn run(path: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut command = Command::new(executable());
    command.env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if let Some(path) = path {
        command.arg("-f").arg(path);
    }
    let output = command.args(args).output().map_err(|e| {
        format!(
            "Could not start hledger: {e}. Install hledger or set LEDGERTRAILS_HLEDGER to its executable."
        )
    })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(err)
}
fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn quantity(v: &Value) -> Result<String> {
    let raw = v["decimalMantissa"]
        .as_number()
        .ok_or("Missing decimal mantissa")?
        .to_string();
    let places = v["decimalPlaces"]
        .as_u64()
        .ok_or("Missing decimal precision")? as usize;
    if places > 255 {
        return Err("Unsupported amount precision".into());
    }
    let negative = raw.starts_with('-');
    let digits = raw.trim_start_matches('-');
    let padded = format!("{:0>width$}", digits, width = places + 1);
    let unsigned = if places == 0 {
        padded
    } else {
        let split = padded.len() - places;
        format!("{}.{}", &padded[..split], &padded[split..])
    };
    Ok(format!("{}{unsigned}", if negative { "-" } else { "" }))
}
fn amounts(v: &Value) -> Result<Vec<Amount>> {
    v.as_array()
        .ok_or("Invalid hledger amount list")?
        .iter()
        .map(|a| {
            Ok(Amount {
                quantity: quantity(&a["aquantity"])?,
                commodity: a["acommodity"].as_str().ok_or("Missing commodity")?.into(),
            })
        })
        .collect()
}
fn string(v: &Value) -> Result<String> {
    v.as_str()
        .map(str::to_owned)
        .ok_or("Unexpected hledger JSON format".into())
}
pub fn snapshot(path: &Path) -> Result<Snapshot> {
    let before = fs::read(path).map_err(err)?;
    let version = run(None, &["--version"])?.trim().to_string();
    let balances: Value = serde_json::from_str(&run(
        Some(path),
        &["balance", "--flat", "--empty", "--declared", "-O", "json"],
    )?)
    .map_err(err)?;
    let accounts = balances[0]
        .as_array()
        .ok_or("Invalid balance report")?
        .iter()
        .map(|row| {
            Ok(Account {
                name: string(&row[0])?,
                amounts: amounts(&row[3])?,
            })
        })
        .collect::<Result<_>>()?;
    let printed: Value =
        serde_json::from_str(&run(Some(path), &["print", "-O", "json"])?).map_err(err)?;
    let transactions = printed
        .as_array()
        .ok_or("Invalid transaction report")?
        .iter()
        .map(|t| {
            let source = t["tsourcepos"].as_array();
            let start = source
                .and_then(|s| s.first())
                .and_then(|p| p["sourceLine"].as_u64())
                .map(|n| n as usize);
            let end = source
                .and_then(|s| s.get(1))
                .and_then(|p| p["sourceLine"].as_u64())
                .map(|n| n as usize);
            let local = source
                .and_then(|s| s.first())
                .and_then(|p| p["sourceName"].as_str())
                == Some(path.to_string_lossy().as_ref());
            let postings: Vec<Posting> = t["tpostings"]
                .as_array()
                .ok_or("Invalid postings")?
                .iter()
                .map(|p| {
                    Ok(Posting {
                        account: string(&p["paccount"])?,
                        amounts: amounts(&p["pamount"])?,
                    })
                })
                .collect::<Result<_>>()?;
            Ok(Transaction {
                date: string(&t["tdate"])?,
                description: string(&t["tdescription"])?,
                editable: local
                    && postings.len() == 2
                    && postings.iter().all(|p| p.amounts.len() == 1)
                    && postings[0].amounts[0].commodity == postings[1].amounts[0].commodity
                    && postings[0].amounts[0].quantity.starts_with('-')
                        != postings[1].amounts[0].quantity.starts_with('-')
                    && start.zip(end).is_some_and(|(a, b)| {
                        editable_span(&String::from_utf8_lossy(&before), a, b).is_ok()
                    }),
                source_line: if local { start } else { None },
                source_end: if local { end } else { None },
                postings,
            })
        })
        .collect::<Result<_>>()?;
    if fs::read(path).map_err(err)? != before {
        return Err("Journal changed while loading. Refresh and try again.".into());
    }
    Ok(Snapshot {
        company: None,
        path: path.to_string_lossy().into(),
        revision: revision(&before),
        version,
        accounts,
        transactions,
    })
}
#[cfg(test)]
pub fn create(path: &Path, sample: bool) -> Result<()> {
    // create_new refuses to overwrite an existing journal, even after a save-dialog confirmation.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(err)?;
    let content = if sample {
        include_str!("../../examples/sample.journal")
    } else {
        "; LedgerTrails journal\n; Account convention: assets, liabilities, income, expenses, equity.\n"
    };
    file.write_all(content.as_bytes()).map_err(err)?;
    file.sync_all().map_err(err)
}
pub(crate) fn entry_text(e: &Entry) -> Result<String> {
    let date = chrono::NaiveDate::parse_from_str(&e.date, "%Y-%m-%d")
        .map_err(|_| "Use a valid date in YYYY-MM-DD format")?;
    if date.format("%Y-%m-%d").to_string() != e.date {
        return Err("Use YYYY-MM-DD for the date".into());
    }
    if e.description.trim().is_empty()
        || e.description.len() > 240
        || e.description
            .chars()
            .any(|c| c.is_control() || c == ';' || c == '|')
    {
        return Err("Enter a description without control characters, semicolons or pipes".into());
    }
    for account in [&e.debit, &e.credit] {
        if account.is_empty()
            || account.len() > 200
            || !account.split(':').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            })
        {
            return Err("Use account names such as expenses:office (letters, numbers, hyphens and underscores)".into());
        }
    }
    if e.debit == e.credit {
        return Err("Choose two different accounts".into());
    }
    let parts: Vec<_> = e.amount.split('.').collect();
    if parts.len() > 2
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
        || e.amount.len() > 40
        || !e.amount.bytes().any(|c| matches!(c, b'1'..=b'9'))
    {
        return Err("Amount must be a positive decimal, such as 42.50".into());
    }
    if e.commodity.is_empty()
        || e.commodity.len() > 12
        || !e.commodity.bytes().all(|c| c.is_ascii_uppercase())
    {
        return Err("Use an uppercase currency or commodity code, such as USD".into());
    }
    Ok(format!(
        "\n{} {}\n    {}    {} {}\n    {}    -{} {}\n",
        e.date,
        e.description.trim(),
        e.debit,
        e.amount,
        e.commodity,
        e.credit,
        e.amount,
        e.commodity
    ))
}
pub fn append(path: &Path, expected: &str, entry: &Entry) -> Result<()> {
    let text = entry_text(entry)?;
    append_text(path, expected, &text)
}
pub(crate) fn append_text(path: &Path, expected: &str, text: &str) -> Result<()> {
    write_text(path, expected, |original| {
        let mut updated = original.to_vec();
        updated.extend_from_slice(text.as_bytes());
        Ok(updated)
    })
}
pub fn edit(path: &Path, expected: &str, start: usize, end: usize, entry: &Entry) -> Result<()> {
    write_text(path, expected, |original| {
        Ok(replace_entry(
            std::str::from_utf8(original).map_err(err)?,
            start,
            end,
            entry,
        )?
        .into_bytes())
    })
}
fn write_text(
    path: &Path,
    expected: &str,
    change: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<()> {
    let lock_path = PathBuf::from(format!("{}.bky-lock", path.display()));
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(err)?;
    lock.try_lock_exclusive().map_err(|_| {
        "Another LedgerTrails operation is writing this journal. Try again.".to_string()
    })?;
    let original = fs::read(path).map_err(err)?;
    if revision(&original) != expected {
        return Err("Journal changed since it was loaded. Refresh before saving.".into());
    }
    // Included journals need a revision covering every file before writes can be supported safely.
    if run(Some(path), &["files"])?.lines().count() != 1 {
        return Err("Journals with included files are view-only in this version.".into());
    }
    let parent = path.parent().ok_or("Journal has no parent directory")?;
    let mut candidate = tempfile::Builder::new()
        .prefix(".bky-")
        .suffix(".journal")
        .tempfile_in(parent)
        .map_err(err)?;
    candidate.write_all(&change(&original)?).map_err(err)?;
    candidate
        .as_file()
        .set_permissions(fs::metadata(path).map_err(err)?.permissions())
        .map_err(err)?;
    candidate.as_file().sync_all().map_err(err)?;
    run(Some(candidate.path()), &["check"])?;
    if fs::read(path).map_err(err)? != original {
        return Err("Journal changed during validation. Refresh before saving.".into());
    }
    let backup_path = PathBuf::from(format!(
        "{}.backup-{}",
        path.display(),
        &revision(&original)
    ));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup_path)
    {
        Ok(mut backup) => {
            backup
                .set_permissions(fs::metadata(path).map_err(err)?.permissions())
                .map_err(err)?;
            backup.write_all(&original).map_err(err)?;
            backup.sync_all().map_err(err)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if fs::read(&backup_path).map_err(err)? != original {
                return Err("Existing backup does not match the journal. Save cancelled.".into());
            }
        }
        Err(e) => return Err(err(e)),
    }
    candidate.persist(path).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> Entry {
        Entry {
            date: "2026-10-04".into(),
            description: "Coffee".into(),
            debit: "expenses:food".into(),
            credit: "assets:bank:checking".into(),
            amount: "4.25".into(),
            commodity: "USD".into(),
        }
    }
    #[test]
    fn declared_accounts_available_without_transactions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("categories.journal");
        fs::write(
            &path,
            "account expenses:office\naccount liabilities:sales-tax:oklahoma\n",
        )
        .unwrap();
        let books = snapshot(&path).unwrap();
        assert!(books.transactions.is_empty());
        for name in ["expenses:office", "liabilities:sales-tax:oklahoma"] {
            assert!(books.accounts.iter().any(|a| a.name == name));
        }
    }
    #[test]
    fn exact_decimals() {
        let v: Value =
            serde_json::from_str(r#"{"decimalMantissa":900719925474099312345,"decimalPlaces":5}"#)
                .unwrap();
        assert_eq!(quantity(&v).unwrap(), "9007199254740993.12345");
        assert_eq!(
            quantity(&serde_json::json!({"decimalMantissa":-1,"decimalPlaces":3})).unwrap(),
            "-0.001"
        );
    }
    #[test]
    fn rejects_injection_and_invalid_amounts() {
        let mut e = entry();
        e.description = "Coffee\n2026-10-05 injected".into();
        assert!(entry_text(&e).is_err());
        let mut e = entry();
        e.debit = "expenses:food  200 USD".into();
        assert!(entry_text(&e).is_err());
        for amount in ["0", "-1", "1e3", "1,00", "1\n", ".", "1."] {
            let mut e = entry();
            e.amount = amount.into();
            assert!(entry_text(&e).is_err());
        }
        let mut e = entry();
        e.date = "2026-02-30".into();
        assert!(entry_text(&e).is_err());
    }
    #[test]
    fn real_hledger_roundtrip_and_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("books.journal");
        create(&path, true).unwrap();
        assert!(create(&path, false).is_err());
        let before = snapshot(&path).unwrap();
        assert_eq!(before.transactions.len(), 5);
        append(&path, &before.revision, &entry()).unwrap();
        let after = snapshot(&path).unwrap();
        assert_eq!(after.transactions.len(), 6);
        assert_eq!(
            after
                .accounts
                .iter()
                .find(|a| a.name == "expenses:food")
                .unwrap()
                .amounts[0]
                .quantity,
            "4.25"
        );
        let bytes = fs::read(&path).unwrap();
        assert!(append(&path, &before.revision, &entry()).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(PathBuf::from(format!("{}.backup-{}", path.display(), before.revision)).exists());
    }
    #[test]
    fn edits_only_selected_transaction_and_rejects_stale_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("books.journal");
        create(&path, true).unwrap();
        let before = snapshot(&path).unwrap();
        let selected = before
            .transactions
            .iter()
            .find(|t| t.description == "Office supplies")
            .unwrap();
        assert!(selected.editable);
        let mut changed = entry();
        changed.description = "Updated office supplies".into();
        edit(
            &path,
            &before.revision,
            selected.source_line.unwrap(),
            selected.source_end.unwrap(),
            &changed,
        )
        .unwrap();
        let after = snapshot(&path).unwrap();
        assert_eq!(after.transactions.len(), before.transactions.len());
        assert!(after
            .transactions
            .iter()
            .any(|t| t.description == "Updated office supplies"));
        assert!(after
            .transactions
            .iter()
            .any(|t| t.description == "Client payment"));
        assert!(edit(
            &path,
            &before.revision,
            selected.source_line.unwrap(),
            selected.source_end.unwrap(),
            &changed
        )
        .is_err());
        assert!(PathBuf::from(format!("{}.backup-{}", path.display(), before.revision)).exists());
    }
    #[test]
    fn edit_preserves_import_identity_and_other_journal_text() {
        let original = "2026-10-01 Imported\n    ; booky-import: abc123\n    ; bank-source: [\"original\"]\n    expenses:office  5 USD\n    assets:bank  -5 USD\n\n; separate note\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("imported.journal");
        fs::write(&path, original).unwrap();
        let before = snapshot(&path).unwrap();
        let transaction = &before.transactions[0];
        assert!(transaction.editable);
        let updated = replace_entry(
            original,
            transaction.source_line.unwrap(),
            transaction.source_end.unwrap(),
            &entry(),
        )
        .unwrap();
        assert!(updated.contains("booky-import: abc123"));
        assert!(updated.contains("bank-source: [\"original\"]"));
        assert!(updated.contains("; separate note"));
        assert!(updated.contains("2026-10-04 Coffee"));
    }
    #[test]
    fn validation_failure_preserves_journal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("books.journal");
        fs::write(
            &path,
            "2026-10-05 Assertion\n    assets:bank:checking    0 USD = 0 USD\n    equity:opening\n",
        )
        .unwrap();
        let original = fs::read(&path).unwrap();
        let rev = snapshot(&path).unwrap().revision;
        let error = append(&path, &rev, &entry()).unwrap_err();
        assert!(
            error.to_lowercase().contains("balance assertion failed"),
            "{error}"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    }
    #[test]
    fn included_journals_are_view_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("books.journal");
        fs::write(
            dir.path().join("child.journal"),
            include_str!("../../examples/sample.journal"),
        )
        .unwrap();
        fs::write(&path, "include child.journal\n").unwrap();
        let before = snapshot(&path).unwrap();
        assert!(append(&path, &before.revision, &entry())
            .unwrap_err()
            .contains("view-only"));
    }
}
