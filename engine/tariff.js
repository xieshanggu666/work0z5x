"use strict";

const DEFAULT_TOU = [
  { start: 8, end: 11, price: 1.02, label: "峰" },
  { start: 18, end: 22, price: 1.02, label: "峰" },
  { start: 6, end: 8, price: 0.63, label: "平" },
  { start: 11, end: 18, price: 0.63, label: "平" },
  { start: 22, end: 24, price: 0.63, label: "平" },
  { start: 0, end: 6, price: 0.32, label: "谷" },
];

const DEFAULT_TIER = [
  { limit: 200, surcharge: 0 },
  { limit: 400, surcharge: 0.05 },
  { limit: Infinity, surcharge: 0.2 },
];

function touPrice(hour, tou) {
  const table = tou || DEFAULT_TOU;
  for (const seg of table) {
    if (hour >= seg.start && hour < seg.end) return seg.price;
  }
  return 0.6;
}

function touLabel(hour, tou) {
  const table = tou || DEFAULT_TOU;
  for (const seg of table) {
    if (hour >= seg.start && hour < seg.end) return seg.label;
  }
  return "—";
}

function tierSurcharge(monthKwh, tier) {
  const t = tier || DEFAULT_TIER;
  let total = 0;
  let remaining = Math.max(0, monthKwh);
  let prev = 0;
  for (const seg of t) {
    const span = Math.min(seg.limit, monthKwh) - prev;
    if (span > 0) total += span * seg.surcharge;
    prev = seg.limit;
    if (monthKwh <= seg.limit) break;
  }
  return total;
}

function hourlyPrices(tou) {
  const out = [];
  for (let h = 0; h < 24; h++) out.push(touPrice(h, tou));
  return out;
}

module.exports = { DEFAULT_TOU, DEFAULT_TIER, touPrice, touLabel, tierSurcharge, hourlyPrices };
