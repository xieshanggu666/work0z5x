"use strict";

function baselineLoad() {
  const out = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) out[h] = 0.12 + (h % 5 === 0 ? 0.08 : 0.02);
  for (let h = 18; h < 24; h++) out[h] += 0.09;
  out[7] += 0.5;
  out[8] += 0.6;
  out[18] += 0.7;
  out[19] += 0.6;
  out[12] += 0.3;
  return out;
}

const SHIFTABLE = [
  { id: "washer", name: "洗衣机", power: 1.2, hours: 1, window: [9, 20] },
  { id: "heater", name: "热水器", power: 2.0, hours: 2, window: [0, 24] },
  { id: "dish", name: "洗碗机", power: 1.0, hours: 1, window: [12, 22] },
  { id: "ev", name: "电动车", power: 3.3, hours: 3, window: [21, 7] },
];

function inWindow(start, win) {
  const a = win[0];
  const b = win[1];
  if (a <= b) return start >= a && start < b;
  return start >= a || start < b;
}

function costAt(load, solar, price, feed) {
  const gridIn = Math.max(0, load - solar);
  const exp = Math.max(0, solar - load);
  return price * gridIn - feed * exp;
}

function scheduleShiftable(base, solar, price, feed, shiftables, priceEff) {
  // priceEff 为需求响应时段的"调度信号价"（峰段加价/谷段减价），仅影响家电的
  // 起始时隙选择；物理账单仍按真实分时价 price 结算。缺省即等价于 price。
  const sig = priceEff || price;
  const load = base.slice();
  const plan = [];
  for (const s of shiftables) {
    let bestStart = -1;
    let bestCost = Infinity;
    for (let st = 0; st < 24; st++) {
      if (!inWindow(st, s.window)) continue;
      let delta = 0;
      for (let k = 0; k < s.hours; k++) {
        const h = (st + k) % 24;
        const before = costAt(load[h], solar[h], sig[h], feed);
        const after = costAt(load[h] + s.power, solar[h], sig[h], feed);
        delta += after - before;
      }
      if (delta < bestCost - 1e-12) {
        bestCost = delta;
        bestStart = st;
      }
    }
    if (bestStart >= 0) {
      for (let k = 0; k < s.hours; k++) load[(bestStart + k) % 24] += s.power;
      plan.push({ id: s.id, name: s.name, start: bestStart, hours: s.hours, window: s.window });
    }
  }
  return { load, plan };
}

module.exports = { baselineLoad, SHIFTABLE, scheduleShiftable };
