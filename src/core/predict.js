'use strict';
/**
 * Predicts how long a prompt will run and how many tokens it will burn, from the user's own history.
 *
 * Model: ln(y) = a + b·ln(chars) + c·ln(wording hint) + d·ln(previous run) — a small ridge regression with
 * non-negative, bounded coefficients so it can never extrapolate wildly. Falls back to shrunk medians with
 * little data and to sensible priors on day one. Always returns a range plus a confidence label.
 */
const { complexityHint } = require('./tokens');

const Z = { p25: -0.6745, p50: 0, p75: 0.6745, p90: 1.2816 };
const PRIORS = { duration: { mu: Math.log(110), sigma: 1.0 }, tokens: { mu: Math.log(60000), sigma: 1.1 }, headline: { mu: Math.log(25000), sigma: 1.1 } };
const MIN_REGRESSION = 14;
const SIGMA_INFLATE = 1.12;   // in-sample residuals understate out-of-sample error (measured by backtest on real logs)
const LIMITS = [[0, 0.6], [0, 2], [0, 0.8]];     // chars, hint, previous-run coefficients
const PREV_WINDOW_MS = 2 * 3600e3;

const ln = (v) => Math.log(v);
const features = (chars, hint, prev, prevMean) => [ln(chars + 20), ln(Math.max(0.3, hint || 1)), prev > 0 ? ln(prev + 5) : prevMean];

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Solve A·x = b for a small dense system (Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
  return x;
}

const sd = (arr, c) => Math.sqrt(arr.reduce((a, v) => a + (v - c) ** 2, 0) / Math.max(1, arr.length - 1));

/** Fit one target (duration | tokens). Returns {mu(x), sigma, n, method}. */
function fit(samples, field, prior) {
  const rows = samples.filter((s) => s[field] > 0 && s.chars >= 0).slice(-300);
  const n = rows.length;
  if (n === 0) return { mu: () => prior.mu, sigma: prior.sigma, n, method: 'prior' };
  const withPrev = rows.filter((s) => s.prev > 0);
  const prevMean = withPrev.length ? withPrev.reduce((a, s) => a + ln(s.prev + 5), 0) / withPrev.length : ln(35);
  const X = rows.map((s) => features(s.chars, s.hint, s.prev, prevMean)), y = rows.map((s) => ln(s[field]));
  const my = y.reduce((a, v) => a + v, 0) / n;
  const mx = [0, 1, 2].map((j) => X.reduce((a, r) => a + r[j], 0) / n);

  if (n >= MIN_REGRESSION) {
    const Xc = X.map((r) => r.map((v, j) => v - mx[j])), yc = y.map((v) => v - my);
    const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Xc.reduce((a, r) => a + r[i] * r[j], 0) + (i === j ? 2 : 0))); // ridge
    const b = [0, 1, 2].map((i) => Xc.reduce((a, r, k) => a + r[i] * yc[k], 0));
    const raw = solve(A, b);
    if (raw) {
      const coef = raw.map((v, j) => Math.max(LIMITS[j][0], Math.min(LIMITS[j][1], v)));
      const a = my - coef.reduce((s, c, j) => s + c * mx[j], 0);
      const res = X.map((r, k) => y[k] - (a + coef.reduce((s, c, j) => s + c * r[j], 0)));
      return { mu: (x) => a + coef.reduce((s, c, j) => s + c * x[j], 0), sigma: Math.max(0.35, sd(res, 0)), n, method: 'regression', coef, prevMean, usesHint: coef[1] > 0.02 };
    }
  }
  // Few samples: blend the empirical median with the prior so one odd turn can't dominate.
  const w = n / (n + 4);
  const sigma = n >= 3 ? Math.max(0.45, sd(y, my)) : prior.sigma;
  const mu0 = w * my + (1 - w) * prior.mu;
  return { mu: () => mu0, sigma: w * sigma + (1 - w) * prior.sigma, n, method: n >= 3 ? 'median' : 'prior', prevMean, usesHint: false };
}

function bands(f, x, mult) {
  const base = f.mu(x) + ln(mult);
  const out = {};
  for (const [k, z] of Object.entries(Z)) out[k] = Math.exp(base + z * f.sigma * SIGMA_INFLATE);
  return out;
}

/**
 * @param {Array<{chars:number,hint?:number,prev?:number,duration:number,tokens:number}>} samples  seconds / weighted tokens
 * @param {string} text  the prompt (may be empty if only `chars` is known)
 * @param {{prev?:number}} [ctx] prev = seconds the user's most recent run took (0 if none in the last 2 h)
 */
function predict(samples, text, chars = (text || '').length, ctx = {}) {
  const n = samples.length;
  const hint = ctx.hint || complexityHint(text || '');
  const prev = ctx.prev || 0;
  const fd = fit(samples, 'duration', PRIORS.duration);
  const ft = fit(samples, 'tokens', PRIORS.tokens);
  const fh = fit(samples, 'headline', PRIORS.headline);
  const damp = n >= 30 ? 0.5 : n >= 8 ? 0.75 : 1;
  const prior = Math.pow(hint, damp);                        // wording prior, used only where the model didn't learn it
  const x = (f) => features(chars, hint, prev, f.prevMean || ln(35));
  const multD = fd.usesHint ? 1 : prior, multT = ft.usesHint ? 1 : prior, multH = fh.usesHint ? 1 : prior;
  const confidence = n < 8 ? 'low' : n < 30 ? 'medium' : 'high';
  return { duration: bands(fd, x(fd), multD), tokens: bands(ft, x(ft), multT), headline: bands(fh, x(fh), multH), n, confidence, method: fd.method, hint: prior };
}

/**
 * "Should I hit enter?" — compares the predicted finish time with the user's finish-by time.
 * @returns {{verdict:'go'|'tight'|'stop'|'over', sendBy:number|null, etaP50:number, etaP90:number, marginMin:number}}
 */
function planVerdict(pred, now, finishBy, bufferMin = 10) {
  const buf = bufferMin * 60000;
  const etaP50 = now + pred.duration.p50 * 1000;
  const etaP90 = now + pred.duration.p90 * 1000;
  const sendBy = finishBy - buf - pred.duration.p90 * 1000;
  let verdict;
  if (now + buf >= finishBy) verdict = 'over';
  else if (etaP90 + buf <= finishBy) verdict = 'go';
  else if (etaP50 + buf <= finishBy) verdict = 'tight';
  else verdict = 'stop';
  return { verdict, sendBy, etaP50, etaP90, marginMin: Math.round((finishBy - etaP90) / 60000) };
}

/** Today's finish-by timestamp from "HH:MM" in local time. */
function finishTimestamp(hhmm, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  const d = new Date(now);
  d.setHours(m ? Math.min(23, +m[1]) : 18, m ? Math.min(59, +m[2]) : 30, 0, 0);
  return d.getTime();
}

module.exports = { predict, planVerdict, finishTimestamp, quantile, PREV_WINDOW_MS };
