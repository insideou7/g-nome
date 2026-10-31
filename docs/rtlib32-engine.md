# RTLIB32.DLL: how the engine loads and runs the game

Findings from reversing `G-NOME/RTLIB32.DLL` (373,248 bytes, MD5
`1a33a9960003f4b577ba0f7709fbeae6`, 7th Level "Runtime Player", Feb 1997).
`DOMINION/RTLIB32.DLL` on the same CD is a different, slightly newer build.

Method: REA 6.8.0 `decompile-all` with Ghidra 12.1.4 (all 1,190 functions),
plus capstone for the spots where Ghidra lost the stack logic. Addresses below
are virtual addresses in the G-Nome build (image base `0x10000000`). Function
names in brackets are my names; the DLL only names its 319 exports.

To reproduce:

```bash
bash scripts/install-ghidra.sh
GHIDRA_INSTALL_DIR=/opt/ghidra npx -y rea-agents@6.8.0 decompile-all \
  game/g-nome/G-NOME/RTLIB32.DLL --output re-output/rtlib32 --provider ghidra
```

## The big picture

```
G-NOME.EXE  --RtStartup-->  RTLIB32.DLL
                              |  opens G-NOME.BIN (ResOpenFile)
                              |  LoadLibrary("render.r32"), ("netgn.r32"), ("smacker.r32")
                              |  GetProcAddress for 306 extern names
                              |  runs script resource 0
                              v
                       script VM  --extern call-->  RENDER.R32 / NETGN.R32 / SMACKER.R32
                                                    (call back into RTLIB32 exports)
```

All game logic is bytecode inside `G-NOME.BIN`. The `.R32` files are plain
DLLs that give the scripts native functions (3D, AI, networking, video). The
exe is a message loop around `RtStartup`, `RtService` and `RtFree`.

## Startup

`RtStartup(hInstance, nCmdShow, cmdLine)` at `0x1001bc18`:

1. `RtInit` creates the global runtime state. Every function reaches it
   through the pointer at `0x10054788` (below, `rt`).
2. Builds the `.BIN` name from the exe's own path (`G-NOME.EXE` to
   `G-NOME.BIN`), reads `7THLEVEL.INI`, creates the window.
3. [LoadTitle] `0x1001d0d4` calls [OpenBin] `0x1001d73a`: `ResOpenFile`,
   resource count, title (`ResGetTitle`, sets the window text), fade/trans
   color counts, build type, then [LoadPlugins] `0x100101c6`.
4. Runs the entry script: [RunScript] `0x1001fcfe` with the id stored at
   `.BIN` offset `0x58` (it is `0` in G-Nome, so script resource 0 boots the
   game).

## .BIN header fields the engine uses

The runtime copies the file header into its resource-file struct at
`+0x2A0`, so struct offset = file offset + `0x2A0`.

| File offset | Meaning |
| --- | --- |
| `0x00` | `"7L"` magic |
| `0x07` | title, NUL terminated (`G-Nome`) |
| `0x58` | entry script resource id (0) |
| `0x5C` | up to 12 chunk boundaries of the script buffer |
| `0x11C` | number of script-buffer chunks (11) |
| `0x138` | 14 "key resources", each `{u32 offset, u32 size}` (`ResLoadKeyResource`, `0x10045701`) |

Key resources in G-Nome:

| Key | Offset | Size | Contents |
| --- | --- | --- | --- |
| 0 | `0x1A8` | 94,400 | resource table: 9,440 x `{u16 flags, u32 offset, u32 size}` |
| 3 | 94,824 | 688 | 86 x `{u32 variable, i32 value}`: initial values of globals |
| 4 | 95,512 | 8,605 | NUL-separated strings (`domintro.smk`, `g-nome.smk`, ...) |
| 5 | 104,117 | 1,020,546 | **script buffer**: all resources of type 13 to 22 |
| 6 | 1,124,663 | 944 | 236 x RGBX palette (header `0x120` also says 236) |
| 10 | 1,125,607 | 21 | plugin names: `render`, `netgn`, `smacker` |
| 11 | 1,125,628 | 4,495 | 306 extern function names |
| 12 | 1,130,123 | 1,224 | 306 x u32: which plugin exports each name |

