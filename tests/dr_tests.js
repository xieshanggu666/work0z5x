"use strict";
const assert = require("assert");
const tariff = require("../engine/tariff");
const sim = require("../engine/sim");
const dr = require("../engine/dr");
const { DrStore } = require("../engine/dr_store");

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

const PEAK_PLAN = {
  name: "削峰",
  events: [{ kind: "peak_shave", start: 19, end: 21, incentive: 2, requiredKwh: 0 }],
  startDay: 1, endDay: null, days: 10,
};
const VALLEY_PLAN = {
  name: "填谷",
  events: [{ kind: "valley_fill", start: 2, end: 4, incentive: 0.3, requiredKwh: 0 }],
  startDay: 1, endDay: null, days: 10,
};
const ALL_IDS = ["washer", "heater", "dish", "ev"];
const BAT_SCENARIO = { month: 7, days: 10, capacity: 0, feed: 0.4, shiftableIds: ALL_IDS, battery: { capKwh: 4, maxKw: 1.5, eff: 0.9, soc0: 2 } };

t("DR 校验：事件类型/窗口/激励非法时拒绝", () => {
  assert.throws(() => dr.validatePlan({ name: "x", events: [{ kind: "bad", start: 1, end: 2, incentive: 1 }] }));
  assert.throws(() => dr.validatePlan({ name: "x", events: [{ kind: "peak_shave", start: 22, end: 2, incentive: 1 }] }));
  assert.throws(() => dr.validatePlan({ name: "x", events: [{ kind: "peak_shave", start: 1, end: 2, incentive: -1 }] }));
  assert.throws(() => dr.validatePlan({ name: "x", events: [] }));
});

t("DR 校验：事件窗口重叠时拒绝", () => {
  assert.throws(() => dr.validatePlan({
    name: "x",
    events: [
      { kind: "peak_shave", start: 19, end: 21, incentive: 1 },
      { kind: "valley_fill", start: 20, end: 22, incentive: 0.2 },
    ],
  }));
});

t("信号价：峰段加价、谷段减价且不为负", () => {
  const p1 = dr.effectivePrices([{ kind: "peak_shave", start: 19, end: 21, incentive: 2 }]);
  assert.strictEqual(p1[19], tariff.touPrice(19) + 2);
  assert.strictEqual(p1[18], tariff.touPrice(18));
  const p2 = dr.effectivePrices([{ kind: "valley_fill", start: 0, end: 6, incentive: 5 }]);
  assert.strictEqual(p2[0], 0); // 谷价 0.32 - 5 截断为 0
});

t("联动家电：填谷信号把热水器迁入事件窗口并标记 dr", () => {
  const priceEff = dr.effectivePrices(VALLEY_PLAN.events);
  const base = sim.computeDay({ month: 7, day: 15, weather: 0.8, capacity: 0, feed: 0.4, shiftableIds: ["heater"] });
  const resp = sim.computeDay({
    month: 7, day: 15, weather: 0.8, capacity: 0, feed: 0.4, shiftableIds: ["heater"],
    dr: { priceEff },
  });
  assert.strictEqual(base.plan[0].start, 0);
  assert.strictEqual(resp.plan[0].start, 2);
  assert.strictEqual(resp.plan[0].dr, true);
});

t("部分报名：未报名家电不按信号价调度", () => {
  const priceEff = dr.effectivePrices(VALLEY_PLAN.events);
  const resp = sim.computeDay({
    month: 7, day: 15, weather: 0.8, capacity: 0, feed: 0.4, shiftableIds: ["heater", "washer"],
    dr: { priceEff, enrolledIds: ["heater"] },
  });
  const heater = resp.plan.find(p => p.id === "heater");
  const washer = resp.plan.find(p => p.id === "washer");
  assert.strictEqual(heater.start, 2);
  assert.strictEqual(heater.dr, true);
  assert.strictEqual(washer.dr, false);
});

t("联动电池：削峰信号压低事件窗口含储能购电量", () => {
  const priceEff = dr.effectivePrices(PEAK_PLAN.events);
  const win = (r, f) => r.hours.slice(19, 21).reduce((a, h) => a + h[f], 0);
  const base = sim.computeDay({ ...BAT_SCENARIO, day: 15, weather: 0.8 }, null, 0.32);
  const resp = sim.computeDay({ ...BAT_SCENARIO, day: 15, weather: 0.8, dr: { priceEff } }, null, 0.32);
  assert(win(resp, "grid_bat") < win(base, "grid_bat") - 0.1);
});

t("电池不联动：battery:false 时电池路径不响应信号", () => {
  const priceEff = dr.effectivePrices(PEAK_PLAN.events);
  const base = sim.computeDay({ ...BAT_SCENARIO, day: 15, weather: 0.8 }, null, 0.32);
  const resp = sim.computeDay({ ...BAT_SCENARIO, day: 15, weather: 0.8, dr: { priceEff, battery: false } }, null, 0.32);
  assert.strictEqual(base.kwh_buy_bat, resp.kwh_buy_bat);
  assert.strictEqual(+base.energy_bat.toFixed(6), +resp.energy_bat.toFixed(6));
});

