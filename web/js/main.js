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
      drHome: "home-1",
      drPlans: [],
      drPlanId: "",
      drBill: null,
      drBusy: false,
      drMsg: "",
      drMsgKind: "",
    };
  },
  computed: {
    drPlan() { return this.drPlans.find(p => p.id === this.drPlanId) || null; },
    drFull() { return this.drBill && this.drBill.bill ? this.drBill.bill : null; },
    billStatusText() {
      const m = {
        settled_success: "✅ 已结算",
        settled_failed: "⚠ 响应失败",
        settled_no_event: "无事件",
        canceled: "已撤销·未结算",
      };
      return m[this.drBill ? this.drBill.status : ""] || this.drBill.status;
    },
    billStatusClass() {
      return this.drBill && this.drBill.status === "settled_success" ? "up" : "";
    },
  },
  methods: {
    // 当前场景参数（月度账单/需求响应共用，保证两条链路同口径）
    scenarioBody(days) {
      const body = {
        month: this.sc.month,
        capacity: this.sc.capacity,
        feed: this.sc.feed,
        shiftableIds: this.sc.shiftableIds,
      };
      if (days) body.days = days;
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
    async loadPlans() {
      try {
        const r = await API.drPlans();
        this.drPlans = r.plans || [];
        if (!this.drPlanId && this.drPlans.length) this.drPlanId = this.drPlans[0].id;
      } catch (e) {}
    },
    drNote(msg, ok) {
      this.drMsg = msg;
      this.drMsgKind = ok ? "ok" : "err";
    },
    async drEnroll() {
      this.drBusy = true;
      try {
        // 报名即锁定当前页面的家庭场景（家电/电池配置），结算按此快照复核
        await API.drEnroll(this.drPlanId, {
          homeId: this.drHome,
          shiftableIds: this.sc.shiftableIds,
          battery: this.sc.battery.enabled,
          scenario: this.scenarioBody(30),
        });
        this.drBill = null;
        this.drNote("报名成功：已联动勾选的可迁移家电" + (this.sc.battery.enabled ? "与电池调度" : "") + "，等待执行结算。", true);
      } catch (e) {
        this.drNote("报名失败：" + e.message, false);
      } finally {
        this.drBusy = false;
      }
    },
    async drCancel() {
      this.drBusy = true;
      try {
        await API.drCancelEnroll(this.drPlanId, this.drHome);
        this.drBill = null;
        this.drNote("已撤销报名：需求响应不再结算，旧月度账单仍按原规则计算。", true);
      } catch (e) {
        this.drNote("撤销失败：" + e.message, false);
      } finally {
        this.drBusy = false;
        await this.loadPlans();
      }
    },
    async drSettle() {
      this.drBusy = true;
      try {
        const r = await API.drSettle(this.drPlanId, this.drHome);
        this.drBill = r.bill;
        if (r.repeated) this.drNote("该结算单已存在，返回原单（幂等）：奖励未重复发放。", false);
        else if (r.bill.status === "settled_success") this.drNote("执行成功：奖励已回写月度账单与节省统计。", true);
        else if (r.bill.status === "settled_failed") this.drNote("响应未达标：本次失败不发奖，且不会重复结算。", false);
        else this.drNote("计划或报名已撤销：零奖励、不产生冲减。", false);
        this.$nextTick(() => this.renderDrChart());
      } catch (e) {
        this.drNote("结算失败：" + e.message, false);
      } finally {
        this.drBusy = false;
      }
    },
    renderDrChart() {
      if (!this.$refs.drChart || !this.drFull) return;
      const d = this.drFull.dr.dr_daily;
      const bat = this.drFull.cost_bat != null;
      Charts.lines(this.$refs.drChart, [
        { name: "原账单", color: "#4da3ff", dash: [4, 4], data: d.map(x => [x.day, bat ? x.cost_bat : x.cost_no_bat]) },
        { name: "联动后实付", color: "#35c97f", data: d.map(x => [x.day, (bat ? x.dr_cost_bat : x.dr_cost_no_bat) - (bat ? x.reward_bat : x.reward_no_bat)]) },
        { name: "当日奖励", color: "#ffb84d", data: d.map(x => [x.day, bat ? x.reward_bat : x.reward_no_bat]) },
      ]);
    },
    async runDay() {
      this.busy = true;
      this.month = null;
      try {
        const body = this.scenarioBody();
        body.weather = this.sc.weather;
        const r = await API.simulate(body);
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
        const body = this.scenarioBody(30);
        this.month = await API.month(body);
        if (!this.result) await this.runDay();
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
  },
  async mounted() {
    try {
      const sys = await API.system();
      this.shiftables = sys.shiftables || [];
    } catch (e) {}
    this.loadPlans();
    this.runDay();
  },
});

app.mount("#app");
