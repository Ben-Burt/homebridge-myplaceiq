'use strict';

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^changes-(\d{4})-(\d{2})-(\d{2})\.log$/;
// A hub-side change seen within this long after a HomeKit command on the same
// accessory is treated as that command taking effect, not an outside change.
const ATTRIBUTION_WINDOW_MS = 60 * 1000;

/**
 * Change log. Always writes one line per change to a daily file in the
 * Homebridge storage folder (<storage>/myplaceiq-logs/changes-YYYY-MM-DD.log)
 * and deletes day files older than the retention period (default 30 days).
 * Optionally also prints each line to the Homebridge log.
 *
 * Two kinds of entries:
 *  - "HomeKit"  : a command the plugin sent because of a Home app / Siri /
 *                 automation action. HomeKit does not tell a plugin which
 *                 person did it, so the person is not recorded.
 *  - "hub"      : a change seen by comparing consecutive polls. If it follows
 *                 a HomeKit command on the same accessory it is labelled
 *                 "confirmed"; otherwise "changed outside HomeKit" (the
 *                 MyPlaceIQ app, a wall panel, or the system itself, e.g.
 *                 closing a zone that got too hot/cold).
 */
class ChangeLog {
  constructor({ storagePath, log, toConsole, retentionDays }) {
    this.log = log;
    this.toConsole = !!toConsole;
    const days = Number(retentionDays);
    this.retentionDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
    this.dir = path.join(storagePath, 'myplaceiq-logs');
    this.previous = null; // last snapshot, null until the first poll
    this.recentCommands = new Map(); // accessory name -> timestamp
    this.writeFailed = false;
    this.pruneTimer = null;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this._failOnce(err);
    }
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), DAY_MS);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  stop() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  /** Record a command sent because of a HomeKit action. */
  command(accessoryName, description) {
    this.recentCommands.set(accessoryName, Date.now());
    this._write(`HomeKit | ${accessoryName}: ${description}`);
  }

  /** Record a failed command. */
  commandFailed(accessoryName, message) {
    this._write(`HomeKit | ${accessoryName}: command FAILED - ${message}`);
  }

  /** Compare a fresh getFullData() body with the previous one. */
  diff(data) {
    const snap = ChangeLog.snapshot(data);
    const prev = this.previous;
    this.previous = snap;
    if (!prev) return; // first poll is the baseline

    const now = Date.now();
    for (const [key, cur] of Object.entries(snap)) {
      const old = prev[key];
      if (!old) continue; // new accessory - not a change worth logging
      for (const [field, label, fmt] of ChangeLog.FIELDS) {
        if (cur[field] === undefined || old[field] === undefined) continue;
        if (cur[field] === old[field]) continue;
        const sentAt = this.recentCommands.get(cur.name);
        const confirmed = sentAt !== undefined && now - sentAt <= ATTRIBUTION_WINDOW_MS;
        const source = confirmed ? 'hub (confirmed)' : 'hub (changed outside HomeKit)';
        this._write(`${source} | ${cur.name}: ${label} ${fmt(old[field])} -> ${fmt(cur[field])}`);
      }
    }
  }

  static snapshot(data) {
    const out = {};
    for (const [id, a] of Object.entries((data && data.aircons) || {})) {
      out[`aircon-${id}`] = {
        name: a.name || `Aircon ${id}`,
        isOn: !!a.isOn,
        mode: a.mode,
        targetTemperatureHeat: a.targetTemperatureHeat,
        targetTemperatureCool: a.targetTemperatureCool,
      };
    }
    for (const [id, z] of Object.entries((data && data.zones) || {})) {
      if (!z.isVisible) continue;
      out[`zone-${id}`] = {
        name: z.name || `Zone ${id}`,
        isOn: !!z.isOn,
        targetTemperatureHeat: z.targetTemperatureHeat,
        targetTemperatureCool: z.targetTemperatureCool,
        isPriorityZone: !!z.isPriorityZone,
      };
    }
    return out;
  }

  /** Delete day files older than the retention period. */
  prune() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      return; // directory missing/unreadable - nothing to prune
    }
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue; // never touch files we didn't create
      const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (fileDay < cutoff) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch (err) { /* ignore */ }
      }
    }
  }

  _write(message) {
    const d = new Date();
    const line = `${ChangeLog.stamp(d)} | ${message}`;
    if (this.toConsole) this.log.info(`[MyPlaceIQ] ${message}`);
    const file = path.join(this.dir, `changes-${ChangeLog.day(d)}.log`);
    fs.appendFile(file, `${line}\n`, (err) => { if (err) this._failOnce(err); });
  }

  _failOnce(err) {
    if (this.writeFailed) return;
    this.writeFailed = true;
    this.log.warn(`[MyPlaceIQ] Could not write change log in ${this.dir}: ${err.message}`);
  }

  static day(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  static stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${ChangeLog.day(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      + ` ${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  }
}

ChangeLog.FIELDS = [
  ['isOn', 'power', (v) => (v ? 'on' : 'off')],
  ['mode', 'mode', (v) => String(v)],
  ['targetTemperatureHeat', 'heat target', (v) => `${v}°C`],
  ['targetTemperatureCool', 'cool target', (v) => `${v}°C`],
  ['isPriorityZone', 'priority', (v) => (v ? 'on' : 'off')],
];

module.exports = { ChangeLog };
