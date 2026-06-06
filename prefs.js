'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

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

export default class PowerMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Power Monitor',
            icon_name: 'battery-symbolic',
        });
        window.add(page);

        /* -------------------------- Panel group -------------------------- */

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'What the top bar shows.',
        });
        page.add(panelGroup);

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
            title: 'Show metric icon',
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

        /* ------------------------- General group ------------------------- */

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'How often the metrics are refreshed.',
        });
        page.add(generalGroup);

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

        /* ------------------------ Averages group ------------------------- */

        const avgGroup = new Adw.PreferencesGroup({
            title: 'Rolling Averages',
            description: 'Averages accumulate since the last reboot or manual reset.',
        });
        page.add(avgGroup);

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
        const handlers = [];
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
