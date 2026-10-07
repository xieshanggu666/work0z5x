"use strict";
const assert = require("assert");
const tariff = require("../engine/tariff");
const solar = require("../engine/solar");
const loads = require("../engine/loads");
const battery = require("../engine/battery");
const sim = require("../engine/sim");
const dr = require("../engine/dr");

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

// ============================= 需求响应 =============================

const DR_HOUSEHOLD = {
  capacity: 5, feed: 0.4,
  shiftableIds: ["dish", "washer", "heater", "ev"],
  battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 },
};

t("DR 信号价：削峰加价、填谷压价，非窗口时段不变", () => {
  const prices = tariff.hourlyPrices();
  const peak = dr.signalPrices(prices, dr.normalizeEvent({ type: "peak", start: 18, end: 21, incentive: 0.8 }));
  assert.strictEqual(peak[18], 1.02 + 0.8);
  assert.strictEqual(peak[21], prices[21]); // 左闭右开
  assert.strictEqual(peak[0], prices[0]);
  const fill = dr.signalPrices(prices, dr.normalizeEvent({ type: "fill", start: 0, end: 6, incentive: 0.3 }));
  assert.strictEqual(fill[0], 0.32 - 0.3);
  assert.strictEqual(fill[6], prices[6]);
});

t("DR 事件参数校验：空窗口/非正激励/非法时刻拒绝", () => {
  assert.throws(() => dr.normalizeEvent({ type: "peak", start: 10, end: 10, incentive: 1 }));
  assert.throws(() => dr.normalizeEvent({ type: "peak", start: 10, end: 12, incentive: 0 }));
  assert.throws(() => dr.normalizeEvent({ type: "peak", start: 24, end: 25, incentive: 1 }));
});

t("DR 测算：同配置基线/响应只差信号；填谷让电池多充谷电", () => {
  const ev = dr.normalizeEvent({ type: "fill", start: 0, end: 6, incentive: 0.4 });
  const m = dr.measure({ ...DR_HOUSEHOLD, month: 7, day: 15 }, ev, 0.5, 0.32);
  assert(m.bat.responded_kwh > 0);
  assert(m.bat.reward === Math.round(m.bat.responded_kwh * 0.4 * 100) / 100);
  // 响应窗口购电量高于基线（填谷方向）
  assert(m.bat.response_grid_kwh > m.bat.baseline_grid_kwh);
});

t("DR 测算：削峰信号可把家电赶出窗口，按窗口减用结算", () => {
  const hh = { month: 7, day: 15, weather: 0.12, capacity: 0, feed: 0.4, shiftableIds: ["dish", "washer"] };
  const ev = dr.normalizeEvent({ type: "peak", start: 11, end: 14, incentive: 1.5 });
  const m = dr.measure(hh, ev, null, 0.32);
  assert(m.no_bat.responded_kwh > 0);
  assert(m.response.plan.every(p => p.start < 11 || p.start + p.hours <= 11 || p.start >= 14));
});

t("DR 测算：含电池基线必须与同日无信号含电池比（不混入无电池曲线）", () => {
  const ev = dr.normalizeEvent({ type: "peak", start: 18, end: 22, incentive: 1.0 });
  const m = dr.measure({ ...DR_HOUSEHOLD, month: 7, day: 15, weather: 0.12 }, ev, 0.5, 0.32);
  // 基线窗口电量取 grid_bat，不是无电池的 grid_no_bat
  const win = ev.hours;
  const baseWin = win.reduce((a, h) => a + m.baseline.hours[h].grid_bat, 0);
  assert(Math.abs(baseWin - m.bat.baseline_grid_kwh) < 0.02);
});

t("DR 计划：发布/重复ID拒绝/撤销后报名失效", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p1", name: "T", month: 7, days: [15], events: [{ type: "peak", start: 18, end: 21, incentive: 1 }] });
  assert.throws(() => s.publishPlan({ id: "p1", name: "T2", month: 7, days: [16], events: [{ type: "peak", start: 18, end: 21, incentive: 1 }] }));
  s.enroll("h", "p1");
  assert.strictEqual(s.isEnrolled("h", "p1"), true);
  s.revokePlan("p1");
  assert.strictEqual(s.isEnrolled("h", "p1"), false);
  assert.throws(() => s.enroll("h2", "p1"));
});

t("DR 计划：days 与事件数量必须一致", () => {
  const s = dr.createStore();
  assert.throws(() => s.publishPlan({ name: "T", month: 7, days: [15, 16], events: [{ type: "peak", start: 18, end: 21, incentive: 1 }] }));
});

