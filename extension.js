'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import UPowerGlib from 'gi://UPowerGlib';

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
        const update = (icon, key) => {
            if (icon)
                icon.gicon = this._gicon(this._iconFileFor(key));
        };
        update(this._dischargeIcon, 'discharge');
        update(this._chargeIcon, 'charge');
        update(this._avgDischargeIcon, 'discharge');
        update(this._avgChargeIcon, 'charge');
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
        this._addHeader('Current:');
        ({label: this._dischargeItem, icon: this._dischargeIcon} =
            this._buildDetailItem(this._iconFileFor('discharge'), 'Discharge: –'));
        ({label: this._chargeItem, icon: this._chargeIcon} =
            this._buildDetailItem(this._iconFileFor('charge'), 'Charge: –'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addHeader('Averages:');
        ({label: this._avgDischargeItem, icon: this._avgDischargeIcon} =
            this._buildDetailItem(this._iconFileFor('discharge'), 'Discharge: –'));
        ({label: this._avgChargeItem, icon: this._avgChargeIcon} =
            this._buildDetailItem(this._iconFileFor('charge'), 'Charge: –'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const resetItem = new PopupMenu.PopupMenuItem('Reset Averages');
        resetItem.label.add_style_class_name('power-monitor-detail-label');
        resetItem.connect('activate', () => this.resetAverages());
        this.menu.addMenuItem(resetItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.label.add_style_class_name('power-monitor-detail-label');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);
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
            this._dischargeItem.text = 'Discharge: unavailable';
            this._chargeItem.text = 'Charge: unavailable';
            this._avgDischargeItem.text = 'Discharge: unavailable';
            this._avgChargeItem.text = 'Charge: unavailable';
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

        this._dischargeItem.text = `Discharge: ${formatWatts(metrics.discharge)}`;
        this._chargeItem.text = `Charge: ${formatWatts(metrics.charge)}`;

        const avgD = this._average('discharge');
        const avgC = this._average('charge');
        this._avgDischargeItem.text =
            `Discharge: ${avgD === null ? '–' : formatWatts(avgD)}`;
        this._avgChargeItem.text =
            `Charge: ${avgC === null ? '–' : formatWatts(avgC)}`;
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
