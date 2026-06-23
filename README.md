# Power Monitor

A GNOME Shell extension that displays real-time battery power metrics in the
system status bar. Two metrics are tracked:

1. **Discharge** — system power draw while running on battery, in watts. Shown
   as a negative number, since power is leaving the battery.
2. **Charge** — how fast power is being delivered to the battery, in watts.

At any instant a single battery is either charging *or* discharging, so only one
of the two is non-zero at a time. The top bar **automatically shows whichever
metric is active** — discharge while on battery, charge while charging —
optionally with its icon. Clicking the panel item opens a detail pane that
lists both metrics, each with its icon on the left, plus the rolling averages,
and a **power-history chart** of recent readings. Values are formatted to one
decimal place with a `W` suffix. The extension tracks a rolling average of each
metric since the last reboot (or last manual reset).

Each average is taken over **only the samples where that metric was active** —
the discharge average over ticks spent on battery, the charge average over ticks
spent actively charging. Idle states (plugged in but full, or `Not charging`)
don't contribute `0 W` samples that would drag the averages down. As a result
the figures read as "average power *while discharging*" / "*while charging*",
not a duty-cycle average over wall-clock time.

It can also **automatically set screen brightness** and the **system power
profile** when you plug in or unplug, applying a configurable level/profile for
AC versus battery (see [Preferences](#preferences)).

> This extension targets **single-battery** machines (laptops). The first
> battery reported under `/sys/class/power_supply/` is used.

Supported GNOME Shell version: **50** (ESM extension format). The automatic
screen-brightness feature relies on GNOME 50's in-shell brightness manager, which
replaced the DBus brightness interface used by earlier releases.

## How the metrics are derived

Values are read from the Linux power-supply sysfs interface under
`/sys/class/power_supply/`. For the battery device (`type` is `Battery`):

- Power is read from `power_now` (microwatts) when available.
- Otherwise it is computed from `current_now` (µA) × `voltage_now` (µV).

Direction comes from the battery `status` field rather than the sign of
`current_now`, which is reported inconsistently across hardware:

- `Discharging` → the battery is powering the system → counts as **discharge**.
- `Charging` → energy is flowing into the battery → counts as **charge**.
- `Full` / `Not charging` / `Unknown` → both metrics read `0.0 W`.

> Note: when running on AC with the battery fully charged, the kernel exposes no
> battery current, so both metrics read `0.0 W`. System-wide AC draw is not
> available from the battery sysfs interface.

## Power-history chart

The detail pane includes a chart of recent power readings, plotted from an
in-memory buffer of samples (no data is written to disk, and the buffer starts
empty each time the shell starts). Toggle buttons above the chart switch the
visible window between **15 min**, **1 hr**, and **4 hr**. Up to 4 hours of
history is retained. Tracking continues while the screen is locked, so locking
and unlocking does not leave a gap in the chart (a true suspend still does,
since nothing runs while suspended).

## Install

### Via the Makefile (recommended)

```sh
make install
```

This compiles the GSettings schema and copies the extension to
`~/.local/share/gnome-shell/extensions/power-monitor@local/`.

Then restart GNOME Shell:

- **Wayland:** log out and back in.
- **X11:** press `Alt`+`F2`, type `r`, press `Enter`.

Finally enable it:

```sh
gnome-extensions enable power-monitor@local
```

…or toggle it on in the **Extensions** (or **Extension Manager**) app.

### From a packaged zip

```sh
make pack
gnome-extensions install --force power-monitor-v3.zip
```

Then restart GNOME Shell and enable as above.

## Icons

Custom icons live in the extension's `icons/` subdirectory. The extension loads
these filenames:

| Metric    | Filename                |
|-----------|-------------------------|
| Discharge | `battery_discharge.png` |
| Charge    | `battery_charge.png`    |

Replace these with your own artwork, keeping the same filenames, and re-run
`make install`. To use different filenames, edit the `ICON_FILES` map at the top
of `extension.js`. If an icon file is missing, that metric gracefully falls back
to showing the text value only.

## Preferences

Open preferences from the panel menu (**Preferences**) or with:

```sh
gnome-extensions prefs power-monitor@local
```

The preferences window lets you:

- Choose the **panel placement**: left, center, or right area of the top bar
  (default right).
- Choose the **color mode**: auto, light, or dark for the detail panel and icons.
  Auto follows the system color-scheme preference (default auto).
- Toggle **show metric icon** to display or hide the icon next to the value.
- Choose the **detail panel size**: original, medium (1.25x), or large (1.5x)
  (default original).
- Choose the **detail panel placement**: default (drops down from the panel pill)
  or pinned to a fixed screen location — one of the nine cells of a 3x3 grid over
  the work area, e.g. top-left, middle-center, bottom-right (default default).
- Choose the **refresh interval**: 5, 10, 15, 20, 25, or 30 seconds (default 10).
- **Manage brightness**: when enabled, the extension sets screen brightness from
  the configured **On battery** and **On AC power** levels (each 20–100%) every
  time the power source changes.
- **Manage power profile**: when enabled, the extension sets the system power
  profile (via `power-profiles-daemon`) from the configured **On battery** and
  **On AC power** selections every time the power source changes. The dropdowns
  list the profiles the daemon reports for your hardware (typically Power Saver,
  Balanced, Performance); defaults are Balanced on battery and Performance on AC.
- View the current **rolling averages** and sample count. Each average covers
  only the samples taken while that metric was active (see [the metrics
  overview](#power-monitor)).
- **Reset Averages** to clear the accumulated totals.

Averages are stored via GSettings, so they survive opening and closing the
settings window. They are automatically reset when the machine reboots (detected
via the kernel `boot_id`).

## Makefile targets

| Target    | Action                                                            |
|-----------|-------------------------------------------------------------------|
| `install` | Compile schema and copy into the user extensions directory.       |
| `pack`    | Produce `power-monitor-v<version>.zip` for distribution.          |
| `schemas` | Compile the GSettings schema with `glib-compile-schemas`.         |
| `clean`   | Remove the zip and the compiled schema.                           |

## Requirements

No external runtime dependencies beyond what ships with GNOME Shell. Building the
schema requires `glib-compile-schemas` (part of GLib) and `zip` for packaging.
