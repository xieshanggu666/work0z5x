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
    };
  },
  methods: {
    async runDay() {
      this.busy = true;
      this.month = null;
      try {
        const body = {
          month: this.sc.month,
          weather: this.sc.weather,
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
        const body = {
          month: this.sc.month,
          capacity: this.sc.capacity,
          feed: this.sc.feed,
          shiftableIds: this.sc.shiftableIds,
          days: 30,
        };
        if (this.sc.battery.enabled) {
          body.battery = {
            capKwh: this.sc.battery.capKwh,
            maxKw: this.sc.battery.maxKw,
            eff: this.sc.battery.eff,
            soc0: this.sc.battery.soc0,
          };
        }
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
    this.runDay();
  },
});

app.mount("#app");
