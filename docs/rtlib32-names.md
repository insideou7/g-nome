# RTLIB32 function and statement names

Generated from [web/src/names.js](../web/src/names.js) by
`python3 -I tools/r32script.py --names-md`. Edit names.js, not this
file. How they were found: [rtlib32-engine.md](rtlib32-engine.md).

## Builtin functions

Called from expressions as `CALL id` with `id < 0xFA`. The switch at
`0x10003fad` has 247 slots (ids 2 to 0xF8); 181 of them do something and
the rest are empty. Arguments are in script order.

| Id | Name | Arguments | What it does |
| --- | --- | --- | --- |
| `0x02` | Nop |  | Does nothing. |
| `0x03` | Abs | x | Absolute value. |
| `0x05` | SetActivateScript | script | Script run with 1 or 0 when the game window is activated or deactivated. Returns its argument. |
| `0x06` | BigAdd | addHi, addLo, &hi, &lo | Adds addHi*10000 + addLo to the base-10000 number in hi/lo (scores). |
| `0x07` | VolumeStepCD | dir | CD audio volume one step up (dir >= 0) or down (statement 0xC6). |
| `0x08` | VolumeStepMidi | dir | MIDI volume one step up (dir >= 0) or down. |
| `0x09` | VolumeStepAll | dir | CD, MIDI and wave volume one step up (dir >= 0) or down. |
| `0x0A` | VolumeStepAll2 | dir | Same as 0x09 in this build (probably meant for wave volume). |
| `0x0B` | GetAngle | x1, y1, x2, y2 | Angle from point 1 to point 2, in tenths of a degree (0-3599). |
| `0x0C` | StrToInt | str | atoi of a string. |
| `0x0D` | SpriteBreakLoops | sprite, flag | Ends the loops in the sprite's queue (statement 0x0D). |
| `0x0F` | SetMouseMoveScript | script | Script run as the mouse moves (0 = none). Returns the previous one. |
| `0x12` | Collide | ...8 args | RTLIB32 export Collide (bounce maths). |
| `0x15` | BitmapMerge | dest, src, x, y | Draws bitmap src into bitmap dest at x, y. |
| `0x16` | BitmapMerge2 | dest, src[, x[, y]] | BitmapMerge with optional position (0 if missing). |
| `0x18` | SpriteHitTest | spriteA, spriteB, a, b, c | SpriteHitDetect between two sprites; 1 if they touch. |
| `0x19` | CopyResource | id | Copies a resource (ResCopyResource); returns the new id. |
| `0x1A` | Cos | angle | Cosine of an angle in tenths of a degree, scaled (export Cosine). |
| `0x1B` | SetCursor | shape | Mouse cursor shape (statement 0x1B). |
| `0x1D` | CurvePoint | ... | SpriteCurvePoint: a point on a curve. |
| `0x1E` | DebugPrintf | fmt, args... | wvsprintf to the debug output (only when debugging is on). |
| `0x1F` | HoverRemoveAll |  | Removes every hover region (statement 0x0E, remove all). |
| `0x20` | HoverRectRemove | l, t, r, b | Removes the hover region with this rectangle. |
| `0x21` | ClickRectRemove | l, t, r, b | Removes the click region with this rectangle (statement 0x10). |
| `0x22` | DeleteCopy | id | Deletes a copy made by CopyResource; 1 on success. |
| `0x24` | ClickRemoveAll |  | Removes every click region and sprite click handler. |
| `0x25` | KeyUnbind | key | Removes the plain binding of a key (statement 0x6B). |
| `0x26` | KeyUnbindMod | key, ctrl, shift | Removes a key binding with modifiers. |
| `0x27` | ClickSpriteRemove | sprite | Removes a sprite's click handler. |
| `0x28` | OnCollide |  | Collision handler between two sprites, arguments from the stack (statement 0x17). |
| `0x29` | Distance | x1, y1, x2, y2 | Distance between two points (export Distance). |
| `0x2A` | BigDiv | divHi, divLo, &hi, &lo | Divides the base-10000 number in hi/lo by divHi*10000 + divLo. |
| `0x2D` | SpriteStop | sprite, hide | Empties the sprite's queue, hiding it first if hide (statement 0xB9 with no queue). |
| `0x2E` | ClickAllEnable | on | Turns every click region and sprite click on or off. |
| `0x2F` | ClickRectEnable | l, t, r, b, on | Turns one click region on or off. |
| `0x30` | InputEnable | player, on | Turns a player's input device on or off (statement 0x60). |
| `0x32` | KeyEnable | key, on | Turns a key's bindings on or off. |
| `0x33` | KeyEnableMod | key, ctrl, shift, on | KeyEnable; the modifiers are ignored by the handler. |
| `0x34` | ClickSpriteEnable | sprite, on | Turns a sprite's click handler on or off. |
| `0x35` | SpriteDragOff | sprite, off | Turns dragging of a sprite off, or back on with off = 0 (statement 0x2B). |
| `0x37` | GotoScene | name, free | Switches to another scene (statement 0x36). |
| `0x38` | GotoSceneReturn | free | Returns to the previous scene. |
| `0x39` | Quit |  | Goes to the quit scene if one is set (statement 0x3A), else quits. |
| `0x3B` | BitmapLoadFile | bitmap, path, flag | Loads an image file or icon into a bitmap resource. |
| `0x3C` | FadeIn | speed | Fades the palette in (statement 0x3C). |
| `0x3D` | FadeOut | speed | Fades the palette out (statement 0x3D). |
| `0x3F` | SpriteGetBounds | sprite, &l, &t, &r, &b | Sprite's bounding box (statement 0x3F). |
| `0x41` | StrGetChar | str, i | Character i of a string (0 past the end). |
| `0x43` | GetDate | &weekday, &month, &day, &year | Local date (statement 0x42); arguments from the stack. |
| `0x44` | TableDim | table, k | Size of dimension k of a type 11 table (header +0x28 + 4k). |
| `0x45` | TableDim2 | table, k | Same as TableDim. |
| `0x46` | GetDriveType |  | GetDriveType of the drive the game runs from (5 = CD-ROM). |
| `0x47` | GetFreeMemory |  | Free physical memory in 64 KB units, measured at startup. |
| `0x48` | LineIntersect | &x, &y, x1, y1, x2, y2, x3, y3, x4, y4 | Where two lines cross (export GetIntersect, statement 0x48). |
| `0x49` | GetMouseFilter |  | The mouse filter script set by statement 0x78. |
| `0x4A` | SpriteGetNumCels | sprite | Number of cels in a sprite. |
| `0x4B` | TableNumDims | table | Number of dimensions of a type 11 table. |
| `0x4C` | Zero |  | Returns 0. |
| `0x4D` | SpriteGetPos | sprite, &x, &y | Sprite position (statement 0x4D). |
| `0x4E` | GetQuadrant | angle | Quadrant 0-3 of an angle (export GetQuadrant). |
| `0x4F` | GetClipBox | &l, &t, &r, &b | The sprite engine's clip box. |
| `0x50` | GetScrollPos | &x, &y | The sprite engine's scroll position. |
| `0x51` | SpriteGetInfo | sprite, &a, &b, &c, &d | Per-layer values from SpriteGetInfo (statement 0x40). |
| `0x52` | TableGet | table, i, j, ... | Element of a type 11 table. |
| `0x53` | GetTime | &hour, &minute, &second, &hundredths | Local time (statement 0x53); arguments from the stack. |
| `0x55` | PostAtom | str | Adds the string as a global atom and posts message 0xF000 with it to the game window. |
| `0x56` | GetUserName | str | Windows user name into a string variable (default if none). |
| `0x57` | WaveGetTime | wave | Length of a wave resource (AudioGetWaveSoundTime). |
| `0x5D` | RunListItem | list, var, advance, script | Statement 0xD9 as a function; var is a variable number, not an address. |
| `0x5F` | SetInputMap | slot, field, value | Sets field 1-8 of entry slot in a 16-byte input mapping table (joystick?). |
| `0x62` | InputActivate | player, exclusive | Makes a player's input device current. |
| `0x64` | IsLoaded | id | 1 if the resource is loaded. |
| `0x66` | SetJoystickSwap | on | Swaps joystick 1 and 2 messages. |
| `0x67` | SetJoystickFlag | on | Sets a joystick option (byte +0x94c5) whose effect is unclear. |
| `0x69` | SetKeyFilter | script | Script called with each key before the bindings (0 = none); return 0 to swallow. Returns the previous one. |
| `0x6A` | IsKeyDown | vk | 1 while a virtual key is held (GetKeyState). |
| `0x6B` | SetKeyFilter2 | script | Same as SetKeyFilter. |
| `0x6E` | TimerStop | id | Stops a timer; -1 stops all (statement 0x6D). |
| `0x6F` | RunProgram | path[, args[, flag]] | Starts another program (WinExec, or ShellExecute with a flag); 1 on success. |
| `0x71` | SpriteSetLevel | sprite, level | Drawing level of a sprite (statement 0x71). |
| `0x73` | LinePoint | ... | SpriteLinePoint: a point along a line. |
| `0x74` | RunLater | script | Runs a script from the message loop (statement 0x74). |
| `0x75` | Load | id | Loads a resource (statement 0x75); 1 on success. |
| `0x76` | Max | a, b | Larger of two numbers. |
| `0x77` | Min | a, b | Smaller of two numbers. |
| `0x79` | BigMul | mulHi, mulLo, &hi, &lo | Multiplies the base-10000 number in hi/lo by mulHi*10000 + mulLo. |
| `0x7B` | SetMute | on | Mutes or unmutes all sound (statement 0x7A). |
| `0x7C` | SpriteOffset | sprite, dx, dy | Moves a sprite by dx, dy (statement 0x7C). |
| `0x7D` | ClickAllScript | script | Gives every click region and sprite click the same script (statement 0x10, global form). |
| `0x7E` | ClickRectsScript | script | Gives every click region this script; 0 removes them all. |
| `0x7F` | ClickSpritesScript | script | Sets the click script of every sprite. |
| `0x80` | InputSetParam | player, value | Sets a player input value; returns the old one (statement 0x61). |
| `0x81` | KeyBind | key, script | Binds a key to a script (statement 0x6B). |
| `0x82` | KeyBindMod | key, ctrl, shift, script | Binds a key with modifiers. |
| `0x83` | SwapMouseFilter | script | Sets the mouse filter script (statement 0x78); returns the old one. |
| `0x84` | HoverRect | l, t, r, b, script, arg | Hover region: runs script with arg when the mouse enters (statement 0x0E). |
| `0x85` | ClickRect | l, t, r, b, script, arg | Click region (statement 0x10). |
| `0x86` | ClickSprite | sprite, script, arg | Click handler on a sprite (statement 0x10). |
| `0x87` | OnCollide2 |  | Same as 0x28. |
| `0x88` | SpriteDrag | sprite, dragScript, dropScript | Makes a sprite draggable (statement 0x2B). |
| `0x89` | AudioPause | on | Pauses or resumes all sound. |
| `0x8B` | MidiPause | on | Pauses or resumes MIDI music. |
| `0x8C` | SpritePause | sprite, on | Pauses a sprite's animation (0 = all sprites) and its clock. |
| `0x8D` | TimersPause | on | Pauses or resumes every timer. |
| `0x8E` | CDPlay | track | Plays a CD audio track (statement 0x8E). |
| `0x90` | MidiPlay | ... | Statement 0x8F as a function. |
| `0x92` | WavePlay | ... | Statement 0x91 as a function. |
| `0x93` | WavePlay2 | ... | Another WavePlay form. |
| `0x94` | SetWaveScript | script | Script posted with the wave id each time a wave starts (0 = none). |
| `0x96` | PostScript | script, a, b | Queues a script call for the next service tick (statement 0x95). |
| `0x97` | PrintBitmap | bitmap[, flag] | Prints a bitmap on the default printer. |
| `0x98` | SpriteIsPicked | sprite, x, y | 1 if the sprite has a solid pixel at x, y. |
| `0x99` | Random | a, b | Random integer in [a, b]. |
| `0x9B` | RunRandom | list | Runs a random script from a script list (statement 0x9A). |
| `0x9D` | RegGetString | key, value, dest[, flag] | Reads a registry string into a string variable. |
| `0x9E` | ReflectAngle | angle, wall | Angle after bouncing off a wall (export ReflectAngle). |
| `0xA0` | PaletteRestore | first, count | Restores palette entries from the saved palette (statement 0xB3). |
| `0xA5` | SetAlarm | script, seconds | Posts the script once after a number of seconds (script 0 cancels). |
| `0xA6` | Scroll | dx, dy | Scrolls the sprite engine's view. |
| `0xA8` | RunNext | list | Runs the next script of a script list (statement 0xA7). |
| `0xAA` | SetBackgroundBitmap0 |  | Statement 0xA4 mode 0 with no bitmap (unused). |
| `0xAB` | SetBackgroundBitmap | bitmap, t1, t2, t3 | Bitmap background; t1-t3 pick a transition (statement 0xA4). |
| `0xAC` | StrSetChar | str, i, ch | Sets character i of a string variable. |
| `0xAD` | SetClipBox | l, t, r, b | Clip box of the sprite engine (statement 0x11). |
| `0xAE` | StartDrag | sprite | Starts dragging a sprite from the current mouse position. |
| `0xB0` | InputSetDevice | player, type, device | Gives a player an input device: type 1 joystick, 2 keyboard?, 5 mouse? (statement 0x60). |
| `0xB2` | SetQueueValue | res, value | Sets field +0x4c of a type 13 resource (purpose unknown). |
| `0xB3` | PaletteFill | first, count, r, g, b | Sets a range of palette entries to one colour (statement 0xB3). |
| `0xB4` | SetPalette | palette | Loads a type 17 palette (statement 0xB4). |
| `0xB5` | SetBackgroundColor0 |  | Statement 0xA4 mode 1 with colour 0. |
| `0xB6` | SetBackgroundColor | index, t1, t2, t3 | Solid background in palette colour index, with a transition. |
| `0xB8` | SpriteSetPos | sprite, x, y | Moves a sprite to x, y (statement 0xB8). |
| `0xB9` | SpriteSetQueue | sprite, queue[, hide] | Gives a sprite a queue (statement 0xB9). |
| `0xBA` | SpriteSetQueue2 | sprite, queue | SpriteSetQueue without hiding. |
| `0xBB` | SetBackgroundRGB | r, g, b | Solid background in the nearest palette colour. |
| `0xBC` | SetBackgroundRGBEx | r, g, b, t1, t2, t3 | SetBackgroundRGB with a transition. |
| `0xBD` | SetScrollBox | l, t, r, b | Limits of the scroll position (RtSetScrollBox). |
| `0xBE` | SetScrollPos | x, y | Scroll position of the sprite engine. |
| `0xBF` | SpriteSetClipBox | sprite, l, t, r, b | Clip box of one sprite. |
| `0xC1` | TableSet | table, value, i, j, ... | Sets an element of a type 11 table; 1 on success. |
| `0xC5` | TimerStart | id, ms, script, repeat | Runs a script after ms, again every ms if repeat (statement 0xC4). Note the order: ms before script. |
| `0xC7` | SetWallpaper | bitmap, file, tile | Saves a bitmap as the Windows desktop wallpaper (statement 0xB7). |
| `0xC8` | ScreenShake | a, b | Shakes the screen (SpriteScreenShake). |
| `0xCA` | Sin | angle | Sine of an angle in tenths of a degree, scaled (export Sine). |
| `0xCB` | SpriteToBackground | sprite, flag | Draws a sprite into the background (0 = all) (statement 0x14). |
| `0xCC` | SpriteGetExtra | sprite | The sprite's extra id (SpriteGetExtraId). |
| `0xCD` | SpritePostMsg | sprite, type, args... | SpritePostMessage: queued sprite message. |
| `0xCE` | SpriteMsg | sprite, type, args... | SpriteSendMessage: sprite message applied now. |
| `0xCF` | SpriteSetExtra | sprite, value | Sets the sprite's extra id. |
| `0xD0` | SpriteTransfer | from, to, queue, destroy | Moves a sprite's image to another sprite and starts a queue (statement 0xDE). |
| `0xD1` | Sqrt | x | Integer square root (export SquareRoot). |
| `0xD2` | CDStop |  | Stops CD audio (statement 0xD2). |
| `0xD3` | MidiStop | midi | Stops a MIDI resource (statement 0xD3). |
| `0xD4` | WaveStop | wave, flag | Stops a wave resource (statement 0xD4). |
| `0xD5` | StrCmp | a, b | lstrcmp of two strings. |
| `0xD6` | StrCmpI | a, b | lstrcmpi of two strings. |
| `0xD7` | StrLen | str | Length of a string. |
| `0xD8` | StrFind | str, sub, start | Position of sub in str from start, or -1. |
| `0xDD` | ToggleMute |  | Toggles mute (AudioMute -1). |
| `0xDF` | Unload | id | Unloads a resource (statement 0xDF). |
| `0xE0` | RayBoxExit | &x, &y, x, y, angle, l, t, r, b | Where a ray from x, y at angle leaves a box (statement 0xE0). |
| `0xE1` | SpriteIsVisible | sprite | 1 if the sprite is shown. |
| `0xE2` | SetFlag94dd | on | Sets runtime byte +0x94dd, which enables an Escape-key path in the key handler. |
| `0xE5` | RegSetString | key, value, str[, flag] | Writes a registry string. |
| `0xE7` | SpriteSetSync | on | Sync mode of the sprite engine (SpriteSetSync). |
| `0xE8` | CachePack | pack, flag | Copies pack file G-NOME.%03d from the CD to the hard disk. |
| `0xE9` | SetExitScript | script | Script run once when the game shuts down. |
| `0xEA` | FreeStringTables |  | Frees every string table but the current one. |
| `0xEB` | SetScreenRes | w, h, bits | Changes the display mode (RtSetScreenRes). |
| `0xEC` | SetPauseScript | script | Script run on pause/unpause instead of AudioPause (statement 0x8A). |
| `0xED` | StrCat | dest, src | Appends a string to a string variable. |
| `0xEE` | StrCpy | dest, src | Copies a string into a string variable. |
| `0xEF` | StrNCpy | dest, src, n | Copies at most n characters. |
| `0xF0` | GetGamePath | dest | Full path of the game folder (MakeFullPath) into a string variable. |
| `0xF2` | UncachePack | pack | Drops a pack copied by CachePack and reads it from the CD again. |
| `0xF3` | SetMousePos | x, y | Moves the mouse pointer (statement 0x1C). |
| `0xF4` | RegGetInt | key, value, &dest, flag | Reads a registry number. |
| `0xF5` | RegGetString2 | key, value, dest[, flag] | Same as 0x9D. |
| `0xF6` | RegSetInt | key, value, n, a, b | Writes a registry number. |
| `0xF7` | RegSetString2 | key, value, str[, flag] | Same as 0xE5. |
| `0xF8` | FileExistsOnCD | path | 1 if a file exists on the game CD (RtFileExistsOnCD). |

