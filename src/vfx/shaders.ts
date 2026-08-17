/**
 * THE THREE VFX SHADER PROGRAMS
 *
 * Every effect in the game is drawn by one of these. That is the whole budget:
 * the renderer has five spare shader programs on the tier that ships to
 * phones, and a compile stall on Android is a visible hitch because
 * `KHR_parallel_shader_compile` is unavailable here.
 *
 *   SPRITE      instanced quads. Dust, clouds, sparks, flashes, embers,
 *               debris streaks, the shockwave dust front AND the persistent
 *               ground cracks. The crack decals are a SECOND MATERIAL built
 *               from this same source — blend state, depth state and bound
 *               textures are GL state, not program identity, so that costs
 *               one draw call and zero programs.
 *   SHOCKWAVE   instanced arc shells. Ground skirt and axial air cone.
 *   SPEEDLINES  one full-screen triangle pair.
 *
 * ── PREMULTIPLIED ALPHA ────────────────────────────────────────────────────
 * All three write premultiplied colour and blend `ONE, ONE_MINUS_SRC_ALPHA`.
 * A fragment can therefore be additive (bright rgb, ~0 alpha), a darkening
 * (near-black rgb, high alpha) or ordinary alpha compositing, per pixel. That
 * is what lets the white-hot pressure edge and the dark compression band
 * behind it live in one draw call — and it is what makes the shockwave read
 * as bending the air rather than as a glowing decal.
 *
 * ── OUTPUT CHUNKS ARE NOT OPTIONAL ─────────────────────────────────────────
 * Every fragment shader ends with `<tonemapping_fragment>` and
 * `<colorspace_fragment>`. three only injects those functions, it never
 * applies them to a ShaderMaterial for you. Without them the LOW tier — which
 * renders straight to the default framebuffer — would show un-tone-mapped,
 * un-encoded VFX sitting on top of a correctly graded scene. On MEDIUM/HIGH
 * both chunks compile to no-ops because the draw goes into the composer's
 * linear target, so the same source is correct on all three tiers.
 */

/* -------------------------------------------------------------------------- */
/* Sprite                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Instanced quad vertex shader.
 *
 * Four orientation modes share one program, selected by a per-INSTANCE
 * attribute rather than a `#define`, because a define would fork the program
 * and the budget has no room for four sprite programs.
 */
