# Project skills

Claude Code loads these for every session in this repo.

| Skill | Command | What it does |
|---|---|---|
| `caveman` | `/caveman` | Terse replies: answer first, no filler, code and errors kept exact. `stop caveman` turns it off. |
| `ultracave` | `/ultracave` | Shorter still: fragments, each fact once. |
| `megacave` | `/megacave` | Same idea in Classical Chinese. |

The three `SKILL.md` files are copied unchanged from
[JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) at commit
`9b68f7ed12b05e7efaff18e65c5a3fc2849fd0a4` (plugin 4.0.1), Apache-2.0,
Copyright 2026 Julius Brussee (licence text in `caveman/LICENSE`).
Only the skill text is vendored: not the upstream plugin's Node hooks, CLI
or proxy. Without the hooks, `/caveman status` reports
`(not tracked by this host)`, which is expected.

To update, copy `skills/{caveman,ultracave,megacave}/SKILL.md` from a newer
upstream commit and change the commit above.
