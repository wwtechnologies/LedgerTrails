# LedgerTrails

A local desktop accounting app built with Tauri 2, React, TypeScript, and Rust. hledger validates the books and generates reports.

## Downloads

Get Linux x86_64 downloads from [GitHub Releases](https://github.com/wwtechnologies/LedgerTrails/releases). See [the changelog](CHANGELOG.md) and each release's notes for compatibility, installation instructions, checksums, and source/license assets. Version 0.1.0 packages require glibc 2.39 or newer and were built on Arch Linux. Windows and macOS installers are not included.

## Company files and backups

| File     | Purpose                                                                        |
| -------- | ------------------------------------------------------------------------------ |
| `.bky`   | Working company file: company name, default currency, and the complete journal |
| `.bkybk` | Portable backup of a company, restored into a new `.bky` file                  |

These are the native LedgerTrails versioned formats, not QuickBooks file formats. They are self-contained UTF-8 JSON documents with an embedded plain-text hledger journal. No database server, online account, cloud upload, or original source folder is required to restore them.

- **New company** collects a company name and default currency, then asks where to save. Start empty or import an existing standalone journal. The source journal is unchanged.
- **Open company** opens a local `.bky` file. The picker also supports standalone `.journal`, `.ledger`, and `.hledger` files for existing users.
- **Save** verifies and flushes the active company file. Submitted transactions already save automatically; unfinished form fields are not saved until submitted.
- **Save as** saves a separate `.bky` copy and switches to it.
- **Back up** writes a `.bkybk` snapshot to a chosen location and keeps the active company open.
- **Restore** opens a local `.bkybk` or `.bky` source and saves it to a new `.bky` destination. It does not modify the source or overwrite an existing company.

Every successful transaction save also preserves the previous complete company in `<company>.bky.backups/<revision>.bkybk`. These automatic backups can be restored using the same Restore action. Backups accumulate; there is no automatic retention cleanup yet.

Company files are validated before creation or restore. Unsupported versions, malformed JSON, unbalanced journals, and external journal includes are rejected. A file lock coordinates LedgerTrails writers, and content revisions prevent stale saves and stale backups. Changes are staged in the destination directory and atomically replace the working file only after validation and backup. External editors do not participate in the LedgerTrails lock; avoid editing the file externally during a save.

Existing `.bky` company files and `.bkybk` backups remain compatible. Legacy file-format markers and the desktop application identifier are retained so existing data and application settings continue to work. `BOOKY_HLEDGER` is still accepted as a fallback for `LEDGERTRAILS_HLEDGER`.

## Run locally

Requires Node.js 24+, Rust stable, the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/), and hledger 1.52.1 on PATH.

```sh
npm ci
npm run tauri dev
```

`npm run dev` starts a browser-only preview with fictional sample data. Native file dialogs and saving require the desktop app. Set `LEDGERTRAILS_HLEDGER` to an absolute executable path if hledger is not on PATH. A bundled executable takes precedence.

## Accounting features

- Net worth, income, expenses, and account balances, separately by commodity.
- Searchable transactions and accounts; expandable postings.
- Two-posting transaction entry with validation and automatic backups.
- Exact decimal strings across Rust/TypeScript and decimal.js display totals.

Overview totals use `assets`, `liabilities`, `income`, and `expenses` prefixes across all dates. They are not currency-converted valuations. The company currency is a default for new entries; it does not convert existing amounts. A transaction row displays its first posting; expand it to see every amount.

Standalone journals with included files remain view-only and cannot be imported into a company yet. Split-entry forms, editing/deleting transactions, period filters, attachments, company-detail editing, and automatic reopening are not implemented. The existing `Imports/` directory is untouched.

## Bank statement imports

Open a company and choose **Import CSV**. Supported formats are Arvest's `Date, Account, Description, Check #, Category, Credit, Debit` export and Bank of America's `Date, Description, Amount, Running Bal.` export with its summary preamble.

1. Choose the CSV and map its source account(s) to `assets:bank:...` accounts in LedgerTrails. Confirm the statement currency (USD by default).
2. Review the transactions. Existing imports are marked and excluded. Choose categories per row, or filter descriptions and apply a category to selected visible rows. Uncheck any rows you do not want.
3. Click **Import N transactions**. The complete batch is validated with hledger and saved atomically, with one automatic backup. The statement file is never modified.

