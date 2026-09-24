(() => {
  const D = window.RADAR;
  const $ = (id) => document.getElementById(id);
  const W = D.weeks.length;
  const WINDOW = D.window; // every figure covers this many complete weeks
  const TOP = 7; // colored series; the rest fold into Other
  const END_LABELS = 4;
  const DAY = 864e5;
  const toolById = Object.fromEntries(D.tools.map((t) => [t.id, t]));
  const state = { mode: "big", view: "tools", tool: "claude-code", measure: "projects", range: "all" };
  // The view lives in the address (#public/models/codex/share/all), so a reload keeps it.
  const KEYS = Object.keys(state);
  const readHash = () => location.hash.slice(1).split("/").forEach((v, i) => v && KEYS[i] && (state[KEYS[i]] = decodeURIComponent(v)));
  readHash();

  // ---------- data ----------
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const lastWindow = (arr, offset = 0) => sum((arr ?? []).slice(Math.max(0, W - WINDOW - offset), W - offset));
  const roll = (arr) => arr.map((_, i) => sum(arr.slice(Math.max(0, i - WINDOW + 1), i + 1)));
  const addUp = (arrays) => arrays.reduce((acc, a) => acc.map((v, i) => v + a[i]), new Array(W).fill(0));

  // Weekly commits of the current view: Map entity → weekly values.
  function seriesOf(mode = state.mode, view = state.view, tool = state.tool) {
    const s = D[mode].series;
    const src = view === "models" ? s.models[tool] ?? {} : s[view] ?? {};
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
  // What a project count is out of: active projects, projects using the tool, or
  // active projects that disclose AI use.
  function usedBase(view = state.view, tool = state.tool) {
    const u = D.big.used;
    return (view === "tools" ? u.all : view === "models" ? u.tools[tool] : u.declaring) ?? new Array(W).fill(0);
  }
  const baseLabel = (view = state.view, tool = state.tool) =>
    view === "tools" ? "active projects" : view === "models" ? `${toolById[tool]?.name ?? tool} projects` : "projects that disclose AI use";

  const windowStats = (key) => {
    const w = D[state.mode].window;
    if (!w) return null;
    return (state.view === "models" ? w.models[state.tool]?.[key] : w[state.view][key]) ?? null;
  };
  const nameOf = (key, view = state.view) => (view === "tools" ? toolById[key]?.name ?? key : key);
  const labOf = (key) => (state.view === "models" ? D.modelLabs[key] : null);

  // Tools whose commits name a model in this mode, most named first.
  function modelTools(mode = state.mode) {
    const models = D[mode].series.models;
    return Object.keys(models)
      .map((id) => [id, sum(Object.entries(models[id]).filter(([k]) => k !== "~").map(([, a]) => lastWindow(a)))])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  // First week with data in this mode; chart points before it + WINDOW - 1 would
  // cover fewer than WINDOW weeks.
  function dataStart() {
    const weekly = state.mode === "big" ? D.big.total : addUp(Object.values(D.public.series.tools));
    return Math.max(0, weekly.findIndex((v) => v > 0));
  }

  // Colors follow the entity: fixed from the combined volume of both modes, never
  // from the current mode, measure or range.
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
    if (n >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
    return Math.round(n).toLocaleString("en-US");
  }
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const fmtShare = (p) => (p > 0 && p < 0.001 ? "<0.1%" : `${(p * 100).toFixed(1)}%`);
  const weekStart = (i) => Date.parse(`${D.weeks[i]}T00:00:00Z`);
  const weekEnd = (i) => weekStart(i) + 6 * DAY;
  const fmtDay = (t, year) => new Date(t).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC", ...(year ? { year: "numeric" } : {}),
  });
  const spanLabel = (i) => `${fmtDay(weekStart(Math.max(0, i - WINDOW + 1)))} – ${fmtDay(weekEnd(i), true)}`;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
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
  function buttons(id, options, key, { tabs = false } = {}) {
    $(id).replaceChildren(...options.map(([value, text]) => {
      const on = state[key] === value;
      const b = el("button", { type: "button", ...(tabs ? { role: "tab", "aria-selected": String(on) } : { "aria-pressed": String(on) }) }, text);
      b.addEventListener("click", () => {
        state[key] = value;
        render();
      });
      return b;
    }));
  }
  function renderControls() {
    buttons("mode", [["big", "Big projects"], ["public", "All public"]], "mode");
    const views = [["tools", "Tools"], ["models", "Models"]];
    if (state.mode === "big") views.push(["labs", "Labs"]);
    if (!views.some(([v]) => v === state.view)) state.view = "tools";
    buttons("view", views, "view", { tabs: true });
    const tools = modelTools();
    if (!tools.includes(state.tool)) state.tool = tools[0] ?? "claude-code";
    $("tool").hidden = state.view !== "models";
    buttons("tool", tools.map((id) => [id, toolById[id]?.name ?? id]), "tool");
    const measures = [["share", "Share"], ["commits", "Commits"]];
    if (state.mode === "big") measures.unshift(["projects", "Projects"]);
    if (state.mode === "big" && state.view === "tools") measures.push(["all", "Of all commits"]);
    if (!measures.some(([v]) => v === state.measure)) state.measure = measures[0][0];
    buttons("measure", measures, "measure");
    // Only ranges shorter than the data make a difference.
    const points = W - dataStart() - WINDOW + 1;
    const ranges = [["13", "3M"], ["26", "6M"], ["52", "1Y"]].filter(([n]) => Number(n) < points);
    if (!ranges.some(([v]) => v === state.range)) state.range = "all";
    buttons("range", ranges.length ? [...ranges, ["all", "All"]] : [], "range");
  }

  // ---------- key figures ----------
  function leader(mode, view, tool) {
    if (mode === "big") {
      const rows = [...usedOf(view, tool)].map(([k, a]) => [k, a[W - 1]]).sort((a, b) => b[1] - a[1]);
      const base = usedBase(view, tool)[W - 1];
      if (!rows.length || !base) return ["–", ""];
      return [nameOf(rows[0][0], view), `in ${fmtShare(rows[0][1] / base)} of ${baseLabel(view, tool)}`];
    }
    const rows = [...seriesOf(mode, view, tool)].map(([k, a]) => [k, lastWindow(a)]).sort((a, b) => b[1] - a[1]);
    const total = sum(rows.map(([, v]) => v));
    if (!rows.length || !total) return ["–", ""];
    return [nameOf(rows[0][0], view), `${fmtShare(rows[0][1] / total)} of ${view === "models" ? "commits naming a model" : "AI-signed commits"}`];
  }
  function renderFigures() {
    const m = state.mode;
    const topTool = modelTools()[0];
    const figures = [];
    if (m === "big") {
      const b = D.big;
      const ai = lastWindow(b.ai);
      const total = lastWindow(b.total);
      const using = b.used.ai?.[W - 1] ?? 0;
      const active = b.used.all?.[W - 1] ?? 0;
      figures.push([total ? fmtShare(ai / total) : "–", "AI share of commits", `${fmtInt(ai)} of ${fmtInt(total)}`]);
      figures.push([active ? fmtShare(using / active) : "–", "Projects using AI", `${fmtInt(using)} of ${fmtInt(active)} active`]);
    } else {
      const tools = [...seriesOf(m, "tools")].map(([, a]) => a);
      const total = sum(tools.map((a) => lastWindow(a)));
      const prior = sum(tools.map((a) => lastWindow(a, WINDOW)));
      const delta = prior ? (total / prior - 1) * 100 : 0;
      figures.push([fmtCount(total), "AI-signed commits", prior ? `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)}% vs the 4 weeks before` : ""]);
    }
    const [tool, toolSub] = leader(m, "tools");
    figures.push([tool, "Top tool", toolSub]);
    if (topTool) {
      const [model, modelSub] = leader(m, "models", topTool);
      figures.push([model, `Top model in ${toolById[topTool]?.name ?? topTool}`, modelSub]);
    }
    if (m === "big") {
      const [lab, labSub] = leader(m, "labs");
      figures.push([lab, "Top lab", labSub]);
    }
    $("figures").style.setProperty("--n", figures.length);
    $("figures").replaceChildren(...figures.map(([value, label, sub]) =>
      el("div", { class: "figure" }, el("div", { class: "value" }, value), el("div", { class: "label" }, label), el("div", { class: "sub" }, sub))));
  }

  // ---------- ranking ----------
  let open = null;
  function drill(stats) {
    return el("div", { class: "drill" }, ...stats.top.flatMap(([repo, n, shas]) => [
      el("a", { class: "repo", href: `https://github.com/${repo}`, target: "_blank", rel: "noopener" }, repo),
      el("span", { class: "count" }, `${fmtInt(n)} commits`),
      el("span", { class: "shas" }, ...shas.map((sha) =>
        el("a", { href: `https://github.com/${repo}/commit/${sha}`, target: "_blank", rel: "noopener", title: "Open commit" }, sha.slice(0, 7)))),
    ]));
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
    const size = (r) => (big ? r.projects : r.value);
    const max = Math.max(1, ...shown.map(size));
    const col = (text, title) => el("span", { class: "num", title }, text);
    const head = el("div", { class: "row head", role: "row" }, el("span"), el("span"), el("span"),
      ...(big ? [col("Projects", `Out of ${fmtInt(usedBase()[W - 1])} ${baseLabel()}`)] : []),
      col("Share", "Share of the AI commits in this view"), col("Commits", `Commits in the last ${WINDOW} weeks`),
      ...(big ? [col("Lines", "Median lines changed per commit"), col("Reverted", "Share of commits reverted later")] : []));
    const quality = (st) => (big ? [
      el("span", { class: "dim" }, st ? fmtInt(st.ml) : ""),
      el("span", { class: "dim" }, st ? fmtShare(st.rv) : ""),
    ] : []);
    const items = [];
    shown.forEach((r, i) => {
      const st = big ? windowStats(r.key) : null;
      const id = `${state.view}|${state.tool}|${r.key}`;
      const isOpen = big && st && open === id;
      const name = el("div", { class: "name" }, el("span", {}, nameOf(r.key)), labOf(r.key) ? el("span", { class: "lab" }, labOf(r.key)) : null);
      const row = el("div", { class: `row item${isOpen ? " open" : ""}`, role: "row", tabindex: big ? 0 : null, "aria-expanded": big ? String(!!isOpen) : null },
        el("span", { class: "rank" }, String(i + 1)), name,
        el("div", { class: "track" }, el("div", { class: "bar", style: { width: `${(size(r) / max) * 100}%`, background: colorOf(groupOf(r.key)) } })),
        ...(big ? [el("span", { class: "num" }, fmtInt(r.projects))] : []),
        el("span", { class: big ? "dim" : "num" }, fmtShare(r.value / total)), el("span", { class: "dim" }, fmtCount(r.value)), ...quality(st));
      items.push(row);
      if (big && st) {
        const toggle = () => {
          open = open === id ? null : id;
          renderBoard();
        };
        row.addEventListener("click", toggle);
        row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
        if (isOpen) items.push(drill(st));
      }
    });
    if (big && state.view === "tools") {
      for (const [key, label] of [["ai", "All AI"], ["none", "Without AI"]]) {
        const st = D.big.window?.[key];
        if (st) items.push(el("div", { class: "row base", role: "row" }, el("span"), el("span", {}, label), el("span"),
          el("span", { class: "num" }, fmtInt(st.p)), el("span"), el("span", { class: "dim" }, fmtCount(st.c)), ...quality(st)));
      }
    }
    board.replaceChildren(head, ...items);
    $("period").textContent = `Last ${WINDOW} weeks, ${spanLabel(W - 1)}`;

    const notes = [];
    if (rows.length > shown.length) notes.push(`${rows.length - shown.length} more with ${fmtShare(sum(rows.slice(shown.length).map((r) => r.value)) / total)} of commits.`);
    if (state.view === "models") {
      const unnamed = lastWindow(notStated());
      if (unnamed) notes.push(`${fmtShare(unnamed / (unnamed + total))} of ${toolById[state.tool]?.name ?? state.tool} commits do not name the model.`);
    }
    if (big) notes.push("Select a row for its projects and commits.");
    $("note").textContent = notes.join(" ");
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
    const totals = byProjects ? usedBase() : addUp([...groups.values()]);
    const all = state.measure === "all" ? roll(D.big.total) : null;
    const first = Math.min(W - 1, dataStart() + WINDOW - 1);
    const start = state.range === "all" ? first : Math.max(first, W - Number(state.range));
    const series = order.map((g) => ({ group: g, values: groups.get(g) })).filter((s) => s.values.slice(start).some((v) => v > 0));
    const valueAt = (v, i) => {
      if (state.measure === "commits") return v / WINDOW;
      const denom = state.measure === "all" ? all[i] : totals[i];
      return denom ? v / denom : 0;
    };
    return { series, members, start, valueAt };
  }
  const fmtValue = (v) => (state.measure === "commits" ? `${fmtCount(v)}/wk` : fmtShare(v));
  const fmtAxis = (v, stacked) => (stacked ? fmtCount(v) : `${+(v * 100).toFixed(1)}%`);
  const groupLabel = (g) => (g === "Other" ? "Other" : nameOf(g));

  function niceTicks(max, count = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let t = 0; t <= max + step * 0.999; t += step) ticks.push(+t.toFixed(10));
    return ticks;
  }

  function renderChart() {
    const { series, members, start, valueAt } = chartData();
    const stacked = state.measure === "commits";
    $("legend").replaceChildren(...series.map((s) =>
      el("li", {}, el("span", { class: `key${stacked ? " rect" : ""}`, style: { background: colorOf(s.group) } }), groupLabel(s.group))));
    renderTable(series, start, valueAt);
    const host = $("chart");
    host.replaceChildren();
    if (!series.length) return;

    const width = host.clientWidth || 800;
    const height = width < 600 ? 240 : 300;
    const m = { l: 48, r: 64, t: 12, b: 30 };
    const end = W - 1;
    const span = Math.max(1, end - start);
    const plotW = width - m.l - m.r;
    const x = (i) => m.l + (end === start ? plotW / 2 : ((i - start) / span) * plotW);
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
      const label = svg("text", { x: m.l - 10, y: y(t) + 4, "text-anchor": "end" });
      label.textContent = fmtAxis(t, stacked);
      root.append(label);
    }

    // One tick per week, labelled with the week's last day; thinned from the newest
    // week backwards so the latest date is always shown.
    const every = Math.max(1, Math.ceil(62 / (plotW / span)));
    for (let i = end; i >= start; i -= every) {
      root.append(svg("line", { class: "tick", x1: x(i), x2: x(i), y1: y(0), y2: y(0) + 4 }));
      const label = svg("text", { x: x(i), y: height - 8, "text-anchor": "middle" });
      label.textContent = fmtDay(weekEnd(i));
      root.append(label);
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

    // Values at the line ends for the biggest series; a label that would collide
    // with one already placed is left to the legend and the tooltip.
    const ends = series.map((s, j) => ({ j, v: tops[j][end], value: stacked ? valueAt(s.values[end], end) : tops[j][end] }))
      .sort((a, b) => b.value - a.value).slice(0, END_LABELS);
    const placed = [];
    for (const e of ends) {
      const ey = y(e.v);
      if (placed.some((p) => Math.abs(p - ey) < 15)) continue;
      placed.push(ey);
      root.append(svg("circle", { class: "dot", cx: x(end), cy: ey, r: 3.5, fill: colorOf(series[e.j].group) }));
      const label = svg("text", { class: "end", x: x(end) + 9, y: ey + 4 });
      label.textContent = fmtValue(e.value);
      root.append(label);
    }

    const cross = svg("line", { class: "cross", y1: m.t, y2: height - m.b, visibility: "hidden" });
    const dots = series.map((s) => svg("circle", { class: "dot", r: 4.5, fill: colorOf(s.group), visibility: "hidden" }));
    root.append(cross, ...dots);
    const hit = svg("rect", { class: "hit", x: m.l - 8, y: 0, width: plotW + 16, height, fill: "transparent", tabindex: 0, "aria-label": "Chart values by week" });
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
      tip.replaceChildren(el("div", { class: "head" }, `${WINDOW} weeks to ${fmtDay(weekEnd(i), true)}`), ...shown.map((r) =>
        el("div", { class: "row" }, el("span", { class: "key", style: { background: colorOf(r.group) } }),
          el("b", {}, fmtValue(r.v)), el("span", {}, nameOf(r.key)))));
      if (rows.length > shown.length) tip.append(el("div", { class: "more" }, `${rows.length - shown.length} more`));
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const px = clientX ?? box.left + (x(i) / width) * box.width;
      const py = clientY ?? box.top + 40;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${px + 18 + w > window.innerWidth - 8 ? px - 18 - w : px + 18}px`;
      tip.style.top = `${Math.min(Math.max(8, py - h / 2), window.innerHeight - h - 8)}px`;
    }
    function hide() {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    }
    const indexAt = (clientX) => {
      const px = ((clientX - host.getBoundingClientRect().left) / host.clientWidth) * width;
      return Math.min(end, Math.max(start, Math.round(start + ((px - m.l) / plotW) * span)));
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
      body.push(el("tr", {}, el("td", {}, fmtDay(weekEnd(i), true)),
        ...series.map((s) => el("td", {}, fmtValue(valueAt(s.values[i], i))))));
    }
    $("table").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
  }

  function render() {
    renderControls();
    const hash = `#${KEYS.map((k) => encodeURIComponent(state[k])).join("/")}`;
    if (location.hash !== hash) history.pushState(null, "", hash);
    $("scope").textContent = state.mode === "big"
      ? `Every commit to ${fmtInt(D.big.projects)} open-source projects with 10,000+ stars`
      : "Commits signed by AI tools in all public repositories";
    renderFigures();
    renderBoard();
    renderChart();
    $("footer").textContent = `Data from GitHub, updated ${fmtDay(Date.parse(D.generated), true)}.`;
  }

  window.addEventListener("popstate", () => {
    readHash();
    render();
  });
  let frame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(renderChart);
  });
  render();
})();
