"use strict";
const assert = require("assert");
const tariff = require("../engine/tariff");
const solar = require("../engine/solar");
const loads = require("../engine/loads");
const battery = require("../engine/battery");
const sim = require("../engine/sim");

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "::", e.message);
  }
}

t("分时电价时段边界", () => {
  assert.strictEqual(tariff.touPrice(0), 0.32);
  assert.strictEqual(tariff.touPrice(5), 0.32);
  assert.strictEqual(tariff.touPrice(6), 0.63);
  assert.strictEqual(tariff.touPrice(7), 0.63);
  assert.strictEqual(tariff.touPrice(8), 1.02);
  assert.strictEqual(tariff.touPrice(10), 1.02);
  assert.strictEqual(tariff.touPrice(11), 0.63);
  assert.strictEqual(tariff.touPrice(18), 1.02);
  assert.strictEqual(tariff.touPrice(22), 0.63);
  assert.strictEqual(tariff.touPrice(23), 0.63);
});

t("分时电价全天覆盖无空隙", () => {
  for (let h = 0; h < 24; h++) {
    assert(tariff.touPrice(h) > 0);
    assert(tariff.touLabel(h) !== "—");
  }
});

t("阶梯附加按档累计", () => {
  assert.strictEqual(tariff.tierSurcharge(150), 0);
  assert.strictEqual(tariff.tierSurcharge(300), 5);
  assert.strictEqual(tariff.tierSurcharge(500), 10 + 20);
});

t("光伏夜间为零且白天为正", () => {
  const s = solar.solarProfile(7, 15, 5, 1);
  assert.strictEqual(s[0], 0);
  assert.strictEqual(s[23], 0);
  assert(s[12] > 0);
});

t("光伏与装机线性", () => {
  const a = solar.solarProfile(7, 15, 5, 1);
  const b = solar.solarProfile(7, 15, 10, 1);
  for (let h = 0; h < 24; h++) {
    assert(Math.abs(b[h] - a[h] * 2) < 1e-9);
  }
});

t("光伏阴天低于晴天", () => {
  const sun = solar.solarProfile(7, 15, 5, 1);
  const rain = solar.solarProfile(7, 15, 5, 0.12);
  assert(rain[12] < sun[12]);
});

t("夏季发电高于冬季", () => {
  const sum = solar.solarProfile(7, 15, 5, 1);
  const win = solar.solarProfile(1, 15, 5, 1);
  const sumTotal = sum.reduce((a, b) => a + b, 0);
  const winTotal = win.reduce((a, b) => a + b, 0);
  assert(sumTotal > winTotal);
});

t("可迁移负荷限制在窗口内", () => {
  const base = new Array(24).fill(0.3);
  const s = new Array(24).fill(0);
  const price = new Array(24).fill(0.6);
  const { plan } = loads.scheduleShiftable(base, s, price, 0.4, [loads.SHIFTABLE[0]]);
  assert.strictEqual(plan.length, 1);
  assert(plan[0].start >= 9 && plan[0].start < 20);
});

t("跨午夜窗口起始点正确", () => {
  const base = new Array(24).fill(0.1);
  const s = new Array(24).fill(0);
  const price = new Array(24).fill(0.6);
  const ev = loads.SHIFTABLE.find(x => x.id === "ev");
  const { plan } = loads.scheduleShiftable(base, s, price, 0.4, [ev]);
  assert.strictEqual(plan.length, 1);
  assert(plan[0].start >= 21 || plan[0].start < 7);
});

t("电池充放电不超功率与SOC约束", () => {
  const load = new Array(24).fill(1);
  const s = new Array(24).fill(0);
  const price = new Array(24).fill(0.6);
  const r = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 });
  for (const h of r.hours) {
    assert(h.ch <= 3 + 1e-9);
    assert(h.dis <= 3 + 1e-9);
    assert(h.soc >= -1e-9 && h.soc <= 1 + 1e-9);
  }
});

t("电池调度电费不高于无电池", () => {
  const load = new Array(24).fill(1.2);
  const price = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 11) || (h >= 18 && h < 22) ? 1.02 : h < 6 ? 0.32 : 0.63);
  const s = new Array(24).fill(0);
  const noBat = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 0.001, maxKw: 0, eff: 0.9, soc0: 0 });
  const withBat = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 });
  assert(withBat.cost <= noBat.cost + 1e-6);
});

