# Changelog

## Unreleased

- Recent books remembers the last ten opened companies and journals on this
  machine, with direct reopening and controls to remove or clear shortcuts.

## 0.1.0 — 2026-10-05

Initial public release of LedgerTrails.

- Local company files, automatic backups, portable backup and restore.
- Exact-decimal bookkeeping powered by hledger 1.52.1.
- Bank CSV imports, duplicate detection, category mapping, and review.
- Financial reports, supporting schedules, and printable exports.
- Tax preparation workspaces and estimated-tax planning.
- Linux x86_64 AppImage, DEB, and RPM downloads.
- GPL-3.0-or-later licensing.

### Compatibility and limitations

Existing `.bky` company files and `.bkybk` backups remain compatible. Linux
downloads were built on Arch Linux and require glibc 2.39 or newer; DEB and RPM
installation has not been validated on other distributions. Native packages
also require the Tauri GTK/WebKit system libraries. Windows and macOS installers
are not included. Packages are unsigned and automatic updates are not configured.

This is an early release. Tax features provide planning and preparation support;
they do not file returns. See the README for feature-specific limitations.