t("事件评估：削峰成功时奖励=响应电量×激励，逐时可查", () => {
  const ev = dr.evaluateDay(
    { ...BAT_SCENARIO, day: 15, weather: 0.8 },
    PEAK_PLAN,
    { battery: true },
  );
  const e = ev.events[0];
  assert(e.delivered);
  assert(e.response_kwh > 0);
  assert.strictEqual(e.reward, Math.round(e.response_kwh * 2 * 100) / 100);
  assert.strictEqual(e.hours.length, 2);
});

t("事件评估：未达最低响应电量判失败且奖励为 0", () => {
  const plan = {
    name: "高门槛",
    events: [{ kind: "peak_shave", start: 19, end: 21, incentive: 2, requiredKwh: 50 }],
    startDay: 1, endDay: null, days: 10,
  };
  const ev = dr.evaluateDay({ ...BAT_SCENARIO, day: 15, weather: 0.8 }, plan, {});
  assert.strictEqual(ev.events[0].delivered, false);
  assert.strictEqual(ev.events[0].reward, 0);
});

t("回写账单：旧规则字段与 monthBill 逐分一致", () => {
  const m = sim.monthBill({ ...BAT_SCENARIO });
  const w = dr.runMonthDr(BAT_SCENARIO, PEAK_PLAN, { battery: true });
  for (const k of ["days", "seed", "kwh_buy_no_bat", "kwh_buy_bat", "export_kwh", "export_kwh_bat",
    "energy_no_bat", "energy_bat", "tier_surcharge_no_bat", "tier_surcharge_bat",
    "cost_no_bat", "cost_bat", "save"]) {
    assert.strictEqual(w[k], m[k], `字段 ${k} 不一致`);
  }
  for (let i = 0; i < m.daily.length; i++) {
    for (const k of ["cost_no_bat", "cost_bat", "energy_no_bat", "energy_bat", "kwh_buy_no_bat", "kwh_buy_bat", "soc_start_kwh", "soc_end_kwh"]) {
      assert.strictEqual(w.daily[i][k], m.daily[i][k], `日明细 ${i}.${k}`);
    }
  }
});

t("回写账单：奖励只在 dr 块冲减一次，能量电费不含奖励", () => {
  const w = dr.runMonthDr(BAT_SCENARIO, PEAK_PLAN, { battery: true });
  assert(w.dr.reward > 0);
  // 响应链物理账单 + 阶梯 − 奖励 = 最终应付；能量电费本身不被奖励污染
  assert(Math.abs(w.dr.final_bat - (w.dr.dr_cost_bat - w.dr.reward_bat)) <= 0.011);
  assert(Math.abs(w.dr.save - (w.cost_bat - w.dr.final_bat)) <= 0.011);
  // 奖励恒等：奖励 + (基线账单 − 响应链物理账单) = DR 总节省
  assert(Math.abs(w.dr.save - (w.dr.reward + (w.cost_bat - w.dr.dr_cost_bat))) < 0.011);
});

t("回写账单：响应链独立 SOC 结转，且日明细基础链可复算", () => {
  const w = dr.runMonthDr({ ...BAT_SCENARIO, days: 8, seed: 3 }, PEAK_PLAN, { battery: true });
  for (let i = 1; i < w.daily.length; i++) {
    assert.strictEqual(w.daily[i].soc_start_kwh, w.daily[i - 1].soc_end_kwh);
  }
  const valley = Math.min(...tariff.hourlyPrices());
  const d1 = w.daily[1];
  const one = sim.simulateDay({
    ...BAT_SCENARIO, days: undefined, day: 2, weather: sim.dayWeather(3, 2),
    batterySocStartKwh: d1.soc_start_kwh, endValue: valley,
  });
  assert.strictEqual(one.energy_bat, d1.energy_bat);
});

t("失败计划：全月零奖励且状态为 settled_failed，最终应付=响应链账单", () => {
  const impossible = {
    name: "失败",
    events: [{ kind: "peak_shave", start: 8, end: 11, incentive: 3, requiredKwh: 50 }],
    startDay: 1, endDay: null, days: 7,
  };
  const w = dr.runMonthDr(
    { month: 7, days: 7, capacity: 5, feed: 0.4, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } },
    impossible, {},
  );
  assert.strictEqual(w.dr.reward, 0);
  assert.strictEqual(w.dr.delivered_events, 0);
  assert(w.dr.failed_events > 0);
  assert.strictEqual(w.dr.status, "settled_failed");
  assert.strictEqual(w.dr.final_bat, w.dr.dr_cost_bat);
});