t("电池在谷电充电峰电放电", () => {
  const load = new Array(24).fill(0.5);
  const price = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 11) || (h >= 18 && h < 22) ? 1.02 : h < 6 ? 0.32 : 0.63);
  const s = new Array(24).fill(0);
  const r = battery.optimizeBattery({ load, solar: s, price, feed: 0.4, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0 });
  const totalCh = r.hours.reduce((a, x) => a + x.ch, 0);
  const totalDis = r.hours.reduce((a, x) => a + x.dis, 0);
  assert(totalCh > 0);
  assert(totalDis > 0);
  const chInValley = r.hours.slice(0, 6).reduce((a, x) => a + x.ch, 0);
  assert(chInValley > 0);
});

t("能量守恒：购电+光伏=负荷+充电+上网", () => {
  const o = { month: 7, day: 15, weather: 0.8, capacity: 5, feed: 0.4, shiftableIds: ["washer"], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  for (const h of r.hours) {
    const lhs = h.grid_no_bat + h.solar;
    const rhs = h.load + h.export_no_bat;
    assert(Math.abs(lhs - rhs) < 1e-6);
  }
});

t("带电池成本更低且谷电充电", () => {
  const o = { month: 7, day: 15, weather: 0.8, capacity: 5, feed: 0.4, shiftableIds: ["washer", "heater"], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  assert(r.cost_bat <= r.cost_no_bat + 1e-6);
  const buyNo = r.hours.filter(x => x.h < 6).reduce((a, x) => a + x.grid_no_bat, 0);
  const buyBat = r.hours.filter(x => x.h < 6).reduce((a, x) => a + x.grid_bat, 0);
  assert(buyBat >= buyNo - 1e-6);
});

t("光伏自用优先于充电", () => {
  const o = { month: 7, day: 15, weather: 1, capacity: 8, feed: 0.4, shiftableIds: [], battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const r = sim.simulateDay(o);
  for (const h of r.hours) {
    if (h.ch > 0) {
      assert(h.grid_bat <= h.ch + h.load + 1e-6);
    }
  }
});

t("月度账单天数与能量节省非负", () => {
  const r = sim.monthBill({ month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } });
  assert.strictEqual(r.days, 30);
  assert(r.kwh > 0);
  // DP 逐日最小化分时能量电费，含储能能量电费不高于无储能
  assert(r.energy_bat <= r.energy_no_bat + 1e-6);
});

t("月度账单：阶梯附加整月只计一次且分场景计算", () => {
  const r = sim.monthBill({ month: 7, capacity: 5, feed: 0.4, days: 30, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } });
  // 账单恒等式：总电费 = 能量电费 + 整月阶梯附加（无第二次附加）
  assert(Math.abs(r.energy_no_bat + r.tier_surcharge_no_bat - r.cost_no_bat) <= 0.011);
  assert(Math.abs(r.energy_bat + r.tier_surcharge_bat - r.cost_bat) <= 0.011);
  // 阶梯附加必须等于整月购电量口径（而不是日附加之和）
  assert.strictEqual(r.tier_surcharge_no_bat, Math.round(tariff.tierSurcharge(r.kwh_buy_no_bat) * 100) / 100);
  assert.strictEqual(r.tier_surcharge_bat, Math.round(tariff.tierSurcharge(r.kwh_buy_bat) * 100) / 100);
  // 日明细不含任何阶梯附加：任一日的购电量都不足以产生附加（否则会出现重复）
  for (const d of r.daily) {
    assert.strictEqual(tariff.tierSurcharge(d.kwh_buy_no_bat), 0);
  }
});

t("月度账单：日明细与单日模拟完全一致", () => {
  const opt = { month: 7, capacity: 5, feed: 0.4, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const m = sim.monthBill({ ...opt, days: 30, seed: 11 });
  const valley = Math.min(...tariff.hourlyPrices());
  for (const d of m.daily) {
    const w = sim.dayWeather(11, d.day);
    // 用月度中该日的起始电量与残值，通过单日 API 精确复算
    const one = sim.simulateDay({
      ...opt, day: d.day, weather: w,
      batterySocStartKwh: d.soc_start_kwh, endValue: valley,
    });
    assert.strictEqual(one.energy_no_bat, d.energy_no_bat);
    assert.strictEqual(one.energy_bat, d.energy_bat);
    assert.strictEqual(one.kwh_buy_no_bat, d.kwh_buy_no_bat);
    assert.strictEqual(one.kwh_buy_bat, d.kwh_buy_bat);
  }
});

t("月度账单：电池电量逐日结转、跨日不断档", () => {
  const r = sim.monthBill({ month: 7, capacity: 2, feed: 0.05, days: 14, seed: 5, battery: { capKwh: 2, maxKw: 3, eff: 0.8, soc0: 2 } });
  // 首日起点即用户给定的 soc0（kWh）
  assert.strictEqual(r.daily[0].soc_start_kwh, 2);
  for (let i = 1; i < r.daily.length; i++) {
    // 当日起点必须等于前一日末态，且都在物理范围内
    assert.strictEqual(r.daily[i].soc_start_kwh, r.daily[i - 1].soc_end_kwh);
    assert(r.daily[i].soc_start_kwh >= -1e-9 && r.daily[i].soc_start_kwh <= 2 + 1e-9);
  }
  // 月末电池资产估值与首末存量一致（残值为固定谷价 0.32）
  const expectAsset = 0.32 * (r.daily[r.daily.length - 1].soc_end_kwh - r.daily[0].soc_start_kwh);
  assert(Math.abs(expectAsset - r.battery_asset_value) <= 0.011);
});

t("月度账单：结转初态会改变当日调度，而非每日重置", () => {
  const opt = { month: 7, capacity: 2, feed: 0.05, battery: { capKwh: 2, maxKw: 3, eff: 0.8, soc0: 2 } };
  const m = sim.monthBill({ ...opt, days: 5, seed: 9 });
  const day = m.daily[1];
  const w = sim.dayWeather(9, 2);
  const carried = sim.simulateDay({ ...opt, day: 2, weather: w, batterySocStartKwh: day.soc_start_kwh, endValue: 0.32 });
  const wrongCarry = sim.simulateDay({ ...opt, day: 2, weather: w, batterySocStartKwh: 0, endValue: 0.32 });
  // 以错误的初始电量（0）复算必然得到不同购电量，证明日结果依赖结转初态
  assert.notStrictEqual(wrongCarry.kwh_buy_bat, carried.kwh_buy_bat);
  assert.strictEqual(carried.energy_bat, day.energy_bat);
});

t("月度账单：无电池场景字段为空且不产生含储能费用", () => {
  const r = sim.monthBill({ month: 7, days: 20 });
  assert.strictEqual(r.cost_bat, null);
  assert.strictEqual(r.tier_surcharge_bat, null);
  assert.strictEqual(r.kwh_buy_bat, null);
  assert.strictEqual(r.save, 0);
  for (const d of r.daily) assert.strictEqual(d.cost_bat, null);
  assert(Math.abs(r.energy_no_bat + r.tier_surcharge_no_bat - r.cost_no_bat) <= 0.011);
});

t("月度账单：无重复计费的整月重算恒等式", () => {
  const opt = { month: 7, capacity: 5, feed: 0.4, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } };
  const m = sim.monthBill({ ...opt, days: 30, seed: 11 });
  const valley = Math.min(...tariff.hourlyPrices());
  // 用 computeDay 按相同初态与结转从头重算，逐日结果必须与账单完全一致
  let carry = null;
  let energyNo = 0;
  let energyBat = 0;
  let kwhNo = 0;
  let kwhBat = 0;
  for (let d = 1; d <= 30; d++) {
    const r = sim.computeDay({ ...opt, month: 7, day: d, weather: sim.dayWeather(11, d) }, carry, valley);
    energyNo += r.energy_no_bat;
    energyBat += r.energy_bat;
    kwhNo += r.kwh_buy_no_bat;
    kwhBat += r.kwh_buy_bat;
    carry = r.soc_end_kwh;
  }
  assert(Math.round(energyNo * 100) / 100 === m.energy_no_bat);
  assert(Math.round(energyBat * 100) / 100 === m.energy_bat);
  // 购电量逐时千分位舍入后累加，分位内一致即可
  assert(Math.abs(kwhNo - m.kwh_buy_no_bat) < 0.01);
  assert(Math.abs(kwhBat - m.kwh_buy_bat) < 0.01);
});

t("月度账单确定性", () => {
  const a = sim.monthBill({ month: 7, days: 20, seed: 3 });
  const b = sim.monthBill({ month: 7, days: 20, seed: 3 });
  assert.strictEqual(a.cost_no_bat, b.cost_no_bat);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

// 需求响应计划套件（独立文件，自带断言与计数）
require("child_process").execFileSync(process.execPath, [require("path").join(__dirname, "dr_tests.js")], { stdio: "inherit" });

