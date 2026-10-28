# XENEON EDGE Companion

An Obsidian plugin that lets the ObsidianEdge widget on the Corsair XENEON EDGE touchscreen see and drive Obsidian. The widget runs inside iCUE and may only carry web files, so it talks to this plugin over plain HTTP on your own PC (loopback only). The plugin answers with the open note, its outline and the context under the cursor, your recent notes and what changed in the vault, and it runs the editor actions you tap on the panel. Desktop only, Windows.

Setup guide: https://pathfinderprototyping.com/support/edge-companion/

## Install

- **Obsidian community plugins** (once listed): Settings, Community plugins, Browse, search "XENEON EDGE Companion", Install, Enable.
- **Until then, through BRAT** (the community "Beta Reviewers Auto-update Tool", installed from Community plugins): BRAT settings, "Add beta plugin", paste `https://github.com/YnotLiveLyfe/edge-companion`, Add. BRAT installs this plugin and keeps it current. Then enable **XENEON EDGE Companion** under Community plugins.
- **By hand**: download the latest release's `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/edge-companion/` and enable the plugin under Community plugins.
## The port

The plugin listens on port **47610** on `127.0.0.1` and `[::1]`, the two loopback addresses (Windows resolves `localhost` to `[::1]` first, so both answer). You can change the port in the plugin's settings; the widget's **Helper port** property must then carry the same number.

If another program already holds the port (a second vault with this plugin turned on, or the obsidian-edge development helper), Obsidian shows "ObsidianEdge companion: port 47610 is taken; change it in settings". The plugin stays loaded and serves nothing until you pick a free port.

## The iCUE permission prompt

The first time the widget calls the plugin, iCUE asks once whether the widget may reach `localhost:47610`. The prompt is a toast that also stays in iCUE's notification centre (the bell, top right). Choose **Allow**; until you do, every request from the widget fails. A different port means one new prompt for that port.

## What it serves

Every response carries `Access-Control-Allow-Origin: *` and `Cache-Control: no-store` (images: `private, max-age=60`). Actions are `POST` with an empty body and their parameters in the query string. A failure answers `{"ok":false,"error":"<reason>"}` with 400 (bad argument), 404 (not allowed or not found), 409 (no active editor) or 500.

| Route | What it answers or does |
|---|---|
| `GET /health` | `{"ok":true,"name":"obsidian-edge-helper","version":"0.2.0","obsidian":true,"vault":{"name","path"},"seq":N}` |
| `GET /state?since=N` | The editor snapshot with its `seq`: the active note, its view and mode, the cursor, the context of the cursor line (heading, list, task, table, quote, code, callout, frontmatter, paragraph), the selection length, recent notes, recent changes and the outline. With `since`, the request is held up to 10 s until `seq` changes. |
| `GET /events?since=N` | Vault changes, newest last: `{"seq","events":[{"seq","t","type":"create"\|"change"\|"delete","path"}]}`. Held like `/state`. |
| `GET /read?path=` | A note's text: `{"path","text","mtime"}`. Up to 256 KB (2 MB for a canvas), then `"truncated":true`. Dot-folders are refused. |
| `GET /image?name=&from=` | An embedded image's bytes, resolved the way Obsidian resolves `![[name]]` from that note. Image types only (png, jpg, jpeg, gif, webp, svg, bmp, avif); 404 when nothing matches, 413 over 20 MB. |
| `GET /outline?path=` | `{"path","headings":[{"level","text","line"}]}`, lines counted from 0; the active note when `path` is absent. |
| `GET /recents?n=8` | `{"files":[{"path","name","folder","mtime"}]}`: Obsidian's recent files, newest first. |
| `GET /commands` | `{"commands":[{"id","name","hotkey"}]}`: the commands the panel may run, with their hotkeys as text. |
| `GET /pins` | `{"pins":["<path>"]}`: the panel's pinned notes. |
| `GET /tree?path=` | One folder level: folders (with colour and count) then notes (with kind, colour and mtime), each sorted by name, at most 400 entries. |
| `GET /colors` | `{"folders":{"<path>":"<colour>"},"notes":{"<path>":"<colour>"}}`: folder colours set on the panel, note colours from each note's `color:` frontmatter. |
| `GET /links?path=` | Backlinks with counts, outgoing links and unresolved links of a note, from Obsidian's link index. |
| `GET /gauges?path=` | Words, characters, reading time, the note's own tasks, its backlinks and its last edit. |
| `POST /command?id=` | Runs one Obsidian command from the allowlist (`editor:`, `workspace:`, `markdown:toggle-preview`, `app:go-back`, `app:go-forward`, `file-explorer:`, `daily-notes`, `switcher:`, `global-search:`, `bookmarks:`, `outline:`, `note-composer:`, `obsidian-git:` and a few more) in the pane that shows the note. |
| `POST /open?path=&newtab=0\|1` | Opens a note. |
| `POST /open-heading?path=&line=` | Opens the note and puts the cursor on that line. |
| `POST /insert?text=` | Types the text at the cursor of the active editor. |
| `POST /wrap?before=&after=` | Wraps the selection, or inserts the pair with the cursor between its halves. |
| `POST /heading?level=0..6` | Sets the heading level of the cursor line. |
| `POST /pin?path=` and `POST /unpin?path=` | Pins a note (12 at most) or unpins it. |
| `POST /color?path=&color=1..8\|#rrggbb\|none` | Colours a folder (kept in this plugin's data, carried along when the folder is renamed) or a note (its frontmatter `color:` key, set through Obsidian's frontmatter API). `none` removes the colour. |
| `POST /plan?moves=&note=` | Writes `reorg-plan-<yyyy-mm-dd-hhmm>.md` in the plans folder: the moves you picked on the panel as an instruction for a model to carry out. Moves nothing and never overwrites. |

## Settings

- **Port**: 47610.
- **Plans folder**: `ObsidianEdge/plans`, created on first use.
- **Verbose log**: off. When on, one line per request goes to the developer console. Errors are always logged.
- **Token**: empty, which means off. When set, every request except `/health` must carry `?token=` with that value. The widget does not send one yet.

## What it never does

- No network beyond loopback: it listens on `127.0.0.1` and `[::1]` only and makes no outgoing connection.
- No telemetry.
- No writes except the ones you ask for: pins and folder colours (in this plugin's own `data.json`), a note's frontmatter `color:` key when you set a note colour on the panel (through Obsidian's frontmatter API, never an edit of the note's body), and the plan files you ask for (in the plans folder). It never moves, renames or deletes anything in your vault.

## XENEON EDGE pages

iCUE turns the EDGE's pages with two keystrokes you record once in iCUE: hover the XENEON EDGE, open Screen Setup, and set **Previous Display Screen** to `Ctrl+Alt+Shift+PageUp` and **Next Display Screen** to `Ctrl+Alt+Shift+PageDown`. With those recorded, the widget's page chevrons (`‹ 2 / 5 ›` in its header) turn the EDGE's pages, and the companion jumps to the ObsidianEdge page whenever Obsidian comes to the front while the EDGE shows another page (the setting "Jump to the ObsidianEdge page when Obsidian comes forward", on by default). The keys fire only while Obsidian is the active window, so a chevron tap from another app brings Obsidian forward first. If you recorded other keys, type them into the two settings (Ctrl, Alt, Shift, Win, PageUp, PageDown, Home, End, F1 to F24, a letter or a digit, joined with `+`). The companion reads which page is showing from iCUE's own page store and never writes to it.
