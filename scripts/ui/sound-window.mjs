import { MODULE_ID } from "../core/context.mjs";

// Foundry creates sound rows on a directory render. Keep detached rows in memory,
// then move only the rows near the viewport into the live DOM while scrolling.
const ROW_HEIGHT = 22;
const DEFAULT_WINDOW_SIZE = 60;
const MIN_WINDOW_SIZE = 60;
const MAX_WINDOW_SIZE = 300;
const WINDOW_SIZE_SETTING = "soundRowBudget";
const OVERSCAN = 30;
const EDGE_GUARD = 8;
const windows = new WeakMap();

function stateFor(app) {
  let state = windows.get(app);
  if (!state) {
    state = { records: [], search: false, pending: false, scrollport: null, resizeObserver: null };
    windows.set(app, state);
  }
  return state;
}

export function searchActive(app) {
  return stateFor(app).search;
}

function rowBudget() {
  const value = Number(game.settings.get(MODULE_ID, WINDOW_SIZE_SETTING));
  return Number.isFinite(value) ? Math.max(MIN_WINDOW_SIZE, Math.min(MAX_WINDOW_SIZE, value)) : DEFAULT_WINDOW_SIZE;
}

export function registerSoundWindowSettings() {
  game.settings.register(MODULE_ID, WINDOW_SIZE_SETTING, {
    name: "RNPLAYCOMP.Settings.SoundRowBudget.Name",
    hint: "RNPLAYCOMP.Settings.SoundRowBudget.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: MIN_WINDOW_SIZE, max: MAX_WINDOW_SIZE, step: 10 },
    default: DEFAULT_WINDOW_SIZE,
    onChange: () => {
      for (const app of [ui.playlists, ui.playlists?.popout]) {
        if (app) requestAnimationFrame(() => updateWindow(app, { force: true }));
      }
    },
  });
}

export function windowPlaylistContext(app, original, root, playlist) {
  const result = original.call(app, root, playlist);
  if (!app._expanded.has(playlist.id) && !searchActive(app)) result.sounds = [];
  return result;
}

function spacer(rows, position, rowHeight) {
  const item = document.createElement("li");
  item.className = `rn-virtual-spacer rn-virtual-${position}`;
  item.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", String(rows * rowHeight));
  item.append(svg);
  return item;
}

function visibleInterval({ total, top, bottom, rowHeight = ROW_HEIGHT }, viewportTop, viewportBottom) {
  if (!total || bottom <= viewportTop || top >= viewportBottom) return null;
  const start = Math.max(0, Math.min(total, Math.floor((viewportTop - top) / rowHeight)));
  const end = Math.max(start, Math.min(total, Math.ceil((viewportBottom - top) / rowHeight)));
  return start < end ? { start, end } : null;
}

/** Calculate one row budget for the entire directory, including short playlists. */
export function rangesForViewport(lists, viewportTop, viewportBottom, budget = DEFAULT_WINDOW_SIZE) {
  const ranges = new Map(lists.map(({ id }) => [id, { start: 0, end: 0 }]));
  const visible = lists.flatMap((list) => {
    const interval = visibleInterval(list, viewportTop, viewportBottom);
    return interval ? [{ ...list, ...interval }] : [];
  });
  const visibleCount = visible.reduce((sum, row) => sum + row.end - row.start, 0);
  let remaining = Math.max(budget, visibleCount);
  for (const row of visible) {
    ranges.set(row.id, { start: row.start, end: row.end });
    remaining -= row.end - row.start;
  }
  for (const row of visible) {
    if (!remaining) break;
    const range = ranges.get(row.id);
    const before = Math.min(OVERSCAN, range.start, remaining);
    range.start -= before;
    remaining -= before;
    const after = Math.min(OVERSCAN, row.total - range.end, remaining);
    range.end += after;
    remaining -= after;
  }
  return ranges;
}

function viewportCovered(lists, top, bottom) {
  // Keep a guard band before rebuilding rows so small scrolls do not repeatedly shift the DOM.
  return lists.every((list) => {
    const visible = visibleInterval(list, top, bottom);
    if (!visible) return true;
    const { start, end } = list.range;
    if (start === end) return false;
    return (
      visible.start >= start + (start ? EDGE_GUARD : 0) && visible.end <= end - (end < list.total ? EDGE_GUARD : 0)
    );
  });
}

function mountRange(record, range) {
  if (record.range.start === range.start && record.range.end === range.end) return false;
  const fragment = document.createDocumentFragment();
  if (range.start) fragment.append(spacer(range.start, "before", record.rowHeight));
  for (let index = range.start; index < range.end; index += 1) fragment.append(record.rows[index]);
  if (range.end < record.total) fragment.append(spacer(record.total - range.end, "after", record.rowHeight));
  record.list.replaceChildren(fragment);
  record.range = range;
  return true;
}

