import { renderProbeSuite } from '../src/audio/__tests__/browser-harness';
const s = await renderProbeSuite();
const n = (v: number | undefined, d = 3) => (v === undefined ? '-' : v.toFixed(d));
const pad = (v: unknown, w: number) => String(v).padEnd(w);
console.log('--- envelope anchor ---');
console.log(JSON.stringify(s.get('dsp.envelopeAnchor').extras));
console.log('\n--- reverb tails ---');
console.log(pad('preset', 14), pad('tailDur', 9), pad('tailRms', 9), pad('decayDb', 9), pad('width', 8), pad('centroid', 9), 'sub<150');
for (const p of ['none','openStreet','arcade','alley','indoor','crater','openField']) {
  const m = s.get(`reverb.tail.${p}`); const e = m.extras;
  console.log(pad(p,14), pad(n(e.tailDuration,2),9), pad(n(e.tailRms,5),9), pad(n(e.decayDb,1),9), pad(n(e.tailWidth,3),8), pad(n(e.tailCentroid,0),9), n(e.tailSub,4));
}
console.log('\n--- environment effect on voices ---');
for (const k of ['punch.normal','collapse.building','ui.tap']) {
  for (const p of ['none','openStreet','crater']) {
    const m = s.get(`env.${k}@${p}`);
    console.log(pad(`${k}@${p}`, 32), 'dur', pad(n(m.activeDuration,2),6), 'peak', pad(n(m.peak),6), 'aRms', pad(n(m.activeRms),6), 'clip', m.clipped);
  }
}
console.log('\n--- jump / dash / leap ---');
for (const k of ['move.jump','move.dash','move.leap','move.footstep','punch.normal']) {
  const m = s.get(k); const r = s.getRaw(k);
  console.log(pad(k,16), 'peak', pad(n(m.peak),6), 'raw', pad(n(r.peak),6), 'aRms', pad(n(m.activeRms),6), 'dur', pad(n(m.activeDuration,2),6), 'subAtk', pad(n(m.sub100Attack),6), 'ons', m.onsetCount, 'hi:', m.highOverTime.map(v=>v.toFixed(2)).join('/'));
}
console.log('\n--- chain rise ---');
for (const c of ['chain.consecutive','chain.barrage']) {
  const e = s.get(c).extras;
  console.log(pad(c,20), 'early', n(e.pitchEarly,1), 'late', n(e.pitchLate,1), 'rise', n(e.pitchRise,3), 'thirds', n(e.third1,1), n(e.third2,1), n(e.third3,1));
}
process.exit(0);
