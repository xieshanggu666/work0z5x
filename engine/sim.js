"use strict";
const tariff = require("./tariff");
const solarMod = require("./solar");
const loadsMod = require("./loads");
const battery = require("./battery");

function r2(x) {
  return Math.round(x * 100) / 100;
}
function r3(x) {
  return Math.round(x * 1000) / 1000;
}

// 月度天气序列（确定性伪随机），月度账单与单日复算共用，保证可复现
function dayWeather(seed, day) {
  return 0.35 + 0.65 * (((seed * 7 + day * 13) % 97) / 97);
}

// 单日引擎：只结算分时能量电费（购电 − 上网），不做月度阶梯附加。
// batterySocStartKwh 为"前一日结转电量"，使月度模拟逐日衔接；
// endValue 为日终残余电量残值（元/kWh）：月度结转时取当日谷价，
// 防止 DP 把存量电当零成本放空；缺省 0 保持单日独立模拟的原行为。
function computeDay(opts, batterySocStartKwh, endValue) {
  const o = opts || {};
  const month = o.month || 7;
  const day = o.day == null ? 15 : o.day;
  const weather = o.weather == null ? 0.8 : Math.max(0, Math.min(1, o.weather));
  const capacity = Math.max(0, o.capacity || 0);
  const feed = o.feed == null ? 0.4 : o.feed;
  const prices = tariff.hourlyPrices(o.tou);
  // 调度信号价（需求响应激励叠加）：仅用于家电/电池寻优，不参与真实能量结算。
  // 缺省等于真实分时电价，保持无 DR 场景行为完全不变。
  const objPrices = Array.isArray(o.objPrices) && o.objPrices.length === 24
    ? o.objPrices.map(Number)
    : prices;
  const drActive = Array.isArray(o.objPrices) && o.objPrices.length === 24;
  const base = loadsMod.baselineLoad();
  const solar = solarMod.solarProfile(month, day, capacity, weather);
  const ids = o.shiftableIds && o.shiftableIds.length
    ? o.shiftableIds
    : loadsMod.SHIFTABLE.map(s => s.id);
  const shiftables = loadsMod.SHIFTABLE.filter(s => ids.includes(s.id));
  const { load, plan } = loadsMod.scheduleShiftable(base, solar, objPrices, feed, shiftables);

  const noBat = battery.optimizeBattery({
    load, solar, price: prices, objPrice: objPrices, feed,
    capKwh: 0.001, maxKw: 0, eff: 0.9, soc0: 0,
  });
  const batCfg = o.battery;
  const hasBat = !!(batCfg && batCfg.capKwh > 0);
  // soc0 沿用既有语义（kWh，缺省 0.5）；月度模拟时由前一日末态 kWh 精确结转
  const socStartKwh = hasBat
    ? (batterySocStartKwh != null
        ? batterySocStartKwh
        : (batCfg.soc0 == null ? 0.5 : batCfg.soc0))
    : null;
  const endV = endValue || 0;
  const bat = hasBat
    ? battery.optimizeBattery({
        load, solar, price: prices, objPrice: objPrices, feed,
        capKwh: batCfg.capKwh,
        maxKw: batCfg.maxKw == null ? 3 : batCfg.maxKw,
        eff: batCfg.eff == null ? 0.9 : batCfg.eff,
        soc0: socStartKwh,
        endValue: endV,
      })
    : null;

  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      h,
      load: r3(load[h]),
      solar: r3(solar[h]),
      price: prices[h],
      ...(drActive ? { obj_price: r3(objPrices[h]) } : {}),
      grid_no_bat: noBat.hours[h].grid_in,
      export_no_bat: noBat.hours[h].export,
      ...(bat
        ? {
            grid_bat: bat.hours[h].grid_in,
            export_bat: bat.hours[h].export,
            ch: bat.hours[h].ch,
            dis: bat.hours[h].dis,
            soc: bat.hours[h].soc,
          }
        : {}),
    });
  }

  return {
    hours,
    plan,
    dr_active: drActive,
    // 当日电网实际收支（购电费 − 上网收益）：日明细、单日账单、月度累计的统一口径
    energy_no_bat: noBat.cost,
    energy_bat: bat ? bat.cost + endV * bat.soc_end_kwh : null,
    // DP 目标值与残值：仅用于月度电池资产清算（望远镜求和），不参与日明细
    dp_cost_bat: bat ? bat.cost : null,
    residual_per_kwh: endV,
    kwh_buy_no_bat: noBat.kwh_buy,
    kwh_buy_bat: bat ? bat.kwh_buy : null,
    kwh_export: noBat.kwh_export,
    kwh_export_bat: bat ? bat.kwh_export : null,
    // 电池首末电量（kWh）：末态用于次日结转，首态用于对账
    soc_start_kwh: bat ? bat.soc_start_kwh : null,
    soc_end_kwh: bat ? bat.soc_end_kwh : null,
    weather,
  };
}

