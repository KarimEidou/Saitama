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

The supplied artwork arrived as a 960x960 JPEG app-tile mock — the painting
inside a rounded rect, a near-white surround outside it, and a thin
neutral-grey stroke on the rect itself. (An earlier master came from a 1254px
mock whose surround was pure BLACK. Assume nothing about the next one; measure
it.) Fitting the rect against the left and top edges puts its outer boundary 3px
in from the image border at a corner radius of 168.5px, rms 0.85px — so the
surround gives out along each corner diagonal at 52px, which is the 52.4px that
radius predicts. The stroke takes the next few pixels: the first true artwork
sits at 58px on the top two corners and 60px on the bottom two, the rect sitting
a pixel high in its frame. The master is a centred 828x828 crop — 66px in on
every side, clearing the worst corner by 6px, which is more than the stroke's
entire thickness — scaled to 1024.

Two traps in taking that measurement. The surround is BRIGHT here, so a "dark
means frame" test inverts. And brightness alone cannot resolve the top-right
corner, where the cream light beam meets the frame at the same luminance as the
grey stroke; what separates them is hue — the stroke is neutral-to-blue
(`b >= r`), the beam is warm (`r > b`). The check that actually settles it runs
on the OUTPUT: this painting owns no bright neutral pixels, so a scan of the
finished master turning up zero near-white and zero bright-neutral pixels means
no frame survived anywhere, corners included.

That crop is 828px of real artwork enlarged into a 1024 master, the source being
smaller than the master this pipeline asks for. It costs less than it sounds:
the largest file `make-icons.ts` emits is 512, so every shipped icon is still a
downscale from more pixels than it needs, and routing 828 -> 1024 -> 512 rather
than 828 -> 512 measures at 2/255 mean error and 2.6% softer edges at 512, and
0.8/255 with no measurable softening at 180 and 192. Keep the master a PNG even
when the source is a JPEG: re-encoding would bake this one's artefacts in
permanently, and an alpha channel renders black on iOS.

Re-measure from the original if the art is ever replaced — its surround colour,
its radius and its stroke will not be these. Do not simply un-round this one.
