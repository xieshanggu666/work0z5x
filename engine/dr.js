"use strict";

const tariff = require("./tariff");
const sim = require("./sim");

function r2(x) {
  return Math.round(x * 100) / 100;
}
function r3(x) {
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 计划校验
// ---------------------------------------------------------------------------

function validateEvent(ev) {
  if (!ev || (ev.kind !== "peak_shave" && ev.kind !== "valley_fill")) {
    throw new Error("事件类型必须是 peak_shave（削峰）或 valley_fill（填谷）");
  }
  const start = Number(ev.start);
  const end = Number(ev.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || end <= start) {
    throw new Error("事件窗口必须是 0-24 内左闭右开的整数小时区间");
  }
  if (!(Number(ev.incentive) >= 0)) throw new Error("激励单价必须是非负数（元/kWh）");
  if (ev.requiredKwh != null && !(Number(ev.requiredKwh) >= 0)) {
    throw new Error("最低响应电量必须是非负数（kWh）");
  }
  return {
    kind: ev.kind,
    start,
    end,
    incentive: Number(ev.incentive),
    requiredKwh: ev.requiredKwh == null ? 0 : Number(ev.requiredKwh),
  };
}

function validatePlan(plan) {
  const p = plan || {};
  if (!p.name) throw new Error("计划名称不能为空");
  if (!Array.isArray(p.events) || !p.events.length) throw new Error("计划至少包含一个激励事件");
  const events = p.events.map(validateEvent);
  // 同一计划的事件窗口不允许重叠（重叠时信号价叠加口径会有歧义）
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (a.start < b.end && b.start < a.end) {
        throw new Error(`事件窗口重叠：${a.start}-${a.end} 与 ${b.start}-${b.end}`);
      }
    }
  }
  const startDay = p.startDay == null ? 1 : Number(p.startDay);
  const endDay = p.endDay == null ? null : Number(p.endDay);
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31) throw new Error("起始日必须是 1-31 的整数");
  if (endDay != null && (!Number.isInteger(endDay) || endDay < startDay || endDay > 31)) {
    throw new Error("结束日必须不小于起始日且不超过 31");
  }
  return {
    name: String(p.name),
    events,
    startDay,
    endDay,
    days: p.days == null ? 30 : Math.max(7, Math.min(62, Number(p.days) || 30)),
  };
}

// ---------------------------------------------------------------------------
// 信号价：峰段加价（引导远离）、谷段减价至不低于 0（引导迁入/充入）
// 只作用于家电选位与电池 DP 选路；物理账单永远按真实分时价结算。
// ---------------------------------------------------------------------------

function effectivePrices(events, tou) {
  const base = tariff.hourlyPrices(tou);
  const out = base.slice();
  for (const ev of events) {
    for (let h = ev.start; h < ev.end; h++) {
      out[h] = ev.kind === "peak_shave"
        ? out[h] + ev.incentive
        : Math.max(0, out[h] - ev.incentive);
    }
  }
  return out;
}

