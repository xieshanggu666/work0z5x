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
};
