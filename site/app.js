(() => {
  const D = window.RADAR;
  const $ = (id) => document.getElementById(id);
  const W = D.weeks.length;
  const WINDOW = D.window; // every figure covers this many complete weeks
  const TOP = 7; // colored series; the rest fold into Other
  const DAY = 864e5;
  const toolById = Object.fromEntries(D.tools.map((t) => [t.id, t]));
  const state = { mode: "big", view: "tools", tool: "claude-code", measure: "projects", range: "all" };
  // The view lives in the address (#public/models/codex/share/all), so a reload keeps it.
  const KEYS = Object.keys(state);
  location.hash.slice(1).split("/").forEach((v, i) => v && KEYS[i] && (state[KEYS[i]] = decodeURIComponent(v)));

  // ---------- data ----------
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const lastWindow = (arr, offset = 0) => sum((arr ?? []).slice(Math.max(0, W - WINDOW - offset), W - offset));
  const roll = (arr) => arr.map((_, i) => sum(arr.slice(Math.max(0, i - WINDOW + 1), i + 1)));

  // Weekly series of the current view: Map entity → weekly values.
  function seriesOf(mode = state.mode, view = state.view, tool = state.tool) {
    const s = D[mode].series;
    const src = view === "models" ? s.models[tool] ?? {} : s[view];
    return new Map(Object.entries(src).filter(([key]) => key !== "~"));
  }
  const notStated = () => D[state.mode].series.models[state.tool]?.["~"];

  // Big projects rank by how many projects use a tool or model, so one very active
  // project cannot decide the ranking. The counts cover the same rolling window.
  function usedOf(view = state.view, tool = state.tool) {
    const u = D.big.used;
    const src = view === "models" ? u.models[tool] ?? {} : u[view] ?? {};
    return new Map(Object.entries(src).filter(([key]) => key !== "~"));
  }
  // Projects a count is out of: active projects, projects using the tool, or
  // active projects that disclose AI use.
  function usedBase(view = state.view, tool = state.tool) {
    const u = D.big.used;
    const base = view === "tools" ? u.all : view === "models" ? u.tools[tool] : u.declaring;
    return base ?? new Array(W).fill(0);
  }
  const baseLabel = (view = state.view, tool = state.tool) =>
    view === "tools" ? "active projects" : view === "models" ? `${toolById[tool]?.name ?? tool} projects` : "disclosing projects";
  const windowStats = (key) => {
    const w = D[state.mode].window;
    if (!w) return null;
    if (state.view === "models") return w.models[state.tool]?.[key] ?? null;
    return w[state.view][key] ?? null;
  };
  const nameOf = (key) => (state.view === "tools" ? toolById[key]?.name ?? key : key);
  const labOf = (key) => (state.view === "models" ? D.modelLabs[key] : null);

  // Tools whose commits name a model in this mode, most named first.
  function modelTools() {
    const models = D[state.mode].series.models;
    return Object.keys(models)
      .map((id) => [id, sum(Object.entries(models[id]).filter(([k]) => k !== "~").map(([, a]) => lastWindow(a)))])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  // Colors follow the entity: fixed from the combined volume of both modes, never
  // from the current mode, filter or range.
  const slotCache = new Map();
  function slots() {
    const key = `${state.view}|${state.view === "models" ? state.tool : ""}`;
    if (!slotCache.has(key)) {
      const totals = new Map();
      for (const mode of ["big", "public"]) {
        for (const [k, arr] of seriesOf(mode)) totals.set(k, (totals.get(k) ?? 0) + sum(arr));
      }
      const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      slotCache.set(key, new Map(ranked.slice(0, TOP).map((k, i) => [k, i])));
    }
    return slotCache.get(key);
  }
  const groupOf = (key) => (slots().has(key) ? key : "Other");
  const colorOf = (group) => (slots().has(group) ? `var(--s${slots().get(group) + 1})` : "var(--other)");

  // ---------- formatting ----------
  function fmtCount(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
    return String(Math.round(n));
  }
  const fmtShare = (p) => (p > 0 && p < 0.001 ? "<0.1%" : `${(p * 100).toFixed(1)}%`);
  const weekStart = (i) => Date.parse(`${D.weeks[i]}T00:00:00Z`);
  const fmtDay = (t, year) => new Date(t).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC", ...(year ? { year: "numeric" } : {}),
  });
  const spanLabel = (i) => `${fmtDay(weekStart(Math.max(0, i - WINDOW + 1)))} – ${fmtDay(weekStart(i) + 6 * DAY, true)}`;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "style") Object.assign(node.style, v);
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // ---------- controls ----------
  function segmented(id, options, key) {
    $(id).replaceChildren(...options.map(([value, text]) => {
      const b = el("button", { type: "button", "aria-pressed": String(state[key] === value) }, text);
      b.addEventListener("click", () => {
        state[key] = value;
        render();
      });
      return b;
    }));
  }
  function renderControls() {
    segmented("mode", [["big", "Big projects"], ["public", "All public"]], "mode");
    const views = [["tools", "Tools"], ["models", "Models"]];
    if (state.mode === "big") views.push(["labs", "Labs"]);
    if (!views.some(([v]) => v === state.view)) state.view = "tools";
    segmented("view", views, "view");
    const tools = modelTools();
    if (!tools.includes(state.tool)) state.tool = tools[0] ?? "claude-code";
    $("tool-row").hidden = state.view !== "models";
    segmented("tool", tools.map((id) => [id, toolById[id]?.name ?? id]), "tool");
    const measures = [["share", "Share"], ["commits", "Commits"]];
    if (state.mode === "big") measures.unshift(["projects", "Projects"]);
    if (state.mode === "big" && state.view === "tools") measures.push(["all", "Of all commits"]);
    if (!measures.some(([v]) => v === state.measure)) state.measure = measures[0][0];
    segmented("measure", measures, "measure");
    segmented("range", [["13", "3M"], ["26", "6M"], ["52", "1Y"], ["all", "All"]], "range");
  }

  // ---------- tiles ----------
  function leader(mode, view, tool) {
    const label = (key) => (view === "tools" ? toolById[key]?.name ?? key : key);
    if (mode === "big") {
      const rows = [...usedOf(view, tool)].map(([k, a]) => [k, a[W - 1]]).sort((a, b) => b[1] - a[1]);
      const base = usedBase(view, tool)[W - 1];
      if (!rows.length || !base) return ["–", ""];
      return [label(rows[0][0]), `in ${fmtShare(rows[0][1] / base)} of ${baseLabel(view, tool)}`];
    }
    const rows = [...seriesOf(mode, view, tool)].map(([k, a]) => [k, lastWindow(a)]).sort((a, b) => b[1] - a[1]);
    const total = sum(rows.map(([, v]) => v));
    if (!rows.length || !total) return ["–", ""];
    const [key, value] = rows[0];
    return [label(key), `${fmtShare(value / total)} share`];
  }
  function renderTiles() {
    const m = state.mode;
    const topTool = modelTools()[0];
    const tiles = [];
    if (m === "big") {
      const b = D.big;
      const ai = lastWindow(b.ai);
      const total = lastWindow(b.total);
      const using = b.used.ai?.[W - 1] ?? 0;
      const active = b.used.all?.[W - 1] ?? 0;
      tiles.push(["AI share of commits", total ? fmtShare(ai / total) : "–", `${fmtCount(ai)} of ${fmtCount(total)} commits`]);
      tiles.push(["Projects using AI", active ? fmtShare(using / active) : "–", `${using.toLocaleString("en-US")} of ${active.toLocaleString("en-US")} active projects`]);
    } else {
      const tools = [...seriesOf(m, "tools")].map(([, a]) => a);
      const total = sum(tools.map((a) => lastWindow(a)));
      const prior = sum(tools.map((a) => lastWindow(a, WINDOW)));
      const delta = prior ? (total / prior - 1) * 100 : 0;
      tiles.push(["AI-signed commits", fmtCount(total), prior ? `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)}% vs prior 4 weeks` : ""]);
    }
    tiles.push(["Top tool", ...leader(m, "tools")]);
    if (topTool) tiles.push([`Top model · ${toolById[topTool]?.name ?? topTool}`, ...leader(m, "models", topTool)]);
    if (m === "big") tiles.push(["Top lab", ...leader(m, "labs")]);
    $("tiles").replaceChildren(...tiles.map(([label, value, sub]) =>
      el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), el("div", { class: "sub" }, sub))));
  }

  // ---------- leaderboard ----------
  let open = null;
  function drill(stats) {
    return el("div", { class: "drill" }, ...stats.top.map(([repo, n, shas]) =>
      el("div", {},
        el("a", { class: "repo", href: `https://github.com/${repo}`, target: "_blank", rel: "noopener" }, repo),
        el("span", { class: "dim" }, `${fmtCount(n)} commits`),
        ...shas.map((sha) => el("a", { href: `https://github.com/${repo}/commit/${sha}`, target: "_blank", rel: "noopener" }, sha.slice(0, 7))))));
  }
  function renderBoard() {
    const big = state.mode === "big";
    const board = $("board");
    board.className = `board${big ? " big" : ""}`;
    const used = big ? usedOf() : new Map();
    const rows = [...seriesOf()]
      .map(([key, a]) => ({ key, value: lastWindow(a), projects: used.get(key)?.[W - 1] ?? 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => (big ? b.projects - a.projects : 0) || b.value - a.value);
    const total = sum(rows.map((r) => r.value));
    const shown = rows.slice(0, 15);
    const rank = (r) => (big ? r.projects : r.value);
    const max = Math.max(1, ...shown.map(rank));
    const head = el("div", { class: "row head", role: "row" }, el("span"), el("span"), el("span"),
      ...(big ? [el("span", { class: "num" }, "Projects")] : []),
      el("span", { class: "num" }, "Share"), el("span", { class: "num" }, "Commits"),
      ...(big ? [el("span", { class: "num" }, "Lines"), el("span", { class: "num" }, "Reverted")] : []));
    const quality = (st) => (big ? [
      el("span", { class: "dim" }, st ? fmtCount(st.ml) : ""),
      el("span", { class: "dim" }, st ? fmtShare(st.rv) : ""),
    ] : []);
    const items = [];
    shown.forEach((r, i) => {
      const st = big ? windowStats(r.key) : null;
      const name = el("div", { class: "name" }, el("span", {}, nameOf(r.key)), labOf(r.key) ? el("span", { class: "lab" }, labOf(r.key)) : null);
      const row = el("div", { class: "row item", role: "row", tabindex: big ? 0 : -1 },
        el("span", { class: "rank" }, String(i + 1)), name,
        el("div", { class: "track" }, el("div", { class: "bar", style: { width: `${(rank(r) / max) * 100}%`, background: colorOf(groupOf(r.key)) } })),
        ...(big ? [el("span", { class: "num" }, r.projects.toLocaleString("en-US"))] : []),
        el("span", { class: big ? "dim" : "num" }, fmtShare(r.value / total)), el("span", { class: "dim" }, fmtCount(r.value)), ...quality(st));
      items.push(row);
      if (big && st) {
        const id = `${state.view}|${state.tool}|${r.key}`;
        const toggle = () => {
          open = open === id ? null : id;
          renderBoard();
        };
        row.addEventListener("click", toggle);
        row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
        if (open === id) items.push(drill(st));
      }
    });
    if (big && state.view === "tools") {
      for (const [key, label] of [["ai", "All AI"], ["none", "Without AI"]]) {
        const st = D.big.window?.[key];
        if (st) items.push(el("div", { class: "row base", role: "row" }, el("span"), el("span", {}, label), el("span"),
          el("span", { class: "num" }, st.p.toLocaleString("en-US")), el("span"),
          el("span", { class: "dim" }, fmtCount(st.c)), ...quality(st)));
      }
    }
    board.replaceChildren(head, ...items);
    $("board-period").textContent = spanLabel(W - 1);

    const notes = [];
    if (big) notes.push(`Projects out of ${usedBase()[W - 1].toLocaleString("en-US")} ${baseLabel()}`);
    if (rows.length > shown.length) notes.push(`+${rows.length - shown.length} more · ${fmtShare(sum(rows.slice(shown.length).map((r) => r.value)) / total)} of commits`);
    if (state.view === "models") {
      const unnamed = lastWindow(notStated());
      if (unnamed) notes.push(`Model not stated: ${fmtShare(unnamed / (unnamed + total))} of ${toolById[state.tool]?.name ?? state.tool} commits`);
    }
    $("board-note").textContent = notes.join(" · ");
  }

  // ---------- history ----------
  function chartData() {
    const byProjects = state.measure === "projects";
    const members = new Map();
    const groups = new Map();
    for (const [key, arr] of byProjects ? usedOf() : seriesOf()) {
      const values = byProjects ? arr : roll(arr);
      const g = groupOf(key);
      members.set(key, { group: g, values });
      if (byProjects && g === "Other") continue; // distinct projects do not add up
      const t = groups.get(g) ?? new Array(W).fill(0);
      values.forEach((v, i) => (t[i] += v));
      groups.set(g, t);
    }
    const order = [...slots().keys(), "Other"].filter((g) => groups.has(g));
    let totals = new Array(W).fill(0);
    for (const arr of groups.values()) arr.forEach((v, i) => (totals[i] += v));
    if (byProjects) totals = usedBase();
    const all = state.measure === "all" ? roll(D.big.total) : null;
    // The first points would cover fewer than WINDOW weeks of data.
    const weekly = state.mode === "big"
      ? D.big.total
      : Object.values(D.public.series.tools).reduce((acc, a) => acc.map((v, i) => v + a[i]), new Array(W).fill(0));
    const first = Math.max(0, weekly.findIndex((v) => v > 0)) + WINDOW - 1;
    const start = state.range === "all" ? first : Math.max(first, W - Number(state.range));
    const series = order.map((g) => ({ group: g, values: groups.get(g) })).filter((s) => s.values.slice(start).some((v) => v > 0));
    return { series, members, totals, all, start };
  }

  function makeValue({ totals, all }) {
    return (v, i) => {
      if (state.measure === "commits") return v / WINDOW;
      const denom = state.measure === "all" ? all[i] : totals[i];
      return denom ? v / denom : 0;
    };
  }
  const fmtValue = (v) => (state.measure === "commits" ? `${fmtCount(v)}/wk` : fmtShare(v));
  const groupLabel = (g) => (g === "Other" ? "Other" : nameOf(g));

  function niceTicks(max, count = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let t = 0; t <= max + step * 0.999; t += step) ticks.push(t);
    return ticks;
  }

  function renderChart() {
    const data = chartData();
    const { series, members, start } = data;
    const valueAt = makeValue(data);
    const stacked = state.measure === "commits";
    $("legend").replaceChildren(...series.map((s) =>
      el("li", {}, el("span", { class: `key${stacked ? " rect" : ""}`, style: { background: colorOf(s.group) } }), groupLabel(s.group))));
    renderTable(series, start, valueAt);
    const host = $("chart");
    host.replaceChildren();
    if (!series.length || start >= W) return;

    const width = host.clientWidth || 800;
    const height = 300;
    const m = { l: 52, r: 14, t: 10, b: 26 };
    const end = W - 1;
    const span = Math.max(1, end - start);
    const x = (i) => m.l + ((i - start) / span) * (width - m.l - m.r);
    const tops = series.map(() => new Array(W).fill(0));
    let max = 0;
    for (let i = start; i <= end; i++) {
      let cum = 0;
      series.forEach((s, j) => {
        const v = valueAt(s.values[i], i);
        cum += v;
        tops[j][i] = stacked ? cum : v;
        max = Math.max(max, tops[j][i]);
      });
    }
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const y = (v) => m.t + (1 - v / top) * (height - m.t - m.b);

    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img", "aria-label": "History chart" });
    for (const t of ticks) {
      root.append(svg("line", { class: t === 0 ? "base" : "grid", x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
      const label = svg("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end" });
      label.textContent = stacked ? fmtCount(t) : `${+(t * 100).toFixed(1)}%`;
      root.append(label);
    }
    // Month ticks, thinned so labels stay at least ~70px apart.
    const monthPx = (4.35 * (width - m.l - m.r)) / span;
    const every = [1, 2, 3, 6, 12].find((k) => k * monthPx >= 70) ?? 12;
    for (let i = start; i <= end; i++) {
      const date = new Date(weekStart(i));
      const prev = new Date(weekStart(i) - 7 * DAY);
      if (i !== start && prev.getUTCMonth() === date.getUTCMonth()) continue;
      if (i !== start && date.getUTCMonth() % every !== 0) continue;
      const t = svg("text", { x: x(i), y: height - 6, "text-anchor": i === start ? "start" : "middle" });
      t.textContent = i === start
        ? fmtDay(weekStart(i) + 6 * DAY, true)
        : date.toLocaleDateString("en-US", { month: "short", ...(date.getUTCMonth() === 0 ? { year: "numeric" } : {}), timeZone: "UTC" });
      root.append(t);
    }

    const pts = (arr) => {
      const out = [];
      for (let i = start; i <= end; i++) out.push(`${x(i).toFixed(1)},${y(arr[i]).toFixed(1)}`);
      return out;
    };
    series.forEach((s, j) => {
      const color = colorOf(s.group);
      const upper = pts(tops[j]);
      if (stacked) {
        const lower = j ? pts(tops[j - 1]).reverse() : [`${x(end).toFixed(1)},${y(0)}`, `${x(start).toFixed(1)},${y(0)}`];
        root.append(svg("path", { d: `M${upper.join("L")}L${lower.join("L")}Z`, fill: color, "fill-opacity": 0.22 }));
      }
      root.append(svg("path", { class: "line", d: `M${upper.join("L")}`, stroke: color }));
    });

    const cross = svg("line", { class: "cross", y1: m.t, y2: height - m.b, visibility: "hidden" });
    const dots = series.map((s) => svg("circle", { class: "dot", r: 4, fill: colorOf(s.group), visibility: "hidden" }));
    root.append(cross, ...dots);
    const hit = svg("rect", { x: m.l, y: 0, width: width - m.l - m.r, height, fill: "transparent", tabindex: 0 });
    root.append(hit);
    host.append(root);

    const tip = $("tooltip");
    let current = end;
    function show(i, clientX, clientY) {
      current = i;
      cross.setAttribute("x1", x(i));
      cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
      dots.forEach((d, j) => {
        d.setAttribute("cx", x(i));
        d.setAttribute("cy", y(tops[j][i]));
        d.setAttribute("visibility", "visible");
      });
      const rows = [...members]
        .map(([key, mm]) => ({ key, group: mm.group, v: valueAt(mm.values[i], i) }))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v);
      const shown = rows.slice(0, 10);
      tip.replaceChildren(el("div", { class: "head" }, spanLabel(i)), ...shown.map((r) =>
        el("div", { class: "row" }, el("span", { class: "key", style: { background: colorOf(r.group) } }),
          el("b", {}, fmtValue(r.v)), el("span", {}, nameOf(r.key)))));
      if (rows.length > shown.length) tip.append(el("div", { class: "head" }, `+${rows.length - shown.length} more`));
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const px = clientX ?? box.left + x(i);
      const py = clientY ?? box.top + 20;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${px + 16 + w > window.innerWidth ? px - 16 - w : px + 16}px`;
      tip.style.top = `${Math.min(Math.max(8, py - h / 2), window.innerHeight - h - 8)}px`;
    }
    function hide() {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    }
    const indexAt = (clientX) => {
      const px = ((clientX - host.getBoundingClientRect().left) / host.clientWidth) * width;
      return Math.min(end, Math.max(start, Math.round(start + ((px - m.l) / (width - m.l - m.r)) * span)));
    };
    hit.addEventListener("pointermove", (e) => show(indexAt(e.clientX), e.clientX, e.clientY));
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", () => show(current));
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") show(Math.max(start, current - 1));
      if (e.key === "ArrowRight") show(Math.min(end, current + 1));
    });
  }

  function renderTable(series, start, valueAt) {
    const head = el("tr", {}, el("th", {}, `${WINDOW} weeks to`), ...series.map((s) => el("th", {}, groupLabel(s.group))));
    const body = [];
    for (let i = W - 1; i >= start; i--) {
      body.push(el("tr", {}, el("td", {}, fmtDay(weekStart(i) + 6 * DAY, true)),
        ...series.map((s) => el("td", {}, fmtValue(valueAt(s.values[i], i))))));
    }
    $("table").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
  }

  function render() {
    renderControls();
    history.replaceState(null, "", `#${KEYS.map((k) => encodeURIComponent(state[k])).join("/")}`);
    renderTiles();
    renderBoard();
    renderChart();
    const scope = state.mode === "big"
      ? `${D.big.projects.toLocaleString("en-US")} projects with 10,000+ stars, every commit on the default branch`
      : "All public repositories, estimated from samples";
    $("footer").textContent = `${scope} · Updated ${fmtDay(Date.parse(D.generated), true)}`;
  }

  let frame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderChart);
  });
  render();
})();