function eventActiveOnDay(plan, day) {
  if (day < plan.startDay) return false;
  if (plan.endDay != null && day > plan.endDay) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 单事件评估：对比"基线链"与"响应链"在事件窗口的实际购电量
// 返回 delivered=false 表示该次事件失败（未达标），失败不结算奖励
// ---------------------------------------------------------------------------

function eventResult(ev, baseDay, drDay, useBat) {
  const field = useBat ? "grid_bat" : "grid_no_bat";
  const requiredKwh = ev.requiredKwh == null ? 0 : Number(ev.requiredKwh);
  let baseKwh = 0;
  let actualKwh = 0;
  const byHour = [];
  for (let h = ev.start; h < ev.end; h++) {
    const b = baseDay.hours[h][field] || 0;
    const a = drDay.hours[h][field] || 0;
    baseKwh += b;
    actualKwh += a;
    byHour.push({ h, base_kwh: r3(b), actual_kwh: r3(a) });
  }
  const delta = ev.kind === "peak_shave" ? baseKwh - actualKwh : actualKwh - baseKwh;
  // 门槛为 0 时：零响应（基线已无法再压/填）也算达标，只是奖励为 0；
  // 负响应（反向动作）永远不达标；门槛为正时必须响应出不低于门槛的电量
  const delivered = delta >= -1e-9 && delta + 1e-9 >= requiredKwh;
  const responseKwh = Math.max(0, delta);
  return {
    kind: ev.kind,
    start: ev.start,
    end: ev.end,
    incentive: ev.incentive,
    required_kwh: requiredKwh,
    base_kwh: r3(baseKwh),
    actual_kwh: r3(actualKwh),
    response_kwh: r3(responseKwh),
    reward: delivered ? r2(responseKwh * ev.incentive) : 0,
    delivered,
    hours: byHour,
  };
}

// ---------------------------------------------------------------------------
// 单日评估：返回基线/响应两个日结果（不写任何账单），供 /api/simulate 预览
// ---------------------------------------------------------------------------

function evaluateDay(opts, plan, enrollment) {
  const enroll = enrollment || {};
  const priceEff = effectivePrices(plan.events, opts.tou);
  const drOpts = {
    ...opts,
    dr: {
      priceEff,
      enrolledIds: enroll.shiftableIds || null,
      battery: enroll.battery === false ? false : true,
    },
  };
  const carryBase = opts.batterySocStartKwh != null ? opts.batterySocStartKwh : null;
  const endValue = opts.endValue || 0;
  // 响应链以同一初始电量起跑，保证事件窗口的差异完全来自调度联动
  const baseDay = sim.computeDay(opts, carryBase, endValue);
  const drDay = sim.computeDay(drOpts, carryBase, endValue);
  const hasBat = drDay.energy_bat != null;
  const events = plan.events.map(ev => eventResult(ev, baseDay, drDay, hasBat));
  const rewardNo = events.reduce((a, e) => a + e.reward, 0);
  return {
    base_day: baseDay,
    dr_day: drDay,
    has_bat: hasBat,
    events,
    reward_no_bat: r2(events.reduce((a, e) => a + e.reward, 0)),
    // 电池参与响应时（默认），以含储能口径结算；未联动电池时与无储能口径一致
    reward_bat: hasBat && enroll.battery !== false
      ? r2(events.reduce((a, e) => a + e.reward, 0))
      : r2(rewardNo),
  };
}

// ---------------------------------------------------------------------------
// 月度执行：基线链与响应链各自独立结转 SOC，逐日对比事件窗口。
// 物理账单按真实分时价累计（energy_no_bat / energy_bat 口径与 monthBill 相同），
// 需求响应奖励是独立的一行，绝不并入能量电费——撤销或失败不会重复结算。
// ---------------------------------------------------------------------------

function runMonthDr(opts, plan, enrollment) {
  const o = opts || {};
  const days = Math.max(7, Math.min(62, o.days || 30));
  const seed = o.seed == null ? 11 : o.seed;
  const enroll = enrollment || {};
  const hasBatteryCfg = !!(o.battery && o.battery.capKwh > 0);
  const batLinked = hasBatteryCfg && enroll.battery !== false;
  const priceEff = effectivePrices(plan.events, o.tou);
  const residual = Math.min.apply(null, tariff.hourlyPrices(o.tou));

  let energyNo = 0, energyBat = 0, energyNoDr = 0, energyBatDr = 0;
  let kwhNo = 0, kwhBat = 0, kwhNoDr = 0, kwhBatDr = 0;
  let exportNo = 0, exportBat = 0, exportNoDr = 0, exportBatDr = 0;
  let carryBase = null, carryDr = null;
  let socInit = null, socEnd = null, socInitDr = null, socEndDr = null;
  let deliveredCount = 0, failedCount = 0;
  let rewardNoTotal = 0, rewardBatTotal = 0;
  const eventDaily = [];
  const daily = [];

  for (let d = 1; d <= days; d++) {
    const w = sim.dayWeather(seed, d);
    const dayOpts = { ...o, month: o.month || 7, day: d, weather: w };
    const drOpts = {
      ...dayOpts,
      dr: {
        priceEff,
        enrolledIds: enroll.shiftableIds || null,
        battery: enroll.battery === false ? false : true,
      },
    };
    const b = sim.computeDay(dayOpts, carryBase, residual);
    const x = sim.computeDay(drOpts, carryDr, residual);

    if (b.soc_start_kwh != null && socInit === null) socInit = b.soc_start_kwh;
    socEnd = b.soc_end_kwh;
    if (x.soc_start_kwh != null && socInitDr === null) socInitDr = x.soc_start_kwh;
    socEndDr = x.soc_end_kwh;

    energyNo += b.energy_no_bat;
    energyBat += b.energy_bat || 0;
    energyNoDr += x.energy_no_bat;
    energyBatDr += x.energy_bat || 0;
    kwhNo += b.kwh_buy_no_bat;
    kwhBat += b.kwh_buy_bat || 0;
    kwhNoDr += x.kwh_buy_no_bat;
    kwhBatDr += x.kwh_buy_bat || 0;
    exportNo += b.kwh_export;
    exportBat += b.kwh_export_bat || 0;
    exportNoDr += x.kwh_export;
    exportBatDr += x.kwh_export_bat || 0;
    carryBase = b.soc_end_kwh;
    carryDr = x.soc_end_kwh;

    daily.push({
      day: d,
      weather: r3(w),
      // 基础日明细与 sim.monthBill 同口径（能量电费、结转电量），逐分可复算
      cost_no_bat: r2(b.energy_no_bat),
      cost_bat: b.energy_bat != null ? r2(b.energy_bat) : null,
      energy_no_bat: r2(b.energy_no_bat),
      energy_bat: b.energy_bat != null ? r2(b.energy_bat) : null,
      kwh_buy_no_bat: b.kwh_buy_no_bat,
      kwh_buy_bat: b.kwh_buy_bat,
      soc_start_kwh: b.soc_start_kwh,
      soc_end_kwh: b.soc_end_kwh,
      // 响应链当日物理能量电费与奖励（奖励只在事件日为正）
      dr_cost_no_bat: r2(x.energy_no_bat),
      dr_cost_bat: x.energy_bat != null ? r2(x.energy_bat) : null,
      dr_kwh_buy_no_bat: x.kwh_buy_no_bat,
      dr_kwh_buy_bat: x.kwh_buy_bat,
      reward_no_bat: 0,
      reward_bat: 0,
      delivered: 0,
      failed: 0,
    });

    if (eventActiveOnDay(plan, d)) {
      const useBat = x.energy_bat != null;
      const evs = plan.events.map(ev => {
        const er = eventResult(ev, b, x, useBat);
        return { ...er, day: d };
      });
      const dayRewardNo = evs.reduce((a, e) => a + e.reward, 0);
      rewardNoTotal += dayRewardNo;
      rewardBatTotal += batLinked ? dayRewardNo : 0;
      for (const e of evs) {
        if (e.delivered) deliveredCount++;
        else failedCount++;
      }
      const dd = daily[daily.length - 1];
      dd.reward_no_bat = r2(dayRewardNo);
      dd.reward_bat = r2(batLinked ? dayRewardNo : 0);
      dd.delivered = evs.filter(e => e.delivered).length;
      dd.failed = evs.filter(e => !e.delivered).length;
      eventDaily.push(...evs);
    }
  }

  const hasBat = socEnd !== null;
  // 阶梯附加按各自整月购电量独立计算一次；响应链若改变购电量，阶梯按新量计
  const surchargeNo = tariff.tierSurcharge(kwhNo, o.tier);
  const surchargeBat = hasBat ? tariff.tierSurcharge(kwhBat, o.tier) : null;
  const surchargeNoDr = tariff.tierSurcharge(kwhNoDr, o.tier);
  const surchargeBatDr = hasBat ? tariff.tierSurcharge(kwhBatDr, o.tier) : null;

  const totalNo = energyNo + surchargeNo;
  const totalBat = hasBat ? energyBat + surchargeBat : null;
  const totalNoDr = energyNoDr + surchargeNoDr;
  const totalBatDr = hasBat ? energyBatDr + surchargeBatDr : null;
  // 未舍入总额：最终应付/节省必须在未舍入口径相减，防止 1 分舍入误差
  const totalNoRaw = totalNo;
  const totalBatRaw = totalBat;
  const totalNoDrRaw = totalNoDr;
  const totalBatDrRaw = totalBatDr;

  // 结算口径：含储能家庭按含储能链结算，无储能家庭按无储能链结算。
  // 只要有奖励落地即成功；有事件但全部未达标才是失败（失败事件奖励本就是 0，不重复计）。
  const reward = batLinked ? rewardBatTotal : rewardNoTotal;
  const totalEvents = deliveredCount + failedCount;
  const status = reward > 0
    ? "settled_success"
    : totalEvents > 0 ? "settled_failed" : "settled_no_event";

  return {
    days,
    seed,
    // —— 以下字段与 sim.monthBill 完全一致：旧账单仍按原规则计算 ——
    kwh: r2(kwhNo),
    kwh_buy_no_bat: r2(kwhNo),
    kwh_buy_bat: hasBat ? r2(kwhBat) : null,
    export_kwh: r2(exportNo),
    export_kwh_bat: hasBat ? r2(exportBat) : null,
    energy_no_bat: r2(energyNo),
    energy_bat: hasBat ? r2(energyBat) : null,
    battery_asset_kwh: hasBat ? r2(socEnd - socInit) : null,
    battery_asset_value: hasBat ? r2(residual * (socEnd - socInit)) : null,
    tier_surcharge: r2(surchargeNo),
    tier_surcharge_no_bat: r2(surchargeNo),
    tier_surcharge_bat: hasBat ? r2(surchargeBat) : null,
    cost_no_bat: r2(totalNo),
    cost_bat: hasBat ? r2(totalBat) : null,
    save: hasBat ? r2(totalNo - totalBat) : 0,
    // 基础日明细字段与 sim.monthBill 完全一致（额外的 DR 字段仅作追加，不影响复算）
    daily,
    // —— 需求响应回写块（新增字段，旧字段不动）——
    dr: {
      plan_name: plan.name,
      enrollment: {
        shiftable_ids: enroll.shiftableIds || (o.shiftableIds && o.shiftableIds.length ? o.shiftableIds : ["washer", "heater", "dish", "ev"]),
        battery_linked: batLinked,
      },
      event_days: eventDaily,
      delivered_events: deliveredCount,
      failed_events: failedCount,
      reward_no_bat: r2(rewardNoTotal),
      reward_bat: hasBat ? r2(rewardBatTotal) : null,
      reward: r2(reward),
      status,
      // 响应链物理账单（真实分时价，不含奖励）
      dr_kwh_buy_no_bat: r2(kwhNoDr),
      dr_kwh_buy_bat: hasBat ? r2(kwhBatDr) : null,
      dr_energy_no_bat: r2(energyNoDr),
      dr_energy_bat: hasBat ? r2(energyBatDr) : null,
      dr_tier_surcharge_no_bat: r2(surchargeNoDr),
      dr_tier_surcharge_bat: hasBat ? r2(surchargeBatDr) : null,
      dr_cost_no_bat: r2(totalNoDr),
      dr_cost_bat: hasBat ? r2(totalBatDr) : null,
      // 联动后实际应付：响应链账单 − 激励奖励（奖励只在此处冲减一次）。
      // 必须用未舍入的总额相减后再 r2，避免两个已舍入数相减产生 1 分误差。
      final_no_bat: r2(totalNoDrRaw - rewardNoTotal),
      final_bat: hasBat ? r2(totalBatDrRaw - rewardBatTotal) : null,
      // DR 净节省 = 原规则账单 − 联动后应付；含节省电费与奖励两部分（未舍入口径）
      save_no_bat: r2(totalNoRaw - (totalNoDrRaw - rewardNoTotal)),
      save_bat: hasBat ? r2(totalBatRaw - (totalBatDrRaw - rewardBatTotal)) : null,
      save: r2(hasBat
        ? totalBatRaw - (totalBatDrRaw - rewardBatTotal)
        : totalNoRaw - (totalNoDrRaw - rewardNoTotal)),
      dr_daily: daily,
    },
  };
}

module.exports = {
  validatePlan,
  validateEvent,
  effectivePrices,
  eventActiveOnDay,
  eventResult,
  evaluateDay,
  runMonthDr,
};
