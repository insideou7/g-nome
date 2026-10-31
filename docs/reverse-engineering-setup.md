# Reverse engineering setup

## What the game is

G-NOME (7th Level, 1997) for Windows 95. Everything is 32-bit x86.

| Files | What they are | Tool |
| --- | --- | --- |
| `G-NOME.EXE` (27 KB) | Small PE stub. Imports only 3 functions from `Rtlib32.dll`. | REA + Ghidra |
| `RTLIB32.DLL` | The engine: 7th Level "Runtime Player 1.2", a script VM that loads `*.R32` plugins. | REA + Ghidra |
| `*.R32` (`RENDER`, `NETGN`, `SMACKER`) | Plugin DLLs (normal PE). `RENDER.R32` is the 3D game and AI on RenderWare; `NETGN.R32` is DirectPlay networking. | REA + Ghidra |
| `G-NOME.BIN` (1.1 MB) | Asset index. Table at `0x1A8` of 9,440 10-byte entries `{u16 flags, u32 offset, u32 size}`; the pack is `G-NOME.%03d` with `flags >> 8`, the type is `flags & 0xFF`. | Python |
| `RWL20.DLL`, `RWDL8*20.DLL` | RenderWare 2.0 3D engine (Criterion). | REA + Ghidra |
| `G-NOME.000` to `.060` | Asset packs addressed by `G-NOME.BIN`. Some start with a `MODL` chunk (3D models). Prior art for 7th Level's audio codecs: [stascorp/7thLevelFile](https://github.com/stascorp/7thLevelFile). | Python, hex editor |
| `*.SMK` | Smacker video, 320x200. | `ffmpeg` / `ffprobe` play and convert them as is |
| `LABTEXT.DAT`, `TRIVIA.*` | Length-prefixed text strings. | hex editor |

`tools/inventory.py` prints this kind of table for any folder.

## Where the game files go

Unzip the game into `game/` at the repo root. `game/` is git-ignored, so the
original binaries and assets are never committed. Commit notes, format specs
and code instead.

## REA (Reverse Engineer Anything)

[REA](https://github.com/morluto/rea) is an MCP server plus a skill that lets
the agent open binaries, decompile functions, list strings, follow references
and report what it found with evidence. It is MIT licensed.

### How it is enabled

- **MCP server:** `.mcp.json` runs `npx -y rea-agents@6.8.0 mcp`, and
  `.claude/settings.json` approves it (`enabledMcpjsonServers`). Every Claude
  Code session opened in this repo, local or cloud, gets the `rea` tools.
- **Skill:** `.claude/settings.json` also enables the `rea@rea` plugin, pinned
  to the `rea-agents-6.8.0` tag. In 6.8.0 the plugin only ships REA's
  workflow skill, not the server, which is why the server is in `.mcp.json`.
  If you move to a release whose plugin also starts a server, drop `.mcp.json`
  to avoid running two `rea` servers.

To update, change the version in `.mcp.json` and the `ref` in
`.claude/settings.json` together. Check with `/mcp` (should list `rea`).

REA needs Node.js 22.23.4+ (or 24.22.1+), and on Linux a procps `ps` on `PATH`.

### Native backend: Ghidra

For PE/x86 files REA needs a decompiler backend. Ghidra is free and works on
Linux, macOS and Windows.

1. Install a JDK 21 (Ghidra 12.1.x) or JDK 25 (Ghidra 12.2).
2. Download Ghidra 12.1.4 from
   <https://github.com/NationalSecurityAgency/ghidra/releases> and unzip it.
3. Point REA at it before starting Claude Code (the MCP server inherits your
   shell's environment):

   ```bash
   export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.4_PUBLIC
   export JAVA_HOME=/absolute/path/to/jdk-21   # optional if java is on PATH
   npx -y rea-agents@6.8.0 doctor --provider ghidra --json
   ```

Hopper and IDA also work if you already have them.

### Checking it works

Ask Claude to call REA's `binary_session` with `{}`. `result.tool_availability`
lists what is ready and why anything is not. Then try:

```text
Open game/G-NOME/RTLIB32.DLL with REA and find where it loads the .R32 plugins.
```

## Python helpers

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # pefile, capstone
.venv/bin/python tools/inventory.py game/G-NOME --pe-details
```

## Claude Code on the web

REA's MCP server and skill work in cloud sessions with no extra setup: npm is
allowed by the default network policy, and Java 21, `ps` and `ffmpeg` are in
the default image.

Ghidra is the missing piece. To add it:

1. In the cloud environment's network settings, allow `api.github.com`,
   `github.com`, `objects.githubusercontent.com` and
   `release-assets.githubusercontent.com` (keep package managers allowed).
2. Set the environment's setup script to:

   ```bash
   bash scripts/install-ghidra.sh
   ```

   It installs Ghidra 12.1.4 to `/opt/ghidra`, which is where `.mcp.json`
   points REA by default.

## Scope

REA's own [disclaimer](https://github.com/morluto/rea/blob/main/DISCLAIMER.md)
excludes DRM or copy-protection bypass and cheats for online services. This
project is about preservation and understanding how the game works.
