use crate::{company, ledger::Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
const PREFIX: &str = "; booky-workspace: ";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Adjustment {
    id: String,
    description: String,
    amount: String,
    currency: String,
    direction: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaxYear {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    estimate: Option<EstimateSettings>,
    entity: String,
    basis: String,
    jurisdiction: String,
    checks: BTreeMap<String, bool>,
    mappings: BTreeMap<String, String>,
    adjustments: Vec<Adjustment>,
    notes: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    id: String,
    kind: String,
    name: String,
    reference: String,
    date: String,
    due: String,
    as_of: String,
    amount: String,
    currency: String,
    notes: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    id: String,
    account: String,
    start: String,
    end: String,
    amount: String,
    currency: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    version: u32,
    tax_years: BTreeMap<String, TaxYear>,
    schedules: Vec<Schedule>,
    budgets: Vec<Budget>,
}
impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: 1,
            tax_years: BTreeMap::new(),
            schedules: vec![],
            budgets: vec![],
        }
    }
}
fn date(v: &str) -> Result<()> {
    if chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d")
        .map(|d| d.format("%Y-%m-%d").to_string() == v)
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err("Use a valid YYYY-MM-DD date".into())
    }
}
fn amount(v: &str, currency: &str) -> Result<()> {
    let parts: Vec<_> = v.split('.').collect();
    if v.len() > 40
        || parts.len() > 2
        || parts
            .iter()
            .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
        || currency.len() != 3
        || !currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err("Use a nonnegative decimal amount and a three-letter currency".into());
    }
    Ok(())
}
impl Workspace {
    fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err("Unsupported workspace version".into());
        }
        for (year, t) in &self.tax_years {
            if year.len() != 4
                || !year.bytes().all(|b| b.is_ascii_digit())
                || !["unknown", "sole", "s-corp", "partnership", "c-corp"]
                    .contains(&t.entity.as_str())
                || !["unknown", "cash", "accrual", "other"].contains(&t.basis.as_str())
            {
                return Err("Invalid tax year, classification, or accounting method".into());
            }
            if let Some(e) = &t.estimate {
                e.validate(year)?;
            }
            for a in &t.adjustments {
                amount(&a.amount, &a.currency)?;
                if !["increase", "decrease"].contains(&a.direction.as_str())
                    || a.description.trim().is_empty()
                {
                    return Err("Describe each adjustment and its direction".into());
                }
            }
        }
        for s in &self.schedules {
            date(&s.date)?;
            date(&s.as_of)?;
            if !s.due.is_empty() {
                date(&s.due)?;
            }
            amount(&s.amount, &s.currency)?;
            if s.name.trim().is_empty()
                || !["invoice", "bill", "asset", "inventory", "contractor"]
                    .contains(&s.kind.as_str())
                || s.date > s.as_of
            {
                return Err("Check schedule name, kind, and dates".into());
            }
        }
        for b in &self.budgets {
            date(&b.start)?;
            date(&b.end)?;
            amount(&b.amount, &b.currency)?;
            if b.start > b.end
                || !(b.account.starts_with("expenses:") || b.account.starts_with("income:"))
            {
                return Err("Budgets need an income/expense account and valid period".into());
            }
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > 1_000_000 {
            return Err("Workspace is too large".into());
        }
        Ok(())
    }
}
pub fn read(path: &Path, revision: &str) -> Result<Workspace> {
    let journal = company::journal_text(path, revision)?;
    let values: Vec<_> = journal
        .lines()
        .filter_map(|l| l.strip_prefix(PREFIX))
        .collect();
    if values.len() > 1 {
        return Err("Company has conflicting workspace records".into());
    }
    let result: Workspace = match values.first() {
        Some(v) => serde_json::from_str(v).map_err(|e| format!("Invalid workspace: {e}"))?,
        None => Workspace::default(),
    };
    result.validate()?;
    Ok(result)
}
pub fn save(path: &Path, revision: &str, value: Workspace) -> Result<()> {
    value.validate()?;
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    company::rewrite(path, revision, |journal| {
        let mut lines: Vec<_> = journal
            .lines()
            .filter(|l| !l.starts_with(PREFIX))
            .map(str::to_owned)
            .collect();
        lines.insert(0, format!("{PREFIX}{text}"));
        Ok((format!("{}\n", lines.join("\n")), ()))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn estimate_settings_roundtrip_and_invalid_payment_is_rejected() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("estimates.bky");
        let snap = company::create(
            &p,
            company::Details {
                name: "Estimate test".into(),
                currency: "USD".into(),
            },
            true,
            None,
        )
        .unwrap();
        let old = serde_json::json!({"entity":"sole","basis":"unknown","jurisdiction":"OK","checks":{},"mappings":{},"adjustments":[],"notes":""});
        let mut tax: TaxYear = serde_json::from_value(old).unwrap();
        assert!(tax.estimate.is_none());
        tax.estimate =
            Some(serde_json::from_str(include_str!("../../tests/estimate-settings.json")).unwrap());
        let mut w = Workspace::default();
        w.tax_years.insert("2025".into(), tax);
        save(&p, &snap.revision, w).unwrap();
        let next = company::snapshot(&p).unwrap();
        let mut loaded = read(&p, &next.revision).unwrap();
        let e = loaded
            .tax_years
            .get_mut("2025")
            .unwrap()
            .estimate
            .as_mut()
            .unwrap();
        assert_eq!(e.filing_status, "single");
        assert_eq!(e.payments[0].amount, "100");
        e.payments[0].amount = "-100".into();
        let before = std::fs::read(&p).unwrap();
        assert!(save(&p, &next.revision, loaded).is_err());
        assert_eq!(before, std::fs::read(&p).unwrap());
    }
    #[test]
    fn workspace_is_portable_and_revision_protected() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("books.bky");
        let s = company::create(
            &p,
            company::Details {
                name: "Example".into(),
                currency: "USD".into(),
            },
            true,
            None,
        )
        .unwrap();
        let mut w = read(&p, &s.revision).unwrap();
        w.tax_years.insert(
            "2025".into(),
            TaxYear {
                estimate: None,
                entity: "s-corp".into(),
                basis: "cash".into(),
                jurisdiction: "OK".into(),
                checks: BTreeMap::new(),
                mappings: BTreeMap::new(),
                adjustments: vec![],
                notes: "A note\ninclude /not-a-journal".into(),
            },
        );
        save(&p, &s.revision, w.clone()).unwrap();
        assert!(save(&p, &s.revision, w).is_err());
        let next = company::snapshot(&p).unwrap();
        assert_eq!(next.transactions.len(), s.transactions.len());
        assert_eq!(next.accounts.len(), s.accounts.len());
        let backup = d.path().join("copy.bkybk");
        company::copy(&p, &next.revision, &backup).unwrap();
        assert_eq!(
            read(&backup, &next.revision).unwrap().tax_years["2025"].entity,
            "s-corp"
        );
        let mut invalid = Workspace::default();
        invalid.version = 2;
        assert!(save(&p, &next.revision, invalid).is_err());
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaxPayment {
    id: String,
    jurisdiction: String,
    date: String,
    amount: String,
    note: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EstimateSettings {
    filing_status: String,
    state: String,
    ok_resident: bool,
    profit_source: String,
    through: String,
    annual_profit: String,
    wages: String,
    ss_wages: String,
    medicare_wages: String,
    other_income: String,
    agi_deductions: String,
    deduction_mode: String,
    federal_deduction: String,
    qbi_deduction: String,
    other_deduction: String,
    federal_credits: String,
    refundable_credits: String,
    federal_other_tax: String,
    federal_withholding: String,
    prior_federal_tax: String,
    prior_agi: String,
    prior_federal_eligible: bool,
    ok_adjustment: String,
    ok_deduction: String,
    ok_exemptions: String,
    ok_credits: String,
    ok_withholding: String,
    prior_ok_tax: String,
    prior_ok_eligible: bool,
    payment_goal: String,
    as_of: String,
    due_dates: BTreeMap<String, String>,
    payments: Vec<TaxPayment>,
}
impl EstimateSettings {
    fn validate(&self, year: &str) -> Result<()> {
        if !["2025", "2026"].contains(&year)
            || !["unknown", "single", "joint", "separate", "head"]
                .contains(&self.filing_status.as_str())
            || !["none", "OK"].contains(&self.state.as_str())
            || !["ledger", "annualized", "manual"].contains(&self.profit_source.as_str())
            || !["standard", "custom"].contains(&self.deduction_mode.as_str())
            || !["minimum", "full"].contains(&self.payment_goal.as_str())
        {
            return Err("Invalid tax estimate settings".into());
        }
        date(&self.through)?;
        date(&self.as_of)?;
        if !self.through.starts_with(&format!("{year}-")) {
            return Err("Profit date must be in the selected tax year".into());
        }
        for v in [
            &self.wages,
            &self.ss_wages,
            &self.medicare_wages,
            &self.other_income,
            &self.agi_deductions,
            &self.qbi_deduction,
            &self.other_deduction,
            &self.federal_credits,
            &self.refundable_credits,
            &self.federal_other_tax,
            &self.federal_withholding,
            &self.ok_exemptions,
            &self.ok_credits,
            &self.ok_withholding,
        ] {
            amount(v, "USD")?;
        }
        for v in [
            &self.federal_deduction,
            &self.ok_deduction,
            &self.prior_federal_tax,
            &self.prior_agi,
            &self.prior_ok_tax,
        ] {
            if !v.is_empty() {
                amount(v, "USD")?;
            }
        }
        for v in [&self.annual_profit, &self.ok_adjustment] {
            if !v.is_empty() {
                amount(v.strip_prefix('-').unwrap_or(v), "USD")?;
            }
        }
        if self
            .ok_exemptions
            .parse::<u32>()
            .map(|n| n > 100)
            .unwrap_or(true)
        {
            return Err("Enter 0 to 100 Oklahoma exemptions".into());
        }
        for (key, v) in &self.due_dates {
            if ![
                "federal_1",
                "federal_2",
                "federal_3",
                "federal_4",
                "oklahoma_1",
                "oklahoma_2",
                "oklahoma_3",
                "oklahoma_4",
            ]
            .contains(&key.as_str())
            {
                return Err("Invalid quarterly due date key".into());
            }
            date(v)?;
        }
        let mut ids = std::collections::HashSet::new();
        for p in &self.payments {
            date(&p.date)?;
            amount(&p.amount, "USD")?;
            if p.date.as_str() < format!("{year}-01-01").as_str()
                || !["federal", "oklahoma"].contains(&p.jurisdiction.as_str())
                || !p.amount.bytes().any(|b| matches!(b, b'1'..=b'9'))
                || !ids.insert(&p.id)
            {
                return Err("Check payment dates, amounts, jurisdiction, and unique IDs".into());
            }
        }
        Ok(())
    }
}