function simulateDay(opts) {
  const o = opts || {};
  // 单日 API 支持显式传入结转电量与残值（用于月度任意一天的精确复算）
  const carry = o.batterySocStartKwh != null ? o.batterySocStartKwh : null;
  const endV = o.endValue || 0;
  const r = computeDay(o, carry, endV);
  // 单日独立账单：阶梯附加按当日购电量结算（与月度场景无关）
  const surchargeNo = tariff.tierSurcharge(r.kwh_buy_no_bat, o.tier);
  const surchargeBat = r.kwh_buy_bat != null ? tariff.tierSurcharge(r.kwh_buy_bat, o.tier) : null;
  return {
    hours: r.hours,
    plan: r.plan,
    energy_no_bat: r2(r.energy_no_bat),
    energy_bat: r.energy_bat != null ? r2(r.energy_bat) : null,
    tier_surcharge_no_bat: r2(surchargeNo),
    tier_surcharge_bat: surchargeBat != null ? r2(surchargeBat) : null,
    tier_surcharge: r2(surchargeNo), // 兼容旧字段：无储能阶梯附加
    cost_no_bat: r2(r.energy_no_bat + surchargeNo),
    cost_bat: r.energy_bat != null ? r2(r.energy_bat + surchargeBat) : null,
    save: r.energy_bat != null
      ? r2((r.energy_no_bat + surchargeNo) - (r.energy_bat + surchargeBat))
      : 0,
    kwh_buy_no_bat: r.kwh_buy_no_bat,
    kwh_buy_bat: r.kwh_buy_bat,
    kwh_export: r.kwh_export,
    kwh_export_bat: r.kwh_export_bat,
    soc0: r.soc_start_kwh != null
      ? r3(r.soc_start_kwh / (o.battery && o.battery.capKwh ? o.battery.capKwh : 1))
      : null,
    soc_start_kwh: r.soc_start_kwh,
    soc_end_kwh: r.soc_end_kwh,
  };
}

