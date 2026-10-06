// `node scripts/backtest.js` — rolling out-of-sample test of the run-time predictor on YOUR transcript history.
const { Engine } = require('../src/core/engine');
const { Settings } = require('../src/core/settings');
const { predict } = require('../src/core/predict');
(async () => {
  const e = new Engine({ settings: new Settings(require('path').join(require('os').tmpdir(), 'tokkie-backtest.json')) }); await e.start();
  const S = e.store.samples.slice().sort((a, b) => a.start - b.start);
  let n = 0, in50 = 0, below90 = 0, errModel = 0, errBase = 0, errMedian = 0;
  for (let i = 25; i < S.length; i++) {
    const hist = S.slice(0, i), t = S[i];
    const p = predict(hist, '', t.chars, { prev: t.prev });
    // text unknown in samples → use stored hint by faking text-free call: apply hint as multiplier through features
    const p2 = predictWithHint(hist, t);
    const med = hist.map((s) => s.duration).sort((a, b) => a - b)[Math.floor(hist.length / 2)];
    n++; in50 += t.duration >= p2.duration.p25 && t.duration <= p2.duration.p75; below90 += t.duration <= p2.duration.p90;
    errModel += Math.abs(Math.log(t.duration / p2.duration.p50)); errMedian += Math.abs(Math.log(t.duration / med));
  }
  function predictWithHint(hist, t) { return predict(hist, hintText(t.hint), t.chars, { prev: t.prev }); }
  function hintText(h) { // synthesise text whose complexityHint ≈ h
    const heavy = Math.max(0, Math.round((h - 1) / 0.12)); return heavy > 0 ? 'build '.repeat(Math.min(8, heavy)) : (h < 1 ? 'quick typo '.repeat(Math.min(4, Math.round((1 - h) / 0.15))) : '');
  }
  console.log({ n, 'p25-p75 coverage (ideal 50%)': (100 * in50 / n).toFixed(0) + '%', 'under p90 (ideal 90%)': (100 * below90 / n).toFixed(0) + '%',
    'median abs log-error model': (errModel / n).toFixed(2), 'baseline (running median)': (errMedian / n).toFixed(2) });
  process.exit(0);
})();