Resource types 13 to 22 are never read from a pack file. `ResLoadResource`
(`0x10045893`) returns a pointer into the in-memory script buffer instead, so
their `offset` is relative to key 5, not to a `G-NOME.%03d` pack. (The earlier
guess that types 13 to 21 are ADPCM audio is wrong.) Type 19 (`0x13`) is a
script: 2,342 of them.

## Plugin loading

[LoadPlugins] `0x100101c6`:

1. Reads key 10. For each name, `wsprintf("%s.r32")`, `SetErrorMode(0x8000)`,
   `LoadLibraryA`. Failure is RtError `0x66`.
2. [InitPlugin] `0x10010344` grows the plugin array at `rt+0x315B` (count at
   `rt+0x3B3F`) by one 60-byte record, copies the name to `+0x2C`, fills an
   info block at `+0x08` with `{size = 0x24, version = 0x200}`, and calls
   `RtLibInit(rt, &record.info)`. Missing export: "plugin '%s' has no RtLibInit
   function". A zero return: "plugin '%s' initialization failed".
3. [BindExterns] `0x100104aa` reads key 12 (plugin index per name) and key 11
   (names), and fills the extern table at `rt+0x3157`: 8 bytes per name,
   `{u32 flag, FARPROC}`, using `GetProcAddress` on that plugin's module.
   A missing name: "extern function '%s' not found". Names starting with `_`
   get `flag = 0`, others `1`.

Plugin record (60 bytes):

| Offset | Field |
| --- | --- |
| `+0x00` | `HMODULE` |
| `+0x04` | context: the value `RtLibInit` returned, passed as the first argument to every call into the plugin |
| `+0x08` | info block handed to `RtLibInit`: `u32 size (0x24)`, `u32 version (0x200)`, then 7 hook slots the plugin may fill |
| `+0x2C` | name (16 bytes) |

Hooks the plugin can set in the info block (offset from the info block, then
where RTLIB32 calls it):

| Info offset | Called from | When |
| --- | --- | --- |
| `+0x0C` | `RtService` via `0x1000fe1f` | every service tick |
| `+0x10` | `0x10022690` after `AudioService` | audio/timer tick |
| `+0x14` | `0x1000fc20`, from window activation | app activated or deactivated (arg: active flag) |
| `+0x18` | `0x1000fd28` | pause state changed (arg: paused flag) |
| `+0x1C` | `0x1000fda2` | scene/title events (args: code, data). Code 1 after a title loads, 3 before it unloads |
| `+0x20` | `0x1000feae` | palette changed (arg: `rt+0x31AF` palette) |

`RENDER.R32` fills `+0x0C`, `+0x10`, `+0x14` and `+0x20`, and also registers
load/copy/free procs for 3D resource types (7 MODL, 8 MPRT, 9 OB3D, 10 OPRT)
with `RtSetRenderLoadProc` and friends. I have not yet checked which hooks
`SMACKER.R32` and `NETGN.R32` fill.

On unload, [FreePlugins] `0x1000ff2d` calls each plugin's `RtLibFree(ctx)`
and later `FreeLibrary` (log line "freeing %04x").

## Calling an extern

In an expression, a call is `push id; push args...; CALL argc`. The call
dispatcher `0x10003f4b` reads the id from the stack:

* `id < 0xFA`: one of RTLIB32's own builtins, a 247-case switch in
  `0x10003fad` (math like `Cosine` and `GetAngle`, sprites, sounds, strings,
  resource tables). Names for all of them are in
  [rtlib32-names.md](rtlib32-names.md); see "Naming the builtins" below.
* `id >= 0xFA`: extern number `id - 0xFA`. [CallExtern] `0x10009b6c` passes
  the function pointer, the plugin's context and the args to `ExternalCall`
  (export, `0x1002af65`).

`ExternalCall(fn, ctx, argv, argc, flag)` clears `flag` on entry, so the only
live path pushes `argv` last to first, then `ctx`, calls `fn` and pops the
stack itself. Every plugin export is therefore `cdecl fn(ctx, arg0, arg1, ...)`
returning a 32-bit int, which the VM pushes as the result. This matches
`RENDER.R32`'s exports (for example `GetProperty(ctx, obj, prop)`).

