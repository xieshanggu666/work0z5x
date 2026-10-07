"use strict";

const dr = require("./dr");

// ---------------------------------------------------------------------------
// 需求响应计划内存状态机（进程重启即清空，演示用）
//
// 计划生命周期： active ──cancel──▶ canceled
// 家庭报名状态： enrolled / canceled（同一家庭只能持有一份有效报名）
// 结算生命周期： 首次 settle 生成不可变结算单；重复调用直接返回同一结算单
//               （撤销 / 失败 / 成功后都不会重复结算、不重复发奖）
// ---------------------------------------------------------------------------

class DrStore {
  constructor() {
    this.plans = new Map();     // planId -> 计划记录
    this.enrolls = new Map();   // `${homeId}:${planId}` -> 报名记录
    this.bills = new Map();     // `${homeId}:${planId}` -> 结算单
    this._seq = 0;
  }

  _id(prefix) {
    this._seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this._seq}`;
  }

  _getPlan(planId) {
    const plan = this.plans.get(planId);
    if (!plan) throw Object.assign(new Error("需求响应计划不存在"), { status: 404 });
    return plan;
  }

  _key(homeId, planId) {
    return `${homeId || "home-1"}:${planId}`;
  }

  publishPlan(input, scenario) {
    const plan = dr.validatePlan(input || {});
    const sc = scenario || (input && input.scenario) || null;
    const rec = {
      id: input.id || this._id("plan"),
      name: plan.name,
      events: plan.events,
      startDay: plan.startDay,
      endDay: plan.endDay,
      days: plan.days,
      status: "active",
      createdAt: new Date().toISOString(),
      // 运营方发布时锁定模拟场景（月份/光伏/电池/家电配置），结算按报名快照复核
      scenario: sc,
    };
    this.plans.set(rec.id, rec);
    return rec;
  }

  cancelPlan(planId) {
    const plan = this._getPlan(planId);
    // 已有成功结算的计划不允许撤销（奖励已入账，撤销会造成账目不一致）
    for (const [k, bill] of this.bills) {
      if (k.endsWith(`:${planId}`) && bill.status === "settled_success") {
        throw Object.assign(new Error("计划已产生成功结算，不能撤销"), { status: 409 });
      }
    }
    plan.status = "canceled";
    plan.canceledAt = new Date().toISOString();
    // 联动撤销该计划下所有未结算的报名；已有的失败/撤销结算单保持不变（幂等）
    for (const [k, en] of this.enrolls) {
      if (k.endsWith(`:${planId}`) && en.status === "enrolled") en.status = "canceled";
    }
    return plan;
  }

  getPlan(planId) {
    return this._getPlan(planId);
  }

  listPlans() {
    return Array.from(this.plans.values());
  }

  enroll(planId, homeId, body) {
    const plan = this._getPlan(planId);
    if (plan.status !== "active") {
      throw Object.assign(new Error("计划已撤销或关闭，不能报名"), { status: 409 });
    }
    const key = this._key(homeId, planId);
    const exist = this.enrolls.get(key);
    if (exist && exist.status === "enrolled") {
      throw Object.assign(new Error("该家庭已报名此计划，请勿重复报名"), { status: 409 });
    }
    const b = body || {};
    const scenario = b.scenario || plan.scenario || {};
    // 缺省联动"报名场景中启用的全部可迁移家电"；场景未指定则联动全部家电
    const defaultIds = Array.isArray(scenario.shiftableIds) && scenario.shiftableIds.length
      ? scenario.shiftableIds.slice()
      : ["washer", "heater", "dish", "ev"];
    const rec = {
      id: this._id("enroll"),
      homeId: homeId || "home-1",
      planId,
      shiftableIds: Array.isArray(b.shiftableIds) && b.shiftableIds.length
        ? b.shiftableIds.slice()
        : defaultIds,
      // 报名时提交的家庭场景（月度账单以此为准）；缺省沿用计划发布时的场景
      battery: b.battery === false ? false : true,
      scenario: b.scenario || plan.scenario || null,
      status: "enrolled",
      enrolledAt: new Date().toISOString(),
      canceledAt: null,
    };
    this.enrolls.set(key, rec);
    return rec;
  }

  cancelEnrollment(planId, homeId) {
    const plan = this._getPlan(planId);
    const key = this._key(homeId, planId);
    const en = this.enrolls.get(key);
    if (!en) throw Object.assign(new Error("未找到报名记录"), { status: 404 });
    if (en.status === "canceled") return en; // 撤销幂等
    const bill = this.bills.get(key);
    if (bill && bill.status === "settled_success") {
      throw Object.assign(new Error("已成功结算的报名不能撤销"), { status: 409 });
    }
    en.status = "canceled";
    en.canceledAt = new Date().toISOString();
    // 只撤销该家庭自己的报名，不影响计划与其他家庭；计划锁定只阻止"计划级撤销"
    return en;
  }

  getEnrollment(planId, homeId) {
    const en = this.enrolls.get(this._key(homeId, planId));
    if (!en) throw Object.assign(new Error("未找到报名记录"), { status: 404 });
    return en;
  }

  listEnrollments(planId) {
    return Array.from(this.enrolls.values()).filter(e => !planId || e.planId === planId);
  }

  // -------------------------------------------------------------------------
  // 结算：核心防重入口。
  // 1. 已存在结算单 -> 原样返回（无论成功/失败/撤销），绝不二次发奖；
  // 2. 计划撤销 / 报名撤销 -> 生成 status=canceled 的零奖励结算单（首次留痕）；
  // 3. 未报名 -> 404。
  // -------------------------------------------------------------------------
  settle(planId, homeId) {
    const plan = this._getPlan(planId);
    const key = this._key(homeId, planId);
    const cached = this.bills.get(key);
    if (cached) return { bill: cached, repeated: true }; // 幂等：不重复结算

    const en = this.enrolls.get(key);
    if (!en) throw Object.assign(new Error("该家庭未报名此计划"), { status: 404 });

    const canceled = plan.status === "canceled" || en.status === "canceled";
    if (canceled) {
      const bill = this._emptyBill(plan, en, "canceled");
      this.bills.set(key, bill);
      return { bill, repeated: false };
    }

    const scenario = en.scenario || {};
    const result = dr.runMonthDr(scenario, plan, {
      shiftableIds: en.shiftableIds,
      battery: en.battery,
    });
    const bill = {
      id: this._id("bill"),
      homeId: en.homeId,
      planId,
      planName: plan.name,
      status: result.dr.status, // settled_success / settled_failed / settled_no_event
      settledAt: new Date().toISOString(),
      reward: result.dr.reward,
      reward_no_bat: result.dr.reward_no_bat,
      reward_bat: result.dr.reward_bat,
      delivered_events: result.dr.delivered_events,
      failed_events: result.dr.failed_events,
      // 回写月度账单：旧规则账单 + DR 奖励/最终应付/节省统计
      bill: result,
    };
    this.bills.set(key, bill);
    return { bill, repeated: false };
  }

  _emptyBill(plan, en, status) {
    return {
      id: this._id("bill"),
      homeId: en.homeId,
      planId: plan.id,
      planName: plan.name,
      status,
      settledAt: new Date().toISOString(),
      reward: 0,
      reward_no_bat: 0,
      reward_bat: 0,
      delivered_events: 0,
      failed_events: 0,
      bill: null, // 撤销不生成任何账单冲减，旧账单完全不受影响
      note: "计划或报名已撤销，不产生需求响应结算",
    };
  }

  getBill(planId, homeId) {
    const bill = this.bills.get(this._key(homeId, planId));
    if (!bill) throw Object.assign(new Error("尚未结算"), { status: 404 });
    return bill;
  }
}

module.exports = { DrStore };
