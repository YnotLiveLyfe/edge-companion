/*
  XENEON EDGE Companion

  The ObsidianEdge widget runs inside iCUE on the Corsair XENEON EDGE touchscreen. A widget can only carry web
  files, so it reaches Obsidian through a small local server over plain HTTP. During development that server is the
  Node helper (helper/obsidian-helper.mjs in the obsidian-edge repository), which drives Obsidian from outside
  through the Obsidian CLI. This plugin is the shippable form of the same server: it runs inside Obsidian and
  answers the same routes with the same status codes, headers and bodies (the contract is docs/helper-api.md), so
  the unchanged widget works against it. Where the helper ran an `eval` string inside Obsidian, this file makes the
  same calls directly on `this.app`.

  What it does on this PC, and nothing more:
  - listens on the loopback addresses 127.0.0.1 and [::1] only (port 47610 unless changed in settings);
  - makes no outgoing connection and sends no telemetry;
  - writes only its own settings file (pins and folder colours), a note's frontmatter `color:` key when the panel
    sets a colour, and reorganise-plan notes in the plans folder when the panel asks for one. It never moves,
    renames or deletes anything in the vault.

  Plain CommonJS with no build step on purpose: the file Obsidian runs is the file you are reading.
*/
"use strict";

const http = require("http");
const nodePath = require("path");
// Node's timers, not the window's: Chromium throttles window timers while Obsidian's window is hidden or
// minimised, and the server's clocks (snapshot, long-poll hold, event debounce) should keep their pace then.
const timers = require("timers");
const { Buffer } = require("buffer");
const { spawn } = require("child_process");
const nodeFs = require("fs");
const { Plugin, PluginSettingTab, Setting, Notice, TAbstractFile, TFile, TFolder, Platform, MarkdownView, normalizePath } = require("obsidian");

// ---------------------------------------------------------------- the EDGE's pages (helper/edge-pages.mjs, inlined)
//
// Generated from the helper's module by the clone's patch step; edit the module and regenerate rather than
// this copy. What it is: iCUE turns the EDGE's pages itself through the "Previous / Next Display Screen"
// keystrokes recorded in XENEON EDGE > Screen Setup (global hotkeys, fired here by injected input while
// Obsidian or iCUE is the foreground window); which page is showing comes from iCUE's own store
// (%APPDATA%\Corsair\CUE5\dashlcd\storage). One long-lived PowerShell child presses the keys and reads
// the foreground window. Measured 2026-10-27: 6 of 6 turns at 306 to 338 ms with Obsidian in front.
const WIDGET_TYPE_ID = "com.pathfinder.obsidian-edge";
const PAGE_STORE = nodePath.join(process.env.APPDATA || "", "Corsair", "CUE5", "dashlcd", "storage");
const DEFAULT_KEYS = { next: "Ctrl+Alt+Shift+PageDown", prev: "Ctrl+Alt+Shift+PageUp" };
const SETTLE_MS = 1600;        // how long a press waits for the store to move
const POLL_MS = 100;
const FOCUS_SETTLE_MS = 450;   // after bringing Obsidian forward, before the chord
const RETRY_WAIT_MS = 300;
const CHILD_TIMEOUT_MS = 6000;
const APP_PROCESS = "Obsidian";
const APP_TITLE = " - Obsidian ";  // the main window's title ends "... - <vault> - Obsidian <version>"
const FRONT_OK = /^(obsidian|icue)$/i;

// The child: one PowerShell 5.1 process reading commands from stdin, one answer line each.
//   ping                      -> pong
//   fg                        -> <pid>\t<process name>\t<title>
//   focus <title fragment>    -> ok <pid> | fail
//   press <chord>             -> ok | bad-key <token>
const CHILD_SCRIPT = String.raw`
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class EP {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  public static void Key(ushort vk, bool up, bool ext) {
    INPUT[] i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = vk; i[0].u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i[0].u.ki.dwFlags = (up ? 2u : 0u) | (ext ? 1u : 0u);
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string Fg() {
    IntPtr h = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(h, out pid); string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return pid + "\t" + name + "\t" + Title(h);
  }
  public static IntPtr Find(string fragment) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; string t = Title(h); if (t.Length > 0 && t.Contains(fragment)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Focus(string fragment) {
    IntPtr h = Find(fragment); if (h == IntPtr.Zero) return "fail no-window";
    if (IsIconic(h)) ShowWindow(h, 9);
    uint pid; uint t = GetWindowThreadProcessId(GetForegroundWindow(), out pid); uint me = GetCurrentThreadId();
    AttachThreadInput(me, t, true); BringWindowToTop(h); bool ok = SetForegroundWindow(h); AttachThreadInput(me, t, false);
    uint wp; GetWindowThreadProcessId(h, out wp);
    return (ok || GetForegroundWindow() == h) ? "ok " + wp : "fail";
  }
}
"@
$vkMap = @{ ctrl=0x11; control=0x11; alt=0x12; shift=0x10; win=0x5B; pageup=0x21; pagedown=0x22; home=0x24; end=0x23; left=0x25; up=0x26; right=0x27; down=0x28; insert=0x2D; delete=0x2E; escape=0x1B; esc=0x1B; tab=0x09; enter=0x0D; space=0x20 }
$extended = @(0x21, 0x22, 0x24, 0x23, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E)
function Resolve-Key([string]$tok) {
  $k = $tok.Trim().ToLowerInvariant()
  if ($vkMap.ContainsKey($k)) { return $vkMap[$k] }
  if ($k -match '^f([1-9]|1[0-9]|2[0-4])$') { return 0x6F + [int]$Matches[1] }
  if ($k.Length -eq 1) { return [int][char]$k.ToUpperInvariant() }
  return -1
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $sp = $line.IndexOf(' '); $cmd = if ($sp -ge 0) { $line.Substring(0, $sp) } else { $line }; $arg = if ($sp -ge 0) { $line.Substring($sp + 1) } else { '' }
  $out = 'unknown'
  try {
    switch ($cmd) {
      'ping' { $out = 'pong' }
      'fg' { $out = [EP]::Fg() }
      'focus' { $out = [EP]::Focus($arg) }
      'press' {
        $vks = @(); $bad = $null
        foreach ($tok in $arg.Split('+')) { $vk = Resolve-Key $tok; if ($vk -lt 0) { $bad = $tok }; $vks += $vk }
        if ($bad) { $out = "bad-key $bad" }
        else {
          foreach ($vk in $vks) { [EP]::Key([uint16]$vk, $false, ($extended -contains $vk)); Start-Sleep -Milliseconds 30 }
          Start-Sleep -Milliseconds 30
          [array]::Reverse($vks)
          foreach ($vk in $vks) { [EP]::Key([uint16]$vk, $true, ($extended -contains $vk)); Start-Sleep -Milliseconds 30 }
          $out = 'ok'
        }
      }
    }
  } catch { $out = "error " + $_.Exception.Message }
  [Console]::Out.WriteLine($out); [Console]::Out.Flush()
}
`;

function parsePages(xml, typeId) {
  const start = xml.indexOf("<screenCollection>");
  const end = xml.indexOf("</screenCollection>");
  if (start < 0 || end < 0) return { ok: false, error: "no screenCollection", list: [], active: null, index: -1, ours: [] };
  const body = xml.slice(start, end);
  const list = [];
  const re = /<screenId>(\{[^}]+\})<\/screenId>\s*<name>([^<]*)<\/name>/g;
  let last = 0;
  let m;
  while ((m = re.exec(body))) {
    const chunk = body.slice(last, m.index);
    last = m.index + m[0].length;
    const widgets = [...chunk.matchAll(/<typeId>([^<]+)<\/typeId>/g)].map((w) => w[1]);
    list.push({ id: m[1], name: m[2], ours: widgets.includes(typeId), widgets });
  }
  const active = (/<activeScreenId>(\{[^}]+\})<\/activeScreenId>/.exec(body) || [])[1] || null;
  const index = list.findIndex((p) => p.id === active);
  return { ok: list.length > 0, error: list.length ? null : "no screens", list, active, index, ours: list.map((p, i) => (p.ours ? i : -1)).filter((i) => i >= 0) };
}

const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));

/** One long-lived PowerShell child; starts on first use, restarts after an exit. */
class KeyChild {
  constructor(log) {
    this.log = log || (() => {});
    this.proc = null;
    this.queue = [];      // pending { resolve, reject, timer }
    this.buf = "";
    this.ready = null;
    this.disposed = false;
  }
  start() {
    if (this.proc || this.disposed) return this.ready;
    const encoded = Buffer.from(CHILD_SCRIPT, "utf16le").toString("base64");
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        const head = this.queue.shift();
        if (head) { clearTimeout(head.timer); head.resolve(line); }
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (t) => this.log("key child stderr: " + String(t).trim().slice(0, 300)));
    proc.on("exit", (code) => {
      this.log(`key child exited (${code})`);
      if (this.proc === proc) this.proc = null;
      this.ready = null;
      for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(new Error("child-exited")); }
    });
    proc.on("error", (e) => this.log("key child failed to start: " + e.message));
    this.ready = this.send("ping", 20000).then((r) => r === "pong");
    return this.ready;
  }
  send(line, timeoutMs = CHILD_TIMEOUT_MS) {
    if (this.disposed) return Promise.reject(new Error("disposed"));
    if (!this.proc) this.start();
    const proc = this.proc;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("child-timeout"));
      }, timeoutMs);
      this.queue.push(entry);
      try { proc.stdin.write(line + "\n"); } catch (e) { clearTimeout(entry.timer); this.queue.splice(this.queue.indexOf(entry), 1); reject(e); }
    });
  }
  /** `{ pid, name, title }` of the foreground window, or null when the child cannot say. */
  async foreground() {
    try {
      const r = await this.send("fg");
      const [pid, name, title] = r.split("\t");
      return { pid: Number(pid) || 0, name: name || "", title: title || "" };
    } catch (e) {
      return null;
    }
  }
  dispose() {
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.stdin.end(); } catch {} try { proc.kill(); } catch {} }
    for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(new Error("disposed")); }
  }
}