export const SPRITE_VERTEX = /* glsl */ `
attribute vec4 iPosSize;   // xyz local position, w size in metres
attribute vec4 iColor;     // rgb linear tint, a alpha
attribute vec4 iParams;    // x roll, y atlas tile, z additiveness, w erosion
attribute vec4 iMotion;    // xyz velocity (or surface normal), w stretch/aspect
attribute vec4 iShade;     // x lit amount, y unused, z mode, w style

uniform float uAtlasTiles;
uniform float uFogDensity;

varying vec2 vUv;
varying vec4 vColor;
varying vec4 vExtra;       // additiveness, erosion, lit, style
varying vec2 vTileOffset;
varying vec2 vSphere;      // un-rolled quad coords, for the fake volume normal
varying float vFog;

void main() {
  float mode = iShade.z;
  float size = iPosSize.w;
  vec2 corner = position.xy;

  vUv = uv;
  vColor = iColor;
  vExtra = vec4(iParams.z, iParams.w, iShade.x, iShade.w);
  vSphere = corner * 2.0;

  float tile = iParams.y;
  float col = mod(tile, uAtlasTiles);
  float row = floor(tile / uAtlasTiles);
  vTileOffset = vec2(col, row) / uAtlasTiles;

  float s = sin(iParams.x);
  float c = cos(iParams.x);

  vec4 mv;
  if (mode < 0.5) {
    /* Camera-facing billboard with a roll. */
    mv = modelViewMatrix * vec4(iPosSize.xyz, 1.0);
    mv.xy += vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * size;
  } else if (mode < 1.5) {
    /* Stretched along screen-space velocity. uv.y runs along the streak, which
       is why the atlas streak tile is authored vertically. */
    mv = modelViewMatrix * vec4(iPosSize.xyz, 1.0);
    vec3 velView = (viewMatrix * vec4(iMotion.xyz, 0.0)).xyz;
    float speed = length(iMotion.xyz);
    float projected = length(velView.xy);
    vec2 along = projected > 1e-4 ? velView.xy / projected : vec2(0.0, 1.0);
    vec2 across = vec2(-along.y, along.x);
    float length2 = size + iMotion.w * speed;
    mv.xy += along * (corner.y * length2) + across * (corner.x * size);
  } else if (mode < 2.5) {
    /* Billboards about the object's +Y only: dust columns and clouds must not
       tip over when the camera pitches down over a crater. Done in VIEW space
       so it stays correct under any model matrix. */
    mv = modelViewMatrix * vec4(iPosSize.xyz, 1.0);
    vec3 upView = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 toCamera = normalize(-mv.xyz);
    vec3 right = cross(upView, toCamera);
    float rightLength = length(right);
    right = rightLength > 1e-4 ? right / rightLength : vec3(1.0, 0.0, 0.0);
    mv.xyz += right * (corner.x * size) + upView * (corner.y * size);
  } else {
    /* Surface-oriented quad — the ground cracks. The tangent frame is built in
       LOCAL space and only then transformed: building it in view space would
       make the decal spin as the camera orbits. */
    vec3 n = normalize(iMotion.xyz);
    vec3 ref = abs(n.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 tangent = normalize(cross(ref, n));
    vec3 bitangent = cross(n, tangent);
    vec3 axisX = tangent * c + bitangent * s;
    vec3 axisY = -tangent * s + bitangent * c;
    vec3 local = iPosSize.xyz + axisX * (corner.x * size) +
                 axisY * (corner.y * size * iMotion.w);
    mv = modelViewMatrix * vec4(local, 1.0);
  }

  float depth = -mv.z;
  float fogArgument = uFogDensity * depth;
  vFog = 1.0 - exp(-fogArgument * fogArgument);

  gl_Position = projectionMatrix * mv;
}
`;

/** Instanced quad fragment shader. */
export const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uAtlasTiles;
uniform vec3 uSunView;      // sun TRAVEL direction, in view space
uniform vec3 uSunColor;
uniform vec3 uAmbientColor;
uniform vec3 uFogColor;
uniform vec3 uDecalRim;
uniform float uIntensity;

varying vec2 vUv;
varying vec4 vColor;
varying vec4 vExtra;
varying vec2 vTileOffset;
varying vec2 vSphere;
varying float vFog;

