'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const INTERVALS = [5, 10, 15, 20, 25, 30];

// Order matches the panel-position enum nicks; index <-> nick mapping for the combo.
const PANEL_POSITIONS = [
    {nick: 'left', label: 'Left'},
    {nick: 'center', label: 'Center'},
    {nick: 'right', label: 'Right'},
];

// Order matches the color-mode enum nicks; index <-> nick mapping for the combo.
const COLOR_MODES = [
    {nick: 'auto', label: 'Auto (follow system)'},
    {nick: 'light', label: 'Light'},
    {nick: 'dark', label: 'Dark'},
];

// Order matches the detail-size enum nicks; index <-> nick mapping for the combo.
const DETAIL_SIZES = [
    {nick: 'original', label: 'Original'},
    {nick: 'medium', label: 'Medium (1.25x)'},
    {nick: 'large', label: 'Large (1.5x)'},
];

// Detail panel placement. 'default' keeps the stock pill-anchored dropdown; the
// rest pin the panel to a cell of a 3x3 grid over the work area. Values are
// free-form strings (see the schema), so no enum to keep in sync.
const DETAIL_PANEL_POSITIONS = [
    {nick: 'default', label: 'Default'},
    {nick: 'top-left', label: 'Top left'},
    {nick: 'top-center', label: 'Top center'},
    {nick: 'top-right', label: 'Top right'},
    {nick: 'middle-left', label: 'Middle left'},
    {nick: 'middle-center', label: 'Middle center'},
    {nick: 'middle-right', label: 'Middle right'},
    {nick: 'bottom-left', label: 'Bottom left'},
    {nick: 'bottom-center', label: 'Bottom center'},
    {nick: 'bottom-right', label: 'Bottom right'},
];

// Friendly labels for the well-known power-profiles-daemon profiles. Anything
// not listed falls back to a title-cased version of its nick.
const POWER_PROFILE_LABELS = {
    'power-saver': 'Power Saver',
    'balanced': 'Balanced',
    'performance': 'Performance',
};

// The standard profiles, used when power-profiles-daemon can't be reached so the
// dropdowns still offer the usual choices instead of being empty.
const FALLBACK_POWER_PROFILES = ['power-saver', 'balanced', 'performance'];

