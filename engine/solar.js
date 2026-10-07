"use strict";

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function dayOfYear(month, day) {
  let t = 0;
  for (let i = 0; i < month - 1; i++) t += MONTH_DAYS[i];
  return t + day;
}

function solarProfile(month, day, capacity, weather) {
  const doy = dayOfYear(month, day);
  const season = Math.sin((2 * Math.PI * (doy - 81)) / 365);
  const dayLen = 12 + 3.5 * season;
  const w = weather == null ? 1 : Math.max(0, Math.min(1, weather));
  const peak = Math.max(0, capacity) * w * (1 + 0.18 * season);
  const out = new Array(24).fill(0);
  const rise = 12 - dayLen / 2;
  for (let h = 0; h < 24; h++) {
    const t = (h - rise) / dayLen;
    if (t <= 0 || t >= 1) continue;
    out[h] = Math.max(0, peak * Math.pow(Math.sin(Math.PI * t), 1.15));
  }
  return out;
}

module.exports = { solarProfile, dayOfYear };