t("DR 执行：未报名拒绝；成功结果冻结且重复执行幂等", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15], events: [{ type: "fill", start: 0, end: 6, incentive: 0.4 }] });
  assert.throws(() => dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD }, s));
  s.enroll("h", "p");
  const a = dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD }, s);
  const b = dr.runEvent("h", { planId: "p", day: 15, household: { ...DR_HOUSEHOLD, battery: { ...DR_HOUSEHOLD.battery, soc0: 0 } } }, s);
  assert.strictEqual(b.idempotent, true);
  assert.strictEqual(b.reward, a.reward);
  assert.strictEqual(b.responded_kwh, a.responded_kwh);
});

t("DR 执行：量测失败冻结为 failed，奖励 0，后续不补结成功", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15], events: [{ type: "fill", start: 0, end: 6, incentive: 0.4 }] });
  s.enroll("h", "p");
  const f = dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD, telemetryFault: true }, s);
  assert.strictEqual(f.status, "failed");
  assert.strictEqual(f.reward, 0);
  const f2 = dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD }, s);
  assert.strictEqual(f2.status, "failed");
  assert.strictEqual(f2.idempotent, true);
});

t("DR 月度回写：奖励单列扣减，账单恒等式成立且只结一次", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15], events: [{ type: "fill", start: 0, end: 6, incentive: 0.4 }] });
  s.enroll("h", "p");
  const ex = dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD }, s);
  assert(ex.reward > 0);
  const m = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  assert.strictEqual(m.dr.settled_count, 1);
  assert.strictEqual(m.dr.events[0].status, "settled");
  assert.strictEqual(m.dr.events[0].reward, ex.reward);
  // 实付 = 真实电费（原规则）− 激励；能量电费与阶梯口径不含激励
  assert(Math.abs(m.cost_bat_after_dr - (m.cost_bat - m.dr_reward)) < 1e-9);
  assert(Math.abs(m.energy_bat + m.tier_surcharge_bat - m.cost_bat) <= 0.011);
  assert(m.dr_reward > 0);
  // 重跑幂等
  const m2 = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  assert.strictEqual(m2.dr_reward, m.dr_reward);
  assert(m2.dr.events.every(e => e.idempotent));
});

t("DR 月度：事件日联动真实购电曲线，日明细含 DR 标记", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15], events: [{ type: "fill", start: 0, end: 6, incentive: 0.4 }] });
  s.enroll("h", "p");
  const m = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  const d = m.daily.find(x => x.day === 15);
  assert(Array.isArray(d.dr) && d.dr[0].status === "settled");
  const other = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, seed: 11 });
  const dOther = other.daily.find(x => x.day === 15);
  // 填谷改变了当日真实购电量
  assert(d.kwh_buy_bat !== dOther.kwh_buy_bat);
});

t("DR 撤销：未执行事件不联动不结算；已结算事件金额保留", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15, 20], events: [
    { type: "fill", start: 0, end: 6, incentive: 0.4 },
    { type: "fill", start: 0, end: 6, incentive: 0.4 },
  ]});
  s.enroll("h", "p");
  dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD }, s);
  s.revokePlan("p");
  const m = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  const d15 = m.dr.events.find(e => e.day === 15);
  const d20 = m.dr.events.find(e => e.day === 20);
  assert.strictEqual(d15.status, "settled");
  assert(d15.reward > 0);
  assert.strictEqual(d20.status, "revoked");
  assert.strictEqual(d20.reward, 0);
  // d20 按原规则计算：与无 DR 账单一致
  const plain = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, seed: 11 });
  const p20 = plain.daily.find(x => x.day === 20);
  const m20 = m.daily.find(x => x.day === 20);
  assert.strictEqual(m20.energy_bat, p20.energy_bat);
});

t("DR 退出报名：事件不再联动，账单按原规则", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15], events: [{ type: "fill", start: 0, end: 6, incentive: 0.4 }] });
  s.enroll("h", "p");
  s.unenroll("h", "p");
  const m = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  assert.strictEqual(m.dr.events[0].status, "withdrawn");
  assert.strictEqual(m.dr_reward, 0);
  const plain = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, seed: 11 });
  assert.strictEqual(m.cost_bat, plain.cost_bat);
});