function powerProfileLabel(nick) {
    if (POWER_PROFILE_LABELS[nick])
        return POWER_PROFILE_LABELS[nick];
    return nick.split(/[-_]/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

// Ask power-profiles-daemon (over the system bus) which profiles this hardware
// supports. The daemon reports them at runtime via the `Profiles` property — an
// array of dicts each carrying a `Profile` nick. Falls back to the standard set
// if the daemon is unavailable.
function availablePowerProfiles() {
    try {
        const reply = Gio.DBus.system.call_sync(
            'net.hadess.PowerProfiles',
            '/net/hadess/PowerProfiles',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['net.hadess.PowerProfiles', 'Profiles']),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null);
        const profiles = reply.get_child_value(0).recursiveUnpack()
            .map(p => p.Profile)
            .filter(Boolean);
        if (profiles.length)
            return profiles;
    } catch (_e) {
        // power-profiles-daemon not installed/running; use the standard set.
    }
    return FALLBACK_POWER_PROFILES;
}

export default class PowerMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlers = [];

        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        const powerPage = new Adw.PreferencesPage({
            title: 'Power',
            icon_name: 'battery-symbolic',
        });
        window.add(powerPage);

        const appearancePage = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'video-display-symbolic',
        });
        window.add(appearancePage);

        /* -------------------------- Panel group -------------------------- */

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'What the top bar shows.',
        });
        appearancePage.add(panelGroup);

        const positionModel = new Gtk.StringList();
        for (const position of PANEL_POSITIONS)
            positionModel.append(position.label);

        const positionRow = new Adw.ComboRow({
            title: 'Panel placement',
            subtitle: 'Which area of the top bar holds the indicator',
            model: positionModel,
        });
        const currentPosition = settings.get_string('panel-position');
        const positionIdx = PANEL_POSITIONS.findIndex(p => p.nick === currentPosition);
        positionRow.selected = positionIdx >= 0 ? positionIdx : PANEL_POSITIONS.findIndex(p => p.nick === 'right');
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', PANEL_POSITIONS[positionRow.selected].nick);
        });
        panelGroup.add(positionRow);

        const colorModeModel = new Gtk.StringList();
        for (const mode of COLOR_MODES)
            colorModeModel.append(mode.label);

        const colorModeRow = new Adw.ComboRow({
            title: 'Color mode',
            subtitle: 'Light, dark, or follow the system setting',
            model: colorModeModel,
        });
        const currentColorMode = settings.get_string('color-mode');
        const colorModeIdx = COLOR_MODES.findIndex(m => m.nick === currentColorMode);
        colorModeRow.selected = colorModeIdx >= 0 ? colorModeIdx : COLOR_MODES.findIndex(m => m.nick === 'auto');
        colorModeRow.connect('notify::selected', () => {
            settings.set_string('color-mode', COLOR_MODES[colorModeRow.selected].nick);
        });
        panelGroup.add(colorModeRow);

        const iconRow = new Adw.SwitchRow({
            title: 'Show battery icon',
            subtitle: 'Display the icon next to the value in the top bar',
        });
        settings.bind('panel-show-icon', iconRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(iconRow);

        const sizeModel = new Gtk.StringList();
        for (const size of DETAIL_SIZES)
            sizeModel.append(size.label);

        const sizeRow = new Adw.ComboRow({
            title: 'Detail panel size',
            subtitle: 'Scale of the dropdown detail panel',
            model: sizeModel,
        });
        const currentSize = settings.get_string('detail-size');
        const sizeIdx = DETAIL_SIZES.findIndex(s => s.nick === currentSize);
        sizeRow.selected = sizeIdx >= 0 ? sizeIdx : DETAIL_SIZES.findIndex(s => s.nick === 'original');
        sizeRow.connect('notify::selected', () => {
            settings.set_string('detail-size', DETAIL_SIZES[sizeRow.selected].nick);
        });
        panelGroup.add(sizeRow);

        const detailPosModel = new Gtk.StringList();
        for (const position of DETAIL_PANEL_POSITIONS)
            detailPosModel.append(position.label);

        const detailPosRow = new Adw.ComboRow({
            title: 'Detail panel placement',
            subtitle: 'Where the detail panel appears after clicking the pill',
            model: detailPosModel,
        });
        const currentDetailPos = settings.get_string('detail-panel-position');
        const detailPosIdx = DETAIL_PANEL_POSITIONS.findIndex(p => p.nick === currentDetailPos);
        detailPosRow.selected = detailPosIdx >= 0 ? detailPosIdx : 0;
        detailPosRow.connect('notify::selected', () => {
            settings.set_string('detail-panel-position', DETAIL_PANEL_POSITIONS[detailPosRow.selected].nick);
        });
        panelGroup.add(detailPosRow);

        /* ------------------------- General group ------------------------- */

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'How often the metrics are refreshed.',
        });
        generalPage.add(generalGroup);

        const model = new Gtk.StringList();
        for (const seconds of INTERVALS)
            model.append(`${seconds} seconds`);

        const intervalRow = new Adw.ComboRow({
            title: 'Refresh interval',
            subtitle: 'Time between power readings',
            model,
        });
        const current = settings.get_int('refresh-interval');
        const idx = INTERVALS.indexOf(current);
        intervalRow.selected = idx >= 0 ? idx : INTERVALS.indexOf(10);
        intervalRow.connect('notify::selected', () => {
            settings.set_int('refresh-interval', INTERVALS[intervalRow.selected]);
        });
        generalGroup.add(intervalRow);

        /* ---------------------- Screen Brightness group ------------------ */

        const brightnessGroup = new Adw.PreferencesGroup({
            title: 'Screen Brightness',
            description: 'Automatically set screen brightness when switching power sources.',
        });
        powerPage.add(brightnessGroup);

        const manageRow = new Adw.SwitchRow({
            title: 'Manage brightness',
            subtitle: 'Apply configured levels when plugging in or unplugging',
        });
        settings.bind('brightness-manage', manageRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        brightnessGroup.add(manageRow);

        const batterySpinRow = new Adw.SpinRow({
            title: 'On battery',
            subtitle: 'Brightness percentage while running on battery power',
            adjustment: new Gtk.Adjustment({
                lower: 20, upper: 100, step_increment: 5, page_increment: 10, value: 50,
            }),
            climb_rate: 1,
            digits: 0,
        });
        batterySpinRow.value = settings.get_int('brightness-on-battery');
        settings.bind('brightness-manage', batterySpinRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        brightnessGroup.add(batterySpinRow);
        batterySpinRow.connect('notify::value', () => {
            settings.set_int('brightness-on-battery', Math.round(batterySpinRow.value));
        });
        handlers.push(settings.connect('changed::brightness-on-battery', () => {
            batterySpinRow.value = settings.get_int('brightness-on-battery');
        }));

        const acSpinRow = new Adw.SpinRow({
            title: 'On AC power',
            subtitle: 'Brightness percentage while plugged in',
            adjustment: new Gtk.Adjustment({
                lower: 20, upper: 100, step_increment: 5, page_increment: 10, value: 100,
            }),
            climb_rate: 1,
            digits: 0,
        });
        acSpinRow.value = settings.get_int('brightness-on-ac');
        settings.bind('brightness-manage', acSpinRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        brightnessGroup.add(acSpinRow);
        acSpinRow.connect('notify::value', () => {
            settings.set_int('brightness-on-ac', Math.round(acSpinRow.value));
        });
        handlers.push(settings.connect('changed::brightness-on-ac', () => {
            acSpinRow.value = settings.get_int('brightness-on-ac');
        }));

        /* ---------------------- Power Profiles group --------------------- */

        const profileGroup = new Adw.PreferencesGroup({
            title: 'Power Profiles',
            description: 'Automatically set the system power profile when switching power sources.',
        });
        powerPage.add(profileGroup);

        const profileManageRow = new Adw.SwitchRow({
            title: 'Manage power profile',
            subtitle: 'Apply the selected profile when plugging in or unplugging',
        });
        settings.bind('power-profile-manage', profileManageRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        profileGroup.add(profileManageRow);

        const profiles = availablePowerProfiles();

        const addProfileRow = (title, subtitle, key, fallbackNick) => {
            const profileModel = new Gtk.StringList();
            for (const nick of profiles)
                profileModel.append(powerProfileLabel(nick));

            const row = new Adw.ComboRow({title, subtitle, model: profileModel});
            const stored = settings.get_string(key);
            let idx = profiles.indexOf(stored);
            if (idx < 0)
                idx = profiles.indexOf(fallbackNick);
            if (idx < 0)
                idx = 0;
            row.selected = idx;
            settings.bind('power-profile-manage', row, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
            row.connect('notify::selected', () => {
                settings.set_string(key, profiles[row.selected]);
            });
            profileGroup.add(row);
        };

        addProfileRow('On battery', 'Profile applied while running on battery power',
            'power-profile-on-battery', 'balanced');
        addProfileRow('On AC power', 'Profile applied while plugged in',
            'power-profile-on-ac', 'performance');

        /* ------------------------ Averages group ------------------------- */

        const avgGroup = new Adw.PreferencesGroup({
            title: 'Rolling Averages',
            description: 'Averages accumulate since the last reboot or manual reset.',
        });
        generalPage.add(avgGroup);

        const dischargeRow = new Adw.ActionRow({title: 'Average discharge'});
        const chargeRow = new Adw.ActionRow({title: 'Average charge'});
        const samplesRow = new Adw.ActionRow({title: 'Samples collected'});
        avgGroup.add(dischargeRow);
        avgGroup.add(chargeRow);
        avgGroup.add(samplesRow);

        const resetButton = new Gtk.Button({
            label: 'Reset Averages',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        const resetRow = new Adw.ActionRow({title: 'Reset accumulated data'});
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        avgGroup.add(resetRow);

        const average = (key) => {
            const count = settings.get_int(`${key}-count`);
            if (count <= 0)
                return null;
            return settings.get_double(`${key}-sum`) / count;
        };

        const refreshLabels = () => {
            const d = average('discharge');
            const c = average('charge');
            dischargeRow.subtitle = d === null ? 'No samples yet' : formatWatts(d);
            chargeRow.subtitle = c === null ? 'No samples yet' : formatWatts(c);
            samplesRow.subtitle = `${settings.get_int('discharge-count')}`;
        };

        refreshLabels();

        // Keep the displayed averages live while the panel keeps sampling.
        for (const key of [
            'discharge-sum', 'discharge-count',
            'charge-sum', 'charge-count',
        ])
            handlers.push(settings.connect(`changed::${key}`, refreshLabels));

        resetButton.connect('clicked', () => {
            for (const key of ['discharge', 'charge']) {
                settings.set_double(`${key}-sum`, 0.0);
                settings.set_int(`${key}-count`, 0);
            }
            refreshLabels();
        });

        window.connect('close-request', () => {
            for (const id of handlers)
                settings.disconnect(id);
        });
    }
}

function formatWatts(value) {
    return `${value.toFixed(1)} W`;
}