## Script bytecode

A script resource is a list of statements, run in order by [ExecScript]
`0x1001fdc6`, which calls [ExecStmt] `0x1001f1f7` for each one. Each statement
returns how far to move, which is how branches work. Script calls nest at most
30 deep (RtError `0x6A`).

### Statements

A `u16` opcode, then a record. Most records have a fixed size (the table is in
`tools/r32script.py`). The ones that matter for control flow:

| Op | Layout | Meaning |
| --- | --- | --- |
| `0xAF` | `u32 len, expr` | evaluate an expression (assignments, calls). 17,244 uses |
| `0x5B`, `0xE3` | `i32 else, i32 then, expr` | if: move by `then` (the record length) when true, by `else` when false |
| `0x68` | `i32 delta` | goto, relative to this statement. Loops are `if` + backward `goto` |
| `0xA1` | `u32 len, expr` | return the value (saved at `rt+0x3E1F`) |
| `0xA2` | | end of script |
| `0xDB` | `u32 ?, u32 table, i32 default, u8 n, u8 ?, expr`, then `n` x 12-byte cases `{u16, u32 value, i32 target, u8 is_var, u8}` | switch on an expression |
| `0xDA` | same, but the subject is a value or variable at `+2` | switch on a variable |
| `0x5A` | 18 bytes | compare two values, branch |
| `0x59` | 26 bytes | compare two values, call one of two scripts |
| `0x01` | `9 + 1 + 4*n` bytes | start a script with `n` args (`0x10015ce6`) |
| `0x39` | | quit (or go to the scene set by `0x3A`) |

The others call fixed-size handlers for sprites, palettes, sound, scenes and
so on. Their records hold literal values or variable ids with an "is a
variable" flag byte, resolved by `0x10014e00`. All 90 opcodes, with their
record layouts as far as they are known, are in
[rtlib32-names.md](rtlib32-names.md).

### Expressions

Stack bytecode, one-byte opcodes, ending with `0x00`. Evaluated by
[EvalExpr] `0x10003330`. The VM stack is at `0x10053EB0`; the stack pointer is
`rt+0x3D33`.

| Op | Operand | Effect |
| --- | --- | --- |
| `01` | `i32` | push constant |
| `02` | `u32 var` | push variable value |
| `04` | `u32 var` | push variable address |
| `03` | | `a[i]` load |
| `05` | | dereference |
| `06` | | `&a[i]` |
| `08` | | assign `*a = b`, leaves `b` |
| `0D` | `u32 ?, u32 argc` | call builtin or extern (see above) |
| `0E` | `u32 nlocals, u32 argc` | call another script, with a new frame of `nlocals` locals |
| `0F` `10` `11` | | `-a`, `!a`, `~a` |
| `12` to `16` | | `+ - * / %` (divide by zero is RtError `0x6F`) |
| `17` to `1C` | | `== <= < >= > !=` |
| `1D` `1E` | | `&& ||` |
| `1F` `20` `21` `29` `2A` | | `& | ^ << >>` |
| `22` to `25` | | `++a a++ --a a--` |
| `26` `27` | `u32 skip` | short-circuit `||` / `&&` |
| `28` | | push `*top` without popping |

Variables are 32-bit ints. Ids below `0x13FE` (5,118) are globals at
`rt+0x3E2F`. Ids from `0x13FE` up are locals and arguments in the current
frame (`rt+0x35CF`), so `0x13FE` is `L0`, the first argument.

The runtime itself writes a few globals. On every mouse message RTLIB32
(`0x1000af10`, via `0x100134e9`) stores the pointer position relative to
the screen centre in `G5005` (x) and `G5006` (y), at `rt+0x8C63` and
`rt+0x8C67`. List screens read the clicked row from `G5006`.

## Naming the builtins and statements

Both dispatchers are MSVC two-level switches, so the case tables can be read
straight out of the DLL:

| Switch | Index byte table | Jump table | Ids |
| --- | --- | --- | --- |
| builtins, `0x10003fad` | `0x10009a69` (indexed by `id - 2`) | `0x1000979d` | 2 to `0xF8` (247 slots) |
| statements, [ExecStmt] `0x1001f1f7` | `0x1001fbd2` (indexed by `op - 1`) | `0x1001fa6e` | 1 to `0xE6` |

66 builtin slots jump to `0x10009767`, an empty case, which leaves 181 real
functions. Each handler pops its arguments off the VM stack (last argument
first) and either calls an RTLIB32 export (`SpriteGetPosition`, `AudioMute`,
`lstrcmpA`, ...), which names it outright, or builds a statement record on
the stack and calls that statement's handler. So builtin `0xB8` fills a
`0xB8` record and calls the `sprite_set_pos` handler, `0x85` fills a `0x10`
(click) record, `0x81` a `0x6B` (key binding) record, and so on: most
builtins are the call form of a statement and share its number or its
handler. Statement handlers in turn are a small parser (resolving the
variable flags with `0x10014e00`) followed by the implementation, which
again usually calls a named export.

The names, argument lists and record layouts live in one file,
[web/src/names.js](../web/src/names.js). The web engine imports it (its
"unimplemented" log and disassembler print names), `tools/r32script.py`
parses it, and `python3 -I tools/r32script.py --names-md` regenerates
[rtlib32-names.md](rtlib32-names.md) from it. `tests/test_r32names.py` checks
that the three agree.

A few runtime fields that several of them touch:

| Field | Set by | Meaning |
| --- | --- | --- |
| `rt+0x3d43` | builtin `0x05` | script run with the active flag on window (de)activation |
| `rt+0x3d47` | statement `0x04` | script run when the window gets the focus back; cleared on scene change |
| `rt+0x3d53` | builtin `0xE9` | script run once at shutdown |
| `rt+0x3deb` | builtins `0x69`, `0x6B` | key filter script, called before the key bindings |
| `rt+0x3dfb` | statement `0x78`, builtin `0x83` | mouse filter script, called with 1 (down), 2 (up), 4 (move) |
| `rt+0x3e0f` | statement `0x8A`, builtin `0xEC` | pause script (instead of `AudioPause`) |
| `rt+0x3e13` | builtin `0x94` | script posted with the wave id whenever a wave starts |
| `rt+0x3e23`, `rt+0xb80` | builtin `0xA5` | one-shot alarm: script and due time |
| `rt+0x3cf7` | statement `0x72` | current source line, reported by `RtGetErrFile` |
| `rt+0x3e27` | statement `0x3E` | statement trace on/off |
| `rt+0x3d57` | builtin `0xAE` | sprite being dragged |
| `rt+0x3d5b` | statement `0x2C` | text being edited (keys go to it) |
| `rt+0xfe8 + 0x3c5 * n` | statements `0x5E`, `0x60`, `0x61`, `0x63` | input device state for player n (0 or 1) |

What the menus, LAB and mission 1 hit: statements `0x4D`, `0x71`, `0xB8`,
`0x8E`, `0xD2` and builtin `0xE7` were the only RTLIB32 ones the web engine
did not implement yet; they are in now. G-Nome's scripts call 19 of the 181
builtins in all (`python3 -I tools/r32script.py G-NOME.BIN --summary`);
`0xC8` ScreenShake is the one the web engine still lacks.

## Sprite motion: paths, speed and motion

Sprite messages (builtin `0xCE` SpriteSendMessage runs one now, `0xCD`
SpritePostMessage queues it; dispatcher `0x1003e1dd`) and type 18 queue
records share their type numbers. The queue step is `0x1003a613`; record
set-up is `0x1003a042`. Each sprite has two clocks:

- **speed** (`SpriteSetSpeed` `0x10035caa`, sprite `+0x54`, deadline
  `+0x4c`): ms between path steps. 0 steps on every service.
- **motion** (`SpriteSetMotion` `0x10035c02`, `+0x58`, deadline `+0x50`):
  ms between cels. Records 1 and 2 set it from their delay.

A deadline restarts from now when it passes, unless keep-time (flag bit 13)
is on: then it advances from the old deadline.