/** The pages: the store read, the presses, the jump. `keys()` returns the current chords. */
class PageTurner {
  constructor({ typeId, keys, log }) {
    this.typeId = typeId;
    this.keys = keys;           // () => { next, prev }
    this.log = log || (() => {});
    this.child = new KeyChild(this.log);
    this.mtime = -1;
    this.pages = { ok: false, error: "not read yet", list: [], active: null, index: -1, ours: [] };
    this.jumping = false;
    this.noStoreLogged = false;
  }
  /** Re-read the store when its mtime moved (or `force`). Returns true when the shown page changed. */
  refresh(force = false) {
    let mtime = -1;
    try {
      mtime = nodeFs.statSync(PAGE_STORE).mtimeMs;
    } catch (e) {
      if (!this.noStoreLogged) { this.noStoreLogged = true; this.log(`iCUE page store not found: ${PAGE_STORE}`); }
      this.pages = { ok: false, error: "no store", list: [], active: null, index: -1, ours: [] };
      return false;
    }
    if (!force && mtime === this.mtime) return false;
    this.mtime = mtime;
    const before = this.pages.active;
    try {
      this.pages = parsePages(nodeFs.readFileSync(PAGE_STORE, "utf8"), this.typeId);
    } catch (e) {
      this.pages = { ok: false, error: String(e), list: [], active: null, index: -1, ours: [] };
    }
    return this.pages.active !== before;
  }
  /** The widget's view: `{ count, shown (1-based, 0 unknown), ours (1-based), follow is the caller's }`. */
  summary() {
    const p = this.pages;
    return { count: p.list.length, shown: p.index + 1, ours: p.ours.map((i) => i + 1), names: p.list.map((x) => x.name) };
  }
  /** Bring Obsidian forward unless Obsidian or iCUE already is; the chord only fires then. */
  async ensureFront() {
    const fg = await this.child.foreground();
    if (fg && FRONT_OK.test(fg.name)) return { ok: true, focused: false, name: fg.name };
    let r = "";
    try { r = await this.child.send("focus " + APP_TITLE); } catch (e) { return { ok: false, error: "focus-failed: " + e.message }; }
    if (!r.startsWith("ok")) return { ok: false, error: "focus-" + r.replace(/\s+/g, "-") };
    await sleep(FOCUS_SETTLE_MS);
    const again = await this.child.foreground();
    if (again && again.name === APP_PROCESS) return { ok: true, focused: true, name: again.name };
    return { ok: false, error: "not-in-front" };
  }
  async waitForTurn(from) {
    const t0 = Date.now();
    while (Date.now() - t0 < SETTLE_MS) {
      await sleep(POLL_MS);
      if (this.refresh() && this.pages.index !== from) return true;
    }
    return this.pages.index !== from;
  }
  /** One press of next or prev, verified against the store. */
  async press(dir) {
    this.refresh(true);
    const from = this.pages.index;
    const chord = dir === "next" ? this.keys().next : this.keys().prev;
    const front = await this.ensureFront();
    if (!front.ok) { this.log(`${dir}: not pressed, ${front.error}`); return { ok: false, changed: false, from, to: from, error: front.error }; }
    let changed = false;
    for (let attempt = 0; attempt < 2 && !changed; attempt++) {
      let r;
      try { r = await this.child.send("press " + chord); } catch (e) { return { ok: false, changed: false, from, to: from, error: "send-failed: " + e.message }; }
      if (r !== "ok") return { ok: false, changed: false, from, to: from, error: r.replace(/\s+/g, "-") };
      changed = await this.waitForTurn(from);
      if (!changed && attempt === 0) await sleep(RETRY_WAIT_MS);
    }
    this.log(`${dir} (${chord}): page ${from + 1} -> ${this.pages.index + 1}${changed ? (front.focused ? ", Obsidian brought forward" : "") : " (no change; are the Screen Setup keys recorded?)"}`);
    return { ok: true, changed, from, to: this.pages.index };
  }
  /** Press toward the nearest page holding our widget, one verified step at a time. */
  async jumpToOurs() {
    this.refresh(true);
    const p = this.pages;
    if (!p.ok) return { ok: false, steps: 0, index: p.index, error: p.error || "no-pages" };
    if (p.ours.length === 0) return { ok: false, steps: 0, index: p.index, error: "widget-on-no-page" };
    if (this.jumping) return { ok: false, steps: 0, index: p.index, error: "busy" };
    this.jumping = true;
    try {
      let steps = 0;
      for (let guard = 0; guard < this.pages.list.length; guard++) {
        const cur = this.pages;
        if (cur.index < 0) return { ok: false, steps, index: cur.index, error: "active-page-unknown" };
        if (cur.list[cur.index] && cur.list[cur.index].ours) return { ok: true, steps, index: cur.index };
        const target = cur.ours.reduce((best, i) => (Math.abs(i - cur.index) < Math.abs(best - cur.index) ? i : best), cur.ours[0]);
        const r = await this.press(target > cur.index ? "next" : "prev");
        steps++;
        if (!r.ok || !r.changed) return { ok: false, steps, index: this.pages.index, error: r.error || "page-did-not-turn" };
      }
      return { ok: false, steps, index: this.pages.index, error: "gave-up" };
    } finally {
      this.jumping = false;
    }
  }
  dispose() { this.child.dispose(); }
}

// ---------------------------------------------------------------- constants (the helper's values, unchanged)

const VERSION = "0.2.0"; // what /health reports, equal to manifest.json (bump both together)
const DEFAULTS = { port: 47610, plansFolder: "ObsidianEdge/plans", verbose: false, token: "", pageNext: DEFAULT_KEYS.next, pagePrev: DEFAULT_KEYS.prev, followPage: true };

const ACTIVE_MS = 450;           // snapshot clock while a client listens
const IDLE_MS = 5000;            // snapshot clock otherwise
const CLIENT_WINDOW_MS = 15000;  // a client counts as listening this long after its last /state or /events
const LONG_POLL_MS = 10000;      // how long /state and /events hold a request that carries ?since=
const EDITOR_QUIET_MS = 150;     // editor-change fires per keystroke: wait for a pause before marking dirty
const EVENT_QUIET_MS = 300;      // per-path debounce of vault events, as the helper's watcher flush
const EVENT_RING = 200;
const RECENT_CHANGES = 12;
const PIN_CAP = 12;
const READ_CAP = 256 * 1024;
const CANVAS_READ_CAP = 2 * 1024 * 1024; // a canvas is JSON: truncated means broken, so it gets more room
const GAUGES_CAP = 2 * 1024 * 1024;
const REGISTRY_MS = 60000;
const NOTE_COLORS_MS = 30000;
const TREE_CAP = 400;
const COLOR_MAX = 8;
const IMAGE_MAX = 20 * 1024 * 1024;
const JSON_TYPE = "application/json; charset=utf-8";

const IGNORE = /(^|[\\/])(\.obsidian|\.git|\.smart-env|\.trash|node_modules|\.worktrees)([\\/]|$)/;
const DOT_SEGMENT = /(^|\/)\./;          // any path segment that starts with a dot
const NOTE_FILE = /\.(md|canvas)$/i;
const WATCHED_FILE = /\.(md|canvas|base)$/i;

// The commands the panel may run. Anything else answers 404 not-allowed.
const ALLOW_PREFIX = ["editor:", "workspace:", "file-explorer:", "bookmarks:", "outline:", "note-composer:", "obsidian-git:", "daily-notes", "switcher:", "global-search:", "command-palette:", "app:go-", "markdown:toggle-preview", "theme:", "window:"];
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif" };
// The widget's palette: Obsidian's six canvas presets plus blue and pink. `color=1..8` maps here.
const PALETTE = ["#fb464c", "#e9973f", "#e0de71", "#44cf6e", "#53dfdd", "#a882ff", "#086ddd", "#ff6fae"];

// ---------------------------------------------------------------- small pure helpers (ported from the helper)

/** A vault-relative path from the query string, or null: no "..", no leading slash, no drive letter. */
function safeRel(p) {
  if (typeof p !== "string" || !p) return null;
  const norm = p.replace(/\\/g, "/");
  if (norm.includes("..") || norm.startsWith("/") || /^[a-z]:/i.test(norm)) return null;
  return norm;
}

function entryName(rel) { const i = rel.lastIndexOf("/"); return rel.slice(i + 1).replace(/\.(md|canvas)$/i, ""); }
function folderOf(rel) { return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""; }
function extOf(rel) { return nodePath.posix.extname(rel).toLowerCase(); }
function errorText(e) { return String((e && e.message) || e); }

