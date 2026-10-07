"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const tariff = require("./engine/tariff");
const solar = require("./engine/solar");
const loads = require("./engine/loads");
const sim = require("./engine/sim");
const dr = require("./engine/dr");
const { DrStore } = require("./engine/dr_store");

const store = new DrStore();
// 默认发布一份夏季峰谷激励计划（削峰 19-21 点 + 填谷 2-5 点）
store.publishPlan({
  name: "夏季峰谷需求响应（7月）",
  startDay: 1,
  endDay: 30,
  events: [
    { kind: "peak_shave", start: 19, end: 21, incentive: 2.0 },
    { kind: "valley_fill", start: 2, end: 5, incentive: 0.3 },
  ],
}, { month: 7, days: 30, capacity: 5, feed: 0.4, battery: { capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 } });

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8074", 10);
const WEB = path.join(__dirname, "web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 2e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/system" && req.method === "GET") {
      return json(res, 200, {
        name: "home-energy",
        version: 1,
        title: "家庭能源与电费优化系统",
        shiftables: loads.SHIFTABLE,
        tou: tariff.DEFAULT_TOU,
      });
    }
    if (p === "/api/simulate" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const r = sim.simulateDay(body || {});
      return json(res, 200, r);
    }
    if (p === "/api/month" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const r = sim.monthBill(body || {});
      return json(res, 200, r);
    }

    // ---------------- 需求响应计划 ----------------

    // 计划列表
    if (p === "/api/dr/plans" && req.method === "GET") {
      return json(res, 200, { plans: store.listPlans() });
    }
    // 运营方发布峰谷激励计划
    if (p === "/api/dr/plans" && req.method === "POST") {
      const body = await readJson(req);
      let rec;
      try {
        rec = store.publishPlan(body, body.scenario || null);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      return json(res, 200, rec);
    }
    // 家庭报名（可指定联动家电与是否联动电池）
    const enrollMatch = p.match(/^\/api\/dr\/plans\/([^/]+)\/enroll$/);
    if (enrollMatch && req.method === "POST") {
      const body = await readJson(req);
      const rec = store.enroll(decodeURIComponent(enrollMatch[1]), body.homeId, body);
      return json(res, 200, rec);
    }
    // 家庭撤销报名（幂等；成功结算后拒绝）
    const cancelEnrollMatch = p.match(/^\/api\/dr\/plans\/([^/]+)\/enroll\/cancel$/);
    if (cancelEnrollMatch && req.method === "POST") {
      const body = await readJson(req);
      const rec = store.cancelEnrollment(decodeURIComponent(cancelEnrollMatch[1]), body.homeId);
      return json(res, 200, rec);
    }
    // 撤销计划（严格匹配 /plans/:id/cancel，避免吞掉 /enroll/cancel）
    const cancelPlanMatch = p.match(/^\/api\/dr\/plans\/([^/]+)\/cancel$/);
    if (cancelPlanMatch && req.method === "POST") {
      return json(res, 200, store.cancelPlan(decodeURIComponent(cancelPlanMatch[1])));
    }
    // 计划详情
    const planDetailMatch = p.match(/^\/api\/dr\/plans\/([^/]+)$/);
    if (planDetailMatch && req.method === "GET") {
      return json(res, 200, store.getPlan(decodeURIComponent(planDetailMatch[1])));
    }
    // 执行结算并回写月度账单（幂等：重复调用返回同一结算单，不重复发奖）
    const settleMatch = p.match(/^\/api\/dr\/plans\/([^/]+)\/settle$/);
    if (settleMatch && req.method === "POST") {
      const body = await readJson(req);
      const out = store.settle(decodeURIComponent(settleMatch[1]), body.homeId);
      return json(res, 200, out);
    }
    // 查询结算单
    const billMatch = p.match(/^\/api\/dr\/plans\/([^/]+)\/bill$/);
    if (billMatch && req.method === "GET") {
      const homeId = url.searchParams.get("homeId") || "home-1";
      return json(res, 200, store.getBill(decodeURIComponent(billMatch[1]), homeId));
    }
    // 单日联动预览（不结算、不留痕）
    if (p === "/api/dr/preview" && req.method === "POST") {
      const body = await readJson(req);
      const plan = body.plan || (body.planId ? store.getPlan(body.planId) : null);
      if (!plan) return json(res, 400, { error: "需要提供 plan 或 planId" });
      const evalR = dr.evaluateDay(body.scenario || {}, plan, body.enrollment || {});
      return json(res, 200, {
        reward_no_bat: evalR.reward_no_bat,
        reward_bat: evalR.reward_bat,
        has_bat: evalR.has_bat,
        events: evalR.events,
        dr_hours: evalR.dr_day.hours,
        base_hours: evalR.base_day.hours,
        plan: evalR.dr_day.plan,
      });
    }
    if (p === "/api/solar" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const s = solar.solarProfile(body.month || 7, body.day || 15, body.capacity || 5, body.weather == null ? 0.8 : body.weather);
      return json(res, 200, { hours: s.map((v, h) => [h, Math.round(v * 1000) / 1000]) });
    }

    let f = p === "/" ? "/index.html" : p;
    // 前端资源以 /static/ 前缀引用，实际文件位于 web 根目录
    if (f.startsWith("/static/")) f = f.slice("/static".length);
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`home-energy running at http://127.0.0.1:${PORT}`);
});
