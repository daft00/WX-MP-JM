(() => {
  const STORAGE_KEY = "growth-diary-html-prototype-v2";
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const seed = () => ({
    activeUserId: "mom",
    activeFamilyId: "",
    activeChildId: "",
    growthType: "HEIGHT",
    families: [
      { id: "warm", name: "暖暖一家", color: "#E98F72" },
      { id: "grandma-home", name: "外婆的小院", color: "#7FA48B" },
    ],
    users: [
      { id: "mom", name: "妈妈", avatar: "妈" },
      { id: "dad", name: "爸爸", avatar: "爸" },
      { id: "grandma", name: "外婆", avatar: "外" },
    ],
    memberships: [
      { familyId: "warm", userId: "mom", role: "OWNER" },
      { familyId: "warm", userId: "dad", role: "ADMIN" },
      { familyId: "warm", userId: "grandma", role: "MEMBER" },
      { familyId: "grandma-home", userId: "grandma", role: "OWNER" },
      { familyId: "grandma-home", userId: "mom", role: "ADMIN" },
      { familyId: "grandma-home", userId: "dad", role: "MEMBER" },
    ],
    children: [
      { id: "lele", familyId: "warm", name: "乐乐", label: "宝宝", birthday: "2025-10-08", color: "#F0A58A" },
      { id: "tangtang", familyId: "warm", name: "糖糖", label: "姐姐", birthday: "2023-06-18", color: "#D991A2" },
      { id: "anan", familyId: "grandma-home", name: "安安", label: "小表弟", birthday: "2026-02-14", color: "#87AAA0" },
    ],
    records: [
      { id: "r1", familyId: "warm", childId: "lele", creatorId: "mom", kind: "DIARY", title: "清晨的小小微笑", body: "醒来后对着窗边的光笑了很久。今天的阳光和你的笑一样柔软。", date: "2026-09-18", media: "image", tone: "peach" },
      { id: "r2", familyId: "warm", childId: "lele", creatorId: "dad", kind: "MILESTONE", title: "第一次自己翻身", body: "努力了好几次，终于成功翻过来，全家都在为你鼓掌。", date: "2026-09-03", media: "video", event: "第一次翻身", tone: "sage" },
      { id: "r3", familyId: "warm", childId: "lele", creatorId: "mom", kind: "MILESTONE", title: "九月成长记录", body: "体检时记录了新的身高，长得很棒。", date: "2026-09-01", metric: { type: "HEIGHT", value: 72.5, unit: "cm" } },
      { id: "r4", familyId: "warm", childId: "tangtang", creatorId: "grandma", kind: "DIARY", title: "一起去公园", body: "糖糖一路都在认真观察树叶，还捡了一片最喜欢的带回家。", date: "2026-08-28", media: "image", tone: "rose" },
      { id: "r5", familyId: "warm", childId: "tangtang", creatorId: "mom", kind: "MILESTONE", title: "三岁两个月体重", body: "今天在家测量并记录。", date: "2026-08-18", metric: { type: "WEIGHT", value: 14.2, unit: "kg" } },
      { id: "r6", familyId: "warm", childId: "lele", creatorId: "mom", kind: "MILESTONE", title: "八月成长记录", body: "又长高了一点。", date: "2026-08-01", metric: { type: "HEIGHT", value: 70.4, unit: "cm" } },
      { id: "r7", familyId: "grandma-home", childId: "anan", creatorId: "grandma", kind: "DIARY", title: "外婆怀里的午后", body: "吃饱以后安静地睡着了，小院里只有风吹树叶的声音。", date: "2026-09-12", media: "image", tone: "sage" },
    ],
    exports: [{ id: "e1", familyId: "warm", childId: "lele", month: "2026-08", status: "CONFIRMED", parts: 1 }],
  });

  let state = load();
  let entryKind = "DIARY";
  let metricType = "";
  let hasMockMedia = false;
  let toastTimer;

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || seed();
    } catch {
      return seed();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function roleLabel(role) {
    return { OWNER: "家庭创建者", ADMIN: "管理员", MEMBER: "家庭成员" }[role] || role;
  }

  function metricLabel(type) {
    return { HEIGHT: "身高", WEIGHT: "体重", HEAD: "头围" }[type] || "成长数据";
  }

  function currentUser() {
    return state.users.find((user) => user.id === state.activeUserId) || state.users[0];
  }

  function currentFamily() {
    return state.families.find((family) => family.id === state.activeFamilyId);
  }

  function currentMembership() {
    return state.memberships.find((item) => item.familyId === state.activeFamilyId && item.userId === state.activeUserId);
  }

  function currentChildren() {
    return state.children.filter((child) => child.familyId === state.activeFamilyId);
  }

  function currentFamilyUsers() {
    const userIds = new Set(state.memberships.filter((item) => item.familyId === state.activeFamilyId).map((item) => item.userId));
    return state.users.filter((user) => userIds.has(user.id));
  }

  function childById(id) {
    return state.children.find((child) => child.id === id);
  }

  function userById(id) {
    return state.users.find((user) => user.id === id);
  }

  function isAdmin() {
    return ["OWNER", "ADMIN"].includes(currentMembership()?.role);
  }

  function ageAt(birthday, date = today) {
    const birth = new Date(birthday);
    const target = new Date(date);
    let months = (target.getFullYear() - birth.getFullYear()) * 12 + target.getMonth() - birth.getMonth();
    if (target.getDate() < birth.getDate()) months -= 1;
    months = Math.max(0, months);
    if (months < 12) return `${months}个月`;
    const years = Math.floor(months / 12);
    const rest = months % 12;
    return rest ? `${years}岁${rest}个月` : `${years}岁`;
  }

  function formatDate(value) {
    const [year, mon, day] = value.split("-");
    return `${year}年${Number(mon)}月${Number(day)}日`;
  }

  function showToast(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function renderContext(step = state.activeFamilyId ? "CHILD" : "FAMILY") {
    const gate = document.querySelector("#context-gate");
    gate.hidden = Boolean(state.activeFamilyId && state.activeChildId);
    document.querySelector("#family-step").hidden = step !== "FAMILY";
    document.querySelector("#child-step").hidden = step !== "CHILD";
    document.querySelector("#gate-family-list").innerHTML = state.families.map((family) => `<button type="button" class="gate-family-card" data-family="${family.id}"><span class="family-symbol" style="background:${family.color}">${escapeHtml(family.name.slice(0, 1))}</span><span><strong>${escapeHtml(family.name)}</strong><small>进入后再选择宝宝</small></span><b>›</b></button>`).join("");
    document.querySelectorAll("[data-family]").forEach((button) => button.addEventListener("click", () => {
      state.activeFamilyId = button.dataset.family;
      state.activeChildId = "";
      save();
      renderContext("CHILD");
    }));
    const family = currentFamily();
    document.querySelector("#gate-family-name").textContent = family?.name || "这个家庭";
    document.querySelector("#gate-child-grid").innerHTML = currentChildren().map((child) => `<button type="button" class="gate-child-card" data-gate-child="${child.id}"><span class="baby-symbol" style="background:${child.color}">${escapeHtml(child.name.slice(0, 1))}</span><strong>${escapeHtml(child.name)}</strong><small>${escapeHtml(child.label)} · ${ageAt(child.birthday)}</small><em>进入成长墙</em></button>`).join("");
    document.querySelectorAll("[data-gate-child]").forEach((button) => button.addEventListener("click", () => {
      state.activeChildId = button.dataset.gateChild;
      save();
      gate.hidden = true;
      renderAll();
      navigate("wall");
    }));
  }

  function navigate(target) {
    if (!state.activeFamilyId || !state.activeChildId) {
      renderContext(state.activeFamilyId ? "CHILD" : "FAMILY");
      return;
    }
    document.querySelectorAll(".screen").forEach((screen) => screen.classList.toggle("active", screen.dataset.screen === target));
    document.querySelectorAll(".tab-bar button").forEach((button) => button.classList.toggle("active", button.dataset.target === target));
    document.querySelector(`#screen-${target}`)?.scrollTo({ top: 0, behavior: "smooth" });
    if (target === "growth") renderGrowth();
    if (target === "profile") renderProfile();
  }

  function renderChildChips(containerId, selectedId, onSelect) {
    const container = document.querySelector(containerId);
    const items = currentChildren();
    container.innerHTML = items.map((child) => `<button type="button" class="${child.id === selectedId ? "active" : ""}" data-id="${child.id}">${escapeHtml(child.name)}</button>`).join("");
    container.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => onSelect(button.dataset.id)));
  }

  function renderWall() {
    const family = currentFamily();
    const activeChild = childById(state.activeChildId);
    document.querySelector("#wall-family-name").textContent = family?.name || "成长日记";
    document.querySelector("#wall-context-value").textContent = `${family?.name || "未选择家庭"} · ${activeChild?.name || "未选择宝宝"}`;
    renderChildChips("#child-filter", state.activeChildId, (id) => {
      state.activeChildId = id;
      save();
      renderAll();
    });
    const records = state.records
      .filter((record) => record.familyId === state.activeFamilyId && record.childId === state.activeChildId)
      .sort((a, b) => b.date.localeCompare(a.date));
    const timeline = document.querySelector("#timeline");
    timeline.innerHTML = records.length ? records.map((record) => {
      const child = childById(record.childId);
      const author = userById(record.creatorId);
      const media = record.media ? `<div class="mock-media ${record.media === "video" ? "video" : record.tone === "rose" ? "rose" : ""}">${record.media === "video" ? "▶" : "✦"}<small>${record.media === "video" ? "视频" : "照片"}</small></div>` : "";
      const metric = record.metric ? `<span class="metric-pill">${metricLabel(record.metric.type)} ${record.metric.value}${record.metric.unit}</span>` : "";
      return `<article class="timeline-item"><span class="timeline-dot" style="background:${child.color}"></span><div class="memory-card" data-entry="${record.id}"><header class="card-header"><span class="child-avatar" style="background:${child.color}">${escapeHtml(child.name.slice(0, 1))}</span><div class="card-person"><strong>${escapeHtml(child.name)} · ${ageAt(child.birthday, record.date)}</strong><small>${formatDate(record.date)} · ${escapeHtml(author.name)}</small></div><span class="type-pill">${record.kind === "MILESTONE" ? "成长里程碑" : "生活日记"}</span></header>${media}<div class="memory-body"><div class="memory-title-row"><h3>${escapeHtml(record.title)}</h3>${metric}</div><p>${escapeHtml(record.body)}</p><div class="memory-meta"><span>${record.event ? `🎈 ${escapeHtml(record.event)}` : ""}</span><span>查看记录 ›</span></div></div></div></article>`;
    }).join("") : `<div class="prototype-warning">当前筛选下还没有成长记录。</div>`;
    timeline.querySelectorAll("[data-entry]").forEach((card) => card.addEventListener("click", () => openEntry(card.dataset.entry)));
  }

  function openEntry(id) {
    const record = state.records.find((item) => item.id === id);
    if (!record) return;
    const child = childById(record.childId);
    const author = userById(record.creatorId);
    const canEdit = isAdmin() || record.creatorId === currentUser().id;
    const detail = document.querySelector("#entry-detail");
    detail.className = "entry-detail";
    detail.innerHTML = `<div class="detail-person"><span class="child-avatar" style="background:${child.color}">${child.name.slice(0, 1)}</span><div><strong>${escapeHtml(child.name)} · ${ageAt(child.birthday, record.date)}</strong><small>${formatDate(record.date)} · ${escapeHtml(author.name)}记录</small></div></div><p class="eyebrow coral">${record.kind === "MILESTONE" ? "成长里程碑" : "生活日记"}</p><h2>${escapeHtml(record.title)}</h2>${record.metric ? `<div class="detail-metric">📏 ${metricLabel(record.metric.type)} ${record.metric.value}${record.metric.unit}</div>` : ""}${record.event ? `<div class="detail-metric">🎈 ${escapeHtml(record.event)}</div>` : ""}<p>${escapeHtml(record.body)}</p>${record.media ? `<div class="detail-media">${record.media === "video" ? "▶" : "✦"}</div>` : ""}<div class="dialog-actions">${canEdit ? `<button type="button" id="demo-edit">编辑记录</button>` : ""}${isAdmin() ? `<button type="button" class="danger" id="demo-delete">永久删除</button>` : ""}</div>`;
    document.querySelector("#entry-dialog").showModal();
    detail.querySelector("#demo-edit")?.addEventListener("click", () => showToast("HTML 原型暂不实现编辑回填"));
    detail.querySelector("#demo-delete")?.addEventListener("click", () => {
      if (window.confirm("永久删除这条记录？原型不提供回收站。")) {
        state.records = state.records.filter((item) => item.id !== id);
        save();
        document.querySelector("#entry-dialog").close();
        renderAll();
        showToast("已从本地原型永久删除");
      }
    });
  }

  function renderPublishOptions() {
    const options = currentChildren().map((child) => `<option value="${child.id}" ${child.id === state.activeChildId ? "selected" : ""}>${escapeHtml(child.name)}</option>`).join("");
    document.querySelector("#publish-child").innerHTML = options;
    document.querySelector("#export-child").innerHTML = options;
  }

  function renderGrowth() {
    if (!currentChildren().some((child) => child.id === state.activeChildId)) state.activeChildId = currentChildren()[0]?.id || "";
    renderChildChips("#growth-child-filter", state.activeChildId, (id) => {
      state.activeChildId = id;
      save();
      renderAll();
    });
    const metrics = state.records.filter((record) => record.familyId === state.activeFamilyId && record.childId === state.activeChildId && record.metric).map((record) => ({ ...record.metric, date: record.date })).sort((a, b) => a.date.localeCompare(b.date));
    ["HEIGHT", "WEIGHT", "HEAD"].forEach((type) => {
      const id = { HEIGHT: "height-count", WEIGHT: "weight-count", HEAD: "head-count" }[type];
      document.querySelector(`#${id}`).textContent = `${metrics.filter((item) => item.type === type).length}次`;
    });
    document.querySelectorAll("#metric-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.type === state.growthType));
    const points = metrics.filter((item) => item.type === state.growthType);
    const latest = points.at(-1);
    document.querySelector("#latest-value").textContent = latest ? `${latest.value}${latest.unit}` : "暂无记录";
    document.querySelector("#latest-date").textContent = latest ? formatDate(latest.date) : "还没有成长数据";
    document.querySelector("#chart-unit").textContent = `单位：${state.growthType === "WEIGHT" ? "kg" : "cm"}`;
    const values = points.map((point) => point.value);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;
    const span = Math.max(1, max - min);
    document.querySelector("#growth-chart").innerHTML = points.length ? points.map((point) => {
      const height = 24 + ((point.value - min) / span) * 92;
      return `<div class="bar-point"><strong>${point.value}</strong><div class="bar-track"><span style="height:${height}px"></span></div><small>${point.date.slice(5)}</small></div>`;
    }).join("") : `<div class="empty-chart">📏<br />还没有这一项数据</div>`;
  }

  function renderProfile() {
    const user = currentUser();
    const family = currentFamily();
    const membership = currentMembership();
    document.querySelector("#profile-avatar").textContent = user.avatar;
    document.querySelector("#profile-name").textContent = user.name;
    document.querySelector("#profile-role").textContent = `${family?.name || "家庭"} · ${roleLabel(membership?.role)}`;
    document.querySelector("#identity-grid").innerHTML = currentFamilyUsers().map((item) => {
      const role = state.memberships.find((member) => member.familyId === state.activeFamilyId && member.userId === item.id)?.role;
      return `<button type="button" class="identity-card ${item.id === user.id ? "active" : ""}" data-user="${item.id}"><span>${item.avatar}</span><strong>${escapeHtml(item.name)}</strong><small>${roleLabel(role)}</small></button>`;
    }).join("");
    document.querySelectorAll("[data-user]").forEach((button) => button.addEventListener("click", () => {
      state.activeUserId = button.dataset.user;
      save();
      renderProfile();
      showToast(`已切换为${currentUser().name}`);
    }));
    document.querySelector("#profile-children").innerHTML = currentChildren().map((child) => `<button type="button" class="child-row"><span class="child-avatar" style="background:${child.color}">${child.name.slice(0, 1)}</span><div><strong>${escapeHtml(child.name)} · ${escapeHtml(child.label)}</strong><small>${ageAt(child.birthday)} · ${child.birthday}出生</small></div><b>›</b></button>`).join("");
    document.querySelector("#member-list").innerHTML = currentFamilyUsers().map((item) => {
      const role = state.memberships.find((member) => member.familyId === state.activeFamilyId && member.userId === item.id)?.role;
      return `<div class="member-row"><span>${item.avatar}</span><strong>${escapeHtml(item.name)}</strong><span class="role-pill ${role !== "MEMBER" ? "admin" : ""}">${roleLabel(role)}</span></div>`;
    }).join("");
    const adminOnlyButtons = [document.querySelector("#add-child"), document.querySelector("#create-invite")];
    adminOnlyButtons.forEach((button) => { button.hidden = !isAdmin(); });
  }

  function renderExports() {
    const jobs = state.exports.filter((job) => job.familyId === state.activeFamilyId);
    document.querySelector("#export-list").innerHTML = jobs.length ? jobs.map((job) => {
      const child = childById(job.childId);
      const label = { READY: "演示包已生成", DOWNLOADED: "已模拟下载", CONFIRMED: "已人工确认上传夸克" }[job.status];
      const action = job.status === "READY" ? `<button type="button" data-download="${job.id}">模拟下载 ZIP</button>` : job.status === "DOWNLOADED" ? `<button type="button" data-confirm="${job.id}">确认已人工上传夸克</button>` : "";
      return `<article class="export-job"><header><strong>${escapeHtml(child?.name || "宝宝")} · ${job.month}</strong><span class="status">${label}</span></header><p>模拟分卷：${job.parts} 个 · 无真实文件</p>${action}</article>`;
    }).join("") : `<p class="dialog-intro">还没有导出任务。</p>`;
    document.querySelectorAll("[data-download]").forEach((button) => button.addEventListener("click", () => updateExport(button.dataset.download, "DOWNLOADED")));
    document.querySelectorAll("[data-confirm]").forEach((button) => button.addEventListener("click", () => updateExport(button.dataset.confirm, "CONFIRMED")));
  }

  function updateExport(id, status) {
    const job = state.exports.find((item) => item.id === id);
    if (job) job.status = status;
    save();
    renderExports();
    showToast(status === "DOWNLOADED" ? "已模拟下载" : "已记录人工确认");
  }

  function renderAll() {
    renderPublishOptions();
    renderWall();
    renderGrowth();
    renderProfile();
    renderExports();
  }

  document.querySelectorAll(".tab-bar button, [data-jump]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.target || button.dataset.jump)));
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close()));
  document.querySelectorAll(".app-dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));

  document.querySelectorAll("#entry-kind button").forEach((button) => button.addEventListener("click", () => {
    entryKind = button.dataset.kind;
    document.querySelectorAll("#entry-kind button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelector("#milestone-fields").hidden = entryKind !== "MILESTONE";
  }));

  document.querySelectorAll("#metric-picker button").forEach((button) => button.addEventListener("click", () => {
    metricType = metricType === button.dataset.metric ? "" : button.dataset.metric;
    document.querySelectorAll("#metric-picker button").forEach((item) => item.classList.toggle("active", item.dataset.metric === metricType));
    document.querySelector("#metric-value-wrap").hidden = !metricType;
    document.querySelector("#metric-unit").textContent = metricType === "WEIGHT" ? "kg" : "cm";
  }));

  document.querySelectorAll("#metric-tabs button").forEach((button) => button.addEventListener("click", () => {
    state.growthType = button.dataset.type;
    save();
    renderGrowth();
  }));

  document.querySelector("#publish-title").addEventListener("input", (event) => { document.querySelector("#title-count").textContent = event.target.value.length; });
  document.querySelector("#publish-body").addEventListener("input", (event) => { document.querySelector("#body-count").textContent = event.target.value.length; });
  document.querySelector("#mock-media").addEventListener("click", () => {
    hasMockMedia = !hasMockMedia;
    document.querySelector("#media-hint").textContent = hasMockMedia ? "已添加 1 个演示照片占位" : "未添加素材";
    showToast(hasMockMedia ? "已添加演示素材" : "已移除演示素材");
  });

  document.querySelector("#publish-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = document.querySelector("#publish-title").value.trim();
    const body = document.querySelector("#publish-body").value.trim();
    const date = document.querySelector("#publish-date").value;
    const childId = document.querySelector("#publish-child").value;
    if (!title || !date || !childId) return;
    const value = Number(document.querySelector("#metric-value").value);
    state.records.push({
      id: `r-${Date.now()}`,
      familyId: state.activeFamilyId,
      childId,
      creatorId: currentUser().id,
      kind: entryKind,
      title,
      body,
      date,
      event: entryKind === "MILESTONE" ? document.querySelector("#custom-event").value.trim() : "",
      metric: entryKind === "MILESTONE" && metricType && value > 0 ? { type: metricType, value, unit: metricType === "WEIGHT" ? "kg" : "cm" } : undefined,
      media: hasMockMedia ? "image" : undefined,
      tone: "peach",
    });
    save();
    event.target.reset();
    document.querySelector("#publish-date").value = today;
    hasMockMedia = false;
    document.querySelector("#media-hint").textContent = "未添加素材";
    document.querySelector("#title-count").textContent = "0";
    document.querySelector("#body-count").textContent = "0";
    renderAll();
    navigate("wall");
    showToast("成长记录已加入本地原型");
  });

  document.querySelector("#create-invite").addEventListener("click", () => {
    if (!isAdmin()) return showToast("只有管理员可以创建邀请");
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const card = document.querySelector("#invite-card");
    card.hidden = false;
    card.innerHTML = `<small>一次性家庭邀请码</small><strong>${code}</strong><small>演示邀请码，24小时后失效</small>`;
    showToast("已生成演示邀请码");
  });

  document.querySelector("#add-child").addEventListener("click", () => showToast("新增宝宝表单请以小程序版本为准"));
  document.querySelector("#wall-change-family").addEventListener("click", () => {
    state.activeFamilyId = "";
    state.activeChildId = "";
    save();
    renderContext("FAMILY");
  });
  document.querySelector("#back-family").addEventListener("click", () => {
    state.activeFamilyId = "";
    state.activeChildId = "";
    save();
    renderContext("FAMILY");
  });
  document.querySelector("#create-family").addEventListener("click", () => showToast("创建家庭将在后续版本开放"));
  document.querySelector("#publish-child").addEventListener("change", (event) => {
    state.activeChildId = event.target.value;
    save();
    renderAll();
  });
  document.querySelector("#open-export").addEventListener("click", () => {
    renderPublishOptions();
    renderExports();
    document.querySelector("#export-dialog").showModal();
  });
  document.querySelector("#export-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isAdmin()) return showToast("只有管理员可以创建导出");
    state.exports.unshift({ id: `e-${Date.now()}`, familyId: state.activeFamilyId, childId: document.querySelector("#export-child").value, month: document.querySelector("#export-month").value, status: "READY", parts: 1 });
    save();
    renderExports();
    showToast("已生成演示导出任务");
  });
  document.querySelector("#reset-demo").addEventListener("click", () => {
    if (window.confirm("重置全部 HTML 原型数据？")) {
      state = seed();
      save();
      renderAll();
      renderContext("FAMILY");
      showToast("演示数据已重置");
    }
  });

  document.querySelector("#publish-date").value = today;
  document.querySelector("#export-month").value = month;
  renderAll();
  renderContext(state.activeFamilyId ? "CHILD" : "FAMILY");
})();
