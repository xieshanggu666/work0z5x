"use strict";
const tariff = require("./tariff");
const sim = require("./sim");

// 电网需求响应（Demand Response）：
// 运营方发布峰段削峰 / 谷段填谷激励计划，家庭报名后，事件当日可迁移家电与
// 储能电池按"调度信号价"联动调度；事件窗口内相对基线少用（或多用）的电网
// 电量按单位激励结算奖励。结算结果写入幂等台账并回写月度账单。
//
// 关键不变式：
//   1. 激励只改变调度信号价，真实分时电价仍是唯一能量结算口径，旧账单不变；
//   2. 同一 (home,event) 的执行/月账单结算只入账一次，撤销/失败不重复结算；
//   3. 计划撤销后尚未执行的报名作废，已结算的奖励不回滚（历史按事实留存）。

function r2(x) {
  return Math.round(x * 100) / 100;
}

function inWindow(hour, win) {
  const a = win[0];
  const b = win[1];
  if (a <= b) return hour >= a && hour < b;
  return hour >= a || hour < b;
}

function windowHours(win) {
  const out = [];
  for (let h = 0; h < 24; h++) if (inWindow(h, win)) out.push(h);
  return out;
}

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// 事件归一化与校验。入参支持完整事件对象或计划发布时的原始字段。
function normalizeEvent(e) {
  if (!e || typeof e !== "object") throw new Error("DR 事件不能为空");
  const type = e.type === "fill" ? "fill" : "peak";
  const start = Number(e.start);
  const end = Number(e.end);
  const incentive = Number(e.incentive);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || end > 24 || start > 23) {
    throw new Error("DR 事件窗口起止小时非法");
  }
  if (start === end) throw new Error("DR 事件窗口不能为空");
  if (!(incentive > 0) || incentive > 5) throw new Error("DR 单位激励必须在 (0, 5] 元/kWh");
  return {
    type,
    start,
    end,
    window: [start, end],
    incentive: r2(incentive),
    hours: windowHours([start, end]),
  };
}

// 调度信号价：峰段削峰在窗口内加价（少购电更划算）；
// 谷段填谷在窗口内压价（压到真实谷价之下，多购电/充电更划算）。
function signalPrices(prices, event) {
  const out = prices.slice();
  for (const h of event.hours) {
    out[h] = event.type === "peak"
      ? out[h] + event.incentive
      : Math.min(out[h], Math.min.apply(null, prices)) - event.incentive;
  }
  return out;
}

// 多事件信号合并：同日多个生效事件时，削峰加价取较大、填谷压价取较小；
// 同一小时若同时存在削峰与填谷信号视为配置冲突。
function mergeSignals(prices, events) {
  const out = prices.slice();
  for (const ev of events) {
    const next = signalPrices(prices, ev);
    for (const h of ev.hours) {
      const peakHere = next[h] > prices[h];
      const fillHere = next[h] < prices[h];
      const wasPeak = out[h] > prices[h];
      const wasFill = out[h] < prices[h];
      if ((peakHere && wasFill) || (fillHere && wasPeak)) {
        throw new Error(`削峰与填谷事件窗口在 ${h} 时冲突`);
      }
      if (peakHere) out[h] = Math.max(out[h], next[h]);
      else if (fillHere) out[h] = Math.min(out[h], next[h]);
    }
  }
  return out;
}

// 事件窗口内电网净购电量（kWh）
function windowGrid(dayResult, key, hours) {
  let sum = 0;
  for (const h of hours) {
    sum += dayResult.hours[h][key];
  }
  return sum;
}

// 需求响应测算：基线（无信号）与响应（叠加信号）对比。
// 两者使用相同的结转初态与残值，保证差异只来自调度信号。
// 返回逐场景（无电池 / 含电池）的窗口电量、奖励与全天能量电费。
function measure(opts, eventRaw, carrySoc, endValue) {
  const event = normalizeEvent(eventRaw);
  const prices = tariff.hourlyPrices(opts.tou);
  const sig = signalPrices(prices, event);
  return measureWithSignal(opts, event, sig, carrySoc, endValue);
}

