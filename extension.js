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

const HISTORY_MAX = 1440; // 4 hrs at 10 s intervals
const CHART_HEIGHT = 160;
const CHART_RANGES = [
    {label: '15 min', ms: 15 * 60 * 1000},
    {label: '1 hr',   ms: 60 * 60 * 1000},
    {label: '4 hr',   ms: 4 * 60 * 60 * 1000},
];

/* ----------------------------- sysfs helpers ----------------------------- */

function readText(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(contents).trim();
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
function readMetrics() {
    const name = findBattery();
    if (name === null)
        return null;

    const status = readText(`${POWER_SUPPLY_PATH}/${name}/status`) || 'Unknown';
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

        // Rolling history buffer for the chart (in-memory, no file I/O).
        this._history = [];
        this._chartRange = 60 * 60 * 1000; // default: 1 hr
        this._lastMetrics = null;
        this._repaintId = null;
        this._menuOpenId = null;

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
        this._applyDetailSize();
        this._applyColorMode();

        // Rebuild the panel when the user toggles whether the icon is shown.
        this._panelChangedIds = [
            this._settings.connect('changed::panel-show-icon', () => this._rebuildPanel()),
            this._settings.connect('changed::detail-size', () => this._applyDetailSize()),
            this._settings.connect('changed::color-mode', () => this._applyColorMode()),
        ];

        if (this._ifaceSettings) {
            this._ifaceColorId = this._ifaceSettings.connect('changed::color-scheme', () => {
                if (this._settings.get_string('color-mode') === 'auto')
                    this._applyColorMode();
            });
        }

        this.connect('destroy', () => {
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
            if (this._repaintId && this._chartArea) {
                this._chartArea.disconnect(this._repaintId);
                this._repaintId = null;
            }
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
            this._panelIcon = this._buildIcon(
                this._iconFileFor('discharge'), 'system-status-icon power-monitor-icon');
            if (this._panelIcon)
                this._panelBox.add_child(this._panelIcon);
        } else {
            this._panelIcon = null;
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
        if (this._panelIcon)
            this._panelIcon.gicon = this._gicon(this._iconFileFor(this._lastActiveKey ?? 'discharge'));
    }

    // Returns a Gio.Icon for the given icon file, or null if it is missing.
    _gicon(iconFile) {
        const iconPath = GLib.build_filenamev([this._extension.path, 'icons', iconFile]);
        if (!GLib.file_test(iconPath, GLib.FileTest.EXISTS))
            return null;
        return Gio.icon_new_for_string(iconPath);
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

    _buildMenu() {
        this._buildChartSection();

        const resetItem = new PopupMenu.PopupMenuItem('Reset Averages');
        resetItem.label.add_style_class_name('power-monitor-detail-label');
        resetItem.connect('activate', () => this.resetAverages());
        this.menu.addMenuItem(resetItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.label.add_style_class_name('power-monitor-detail-label');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    /* -------------------------- chart section ---------------------------- */

    _buildChartSection() {
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

        // 2×2 data summary below the chart
        const dataRow = new St.BoxLayout({
            x_expand: true,
            style_class: 'power-monitor-data-row',
        });
        const leftCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'power-monitor-data-col',
        });
        const rightCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'power-monitor-data-col',
        });

        const makeLabel = text => new St.Label({
            text,
            style_class: 'power-monitor-grid-label',
            x_expand: true,
        });

        this._gridDischarge    = makeLabel('Discharge: –');
        this._gridAvgDischarge = makeLabel('Avg: –');
        this._gridCharge       = makeLabel('Charge: –');
        this._gridAvgCharge    = makeLabel('Avg: –');

        leftCol.add_child(this._gridDischarge);
        leftCol.add_child(this._gridAvgDischarge);
        rightCol.add_child(this._gridCharge);
        rightCol.add_child(this._gridAvgCharge);
        dataRow.add_child(leftCol);
        dataRow.add_child(rightCol);
        vbox.add_child(dataRow);

        this.menu.addMenuItem(outerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Repaint on open so the chart is fresh on first show.
        this._menuOpenId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen && this._chartArea)
                this._chartArea.queue_repaint();
        });

        this._updateRangeBtnStyles();
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
        this._history.push({
            t: Date.now(),
            discharge: metrics.discharge,
            charge: metrics.charge,
        });
        if (this._history.length > HISTORY_MAX)
            this._history.shift();
    }

    _updateChartData() {
        if (!this._lastMetrics)
            return;
        const m = this._lastMetrics;
        const avgD = this._average('discharge');
        const avgC = this._average('charge');
        this._gridDischarge.text    = `Dis: ${formatWatts(m.discharge)}`;
        this._gridCharge.text       = `Chg: ${formatWatts(m.charge)}`;
        this._gridAvgDischarge.text = `Avg: ${avgD === null ? '–' : formatWatts(avgD)}`;
        this._gridAvgCharge.text    = `Avg: ${avgC === null ? '–' : formatWatts(avgC)}`;
    }

    _drawChart(area) {
        const cr = area.get_context();
        const allocBox = area.get_allocation_box();
        const W = allocBox.x2 - allocBox.x1;
        const H = allocBox.y2 - allocBox.y1;

        const now = Date.now();
        const windowMs = this._chartRange;
        const cutoff = now - windowMs;
        const samples = this._history.filter(s => s.t >= cutoff);

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
        for (const s of samples) {
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

        if (samples.length > 1) {
            const x0 = toX(samples[0].t);
            const xN = toX(samples[samples.length - 1].t);

            // Charge area — green fill above zero line
            cr.setSourceRGBA(0.18, 0.72, 0.27, 0.3);
            cr.moveTo(x0, cy);
            for (const s of samples)
                cr.lineTo(toX(s.t), toY(s.charge));
            cr.lineTo(xN, cy);
            cr.closePath();
            cr.fill();

            // Charge stroke
            cr.setSourceRGBA(0.2, 0.82, 0.32, 0.85);
            cr.setLineWidth(1.5);
            cr.moveTo(toX(samples[0].t), toY(samples[0].charge));
            for (let i = 1; i < samples.length; i++)
                cr.lineTo(toX(samples[i].t), toY(samples[i].charge));
            cr.stroke();

            // Discharge area — red fill below zero line
            cr.setSourceRGBA(0.82, 0.18, 0.18, 0.3);
            cr.moveTo(x0, cy);
            for (const s of samples)
                cr.lineTo(toX(s.t), toY(s.discharge));
            cr.lineTo(xN, cy);
            cr.closePath();
            cr.fill();

            // Discharge stroke
            cr.setSourceRGBA(0.9, 0.25, 0.2, 0.85);
            cr.setLineWidth(1.5);
            cr.moveTo(toX(samples[0].t), toY(samples[0].discharge));
            for (let i = 1; i < samples.length; i++)
                cr.lineTo(toX(samples[i].t), toY(samples[i].discharge));
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
        }
    }

    _accumulate(key, value) {
        const sum = this._settings.get_double(`${key}-sum`) + value;
        const count = this._settings.get_int(`${key}-count`) + 1;
        this._settings.set_double(`${key}-sum`, sum);
        this._settings.set_int(`${key}-count`, count);
    }

    _average(key) {
        const count = this._settings.get_int(`${key}-count`);
        if (count <= 0)
            return null;
        return this._settings.get_double(`${key}-sum`) / count;
    }

    /* ------------------------------ refresh ------------------------------ */

    update() {
        const metrics = readMetrics();

        if (metrics === null) {
            this._panelLabel.text = 'n/a';
            return;
        }

        this._accumulate('discharge', metrics.discharge);
        this._accumulate('charge', metrics.charge);

        // Surface the metric that matches the plug state: discharge while the
        // laptop is unplugged, charge while it is plugged in. This holds even
        // when the active value is 0 W (e.g. a plugged-in battery that is Full
        // or Not charging still shows charge, not discharge).
        const activeKey = metrics.onBattery ? 'discharge' : 'charge';
        this._lastActiveKey = activeKey;
        this._panelLabel.text = formatWatts(metrics[activeKey]);
        if (this._panelIcon)
            this._panelIcon.gicon = this._gicon(this._iconFileFor(activeKey));

        // Feed the history buffer and refresh the chart (only while open).
        this._lastMetrics = metrics;
        this._pushHistory(metrics);
        this._updateChartData();
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

        this._addIndicator();

        // Restart the polling loop whenever the interval setting changes.
        this._settingsChangedId = this._settings.connect(
            'changed::refresh-interval', () => this._startPolling());

        // Re-place the indicator when the user moves it between panel boxes.
        this._positionChangedId = this._settings.connect(
            'changed::panel-position', () => this._addIndicator());

        this._watchPowerSource();

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