## Statements

A `u16` opcode, then the record. Offsets count from the opcode.

| Op | Name | Record | What it does |
| --- | --- | --- | --- |
| `0x01` | spawn | +2 script, +6 is var, +7 arg var bits, +9 u8 argc, +10 args | Calls a script with arguments. |
| `0x02` | nop |  | Does nothing. |
| `0x04` | set_resume_script | +2 script (flag +6) | Script run when the game window gets the focus back. |
| `0x0B` | get_angle | +2 var, +6 x1, +10 y1, +0xe x2, +0x12 y2 (flags +0x16..) | var = angle from point 1 to point 2. |
| `0x0D` | sprite_break_loops | +2 sprite (flag +7), +6 u8 flag | Ends the loops in a sprite's queue. |
| `0x0E` | hover | +2 rect, +0x12 enter script, +0x16 arg, +0x1a leave script, +0x1e arg, +0x22 sprite, +0x26 u8 remove all | Hover region. |
| `0x10` | click | +2 sprite, +6 script, +10 arg, +0xe rect, +0x1e u8 global, +0x1f u8 enable, +0x20 u8 disable | Click region or sprite click handler. |
| `0x11` | set_clip_box | +2 rect (var bits +0x12) | Clip box of the sprite engine. |
| `0x14` | sprite_to_background | +2 sprite (0 = all), +6 u8 flag | Draws a sprite into the background bitmap. |
| `0x17` | on_collide | +2 sprite a, +6 sprite b, +10 script (0 removes), +0xe arg, +0x12 arg, +0x16 u8 remove all | Runs a script when two sprites collide. |
| `0x1A` | cos | +2 var, +6 angle | var = Cosine(angle). |
| `0x1B` | set_cursor | +2 u8 shape | Mouse cursor shape / input mode. |
| `0x1C` | set_mouse_pos | +2 x, +6 y (flags +10, +11) | Moves the mouse pointer. |
| `0x1E` | debug_print | +6 string | Writes a string to the debug output. |
| `0x23` | ini_delete_section | +2 section string (0 = the game's) | Deletes a 7THLEVEL.INI section. |
| `0x2B` | sprite_drag | +2 sprite, +6 drag script, +10 drop script, +0xe u8 off | Makes a sprite draggable; off ends a drag in progress. |
| `0x2C` | text_edit | +2 text (0 = stop), +6 ? | Starts typing into a type 21 text (keys go to it). |
| `0x36` | goto_scene | +2 name[16], +0x12 u8 free resources, +0x13 u8 return to previous | Switches scene. |
| `0x39` | quit |  | Quits, or goes to the scene set by 0x3A. |
| `0x3A` | set_quit_scene | +2 name[16] | Scene that 0x39 goes to instead of quitting. |
| `0x3C` | fade_in | +2 speed (1-100) | Fades the palette in. |
| `0x3D` | fade_out | +2 speed (1-100) | Fades the palette out. |
| `0x3E` | trace | +2 on | Turns statement tracing on or off. |
| `0x3F` | sprite_get_bounds | +2 sprite (flag +6), +8 var l, +0xc t, +0x10 r, +0x14 b | Sprite's bounding box into four variables. |
| `0x40` | sprite_get_info | +2 sprite, +8 vars[] | Per-layer values from SpriteGetInfo into variables. |
| `0x42` | get_date | +2 var weekday, +6 var month, +10 var day, +0xe var year | Local date. |
| `0x48` | line_intersect | +2 var x, +6 var y, +10 x1 y1 x2 y2 x3 y3 x4 y4 | Where two lines cross. |
| `0x4D` | sprite_get_pos | +2 sprite (flag +6), +8 var x, +0xc var y | Sprite position into two variables. |
| `0x53` | get_time | +2 var hour, +6 var minute, +10 var second, +0xe var hundredths | Local time. |
| `0x59` | if_cmp_call | +2 then script, +6 else script, +10 u8 has else, +0xe a, +0x12 b, +0x16 u8 op (variable flags +0xb, +0xc, +0x17, +0x18) | Compares a and b (op bits: 1 ==, 2 >, 4 <, 8 \|, 0x10 &, 0x20 %, 0x80 not; 0 = a != 0) and calls a script. |
| `0x5A` | if_cmp_goto | +2 else delta, +6 a, +10 b, +0xe u8 op (variable flags +0xf, +0x10) | Compares like 0x59 and skips by the else delta when false. |
| `0x5B` | if | +2 else delta, +6 then delta (record length), +10 expr | If. |
| `0x5C` | if_loaded_call | +2 resource, +6 script (flags +10, +11) | If the resource is loaded, calls the script (no script: stops). |
| `0x5E` | input_bind | +2 player, +6 event, +10 script, +0xe priority, +0x12 arg, +0x16 u8 all, +0x17 u8 enable, +0x18 u8 disable | Binds a player input event to a script. |
| `0x60` | input_set_device | +2 u8 player, +6 device, +10 u8 type (1 joystick, 2 keyboard?, 5 mouse?), +0xb u8 on, +0xc u8 release | Gives a player an input device. |
| `0x61` | input_set_param | +2 player, +6 value | Sets a player input value. |
| `0x63` | input_get_state | +2 player, +6 var, +10 var, +0xe var | Reads a player's input state. |
| `0x65` | set_slot | +2 index (0-33), +6 value (flag +10) | Stores a value in a per-scene table that is cleared on scene change. |
| `0x68` | goto | +2 delta | Jumps relative to this statement. |
| `0x6A` | get_key_state | +2 var, +6 virtual key | var = 1 while the key is held. |
| `0x6B` | key_bind | +2 key (0 = all), +6 script, +0xc u8 shift, +0xd u8 ctrl, +0xe u8 enable, +0xf u8 disable, +0x10 u8 on key up | Binds a key to a script. |
| `0x6D` | timer_stop | +2 id, +6 u8 all | Stops a timer. |
| `0x71` | sprite_set_level | +2 sprite, +6 level (flags +10, +11) | Drawing level of a sprite. |
| `0x72` | line | +2 line number | Source line number, for error messages. |
| `0x74` | run_later | +2 script (flag +6) | Runs a script from the message loop. |
| `0x75` | load | +2 resource (flag +6) | Loads a resource. |
| `0x78` | set_mouse_filter | +2 script (flag +6) | Script called with 1 (button down), 2 (up), 4 (move) before the click handlers; return 0 to swallow. |
| `0x7A` | mute | +2 u8 on | Mutes all sound. |
| `0x7C` | sprite_offset | +2 sprite, +6 dx, +10 dy | Moves a sprite by dx, dy. |
| `0x8A` | set_pause_script | +2 script (flag +6) | Script run on pause instead of AudioPause. |
| `0x8E` | cd_play | +2 u8 track | Plays a CD audio track. |
| `0x8F` | midi_play | +2 midi (type 6), +8 options | Plays MIDI music. |
| `0x91` | wave_play | +2 wave (type 12), options | Plays a sound. |
| `0x95` | post_script | +2 script, +6 arg, +10 arg (flags +0xe..+0x10) | Queues a script call for the next service tick. |
| `0x99` | random_var | +2 var, +6 low, +10 high | Random number in [low, high], never the same twice in a row. |
| `0x9A` | run_random | +2 u8 count, +3 u8 last, +4 u8 is list, +6 scripts[] (or a list) | Runs one of the scripts at random, never the same twice in a row. |
| `0x9C` | ini_read | +2 var, +6 key, +10 section, +0xf u8 string | Reads 7THLEVEL.INI. |
| `0xA1` | return | +2 length, +6 expr | Returns a value. |
| `0xA2` | end |  | End of script. |
| `0xA3` | ini_backup |  | Copies 7THLEVEL.INI to a backup file. |
| `0xA4` | set_background | +2 mode (0 bitmap, 1 colour, 2 none, 3 type 22), +6 resource, +10 resource 2, +0x10 u8 colour, +0x12 transition | Sets the background. |
| `0xA7` | run_next | same as 0x9a | Runs the scripts one after another, one per call. |
| `0xA9` | calc | +2 var, +6 count, +10 terms | Arithmetic on a variable. |
| `0xAF` | expr | +2 length, +6 expr | Evaluates an expression. |
| `0xB3` | palette_set_range | +2 first, +6 count, +10 u8 restore, +0xe rgb | Sets or restores a range of palette entries. |
| `0xB4` | set_palette | +2 palette (flag +6) | Loads a type 17 palette. |
| `0xB7` | set_wallpaper | +2 bitmap, +6 file name, +10 u8 tile | Saves a bitmap as the Windows desktop wallpaper. |
| `0xB8` | sprite_set_pos | +2 sprite, +6 x, +10 y (flags +0xe, +0xf, +0x10) | Moves a sprite. |
| `0xB9` | sprite_set_queue | +2 sprite, +6 queue, +10 u8 hide (flags +0xb, +0xc) | Gives a sprite a queue (type 18), or clears it. |
| `0xC0` | format | +2 dest string, +6 format, +10 argc, +0xe args | wsprintf into a string variable. |
| `0xC2` | text_set | +2 text, +6 number, +10 string, +0x10 u8 format | Sets the string of a type 21 text. |
| `0xC3` | text_set_color | +2 text, +6 colour (flags +10, +11) | Colour index of a type 21 text. |
| `0xC4` | timer_start | +2 id, +6 script, +10 ms, +0x11 u8 repeat | Starts a timer. |
| `0xC6` | volume | +2 u8 mode (0 up, 1 down, 2 set), +3 u8 channel (0 all, 1 CD, 2 MIDI, 3 wave), +4 u8 is var, +5 value (0-127) | Changes a volume. |
| `0xCA` | sin | +2 var, +6 angle | var = Sine(angle). |
| `0xD2` | cd_stop |  | Stops CD audio. |
| `0xD3` | midi_stop | +2 midi | Stops MIDI music. |
| `0xD4` | wave_stop | +2 wave | Stops a sound. |
| `0xD5` | str_cmp | +2 var, +6 string a, +10 string b | var = lstrcmp(a, b). |
| `0xD6` | str_cmpi | +2 var, +6 string a, +10 string b | var = lstrcmpi(a, b). |
| `0xD9` | run_list_item | +2 list, +6 script, +10 var, +0xe u8 run script past end, +0xf u8 advance | Runs statement number var of a type 14 list. |
| `0xDA` | switch_var | +2 value or var, +6 table, +10 default | Switch on a value. |
| `0xDB` | switch | +6 table, +10 default, +0x10 expr | Switch on an expression. |
| `0xDE` | sprite_transfer | +2 from sprite, +6 to sprite, +10 queue, +0xe destroy | Moves one sprite's image to another and starts a queue. |
| `0xDF` | unload | +2 resource (flag +6) | Unloads a resource. |
| `0xE0` | ray_box_exit | +2 var x, +6 var y, +10 x, +0xe y, +0x12 angle, +0x16 box | Where a ray leaves a box. |
| `0xE1` | sprite_is_visible | +2 var, +6 sprite | var = 1 if the sprite is shown. |
| `0xE3` | if | same as 0x5b | If (a second opcode with the same handler). |
| `0xE4` | ini_write | +2 var, +6 key, +10 section, +0xf u8 string | Writes 7THLEVEL.INI. |
| `0xE6` | set_zoom | +2 mode (0-4), +6 x, +10 y | Zoom mode of the sprite engine (SpriteSetZoom). |