// 对给定基线/响应两条逐日曲线，按指定小时窗口测算响应量与（可选）单价奖励
function windowScenario(base, resp, hoursSub, type, incentive) {
  function one(key, energyKey) {
    const baseWin = windowGrid(base, key, hoursSub);
    const respWin = windowGrid(resp, key, hoursSub);
    const delta = baseWin - respWin; // 峰段：正值=削峰；谷段：负值=填谷
    const kwh = type === "fill" ? Math.max(0, -delta) : Math.max(0, delta);
    return {
      baseline_grid_kwh: r2(baseWin),
      response_grid_kwh: r2(respWin),
      delta_kwh: r2(delta),
      responded_kwh: r2(kwh),
      reward: incentive != null ? r2(kwh * incentive) : null,
      baseline_energy: r2(base[energyKey]),
      response_energy: r2(resp[energyKey]),
      energy_delta: r2(resp[energyKey] - base[energyKey]),
    };
  }
  return {
    no_bat: one("grid_no_bat", "energy_no_bat"),
    bat: resp.kwh_buy_bat != null ? one("grid_bat", "energy_bat") : null,
  };
}

// 显式给定调度信号与归因窗口（用于同日多事件信号合并）。
// eventLike 需要 { type, hours, incentive? }；多事件合并时 type='composite'
// 且不给 incentive，奖励由月账单按各子事件窗口/单价另行归因。
function measureWithSignal(opts, eventLike, sig, carrySoc, endValue) {
  const type = eventLike.type === "fill" ? "fill" : "peak";
  const base = sim.computeDay({ ...opts, objPrices: null }, carrySoc, endValue);
  const resp = sim.computeDay({ ...opts, objPrices: sig }, carrySoc, endValue);
  const whole = windowScenario(base, resp, eventLike.hours, type, eventLike.incentive);
  return {
    event: { type, hours: eventLike.hours },
    signal: sig.map(r2),
    no_bat: whole.no_bat,
    bat: whole.bat,
    baseline: base,
    response: resp,
  };
}

// ------------------------------- 台账存储 ----------------------------------