t("状态机：发布/报名/撤销结算全链路幂等、零奖励不重复", () => {
  const store = new DrStore();
  const plan = store.publishPlan({
    name: "撤销测试",
    events: [{ kind: "peak_shave", start: 19, end: 21, incentive: 1 }],
    scenario: BAT_SCENARIO,
  });
  store.enroll(plan.id, "home-1", {});
  store.cancelEnrollment(plan.id, "home-1");
  const s1 = store.settle(plan.id, "home-1");
  assert.strictEqual(s1.repeated, false);
  assert.strictEqual(s1.bill.status, "canceled");
  assert.strictEqual(s1.bill.reward, 0);
  assert.strictEqual(s1.bill.bill, null);
  const s2 = store.settle(plan.id, "home-1");
  assert.strictEqual(s2.repeated, true);
  assert.strictEqual(s2.bill.id, s1.bill.id);
  assert.strictEqual(s2.bill.reward, 0);
});

t("状态机：成功结算后重复结算返回同一结算单且奖励不翻倍", () => {
  const store = new DrStore();
  const plan = store.publishPlan({
    name: "成功测试",
    events: [{ kind: "peak_shave", start: 19, end: 21, incentive: 2, requiredKwh: 0.05 }],
    scenario: BAT_SCENARIO,
  });
  store.enroll(plan.id, "home-1", {});
  const s1 = store.settle(plan.id, "home-1");
  assert.strictEqual(s1.bill.status, "settled_success");
  const r1 = s1.bill.reward;
  assert(r1 > 0);
  const s2 = store.settle(plan.id, "home-1");
  assert.strictEqual(s2.repeated, true);
  assert.strictEqual(s2.bill.id, s1.bill.id);
  assert.strictEqual(s2.bill.reward, r1);
  // 本人成功结算后拒绝撤销自己的报名
  assert.throws(() => store.cancelEnrollment(plan.id, "home-1"));
  // 计划级撤销也被拒（已有成功结算）
  assert.throws(() => store.cancelPlan(plan.id));
});

t("状态机：计划锁定只阻止计划级撤销，其他家庭仍可撤销自己的报名", () => {
  const store = new DrStore();
  const plan = store.publishPlan({
    name: "锁定测试",
    events: [{ kind: "peak_shave", start: 19, end: 21, incentive: 2, requiredKwh: 0.05 }],
    scenario: BAT_SCENARIO,
  });
  store.enroll(plan.id, "home-1", {});
  store.settle(plan.id, "home-1"); // home-1 成功结算，计划锁定
  // 计划级撤销被拒
  assert.throws(() => store.cancelPlan(plan.id));
  // 另一家庭报名后撤销自己的报名：允许（只影响自己，且自己尚未成功结算）
  store.enroll(plan.id, "home-2", {});
  const en2 = store.cancelEnrollment(plan.id, "home-2");
  assert.strictEqual(en2.status, "canceled");
  const s2 = store.settle(plan.id, "home-2");
  assert.strictEqual(s2.bill.status, "canceled");
  assert.strictEqual(s2.bill.reward, 0);
});

t("状态机：计划撤销与重复报名的冲突处理", () => {
  const store = new DrStore();
  const plan = store.publishPlan({
    name: "冲突", events: [{ kind: "valley_fill", start: 0, end: 6, incentive: 0.1 }], scenario: { month: 7, days: 7 },
  });
  store.enroll(plan.id, "h", {});
  assert.throws(() => store.enroll(plan.id, "h", {})); // 重复报名
  store.cancelPlan(plan.id);
  assert.strictEqual(store.getEnrollment(plan.id, "h").status, "canceled"); // 联动撤销
  assert.throws(() => store.enroll(plan.id, "h2", {})); // 撤销后不能再报名
  // 未报名结算 404
  const p2 = store.publishPlan({ name: "无人", events: [{ kind: "peak_shave", start: 18, end: 22, incentive: 1 }], scenario: { month: 7, days: 7 } });
  assert.throws(() => store.settle(p2.id, "nobody"));
});

t("无储能家庭：bat 口径为空，无储能 DR 奖励与节省照常回写", () => {
  // 无光伏、热水器参与填谷（迁入窗口带来实际购电增量）；窗口 2-5 覆盖热水器迁入的 2-4 点
  const plan = {
    name: "无电池",
    events: [{ kind: "valley_fill", start: 2, end: 5, incentive: 0.3 }],
    startDay: 1, endDay: null, days: 7,
  };
  const w = dr.runMonthDr(
    { month: 7, days: 7, capacity: 0, feed: 0.4, shiftableIds: ["heater"] },
    plan, { shiftableIds: ["heater"] },
  );
  assert.strictEqual(w.cost_bat, null);
  assert.strictEqual(w.dr.reward_bat, null);
  assert(w.dr.reward_no_bat > 0);
  assert.strictEqual(w.dr.reward, w.dr.reward_no_bat);
  assert(w.dr.final_bat === null);
  assert.strictEqual(w.dr.status, "settled_success");
});

module.exports = { run: () => ({ passed, failed }) };

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
