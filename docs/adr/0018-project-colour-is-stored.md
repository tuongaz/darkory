# A Project's colour is stored with it, not derived from its key

A Project carries `color`, an index 0–11 into twelve hues around the colour wheel, 30° apart (0 red … 11 pink). The server stores it (`projects.color`, migration 0005) and gives it in every Project; an admin names it on create (`POST /v1/projects`, `darkory project create --color`) or changes it (`PATCH /v1/projects/{project}`, `project set --color`, the swatches in Settings › a Project › General), each recorded in `project.created` / `project.changed`. The web app draws the hue it names (`lib/projectHue.ts`), at the lightness and strength the theme sets (`--mark-l`, `--mark-c`), so the hue is the same in light and dark.

A Project created without one takes the hue farthest round the wheel from those its Organisation's Projects have, the lowest index on a tie; past twelve, of the hues the fewest Projects have, the one farthest from those more have (`core.pickProjectColor`). From none that gives the first twelve 0 6 3 9 1 2 4 5 7 8 10 11, each its own, and the thirteenth 0 again. Migration 0005 gave the Projects already in a database those colours in the order they were created, per Organisation, so the owner's Install has distinct colours without anyone choosing.

We chose this because a Project should keep its colour and no two of a small Organisation's should share one. The mark had been a hash of the key into the five chart tokens: the tokens change hue between themes and are three oranges in light, and a hash into twelve hues still puts two of four Projects on one hue about 43% of the time, which is the defect the owner saw (Big, Sample and Software alike). Only the Organisation knows which hues are taken, so only a stored value assigned with that knowledge can keep them apart, and it lets an admin choose.

Decided on 2026-10-09 by the lead, after the hashed palette (wl-polish 1f2f52d) was judged a smaller change than the right model.

## Considered Options

- **Hash the key into twelve hues.** No model change, but collisions are likely with few Projects and cannot be resolved.
- **Assign by position in the viewer's list of Projects.** Distinct for one viewer, but a Member who is not an admin sees only their Projects, so the same Project would show different colours to different people, and adding a Project would recolour others.
- **Store a free colour (`#rrggbb`), as a Label does.** A mark sits on text in both themes; a fixed set of hues at theme-set lightness reads in both, which an arbitrary colour does not.
