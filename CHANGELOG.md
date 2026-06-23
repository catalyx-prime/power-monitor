# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the version numbers match
the `version` field in `metadata.json`.

## [3] - 2026-06-23

### Fixed
- Rolling averages were diluted toward zero by inactive-state samples: every
  poll folded the inactive metric's forced-`0 W` into the running totals
  (discharge while plugged in, charge while idle/full), so both averages read
  too low. Each accumulator is now gated on its active state, so an average
  covers only the samples where that metric was actually active ("average power
  while discharging / while charging"). Reset Averages once after upgrading to
  clear totals still polluted with old zeros.

### Changed
- Migrated all signal wiring to the `connectObject`/`disconnectObject`
  signal-tracker, so each source tears down with a single
  `disconnectObject(this)` instead of per-handler id tracking. The indicator now
  overrides `destroy()`, and the chart buffer is dropped on `disable()` per EGO
  teardown rules.
- Auto color mode now follows the shell via `Main.getStyleVariant()`.

## [1] - Initial release

### Added
- Live battery wattage in the panel with automatic discharge/charge switching.
- Detail pane with per-metric rows, rolling averages since boot (with reset),
  and a power-history chart (15 min / 1 hr / 4 hr).
- Optional automatic screen-brightness control per power source via GNOME 50's
  in-shell brightness manager.
- Optional automatic power-profile switching via `power-profiles-daemon`.
- Preferences split into General, Power, and Appearance pages: placement, color
  mode, icon visibility, refresh interval, and detail-panel size.
- Targets GNOME Shell 50; declares the `unlock-dialog` session mode so the chart
  keeps tracking on the lock screen.
