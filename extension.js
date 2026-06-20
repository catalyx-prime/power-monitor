'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import UPowerGlib from 'gi://UPowerGlib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const POWER_SUPPLY_PATH = '/sys/class/power_supply';
const ICON_FILES = {
    discharge: 'battery_discharge.png',
    charge: 'battery_charge.png',
    discharge_light: 'battery_discharge_light.png',
    charge_light: 'battery_charge_light.png',
};

// The two metrics we display. The panel automatically shows whichever one is
// currently active (discharge while discharging, charge while charging); the
// detail pane always shows both. Discharge is reported as a negative number
// (power leaving the battery); charge is a positive magnitude.
const METRICS = {
    discharge: {icon: ICON_FILES.discharge, label: 'Discharge'},
    charge: {icon: ICON_FILES.charge, label: 'Charge'},
};

// How often the in-memory average accumulators are flushed to GSettings. The
// keys exist only so the separate prefs process can read the averages, so a few
// seconds of lag there is fine and avoids a dconf write on every poll tick.
const ACCUM_FLUSH_MS = 30 * 1000;
const CHART_HEIGHT = 160;
const CHART_RANGES = [
    {label: '15 min', ms: 15 * 60 * 1000},
    {label: '1 hr',   ms: 60 * 60 * 1000},
    {label: '4 hr',   ms: 4 * 60 * 60 * 1000},
];
// The history buffer is bounded by age, not sample count: keep samples within the
// longest selectable range so the depth is independent of the refresh interval.
const HISTORY_WINDOW_MS = Math.max(...CHART_RANGES.map(r => r.ms));

/* ----------------------------- sysfs helpers ----------------------------- */

// Reused across the many per-poll sysfs reads instead of allocating a fresh
// decoder each call.
const _decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return _decoder.decode(contents).trim();
    } catch (_e) {
        return null;
    }
}

function readInt(path) {
    const text = readText(path);
    if (text === null)
        return null;
    const value = parseInt(text, 10);
    return Number.isNaN(value) ? null : value;
}

// Returns the name of the first battery device, or null if none is present.
// This extension targets single-battery machines, so the first battery wins.
function findBattery() {
    try {
        const dir = Gio.File.new_for_path(POWER_SUPPLY_PATH);
        const enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const type = readText(`${POWER_SUPPLY_PATH}/${name}/type`);
            if (type === 'Battery') {
                enumerator.close(null);
                return name;
            }
        }
        enumerator.close(null);
    } catch (_e) {
        // /sys not readable or no power supplies present.
    }
    return null;
}

// Returns the battery power flow magnitude in watts (>= 0), or null if it
// cannot be determined.
function batteryWatts(name) {
    const base = `${POWER_SUPPLY_PATH}/${name}`;

    // Preferred: power_now is already a power figure in microwatts.
    let microWatts = readInt(`${base}/power_now`);

    // Fallback: derive power from current_now (µA) and voltage_now (µV).
    if (microWatts === null) {
        const microAmps = readInt(`${base}/current_now`);
        const microVolts = readInt(`${base}/voltage_now`);
        if (microAmps !== null && microVolts !== null)
            microWatts = (microAmps * microVolts) / 1e6;
    }

    if (microWatts === null)
        return null;

    return Math.abs(microWatts) / 1e6;
}

// Reads the single battery into the two metrics we display.
//
// Direction is taken from the `status` field rather than the sign of
// current_now, which is reported inconsistently across hardware:
//   - Discharging -> the battery is powering the system (discharge)
//   - Charging    -> energy is flowing into the battery (charge)
// Full / Not charging / Unknown read as zero for both.
// The battery device name is discovered once and cached. sysfs does not rename
// a battery under a running kernel, so re-enumerating /sys/class/power_supply on
// every poll is wasted I/O. If the cached node ever disappears (a read returns
// null), we re-scan once and retry.
let _batteryName = null;

function readMetrics() {
    let name = _batteryName ?? (_batteryName = findBattery());
    if (name === null)
        return null;

    let status = readText(`${POWER_SUPPLY_PATH}/${name}/status`);
    if (status === null) {
        // Cached device vanished (removed/renamed) — re-scan once and retry.
        name = _batteryName = findBattery();
        if (name === null)
            return null;
        status = readText(`${POWER_SUPPLY_PATH}/${name}/status`);
    }
    status = status || 'Unknown';
    const onBattery = status === 'Discharging';

    let watts = batteryWatts(name);
    if (watts === null) {
        // No power figure available. On hardware without a `power_now` node we
        // derive watts from current_now/voltage_now, and a plugged-in battery
        // that is full/idle reports current_now as 0 — or, briefly at shell
        // startup before the first ACPI measurement, as an empty string. Either
        // way, while on AC there is legitimately ~0 W of battery power flow, so
        // report 0 and let the panel show "0.0 W" instead of "n/a"/blank. While
        // discharging the reading genuinely matters, so keep it unavailable.
        if (onBattery)
            return null;
        watts = 0;
    }

    return {
        // Discharge is signed negative (power leaving the battery); charge is a
        // positive magnitude. The sign carries through the accumulator/average
        // and is rendered by formatWatts.
        discharge: onBattery ? -watts : 0,
        charge: status === 'Charging' ? watts : 0,
        // Plug state drives which metric the panel surfaces. Only `Discharging`
        // means the battery is powering the system (unplugged); every other
        // status (Charging / Full / Not charging / Unknown) means AC is present.
        onBattery,
    };
}

