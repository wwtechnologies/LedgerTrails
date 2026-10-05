use crate::{
    company,
    ledger::{self, Result},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
};

#[derive(Clone, Serialize)]
pub struct Row {
    pub index: usize,
    pub line: u64,
    pub date: String,
    pub source: String,
    pub description: String,
    pub category: String,
    pub check: String,
    pub amount: String,
    pub opening: bool,
    pub id: String,
}
#[derive(Serialize)]
pub struct Parsed {
    pub bank: String,
    pub file_revision: String,
    pub sources: Vec<String>,
    pub rows: Vec<Row>,
    pub credits: String,
    pub debits: String,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
pub struct PreviewRow {
    #[serde(flatten)]
    pub row: Row,
    pub duplicate: bool,
}
#[derive(Serialize)]
pub struct Preview {
    pub parsed: Parsed,
    pub rows: Vec<PreviewRow>,
}
#[derive(Deserialize)]
pub struct Selection {
    pub index: usize,
    pub category: String,
}
#[derive(Deserialize)]
pub struct Request {
    pub path: String,
    pub file_revision: String,
    pub revision: String,
    pub mappings: BTreeMap<String, String>,
    pub currency: String,
    pub selections: Vec<Selection>,
}
#[derive(Serialize)]
pub struct Outcome {
    pub imported: usize,
    pub skipped: usize,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn money(value: i128) -> String {
    format!(
        "{}{}.{:02}",
        if value < 0 { "-" } else { "" },
        value.abs() / 100,
        value.abs() % 100
    )
}
fn cents(raw: &str) -> Result<i128> {
    let mut s = raw.trim();
    let mut negative = false;
    if s.starts_with('(') && s.ends_with(')') {
        negative = true;
        s = &s[1..s.len() - 1];
    }
    if let Some(rest) = s.strip_prefix('-') {
        if negative {
            return Err("Repeated minus sign".into());
        }
        negative = true;
        s = rest;
    } else if let Some(rest) = s.strip_prefix('+') {
        s = rest;
    }
    if let Some(rest) = s.strip_prefix('$') {
        s = rest;
    }
    let parts: Vec<_> = s.split('.').collect();
    if parts.is_empty() || parts.len() > 2 || parts[0].is_empty() {
        return Err("Invalid amount".into());
    }
    let groups: Vec<_> = parts[0].split(',').collect();
    if groups.len() > 1 && (groups[0].len() > 3 || groups.iter().skip(1).any(|g| g.len() != 3)) {
        return Err("Invalid amount grouping".into());
    }
    if groups
        .iter()
        .any(|g| g.is_empty() || !g.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("Invalid amount digits".into());
    }
    let whole = groups.join("");
    if whole.len() > 18 {
        return Err("Amount is too large".into());
    }
    let fraction = parts.get(1).copied().unwrap_or("");
    if fraction.len() > 2 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Expected at most two decimal places".into());
    }
    let value = whole.parse::<i128>().map_err(|_| "Invalid amount")? * 100
        + format!("{fraction:0<2}")
            .parse::<i128>()
            .map_err(|_| "Invalid fraction")?;
    Ok(if negative { -value } else { value })
}
fn date(raw: &str) -> Result<String> {
    chrono::NaiveDate::parse_from_str(raw.trim(), "%m/%d/%Y")
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|_| "Expected a valid MM/DD/YYYY date".into())
}
pub fn read(path: &Path) -> Result<Parsed> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 20_000_000 {
        return Err("CSV exceeds the 20 MB import limit".into());
    }
    parse(&fs::read(path).map_err(|e| e.to_string())?)
}
pub fn parse(bytes: &[u8]) -> Result<Parsed> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Save the CSV using UTF-8 encoding")?
        .trim_start_matches('\u{feff}');
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let records = reader
        .records()
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| format!("Invalid CSV: {e}"))?;
    let arvest = [
        "Date",
        "Account",
        "Description",
        "Check #",
        "Category",
        "Credit",
        "Debit",
    ];
    let boa = ["Date", "Description", "Amount", "Running Bal."];
    let header = records
        .iter()
        .position(|r| r.iter().map(str::trim).eq(arvest) || r.iter().map(str::trim).eq(boa))
        .ok_or(
            "CSV format not recognized. Choose an Arvest or Bank of America transaction export.",
        )?;
    let is_arvest = records[header].len() == 7;
    let bank = if is_arvest {
        "Arvest"
    } else {
        "Bank of America"
    };
    let mut rows = Vec::new();
    let mut sources = HashSet::new();
    let mut occurrences = HashMap::<String, usize>::new();
    let mut credits = 0;
    let mut debits = 0;
    let mut skipped_zero = 0;
    let mut has_opening = false;
    let mut current_source = String::new();
    if is_arvest && header > 0 && records[header - 1].len() == 2 {
        current_source = format!(
            "{} {}",
            records[header - 1][0].trim(),
            records[header - 1][1].trim()
        );
    }
    let mut expected_totals = None;
    for record in records.iter().skip(header + 1) {
        let line = record.position().map(|p| p.line()).unwrap_or(0);
        let fail = |msg: &str| format!("CSV line {line}: {msg}. No transactions were imported.");
        if record.iter().all(|s| s.trim().is_empty()) {
            continue;
        }
        if is_arvest && record.iter().map(str::trim).eq(arvest) {
            continue;
        }
        if is_arvest && record.len() == 2 && !record[0].trim().is_empty() && record[1].contains('*')
        {
            current_source = format!("{} {}", record[0].trim(), record[1].trim());
            continue;
        }
        if is_arvest
            && record.len() == 7
            && record[0].trim().is_empty()
            && record[3].trim() == "Totals:"
        {
            // Multi-section exports can have per-account footers; validate only the final global totals when there is one.
            if expected_totals.is_some() {
                return Err(fail(
                    "Multiple totals sections are not supported; export each account separately",
                ));
            }
            expected_totals = Some((
                cents(&record[5]).map_err(|e| fail(&e))?,
                cents(&record[6]).map_err(|e| fail(&e))?.abs(),
            ));
            continue;
        }
        if record.len() != if is_arvest { 7 } else { 4 } {
            return Err(fail("Unexpected column count"));
        }
        let parsed_date = date(&record[0]).map_err(|e| fail(&e))?;
        let description = record[if is_arvest { 2 } else { 1 }].trim().to_string();
        if description.is_empty() {
            return Err(fail("Missing description"));
        }
        let mut opening = false;
        let (amount, source, category, check): (i128, String, String, String) = if is_arvest {
            let credit = if record[5].trim().is_empty() {
                0
            } else {
                cents(&record[5]).map_err(|e| fail(&e))?
            };
            let debit = if record[6].trim().is_empty() {
                0
            } else {
                cents(&record[6]).map_err(|e| fail(&e))?
            };
            if credit < 0 || (credit != 0 && debit != 0) {
                return Err(fail("Ambiguous credit/debit amounts"));
            }
            if record[5].trim().is_empty() && record[6].trim().is_empty() {
                return Err(fail("Missing credit and debit"));
            }
            if record[1].trim().is_empty() {
                return Err(fail("Missing source account"));
            }
            let source =
                if !current_source.is_empty() && current_source.starts_with(record[1].trim()) {
                    current_source.clone()
                } else {
                    record[1].trim().to_string()
                };
            if source.is_empty() {
                return Err(fail("Missing source account"));
            }
            (
                credit - debit.abs(),
                source,
                record[4].trim().into(),
                record[3].trim().into(),
            )
        } else {
            let value = if record[2].trim().is_empty()
                && description.starts_with("Beginning balance as of ")
            {
                opening = true;
                has_opening = true;
                cents(&record[3])
            } else {
                cents(&record[2])
            }
            .map_err(|e| fail(&e))?;
            (
                value,
                "Bank of America statement".into(),
                String::new(),
                String::new(),
            )
        };
        if amount == 0 {
            skipped_zero += 1;
            continue;
        }
        if !opening {
            if amount > 0 {
                credits += amount;
            } else {
                debits += amount.abs();
            }
        }
        sources.insert(source.clone());
        // Occurrence counts preserve identical legitimate transactions within one export.
        let basis = serde_json::to_vec(&(
            bank,
            &source,
            &parsed_date,
            &description,
            amount,
            &check,
            opening,
        ))
        .map_err(|e| e.to_string())?;
        let base = hash(&basis);
        let occurrence = occurrences.entry(base.clone()).or_default();
        *occurrence += 1;
        let id = hash(format!("{base}:{occurrence}").as_bytes());
        rows.push(Row {
            index: rows.len(),
            line,
            date: parsed_date,
            source,
            description,
            category,
            check,
            amount: money(amount),
            opening,
            id,
        });
    }
    if rows.is_empty() {
        return Err("No transactions found in this CSV".into());
    }
    if !is_arvest {
        for r in records.iter().take(header) {
            if r.len() == 3 && ["Total credits", "Total debits"].contains(&r[0].trim()) {
                let expected = cents(&r[2])?.abs();
                let actual = if r[0].trim() == "Total credits" {
                    credits
                } else {
                    debits
                };
                if expected != actual {
                    return Err("Bank of America summary totals do not match the transactions. No transactions were imported.".into());
                }
            }
        }
    }
    if let Some((credit, debit)) = expected_totals {
        if credit != credits || debit != debits {
            return Err(
                "Arvest totals do not match parsed transactions. No transactions were imported."
                    .into(),
            );
        }
    }
    let mut warnings=vec!["Unassigned entries post to equity:unassigned until you choose a category. Review transfers and card payments carefully.".into(),"Duplicate detection matches bank, source, destination account, currency, date, description, amount and check number. It cannot match prior manual entries or changed bank descriptions.".into()];
    if has_opening {
        warnings.push("An opening balance is available but unchecked. Include it only if this bank account does not already have its opening balance.".into());
    }
    if skipped_zero > 0 {
        warnings.push(format!("Skipped {skipped_zero} zero-amount rows."));
    }
    let mut sources: Vec<_> = sources.into_iter().collect();
    sources.sort();
    Ok(Parsed {
        bank: bank.into(),
        file_revision: hash(bytes),
        sources,
        rows,
        credits: money(credits),
        debits: money(debits),
        warnings,
    })
}
fn imported_ids(journal: &str) -> HashSet<&str> {
    journal
        .lines()
        .filter_map(|line| line.trim().strip_prefix("; booky-import: "))
        .collect()
}
fn id(row: &Row, mappings: &BTreeMap<String, String>, currency: &str) -> Result<String> {
    let account = mappings
        .get(&row.source)
        .ok_or("Map every source bank account before continuing")?;
    Ok(hash(
        serde_json::to_string(&(&row.id, account, currency))
            .map_err(|e| e.to_string())?
            .as_bytes(),
    ))
}
fn entry(
    row: &Row,
    bank: &str,
    mappings: &BTreeMap<String, String>,
    currency: &str,
    category: &str,
) -> Result<String> {
    let account = mappings
        .get(&row.source)
        .ok_or("Missing bank account mapping")?;
    if !account.starts_with("assets:") {
        return Err("Map bank statements to an assets: account, such as assets:bank:arvest".into());
    }
    let negative = row.amount.starts_with('-');
    let mut description = format!("{bank}: ");
    for c in row.description.chars().map(|c| {
        if c.is_control() || c == ';' || c == '|' {
            ' '
        } else {
            c
        }
    }) {
        if description.len() + c.len_utf8() > 240 {
            break;
        }
        description.push(c);
    }
    let e = ledger::Entry {
        date: row.date.clone(),
        description,
        debit: if negative {
            category.into()
        } else {
            account.clone()
        },
        credit: if negative {
            account.clone()
        } else {
            category.into()
        },
        amount: row.amount.trim_start_matches('-').into(),
        commodity: currency.into(),
    };
    let text = ledger::entry_text(&e)?;
    // Tags are transaction comments immediately after the header, before postings.
    let split = text[1..].find('\n').ok_or("Invalid entry")? + 1;
    let metadata = serde_json::to_string(&(&row.description, &row.category, &row.check))
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "{}\n    ; booky-import: {}\n    ; bank-source: {}{}",
        &text[..split],
        id(row, mappings, currency)?,
        metadata,
        &text[split..]
    ))
}
pub fn review(
    company_path: &Path,
    path: &Path,
    file_revision: &str,
    revision: &str,
    mappings: &BTreeMap<String, String>,
    currency: &str,
) -> Result<Preview> {
    let parsed = read(path)?;
    if parsed.file_revision != file_revision {
        return Err("CSV changed. Select the file again.".into());
    }
    let journal = company::journal_text(company_path, revision)?;
    let existing = imported_ids(&journal);
    let mut rows = Vec::new();
    for row in &parsed.rows {
        entry(
            row,
            &parsed.bank,
            mappings,
            currency,
            if row.opening {
                "equity:opening-balances"
            } else {
                "equity:unassigned"
            },
        )?;
        rows.push(PreviewRow {
            row: row.clone(),
            duplicate: existing.contains(id(row, mappings, currency)?.as_str()),
        });
    }
    Ok(Preview { parsed, rows })
}
pub fn commit(company_path: &Path, request: &Request) -> Result<Outcome> {
    let parsed = read(Path::new(&request.path))?;
    if parsed.file_revision != request.file_revision {
        return Err("CSV changed since preview. Select the file again.".into());
    }
    if request.selections.is_empty() {
        return Err("Select at least one transaction".into());
    }
    company::update(company_path, &request.revision, |journal| {
        let mut existing: HashSet<String> = imported_ids(journal)
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut indices = HashSet::new();
        let mut text = String::new();
        let mut imported = 0;
        let mut skipped = 0;
        for selection in &request.selections {
            if !indices.insert(selection.index) {
                return Err("Repeated selection index".into());
            }
            let row = parsed
                .rows
                .get(selection.index)
                .ok_or("Unknown transaction selection")?;
            let entry = entry(
                row,
                &parsed.bank,
                &request.mappings,
                &request.currency,
                &selection.category,
            )?;
            if existing.insert(id(row, &request.mappings, &request.currency)?) {
                text.push_str(&entry);
                imported += 1;
            } else {
                skipped += 1;
            }
        }
        Ok((text, Outcome { imported, skipped }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const ARVEST:&str="Checking,******0000\nDate,Account,Description,Check #,Category,Credit,Debit\n12/31/2025,Checking,Fee,,Miscellaneous,,-10.00\n12/30/2025,Checking,Deposit,,Income,100.00,\n12/31/2025,Checking,Fee,,Miscellaneous,,-10.00\n,,,Totals:,3 items,100.00,-20.00\n";
    const BOA:&str="Description,,Summary Amt.\nBeginning balance as of 04/01/2025,,\"1,000.00\"\nTotal credits,,200.00\nTotal debits,,-10.00\nEnding balance as of 04/30/2025,,\"1,190.00\"\n\nDate,Description,Amount,Running Bal.\n04/01/2025,Beginning balance as of 04/01/2025,,\"1,000.00\"\n04/02/2025,\"Merchant, Inc.\",-10.00,990.00\n04/03/2025,Deposit,200.00,\"1,190.00\"\n";
    fn request(path: &Path, parsed: &Parsed, revision: &str) -> Request {
        Request {
            path: path.to_string_lossy().into(),
            file_revision: parsed.file_revision.clone(),
            revision: revision.into(),
            mappings: parsed
                .sources
                .iter()
                .map(|s| (s.clone(), "assets:bank:test".into()))
                .collect(),
            currency: "USD".into(),
            selections: parsed
                .rows
                .iter()
                .filter(|r| !r.opening)
                .map(|r| Selection {
                    index: r.index,
                    category: "equity:unassigned".into(),
                })
                .collect(),
        }
    }
    #[test]
    fn formats_exact_money_and_rejects_bad_values() {
        assert_eq!(cents("\"1\"").err().is_some(), true);
        assert_eq!(cents("(1,234.50)").unwrap(), -123450);
        assert_eq!(cents("$0.01").unwrap(), 1);
        for raw in ["1,23.00", "1.234", "1e3", "", "-$1$", "12/2"] {
            assert!(cents(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn recognizes_banks_skips_summaries_and_preserves_identical_rows() {
        let a = parse(ARVEST.as_bytes()).unwrap();
        assert_eq!(a.rows.len(), 3);
        assert_eq!(a.debits, "20.00");
        assert_ne!(a.rows[0].id, a.rows[2].id);
        let b = parse(BOA.as_bytes()).unwrap();
        assert_eq!(b.rows.len(), 3);
        assert!(b.rows[0].opening);
        assert_eq!(b.rows[1].description, "Merchant, Inc.");
        assert_eq!(b.credits, "200.00");
        assert!(parse(ARVEST.replace("-20.00", "-21.00").as_bytes()).is_err());
        assert!(parse(
            BOA.replace("Total credits,,200.00", "Total credits,,201.00")
                .as_bytes()
        )
        .is_err());
        assert!(parse(ARVEST.replace("12/30/2025", "02/30/2025").as_bytes()).is_err());
        assert!(parse(ARVEST.replace(",100.00,", ",100.00,-1.00").as_bytes()).is_err());
    }
    #[test]
    fn batch_import_is_atomic_repeat_safe_and_portable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.csv");
        fs::write(&path, ARVEST).unwrap();
        let parsed = read(&path).unwrap();
        let company_path = dir.path().join("books.bky");
        let initial = company::create(
            &company_path,
            company::Details {
                name: "Test".into(),
                currency: "USD".into(),
            },
            false,
            None,
        )
        .unwrap();
        let mut req = request(&path, &parsed, &initial.revision);
        let preview = review(
            &company_path,
            &path,
            &parsed.file_revision,
            &initial.revision,
            &req.mappings,
            &req.currency,
        )
        .unwrap();
        assert!(preview.rows.iter().all(|r| !r.duplicate));
        assert_eq!(commit(&company_path, &req).unwrap().imported, 3);
        let saved = company::snapshot(&company_path).unwrap();
        assert_eq!(saved.transactions.len(), 3);
        let account = saved
            .accounts
            .iter()
            .find(|a| a.name == "assets:bank:test")
            .unwrap();
        assert_eq!(account.amounts[0].quantity, "80.00");
        assert!(commit(&company_path, &req).is_err());
        req.revision = saved.revision.clone();
        assert_eq!(commit(&company_path, &req).unwrap().skipped, 3);
        assert_eq!(
            fs::read_dir(dir.path().join("books.bky.backups"))
                .unwrap()
                .count(),
            1
        );
        let backup = dir.path().join("backup.bkybk");
        company::copy(&company_path, &saved.revision, &backup).unwrap();
        let restored = dir.path().join("restored.bky");
        company::restore(&backup, &restored).unwrap();
        assert_eq!(commit(&restored, &req).unwrap().imported, 0);
        fs::write(&path, ARVEST.replace("Deposit", "Changed")).unwrap();
        assert!(commit(&company_path, &req).is_err());
    }
    #[test]
    fn invalid_selected_category_keeps_entire_company_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.csv");
        fs::write(&path, BOA).unwrap();
        let parsed = read(&path).unwrap();
        let company_path = dir.path().join("books.bky");
        let initial = company::create(
            &company_path,
            company::Details {
                name: "Test".into(),
                currency: "USD".into(),
            },
            false,
            None,
        )
        .unwrap();
        let original = fs::read(&company_path).unwrap();
        let mut req = request(&path, &parsed, &initial.revision);
        req.selections[1].category = "expenses:office\ninclude secret".into();
        assert!(commit(&company_path, &req).is_err());
        assert_eq!(fs::read(&company_path).unwrap(), original);
    }
    #[test]
    fn source_text_is_escaped_and_opening_balance_is_optional() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.csv");
        fs::write(&path, BOA.replace("Deposit", "Deposit; note | extra")).unwrap();
        let parsed = read(&path).unwrap();
        let company_path = dir.path().join("books.bky");
        let initial = company::create(
            &company_path,
            company::Details {
                name: "Test".into(),
                currency: "USD".into(),
            },
            false,
            None,
        )
        .unwrap();
        let mut req = request(&path, &parsed, &initial.revision);
        assert_eq!(req.selections.len(), 2);
        req.selections.push(Selection {
            index: 0,
            category: "equity:opening-balances".into(),
        });
        commit(&company_path, &req).unwrap();
        let saved = company::snapshot(&company_path).unwrap();
        assert_eq!(saved.transactions.len(), 3);
        assert_eq!(
            saved
                .accounts
                .iter()
                .find(|a| a.name == "assets:bank:test")
                .unwrap()
                .amounts[0]
                .quantity,
            "1190.00"
        );
    }
    #[test]
    #[ignore = "Local private statements are never committed as fixtures"]
    fn local_statements_end_to_end() {
        let folder = std::env::var("BOOKY_IMPORT_SAMPLES")
            .expect("Set BOOKY_IMPORT_SAMPLES to the local statement folder");
        for file in fs::read_dir(folder).unwrap() {
            let path = file.unwrap().path();
            if path.extension().and_then(|v| v.to_str()) != Some("csv") {
                continue;
            }
            let parsed = read(&path).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let company_path = dir.path().join("test.bky");
            let initial = company::create(
                &company_path,
                company::Details {
                    name: "Temporary import verification".into(),
                    currency: "USD".into(),
                },
                false,
                None,
            )
            .unwrap();
            let mut req = request(&path, &parsed, &initial.revision);
            let outcome = commit(&company_path, &req).unwrap();
            let saved = company::snapshot(&company_path).unwrap();
            assert_eq!(saved.transactions.len(), outcome.imported);
            assert!(outcome.imported > 0);
            req.revision = saved.revision;
            assert_eq!(commit(&company_path, &req).unwrap().imported, 0);
            println!(
                "{}: {} transactions validated; repeat import skipped",
                parsed.bank, outcome.imported
            );
        }
    }
}
