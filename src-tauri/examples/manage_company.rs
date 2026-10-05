//! Local administration using the same validated, backed-up import path as the desktop app.
#[allow(dead_code)]
#[path = "../src/company.rs"]
mod company;
#[allow(dead_code)]
#[path = "../src/imports.rs"]
mod imports;
#[allow(dead_code)]
#[path = "../src/ledger.rs"]
mod ledger;
#[allow(dead_code)]
#[path = "../src/workspace.rs"]
mod workspace;
use std::{env, fs, path::Path};
fn run() -> Result<serde_json::Value, String> {
    let args: Vec<String> = env::args().collect();
    let command = args.get(1).ok_or(
        "Usage: manage_company parse CSV | snapshot COMPANY | import COMPANY REQUEST_JSON",
    )?;
    let path = Path::new(args.get(2).ok_or("Missing file path")?);
    match command.as_str() {
        "parse" => serde_json::to_value(imports::read(path)?).map_err(|e| e.to_string()),
        "snapshot" => serde_json::to_value(company::snapshot(path)?).map_err(|e| e.to_string()),
        "read-workspace" => {
            let current = company::snapshot(path)?;
            serde_json::to_value(workspace::read(path, &current.revision)?)
                .map_err(|e| e.to_string())
        }
        "save-workspace" => {
            let revision = args.get(3).ok_or("Missing revision")?;
            let value = serde_json::from_slice(
                &fs::read(args.get(4).ok_or("Missing workspace file")?)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            workspace::save(path, revision, value)?;
            Ok(serde_json::json!({"saved": true}))
        }
        "import" => {
            let request: imports::Request = serde_json::from_slice(
                &fs::read(args.get(3).ok_or("Missing request JSON")?).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(imports::commit(path, &request)?).map_err(|e| e.to_string())
        }
        _ => Err("Unknown command".into()),
    }
}
fn main() {
    match run() {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
