Component({
  properties: {
    active: {
      type: String,
      value: "collect"
    }
  },

  methods: {
    switchTab(event) {
      const target = event.currentTarget.dataset.target;
      if (!target || target === this.data.active) return;

      const routes = {
        collect: "/pages/index/index",
        chat: "/pages/chat/chat",
        mine: "/pages/settings/settings"
      };
      const url = routes[target];
      if (!url) return;
      wx.redirectTo({ url });
    }
  }
});
