import { showcaseBodies, buildCivilian } from './src/characters/mesh/characters.ts';
import { buildHumanoid } from './src/characters/mesh/assemble.ts';
import { analyseTopology, analyseSkinning, measureSilhouette, silhouetteDistance } from './src/characters/mesh/analysis.ts';

for (const lod of [0, 1, 2] as const) {
  console.log(`\n=== LOD ${lod} ===`);
  for (const recipe of showcaseBodies()) {
    const build = buildHumanoid(recipe.profile, { ...recipe.options, lod });
    const topo = analyseTopology(build.geometry);
    const skin = analyseSkinning(build.geometry, build.rig.bones.length);
    const sil = measureSilhouette(build.geometry);
    console.log(
      `${recipe.name.padEnd(18)} tris=${String(build.stats.triangles).padStart(5)}` +
        ` verts=${String(build.stats.vertices).padStart(5)}` +
        ` comp=${String(topo.components).padStart(3)}` +
        ` euler=[${[...new Set(topo.perComponent.map((c) => c.euler))].sort().join(',')}]` +
        ` hist=${skin.influenceHistogram.join('/')}` +
        ` h=${sil.height.toFixed(3)}(want ${recipe.profile.height})` +
        ` w=${sil.width.toFixed(3)} d=${sil.depth.toFixed(3)}`
    );
  }
}

console.log('\n=== silhouette pair distances (LOD0) ===');
const builds = showcaseBodies().map((r) => ({ name: r.name, sil: measureSilhouette(buildHumanoid(r.profile, r.options).geometry) }));
let worst = Infinity, worstPair = '';
for (let i = 0; i < builds.length; i++)
  for (let j = i + 1; j < builds.length; j++) {
    const d = silhouetteDistance(builds[i]!.sil, builds[j]!.sil);
    if (d < worst) { worst = d; worstPair = `${builds[i]!.name} vs ${builds[j]!.name}`; }
  }
console.log(`min pair distance ${worst.toFixed(4)} (${worstPair})`);

console.log('\n=== body-only footprint (no garments/hair) ===');
const bare = buildHumanoid(showcaseBodies()[0]!.profile, { shape: { muscle: 0.6, belly: 0.04 } });
console.log(`bare LOD0 tris=${bare.stats.triangles} verts=${bare.stats.vertices}`);
for (const lod of [1, 2] as const) {
  const b = buildHumanoid(showcaseBodies()[0]!.profile, { lod, shape: { muscle: 0.6, belly: 0.04 } });
  console.log(`bare LOD${lod} tris=${b.stats.triangles} verts=${b.stats.vertices}`);
}

console.log('\n=== civilians ===');
for (let s = 0; s < 6; s++) {
  const b = buildCivilian(s * 977 + 3, 0);
  console.log(`seed ${s}: ${b.profile.archetype.padEnd(9)} h=${b.profile.height.toFixed(2)} tris=${b.stats.triangles} bulk=${b.profile.bulk.toFixed(2)} muscle=${b.shape.muscle.toFixed(2)} belly=${b.shape.belly.toFixed(2)}`);
}

console.log('\n=== foot contact (LOD0) ===');
for (const recipe of showcaseBodies()) {
  const b = buildHumanoid(recipe.profile, recipe.options);
  const box = b.geometry.boundingBox!;
  console.log(`${recipe.name.padEnd(18)} minY=${box.min.y.toFixed(5)} maxY=${box.max.y.toFixed(4)}`);
}
