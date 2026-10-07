"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const tariff = require("./engine/tariff");
const solar = require("./engine/solar");
const loads = require("./engine/loads");
const sim = require("./engine/sim");
const dr = require("./engine/dr");

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

    // ------------------------- 电网需求响应 -------------------------
    // 运营方发布峰谷激励计划
    if (p === "/api/dr/plans" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      return json(res, 200, dr.store.publishPlan(body || {}));
    }
    if (p === "/api/dr/plans" && req.method === "GET") {
      return json(res, 200, { plans: dr.store.listPlans() });
    }
    // 撤销计划（GET 仅查询）
    if (p.startsWith("/api/dr/plans/") && p.endsWith("/revoke") && req.method === "POST") {
      const planId = decodeURIComponent(p.slice("/api/dr/plans/".length, -"/revoke".length));
      return json(res, 200, dr.store.revokePlan(planId));
    }
    // 家庭报名 / 退出
    if (p === "/api/dr/enroll" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) || {};
      if (!body.homeId || !body.planId) return json(res, 400, { error: "homeId 与 planId 必填" });
      return json(res, 200, dr.store.enroll(body.homeId, body.planId));
    }
    if (p === "/api/dr/unenroll" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) || {};
      if (!body.homeId || !body.planId) return json(res, 400, { error: "homeId 与 planId 必填" });
      return json(res, 200, dr.store.unenroll(body.homeId, body.planId));
    }
    // 家庭视角：报名情况与某月事件台账（含撤销/失败/已结算）
    if (p.startsWith("/api/dr/home/") && req.method === "GET") {
      const homeId = decodeURIComponent(p.slice("/api/dr/home/".length).split("?")[0]);
      const year = Number(url.searchParams.get("year") || new Date().getFullYear());
      const month = Number(url.searchParams.get("month") || 7);
      return json(res, 200, {
        homeId,
        enrollments: dr.store.listEnrollments(homeId),
        events: dr.store.monthlyEvents(homeId, year, month),
      });
    }
    // 执行某次 DR 事件（量测、联动调度、冻结结算；重复调用幂等不重复结算）
    if (p === "/api/dr/execute" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) || {};
      if (!body.homeId) return json(res, 400, { error: "homeId 必填" });
      return json(res, 200, dr.runEvent(body.homeId, body));
    }
    // DR 事件日单日预览（不结算、不写台账）：基线 vs 响应对比
    if (p === "/api/dr/preview" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) || {};
      const event = dr.normalizeEvent(body.event || {
        type: body.type, start: body.start, end: body.end, incentive: body.incentive,
      });
      const household = body.household || {};
      const carry = household.battery && household.battery.soc0 != null ? household.battery.soc0 : null;
      const valley = Math.min.apply(null, tariff.hourlyPrices(household.tou));
      const m = dr.measure(household, event, carry, valley);
      return json(res, 200, {
        event: { type: event.type, window: event.window, incentive: event.incentive, hours: event.hours },
        signal: m.signal,
        no_bat: m.no_bat,
        bat: m.bat,
        response_hours: m.response.hours,
        plan: m.response.plan,
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
    if (p === "/api/solar" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const s = solar.solarProfile(body.month || 7, body.day || 15, body.capacity || 5, body.weather == null ? 0.8 : body.weather);
      return json(res, 200, { hours: s.map((v, h) => [h, Math.round(v * 1000) / 1000]) });
    }

    let f = p === "/" ? "/index.html" : p;
    if (f.startsWith("/static/")) f = f.slice("/static".length); // 前端静态资源前缀
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`home-energy running at http://127.0.0.1:${PORT}`);
});