/* ----------------------------- panel widget ------------------------------ */

const PowerMonitorIndicator = GObject.registerClass(
class PowerMonitorIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Power Monitor', false);

        this._extension = extension;
        this._settings = extension.getSettings();

        // Rolling history buffer for the chart (in-memory, no file I/O). It
        // lives on the long-lived extension object, not the indicator, so it
        // survives a disable()/enable() cycle (e.g. a panel-position change, or
        // any future re-enable). We declare the `unlock-dialog` session mode in
        // metadata.json so the extension stays *enabled* on the lock screen and
        // keeps polling — that's what prevents a flat-line gap in the chart while
        // the screensaver is up. Sharing the array by reference means
        // _pushHistory keeps appending to the same buffer.
        this._history = extension._history;

        // Average accumulators are batched in memory and flushed to GSettings
        // periodically rather than on every tick (see _flushAccumulators). These
        // hold only the unflushed delta since the last flush.
        this._pending = {
            discharge: {sum: 0, count: 0},
            charge: {sum: 0, count: 0},
        };
        this._lastFlush = Date.now();
        this._chartRange = 15 * 60 * 1000; // default: 15 min
        this._lastMetrics = null;
        this._repaintId = null;
        this._menuOpenId = null;
        this._chartArea = null;
        this._rangeBtns = [];

        try {
            this._ifaceSettings = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        } catch (_e) {
            this._ifaceSettings = null;
        }

        // Drop the rounded "pill" background the panel button normally draws.
        this.add_style_class_name('power-monitor-panel-button');

        this._panelBox = new St.BoxLayout({
            style_class: 'power-monitor-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._buildPanel();
        this._buildMenu();
        this._installMenuPositioning();
        this._applyDetailSize();
        this._applyColorMode();
        this._applyDetailPanelPosition();

        // Rebuild the panel when the user toggles whether the icon is shown.
        this._panelChangedIds = [
            this._settings.connect('changed::panel-show-icon', () => this._rebuildPanel()),
            this._settings.connect('changed::detail-size', () => this._applyDetailSize()),
            this._settings.connect('changed::color-mode', () => this._applyColorMode()),
            this._settings.connect('changed::detail-panel-position',
                () => this._applyDetailPanelPosition()),
        ];

        if (this._ifaceSettings) {
            this._ifaceColorId = this._ifaceSettings.connect('changed::color-scheme', () => {
                if (this._settings.get_string('color-mode') === 'auto')
                    this._applyColorMode();
            });
        }

        this.connect('destroy', () => {
            // Persist any unflushed average samples before tearing down.
            this._flushAccumulators();
            for (const id of this._panelChangedIds)
                this._settings.disconnect(id);
            this._panelChangedIds = [];
            if (this._ifaceSettings && this._ifaceColorId) {
                this._ifaceSettings.disconnect(this._ifaceColorId);
                this._ifaceColorId = null;
            }
            this._ifaceSettings = null;
            if (this._menuOpenId) {
                this.menu.disconnect(this._menuOpenId);
                this._menuOpenId = null;
            }
            this._destroyChartContent();
        });
    }

    _isDark() {
        const mode = this._settings.get_string('color-mode');
        if (mode === 'dark') return true;
        if (mode === 'light') return false;
        try {
            return !this._ifaceSettings ||
                this._ifaceSettings.get_string('color-scheme') !== 'prefer-light';
        } catch (_e) {
            return true;
        }
    }

    _iconFileFor(key) {
        return this._isDark() ? ICON_FILES[key] : ICON_FILES[`${key}_light`];
    }

    // Builds the panel widget. Which metric it shows is decided live in
    // update(), so the icon's gicon is swapped there rather than fixed here.
    _buildPanel() {
        if (this._settings.get_boolean('panel-show-icon')) {
            this._panelIconFile = this._iconFileFor('discharge');
            this._panelIcon = this._buildIcon(
                this._panelIconFile, 'system-status-icon power-monitor-icon');
            if (this._panelIcon)
                this._panelBox.add_child(this._panelIcon);
        } else {
            this._panelIcon = null;
            this._panelIconFile = null;
        }

        this._panelLabel = new St.Label({
            text: '–',
            style_class: 'power-monitor-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._panelLabel);
    }

    _rebuildPanel() {
        this._panelBox.destroy_all_children();
        this._buildPanel();
        this.update();
    }

    // Scales the dropdown detail panel by toggling a style class on the menu
    // container; the stylesheet bumps font-size and icon-size for each step.
    _applyDetailSize() {
        const box = this.menu.box;
        box.remove_style_class_name('power-monitor-detail-medium');
        box.remove_style_class_name('power-monitor-detail-large');

        const size = this._settings.get_string('detail-size');
        if (size === 'medium')
            box.add_style_class_name('power-monitor-detail-medium');
        else if (size === 'large')
            box.add_style_class_name('power-monitor-detail-large');
    }

    // Applies power-monitor-force-dark or power-monitor-force-light to the
    // menu box based on the color-mode setting. Auto resolves by reading the
    // system color-scheme preference from org.gnome.desktop.interface.
    _applyColorMode() {
        const box = this.menu.box;
        box.remove_style_class_name('power-monitor-force-light');
        box.remove_style_class_name('power-monitor-force-dark');
        box.add_style_class_name(this._isDark() ? 'power-monitor-force-dark' : 'power-monitor-force-light');
        this._updateDetailIcons();
    }

    _updateDetailIcons() {
        const key = this._lastActiveKey ?? 'discharge';
        if (this._panelIcon) {
            this._panelIconFile = this._iconFileFor(key);
            this._panelIcon.gicon = this._gicon(this._panelIconFile);
        }
        const update = (icon, iconKey) => {
            if (icon)
                icon.gicon = this._gicon(this._iconFileFor(iconKey));
        };
        update(this._dischargeIcon,    'discharge');
        update(this._chargeIcon,       'charge');
        update(this._avgDischargeIcon, 'discharge');
        update(this._avgChargeIcon,    'charge');
    }

    // Returns a Gio.Icon for the given icon file, or null if it is missing.
    // GIcons are immutable, so the result is memoized: the poll loop and the
    // detail-icon refresh ask for the same handful of files repeatedly, and
    // there's no point re-running the `file_test` stat and reallocating each
    // time.
    _gicon(iconFile) {
        this._giconCache ??= new Map();
        if (this._giconCache.has(iconFile))
            return this._giconCache.get(iconFile);
        const iconPath = GLib.build_filenamev([this._extension.path, 'icons', iconFile]);
        const gicon = GLib.file_test(iconPath, GLib.FileTest.EXISTS)
            ? Gio.icon_new_for_string(iconPath)
            : null;
        this._giconCache.set(iconFile, gicon);
        return gicon;
    }

    // Returns an St.Icon for the given icon file, or null if it is missing.
    _buildIcon(iconFile, styleClass) {
        const gicon = this._gicon(iconFile);
        if (gicon === null)
            return null;
        return new St.Icon({
            gicon,
            style_class: styleClass,
        });
    }

    // Aligns the dropdown detail panel horizontally with the panel pill:
    //   - left pill   → panel's left edge meets the pill's left edge
    //   - right pill  → panel's right edge meets the pill's right edge
    //   - center pill → panel's middle meets the pill's middle
    // GNOME's BoxPointer positions the box around the *arrow*, offset by the
    // rounded-corner `margin` (4*border-radius + arrow-base + …), so its
    // arrow/source alignment fractions can't express exact edge alignment for
    // the left/right cases. We wrap _reposition to let it do its work, then
    // rewrite the box origin. The override reads `panel-position` live so it
    // always reflects the current setting, and it dies with the menu's
    // boxpointer when the indicator is torn down — no explicit cleanup needed.
    _installMenuPositioning() {
        const boxPointer = this.menu._boxPointer;
        if (!boxPointer || boxPointer._powerMonitorPatched)
            return;
        boxPointer._powerMonitorPatched = true;

        const indicator = this;
        const originalReposition = boxPointer._reposition;
        boxPointer._reposition = function (allocationBox) {
            originalReposition.call(this, allocationBox);

            // When the detail panel is pinned to a fixed screen location, ignore
            // the pill-relative edge alignment below and place it on the grid.
            const detailPos = indicator._settings.get_string('detail-panel-position');
            if (detailPos !== 'default') {
                indicator._repositionDetailPanel(this, detailPos, allocationBox);
                return;
            }

            // Only horizontal panel dropdowns (arrow on top/bottom) get edge
            // alignment; a side arrow would need vertical logic instead.
            if (this._arrowSide !== St.Side.TOP && this._arrowSide !== St.Side.BOTTOM)
                return;

            const src = this._sourceExtents;
            if (!src)
                return;
            const srcLeft = src.get_top_left().x;
            const srcRight = src.get_bottom_right().x;
            const boxWidth = allocationBox.get_width();

            const position = indicator._settings.get_string('panel-position');
            let stageX;
            if (position === 'left')
                stageX = srcLeft;
            else if (position === 'right')
                stageX = srcRight - boxWidth;
            else
                stageX = (srcLeft + srcRight) / 2 - boxWidth / 2;

            // Don't let edge alignment push the panel off the monitor.
            const wa = this._workArea;
            if (wa)
                stageX = Math.max(wa.x, Math.min(stageX, wa.x + wa.width - boxWidth));

            // _reposition computes in stage coordinates but writes a
            // parent-relative origin; convert back the same way, keeping the
            // vertical position the original already worked out.
            const [parentStageX] = this.get_parent().get_transformed_position();
            allocationBox.set_origin(Math.round(stageX - parentStageX), allocationBox.y1);

            // Keep the arrow under the middle of the pill.
            let arrowOrigin = (srcLeft + srcRight) / 2 - stageX;
            arrowOrigin = Math.max(0, Math.min(arrowOrigin, boxWidth));
            this.setArrowOrigin(arrowOrigin);
        };
    }

    // Pin the detail panel (the menu's BoxPointer) to a cell of a 3x3 grid over
    // the work area (the monitor minus the top bar), ignoring the pill. `pos` is
    // a '<row>-<col>' key: top/middle/bottom aligns the panel's top/centre/bottom
    // to the area's; left/center/right its left/centre/right edge. The stock
    // _reposition (called just before us) has already populated `_workArea` and
    // sized the box, so we only need to rewrite the origin — same parent-relative
    // conversion the edge-alignment path uses.
    _repositionDetailPanel(boxPointer, pos, allocationBox) {
        const wa = boxPointer._workArea;
        if (!wa)
            return;

        const boxWidth = allocationBox.get_width();
        const boxHeight = allocationBox.get_height();
        const [row, col] = pos.split('-');

        let stageX = col === 'left'  ? wa.x
                   : col === 'right' ? wa.x + wa.width - boxWidth
                   :                   wa.x + (wa.width - boxWidth) / 2;
        let stageY = row === 'top'    ? wa.y
                   : row === 'bottom' ? wa.y + wa.height - boxHeight
                   :                    wa.y + (wa.height - boxHeight) / 2;

        // Keep the panel fully on the work area even if it is larger than it.
        stageX = Math.max(wa.x, Math.min(stageX, wa.x + wa.width - boxWidth));
        stageY = Math.max(wa.y, Math.min(stageY, wa.y + wa.height - boxHeight));

        const [parentStageX, parentStageY] = boxPointer.get_parent().get_transformed_position();
        allocationBox.set_origin(Math.round(stageX - parentStageX),
            Math.round(stageY - parentStageY));
    }

    // Flatten the BoxPointer arrow when the panel is pinned (it no longer points
    // at the pill) and force a relayout so a placement change takes effect at
    // once, including while the menu is open.
    _applyDetailPanelPosition() {
        const boxPointer = this.menu._boxPointer;
        if (!boxPointer)
            return;
        const pinned = this._settings.get_string('detail-panel-position') !== 'default';
        if (pinned)
            boxPointer.add_style_class_name('power-monitor-detail-pinned');
        else
            boxPointer.remove_style_class_name('power-monitor-detail-pinned');
        boxPointer.queue_relayout();
    }

    _buildMenu() {
        // Permanent section: chart content is rebuilt fresh on every open to
        // avoid stale actor references after GNOME Shell closes the menu.
        this._chartSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._chartSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addHeader('Current:');
        ({label: this._chargeItem, icon: this._chargeIcon} =
            this._buildDetailItem(this._iconFileFor('charge'), 'Charge: –'));
        ({label: this._dischargeItem, icon: this._dischargeIcon} =
            this._buildDetailItem(this._iconFileFor('discharge'), 'Discharge: –'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addHeader('Averages:');
        ({label: this._avgChargeItem, icon: this._avgChargeIcon} =
            this._buildDetailItem(this._iconFileFor('charge'), 'Charge: –'));
        ({label: this._avgDischargeItem, icon: this._avgDischargeIcon} =
            this._buildDetailItem(this._iconFileFor('discharge'), 'Discharge: –'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const resetItem = new PopupMenu.PopupMenuItem('Reset Averages');
        resetItem.label.add_style_class_name('power-monitor-detail-label');
        resetItem.connect('activate', () => this.resetAverages());
        this.menu.addMenuItem(resetItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.label.add_style_class_name('power-monitor-detail-label');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._menuOpenId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._buildChartContent();
            } else {
                // Defer teardown until after the close animation so the chart
                // doesn't vanish visually while the menu is still fading out.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._destroyChartContent();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    /* -------------------------- chart section ---------------------------- */

    _buildChartContent() {
        // Discard any leftover state before building fresh.
        this._destroyChartContent();

        const outerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'power-monitor-chart-item',
        });

        const vbox = new St.BoxLayout({
            vertical: true,
            style_class: 'power-monitor-chart-box',
            x_expand: true,
        });
        outerItem.add_child(vbox);

        // Range toggle buttons
        const rangeBox = new St.BoxLayout({
            style_class: 'power-monitor-range-box',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._rangeBtns = [];
        for (const {label, ms} of CHART_RANGES) {
            const btn = new St.Button({
                label,
                style_class: 'power-monitor-range-btn',
                can_focus: true,
            });
            btn._rangeMs = ms;
            btn.connect('clicked', () => {
                this._chartRange = ms;
                this._updateRangeBtnStyles();
                if (this._chartArea)
                    this._chartArea.queue_repaint();
            });
            this._rangeBtns.push(btn);
            rangeBox.add_child(btn);
        }
        vbox.add_child(rangeBox);

        // Chart canvas
        this._chartArea = new St.DrawingArea({
            height: CHART_HEIGHT,
            x_expand: true,
            style_class: 'power-monitor-chart-area',
        });
        this._repaintId = this._chartArea.connect('repaint', area => this._drawChart(area));
        vbox.add_child(this._chartArea);

        this._chartSection.addMenuItem(outerItem);
        this._updateRangeBtnStyles();
        this._chartArea.queue_repaint();
    }

    _destroyChartContent() {
        if (this._repaintId && this._chartArea) {
            this._chartArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._chartArea = null;
        this._rangeBtns = [];
        if (this._chartSection)
            this._chartSection.removeAll();
    }

    _updateRangeBtnStyles() {
        for (const btn of this._rangeBtns) {
            if (btn._rangeMs === this._chartRange)
                btn.add_style_class_name('power-monitor-range-btn-active');
            else
                btn.remove_style_class_name('power-monitor-range-btn-active');
        }
    }

    _pushHistory(metrics) {
        const now = Date.now();
        this._history.push({
            t: now,
            discharge: metrics.discharge,
            charge: metrics.charge,
        });
        // Evict from the head while the oldest sample is past the age window.
        // Samples are pushed in time order, so the front is always the oldest.
        const cutoff = now - HISTORY_WINDOW_MS;
        while (this._history.length && this._history[0].t < cutoff)
            this._history.shift();
    }

    _drawChart(area) {
        const cr = area.get_context();
        const allocBox = area.get_allocation_box();
        const W = allocBox.x2 - allocBox.x1;
        const H = allocBox.y2 - allocBox.y1;

        const now = Date.now();
        const windowMs = this._chartRange;
        const cutoff = now - windowMs;
        // Visible window. The buffer is time-ordered, so walk back from the end
        // to the first in-window sample instead of allocating a filtered copy of
        // — and scanning all of — the buffer on every repaint (most of it is
        // older than the cutoff for the shorter ranges).
        const hist = this._history;
        let start = hist.length;
        while (start > 0 && hist[start - 1].t >= cutoff)
            start--;
        const n = hist.length - start;

        // Layout constants
        const TM = 18; // top margin (y-axis max label)
        const BM = 22; // bottom margin (x-axis labels)
        const LM = 42; // left margin (y-axis labels)
        const RM = 6;  // right margin

        const pl = LM;
        const pr = W - RM;
        const pt = TM;
        const pb = H - BM;
        const pw = pr - pl;
        const ph = pb - pt;
        const cy = pt + ph / 2; // y of zero line
        const hh = ph / 2;      // half-height for value scaling

        // Auto-scale: find max of |discharge| and charge over visible window
        let maxVal = 0;
        for (let i = start; i < hist.length; i++) {
            const s = hist[i];
            if (s.charge > maxVal) maxVal = s.charge;
            const ad = Math.abs(s.discharge);
            if (ad > maxVal) maxVal = ad;
        }
        maxVal = maxVal > 0.001 ? maxVal * 1.1 : 5.0;

        // Maps a watt value to a canvas y pixel.
        // v > 0 (charge) → above cy; v < 0 (discharge) → below cy.
        const toY = v => cy - (v / maxVal) * hh;
        // Maps a sample timestamp to a canvas x pixel.
        const toX = t => pl + ((t - cutoff) / windowMs) * pw;

        const dark = this._isDark();
        const [tr, tg, tb, ta] = dark ? [1, 1, 1, 0.75] : [0.1, 0.1, 0.1, 0.85];

        // Subtle plot boundary guides
        cr.setSourceRGBA(tr, tg, tb, 0.1);
        cr.setLineWidth(0.5);
        cr.moveTo(pl, pt); cr.lineTo(pr, pt); cr.stroke();
        cr.moveTo(pl, pb); cr.lineTo(pr, pb); cr.stroke();

        if (n > 1) {
            const first = hist[start];
            const last = hist[hist.length - 1];
            const x0 = toX(first.t);
            const xN = toX(last.t);

            // Charge area — green fill above zero line
            cr.setSourceRGBA(0.18, 0.72, 0.27, 0.3);
            cr.moveTo(x0, cy);
            for (let i = start; i < hist.length; i++)
                cr.lineTo(toX(hist[i].t), toY(hist[i].charge));
            cr.lineTo(xN, cy);
            cr.closePath();
            cr.fill();

            // Charge stroke
            cr.setSourceRGBA(0.2, 0.82, 0.32, 0.85);
            cr.setLineWidth(1.5);
            cr.moveTo(x0, toY(first.charge));
            for (let i = start + 1; i < hist.length; i++)
                cr.lineTo(toX(hist[i].t), toY(hist[i].charge));
            cr.stroke();

            // Discharge area — blue fill below zero line (matches discharge icon)
            cr.setSourceRGBA(0.35, 0.61, 0.99, 0.3);
            cr.moveTo(x0, cy);
            for (let i = start; i < hist.length; i++)
                cr.lineTo(toX(hist[i].t), toY(hist[i].discharge));
            cr.lineTo(xN, cy);
            cr.closePath();
            cr.fill();

            // Discharge stroke
            cr.setSourceRGBA(0.35, 0.61, 0.99, 0.85);
            cr.setLineWidth(1.5);
            cr.moveTo(x0, toY(first.discharge));
            for (let i = start + 1; i < hist.length; i++)
                cr.lineTo(toX(hist[i].t), toY(hist[i].discharge));
            cr.stroke();
        }

        // Zero line
        cr.setSourceRGBA(tr, tg, tb, 0.3);
        cr.setLineWidth(1.0);
        cr.moveTo(pl, cy);
        cr.lineTo(pr, cy);
        cr.stroke();

        // Text helper: renders label at (x, y), right/center/left aligned
        const font = Pango.FontDescription.from_string('Sans 8');
        const drawText = (text, x, y, align) => {
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(font);
            layout.set_text(text, -1);
            const [tw] = layout.get_pixel_size();
            let tx = x;
            if (align === 'right')  tx = x - tw;
            else if (align === 'center') tx = x - tw / 2;
            cr.setSourceRGBA(tr, tg, tb, ta);
            cr.moveTo(Math.round(tx), Math.round(y));
            PangoCairo.show_layout(cr, layout);
        };

        // Y-axis labels
        const maxStr = `${maxVal.toFixed(1)}W`;
        drawText(`+${maxStr}`, LM - 2, pt,      'right');
        drawText(`0W`,         LM - 2, cy - 6,  'right');
        drawText(`−${maxStr}`, LM - 2, pb - 12, 'right');

        // X-axis time labels at even intervals
        let stepMs;
        if (windowMs <= 15 * 60 * 1000)      stepMs = 5 * 60 * 1000;
        else if (windowMs <= 60 * 60 * 1000) stepMs = 15 * 60 * 1000;
        else                                  stepMs = 60 * 60 * 1000;

        for (let ago = 0; ago <= windowMs + 1; ago += stepMs) {
            const clamped = Math.min(ago, windowMs);
            const x = pr - (clamped / windowMs) * pw;
            let label;
            if (clamped === 0) {
                label = 'now';
            } else if (windowMs <= 60 * 60 * 1000) {
                label = `−${clamped / 60000}m`;
            } else {
                const h = clamped / 3600000;
                label = `−${Number.isInteger(h) ? h : h.toFixed(1)}h`;
            }
            const align = clamped === 0 ? 'right' : clamped >= windowMs ? 'left' : 'center';
            drawText(label, x, pb + 5, align);
        }

        cr.$dispose();
    }

    /* ------------------------- averages handling ------------------------- */

    // Reset averages whenever the machine has rebooted since the last sample.
    checkBoot() {
        const bootId = readText('/proc/sys/kernel/random/boot_id') || '';
        if (this._settings.get_string('boot-id') !== bootId) {
            this.resetAverages();
            this._settings.set_string('boot-id', bootId);
        }
    }

    resetAverages() {
        for (const key of ['discharge', 'charge']) {
            this._settings.set_double(`${key}-sum`, 0.0);
            this._settings.set_int(`${key}-count`, 0);
            this._pending[key].sum = 0;
            this._pending[key].count = 0;
        }
    }

    // Accumulate into the in-memory delta only. The delta is folded into the
    // GSettings totals later by _flushAccumulators (every ACCUM_FLUSH_MS), which
    // keeps dconf writes off the hot poll path.
    _accumulate(key, value) {
        this._pending[key].sum += value;
        this._pending[key].count += 1;
    }

    // Fold the in-memory deltas into the GSettings running totals. Uses
    // read-modify-write so an external reset (the prefs Reset button zeroing the
    // keys in another process) is respected: we only ever add our unflushed
    // delta onto whatever base GSettings currently holds.
    _flushAccumulators() {
        for (const key of ['discharge', 'charge']) {
            const pending = this._pending[key];
            if (pending.count === 0)
                continue;
            const sum = this._settings.get_double(`${key}-sum`) + pending.sum;
            const count = this._settings.get_int(`${key}-count`) + pending.count;
            this._settings.set_double(`${key}-sum`, sum);
            this._settings.set_int(`${key}-count`, count);
            pending.sum = 0;
            pending.count = 0;
        }
        this._lastFlush = Date.now();
    }

    // Average over the GSettings total plus the not-yet-flushed in-memory delta,
    // so the panel display stays exact between flushes (the prefs process, which
    // only sees GSettings, lags by at most ACCUM_FLUSH_MS).
    _average(key) {
        const count = this._settings.get_int(`${key}-count`) + this._pending[key].count;
        if (count <= 0)
            return null;
        const sum = this._settings.get_double(`${key}-sum`) + this._pending[key].sum;
        return sum / count;
    }

    /* ------------------------------ refresh ------------------------------ */

    update() {
        const metrics = readMetrics();

        if (metrics === null) {
            this._panelLabel.text = 'n/a';
            this._dischargeItem.text    = 'Discharge: unavailable';
            this._chargeItem.text       = 'Charge: unavailable';
            this._avgDischargeItem.text = 'Discharge: unavailable';
            this._avgChargeItem.text    = 'Charge: unavailable';
            return;
        }

        this._accumulate('discharge', metrics.discharge);
        this._accumulate('charge', metrics.charge);
        if (Date.now() - this._lastFlush >= ACCUM_FLUSH_MS)
            this._flushAccumulators();

        // Surface the metric that matches the plug state: discharge while the
        // laptop is unplugged, charge while it is plugged in. This holds even
        // when the active value is 0 W (e.g. a plugged-in battery that is Full
        // or Not charging still shows charge, not discharge).
        const activeKey = metrics.onBattery ? 'discharge' : 'charge';
        this._lastActiveKey = activeKey;
        this._panelLabel.text = formatWatts(metrics[activeKey]);
        // Only touch the gicon when the resolved icon file actually changes
        // (the active metric flips). Reassigning an equivalent icon every tick
        // would re-run a stat and churn the texture cache for no visible effect;
        // color-scheme changes route through _updateDetailIcons instead.
        const iconFile = this._iconFileFor(activeKey);
        if (this._panelIcon && iconFile !== this._panelIconFile) {
            this._panelIconFile = iconFile;
            this._panelIcon.gicon = this._gicon(iconFile);
        }

        this._dischargeItem.text = `Discharge: ${formatWatts(metrics.discharge)}`;
        this._chargeItem.text    = `Charge: ${formatWatts(metrics.charge)}`;
        const avgD = this._average('discharge');
        const avgC = this._average('charge');
        this._avgDischargeItem.text =
            `Discharge: ${avgD === null ? '–' : formatWatts(avgD)}`;
        this._avgChargeItem.text =
            `Charge: ${avgC === null ? '–' : formatWatts(avgC)}`;

        // Feed the history buffer and refresh the chart (only while open).
        this._lastMetrics = metrics;
        this._pushHistory(metrics);
        if (this._chartArea && this.menu.isOpen)
            this._chartArea.queue_repaint();
    }

    // A non-reactive section header (e.g. "Current:", "Averages:").
    _addHeader(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.add_style_class_name('power-monitor-detail-header');
        this.menu.addMenuItem(item);
    }

    // A detail-pane row: icon on the left, metric/description label to its
    // right. Returns {label, icon} so callers can update both.
    _buildDetailItem(iconFile, initialText) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});

        const icon = this._buildIcon(iconFile, 'popup-menu-icon power-monitor-detail-icon');
        if (icon)
            item.add_child(icon);

        const label = new St.Label({
            text: initialText,
            style_class: 'power-monitor-detail-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(label);

        this.menu.addMenuItem(item);
        return {label, icon};
    }
});

function formatWatts(value) {
    return `${value.toFixed(1)} W`;
}

/* ------------------------------- extension ------------------------------- */

export default class PowerMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // The chart history buffer is owned here, not by the indicator, so it
        // outlives the disable()/enable() cycle that GNOME Shell triggers on
        // screen lock (and any other re-enable). It is only ever empty on a true
        // shell (re)start, which creates a fresh extension object. Initialize it
        // once; never clobber an existing buffer on re-enable.
        this._history ??= [];

        this._addIndicator();

        // Restart the polling loop whenever the interval setting changes.
        this._settingsChangedId = this._settings.connect(
            'changed::refresh-interval', () => this._startPolling());

        // Re-place the indicator when the user moves it between panel boxes.
        this._positionChangedId = this._settings.connect(
            'changed::panel-position', () => this._addIndicator());

        this._watchPowerSource();
        this._setupBrightnessControl();
        this._setupPowerProfileControl();

        // At startup the laptop may already be plugged in, in which case the
        // UPower `on-battery` transition that normally triggers a settle re-read
        // never fires. Schedule one anyway so a value that sysfs reports late is
        // picked up shortly after launch instead of waiting a full poll.
        this._scheduleSettleUpdate();
    }

    // Refresh the moment AC power is plugged in or unplugged, rather than
    // waiting for the next poll tick. UPower's `on-battery` property flips on
    // the transition; the battery's sysfs `status`/`power_now` can lag the
    // event by a moment, so we also schedule a single follow-up update to catch
    // the reading once it settles.
    _watchPowerSource() {
        try {
            this._upowerClient = UPowerGlib.Client.new_full(null);
        } catch (_e) {
            // UPower unavailable; the poll loop still keeps the panel current.
            this._upowerClient = null;
            return;
        }

        this._onBatteryId = this._upowerClient.connect('notify::on-battery', () => {
            this._indicator.update();
            this._scheduleSettleUpdate();
            this._applyBrightness();
            this._applyPowerProfile();
        });
    }

    // Re-read once more after a short delay, to catch a value that the battery's
    // sysfs `status`/`power_now`/`current_now` reports late — both right after a
    // plug/unplug transition and at shell startup, where the driver may not have
    // taken its first measurement when the extension first reads it.
    _scheduleSettleUpdate() {
        this._clearSettleTimeout();
        this._settleTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 1500, () => {
                this._settleTimeoutId = null;
                this._indicator.update();
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearSettleTimeout() {
        if (this._settleTimeoutId) {
            GLib.Source.remove(this._settleTimeoutId);
            this._settleTimeoutId = null;
        }
    }

    _unwatchPowerSource() {
        this._clearSettleTimeout();
        if (this._upowerClient) {
            if (this._onBatteryId)
                this._upowerClient.disconnect(this._onBatteryId);
            this._onBatteryId = null;
            this._upowerClient = null;
        }
    }

    _setupBrightnessControl() {
        this._brightnessSettingIds = [
            this._settings.connect('changed::brightness-manage',     () => this._applyBrightness()),
            this._settings.connect('changed::brightness-on-battery', () => this._applyBrightness()),
            this._settings.connect('changed::brightness-on-ac',      () => this._applyBrightness()),
        ];
        // Apply the configured level at startup, but without the OSD popup: the
        // osdWindowManager isn't ready this early in enable(), and calling
        // show() here throws — which would propagate out of enable() and put the
        // whole extension into ERROR state.
        this._applyBrightness(false);
    }

    _applyBrightness(showOsd = true) {
        if (!this._settings || !this._settings.get_boolean('brightness-manage'))
            return;

        let onBattery = false;
        if (this._upowerClient)
            onBattery = this._upowerClient.on_battery;
        else {
            const m = readMetrics();
            onBattery = m ? m.onBattery : false;
        }

        const pct = this._settings.get_int(
            onBattery ? 'brightness-on-battery' : 'brightness-on-ac');

        // GNOME 50 moved screen-brightness control out of gsd-power (the old
        // org.gnome.SettingsDaemon.Power.Screen DBus interface is gone) and into
        // gnome-shell/mutter. Main.brightnessManager.globalScale is the
        // in-process object the Quick Settings brightness slider is bound to, so
        // writing its value (a 0..1 float) both drives the hardware via mutter's
        // backlight API *and* moves the slider — keeping the shell UI in sync.
        // Going around it (logind SetBrightness, raw sysfs) changes the hardware
        // but leaves the slider/OSD stale. globalScale is null when no monitor
        // exposes a controllable backlight, so guard for it.
        const scale = Main.brightnessManager?.globalScale;
        if (!scale)
            return;

        scale.value = Math.max(0, Math.min(1, pct / 100));

        // Guard the OSD: a failure here must never escape into enable() or a
        // settings handler and break the rest of the extension.
        if (showOsd) {
            try {
                Main.osdWindowManager.show(
                    -1,
                    Gio.ThemedIcon.new('display-brightness-symbolic'),
                    null,
                    pct / 100
                );
            } catch (_e) {}
        }
    }

    _setupPowerProfileControl() {
        this._powerProfileSettingIds = [
            this._settings.connect('changed::power-profile-manage',     () => this._applyPowerProfile()),
            this._settings.connect('changed::power-profile-on-battery', () => this._applyPowerProfile()),
            this._settings.connect('changed::power-profile-on-ac',      () => this._applyPowerProfile()),
        ];
        // Apply the configured profile for the current power source at startup.
        this._applyPowerProfile();
    }

    _applyPowerProfile() {
        if (!this._settings || !this._settings.get_boolean('power-profile-manage'))
            return;

        let onBattery = false;
        if (this._upowerClient)
            onBattery = this._upowerClient.on_battery;
        else {
            const m = readMetrics();
            onBattery = m ? m.onBattery : false;
        }

        const profile = this._settings.get_string(
            onBattery ? 'power-profile-on-battery' : 'power-profile-on-ac');
        if (!profile)
            return;

        // Drive power-profiles-daemon by writing its ActiveProfile property over
        // the system bus. The call is async (fire-and-forget) so it never blocks
        // the shell; a failure (daemon absent, or the profile no longer exists on
        // this hardware) is swallowed rather than escaping into enable() or a
        // settings handler.
        try {
            Gio.DBus.system.call(
                'net.hadess.PowerProfiles',
                '/net/hadess/PowerProfiles',
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', [
                    'net.hadess.PowerProfiles',
                    'ActiveProfile',
                    new GLib.Variant('s', profile),
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null);
        } catch (_e) {}
    }

    // Creates the indicator and adds it to the configured panel box. Re-running
    // this (on a panel-position change) tears down the old indicator first, so
    // it effectively moves the indicator between the left/center/right boxes.
    _addIndicator() {
        this._stopPolling();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._indicator = new PowerMonitorIndicator(this);
        // panel-position nicks ('left'/'center'/'right') match Main.panel's box
        // names, so the setting maps straight onto addToStatusArea's box arg.
        const box = this._settings.get_string('panel-position');
        // In the left box, index 0 would shove us to the far left, ahead of
        // Activities and everything else. Append after the existing items by
        // using the box's current child count instead.
        const boxActor = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        }[box];
        const position = box === 'left' && boxActor
            ? boxActor.get_n_children()
            : 0;
        Main.panel.addToStatusArea('power-monitor', this._indicator, position, box);

        this._indicator.checkBoot();

        this._startPolling();
    }

    _startPolling() {
        this._stopPolling();

        // Show a value immediately rather than waiting a full interval.
        this._indicator.update();

        const interval = this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._indicator.update();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPolling() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    disable() {
        this._stopPolling();
        this._unwatchPowerSource();

        if (this._brightnessSettingIds) {
            for (const id of this._brightnessSettingIds)
                this._settings.disconnect(id);
            this._brightnessSettingIds = null;
        }

        if (this._powerProfileSettingIds) {
            for (const id of this._powerProfileSettingIds)
                this._settings.disconnect(id);
            this._powerProfileSettingIds = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        this._settings = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