| type | message args | record layout | what it does |
|---|---|---|---|
| 5 | x1, y1, x2, y2, steps, relative | +2 steps, +6 u8 relative, +0xc x1, +0x10 y1, +0x14 x2, +0x18 y2; var flags +7..+0xb; 0x3c bytes | Quadratic curve from the sprite through (x1, y1) at its midpoint to (x2, y2): `t = (i*1024 + n/2)/n`, `p = p0 + (t^2 (p2-p0) + t(1024-t)(4(p1-p0) - (p2-p0))) >> 20` (`0x10042f50`). |
| 9 | x1, y1, steps, pixels, relative | +2 steps, +6 u8 relative, +7 u8 pixels, +0xc x1, +0x10 y1; var flags +8, +9, +0xa; 0x2c bytes | Line to (x1, y1), each coordinate `d*i/n` rounded half away from zero (`0x10042ff0`, also `SpriteLinePoint`). With pixels, steps is the step length: `n = ceil(max(abs dx, abs dy) / steps)` (`0x10039e82`). |
| 10 | x, y, relative (needs all 3) | +2 u8 relative, +6 x, +0xa y; var flags +3, +4 | One move to (x, y), or by (x, y), at the next speed tick. |
| 13 | flag | +2 flag | Keep-time on or off; both deadlines reset to 0. |
| 14 | flag | +2 flag | Bit 15 of the flags: where the position is kept (sprite or frame record). No visible effect in the port. |
| 15 | ms | +2 ms (var flag +6) | Sets motion. |
| 16 | current, from, to | +2, +6, +0xa (var flags +0xe..+0x10) | Cel range (`0x10036cc1`); backwards when to < from. |
| 17 | ms[, motion] | +2 ms, +6 motion if not 0 (var flags +0xa, +0xb) | Sets speed, and motion. |

A message 5, 9 or 10 sent now empties the queue first (`0x1003e606`) and
takes its first step at once. While a path runs, a range of more than one
cel cycles at the motion rate, wrapping to `from` (`0x10036f00`).

No G-NOME script or queue uses records or messages 5, 9, 10, 13, 15, 16 or
17: the queues use 1, 2, 6, 8, 11, 18, 21 and 23, and the scripts send
messages 1, 2, 7, 8, 12, 14 and 18 only. The web engine implements them all
(`web/src/sprites.js`) and tests them on made-up sprites
(`web/tests/sprite-motion-check.mjs`).

## Disassembler

`tools/r32script.py` implements all of the above. On `G-NOME.BIN` it parses
all 2,342 scripts to exactly their stored size, which is a good check that the
statement sizes and expression format are right. A `goto` and a `switch`
are listed at their own size, so the code after a forward `goto` and the
case bodies of a `switch` (its case table follows them and is skipped) are
listed too; before, both skipped over that code. Example from script 1 (game
reset):

```
0000  expr           G733 = 0
0012  expr           L0 = 0
0024  if             (L0 < 20)  else->+1256
003a  expr           G13[L0] = 0
...
04f8  expr           L0++
0506  goto           -1250
```

and calls into plugins:

```
expr  L5 = smacker.SmackerSetupView(0, 0, 3, 640, 0, 1)
if    !(netgn.DPGetPlayerInfo(L5, &L1, 3))  else->+92
```

```bash
python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --summary
python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --script 0 --script 1
python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --externs
python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --all > re-output/scripts.txt
```

## Open questions

* Some names are still guesses, marked with "?" in
  [rtlib32-names.md](rtlib32-names.md): the input device type numbers
  (statement `0x60`), builtin `0x5F`'s table, and builtin `0x0A`, which is
  the same as `0x09` in this build.
* Record layouts of statements G-Nome never uses (the input device ones,
  `0x8F`/`0x91` sound options, `0x2C`'s second field) are only partly known.
* The first `u32` of expression op `0D`. It ranges
  from 0 to 29 across the scripts, but the VM never reads it (maybe a
  compiler leftover such as a stack depth).
* Global variable names. The `.BIN` has no symbols, so they have to come from
  how the scripts use them.