void main() {
  vec2 atlasUv = vTileOffset + vUv / uAtlasTiles;
  vec4 tex = texture2D(uAtlas, atlasUv);

  /* Erosion, not fading. Raising a threshold against the density channel eats
     the wispy edges first, so a puff DISSOLVES. Uniformly fading its opacity
     instead is the single most common reason particle smoke reads as a decal
     sliding out of existence. */
  float erosion = vExtra.y;
  float coverage = tex.a * smoothstep(erosion, erosion + 0.30, tex.r * 0.72 + 0.28);
  float alpha = coverage * vColor.a * uIntensity;
  if (alpha < 0.004) discard;

  vec3 rgb = vColor.rgb;

  if (vExtra.w > 0.5) {
    /* Ground crack. R is the fracture core, G the lip of displaced concrete.
       Kept outside the quality guard: it is three instructions, and a flat
       grey smear would be worse on LOW than anywhere else. */
    float lip = clamp(tex.g * 1.25 - tex.r * 0.85, 0.0, 1.0);
    rgb = mix(vColor.rgb * (0.20 + 0.30 * (1.0 - tex.r)), uDecalRim, lip * 0.85);
  }
#if VFX_QUALITY > 0
  else if (vExtra.z > 0.001) {
    /* Fake volume. The quad is shaded as if it were a sphere: this is what
       turns a hundred grey discs into a body of dust with a lit side. */
    float radiusSq = min(1.0, dot(vSphere, vSphere));
    float nz = sqrt(1.0 - radiusSq);
    vec3 n = vec3(vSphere, nz);
    float ndl = max(0.0, dot(n, -uSunView));
    /* Wrapped diffuse: dust forward-scatters, so the terminator is soft and
       the shadowed side still carries bounce. */
    vec3 shade = uAmbientColor + uSunColor * (ndl * 0.72 + 0.28);
    shade *= mix(1.0, tex.g, 0.45);
    float rim = tex.b * pow(1.0 - nz, 1.6) * clamp(0.7 - dot(n, -uSunView) * 0.5, 0.0, 1.2);
    rgb = mix(rgb, rgb * shade + uSunColor * rim * 0.45, vExtra.z);
  }
#endif

  /* Fog. An ADDITIVE fragment must fade toward black rather than toward the
     fog colour, or a distant spark gets brighter the further away it is. */
  rgb = mix(rgb, uFogColor * (1.0 - vExtra.x), vFog);

  gl_FragColor = vec4(rgb * alpha, alpha * (1.0 - vExtra.x));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* Shockwave                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Arc-shell vertex shader.
 *
 * The geometry is a plain (u, v) grid; the shell's actual shape is computed
 * here from per-instance parameters. One grid therefore serves a 22-degree
 * punch cone at 40 metres and a full 360-degree ring at 180 metres, with no
 * geometry rebuild and no second program.
 *
 *   u  0..1 across the arc (or around the cone's revolution)
 *   v  0..1 across the wave's thickness, 1 at the leading edge
 */
export const SHOCKWAVE_VERTEX = /* glsl */ `
attribute vec4 iOrigin;   // xyz origin, w half-angle in radians
attribute vec4 iAxis;     // xyz unit propagation direction, w current radius
attribute vec4 iShape;    // x thickness, y life 0..1, z intensity, w loft
attribute vec4 iStyle;    // rgb tint, w seed
attribute vec4 iMode;     // x kind (0 ground skirt, 1 axial cone), y edge sharpness,
                          // z chromatic offset, w unused

uniform float uFogDensity;

varying vec2 vGrid;
varying vec4 vShape;
varying vec3 vTint;
varying vec3 vMode;
varying float vArc;
varying float vFog;

void main() {
  float u = position.x;
  float v = position.y;
  float halfAngle = iOrigin.w;
  float radius = iAxis.w;
  float thickness = iShape.x;
  float loft = iShape.w;
  vec3 dir = normalize(iAxis.xyz + vec3(0.0, 0.0, 1e-6));

  vec3 p;
  float heightFade = 1.0;

  if (iMode.x < 0.5) {
    /* GROUND SKIRT — sweeps about world +Y, centred on the horizontal part of
       the punch direction. The trailing edge lofts upward, which is what a
       real ground blast's dust wall does and what stops the ring from reading
       as a flat decal painted on the road. */
    vec3 flat2 = vec3(dir.x, 0.0, dir.z);
    float flatLength = length(flat2);
    flat2 = flatLength > 1e-4 ? flat2 / flatLength : vec3(0.0, 0.0, 1.0);
    float baseAngle = atan(flat2.x, flat2.z);
    float azimuth = baseAngle + (u - 0.5) * 2.0 * halfAngle;
    float ringRadius = max(0.0, radius - (1.0 - v) * thickness);
    float trailing = max(0.0, 1.0 - v);
    /* The exponent decides whether this is a WALL or a stripe painted on the
       road. At 0.7 the bright pressure band — which sits just inside the
       leading edge — is barely off the ground and reads as a lens flare
       skidding along the tarmac. At 0.4 the shell stands up fast behind the
       edge, so the band is a segment of a curtain and the dust behind it has
       something to billow against. */
    float height = loft * pow(trailing, 0.40);
    p = iOrigin.xyz + vec3(sin(azimuth) * ringRadius, height, cos(azimuth) * ringRadius);
    heightFade = 1.0 - 0.45 * pow(trailing, 1.6);
  } else {
    /* AXIAL CONE — a surface of revolution about the punch direction. This is
       the air the fist is pushing, and it is the form that matches the combat
       cone's half-angle exactly. */
    vec3 ref = abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 right = normalize(cross(ref, dir));
    vec3 up = cross(dir, right);
    float phi = u * 6.28318530718;
    float along = max(0.0, radius - (1.0 - v) * thickness);
    float rho = along * tan(min(halfAngle, 1.35)) * (0.30 + 0.70 * v);
    p = iOrigin.xyz + dir * along + (right * cos(phi) + up * sin(phi)) * rho;
  }

  /* The open ends of a cone must dissolve, or the wave has two hard vertical
     walls where the geometry simply stops. A full ring and a closed cone need
     no such fade. */
  float arc = 1.0;
  if (iMode.x < 0.5 && halfAngle < 3.1) {
    arc = smoothstep(0.0, 0.16, u) * smoothstep(0.0, 0.16, 1.0 - u);
  }

  vArc = arc * heightFade;
  vGrid = vec2(u, v);
  vShape = iShape;
  vTint = iStyle.rgb;
  vMode = vec3(iMode.y, iMode.z, iStyle.w);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float fogArgument = uFogDensity * (-mv.z);
  vFog = 1.0 - exp(-fogArgument * fogArgument);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Arc-shell fragment shader — the signature effect.
 *
 * Three overlapping features make the wave read as PRESSURE rather than as a
 * glowing ring:
 *
 *   the pressure edge   a narrow, near-white gaussian band. Deliberately left
 *                       un-textured: breaking it up destroys the "wall" read.
 *   the lens            a thin darkened, colour-fringed sliver AHEAD of the
 *                       edge. Sampling the same band profile at slightly
 *                       offset positions for red and blue gives the fringe a
 *                       real schlieren photograph has, and darkening rather
 *                       than brightening is what sells air being bent — with
 *                       no grab pass, which the draw-call budget forbids.
 *   the body            trailing compression, broken into hashed force lines
 *                       around the arc. Anime speed-line structure, inside the
 *                       wave rather than over the whole screen.
 */
export const SHOCKWAVE_FRAGMENT = /* glsl */ `
uniform vec3 uFogColor;
uniform float uIntensity;

varying vec2 vGrid;
varying vec4 vShape;
varying vec3 vTint;
varying vec3 vMode;
varying float vArc;
varying float vFog;

float vfxHash(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

/* Unit gaussian. Written as a multiply because pow() with a negative base is
   undefined in GLSL and the edge profile is sampled on both sides of zero. */
float vfxGauss(float x) {
  return exp(-x * x);
}

void main() {
  float u = vGrid.x;
  float v = vGrid.y;
  float life = vShape.y;
  float intensity = vShape.z * uIntensity;
  float sharpness = vMode.x;
  float chroma = vMode.y;
  float seed = vMode.z;

  const float EDGE = 0.86;
  float width = 0.055 / max(0.35, sharpness);
  float band = vfxGauss((v - EDGE) / width);
  float bandR = vfxGauss((v - EDGE + chroma) / width);
  float bandB = vfxGauss((v - EDGE - chroma) / width);

  float cell = floor(u * 220.0 + seed * 57.0);
  float streak = 0.45 + 0.55 * smoothstep(0.25, 0.95, vfxHash(cell));

  /* The trailing compression is a BAND behind the edge, not a filled shell.
     Starting it at v = 0 fills the whole cone with haze and the wave stops
     reading as a wave. */
  float body = smoothstep(0.30, 0.80, v) * (1.0 - smoothstep(EDGE - 0.02, EDGE + 0.10, v));
  body *= streak;

  float lens = smoothstep(EDGE + 0.01, 0.97, v) * (1.0 - smoothstep(0.94, 1.0, v));

  float fade = pow(max(0.0, 1.0 - life), 0.65);
  float attenuation = fade * vArc * intensity;

  float alpha = clamp(body * 0.15 + lens * 0.20 + band * 0.36, 0.0, 1.0) * attenuation;

  /* The edge keeps most of its coherence — breaking it up entirely destroys
     the "wall of pressure" read — but a completely smooth arc looks like a
     lens flare, so it takes a quarter of the arc hashing. */
  float edgeStreak = 0.76 + 0.24 * streak;
  band *= edgeStreak;
  bandR *= edgeStreak;
  bandB *= edgeStreak;

  vec3 rgb = vTint * (band * 1.35 + body * 0.09);
#if VFX_QUALITY > 0
  rgb += vec3(bandR, band, bandB) * 0.42 * vTint;
  rgb += vec3(0.0, 0.025, 0.09) * lens;
#else
  rgb += band * 0.42 * vTint;
#endif
  rgb = max(rgb, vec3(0.0)) * attenuation;

  if (alpha < 0.003 && dot(rgb, rgb) < 1e-6) discard;

  rgb = mix(rgb, uFogColor * alpha, vFog);
  gl_FragColor = vec4(rgb, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* Speedlines                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Full-screen quad, positioned directly in clip space.
 *
 * No matrices at all, so the overlay is immune to whatever the camera is
 * doing and needs neither its own scene nor its own camera — it is one mesh
 * in the main scene with depth testing off and a very high render order.
 */
export const SPEEDLINES_VERTEX = /* glsl */ `
varying vec2 vNdc;

void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Radial speedlines — the anime signature, and the cheapest drama in the game.
 *
 * Three superimposed line fields at different densities, each line getting its
 * own width, phase and start radius from a hash of its angular cell. That
 * irregularity is the entire difference between "speedlines" and "a pie
 * chart": evenly spaced identical spokes read as a test pattern.
 */
export const SPEEDLINES_FRAGMENT = /* glsl */ `
uniform vec2 uAspect;
uniform vec2 uFocus;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uInner;
uniform float uDensity;
uniform float uGlow;
uniform float uPhase;

varying vec2 vNdc;

float slHash(float p) {
  return fract(sin(p * 91.3458) * 47453.5453);
}

float slLines(float k, float r, float density, float seed) {
  float x = k * density;
  float cell = floor(x);
  float f = x - cell;
  float h = slHash(cell + seed);
  float h2 = slHash(cell + seed + 37.0);
  /* Most cells carry NO line. Evenly filled spokes read as a test pattern; the
     gaps are what make the field read as motion rather than as a sunburst. */
  if (h < 0.74) return 0.0;
  float halfWidth = 0.010 + 0.075 * h2;
  float centre = 0.5 + (h2 - 0.5) * 0.5;
  float line = smoothstep(halfWidth, halfWidth * 0.15, abs(f - centre));
  float start = uInner * (0.75 + 0.8 * h2);
  float grow = smoothstep(start, start + 0.62, r);
  return line * grow * (0.45 + 0.55 * h2);
}

void main() {
  vec2 d = (vNdc - uFocus) * uAspect;
  float r = length(d);
  float k = atan(d.y, d.x) * 0.15915494 + 0.5;

  float lines = slLines(k, r, uDensity, uPhase);
  lines = max(lines, slLines(k, r, uDensity * 0.43, uPhase + 13.0) * 0.75);
#if VFX_QUALITY > 0
  lines = max(lines, slLines(k, r, uDensity * 2.30, uPhase + 71.0) * 0.42);
#endif

  /* Lines strengthen toward the frame edge so the centre of the shot — the
     thing the player is actually looking at — stays clear. Speedlines that
     cover the subject are not style, they are an occlusion bug. */
  lines *= mix(0.0, 1.0, smoothstep(0.58, 1.45, r));

  float alpha = clamp(lines * uIntensity, 0.0, 1.0);
  if (alpha < 0.004) discard;

  gl_FragColor = vec4(uColor * alpha * uGlow, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