Deposits increase the mapped asset account and withdrawals reduce it. Rows default to `equity:unassigned`, a neutral holding account rather than an assumed income/expense classification. Bank-provided categories are shown as hints. Assign categories before import: editing previously imported transactions is not implemented yet. A transfer shown in both bank files should only be posted once if assigning both bank accounts to one entry; exclude the other statement's corresponding row.

Bank of America beginning-balance rows are optional and unchecked. Select one only for a bank account whose opening balance has not already been entered. Other summary rows and Arvest totals are not transactions. Reported credit/debit totals are checked against parsed transactions; malformed rows abort the import rather than being silently discarded.

Duplicate markers travel with the company and backups. Matching uses bank, source account, mapped LedgerTrails account, currency, date, original description, exact amount, check number, and an occurrence count for identical rows. Use consistent bank mappings. This cannot match earlier manual entries, changed descriptions/source labels, or distinguish identical same-day transactions omitted from a partial overlapping export. Review those cases before importing.

Tests use fictional fixtures. To verify local statement files in disposable companies without committing their contents:

```sh
BOOKY_IMPORT_SAMPLES=/absolute/path/to/Imports cargo test --manifest-path src-tauri/Cargo.toml local_statements_end_to_end -- --ignored --nocapture
```

## Checks

```sh
npm test
npm run build
npm run test:backend
```

Frontend tests exercise company creation, opening, Save, Save As, backup, restore, cancellation, error handling, and currency defaults using mocked native dialogs and commands. Backend tests use real hledger and temporary files to verify complete backup/restore portability, automatic backups, refusal to overwrite, invalid-file rejection, stale revisions, write locks, journal validation, and exact decimal decoding.

## Desktop packaging

```sh
npm run desktop:build
```

This downloads the pinned official hledger 1.52.1 archive, verifies its committed SHA-256 digest, and bundles it as `ledgertrails-hledger` to avoid conflicts with a system hledger installation.

Build separately on Linux x64, Windows x64, and macOS Intel/Apple Silicon with their Tauri prerequisites. Other architectures need an appropriate hledger binary. `.github/workflows/check.yml` runs these build checks on GitHub. Windows and macOS have not been tested locally. Signing, notarization, and automatic updates are not configured.

For a Linux debug package:

```sh
npm run sidecar:prepare
npm run test:backend -- --bundled
npm run tauri build -- --debug --bundles deb --config src-tauri/tauri.bundle.conf.json
```