function updateWindow(app, { force = false } = {}) {
  const state = stateFor(app);
  const scrollport = state.scrollport;
  if (state.search || !scrollport?.isConnected) return;
  const viewport = scrollport.getBoundingClientRect();
  const lists = state.records.map((record) => {
    const bounds = record.list.getBoundingClientRect();
    const hidden = !record.element.classList.contains("expanded") || record.element.closest(".folder:not(.expanded)");
    return {
      id: record.id,
      total: record.total,
      top: hidden ? Infinity : bounds.top + record.paddingTop,
      bottom: hidden ? Infinity : bounds.bottom - record.paddingBottom,
      rowHeight: record.rowHeight,
      range: record.range,
    };
  });
  if (!force && viewportCovered(lists, viewport.top, viewport.bottom)) return;
  const ranges = rangesForViewport(lists, viewport.top, viewport.bottom, rowBudget());
  let changed = false;
  for (const record of state.records) changed = mountRange(record, ranges.get(record.id)) || changed;
  if (changed) state.decorateRows?.();
}

function scheduleWindow(app) {
  const state = stateFor(app);
  if (state.pending) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    updateWindow(app);
  });
}

// Let Foundry create sound rows for expanded playlists so its controls and
// handlers work normally. Then detach offscreen rows to keep scrolling fast.
// This still pays the cost of creating those rows on each directory render.
export function mountSoundWindows(app, element, decorateRows) {
  const state = stateFor(app);
  const scrollport = element.querySelector(".directory-list");
  if (!scrollport) return;
  // The playing/controls parts can render without replacing the directory.
  // Keep its detached row cache and scroll listener in that case.
  const freshList = scrollport.querySelector(".playlist.expanded .playlist-sounds:not(.rn-windowed)");
  if (state.scrollport === scrollport && state.records.every((record) => record.list.isConnected) && !freshList) return;
  state.resizeObserver?.disconnect();
  state.records = [];
  state.scrollport = scrollport;
  state.decorateRows = decorateRows;
  if (state.search) return;

  for (const playlist of scrollport.querySelectorAll(".playlist.expanded[data-entry-id]")) {
    const list = playlist.querySelector(":scope > .expandable .playlist-sounds");
    if (!list) continue;
    const rows = [...list.children].filter((row) => row.classList.contains("sound"));
    if (!rows.length) continue;
    list.classList.add("rn-windowed");
    const listStyle = getComputedStyle(list);
    const rowStyle = getComputedStyle(rows[0]);
    const measured = rows[0].getBoundingClientRect().height + Number.parseFloat(rowStyle.marginBottom);
    const record = {
      id: playlist.dataset.entryId,
      element: playlist,
      list,
      rows,
      total: rows.length,
      rowHeight: measured > 0 ? measured : ROW_HEIGHT,
      paddingTop: Number.parseFloat(listStyle.paddingTop) || 0,
      paddingBottom: Number.parseFloat(listStyle.paddingBottom) || 0,
      range: { start: 0, end: 0 },
    };
    state.records.push(record);
    list.replaceChildren(spacer(record.total, "after", record.rowHeight));
  }
  updateWindow(app, { force: true });
  scrollport.addEventListener("scroll", () => scheduleWindow(app), { passive: true });
  scrollport.addEventListener("transitionend", () => scheduleWindow(app));
  state.resizeObserver = new ResizeObserver(() => scheduleWindow(app));
  state.resizeObserver.observe(scrollport);
}

export function patchSoundWindows(Directory) {
  const prepare = Directory.prototype._preparePlaylistContext;
  Directory.prototype._preparePlaylistContext = function (root, playlist) {
    return windowPlaylistContext(this, prepare, root, playlist);
  };

  const activate = Directory.prototype._onActivate;
  Directory.prototype._onActivate = function (...args) {
    const result = activate?.apply(this, args);
    requestAnimationFrame(() => updateWindow(this, { force: true }));
    return result;
  };

  const click = Directory.prototype._onClickEntry;
  Directory.prototype._onClickEntry = async function (event, target) {
    const id = target.closest("[data-entry-id]")?.dataset.entryId;
    await click.call(this, event, target);
    if (!id) return;
    if (this._expanded.has(id)) {
      // While collapsed, this playlist had no sound rows. Re-render to create them,
      // then reapply expanded on the next frame to animate the new DOM.
      await this.render({ parts: ["directory"] });
      const row = this.element?.querySelector(`.playlist[data-entry-id="${CSS.escape(id)}"]`);
      if (row) {
        row.classList.remove("expanded");
        requestAnimationFrame(() => row.classList.add("expanded"));
      }
    } else {
      updateWindow(this, { force: true });
    }
  };

  const search = Directory.prototype._onSearchFilter;
  if (search) {
    Directory.prototype._onSearchFilter = function (...args) {
      const result = search.apply(this, args);
      const state = stateFor(this);
      const active = Boolean(String(args[1] ?? "").trim());
      if (state.search !== active) {
        state.search = active;
        queueMicrotask(() => this.render({ parts: ["directory"] }));
      }
      return result;
    };
  }
}
