const { createApp } = Vue;

const app = createApp({
  data() {
    return {
      busy: false,
      shiftables: [],
      sc: {
        month: 7,
        weather: 0.8,
        capacity: 5,
        feed: 0.4,
        battery: { enabled: true, capKwh: 8, maxKw: 3, eff: 0.9, soc0: 0.5 },
        shiftableIds: ["washer", "heater", "dish", "ev"],
      },
      result: null,
      plan: [],
      month: null,
      // 需求响应
      dr: {
        homeId: "home-001",
        plans: [],
        home: null,
        execDay: 15,
        fault: false,
        form: { name: "", month: 7, days: "15", type: "peak", start: 18, end: 21, incentive: 0.8 },
      },
    };
  },
  methods: {
    stText(s) {
      return { settled: "已结算", failed: "失败", revoked: "已撤销", withdrawn: "已退出", enrolled: "待执行" }[s] || s;
    },
    householdBody() {
      const body = {
        month: this.sc.month,
        capacity: this.sc.capacity,
        feed: this.sc.feed,
        shiftableIds: this.sc.shiftableIds,
      };
      if (this.sc.battery.enabled) {
        body.battery = {
          capKwh: this.sc.battery.capKwh,
          maxKw: this.sc.battery.maxKw,
          eff: this.sc.battery.eff,
          soc0: this.sc.battery.soc0,
        };
      }
      return body;
    },
    async runDay() {
      this.busy = true;
      this.month = null;
      try {
        const r = await API.simulate(this.householdBody());
        this.result = r;
        this.plan = r.plan || [];
        this.$nextTick(() => {
          const hours = r.hours;
          Charts.lines(this.$refs.powerChart, [
            { name: "负荷", color: "#ffd166", data: hours.map(x => [x.h, x.load]) },
            { name: "光伏", color: "#ffb84d", data: hours.map(x => [x.h, x.solar]) },
            { name: "电网(无电池)", color: "#4da3ff", dash: [4, 4], data: hours.map(x => [x.h, x.grid_no_bat]) },
            ...(r.cost_bat != null ? [{ name: "电网(含电池)", color: "#35c97f", data: hours.map(x => [x.h, x.grid_bat]) }] : []),
          ]);
          if (this.$refs.batChart) {
            Charts.lines(this.$refs.batChart, [
              { name: "SOC", color: "#35c97f", data: hours.map(x => [x.h, x.soc]) },
              { name: "充电", color: "#4da3ff", data: hours.map(x => [x.h, x.ch]) },
              { name: "放电", color: "#ff5f56", data: hours.map(x => [x.h, x.dis]) },
            ]);
          }
          Charts.bars(this.$refs.priceChart, hours.map(x => [x.h, x.price]), {
            colors: hours.map(x => x.price >= 1 ? "#ff5f56" : x.price <= 0.4 ? "#4da3ff" : "#ffd166"),
          });
        });
      } catch (e) {
        alert("模拟失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async runMonth() {
      this.busy = true;
      try {
        // homeId 触发需求响应回写：事件日按报名计划联动调度、幂等结算奖励
        const body = { ...this.householdBody(), days: 30, homeId: this.dr.homeId };
        this.month = await API.month(body);
        if (!this.result) await this.runDay();
        await this.refreshHome(false);
        this.$nextTick(() => {
          if (this.$refs.monthChart) {
            const batPts = this.month.daily
              .filter(d => d.cost_bat != null)
              .map(d => [d.day, d.cost_bat]);
            Charts.lines(this.$refs.monthChart, [
              { name: "无储能", color: "#4da3ff", data: this.month.daily.map(d => [d.day, d.cost_no_bat]) },
              ...(batPts.length ? [{ name: "含储能", color: "#35c97f", data: batPts }] : []),
            ]);
          }
        });
      } catch (e) {
        alert("月度模拟失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },

    // --------------------------- 需求响应 ---------------------------
    async loadPlans() {
      try {
        const r = await API.drListPlans();
        this.dr.plans = r.plans || [];
      } catch (e) { /* ignore */ }
    },
    async refreshHome(showErr = true) {
      try {
        this.dr.home = await API.drHome(this.dr.homeId, new Date().getFullYear(), this.sc.month);
      } catch (e) {
        if (showErr) alert("查询失败：" + e.message);
      }
    },
    async publishPlan() {
      const f = this.dr.form;
      const days = String(f.days).split(",").map(s => Number(s.trim())).filter(n => n >= 1 && n <= 31);
      if (!f.name || !days.length || f.end <= f.start) {
        alert("请填写计划名、合法日期与窗口（end > start）");
        return;
      }
      this.busy = true;
      try {
        const event = { type: f.type, start: f.start, end: f.end, incentive: f.incentive };
        const r = await API.drPublishPlan({
          name: f.name, month: this.sc.month, days,
          events: days.map(() => ({ ...event })),
        });
        this.dr.form.name = "";
        await this.loadPlans();
        alert(`计划 ${r.id} 已发布，${r.events.length} 个事件`);
      } catch (e) {
        alert("发布失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    async enroll(planId) {
      this.busy = true;
      try {
        await API.drEnroll(this.dr.homeId, planId);
        await this.refreshHome();
        alert("报名成功");
      } catch (e) { alert("报名失败：" + e.message); } finally { this.busy = false; }
    },
    async unenroll(planId) {
      this.busy = true;
      try {
        await API.drUnenroll(this.dr.homeId, planId);
        await this.refreshHome();
      } catch (e) { alert("退出失败：" + e.message); } finally { this.busy = false; }
    },
    async revoke(planId) {
      if (!confirm("撤销后未执行事件不再联动结算，已结算奖励保留。确认撤销？")) return;
      this.busy = true;
      try {
        await API.drRevokePlan(planId);
        await this.loadPlans();
        await this.refreshHome();
      } catch (e) { alert("撤销失败：" + e.message); } finally { this.busy = false; }
    },
    async executeEvent() {
      this.busy = true;
      try {
        // 找到当日所属计划（按当月事件台账或计划列表匹配）
        const plan = this._findPlanOfDay(this.dr.execDay);
        if (!plan) { alert(`当日（${this.dr.execDay}）没有已报名的生效事件`); return; }
        const r = await API.drExecute({
          homeId: this.dr.homeId,
          planId: plan.id,
          day: this.dr.execDay,
          telemetryFault: this.dr.fault,
          household: this.householdBody(),
        });
        await this.refreshHome();
        if (r.status === "settled") {
          alert(`${r.idempotent ? "（幂等回读）" : ""}结算完成：响应 ${r.responded_kwh} kWh，奖励 ${r.reward} 元`);
        } else {
          alert(`${r.idempotent ? "（幂等回读）" : ""}事件失败：${r.reason || ""}；奖励 0，不补结`);
        }
      } catch (e) {
        alert("执行失败：" + e.message);
      } finally {
        this.busy = false;
      }
    },
    _findPlanOfDay(day) {
      const home = this.dr.home;
      if (home && home.events) {
        const e = home.events.find(x => x.day === day);
        if (e) return { id: e.planId };
      }
      const hit = this.dr.plans.find(p => p.status === "published" &&
        p.month === this.sc.month && p.events.some(ev => ev.day === day));
      return hit || null;
    },
  },
  async mounted() {
    try {
      const sys = await API.system();
      this.shiftables = sys.shiftables || [];
    } catch (e) {}
    await this.loadPlans();
    await this.refreshHome(false);
    this.runDay();
  },
});

app.mount("#app");
