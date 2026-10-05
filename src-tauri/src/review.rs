use crate::{company, ledger::Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
#[derive(Serialize)]
pub struct Row {
    pub line: usize,
    pub date: String,
    pub description: String,
    pub account: String,
    pub amount: String,
}
#[derive(Deserialize)]
pub struct Change {
    pub line: usize,
    pub category: String,
}
pub fn rows(journal: &str) -> Vec<Row> {
    let mut result = Vec::new();
    let mut header = "";
    let mut imported = false;
    for (line, text) in journal.lines().enumerate() {
        if text.starts_with(|c: char| c.is_ascii_digit()) {
            header = text;
            imported = false;
        }
        if text.trim().starts_with("; booky-import:") {
            imported = true;
        }
        let trimmed = text.trim_start();
        if imported && trimmed.starts_with("equity:needs-review:") {
            if let Some((account, amount)) = trimmed.split_once("  ") {
                result.push(Row {
                    line,
                    date: header.chars().take(10).collect(),
                    description: header.get(10..).unwrap_or("").trim().into(),
                    account: account.into(),
                    amount: amount.trim().into(),
                });
            }
        }
    }
    result
}
pub fn commit(path: &Path, revision: &str, changes: Vec<Change>) -> Result<()> {
    if changes.is_empty() {
        return Err("Select transactions to categorize".into());
    }
    company::rewrite(path, revision, |journal| {
        let eligible: HashSet<usize> = rows(journal).iter().map(|r| r.line).collect();
        let mut seen = HashSet::new();
        let mut lines: Vec<String> = journal.lines().map(String::from).collect();
        for change in changes {
            if !eligible.contains(&change.line) || !seen.insert(change.line) {
                return Err(
                    "Transaction is no longer awaiting review. Refresh and try again.".into(),
                );
            }
            let category = change.category.trim();
            if !["assets:", "liabilities:", "equity:", "income:", "expenses:"]
                .iter()
                .any(|p| category.starts_with(p))
                || category.starts_with("equity:needs-review:")
                || category.split(':').any(|part| {
                    part.is_empty()
                        || !part
                            .chars()
                            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
                })
            {
                return Err(
                    "Choose a category such as expenses:office or equity:owner-draws".into(),
                );
            }
            let (_, amount) = lines[change.line]
                .trim_start()
                .split_once("  ")
                .ok_or("Unsupported posting")?;
            lines[change.line] = format!("    {category}  {}", amount.trim());
        }
        Ok((format!("{}\n", lines.join("\n")), ()))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_changes_only_category_and_rejects_stale_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("test.bky");
        company::create(
            &p,
            company::Details {
                name: "Test".into(),
                currency: "USD".into(),
            },
            false,
            None,
        )
        .unwrap();
        let s = company::snapshot(&p).unwrap();
        company::update(&p,&s.revision, |_| Ok(("2025-01-01 Example\n    ; booky-import: abc\n    equity:needs-review:checks  12.34 USD\n    assets:bank  -12.34 USD\n".into(),()))).unwrap();
        let s = company::snapshot(&p).unwrap();
        let journal = company::journal_text(&p, &s.revision).unwrap();
        let line = rows(&journal)[0].line;
        assert!(commit(
            &p,
            &s.revision,
            vec![Change {
                line,
                category: "expenses:bad\ninclude x".into()
            }]
        )
        .is_err());
        assert_eq!(company::journal_text(&p, &s.revision).unwrap(), journal);
        commit(
            &p,
            &s.revision,
            vec![Change {
                line,
                category: "expenses:office".into(),
            }],
        )
        .unwrap();
        assert!(commit(
            &p,
            &s.revision,
            vec![Change {
                line,
                category: "expenses:other".into()
            }]
        )
        .is_err());
        let next = company::snapshot(&p).unwrap();
        let result = company::journal_text(&p, &next.revision).unwrap();
        assert_eq!(
            result,
            journal.replace("equity:needs-review:checks", "expenses:office")
        );
        assert_eq!(next.transactions.len(), 1);
    }
}