/** "none" or "0" clears, "#rrggbb" is kept (lower case), 1..8 picks from the palette; anything else is null (refused). */
function parseColor(v) {
  if (v === "none" || v === "0" || v === "") return "";
  if (/^#[0-9a-f]{6}$/i.test(v || "")) return v.toLowerCase();
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= COLOR_MAX ? PALETTE[n - 1] : null;
}

function allowed(id) { return typeof id === "string" && /^[a-z0-9:_-]+$/i.test(id) && ALLOW_PREFIX.some((p) => id.startsWith(p)); }

/** The gauges of one note: words, characters, reading time and its own tasks. Frontmatter is not counted. */
function countGauges(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // The class holds both apostrophes, the straight one and the typographic one (U+2019), as the helper's does.
  const words = (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  const open = (body.match(/^\s*(?:[-*+]|\d+[.)])\s\[ \]/gm) || []).length;
  const done = (body.match(/^\s*(?:[-*+]|\d+[.)])\s\[[xX]\]/gm) || []).length;
  return { words, characters: body.length, readMinutes: Math.max(1, Math.round(words / 200)), tasks: { open, done, total: open + done } };
}

/**
 * A command's first hotkey as text ("Ctrl+Shift+K"), or "" when it has none. The hotkey manager is not in
 * Obsidian's public typings, so every step is guarded. getHotkeys() answers the user's own binding (an empty list
 * when they removed it) or nothing when they never changed it; then the default binding applies.
 */
function hotkeyText(app, id) {
  try {
    const hm = app.hotkeyManager;
    const command = app.commands && app.commands.commands ? app.commands.commands[id] : null;
    let list = hm && typeof hm.getHotkeys === "function" ? hm.getHotkeys(id) : null;
    if (!list && hm && typeof hm.getDefaultHotkeys === "function") list = hm.getDefaultHotkeys(id);
    if (!list && command) list = command.hotkeys;
    const hotkey = Array.isArray(list) ? list[0] : null;
    if (!hotkey || typeof hotkey.key !== "string" || !hotkey.key) return "";
    const mac = Platform.isMacOS;
    const label = { Mod: mac ? "Cmd" : "Ctrl", Ctrl: "Ctrl", Meta: mac ? "Cmd" : "Win", Alt: mac ? "Option" : "Alt", Shift: "Shift" };
    const mods = Array.isArray(hotkey.modifiers) ? hotkey.modifiers : [];
    const parts = [];
    for (const m of ["Mod", "Ctrl", "Meta", "Alt", "Shift"]) {
      if (mods.indexOf(m) >= 0 && parts.indexOf(label[m]) < 0) parts.push(label[m]);
    }
    parts.push(hotkey.key === " " ? "Space" : hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
    return parts.join("+");
  } catch (e) {
    return "";
  }
}

// ---------------------------------------------------------------- HTTP plumbing (as the helper's)

/** One answer with the contract's headers. A response that already ended, or whose client left, is left alone. */
function send(res, status, body, type) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": type || JSON_TYPE, "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** Answer at once when there is news; otherwise hold the request until a waiter fires or LONG_POLL_MS pass. */
function longPoll(waiters, hasNews, build, res) {
  if (hasNews()) return send(res, 200, build());
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    waiters.delete(finish);
    timers.clearTimeout(timer);
    send(res, 200, build());
  };
  // Used when the server stops: the socket is destroyed right after, so only the bookkeeping goes.
  finish.drop = () => { done = true; timers.clearTimeout(timer); };
  waiters.add(finish);
  timer = timers.setTimeout(finish, LONG_POLL_MS);
  res.on("close", () => { done = true; waiters.delete(finish); timers.clearTimeout(timer); });
}

/** Wake every held long poll of one kind (each waiter answers with the current body). */
function wake(waiters) {
  const list = Array.from(waiters);
  waiters.clear();
  for (const w of list) w();
}

// ---------------------------------------------------------------- the plugin

class ObsidianEdgeCompanion extends Plugin {
  async onload() {
    // Runtime fields first, before any await, so onunload is safe even if it comes before loading finished.
    this.stopped = false;
    this.started = false;
    this.servers = [];            // [{ host, server, sockets }]
    this.oneShots = new Set();    // short timers to clear on unload
    this.tickTimer = null;
    this.editorTimer = null;
    this.restartTimer = null;
    this.saving = Promise.resolve();
    this.portNoticeShown = false;
    this.turner = null;           // the EDGE's pages (PageTurner), from start()
    this.wasFront = null;
    this.followBusy = false;

    // The snapshot, in the helper's key order (the widget reads it as JSON).
    this.state = {
      seq: 0,
      t: 0,
      obsidian: false,
      vault: { name: null, path: null },
      active: { path: null, name: null, folder: null, viewType: "empty", mode: null, cursor: null, lineText: "", context: "none", headingLevel: null, selection: 0, lines: null },
      recents: [],
      recentChanges: [],
      outline: [],
      pages: { count: 0, shown: 0, ours: [], follow: true, keys: { next: DEFAULTS.pageNext, prev: DEFAULTS.pagePrev } },
    };
    this.lastSnapshotKey = "";
    this.lastBuild = 0;
    this.lastClientSeen = 0;
    this.dirty = true;
    this.stateWaiters = new Set();

    this.events = [];             // ring of { seq, t, type, path }
    this.eventSeq = 0;
    this.eventWaiters = new Set();
    this.pending = new Map();     // path -> { kind, timer } (debounce)

    this.registry = { at: 0, list: [] };
    this.noteColors = { at: 0, map: {} };
    this.linksCache = new Map();  // path -> { seq, body }

    await this.loadStore();
    this.addSettingTab(new CompanionSettingTab(this.app, this));
    // Start once the workspace is laid out: before that, vault "create" fires once for every existing file (it
    // would flood the events ring) and the workspace has no leaves to read a snapshot from.
    this.app.workspace.onLayoutReady(() => this.start());
  }

  onunload() {
    this.stopped = true;
    timers.clearTimeout(this.tickTimer);
    timers.clearTimeout(this.editorTimer);
    timers.clearTimeout(this.restartTimer);
    for (const t of this.oneShots) timers.clearTimeout(t);
    this.oneShots.clear();
    for (const entry of this.pending.values()) timers.clearTimeout(entry.timer);
    this.pending.clear();
    if (this.turner) { this.turner.dispose(); this.turner = null; }
    // Frees the port at once, so disabling and enabling the plugin rebinds without restarting Obsidian.
    this.stopServer();
  }

  // ---------------------------------------------------------------- settings, pins and folder colours

  /** Settings, pins and folder colours share the plugin's data.json, flat: { port, plansFolder, verbose, token, pins, folderColors }. */
  async loadStore() {
    let raw = null;
    try {
      raw = await this.loadData();
    } catch (e) {
      console.error("ObsidianEdge companion: could not read settings, using defaults", e);
    }
    raw = raw && typeof raw === "object" ? raw : {};
    const port = Number(raw.port);
    this.store = {
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port,
      plansFolder: typeof raw.plansFolder === "string" ? raw.plansFolder : DEFAULTS.plansFolder,
      verbose: raw.verbose === true,
      token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
      pageNext: typeof raw.pageNext === "string" && raw.pageNext.trim() ? raw.pageNext.trim() : DEFAULTS.pageNext,
      pagePrev: typeof raw.pagePrev === "string" && raw.pagePrev.trim() ? raw.pagePrev.trim() : DEFAULTS.pagePrev,
      followPage: raw.followPage !== false,
      pins: Array.isArray(raw.pins) ? raw.pins.filter((x) => typeof x === "string").slice(0, PIN_CAP) : [],
      folderColors: raw.folderColors && typeof raw.folderColors === "object" && !Array.isArray(raw.folderColors) ? raw.folderColors : {},
    };
  }

  /** Save the store. Saves run one after another, so two quick taps cannot interleave their writes. */
  persist() {
    const run = () => this.saveData(this.store);
    const p = this.saving.then(run, run);
    this.saving = p.catch(() => {});
    return p;
  }

  /** The plans folder setting as a clean vault path; the default when empty, unsafe or inside a dot-folder. */
  plansFolder() {
    const rel = safeRel(normalizePath(String(this.store.plansFolder || "").trim()));
    return rel && !DOT_SEGMENT.test(rel) ? rel : DEFAULTS.plansFolder;
  }

  /** From the settings tab: a valid new port is saved, and the server rebinds once typing pauses. */
  async setPort(value) {
    const port = Number(String(value).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === this.store.port) return;
    this.store.port = port;
    await this.persist();
    timers.clearTimeout(this.restartTimer);
    this.restartTimer = timers.setTimeout(() => {
      this.restartTimer = null;
      if (this.started && !this.stopped) this.startServer();
    }, 1000);
  }

  verboseLine(msg) {
    if (this.store && this.store.verbose) console.log("ObsidianEdge companion: " + msg);
  }

