const Charts = {
  _fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    return { ctx, w: r.width, h: r.height };
  },
  _axes(ctx, w, h, pad, lo, hi) {
    ctx.strokeStyle = "#2b3d33";
    ctx.strokeRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
    ctx.fillStyle = "#6d8378";
    ctx.font = "10px monospace";
    for (let g = 0; g <= 4; g++) {
      const gy = pad.t + g * (h - pad.t - pad.b) / 4;
      const val = hi - (hi - lo) * g / 4;
      ctx.strokeStyle = "#1c2a22";
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(w - pad.r, gy); ctx.stroke();
      ctx.fillText(val.toFixed(2), 4, gy + 3);
    }
  },
  bars(canvas, series, opts) {
    const { ctx, w, h } = this._fit(canvas);
    if (!series.length) return;
    const o = opts || {};
    const pad = { l: 50, r: 8, t: 8, b: 20 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const lo = Math.min(0, ...series.map(d => d[1]));
    const hi = Math.max(...series.map(d => d[1]));
    const range = hi - lo || 1;
    const bw = Math.max(2, pw / series.length * 0.7);
    this._axes(ctx, w, h, pad, lo, hi);
    series.forEach((d, i) => {
      const x = pad.l + i * (pw / series.length);
      const y = d[1] >= 0 ? pad.t + (1 - d[1] / range) * ph : pad.t + ph * (1 - d[1] / range);
      const bh = Math.abs(d[1]) / range * ph;
      ctx.fillStyle = o.colors ? o.colors[i % o.colors.length] : (d[1] >= 0 ? o.posColor || "#35c97f" : o.negColor || "#ff5f56");
      ctx.fillRect(x, Math.min(y, pad.t + ph), bw, bh);
    });
    for (let i = 0; i < series.length; i += 2) {
      ctx.fillStyle = "#6d8378";
      ctx.font = "10px monospace";
      ctx.fillText(String(i), pad.l + i * (pw / series.length) + bw / 2 - 4, h - 6);
    }
  },
  lines(canvas, sets, opts) {
    const { ctx, w, h } = this._fit(canvas);
    const o = opts || {};
    if (!sets.length) return;
    const pad = { l: 50, r: 8, t: 8, b: 20 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const all = sets.flatMap(s => s.data.map(d => d[1]));
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pr = (hi - lo) * 0.1 || 1;
    lo -= pr; hi += pr;
    const range = hi - lo || 1;
    this._axes(ctx, w, h, pad, lo, hi);
    const n = sets[0].data.length;
    const x = i => pad.l + (n === 1 ? pw / 2 : i * (pw / (n - 1)));
    const y = v => pad.t + (1 - (v - lo) / range) * ph;
    sets.forEach(s => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.6;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      s.data.forEach((d, i) => {
        const px = x(i), py = y(d[1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  },
  legend(canvas, items) {
    const { ctx, w } = this._fit(canvas);
    let cx = 8;
    ctx.font = "11px sans-serif";
    for (const it of items) {
      ctx.fillStyle = it.color;
      ctx.fillRect(cx, 6, 14, 4);
      ctx.fillStyle = "#93a89c";
      ctx.fillText(it.name, cx + 18, 11);
      cx += 18 + ctx.measureText(it.name).width + 14;
    }
  },
};
