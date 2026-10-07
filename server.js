"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const tariff = require("./engine/tariff");
const solar = require("./engine/solar");
const loads = require("./engine/loads");
const sim = require("./engine/sim");

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