function createStore() {
  const plans = new Map();     // planId -> plan（含 events[]）
  const enrollments = new Map(); // `${homeId}${planId}` -> {homeId, planId, at, status}
  const executions = new Map();  // `${homeId}${eventKey}` -> 执行结果（幂等，冻结）
  const settlements = new Map(); // 结算幂等键 -> 结算记录
  let planSeq = 0;

  function planKeyOf(ev) {
    return `${ev.year || ev.monthYear}-${ev.month}-p${ev.planId}`;
  }
  function eventKeyOf(ev) {
    return ev.eventKey || `${planKeyOf(ev)}-d${ev.day}`;
  }
  function exKey(homeId, ev) {
    return `${homeId}${eventKeyOf(ev)}`;
  }
  function enKey(homeId, planId) {
    return `${homeId}${planId}`;
  }

  // 运营方发布计划
  function publishPlan(input) {
    const body = input || {};
    if (!body.name) throw new Error("计划名称不能为空");
    const month = Number(body.month);
    const year = Number(body.year || new Date().getFullYear());
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("计划月份非法");
    const rawEvents = body.events || body.event;
    const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    if (!list.length || list.some(e => e == null)) throw new Error("计划至少包含一个事件");
    const events = list.map(e => normalizeEvent(e));
    const daysNum = (body.days || []).map(Number);
    if (!daysNum.length) throw new Error("计划必须指定事件日期 days[]");
    if (daysNum.length !== events.length) throw new Error("days 与事件数量必须一致");
    for (const d of daysNum) {
      if (!Number.isInteger(d) || d < 1 || d > daysInMonth(year, month)) {
        throw new Error(`事件日期超出 ${year} 年 ${month} 月范围`);
      }
    }
    // 同一计划同一天不允许两个事件（避免结算键冲突）
    if (new Set(daysNum).size !== daysNum.length) throw new Error("同一计划的事件日期不能重复");
    planSeq += 1;
    const id = body.id || `plan-${year}-${String(month).padStart(2, "0")}-${planSeq}`;
    if (plans.has(id)) throw new Error(`计划 ${id} 已存在`);
    const plan = {
      id,
      name: body.name,
      operator: body.operator || "电网运营方",
      year,
      month,
      events: events.map((e, i) => ({
        ...e,
        planId: id,
        day: daysNum[i],
        year,
        month,
        eventKey: `${id}-d${daysNum[i]}`,
      })),
      status: "published", // published -> revoked
      created_at: new Date().toISOString(),
    };
    plans.set(id, plan);
    return publicPlan(plan);
  }

  function publicPlan(plan) {
    return {
      id: plan.id, name: plan.name, operator: plan.operator,
      year: plan.year, month: plan.month, status: plan.status,
      events: plan.events.map(e => ({
        type: e.type, start: e.start, end: e.end,
        incentive: e.incentive, window: e.window, day: e.day, eventKey: e.eventKey,
      })),
      created_at: plan.created_at,
    };
  }

  function getPlan(planId) {
    return plans.get(planId) || null;
  }
  function listPlans() {
    return [...plans.values()].map(publicPlan);
  }

  // 撤销计划：尚未执行的报名失效；已结算的奖励保留不回滚
  function revokePlan(planId) {
    const plan = plans.get(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    if (plan.status === "revoked") return publicPlan(plan);
    plan.status = "revoked";
    for (const en of enrollments.values()) {
      if (en.planId === planId && en.status === "enrolled") en.status = "revoked";
    }
    return publicPlan(plan);
  }

  // 家庭报名 / 退出
  function enroll(homeId, planId) {
    const plan = plans.get(planId);
    if (!plan) throw new Error(`计划 ${planId} 不存在`);
    if (plan.status === "revoked") throw new Error("计划已撤销，无法报名");
    const k = enKey(homeId, planId);
    if (enrollments.has(k)) return enrollments.get(k);
    const en = { homeId, planId, status: "enrolled", at: new Date().toISOString() };
    enrollments.set(k, en);
    return { ...en };
  }
  function unenroll(homeId, planId) {
    const k = enKey(homeId, planId);
    const en = enrollments.get(k);
    if (!en) return { homeId, planId, status: "none" };
    en.status = "withdrawn";
    return { ...en };
  }
  function isEnrolled(homeId, planId) {
    const en = enrollments.get(enKey(homeId, planId));
    return !!(en && en.status === "enrolled");
  }
  function listEnrollments(homeId) {
    return [...enrollments.values()]
      .filter(e => e.homeId === homeId)
      .map(e => ({ ...e, plan: plans.has(e.planId) ? publicPlan(plans.get(e.planId)) : null }));
  }

  // 取某月对该家庭生效的事件（已报名且计划未撤销），按日索引
  function activeEventMap(homeId, year, month) {
    const map = new Map();
    for (const en of enrollments.values()) {
      if (en.homeId !== homeId || en.status !== "enrolled") continue;
      const plan = plans.get(en.planId);
      if (!plan || plan.status !== "published" || plan.year !== year || plan.month !== month) continue;
      for (const ev of plan.events) {
        if (!map.has(ev.day)) map.set(ev.day, ev);
      }
    }
    return map;
  }

  // 取某日该家庭的全部事件上下文（不要求报名仍有效）：已结算的事件即使计划撤销，
  // 月度链路仍需识别其事件窗口以便对账；返回数组，支持同家庭同日报名多个计划。
  // 每项为 { ev, plan, enrollment, active }
  function findDayEvent(homeId, year, month, day) {
    const out = [];
    for (const en of enrollments.values()) {
      if (en.homeId !== homeId) continue;
      const plan = plans.get(en.planId);
      if (!plan || plan.year !== year || plan.month !== month) continue;
      const ev = plan.events.find(e => e.day === day);
      if (!ev) continue;
      const active = en.status === "enrolled" && plan.status === "published";
      out.push({ ev, plan, enrollment: en, active });
    }
    return out.length ? out : null;
  }

  function getExecution(homeId, ev) {
    return executions.get(exKey(homeId, ev)) || null;
  }

  // 冻结一次执行结果（幂等：已存在则原样返回，不覆盖、不重复结算）
  function freezeExecution(homeId, ev, rec) {
    const k = exKey(homeId, ev);
    const existed = executions.get(k);
    if (existed) return { record: existed, reused: true };
    executions.set(k, rec);
    return { record: rec, reused: false };
  }

  function settle(key, record) {
    if (settlements.has(key)) return { record: settlements.get(key), reused: true };
    settlements.set(key, record);
    return { record, reused: false };
  }
  function getSettlement(key) {
    return settlements.get(key) || null;
  }

  // 月度账单视角：该家庭当月所有事件（含已撤销/已退出/失败/已结算）的执行视图
  function monthlyEvents(homeId, year, month) {
    const out = [];
    for (const en of enrollments.values()) {
      if (en.homeId !== homeId) continue;
      const plan = plans.get(en.planId);
      if (!plan || plan.year !== year || plan.month !== month) continue;
      for (const ev of plan.events) {
        const ex = executions.get(exKey(homeId, ev));
        // 已执行（成功/失败）的结果是历史事实：即使计划随后撤销也保留状态与金额；
        // 尚未执行的事件才随计划撤销/家庭退出而失效，月度按正常规则计算且不结算。
        let status;
        if (ex) status = ex.status;
        else if (plan.status === "revoked") status = "revoked";
        else if (en.status === "withdrawn") status = "withdrawn";
        else status = "enrolled";
        out.push({
          eventKey: ev.eventKey, day: ev.day, type: ev.type,
          window: ev.window, incentive: ev.incentive,
          planId: plan.id, planName: plan.name,
          enrollment: en.status, planStatus: plan.status,
          status,
          reward: ex ? ex.reward : null,
          responded_kwh: ex ? ex.responded_kwh : null,
        });
      }
    }
    return out.sort((a, b) => a.day - b.day);
  }

  return {
    publishPlan, getPlan, listPlans, revokePlan,
    enroll, unenroll, isEnrolled, listEnrollments,
    activeEventMap, monthlyEvents, findDayEvent,
    getExecution, freezeExecution,
    settle, getSettlement,
  };
}

// 单例台账（进程内持久，随服务生命周期）
const store = createStore();

// 执行一次 DR 事件（运营方/家庭预演或事件结算用）：
//   - 同一 (home, event) 重复执行返回首次冻结结果，不重复结算；
//   - telemetryFault=true 模拟量测失败：记录 failed，奖励 0，且不再重试成功；
//   - 独立执行的天气取月度确定性序列（seed 缺省 11），SOC 按家庭电池配置初态，
//     月度账单只采信事件日的奖励金额并冻结，能量电费仍按账单链路逐日结转计算。
function runEvent(homeId, input, storeIn) {
  const S = storeIn || store;
  const body = input || {};
  const plan = S.getPlan(body.planId);
  if (!plan) throw new Error(`计划 ${body.planId} 不存在`);
  if (!S.isEnrolled(homeId, body.planId)) {
    throw new Error(`家庭 ${homeId} 未报名该计划或报名已失效`);
  }
  const day = Number(body.day);
  const ev = plan.events.find(e => e.day === day);
  if (!ev) throw new Error(`计划 ${body.planId} 在 ${day} 日无 DR 事件`);

  const existed = S.getExecution(homeId, ev);
  if (existed) return { ...existed, idempotent: true };

  const opts = body.household || {};
  const seed = body.seed == null ? 11 : body.seed;
  const w = sim.dayWeather(seed, day);
  const dayOpts = { ...opts, month: plan.month, day, weather: body.weather == null ? w : body.weather };
  const carry = opts.battery && opts.battery.soc0 != null ? opts.battery.soc0 : null;
  const endValue = Math.min.apply(null, tariff.hourlyPrices(opts.tou));

  const idemKey = `exec:${homeId}:${ev.eventKey}`;
  const recBase = {
    homeId, planId: plan.id, planName: plan.name,
    year: plan.year, month: plan.month, day,
    event: { type: ev.type, window: ev.window, incentive: ev.incentive },
    created_at: new Date().toISOString(),
    idempotency_key: idemKey,
  };

  if (body.telemetryFault) {
    // 失败同样冻结入账：奖励 0，后续重复调用只回读，不会再次结算或转为成功
    const failed = {
      ...recBase, status: "failed", reward: 0, responded_kwh: 0,
      reason: body.faultReason || "量测数据缺失，事件执行失败",
    };
    S.freezeExecution(homeId, ev, failed);
    S.settle(idemKey, { at: failed.created_at, kind: "exec", execution: failed });
    return { ...failed, idempotent: false };
  }

  const m = measure(dayOpts, ev, carry, endValue);
  const useBat = m.bat != null && opts.preferNoBat !== true;
  const sc = useBat ? m.bat : m.no_bat;
  const settled = {
    ...recBase,
    status: "settled",
    scenario: useBat ? "bat" : "no_bat",
    responded_kwh: sc.responded_kwh,
    baseline_grid_kwh: sc.baseline_grid_kwh,
    response_grid_kwh: sc.response_grid_kwh,
    reward: sc.reward,
    energy_delta: sc.energy_delta,
  };
  S.freezeExecution(homeId, ev, settled);
  S.settle(idemKey, { at: settled.created_at, kind: "exec", execution: settled });
  return { ...settled, idempotent: false };
}

// 月度账单链路在事件日的结算入口（幂等）：
//   - ctx 为 store.findDayEvent 的结果；
//   - 撤销/退出且未执行、或量测失败：按正常规则计算，奖励 0，不落成功结算；
//   - 成功事件：先看独立执行是否已冻结奖励，已冻结则以台账金额为准（不重复结算），
//     否则按月链路测算结果入账，同一月账单重跑只回读同一笔。
function settleMonthDay(S, homeId, monthKey, day, ctx, m) {
  const ev = ctx.ev;
  const idemKey = `month:${monthKey}:${homeId}:${ev.eventKey}`;
  const prev = S.getSettlement(idemKey);
  if (prev) return { ...prev.result, idempotent: true };

  const base = {
    homeId, day,
    planId: ctx.plan.id, planName: ctx.plan.name,
    type: ev.type, window: ev.window, incentive: ev.incentive,
  };
  const execRec = S.getExecution(homeId, ev);

  let result;
  if (execRec && execRec.status === "failed") {
    result = { ...base, status: "failed", scenario: null, responded_kwh: 0, reward: 0, reward_no_bat: 0, reward_bat: 0, energy_delta: null, baseline_grid_kwh: null, response_grid_kwh: null, reason: execRec.reason };
  } else if (!ctx.active && !execRec) {
    result = { ...base, status: ctx.plan.status === "revoked" ? "revoked" : "withdrawn", scenario: null, responded_kwh: 0, reward: 0, reward_no_bat: 0, reward_bat: 0, energy_delta: null, baseline_grid_kwh: null, response_grid_kwh: null };
  } else {
    // 单日事件或多事件合并调度，均按本事件自身窗口/单价从基线/响应曲线归因
    const sub = windowScenario(m.baseline, m.response, ev.hours, ev.type, ev.incentive);
    const hasBat = !!sub.bat;
    const noBatSc = sub.no_bat;
    const batSc = hasBat ? sub.bat : null;
    const frozen = execRec && execRec.status === "settled";
    // 独立执行已冻结的奖励优先采信，保证"事件结算 → 账单回写"金额一致；
    // 冻结时按当时执行口径回读，另一口径仍取本月链路测算值。
    result = {
      ...base, status: "settled",
      scenario: hasBat ? "bat" : "no_bat",
      baseline_grid_kwh: hasBat ? batSc.baseline_grid_kwh : noBatSc.baseline_grid_kwh,
      response_grid_kwh: hasBat ? batSc.response_grid_kwh : noBatSc.response_grid_kwh,
      responded_kwh: frozen ? execRec.responded_kwh : (hasBat ? batSc.responded_kwh : noBatSc.responded_kwh),
      reward: frozen ? execRec.reward : (hasBat ? batSc.reward : noBatSc.reward),
      // 两种口径都留底：月度账单按家庭实际配置（无/含电池）取对应金额
      reward_no_bat: frozen && execRec.scenario === "no_bat" ? execRec.reward : noBatSc.reward,
      reward_bat: hasBat ? (frozen && execRec.scenario === "bat" ? execRec.reward : batSc.reward) : 0,
      energy_delta: hasBat ? batSc.energy_delta : noBatSc.energy_delta,
    };
  }
  S.settle(idemKey, { at: new Date().toISOString(), kind: "month", result });
  return { ...result, idempotent: false };
}

module.exports = {
  createStore,
  store,
  normalizeEvent,
  signalPrices,
  mergeSignals,
  windowHours,
  measure,
  measureWithSignal,
  windowScenario,
  runEvent,
  settleMonthDay,
};
