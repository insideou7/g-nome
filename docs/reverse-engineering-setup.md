# Reverse engineering setup

## What the game is

G-NOME (7th Level, 1997) for Windows 95. Everything is 32-bit x86.

| Files | What they are | Tool |
| --- | --- | --- |
| `G-NOME.EXE` (27 KB) | Small PE launcher. Imports only 3 functions from `Rtlib32.dll`. | REA + Ghidra |
| `G-NOME.BIN` (1.1 MB) | Probably the real game code in 7th Level's own format (starts with `7L`, `32`, `G-Nome`). Ghidra will not load it directly; `RTLIB32.DLL` is what loads it, so reverse that first. | REA + Ghidra, then a custom loader |
| `RTLIB32.DLL`, `*.R32` (`RENDER`, `NETGN`, `SMACKER`) | 7th Level runtime and plugins. `.R32` files are normal PE DLLs. | REA + Ghidra |
| `RWL20.DLL`, `RWDL8*20.DLL` | RenderWare 2.0 3D engine (Criterion). | REA + Ghidra |
| `G-NOME.000` to `.060` | Data archives. Some start with a `MODL` chunk (3D models). | hex editor, `tools/inventory.py` |
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

`.claude/settings.json` registers REA's plugin marketplace pinned to the
`rea-agents-6.8.0` tag and enables the `rea@rea` plugin. When you open this
repo in Claude Code it asks you to trust and install it. To do it by hand:

```text
/plugin marketplace add morluto/rea
/plugin install rea@rea
```

Then restart Claude Code and check `/mcp` shows `rea`. To update, change the
`ref` in `.claude/settings.json` to a newer `rea-agents-X.Y.Z` tag.

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
Open game/G-NOME/RTLIB32.DLL with REA and find the code that loads G-NOME.BIN.
```

## Python helpers

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # pefile, capstone
.venv/bin/python tools/inventory.py game/G-NOME --pe-details
```

## Claude Code on the web

Cloud sessions start from a fresh container, so the plugin installs per session
and Ghidra has to be downloaded each time. At the time of setup the cloud
network policy blocked GitHub release downloads, so Ghidra could not be
fetched there. To use native analysis in the cloud, allow
`github.com` and `objects.githubusercontent.com` in the environment's network
settings and add a setup script that downloads Ghidra and exports
`GHIDRA_INSTALL_DIR`. Java 21, `ps` and `ffmpeg` are already in the default
image.

## Scope

REA's own [disclaimer](https://github.com/morluto/rea/blob/main/DISCLAIMER.md)
excludes DRM or copy-protection bypass and cheats for online services. This
project is about preservation and understanding how the game works.
