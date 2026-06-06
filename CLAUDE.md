# CLAUDE.md

GNOME Shell extension that shows real-time battery power metrics (discharge,
charge) in the panel. Single-battery machines only. ESM extension format.
UUID: `power-monitor@local`.

For user-facing docs (metric definitions, install steps, icon table, preferences)
see `README.md`. This file is the orientation for working *on* the code.

## Layout

- `extension.js` — the shell-side code (runs inside gnome-shell). Panel indicator,
  sysfs reading, polling loop, rolling-average accumulation.
- `prefs.js` — the preferences window (runs in a separate Gtk4/Adw process, **not**
  inside gnome-shell — it has no access to `St`, `Clutter`, `Main`, or the indicator).
- `schemas/org.gnome.shell.extensions.power-monitor.gschema.xml` — GSettings keys.
- `metadata.json` — `shell-version` list gates which GNOME versions will load it.
- `icons/` — PNGs referenced by `ICON_FILES` in `extension.js`.
- `Makefile` — build/install/pack.

## Build & install

```sh
make install   # compiles schema, copies to ~/.local/share/gnome-shell/extensions/<uuid>/
make pack      # builds <uuid>.zip for distribution
make schemas   # just (re)compile the GSettings schema
```

`make install` does **not** reload a running shell. On Wayland you must log out
and back in for changes to take effect; X11 can `Alt+F2` → `r`. A stale running
session is why a freshly installed extension can show `State: OUT OF DATE` even
when `metadata.json` already lists the running version — it clears after re-login.

Inspect / debug a running install:

```sh
gnome-extensions info power-monitor@local
journalctl --user -b 0 -o cat /usr/bin/gnome-shell | grep -i power-monitor
gnome-extensions prefs power-monitor@local
```

There is no test suite. Validate edits with `node --check extension.js prefs.js`
for syntax, then exercise the real shell after a re-login.

## Conventions & gotchas

- **Two execution contexts.** Anything in `extension.js` runs inside gnome-shell
  (St/Clutter/Main available). `prefs.js` runs in its own process — only Gtk/Adw/Gio
  and `getSettings()`. Don't import shell-only modules into prefs, or vice versa.
- **All state lives in GSettings**, not in JS fields. The accumulator keys
  (`discharge-sum`/`discharge-count`, `charge-sum`/`charge-count`),
  `boot-id`, and `refresh-interval` are the source of truth, which is how the panel
  and the prefs window stay in sync (prefs subscribes via `changed::` signals).
  The two metric ids (`discharge`, `charge`) map straight onto the `<id>-*` keys.
- **Averages reset on reboot**, detected by comparing the stored `boot-id` against
  `/proc/sys/kernel/random/boot_id` in `checkBoot()`.
- **Direction comes from the battery `status` field, not the sign of `current_now`**
  (hardware reports the sign inconsistently). See the comment block above
  `readMetrics()` before changing metric logic.
- **Schema changes require recompiling**: edit the `.gschema.xml`, then `make schemas`
  (or `make install`). New keys must also be wired into both `extension.js` and
  `prefs.js`. If you add an enum/range, keep `INTERVALS` in `prefs.js` and the schema
  `<range>` in sync.
- **Clean up in `disable()`.** Every `GLib.timeout_add*`, signal `connect`, and the
  indicator itself must be torn down — see `_stopPolling()` / `disable()`. Leaking a
  timeout or signal handler across enable/disable cycles is the classic extension bug.
- **GNOME version compatibility.** Use current GJS/St/Clutter idioms and check what
  the installed shell actually ships (`/usr/lib64/gnome-shell/St-*.typelib`,
  `/usr/share/gnome-shell/`). Removed-API breakage is the main porting hazard — e.g.
  the old `St.Align` enum is gone in GNOME 50; alignment uses `Clutter.ActorAlign`.
  Update the `shell-version` array in `metadata.json` when targeting a new release.

## Formatting

Watts are formatted to one decimal with a ` W` suffix. Discharge is reported as
a negative number (power leaving the battery); charge is a positive magnitude.
The sign is set at the source in `readMetrics()` and flows through the
accumulator/average — `formatWatts` just renders whatever sign it is given.
`formatWatts` is
duplicated in both `extension.js` and `prefs.js` (the two processes can't share a
module easily) — keep them identical if you change either.