function monthBill(opts) {
  const o = opts || {};
  const days = Math.max(7, Math.min(62, o.days || 30));
  const seed = o.seed == null ? 11 : o.seed;
  const month = o.month || 7;
  const year = Number(o.year || new Date().getFullYear());
  const homeId = o.homeId || null;

  // 需求响应台账（可选）：报名生效的事件日按激励信号联动调度，结算幂等回写。
  // 不传 homeId / store 时行为与旧版完全一致：旧账单仍按原规则计算。
  const drMod = require("./dr");
  const drStore = o.drStore || (homeId ? drMod.store : null);
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  // 能量电费与购电量逐日累计（未舍入），阶梯附加只在整月末尾统一计算一次
  let energyNo = 0;
  let energyBat = 0;
  let kwhNo = 0;
  let kwhBat = 0;
  let exportKwh = 0;
  let exportKwhBat = 0;
  // 基线对照（事件日无信号的当日能量电费），用于拆分"调度联动"与"激励奖励"
  let drEnergyNo = 0;
  let drEnergyBat = 0;
  let drKwhNo = 0;
  let drKwhBat = 0;
  let carrySocKwh = null;   // 前一日末态电量，次日以它为初始状态，跨日不断档
  let socInitKwh = null;    // 月初电池电量
  let socEndKwh = null;     // 月末电池电量
  let residualInit = 0;     // 月初电量残值（取第 1 日谷价）
  let residualEnd = 0;      // 月末电量残值（取末日谷价）
  const daily = [];
  const drDays = [];
  let drRewardNo = 0;       // 无电池口径激励奖励（成功结算累计）
  let drRewardBat = 0;      // 含电池口径激励奖励

  for (let d = 1; d <= days; d++) {
    const w = dayWeather(seed, d);
    const dayOpts = { ...o, month, day: d, weather: w };
    // 日终残值取当日谷价：残余电量次日可按谷电回补
    const residual = Math.min.apply(null, tariff.hourlyPrices(o.tou));
    const ctxListAll = drStore ? drStore.findDayEvent(homeId, year, month, d) : null;
    // 参与联动调度的事件：报名仍有效，或已成功执行（撤销不影响已结算事实）
    const ctxList = (ctxListAll || []).filter(ctx => {
      const ex = drStore.getExecution(homeId, ctx.ev);
      return ctx.active || (ex && ex.status === "settled");
    });
    const respond = ctxList.length > 0;

    let r;
    let m = null;
    let drRecs = [];
    if (respond) {
      // 同日多事件信号合并（削峰取高、填谷取低；冲突时报错）
      const merged = drMod.mergeSignals(tariff.hourlyPrices(o.tou), ctxList.map(c => c.ev));
      const dayEventMerged = {
        type: "composite",
        hours: [...new Set(ctxList.flatMap(c => c.ev.hours))],
      };
      // 基线 vs 合并响应：响应量与能量差按合并窗口整体测算
      m = drMod.measureWithSignal(dayOpts, dayEventMerged, merged, carrySocKwh, residual);
      r = m.response;
      // 逐事件结算：按各自窗口从基线/响应逐时曲线归因；冻结奖励以台账为准
      for (const ctx of ctxList) {
        const rec = drMod.settleMonthDay(drStore, homeId, monthKey, d, ctx, m);
        drRecs.push(rec);
      }
    } else {
      r = computeDay(dayOpts, carrySocKwh, residual);
      for (const ctx of ctxListAll || []) {
        // 撤销/退出/失败：生成 0 奖励视图（幂等记录，不触发第二笔成功结算）
        drRecs.push(drMod.settleMonthDay(drStore, homeId, monthKey, d, ctx, null));
      }
    }

    if (r.soc_start_kwh != null && socInitKwh === null) {
      socInitKwh = r.soc_start_kwh;
      residualInit = residual;
    }
    socEndKwh = r.soc_end_kwh;
    residualEnd = residual;

    energyNo += r.energy_no_bat;
    energyBat += r.energy_bat || 0; // 当日电网实际收支（已含日终残值回补，逐日衔接）
    kwhNo += r.kwh_buy_no_bat;
    kwhBat += r.kwh_buy_bat || 0;
    exportKwh += r.kwh_export;
    exportKwhBat += r.kwh_export_bat || 0;

    if (respond && m) {
      drEnergyNo += m.baseline.energy_no_bat;
      drEnergyBat += m.baseline.energy_bat || 0;
      drKwhNo += m.baseline.kwh_buy_no_bat;
      drKwhBat += m.baseline.kwh_buy_bat || 0;
      for (const drRec of drRecs) {
        if (drRec.status === "settled") {
          // 两种口径奖励都已在结算记录中留底（独立执行已冻结时以台账为准）
          drRewardNo += drRec.reward_no_bat;
          drRewardBat += hasBattery(o) ? drRec.reward_bat : drRec.reward_no_bat;
        }
        drDays.push({
          day: d,
          type: drRec.type,
          window: drRec.window,
          incentive: drRec.incentive,
          plan_id: drRec.planId,
          plan_name: drRec.planName,
          status: drRec.status,
          scenario: drRec.scenario || null,
          baseline_grid_kwh: drRec.baseline_grid_kwh != null ? drRec.baseline_grid_kwh : null,
          response_grid_kwh: drRec.response_grid_kwh != null ? drRec.response_grid_kwh : null,
          responded_kwh: drRec.responded_kwh || 0,
          reward: drRec.reward || 0,
          energy_no_bat_delta: null, // 多事件合并调度时单事件能量差不独立归因
          energy_bat_delta: null,
          idempotent: !!drRec.idempotent,
        });
      }
    } else {
      drEnergyNo += r.energy_no_bat;
      drEnergyBat += r.energy_bat || 0;
      drKwhNo += r.kwh_buy_no_bat;
      drKwhBat += r.kwh_buy_bat || 0;
      for (const drRec of drRecs) {
        drDays.push({
          day: d,
          type: drRec.type,
          window: drRec.window,
          incentive: drRec.incentive,
          plan_id: drRec.planId,
          plan_name: drRec.planName,
          status: drRec.status,
          scenario: null,
          baseline_grid_kwh: null,
          response_grid_kwh: null,
          responded_kwh: 0,
          reward: 0,
          energy_no_bat_delta: null,
          energy_bat_delta: null,
          idempotent: !!drRec.idempotent,
        });
      }
    }
    carrySocKwh = r.soc_end_kwh;

    daily.push({
      day: d,
      weather: r3(r.weather),
      // 日明细只含当日能量电费；与 simulateDay 同参数复算结果逐分一致
      cost_no_bat: r2(r.energy_no_bat),
      cost_bat: r.energy_bat != null ? r2(r.energy_bat) : null,
      energy_no_bat: r2(r.energy_no_bat),
      energy_bat: r.energy_bat != null ? r2(r.energy_bat) : null,
      kwh_buy_no_bat: r.kwh_buy_no_bat,
      kwh_buy_bat: r.kwh_buy_bat,
      soc_start_kwh: r.soc_start_kwh,
      soc_end_kwh: r.soc_end_kwh,
      dr: drRecs.length ? drRecs.map(rec => ({
        type: rec.type, window: rec.window, incentive: rec.incentive,
        status: rec.status, responded_kwh: rec.responded_kwh || 0, reward: rec.reward || 0,
        plan_id: rec.planId,
      })) : null,
    });
  }

  const hasBat = socEndKwh !== null;
  // 整月统一阶梯：无储能 / 含储能各按自身整月购电量计一次，不摊到每天。
  // 事件日联动调度改变了真实购电曲线，阶梯按响应后的实际购电量计算（原规则不变）。
  const surchargeNo = tariff.tierSurcharge(kwhNo, o.tier);
  const surchargeBat = tariff.tierSurcharge(kwhBat, o.tier);
  // 基线口径阶梯（无 DR 信号时本应产生的附加），用于节省拆分对账
  const baseSurchargeNo = tariff.tierSurcharge(drKwhNo, o.tier);
  const baseSurchargeBat = hasBat ? tariff.tierSurcharge(drKwhBat, o.tier) : null;
  // 月度电池资产清算（望远镜）：
  // Σ日实际收支 = Σ日DP目标 + 末日残值·月末SOC − 首日残值·月初SOC
  // energyBat 即逐日实际收支累计；assetAdjust 为电池净存量电量的估值，供对账展示。
  const assetAdjust = hasBat ? residualEnd * socEndKwh - residualInit * socInitKwh : 0;

  const totalNo = energyNo + surchargeNo;
  const totalBat = hasBat ? energyBat + surchargeBat : null;

  // 需求响应回写：奖励作为运营方激励单列扣减，不混入能量电费或阶梯附加，
  // 因而撤销/失败不影响电费口径，且每笔奖励经台账幂等只结算一次。
  const drSettled = drDays.filter(x => x.status === "settled");
  const householdHasBat = hasBat;
  const drBlock = drStore ? {
    home_id: homeId,
    month_key: monthKey,
    events: drDays.map(x => ({
      day: x.day, plan_id: x.plan_id, plan_name: x.plan_name,
      type: x.type, window: x.window, incentive: x.incentive,
      status: x.status, scenario: x.scenario,
      baseline_grid_kwh: x.baseline_grid_kwh,
      response_grid_kwh: x.response_grid_kwh,
      responded_kwh: r2(x.responded_kwh),
      reward: r2(x.reward),
      energy_no_bat_delta: x.energy_no_bat_delta,
      energy_bat_delta: x.energy_bat_delta,
      idempotent: x.idempotent,
    })),
    // 奖励按家庭实际配置口径（无电池 / 含电池）从幂等台账累计
    reward: r2(householdHasBat ? drRewardBat : drRewardNo),
    reward_no_bat: r2(drRewardNo),
    reward_bat: householdHasBat ? r2(drRewardBat) : null,
    settled_count: drSettled.length,
    failed_count: drDays.filter(x => x.status === "failed").length,
    revoked_count: drDays.filter(x => x.status === "revoked" || x.status === "withdrawn").length,
  } : null;

  const drReward = drBlock ? drBlock.reward : 0;
  const drRewardNoBat = drBlock ? drBlock.reward_no_bat : 0;
  // 基线账单（无 DR 联动时本应支付的金额，含阶梯）：旧规则口径，供节省统计
  const baseCostNo = drEnergyNo + baseSurchargeNo;
  const baseCostBat = hasBat ? drEnergyBat + baseSurchargeBat : null;
  const drSaveNo = r2(baseCostNo - totalNo - drRewardNoBat);
  const drSaveBat = hasBat ? r2(baseCostBat - totalBat - drReward) : null;

  return {
    days,
    seed,
    year,
    home_id: homeId,
    kwh: r2(kwhNo),
    kwh_buy_no_bat: r2(kwhNo),
    kwh_buy_bat: hasBat ? r2(kwhBat) : null,
    export_kwh: r2(exportKwh),
    export_kwh_bat: hasBat ? r2(exportKwhBat) : null,
    energy_no_bat: r2(energyNo),
    energy_bat: hasBat ? r2(energyBat) : null,
    battery_asset_kwh: hasBat ? r2(socEndKwh - socInitKwh) : null,
    battery_asset_value: hasBat ? r2(assetAdjust) : null,
    tier_surcharge: r2(surchargeNo), // 兼容旧字段：无储能整月阶梯附加
    tier_surcharge_no_bat: r2(surchargeNo),
    tier_surcharge_bat: hasBat ? r2(surchargeBat) : null,
    cost_no_bat: r2(totalNo),
    cost_bat: hasBat ? r2(totalBat) : null,
    save: hasBat ? r2(totalNo - totalBat) : 0,
    daily,
    // 需求响应回写块：无 homeId/台账时为 null，旧账单字段保持原值原义
    dr: drBlock,
    cost_no_bat_after_dr: drBlock ? r2(totalNo - drRewardNoBat) : null,
    cost_bat_after_dr: drBlock && hasBat ? r2(totalBat - drReward) : null,
    dr_reward: drBlock ? r2(drReward) : 0,
    dr_reward_no_bat: drBlock ? r2(drRewardNoBat) : 0,
    dr_save_no_bat: drBlock ? drSaveNo : null,
    dr_save_bat: drBlock ? drSaveBat : null,
  };
}

function hasBattery(o) {
  return !!(o && o.battery && o.battery.capKwh > 0);
}

module.exports = { simulateDay, monthBill, computeDay, dayWeather, hasBattery };
