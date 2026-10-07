const API = {
  async _req(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = j.error || j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  },
  system() { return this._req("/api/system"); },
  simulate(params) {
    return this._req("/api/simulate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  },
  month(params) {
    return this._req("/api/month", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  },
  drPlans() { return this._req("/api/dr/plans"); },
  drPublish(plan) {
    return this._req("/api/dr/plans", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan),
    });
  },
  drEnroll(planId, body) {
    return this._req(`/api/dr/plans/${encodeURIComponent(planId)}/enroll`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  },
  drCancelEnroll(planId, homeId) {
    return this._req(`/api/dr/plans/${encodeURIComponent(planId)}/enroll/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeId }),
    });
  },
  drSettle(planId, homeId) {
    return this._req(`/api/dr/plans/${encodeURIComponent(planId)}/settle`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeId }),
    });
  },
  drBill(planId, homeId) {
    return this._req(`/api/dr/plans/${encodeURIComponent(planId)}/bill?homeId=${encodeURIComponent(homeId)}`);
  },
  drPreview(body) {
    return this._req("/api/dr/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};