t("DR 失败事件：账单按原规则计算且无奖励，且不与成功事件重复结算", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "p", name: "T", month: 7, days: [15, 16], events: [
    { type: "fill", start: 0, end: 6, incentive: 0.4 },
    { type: "fill", start: 0, end: 6, incentive: 0.4 },
  ]});
  s.enroll("h", "p");
  dr.runEvent("h", { planId: "p", day: 15, household: DR_HOUSEHOLD, telemetryFault: true }, s);
  const m = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  assert.strictEqual(m.dr.failed_count, 1);
  assert.strictEqual(m.dr.events.find(e => e.day === 15).reward, 0);
  assert(m.dr.events.find(e => e.day === 16).reward > 0);
  const reward = m.dr_reward;
  const m2 = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  assert.strictEqual(m2.dr_reward, reward);
});

t("DR 不影响旧账单：无 homeId 时 dr 为空且各字段逐分不变", () => {
  const a = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, seed: 11 });
  const b = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, seed: 11 });
  assert.strictEqual(a.dr, null);
  assert.strictEqual(a.dr_reward, 0);
  assert.strictEqual(a.cost_no_bat, b.cost_no_bat);
  assert.strictEqual(a.cost_bat, b.cost_bat);
});

t("DR 电池：信号价寻优、真实价结算的分离不破坏成本口径", () => {
  const prices = tariff.hourlyPrices();
  const ev = dr.normalizeEvent({ type: "fill", start: 0, end: 6, incentive: 0.4 });
  const sig = dr.signalPrices(prices, ev);
  const hh = { month: 7, day: 15, ...DR_HOUSEHOLD };
  const base = sim.computeDay(hh, 0.5, 0.32);
  const resp = sim.computeDay({ ...hh, objPrices: sig }, 0.5, 0.32);
  // 响应日逐时电费按真实价重算：energy_bat = Σ(真实价×购电−上网)（日终残值在 DP cost 内已补回）
  let manual = 0;
  for (const h of resp.hours) manual += h.grid_bat * prices[h.h] - 0.4 * h.export_bat;
  assert(Math.abs(manual - resp.energy_bat) < 0.05);
  assert(base.energy_bat !== resp.energy_bat || base.kwh_buy_bat !== resp.kwh_buy_bat);
});

t("DR 同日多计划：信号合并、逐事件归因结算", () => {
  const s = dr.createStore();
  s.publishPlan({ id: "pa", name: "A", month: 7, days: [15], events: [{ type: "fill", start: 0, end: 4, incentive: 0.4 }] });
  s.publishPlan({ id: "pb", name: "B", month: 7, days: [15], events: [{ type: "fill", start: 4, end: 6, incentive: 0.6 }] });
  s.enroll("h", "pa");
  s.enroll("h", "pb");
  const ea = dr.runEvent("h", { planId: "pa", day: 15, household: DR_HOUSEHOLD }, s);
  const eb = dr.runEvent("h", { planId: "pb", day: 15, household: DR_HOUSEHOLD }, s);
  const m = sim.monthBill({ ...DR_HOUSEHOLD, month: 7, days: 30, homeId: "h", drStore: s });
  const evs = m.dr.events.filter(e => e.day === 15);
  assert.strictEqual(evs.length, 2);
  assert(evs.every(e => e.status === "settled"));
  // 两笔事件分别结算（金额独立冻结），合计等于账单激励
  const sum = Math.round((evs.reduce((a, e) => a + e.reward, 0)) * 100) / 100;
  assert(Math.abs(sum - m.dr_reward) < 0.011);
  // 独立执行冻结金额与账单回写一致
  assert.strictEqual(evs.find(e => e.plan_id === "pa").reward, ea.reward);
  assert.strictEqual(evs.find(e => e.plan_id === "pb").reward, eb.reward);
});

t("DR 削峰/填谷窗口重叠冲突时报错", () => {
  const prices = tariff.hourlyPrices();
  const a = dr.normalizeEvent({ type: "peak", start: 18, end: 21, incentive: 1 });
  const b = dr.normalizeEvent({ type: "fill", start: 20, end: 23, incentive: 0.3 });
  assert.throws(() => dr.mergeSignals(prices, [a, b]));
});

t("DR 计划：日期超出月份天数（含闰年）拒绝", () => {
  const s = dr.createStore();
  assert.throws(() => s.publishPlan({ name: "t", month: 2, days: [29], events: [{ type: "peak", start: 18, end: 21, incentive: 1 }] }));
  s.publishPlan({ id: "leap", name: "t", year: 2024, month: 2, days: [29], events: [{ type: "peak", start: 18, end: 21, incentive: 1 }] });
  assert.throws(() => s.publishPlan({ name: "t", month: 4, days: [31], events: [{ type: "peak", start: 18, end: 21, incentive: 1 }] }));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
