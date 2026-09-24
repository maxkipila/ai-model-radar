(() => {
  const D = window.RADAR;
  const $ = (id) => document.getElementById(id);
  const N = D.days.length;
  const TRAIL = D.trail; // each chart point covers this many days
  const FRAMES = Object.fromEntries(D.frames); // id → days (null: all)
  const FRAME_LABELS = { "1w": "1W", "1m": "1M", "3m": "3M", all: "All" };
  const TOP = 7; // colored series; the rest fold into Other
  const END_LABELS = 4;
  const DAY = 864e5;
  const ALL = "*"; // all tools together
  const toolById = Object.fromEntries(D.tools.map((t) => [t.id, t]));
  const state = { mode: "big", view: "models", tool: ALL, measure: "share", frame: "1m" };
  // The view lives in the address (#big/models/claude-code/share/1m), so a reload keeps it.
  const KEYS = Object.keys(state);
  const readHash = () => location.hash.slice(1).split("/").forEach((v, i) => v && KEYS[i] && (state[KEYS[i]] = decodeURIComponent(v)));
  readHash();

  // ---------- data ----------
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mode = () => D[state.mode];
  const start = () => mode().start; // first day with data in this mode
  // First day of the chosen period; the chart starts TRAIL - 1 days later at the
  // earliest, so its first point covers full TRAIL days.
  const frameFrom = (frame = state.frame) => (FRAMES[frame] ? Math.max(start(), N - FRAMES[frame]) : start());
  const inFrame = (arr, frame = state.frame) => sum((arr ?? []).slice(frameFrom(frame)));
  const trail = (arr) => arr.map((_, d) => sum(arr.slice(Math.max(0, d - TRAIL + 1), d + 1)));
  const addUp = (arrays) => arrays.reduce((acc, a) => acc.map((v, i) => v + a[i]), new Array(N).fill(0));

  // Daily commits of a view: Map entity → daily values.
  function seriesOf(m = state.mode, view = state.view, tool = state.tool) {
    const s = D[m].series;
    const src = view === "models" ? s.models[tool] ?? {} : s[view] ?? {};
    return new Map(Object.entries(src).filter(([key]) => key !== "~"));
  }
  const notStated = () => mode().series.models[state.tool]?.["~"];

  // Big projects also count the projects using a tool or model, so one very active
  // project cannot decide the ranking.
  function usedDaily(view = state.view, tool = state.tool) {
    const u = D.big.used;
    const src = view === "models" ? u.models[tool] ?? {} : u[view] ?? {};
    return new Map(Object.entries(src).filter(([key]) => key !== "~"));
  }
  const usedFrame = () => D.big.frames[state.frame].used;
  function usedIn(key, view = state.view, tool = state.tool) {
    const u = usedFrame();
    return (view === "models" ? u.models[tool]?.[key] : u[view]?.[key]) ?? 0;
  }
  // What a project count is out of: active projects, projects using the tool (or AI
  // at all), or active projects that disclose AI use.
  const baseKey = (view = state.view, tool = state.tool) =>
    view === "tools" ? ["all"] : view === "labs" ? ["declaring"] : tool === ALL ? ["ai"] : ["tools", tool];
  const baseDaily = (view, tool) => {
    const [k, t] = baseKey(view, tool);
    return (t ? D.big.used[k][t] : D.big.used[k]) ?? new Array(N).fill(0);
  };
  const baseIn = (view, tool) => {
    const [k, t] = baseKey(view, tool);
    return (t ? usedFrame()[k][t] : usedFrame()[k]) ?? 0;
  };
  const baseLabel = (view = state.view, tool = state.tool) =>
    view === "tools" ? "active projects" : view === "labs" ? "projects that disclose AI use"
      : tool === ALL ? "projects using AI" : `${toolById[tool]?.name ?? tool} projects`;
  const statsOf = (key) => {
    if (state.mode !== "big") return null;
    const st = D.big.frames[state.frame].stats;
    return (state.view === "models" ? st.models[state.tool]?.[key] : st[state.view]?.[key]) ?? null;
  };

  const toolName = (id) => (id === ALL ? "All tools" : toolById[id]?.name ?? id);
  const nameOf = (key, view = state.view) => (view === "tools" ? toolName(key) : key);
  const labOf = (key) => (state.view === "models" ? D.modelLabs[key] : null);

  // Tools whose commits name a model in this mode, most named first.
  function modelTools(m = state.mode) {
    const models = D[m].series.models;
    return Object.keys(models)
      .filter((id) => id !== ALL)
      .map((id) => [id, sum(Object.entries(models[id]).filter(([k]) => k !== "~").map(([, a]) => inFrame(a)))])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  // Colors follow the entity: fixed from the combined volume of both modes, never
  // from the current mode, measure or period.
  const slotCache = new Map();
  function slots() {
    const key = `${state.view}|${state.view === "models" ? state.tool : ""}`;
    if (!slotCache.has(key)) {
      const totals = new Map();
      for (const m of ["big", "public"]) {
        for (const [k, arr] of seriesOf(m)) totals.set(k, (totals.get(k) ?? 0) + sum(arr));
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
  const dayTime = (d) => Date.parse(`${D.days[d]}T00:00:00Z`);
  const fmtDay = (d, year) => new Date(dayTime(d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC", ...(year ? { year: "numeric" } : {}),
  });
  const periodLabel = () => `${fmtDay(frameFrom())} – ${fmtDay(N - 1, true)}`;

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
    const views = [["models", "Models"], ["tools", "Tools"]];
    if (state.mode === "big") views.push(["labs", "Labs"]);
    if (!views.some(([v]) => v === state.view)) state.view = "models";
    buttons("view", views, "view", { tabs: true });
    // Periods longer than the data show the same as All.
    const span = N - start();
    const frames = D.frames.filter(([id, len]) => len == null || len < span);
    if (!frames.some(([id]) => id === state.frame)) state.frame = "all";
    buttons("frame", frames.map(([id]) => [id, FRAME_LABELS[id] ?? id]), "frame");
    const tools = [ALL, ...modelTools()];
    if (!tools.includes(state.tool)) state.tool = ALL;
    $("tool").hidden = state.view !== "models";
    buttons("tool", tools.map((id) => [id, toolName(id)]), "tool");
    const measures = [["share", "Share"]];
    if (state.mode === "big") measures.push(["projects", "Projects"]);
    measures.push(["commits", "Commits"]);
    if (state.mode === "big" && state.view === "tools") measures.push(["all", "Of all commits"]);
    if (!measures.some(([v]) => v === state.measure)) state.measure = "share";
    buttons("measure", measures, "measure");
  }

  // ---------- key figures ----------
  function leader(view, tool) {
    if (state.mode === "big") {
      const rows = [...seriesOf("big", view, tool)].map(([k]) => [k, usedIn(k, view, tool)]).sort((a, b) => b[1] - a[1]);
      const base = baseIn(view, tool);
      if (!rows.length || !base || !rows[0][1]) return ["–", ""];
      return [nameOf(rows[0][0], view), `in ${fmtShare(rows[0][1] / base)} of ${baseLabel(view, tool)}`];
    }
    const rows = [...seriesOf(state.mode, view, tool)].map(([k, a]) => [k, inFrame(a)]).sort((a, b) => b[1] - a[1]);
    const total = sum(rows.map(([, v]) => v));
    if (!rows.length || !total) return ["–", ""];
    return [nameOf(rows[0][0], view), `${fmtShare(rows[0][1] / total)} of ${view === "models" ? "commits naming a model" : "AI-signed commits"}`];
  }
  function renderFigures() {
    const figures = [];
    if (state.mode === "big") {
      const b = D.big;
      const ai = inFrame(b.ai);
      const total = inFrame(b.total);
      const u = usedFrame();
      figures.push([total ? fmtShare(ai / total) : "–", "AI share of commits", `${fmtInt(ai)} of ${fmtInt(total)}`]);
      figures.push([u.all ? fmtShare(u.ai / u.all) : "–", "Projects using AI", `${fmtInt(u.ai ?? 0)} of ${fmtInt(u.all ?? 0)} active`]);
    } else {
      const tools = [...seriesOf(state.mode, "tools")].map(([, a]) => a);
      const total = sum(tools.map((a) => inFrame(a)));
      figures.push([fmtCount(total), "AI-signed commits", periodLabel()]);
    }
    const [model, modelSub] = leader("models", ALL);
    figures.push([model, "Top model", modelSub]);
    const [tool, toolSub] = leader("tools");
    figures.push([tool, "Top tool", toolSub]);
    if (state.mode === "big") {
      const [lab, labSub] = leader("labs");
      figures.push([lab, "Top lab", labSub]);
    }
    $("figures").style.setProperty("--n", figures.length);
    $("figures").replaceChildren(...figures.map(([value, label, sub]) =>
      el("div", { class: "figure" }, el("div", { class: "value" }, value), el("div", { class: "label" }, label), el("div", { class: "sub" }, sub))));
  }

  // ---------- chart ----------
  function chartData() {
    const byProjects = state.measure === "projects";
    const members = new Map();
    const groups = new Map();
    for (const [key, arr] of byProjects ? usedDaily() : seriesOf()) {
      const values = byProjects ? arr : trail(arr);
      const g = groupOf(key);
      members.set(key, { group: g, values });
      if (byProjects && g === "Other") continue; // distinct projects do not add up
      const t = groups.get(g) ?? new Array(N).fill(0);
      values.forEach((v, i) => (t[i] += v));
      groups.set(g, t);
    }
    const order = [...slots().keys(), "Other"].filter((g) => groups.has(g));
    const totals = byProjects ? baseDaily() : addUp([...groups.values()]);
    const all = state.measure === "all" ? trail(D.big.total) : null;
    const first = Math.min(N - 1, Math.max(frameFrom(), start() + TRAIL - 1));
    const series = order.map((g) => ({ group: g, values: groups.get(g) })).filter((s) => s.values.slice(first).some((v) => v > 0));
    const valueAt = (v, d) => {
      if (state.measure === "commits") return v / TRAIL;
      const denom = state.measure === "all" ? all[d] : totals[d];
      return denom ? v / denom : 0;
    };
    return { series, members, first, valueAt };
  }
  const fmtValue = (v) => (state.measure === "commits" ? `${fmtCount(v)}/day` : fmtShare(v));
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

  function chartTitle() {
    const what = { share: "share", projects: "projects", commits: "commits per day", all: "share of all commits" }[state.measure];
    if (state.view === "models") return `Models by ${what}${state.tool === ALL ? "" : `, ${toolName(state.tool)}`}`;
    return `${state.view === "tools" ? "Tools" : "Labs"} by ${what}`;
  }

  function renderChart() {
    const { series, members, first, valueAt } = chartData();
    const stacked = state.measure === "commits";
    $("chart-title").textContent = chartTitle();
    $("legend").replaceChildren(...series.map((s) =>
      el("li", {}, el("span", { class: `key${stacked ? " rect" : ""}`, style: { background: colorOf(s.group) } }), groupLabel(s.group))));
    renderTable(series, first, valueAt);
    const host = $("chart");
    host.replaceChildren();
    if (!series.length) return;

    const width = host.clientWidth || 800;
    const height = width < 600 ? 260 : 360;
    const m = { l: 48, r: 64, t: 12, b: 30 };
    const end = N - 1;
    const span = Math.max(1, end - first);
    const plotW = width - m.l - m.r;
    const x = (d) => m.l + (end === first ? plotW / 2 : ((d - first) / span) * plotW);
    const tops = series.map(() => new Array(N).fill(0));
    let max = 0;
    for (let d = first; d <= end; d++) {
      let cum = 0;
      series.forEach((s, j) => {
        const v = valueAt(s.values[d], d);
        cum += v;
        tops[j][d] = stacked ? cum : v;
        max = Math.max(max, tops[j][d]);
      });
    }
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const y = (v) => m.t + (1 - v / top) * (height - m.t - m.b);

    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img", "aria-label": chartTitle() });
    for (const t of ticks) {
      root.append(svg("line", { class: t === 0 ? "base" : "grid", x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
      const label = svg("text", { x: m.l - 10, y: y(t) + 4, "text-anchor": "end" });
      label.textContent = fmtAxis(t, stacked);
      root.append(label);
    }
    // Date ticks from the newest day backwards, so the latest date is always shown;
    // a week apart once days get too dense.
    const perDay = plotW / span;
    const every = perDay >= 64 ? 1 : 7 * Math.max(1, Math.ceil(64 / (perDay * 7)));
    for (let d = end; d >= first; d -= every) {
      root.append(svg("line", { class: "tick", x1: x(d), x2: x(d), y1: y(0), y2: y(0) + 4 }));
      const label = svg("text", { x: x(d), y: height - 8, "text-anchor": "middle" });
      label.textContent = fmtDay(d);
      root.append(label);
    }

    const pts = (arr) => {
      const out = [];
      for (let d = first; d <= end; d++) out.push(`${x(d).toFixed(1)},${y(arr[d]).toFixed(1)}`);
      return out;
    };
    series.forEach((s, j) => {
      const color = colorOf(s.group);
      const upper = pts(tops[j]);
      if (stacked) {
        const lower = j ? pts(tops[j - 1]).reverse() : [`${x(end).toFixed(1)},${y(0)}`, `${x(first).toFixed(1)},${y(0)}`];
        root.append(svg("path", { d: `M${upper.join("L")}L${lower.join("L")}Z`, fill: color, "fill-opacity": 0.22 }));
      }
      root.append(svg("path", { class: "line", d: `M${upper.join("L")}`, stroke: color }));
    });

    // Values at the line ends for the biggest named series; a label that would
    // collide with one already placed is left to the legend and the tooltip.
    const ends = series.map((s, j) => ({ j, y: y(tops[j][end]), value: stacked ? valueAt(s.values[end], end) : tops[j][end] }))
      .filter((e) => series[e.j].group !== "Other")
      .sort((a, b) => b.value - a.value).slice(0, END_LABELS);
    const placed = [];
    for (const e of ends) {
      if (placed.some((p) => Math.abs(p - e.y) < 15)) continue;
      placed.push(e.y);
      root.append(svg("circle", { class: "dot", cx: x(end), cy: e.y, r: 3.5, fill: colorOf(series[e.j].group) }));
      const label = svg("text", { class: "end", x: x(end) + 9, y: e.y + 4 });
      label.textContent = fmtValue(e.value);
      root.append(label);
    }

    const cross = svg("line", { class: "cross", y1: m.t, y2: height - m.b, visibility: "hidden" });
    const dots = series.map((s) => svg("circle", { class: "dot", r: 4.5, fill: colorOf(s.group), visibility: "hidden" }));
    root.append(cross, ...dots);
    const hit = svg("rect", { class: "hit", x: m.l - 8, y: 0, width: plotW + 16, height, fill: "transparent", tabindex: 0, "aria-label": "Chart values by day" });
    root.append(hit);
    host.append(root);

    const tip = $("tooltip");
    let current = end;
    function show(d, clientX, clientY) {
      current = d;
      cross.setAttribute("x1", x(d));
      cross.setAttribute("x2", x(d));
      cross.setAttribute("visibility", "visible");
      dots.forEach((dot, j) => {
        dot.setAttribute("cx", x(d));
        dot.setAttribute("cy", y(tops[j][d]));
        dot.setAttribute("visibility", "visible");
      });
      const rows = [...members]
        .map(([key, mm]) => ({ key, group: mm.group, v: valueAt(mm.values[d], d) }))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v);
      const shown = rows.slice(0, 10);
      tip.replaceChildren(el("div", { class: "head" }, `${TRAIL} days to ${fmtDay(d, true)}`), ...shown.map((r) =>
        el("div", { class: "row" }, el("span", { class: "key", style: { background: colorOf(r.group) } }),
          el("b", {}, fmtValue(r.v)), el("span", {}, nameOf(r.key)))));
      if (rows.length > shown.length) tip.append(el("div", { class: "more" }, `${rows.length - shown.length} more`));
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const px = clientX ?? box.left + (x(d) / width) * box.width;
      const py = clientY ?? box.top + 40;
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${px + 18 + w > window.innerWidth - 8 ? px - 18 - w : px + 18}px`;
      tip.style.top = `${Math.min(Math.max(8, py - h / 2), window.innerHeight - h - 8)}px`;
    }
    function hide() {
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      dots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
    }
    const dayAt = (clientX) => {
      const px = ((clientX - host.getBoundingClientRect().left) / host.clientWidth) * width;
      return Math.min(end, Math.max(first, Math.round(first + ((px - m.l) / plotW) * span)));
    };
    hit.addEventListener("pointermove", (e) => show(dayAt(e.clientX), e.clientX, e.clientY));
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", () => show(current));
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") show(Math.max(first, current - 1));
      if (e.key === "ArrowRight") show(Math.min(end, current + 1));
    });
  }

  function renderTable(series, first, valueAt) {
    const head = el("tr", {}, el("th", {}, `${TRAIL} days to`), ...series.map((s) => el("th", {}, groupLabel(s.group))));
    const body = [];
    for (let d = N - 1; d >= first; d--) {
      body.push(el("tr", {}, el("td", {}, fmtDay(d, true)), ...series.map((s) => el("td", {}, fmtValue(valueAt(s.values[d], d))))));
    }
    $("table").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
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
    const rows = [...seriesOf()]
      .map(([key, a]) => ({ key, value: inFrame(a), projects: big ? usedIn(key) : 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => (big ? b.projects - a.projects : 0) || b.value - a.value);
    const total = sum(rows.map((r) => r.value));
    const shown = rows.slice(0, 15);
    const size = (r) => (big ? r.projects : r.value);
    const max = Math.max(1, ...shown.map(size));
    const col = (text, title) => el("span", { class: "num", title }, text);
    const head = el("div", { class: "row head", role: "row" }, el("span"), el("span"), el("span"),
      ...(big ? [col("Projects", `Out of ${fmtInt(baseIn())} ${baseLabel()}`)] : []),
      col("Share", state.view === "models" ? "Share of the commits that name a model" : "Share of the AI commits in this view"),
      col("Commits", "Commits in the period"),
      ...(big ? [col("Lines", "Median lines changed per commit"), col("Reverted", "Share of commits reverted later")] : []));
    const quality = (st) => (big ? [
      el("span", { class: "dim" }, st ? fmtInt(st.ml) : ""),
      el("span", { class: "dim" }, st ? fmtShare(st.rv) : ""),
    ] : []);
    const items = [];
    shown.forEach((r, i) => {
      const st = statsOf(r.key);
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
      const st = D.big.frames[state.frame].stats;
      const u = usedFrame();
      for (const [key, label] of [["ai", "All AI"], ["none", "Without AI"]]) {
        if (st[key]) items.push(el("div", { class: "row base", role: "row" }, el("span"), el("span", {}, label), el("span"),
          el("span", { class: "num" }, fmtInt(u[key] ?? 0)), el("span"), el("span", { class: "dim" }, fmtCount(st[key].c)), ...quality(st[key])));
      }
    }
    board.replaceChildren(head, ...items);
    $("period").textContent = periodLabel();

    const notes = [];
    if (rows.length > shown.length) notes.push(`${rows.length - shown.length} more with ${fmtShare(sum(rows.slice(shown.length).map((r) => r.value)) / total)} of commits.`);
    if (state.view === "models") {
      const unnamed = inFrame(notStated());
      if (unnamed) notes.push(`${fmtShare(unnamed / (unnamed + total))} of ${state.tool === ALL ? "AI" : toolName(state.tool)} commits do not name the model.`);
    }
    if (big) notes.push("Select a row for its projects and commits.");
    $("note").textContent = notes.join(" ");
  }

  function render() {
    renderControls();
    const hash = `#${KEYS.map((k) => encodeURIComponent(state[k])).join("/")}`;
    if (location.hash !== hash) history.pushState(null, "", hash);
    $("scope").textContent = state.mode === "big"
      ? `Every commit to ${fmtInt(D.big.projects)} open-source projects with 10,000+ stars`
      : "Commits signed by AI tools in all public repositories";
    renderFigures();
    renderChart();
    renderBoard();
    $("footer").textContent = `Data from GitHub to ${fmtDay(N - 1, true)}, updated ${new Date(D.generated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.`;
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