hledger is GPL-3.0-or-later; see its [license and source](https://github.com/hledgerorg/hledger/tree/1.52.1). Public redistribution needs the corresponding license/source arrangements. Local packaging is not a completed public release process.

## Project layout

- `src/App.tsx`: desktop interface and commands.
- `src/model.ts`: exact amounts and totals.
- `src/ImportDialog.tsx`: bank mapping, transaction preview, and import selection.
- `src-tauri/src/imports.rs`: statement parsers, exact amounts, duplicate fingerprints, and batch import.
- `src-tauri/src/company.rs`: company format, save/copy/backup/restore, and automatic backup lifecycle.
- `src-tauri/src/ledger.rs`: hledger execution, JSON reports, validation, and journal writes.
- `src-tauri/src/lib.rs`: async Tauri commands and active company/journal state.
- `scripts/prepare-hledger.mjs`: verified platform-specific hledger downloads.
- `examples/sample.journal`: fictional data only.

Personal company files, backups, journals, downloaded binaries, and `Imports/` are excluded from version control. Keep real company files outside the source tree when possible.

### Review imported transactions

Open a company and choose **Review** in the sidebar. This lists imported postings in `equity:needs-review:*` accounts. Search by description, date, amount, or current category; select one or several matching transactions; then choose or enter an account and apply it. Changes update the original postings, preserve import identifiers and bank metadata, validate with hledger, and create an automatic company backup. If another operation changes the company, refresh before saving. Split allocations (such as loan principal and interest) are not yet supported on this page.

### Reports and tax preparation

**Reports** provides 25 ledger and supporting reports: profit and loss, balance sheet, cash flow, trial balance, monthly results, period comparisons, income and expense detail, budget variance, general ledger, transaction detail, bank activity, uncategorized items, receivables/payables balances and aging, debts, payroll accounts, sales-tax accounts, fixed assets, an asset register, inventory valuation, contractor payments, and owner/equity activity. Choose dates and currency; export CSV or printable HTML (open in a browser to print or save as PDF).

Reports follow the recorded ledger, without converting accounting methods or currencies. Balance reports include prior activity through the end date. Cash flow recognizes cash under `assets:bank`, `assets:cash`, `assets:checking`, and `assets:savings`; counterpart account prefixes determine its activity groups. Nonstandard account conventions need review. Operating reports use the selected date range. A review warning and missing-opening-balance hints accompany exports.

**Supporting schedules & budgets** accepts outstanding invoices/bills, asset costs, inventory carrying values, contractor payments, and exact-period account budgets. These records do not create ledger postings. Aging and asset/inventory schedules use the exact report end date as their snapshot date; maintain outstanding balances after partial payments and reconcile them to the ledger. Contractor payment schedules are supporting records, not automatic 1099 determinations. Full invoicing, bill payment, inventory tracking, bank clearing/reconciliation, and automated depreciation are not implemented.

**Tax** stores a separate calendar-year preparation workspace, including federal entity classification, accounting method, jurisdiction notes, checklist, account mappings, preparer notes, and manual book-to-tax adjustments. Tax settings and supporting schedules are saved inside the `.bky` file as a versioned journal comment, so existing company backups/restores remain portable. Saves require a current revision and produce an automatic backup. The printable preparer packet includes the tax worksheets and underlying reports. LedgerTrails does not calculate final tax liability, automatically approve deductions, prepare signed returns, or e-file. Entity-specific IRS form links, recordkeeping guidance, accounting-method guidance, and information-return instructions help users collect the right records. Rates, thresholds, depreciation elections, state/local rules, and taxpayer-specific limitations are not guessed from bank transactions.

### Tax estimate dashboard

Tax → Estimates supports 2025 and 2026 for sole proprietors/single-member LLCs in USD. Each year saves its own filing status, forecast, withholding, deductions, credits, prior-year tax, due-date overrides, and payment log in the portable company workspace. The dashboard shows federal income and self-employment tax, Oklahoma full-year resident tax, projected balances at filing, and separate quarterly targets. Printable exports include assumptions and official source links.

Choose recorded profit, a straight-line year-to-date forecast, or a reviewed annual Schedule C profit. Missing records produce a setup message rather than a zero-tax estimate. Recorded profit is not a forecast of remaining-year activity; unresolved categories and manual book-to-tax adjustments require review. QBI is a reviewed manual input. Other personal income and withholding default to zero and must be checked. Special rates, AMT, NIIT, loss limitations, spouse self-employment, and part-year state allocations are not calculated automatically.

Minimum installment targets use current-year/prior-year rules; the full-tax option budgets for the projected total. Payment tracking records payments already made and does not send money or post journal entries. Payments are matched by effective date, so a later catch-up payment does not erase an earlier deadline gap. No penalty is calculated. Review the linked official guidance before applying disaster-relief deadline overrides. Rules verified October 4, 2026.

## License

Copyright (C) 2026 LedgerTrails contributors.

LedgerTrails is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (SPDX: `GPL-3.0-or-later`).

LedgerTrails is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

Commercial use is permitted. When distributing modified versions, the GPL requires corresponding source code and preservation of the applicable license and notices. Your company files, imported transactions, and reports are your data; this software license does not require publishing them.

### Third-party software

Dependencies retain their own licenses and copyright notices. [hledger](https://github.com/hledgerorg/hledger) is copyright Simon Michael and contributors and is licensed under GPL-3.0-or-later. The build downloads the unmodified hledger 1.52.1 executable; its source is available at [the matching release tag](https://github.com/hledgerorg/hledger/tree/1.52.1).

When publishing desktop binaries, include the applicable dependency notices and licenses, and provide corresponding source for GPL-covered components, including the bundled hledger version, as required by the GPL. A LedgerTrails source checkout alone does not include hledger's source. This repository publishes source code; downloaded sidecar binaries and private financial data are excluded from Git.