  /** A short timer that is cleared on unload and never runs after it. */
  later(fn, ms) {
    const t = timers.setTimeout(() => {
      this.oneShots.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.oneShots.add(t);
  }

  // ---------------------------------------------------------------- start

  start() {
    if (this.stopped || this.started) return;
    this.started = true;
    const adapter = this.app.vault.adapter;
    this.state.vault.name = this.app.vault.getName();
    this.state.vault.path = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
    this.watchWorkspace();
    this.watchVault();
    this.rebuild();               // the first snapshot: obsidian true, seq 1
    this.scheduleTick(IDLE_MS);   // no client yet; the first /state or /events switches to the fast clock
    this.startServer();
    this.startPages();
  }

  // ---------------------------------------------------------------- the EDGE's pages

  startPages() {
    this.state.pages.follow = this.store.followPage;
    this.state.pages.keys = { next: this.store.pageNext, prev: this.store.pagePrev };
    this.turner = new PageTurner({ typeId: WIDGET_TYPE_ID, keys: () => this.state.pages.keys, log: (m) => this.verboseLine("pages: " + m) });
    this.syncPages(true);
    if (this.store.followPage) this.turner.child.start(); // warm, so the first jump pays no compile
    // Follow: Obsidian's window coming to the front is this window's focus event (its own dialogs and
    // settings share the window, so they never count as leaving). The harness has no window.
    const hasWindow = typeof window !== "undefined" && typeof document !== "undefined";
    this.wasFront = hasWindow ? document.hasFocus() : null;
    if (hasWindow && typeof this.registerDomEvent === "function") {
      this.registerDomEvent(window, "focus", () => this.onFront(true));
      this.registerDomEvent(window, "blur", () => this.onFront(false));
    }
  }

  /** Once per false-to-true foreground transition: jump to the ObsidianEdge page when the panel shows another. */
  onFront(front) {
    const rose = this.wasFront === false && front === true;
    this.wasFront = front;
    if (!rose || !this.state.pages.follow || !this.turner || this.followBusy) return;
    this.followBusy = true;
    // The first press within about 300 ms of a focus change can be lost (DECISIONS 2026-10-27): settle first.
    this.later(() => {
      if (!this.turner) { this.followBusy = false; return; }
      this.turner.refresh(true);
      const pg = this.turner.pages;
      const away = pg.ok && pg.index >= 0 && pg.ours.length > 0 && !pg.list[pg.index].ours;
      if (!away || (typeof document !== "undefined" && !document.hasFocus())) { this.followBusy = false; return; }
      this.turner.jumpToOurs()
        .then((r) => this.verboseLine(`pages: follow ${r.ok ? "on our page" : "failed: " + r.error} after ${r.steps} step(s)`))
        .catch((e) => console.error("ObsidianEdge companion: page follow failed", e))
        .finally(() => { this.followBusy = false; this.syncPages(true); });
    }, FOCUS_SETTLE_MS);
  }

  /** Fold the store's page list into the snapshot; seq bumps when the count or the shown page moved. */
  syncPages(force = false) {
    if (!this.turner) return;
    this.turner.refresh(force);
    const sum = this.turner.summary();
    const p = this.state.pages;
    if (sum.count !== p.count || sum.shown !== p.shown || sum.ours.join() !== p.ours.join()) {
      p.count = sum.count; p.shown = sum.shown; p.ours = sum.ours;
      this.bump();
    }
  }

  async setFollow(on) {
    this.store.followPage = on === true;
    this.state.pages.follow = this.store.followPage;
    if (this.store.followPage && this.turner) this.turner.child.start();
    this.bump();
    await this.persist();
  }

  async setPageKey(which, value) {
    const v = String(value || "").trim() || (which === "next" ? DEFAULTS.pageNext : DEFAULTS.pagePrev);
    if (which === "next") this.store.pageNext = v; else this.store.pagePrev = v;
    this.state.pages.keys = { next: this.store.pageNext, prev: this.store.pagePrev };
    await this.persist();
  }

  // ---------------------------------------------------------------- state snapshot

  /** Workspace events mark the snapshot dirty. Typing is debounced so a burst marks it once. */
  watchWorkspace() {
    const ws = this.app.workspace;
    const dirty = () => { this.dirty = true; };
    this.registerEvent(ws.on("active-leaf-change", dirty));
    this.registerEvent(ws.on("file-open", dirty));
    this.registerEvent(ws.on("layout-change", dirty));
    this.registerEvent(ws.on("editor-change", () => {
      timers.clearTimeout(this.editorTimer);
      this.editorTimer = timers.setTimeout(() => { this.editorTimer = null; this.dirty = true; }, EDITOR_QUIET_MS);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      const active = this.app.workspace.getActiveFile();
      if (active && file && file.path === active.path) this.dirty = true;
    }));
  }

  clientActive() { return Date.now() - this.lastClientSeen < CLIENT_WINDOW_MS; }

  /**
   * /state and /events call this. Coming back from idle, the idle clock may be up to 5 s away, so the snapshot is
   * rebuilt now (or as soon as the 450 ms cap allows) and the clock switches to the fast pace.
   */
  noteClient() {
    const wasIdle = !this.clientActive();
    this.lastClientSeen = Date.now();
    if (!wasIdle) return;
    const wait = this.lastBuild + ACTIVE_MS - Date.now();
    if (wait <= 0) this.tick(); else this.scheduleTick(wait);
  }

  scheduleTick(ms) {
    timers.clearTimeout(this.tickTimer);
    this.tickTimer = timers.setTimeout(() => this.tick(), ms);
  }

  /**
   * The snapshot clock. While a client listens, every tick rebuilds, dirty or not: Obsidian has no public event for
   * a cursor move or a selection change (editor-change is content only), and the snapshot carries the cursor, its
   * line and its context. seq still bumps only when the snapshot changed, so the widget repaints no more often.
   * While no client listens, a tick rebuilds only when an event marked the snapshot dirty.
   */
  tick() {
    // noteClient() may call this while the idle timer is still pending: clear it, or two clocks would run.
    timers.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    if (this.stopped) return;
    if (this.clientActive() || this.dirty) this.rebuild();
    this.syncPages();
    this.scheduleTick(this.clientActive() ? ACTIVE_MS : IDLE_MS);
  }

  bump() {
    this.state.seq++;
    this.state.t = Date.now();
    wake(this.stateWaiters);
  }

  /** Rebuild the snapshot; seq bumps only when the JSON of [active, recents, outline] changed (the helper's rule). */
  rebuild() {
    if (this.stopped) return;
    this.dirty = false;
    this.lastBuild = Date.now();
    let v;
    try {
      v = this.readSnapshot();
    } catch (e) {
      console.error("ObsidianEdge companion: snapshot failed", e);
      this.dirty = true; // so the next tick retries, idle or not
      return;
    }
    const key = JSON.stringify([v.active, v.recents, v.outline]);
    const changed = key !== this.lastSnapshotKey || !this.state.obsidian;
    this.state.obsidian = true;
    this.state.vault.name = v.vault;
    this.state.active = v.active;
    this.state.recents = v.recents;
    this.state.outline = v.outline;
    if (changed) {
      this.lastSnapshotKey = key;
      this.bump();
    }
  }

  /** Every open markdown and canvas leaf. */
  noteLeaves() {
    const ws = this.app.workspace;
    return ws.getLeavesOfType("markdown").concat(ws.getLeavesOfType("canvas"));
  }

  /**
   * Obsidian's own view of where the cursor sits: the helper's STATE_EVAL, line for line, as direct calls.
   * The leaf is the one that shows the active file (the active leaf is often a sidebar).
   */
  readSnapshot() {
    const app = this.app;
    const ws = app.workspace;
    const f = ws.getActiveFile();
    let leaf = ws.getMostRecentLeaf();
    if (f) {
      const mine = this.noteLeaves().find((l) => l.view && l.view.file && l.view.file.path === f.path);
      if (mine) leaf = mine;
    } else {
      leaf = ws.getMostRecentLeaf() || leaf;
    }
    const v = leaf && leaf.view;
    const vt = v ? v.getViewType() : "empty";
    let mode = null, cursor = null, lineText = "", ctx = "none", hl = null, sel = 0, lines = null;
    if (vt === "markdown" && v.getMode) {
      mode = v.getMode();
      const e = v.editor;
      if (e && mode === "source") {
        const c = e.getCursor();
        cursor = { line: c.line, ch: c.ch };
        lineText = e.getLine(c.line) || "";
        sel = e.getSelection().length;
        lines = e.lineCount();
        // The section under the cursor, from the metadata cache: Obsidian's own parse of the note.
        const cache = f && app.metadataCache.getFileCache(f);
        let sec = null;
        if (cache && cache.sections) {
          for (const s of cache.sections) {
            if (c.line >= s.position.start.line && c.line <= s.position.end.line) { sec = s.type; break; }
          }
        }
        ctx = sec === "heading" ? "heading"
          : sec === "list" ? (/^\s*[-*+]\s\[.\]/.test(lineText) ? "task" : "list")
          : sec === "table" ? "table"
          : sec === "callout" ? "callout"
          : sec === "blockquote" ? (/^\s*>\s*\[!/.test(lineText) ? "callout" : "quote")
          : sec === "code" ? "code"
          : sec === "yaml" ? "frontmatter"
          : sec ? "paragraph"
          : (lineText.trim() ? "paragraph" : "blank");
        // A line typed as a heading counts before the cache has caught up.
        if (/^#{1,6}\s/.test(lineText)) ctx = "heading";
        if (ctx === "heading") { const m = /^(#{1,6})\s/.exec(lineText); hl = m ? m[1].length : null; }
      }
    }
    // Recents: open note panes by last activation, then the app's last-open list; markdown and canvas first.
    const leaves = this.noteLeaves().filter((l) => l.view && l.view.file).sort((a, b) => (b.activeTime || 0) - (a.activeTime || 0)).map((l) => l.view.file.path);
    const seen = new Set(leaves);
    // Obsidian's last-open list keeps paths of notes deleted since; the panel must not offer them (the helper's rule).
    const all = leaves.concat(ws.getLastOpenFiles().filter((p) => !seen.has(p) && app.vault.getAbstractFileByPath(p)));
    const md = all.filter((p) => NOTE_FILE.test(p));
    const rec = md.concat(all.filter((p) => !NOTE_FILE.test(p))).slice(0, 8);
    const cache2 = f && app.metadataCache.getFileCache(f);
    const heads = ((cache2 && cache2.headings) || []).slice(0, 120).map((h) => ({ level: h.level, text: h.heading, line: h.position.start.line }));
    const named = (p) => { const i = p.lastIndexOf("/"); return { path: p, name: p.slice(i + 1).replace(/\.(md|canvas)$/, ""), folder: i > 0 ? p.slice(0, i) : "" }; };
    return {
      vault: app.vault.getName(),
      // folder is the parent's path as Obsidian has it, so a note at the vault root reads "/" (as with the helper).
      active: f
        ? { path: f.path, name: f.basename, folder: f.parent ? f.parent.path : "", viewType: vt, mode, cursor, lineText, context: ctx, headingLevel: hl, selection: sel, lines }
        : { path: null, name: null, folder: null, viewType: vt, mode: null, cursor: null, lineText: "", context: "none", headingLevel: null, selection: 0, lines: null },
      recents: rec.map(named),
      outline: heads,
    };
  }

  // ---------------------------------------------------------------- vault events

  /** Vault events feed the events ring. A rename is a delete of the old path plus a create of the new one. */
  watchVault() {
    const vault = this.app.vault;
    this.registerEvent(vault.on("create", (file) => this.onVaultChange(file.path, "create")));
    this.registerEvent(vault.on("modify", (file) => this.onVaultChange(file.path, "change")));
    this.registerEvent(vault.on("delete", (file) => this.onVaultChange(file.path, "delete")));
    this.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof TFolder) this.carryFolderColors(oldPath, file.path);
      this.onVaultChange(oldPath, "delete");
      this.onVaultChange(file.path, "create");
      this.dirty = true; // the renamed file may be the active one
    }));
  }

  /**
   * Debounced per path. At the flush, as in the helper: a path that no longer exists is a delete; otherwise the last
   * event decides between create and change.
   */
  onVaultChange(rel, kind) {
    if (!rel || IGNORE.test(rel) || DOT_SEGMENT.test(rel) || !WATCHED_FILE.test(rel)) return;
    const prev = this.pending.get(rel);
    if (prev) timers.clearTimeout(prev.timer);
    const entry = { kind, timer: null };
    entry.timer = timers.setTimeout(() => {
      this.pending.delete(rel);
      if (this.stopped) return;
      const exists = !!this.app.vault.getAbstractFileByPath(rel);
      this.pushEvent(exists ? (entry.kind === "create" ? "create" : "change") : "delete", rel);
    }, EVENT_QUIET_MS);
    this.pending.set(rel, entry);
  }

  pushEvent(type, rel) {
    this.eventSeq++;
    this.events.push({ seq: this.eventSeq, t: Date.now(), type, path: rel });
    if (this.events.length > EVENT_RING) this.events.splice(0, this.events.length - EVENT_RING);
    // The "what is being worked on" list: last distinct note paths touched, newest first.
    if (NOTE_FILE.test(rel)) {
      const i = rel.lastIndexOf("/");
      this.state.recentChanges = [{ path: rel, name: rel.slice(i + 1).replace(/\.(md|canvas)$/i, ""), folder: i > 0 ? rel.slice(0, i) : "", type, t: Date.now() }]
        .concat(this.state.recentChanges.filter((x) => x.path !== rel)).slice(0, RECENT_CHANGES);
      this.bump();
    }
    wake(this.eventWaiters);
  }

  /** A renamed or moved folder keeps its colour, and so do its coloured sub-folders. */
  carryFolderColors(from, to) {
    const colors = this.store.folderColors;
    if (!Object.keys(colors).some((k) => k === from || k.startsWith(from + "/"))) return;
    const next = {};
    for (const k of Object.keys(colors)) next[k === from ? to : k.startsWith(from + "/") ? to + k.slice(from.length) : k] = colors[k];
    this.store.folderColors = next;
    this.persist().catch((e) => console.error("ObsidianEdge companion: could not save folder colours", e));
    this.verboseLine(`folder colour carried from ${from} to ${to}`);
  }

  // ---------------------------------------------------------------- vault lookups

  /**
   * The file or folder at a vault-relative path (doubled or trailing slashes tolerated), or null. The vault's lookup
   * is a property read, so a name like "__proto__" could return a non-file object: only real vault entries count.
   */
  fileAt(rel) {
    const vault = this.app.vault;
    const entry = (p) => { const hit = vault.getAbstractFileByPath(p); return hit instanceof TAbstractFile ? hit : null; };
    const hit = entry(rel);
    if (hit) return hit;
    const tidy = rel.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    return tidy && tidy !== rel ? entry(tidy) : null;
  }

  /**
   * An image for the reader, resolved the way Obsidian resolves ![[name]] from that note. Image extensions only,
   * never a dot-folder. Like the helper's last resort, a name with a folder part that does not resolve is tried by
   * its basename.
   */
  resolveImage(name, from) {
    const n = safeRel(name);
    if (!n || !this.state.vault.path) return null;
    if (!IMAGE_MIME[extOf(n)] || DOT_SEGMENT.test(n)) return null;
    const source = safeRel(from || "") || "";
    const mc = this.app.metadataCache;
    let file = mc.getFirstLinkpathDest(n, source);
    if (!file && n.includes("/")) file = mc.getFirstLinkpathDest(n.slice(n.lastIndexOf("/") + 1), source);
    // getFirstLinkpathDest resolves any file type, so check what came back as well as what was asked.
    if (!(file instanceof TFile) || !IMAGE_MIME["." + String(file.extension).toLowerCase()] || DOT_SEGMENT.test(file.path)) return null;
    return file;
  }

  // ---------------------------------------------------------------- commands and editor actions

  /** The allowlisted part of the live command registry, with hotkeys as text; refreshed at most once a minute. */
  loadRegistry() {
    if (Date.now() - this.registry.at < REGISTRY_MS && this.registry.list.length) return this.registry.list;
    const commands = (this.app.commands && this.app.commands.commands) || {};
    const list = Object.values(commands)
      .filter((c) => c && typeof c.id === "string" && ALLOW_PREFIX.some((p) => c.id.startsWith(p)))
      .map((c) => ({ id: c.id, name: c.name, hotkey: hotkeyText(this.app, c.id) }));
    this.registry = { at: Date.now(), list };
    return list;
  }

  /**
   * Editor commands act on Obsidian's active leaf, which is often a sidebar (file explorer, search) rather than the
   * note. Before running one, make the pane that shows the active file the active leaf (the helper's ACTIVATE).
   */
  activateNoteLeaf() {
    const ws = this.app.workspace;
    const f = ws.getActiveFile();
    if (!f) return;
    const leaf = this.noteLeaves().find((l) => l.view && l.view.file && l.view.file.path === f.path);
    const current = ws.getActiveViewOfType(MarkdownView);
    if (leaf && (!current || current.leaf !== leaf)) ws.setActiveLeaf(leaf, { focus: true });
  }

  /** Run one command by id inside Obsidian and report its own true/false as "ok" or "refused". */
  runCommand(id) {
    try {
      this.activateNoteLeaf();
      const out = this.app.commands.executeCommandById(id) ? "ok" : "refused";
      return { ok: out === "ok", out };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  /** Act on the active note's editor (the helper's editorEval): fn(editor) returns "ok" or an "ERR:" string. */
  editorAction(fn) {
    try {
      this.activateNoteLeaf();
      const v = this.app.workspace.getActiveViewOfType(MarkdownView);
      const e = v && v.editor;
      if (!e) return { ok: true, value: "ERR:no-editor" };
      return { ok: true, value: fn(e) };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /** Open a note (or any vault file) in the current tab, or a new one. Resolves to { ok, out, leaf }. */
  async openNote(rel, newTab) {
    const file = this.fileAt(rel);
    if (!(file instanceof TFile)) return { ok: false, out: "not-found" };
    try {
      const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
      await leaf.openFile(file, { active: true });
      return { ok: true, out: "ok", leaf };
    } catch (e) {
      return { ok: false, out: errorText(e) };
    }
  }

  /** The helper's open-heading eval: switch a reading view to editing, put the cursor on the line, scroll to it. */
  cursorToLine(leaf, line) {
    try {
      const v = leaf.view;
      if (!v || v.getViewType() !== "markdown") return { ok: true, value: "ERR:no-markdown" };
      if (v.getMode() === "preview") this.app.commands.executeCommandById("markdown:toggle-preview");
      const e = v.editor;
      if (!e) return { ok: true, value: "ERR:no-editor" };
      e.setCursor({ line, ch: 0 });
      e.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      return { ok: true, value: "ok" };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  // ---------------------------------------------------------------- navigator: tree, colours, links, plan

  /** Note colours live in each note's frontmatter `color:` key, read through the metadata cache (cached 30 s). */
  loadNoteColors(force) {
    if (!force && Date.now() - this.noteColors.at < NOTE_COLORS_MS) return this.noteColors.map;
    const map = {};
    for (const f of this.app.vault.getMarkdownFiles()) {
      const c = this.app.metadataCache.getFileCache(f);
      const v = c && c.frontmatter ? c.frontmatter.color : undefined;
      if (v !== undefined && v !== null && v !== "") map[f.path] = v;
    }
    this.noteColors = { at: Date.now(), map };
    return map;
  }

  /** One folder level of the vault, folders first then notes, each sorted case-insensitively. Null when not a folder. */
  readTree(rel) {
    const dir = rel ? this.fileAt(rel) : this.app.vault.getRoot();
    if (!(dir instanceof TFolder)) return null;
    const folderColors = this.store.folderColors;
    const colors = this.loadNoteColors(false);
    const folders = [], notes = [];
    for (const e of dir.children) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (IGNORE.test(r)) continue;
      if (e instanceof TFolder) {
        // As the helper counts a folder: its notes plus every entry with no extension (its sub-folders).
        const count = e.children.filter((c) => !c.name.startsWith(".") && (NOTE_FILE.test(c.name) || !extOf(c.name))).length;
        folders.push({ name: e.name, path: r, color: folderColors[r] || undefined, count });
      } else if (NOTE_FILE.test(e.name)) {
        notes.push({ name: entryName(r), path: r, kind: /\.canvas$/i.test(e.name) ? "canvas" : "md", color: colors[r] || undefined, mtime: e.stat ? e.stat.mtime : 0 });
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    folders.sort(byName);
    notes.sort(byName);
    let truncated = false;
    if (folders.length + notes.length > TREE_CAP) {
      truncated = true;
      const room = Math.max(0, TREE_CAP - folders.length);
      notes.splice(room);
      if (folders.length > TREE_CAP) folders.splice(TREE_CAP);
    }
    const parent = rel ? (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "") : null;
    return { ok: true, path: rel, parent, folders, notes, truncated };
  }

  /** Backlinks (with counts), outgoing links and unresolved links of one note, cached per path per state tick. */
  readLinks(rel) {
    const hit = this.linksCache.get(rel);
    if (hit && hit.seq === this.state.seq) return hit.body;
    let body;
    try {
      const mc = this.app.metadataCache;
      const rl = mc.resolvedLinks || {};
      const ul = mc.unresolvedLinks || {};
      const back = [];
      for (const src in rl) { const n = rl[src][rel]; if (n) back.push({ path: src, count: n }); }
      back.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
      const out = Object.keys(rl[rel] || {}).map((p) => ({ path: p, count: rl[rel][p] }));
      const un = Object.keys(ul[rel] || {});
      const named = (x) => ({ path: x.path, name: entryName(x.path), folder: folderOf(x.path), count: x.count });
      body = { ok: true, path: rel, backlinks: back.slice(0, 200).map(named), links: out.slice(0, 200).map(named), unresolved: un.slice(0, 50) };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
    this.linksCache.set(rel, { seq: this.state.seq, body });
    if (this.linksCache.size > 50) this.linksCache.delete(this.linksCache.keys().next().value);
    return body;
  }

  /** Create every missing folder of a vault path, parent first. */
  async ensureFolder(folder) {
    const vault = this.app.vault;
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      const hit = vault.getAbstractFileByPath(sub);
      if (hit instanceof TFolder) continue;
      if (hit) throw new Error(`plans folder: ${sub} is a file`);
      try {
        await vault.createFolder(sub);
      } catch (e) {
        // Present on disk already (created meanwhile, or not indexed yet) is fine; anything else is a failure.
        if (!(await vault.adapter.exists(sub))) throw e;
      }
    }
  }

  /** Create <folder>/<base>.md, else <base>-2.md, -3.md and on: vault.create never overwrites, and neither does this. */
  async createUnique(folder, base, text) {
    const vault = this.app.vault;
    const taken = async (file) => !!vault.getAbstractFileByPath(file) || (await vault.adapter.exists(file));
    for (let i = 1; i < 1000; i++) {
      const file = `${folder}/${base}${i === 1 ? "" : "-" + i}.md`;
      if (await taken(file)) continue;
      try {
        await vault.create(file, text);
        return file;
      } catch (e) {
        if (await taken(file)) continue; // lost a race with another writer of the same name
        throw e;
      }
    }
    throw new Error("no free plan file name");
  }

  /** The reorganise plan: a Markdown file that lists moves for a model to carry out. Nothing in the vault moves here. */
  async writePlan(moves, note) {
    const vault = this.app.vault;
    const bad = [];
    const clean = [];
    for (const m of moves) {
      const from = safeRel(m && m.from), to = m && m.to === "" ? "" : safeRel(m && m.to);
      if (!from || to === null || to === undefined) { bad.push({ move: m, why: "bad-path" }); continue; }
      const source = this.fileAt(from);
      if (!source) { bad.push({ move: m, why: "from-missing" }); continue; }
      const target = to ? this.fileAt(to) : vault.getRoot();
      if (!(target instanceof TFolder)) { bad.push({ move: m, why: "to-not-a-folder" }); continue; }
      const base = from.slice(from.lastIndexOf("/") + 1);
      const dest = to ? to + "/" + base : base;
      if (dest === from) { bad.push({ move: m, why: "same-place" }); continue; }
      clean.push({ from, to, dest, base, isFolder: source instanceof TFolder });
    }
    if (!clean.length) return { ok: false, error: "no-valid-moves", rejected: bad };
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const dests = Array.from(new Set(clean.map((m) => m.to)));
    // The text is the helper's writePlan, line for line.
    const lines = [];
    lines.push(`# Reorganise plan, ${d.toISOString().slice(0, 16).replace("T", " ")}`, "");
    lines.push(`Written by the ObsidianEdge widget from the XENEON EDGE. Vault: ${this.state.vault.name || "(unknown)"}. Nothing has moved; this file is the instruction.`, "");
    if (note) lines.push(`Note from the panel: ${String(note).slice(0, 500)}`, "");
    lines.push("## Moves", "", "| From | To |", "|---|---|");
    for (const m of clean) lines.push(`| \`${m.from}\` | \`${m.dest}\` |`);
    lines.push("", "## Result, per destination folder", "");
    for (const to of dests) {
      lines.push(`### ${to || "(vault root)"}`, "");
      const folder = to ? this.fileAt(to) : vault.getRoot();
      const existing = folder instanceof TFolder
        ? folder.children.map((c) => c.name).filter((n) => !n.startsWith(".") && !IGNORE.test(to ? to + "/" + n : n)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        : [];
      const incoming = clean.filter((m) => m.to === to).map((m) => m.base);
      const leaving = new Set(clean.filter((m) => m.from.startsWith(to ? to + "/" : "") && !m.from.slice(to ? to.length + 1 : 0).includes("/")).map((m) => m.base));
      for (const n of existing) if (!leaving.has(n)) lines.push(`- ${n}`);
      for (const n of incoming) lines.push(`- **${n}** (moves in)`);
      lines.push("");
    }
    lines.push("## Instruction for the executing model", "");
    lines.push("Carry out exactly the moves in the table, using Obsidian's own rename (`app.fileManager.renameFile` or the Obsidian CLI `move`) so that links update. Do not touch anything not listed. If a destination already holds a file of the same name, stop and report instead of overwriting. Report each move as done or refused.", "");
    if (bad.length) {
      lines.push("## Rejected by the helper (not in the table)", "");
      for (const b of bad) lines.push(`- ${JSON.stringify(b.move)}: ${b.why}`);
      lines.push("");
    }
    const plansFolder = this.plansFolder();
    await this.ensureFolder(plansFolder);
    const file = await this.createUnique(plansFolder, `reorg-plan-${stamp}`, lines.join("\n"));
    this.verboseLine(`plan written: ${file} (${clean.length} moves, ${bad.length} rejected)`);
    // `file` is an absolute path on disk, as the helper answered; the widget shows its basename.
    return { ok: true, file: nodePath.join(this.state.vault.path || "", file), moves: clean.length, rejected: bad };
  }

  // ---------------------------------------------------------------- server

  /**
   * Loopback only, on both address families: iCUE records the widget's permission as host "localhost", and Windows
   * resolves localhost to ::1 first, so the IPv6 loopback must answer as well as 127.0.0.1.
   */
  startServer() {
    if (this.stopped) return;
    this.stopServer();
    const port = this.store.port;
    this.portNoticeShown = false;
    for (const host of ["127.0.0.1", "::1"]) {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      const entry = { host, server, sockets: new Set() };
      // Track sockets so a stop can end held long polls and idle keep-alive connections at once.
      server.on("connection", (socket) => {
        entry.sockets.add(socket);
        socket.on("close", () => entry.sockets.delete(socket));
      });
      server.on("error", (err) => this.onServerError(entry, port, err));
      server.listen(port, host, () => this.verboseLine(`listening on http://${host === "::1" ? "[::1]" : host}:${port}`));
      this.servers.push(entry);
    }
  }

  onServerError(entry, port, err) {
    const code = err && err.code;
    if (code === "EADDRINUSE") {
      console.error(`ObsidianEdge companion: ${entry.host} port ${port} is taken`);
      if (!this.portNoticeShown) {
        this.portNoticeShown = true;
        new Notice(`ObsidianEdge companion: port ${port} is taken; change it in settings`);
      }
      return;
    }
    if (entry.host === "::1") {
      // Some PCs run without IPv6; 127.0.0.1 still serves the widget's API calls.
      console.error("ObsidianEdge companion: IPv6 loopback not available", code || err);
      return;
    }
    console.error(`ObsidianEdge companion: cannot serve on ${entry.host}:${port}`, err);
    if (!this.portNoticeShown) {
      this.portNoticeShown = true;
      new Notice(`ObsidianEdge companion: cannot listen on port ${port} (${code || "error"})`);
    }
  }

  stopServer() {
    for (const entry of this.servers) {
      try { entry.server.close(); } catch (e) { /* never started listening: nothing to close */ }
      if (typeof entry.server.closeAllConnections === "function") {
        try { entry.server.closeAllConnections(); } catch (e) { /* the sockets below are destroyed anyway */ }
      }
      for (const socket of entry.sockets) socket.destroy();
      entry.sockets.clear();
    }
    this.servers = [];
    // Held long polls belonged to the sockets just destroyed.
    for (const w of this.stateWaiters) w.drop();
    this.stateWaiters.clear();
    for (const w of this.eventWaiters) w.drop();
    this.eventWaiters.clear();
  }

  onRequest(req, res) {
    if (this.store.verbose) {
      // One console line per request, written when it ends (a long poll ends when it answers or its client leaves).
      const started = Date.now();
      const shown = String(req.url).replace(/([?&]token=)[^&]*/gi, "$1***");
      res.on("close", () => {
        console.log(`ObsidianEdge companion: ${req.method} ${shown} ${res.statusCode}${res.writableFinished ? "" : " (client left)"} ${Date.now() - started} ms`);
      });
    }
    this.handle(req, res).catch((e) => {
      console.error("ObsidianEdge companion: request failed", req.method, req.url, e);
      try { send(res, 500, { ok: false, error: "internal" }); } catch (e2) { /* the client is gone */ }
    });
  }

  // ---------------------------------------------------------------- routes (the helper's, in its order)

  async handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const q = url.searchParams;
    const p = url.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-private-network": "true", "cache-control": "no-store" });
      return res.end();
    }
    // The token hook, off while the setting is empty: then every route but /health must carry ?token=.
    const token = this.store.token;
    if (token && p !== "/health" && q.get("token") !== token) return send(res, 401, { ok: false, error: "bad-token" });
    if (req.method === "GET") return this.handleGet(p, q, res);
    if (req.method === "POST") return this.handlePost(p, q, res);
    return send(res, 405, { ok: false, error: "method" });
  }

  async handleGet(p, q, res) {
    const st = this.state;
    if (p === "/health") return send(res, 200, { ok: true, name: "obsidian-edge-helper", version: VERSION, obsidian: st.obsidian, vault: st.vault, seq: st.seq });
    if (p === "/pages") {
      this.syncPages(true);
      const pg = this.turner ? this.turner.pages : { ok: false, error: "not-started", list: [], index: -1 };
      return send(res, 200, { ok: pg.ok, error: pg.error, store: PAGE_STORE, shown: pg.index + 1, follow: st.pages.follow, keys: st.pages.keys, pages: pg.list.map((x, i) => ({ n: i + 1, name: x.name, ours: x.ours, widgets: x.widgets })) });
    }
    if (p === "/state") {
      this.noteClient();
      // As the helper: Number(null) is 0, so a missing `since` long-polls on 0 and answers at once once seq > 0.
      const since = Number(q.get("since"));
      if (!Number.isFinite(since)) return send(res, 200, st);
      return longPoll(this.stateWaiters, () => this.state.seq !== since, () => this.state, res);
    }
    if (p === "/events") {
      this.noteClient();
      const since = Number(q.get("since")) || 0;
      const build = () => ({ seq: this.eventSeq, events: this.events.filter((e) => e.seq > since) });
      if (q.get("since") === null) return send(res, 200, build());
      return longPoll(this.eventWaiters, () => this.eventSeq > since, build, res);
    }
    if (p === "/read") {
      const rel = safeRel(q.get("path"));
      if (!rel || !st.vault.path) return send(res, 400, { ok: false, error: "bad-path" });
      // Never serve dot-folders: .obsidian holds plugin data files that can carry API keys.
      if (DOT_SEGMENT.test(rel)) return send(res, 404, { ok: false, error: "not-found" });
      const file = this.fileAt(rel);
      if (!(file instanceof TFile)) return send(res, 404, { ok: false, error: "not-found" });
      const cap = /\.canvas$/i.test(rel) ? CANVAS_READ_CAP : READ_CAP;
      const text = await this.app.vault.cachedRead(file);
      if (file.stat.size > cap) return send(res, 200, { ok: true, path: rel, text: text.slice(0, cap), mtime: file.stat.mtime, truncated: true });
      return send(res, 200, { ok: true, path: rel, text, mtime: file.stat.mtime });
    }
    if (p === "/image") {
      const file = this.resolveImage(q.get("name"), q.get("from"));
      if (!file) return send(res, 404, { ok: false, error: "not-found" });
      if (file.stat.size > IMAGE_MAX) return send(res, 413, { ok: false, error: "too-large" });
      const bytes = Buffer.from(await this.app.vault.readBinary(file));
      if (res.headersSent || res.destroyed) return;
      res.writeHead(200, { "content-type": IMAGE_MIME["." + String(file.extension).toLowerCase()], "content-length": bytes.length, "access-control-allow-origin": "*", "cache-control": "private, max-age=60" });
      return res.end(bytes);
    }
    if (p === "/outline") {
      // From the metadata cache; lines count from 0, as the editor and /open-heading do.
      const rel = q.get("path") ? safeRel(q.get("path")) : null;
      const file = rel ? this.fileAt(rel) : this.app.workspace.getActiveFile();
      const cache = file instanceof TFile ? this.app.metadataCache.getFileCache(file) : null;
      const headings = ((cache && cache.headings) || []).map((h) => ({ level: h.level, text: h.heading, line: h.position.start.line }));
      return send(res, 200, { ok: true, path: rel || st.active.path, headings });
    }
    if (p === "/recents") {
      const n = Math.min(50, Number(q.get("n")) || 8);
      const files = this.app.workspace.getLastOpenFiles().map((l) => String(l).trim()).filter(Boolean).slice(0, n).map((rel) => {
        const i = rel.lastIndexOf("/");
        const f = this.app.vault.getAbstractFileByPath(rel);
        return { path: rel, name: rel.slice(i + 1).replace(/\.(md|canvas)$/, ""), folder: i > 0 ? rel.slice(0, i) : "", mtime: f instanceof TFile ? f.stat.mtime : null };
      });
      return send(res, 200, { ok: true, files });
    }
    if (p === "/commands") return send(res, 200, { ok: true, commands: this.loadRegistry() });
    if (p === "/pins") return send(res, 200, { ok: true, pins: this.store.pins });
    if (p === "/tree") {
      const rel = q.get("path") ? safeRel(q.get("path")) : "";
      if (rel === null || !st.vault.path) return send(res, 400, { ok: false, error: "bad-path" });
      if (DOT_SEGMENT.test(rel) || IGNORE.test(rel)) return send(res, 404, { ok: false, error: "not-found" });
      const tree = this.readTree(rel);
      if (!tree) return send(res, 404, { ok: false, error: "not-found" });
      return send(res, 200, tree);
    }
    if (p === "/colors") return send(res, 200, { ok: true, folders: this.store.folderColors, notes: this.loadNoteColors(false) });
    if (p === "/links") {
      const rel = q.get("path") ? safeRel(q.get("path")) : st.active.path;
      if (!rel) return send(res, 400, { ok: false, error: "bad-path" });
      if (!st.obsidian) return send(res, 409, { ok: false, error: "obsidian-not-running" }); // kept for parity; cannot happen inside Obsidian
      const body = this.readLinks(rel);
      return send(res, body.ok ? 200 : 500, body);
    }
    if (p === "/gauges") {
      const rel = q.get("path") ? safeRel(q.get("path")) : st.active.path;
      if (!rel || !st.vault.path) return send(res, 400, { ok: false, error: "bad-path" });
      if (!/\.md$/i.test(rel) || DOT_SEGMENT.test(rel)) return send(res, 404, { ok: false, error: "not-a-note" });
      const file = this.fileAt(rel);
      if (!(file instanceof TFile)) return send(res, 404, { ok: false, error: "not-found" });
      const text = await this.app.vault.cachedRead(file);
      const g = countGauges(text.slice(0, GAUGES_CAP));
      let backlinks = { notes: null, links: null };
      const l = this.readLinks(rel);
      if (l.ok) backlinks = { notes: l.backlinks.length, links: l.backlinks.reduce((s, x) => s + (x.count || 0), 0) };
      return send(res, 200, { ok: true, path: rel, name: entryName(rel), mtime: file.stat.mtime, ...g, backlinks });
    }
    // The helper served the widget's own files here for its dev loop; the plugin has none to serve.
    return send(res, 404, { ok: false, error: "not-found" });
  }

  async handlePost(p, q, res) {
    const st = this.state;
    if (p === "/page") {
      const follow = q.get("follow");
      if (follow === "on" || follow === "off") {
        await this.setFollow(follow === "on");
        return send(res, 200, { ok: true, follow: st.pages.follow });
      }
      if (!this.turner) return send(res, 409, { ok: false, error: "not-started" });
      const dir = q.get("dir");
      if (dir === "next" || dir === "prev") {
        const r = await this.turner.press(dir);
        this.syncPages(true);
        return send(res, r.ok ? 200 : 409, { ok: r.ok, changed: r.changed, from: r.from + 1, to: r.to + 1, error: r.error });
      }
      if (q.get("to") === "ours") {
        const r = await this.turner.jumpToOurs();
        this.syncPages(true);
        return send(res, r.ok ? 200 : 409, { ok: r.ok, steps: r.steps, shown: r.index + 1, error: r.error });
      }
      return send(res, 400, { ok: false, error: "dir-or-to-or-follow" });
    }
    // Kept for parity with the helper; inside Obsidian the snapshot is live before the server starts.
    if (!st.obsidian && p !== "/pin" && p !== "/unpin") return send(res, 409, { ok: false, error: "obsidian-not-running" });
    if (p === "/command") {
      const id = q.get("id");
      if (!allowed(id)) return send(res, 404, { ok: false, error: "not-allowed", id });
      const r = this.runCommand(id);
      this.later(() => this.rebuild(), 120);
      return send(res, r.ok ? 200 : r.error ? 500 : 409, { ok: r.ok, id, out: r.out || r.error });
    }
    if (p === "/open") {
      const rel = safeRel(q.get("path"));
      if (!rel) return send(res, 400, { ok: false, error: "bad-path" });
      const r = await this.openNote(rel, q.get("newtab") === "1");
      this.later(() => this.rebuild(), 150);
      return send(res, r.ok ? 200 : 500, { ok: r.ok, path: rel, out: r.out });
    }
    if (p === "/open-heading") {
      const rel = safeRel(q.get("path"));
      const line = Number(q.get("line"));
      if (!rel || !Number.isFinite(line)) return send(res, 400, { ok: false, error: "bad-argument" });
      // As the helper: open the note only when the snapshot says it is not the active one, then act on the active leaf.
      const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
      let leaf = mv ? mv.leaf : this.app.workspace.getMostRecentLeaf();
      if (st.active.path !== rel) {
        const opened = await this.openNote(rel, false);
        if (!opened.ok) return send(res, 500, { ok: false, error: "open-failed" });
        leaf = opened.leaf;
      }
      const r = leaf ? this.cursorToLine(leaf, line) : { ok: false, error: "no active leaf" };
      const ok = r.ok && r.value === "ok";
      this.later(() => this.rebuild(), 150);
      return send(res, ok ? 200 : 500, { ok, path: rel, line, out: r.value || r.error });
    }
    if (p === "/insert" || p === "/wrap") {
      if (st.active.viewType !== "markdown" || st.active.mode !== "source") return send(res, 409, { ok: false, error: "no-active-editor" });
      const r = p === "/insert"
        ? this.editorAction((e) => { e.replaceSelection(q.get("text") || ""); return "ok"; })
        : this.editorAction((e) => {
          const b = q.get("before") || "", a = q.get("after") || "";
          const s = e.getSelection();
          if (s) {
            e.replaceSelection(b + s + a);
          } else {
            // No selection: insert the pair and leave the cursor between its halves.
            const c = e.getCursor();
            e.replaceSelection(b + a);
            e.setCursor({ line: c.line, ch: c.ch + b.length });
          }
          return "ok";
        });
      const ok = r.ok && r.value === "ok";
      this.later(() => this.rebuild(), 120);
      return send(res, ok ? 200 : 500, { ok, out: r.value || r.error });
    }
    if (p === "/heading") {
      const level = Number(q.get("level"));
      if (!(level >= 0 && level <= 6)) return send(res, 400, { ok: false, error: "bad-level" });
      const r = this.runCommand(`editor:set-heading-${level}`);
      this.later(() => this.rebuild(), 120);
      return send(res, r.ok ? 200 : 409, { ok: r.ok, level, out: r.out || r.error });
    }
    if (p === "/pin" || p === "/unpin") {
      const rel = safeRel(q.get("path"));
      if (!rel) return send(res, 400, { ok: false, error: "bad-path" });
      let pins = this.store.pins.filter((x) => x !== rel);
      if (p === "/pin") pins = [rel].concat(pins).slice(0, PIN_CAP);
      this.store.pins = pins;
      await this.persist();
      return send(res, 200, { ok: true, pins });
    }
    if (p === "/color") {
      // A folder's colour lives in this plugin's data; a note's in its own frontmatter `color:` key, set through
      // Obsidian's frontmatter API (never a text edit of the body). color=none removes.
      const rel = safeRel(q.get("path"));
      const color = parseColor(q.get("color"));
      if (!rel || color === null || !st.vault.path) return send(res, 400, { ok: false, error: "bad-argument" });
      if (DOT_SEGMENT.test(rel)) return send(res, 404, { ok: false, error: "not-found" });
      const target = this.fileAt(rel);
      if (!target) return send(res, 404, { ok: false, error: "not-found" });
      if (target instanceof TFolder) {
        const colors = this.store.folderColors;
        if (color) colors[rel] = color; else delete colors[rel];
        await this.persist();
        return send(res, 200, { ok: true, path: rel, color, kind: "folder" });
      }
      if (!/\.md$/i.test(rel)) return send(res, 400, { ok: false, error: "not-a-note" });
      let ok = false;
      let out;
      try {
        await this.app.fileManager.processFrontMatter(target, (fm) => { if (color) fm.color = color; else delete fm.color; });
        ok = true;
        out = "ok";
      } catch (e) {
        out = errorText(e);
        console.error("ObsidianEdge companion: note colour failed", rel, e);
      }
      if (ok) {
        if (color) this.noteColors.map[rel] = color; else delete this.noteColors.map[rel];
        // The metadata cache catches up a moment after the write; read the colours again then.
        this.later(() => this.loadNoteColors(true), 1500);
      }
      return send(res, ok ? 200 : 500, { ok, path: rel, color, kind: "note", out });
    }
    if (p === "/plan") {
      // The moves ride in the query string (a POST body would need a preflight): moves=<JSON [{from,to}]>, note=<text>.
      let moves;
      try { moves = JSON.parse(q.get("moves") || "[]"); } catch (e) { moves = null; }
      if (!Array.isArray(moves) || !moves.length || moves.length > 200 || !st.vault.path) return send(res, 400, { ok: false, error: "bad-moves" });
      const r = await this.writePlan(moves, q.get("note") || "");
      return send(res, r.ok ? 200 : 400, r);
    }
    return send(res, 404, { ok: false, error: "not-found" });
  }
}

// ---------------------------------------------------------------- settings tab

class CompanionSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const plugin = this.plugin;
    const el = this.containerEl;
    el.empty();

    new Setting(el)
      .setName("Port")
      .setDesc("The loopback port the XENEON EDGE widget calls (default 47610). Set the widget's Helper port to the same number. A new port takes effect a second after you stop typing, and iCUE asks once to allow it.")
      .addText((text) => text
        .setPlaceholder(String(DEFAULTS.port))
        .setValue(String(plugin.store.port))
        .onChange((value) => plugin.setPort(value)));

    new Setting(el)
      .setName("Plans folder")
      .setDesc("The vault folder where the widget's reorganise plans are written (default ObsidianEdge/plans). Created on first use.")
      .addText((text) => text
        .setPlaceholder(DEFAULTS.plansFolder)
        .setValue(plugin.store.plansFolder)
        .onChange(async (value) => { plugin.store.plansFolder = value; await plugin.persist(); }));

    new Setting(el)
      .setName("Verbose log")
      .setDesc("Write one line per request to the developer console. Errors are always logged.")
      .addToggle((toggle) => toggle
        .setValue(plugin.store.verbose)
        .onChange(async (value) => { plugin.store.verbose = value; await plugin.persist(); }));

    new Setting(el)
      .setName("Token")
      .setDesc("Off while empty. When set, every request except /health must carry ?token= with this value. The widget does not send a token yet, so leave it empty.")
      .addText((text) => text
        .setValue(plugin.store.token)
        .onChange(async (value) => { plugin.store.token = value.trim(); await plugin.persist(); }));

    new Setting(el).setName("XENEON EDGE pages").setHeading();

    new Setting(el)
      .setName("Jump to the ObsidianEdge page when Obsidian comes forward")
      .setDesc("When Obsidian becomes the active window and the EDGE shows another page, the companion turns to the page that holds ObsidianEdge by pressing the keys below. The widget's page chevrons press them too.")
      .addToggle((toggle) => toggle
        .setValue(plugin.store.followPage)
        .onChange((value) => plugin.setFollow(value)));

    new Setting(el)
      .setName("Next page keys")
      .setDesc("The keystroke recorded in iCUE under XENEON EDGE, Screen Setup, Next Display Screen. Record Ctrl+Alt+Shift+PageDown there, or type here whatever you recorded. Names: Ctrl, Alt, Shift, Win, PageUp, PageDown, Home, End, F1 to F24, a letter or a digit, joined with +.")
      .addText((text) => text
        .setPlaceholder(DEFAULTS.pageNext)
        .setValue(plugin.store.pageNext)
        .onChange((value) => plugin.setPageKey("next", value)));

    new Setting(el)
      .setName("Previous page keys")
      .setDesc("The keystroke recorded under Previous Display Screen (Ctrl+Alt+Shift+PageUp).")
      .addText((text) => text
        .setPlaceholder(DEFAULTS.pagePrev)
        .setValue(plugin.store.pagePrev)
        .onChange((value) => plugin.setPageKey("prev", value)));
  }
}

module.exports = ObsidianEdgeCompanion;
