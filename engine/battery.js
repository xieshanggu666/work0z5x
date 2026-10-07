"use strict";

function r3(x) {
  return Math.round(x * 1000) / 1000;
}

function optimizeBattery({ load, solar, price, objPrice, feed, capKwh, maxKw, eff, soc0, endValue }) {
  const H = 24;
  const n = 21;
  const step = capKwh / (n - 1);
  const socOf = i => i * step;
  const INF = Infinity;
  const init = Math.max(0, Math.min(capKwh, soc0 == null ? capKwh / 2 : soc0));
  const eff2 = eff || 0.9;
  const maxP = Math.max(0, maxKw || 0);
  // 日终残余电量的单位残值（元/kWh）：次日可按此价格回补，避免把存量电当成
  // 零成本放空套利。默认 0 保持原有单日行为；月度逐日结转时传入当日谷价。
  const endV = endValue || 0;
  // DP 寻优所用价格（调度信号价）：需求响应事件期间峰段叠加激励/谷段压低，
  // 使电池按激励信号安排充放；缺省与实际结算价 price 一致，保持原行为。
  const obj = objPrice || price;

  const i0 = Math.max(0, Math.min(n - 1, Math.round(init / step)));
  let dp = new Array(n).fill(INF);
  dp[i0] = 0;
  const parents = [];

  for (let h = 0; h < H; h++) {
    const ndp = new Array(n).fill(INF);
    const par = new Array(n).fill(-1);
    const chActs = new Array(n).fill(0);
    const disActs = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const cur = dp[i];
      if (!isFinite(cur)) continue;
      const soc = socOf(i);
      for (let j = 0; j < n; j++) {
        const d = socOf(j) - soc;
        let ch = 0;
        let dis = 0;
        if (d > 1e-12) ch = d / eff2;
        else if (d < -1e-12) dis = -d;
        if (ch > maxP + 1e-9 || dis > maxP + 1e-9) continue;
        const netLoad = Math.max(0, load[h] - dis * eff2);
        const gridIn = Math.max(0, netLoad + ch - solar[h]);
        const exp = Math.max(0, solar[h] - netLoad - ch);
        // DP 按调度信号价 obj 寻优；实际购电成本（真实分时电价）在回溯出最优路径后另算
        const v = cur + obj[h] * gridIn - feed * exp;
        if (v < ndp[j] - 1e-9) {
          ndp[j] = v;
          par[j] = i;
          chActs[j] = ch;
          disActs[j] = dis;
        }
      }
    }
    dp = ndp;
    parents.push({ par, chActs, disActs });
  }

  // 选取（能量电费 − 终态残值）最小的末态；残值保证日终电量不会被无偿抽干
  let j = 0;
  for (let i = 1; i < n; i++) {
    if (dp[i] - endV * socOf(i) < dp[j] - endV * socOf(j)) j = i;
  }
  const dpTotal = dp[j] - endV * socOf(j);

  const ch = new Array(H).fill(0);
  const dis = new Array(H).fill(0);
  const soc = new Array(H + 1).fill(0);
  soc[H] = socOf(j);
  for (let h = H - 1; h >= 0; h--) {
    const p = parents[h];
    ch[h] = p.chActs[j];
    dis[h] = p.disActs[j];
    j = p.par[j];
    soc[h] = socOf(j);
  }
  soc[0] = socOf(j);

  const hours = [];
  let kwhBuy = 0;
  let kwhExport = 0;
  let actualCost = 0;
  for (let h = 0; h < H; h++) {
    const netLoad = Math.max(0, load[h] - dis[h] * eff2);
    const gridIn = Math.max(0, netLoad + ch[h] - solar[h]);
    const exp = Math.max(0, solar[h] - netLoad - ch[h]);
    kwhBuy += gridIn;
    kwhExport += exp;
    // DP 值是调度信号价口径，仅用于选路；实际购电支出沿回溯路径按真实电价另算。
    // 信号价缺省等于真实电价时，累加项与逐时 DP 转移完全相同，结果逐分一致。
    actualCost += price[h] * gridIn - feed * exp;
    hours.push({
      h,
      ch: r3(ch[h]),
      dis: r3(dis[h]),
      soc: r3(soc[h] / capKwh),
      grid_in: r3(gridIn),
      export: r3(exp),
      net_load: r3(netLoad),
    });
  }
  const endSoc = socOf(j);
  const total = actualCost - endV * endSoc;
  return { hours, cost: total, obj_cost: dpTotal, kwh_buy: r3(kwhBuy), kwh_export: r3(kwhExport), soc_start_kwh: r3(socOf(i0)), soc_end_kwh: r3(endSoc) };
}

module.exports = { optimizeBattery };
