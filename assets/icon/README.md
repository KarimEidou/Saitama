# App icon master

`icon-source.png` — 1024x1024, opaque, **full-bleed**. It is the only tracked
image outside `docs/screenshots/`, and `scripts/guard-no-binaries.ts` carries a
narrow exemption for this directory so it can stay here.

## Why it is committed

Everything else binary in this repo is reproducible: `assets/source/` re-fetches
and `assets/generated/` re-derives from the manifest via `npm run assets`. This
is artwork. Nothing regenerates it, so keeping it out of git would not move it
somewhere safer — it would lose it.

## Why it has no rounded corners

`scripts/make-icons.ts` resizes this file into every size `public/icons/` needs.
iOS and Android each apply their own mask to whatever they are given, and the
manifest declares `purpose: "any"`, so the master has to be a plain square that
bleeds to all four edges. Corners baked into the art would sit inside the
platform's mask and read as a dark ring around the icon.

The supplied artwork arrived as a 1254px app-tile mock — the painting inside a
rounded rect flush with the image border, pure black outside it. The master is a
centred 1082x1082 crop of that, scaled to 1024: 86px in on every side, measured
to clear the frame's hairline where it crosses each corner diagonal at ~76-81px.
Re-crop from the original if the art is ever replaced — do not simply un-round
this one.
