import { storedData } from "../audio/playback-state.mjs";
import { t } from "../core/context.mjs";

const html = (value) => foundry.utils.escapeHTML(String(value ?? ""));
const fieldLabel = (name) => {
  const key = `RNPLAYCOMP.Archive.Fields.${name}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : name;
};
function value(value, field) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? t("Archive.Yes") : t("Archive.No");
  if (typeof value === "object") return t("Archive.ChangedContent");
  if (field === "volume" && typeof value === "number") return `${Math.round(value * 100)}%`;
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function soundDifference(archived, current, leftLabel = t("Archive.Saved"), rightLabel = t("Archive.Current")) {
  const ignore = new Set(["playing", "pausedTime", "_stats"]);
  const names = new Set([...Object.keys(archived), ...Object.keys(current)]);
  const changed = [...names].filter(
    (name) => !ignore.has(name) && JSON.stringify(archived[name]) !== JSON.stringify(current[name]),
  );
  if (!changed.length) return "";
  const rows = changed
    .map(
      (name) =>
        `<tr><th>${html(fieldLabel(name))}</th><td>${html(value(archived[name], name))}</td><td>${html(value(current[name], name))}</td></tr>`,
    )
    .join("");
  return `<table class="rn-archive-diff"><thead><tr><th>${t("Archive.Field")}</th><th>${leftLabel}</th><th>${rightLabel}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function soundTable(archived, current, leftLabel = t("Archive.Saved"), rightLabel = t("Archive.Current")) {
  if (!current) {
    const sounds = [...(archived?.sounds ?? [])].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    if (!sounds.length) return `<p>${t("Archive.NoSounds")}</p>`;
    return `<h3>${t("Archive.ArchivedSounds")}</h3><ul class="rn-archive-sounds">${sounds.map((sound) => `<li class="rn-archive-sound">${html(sound.name)}</li>`).join("")}</ul>`;
  }
  const saved = new Map((archived?.sounds ?? []).map((sound) => [sound._id, sound]));
  const now = new Map((current?.sounds ?? []).map((sound) => [sound._id, sound]));
  const playlistSettings = (data) => {
    const { sounds, ...settings } = storedData(data);
    return settings;
  };
  const settingsDiff = soundDifference(playlistSettings(archived), playlistSettings(current), leftLabel, rightLabel);
  const settingsStatus = settingsDiff ? "different" : "same";
  const settingsMarker = settingsDiff ? "≠" : "✓";
  const settingsTooltip = settingsDiff
    ? ` data-tooltip-html="${html(settingsDiff)}"`
    : ` data-tooltip="${html(t("Archive.Same"))}"`;
  const ids = [...new Set([...saved.keys(), ...now.keys()])].sort((a, b) =>
    String(saved.get(a)?.name ?? now.get(a)?.name ?? a).localeCompare(
      String(saved.get(b)?.name ?? now.get(b)?.name ?? b),
      game.i18n.lang,
    ),
  );
  const settingsRow = `<tr><td>${t("Archive.Type.playlist")}</td><td>${t("Archive.Type.playlist")}</td><td class="rn-archive-status rn-archive-${settingsStatus}"${settingsTooltip}>${settingsMarker}</td></tr>`;
  const rows = ids
    .map((id) => {
      const left = saved.get(id);
      const right = now.get(id);
      const differences = left && right ? soundDifference(left, right, leftLabel, rightLabel) : "";
      const status = !left || !right ? "missing" : differences ? "different" : "same";
      const marker = { missing: "×", different: "≠", same: "✓" }[status];
      const tooltip = differences
        ? ` data-tooltip-html="${html(differences)}"`
        : ` data-tooltip="${html(t(left && right ? "Archive.Same" : "Archive.Missing"))}"`;
      return `<tr><td>${html(left?.name ?? "—")}</td><td>${html(right?.name ?? "—")}</td><td class="rn-archive-status rn-archive-${status}"${tooltip}>${marker}</td></tr>`;
    })
    .join("");
  return `<p class="rn-archive-legend"><span class="rn-archive-same">✓</span> ${t("Archive.LegendSame")} · <span class="rn-archive-missing">×</span> ${t("Archive.LegendMissing")} · <span class="rn-archive-different">≠</span> ${t("Archive.LegendDifferent")}</p><table class="rn-archive-table"><thead><tr><th>${leftLabel}</th><th>${rightLabel}</th><th>${t("Archive.Status")}</th></tr></thead><tbody>${settingsRow}${rows}</tbody></table>`;
}

function branchRows(rootId, folders, playlists) {
  const folderChildren = new Map();
  const playlistChildren = new Map();
  for (const folder of folders) {
    const children = folderChildren.get(folder.folder) ?? [];
    children.push(folder);
    folderChildren.set(folder.folder, children);
  }
  for (const playlist of playlists) {
    const children = playlistChildren.get(playlist.folder) ?? [];
    children.push(playlist);
    playlistChildren.set(playlist.folder, children);
  }
  const rows = [];
  const visited = new Set();
  const walk = (folderId, depth = 0) => {
    if (visited.has(folderId)) return;
    visited.add(folderId);
    for (const folder of folderChildren.get(folderId) ?? []) {
      rows.push({ type: "folder", depth: depth + 1, data: folder });
      walk(folder._id, depth + 1);
    }
    for (const playlist of playlistChildren.get(folderId) ?? []) {
      rows.push({ type: "playlist", depth: depth + 1, data: playlist });
    }
  };
  const root = folders.find((folder) => folder._id === rootId);
  if (!root) return [];
  rows.push({ type: "folder", depth: 0, data: root });
  walk(rootId);
  return rows;
}

export function branchComparison(
  rootId,
  leftFolders,
  leftPlaylists,
  rightFolders,
  rightPlaylists,
  leftLabel,
  rightLabel,
) {
  const left = branchRows(rootId, leftFolders, leftPlaylists);
  const right = branchRows(rootId, rightFolders, rightPlaylists);
  if (!right.length) {
    const items = left.map(
      (item) => `<li>${html(item.data.name)} <small>(${t(`Archive.Type.${item.type}`)})</small></li>`,
    );
    return `<ul class="rn-archive-sounds">${items.join("")}</ul>`;
  }
  const rightById = new Map(right.map((item) => [`${item.type}:${item.data._id}`, item]));
  const leftKeys = new Set(left.map((item) => `${item.type}:${item.data._id}`));
  const paired = [
    ...left.map((item) => [item, rightById.get(`${item.type}:${item.data._id}`)]),
    ...right.filter((item) => !leftKeys.has(`${item.type}:${item.data._id}`)).map((item) => [null, item]),
  ];
  const rows = paired
    .map(([saved, current]) => {
      const differences =
        saved && current
          ? soundDifference(
              saved.type === "playlist" ? storedData(saved.data) : saved.data,
              current.type === "playlist" ? storedData(current.data) : current.data,
              leftLabel,
              rightLabel,
            )
          : "";
      const status = !saved || !current ? "missing" : differences ? "different" : "same";
      const marker = { missing: "×", different: "≠", same: "✓" }[status];
      const tooltip = differences
        ? ` data-tooltip-html="${html(differences)}"`
        : ` data-tooltip="${html(t(saved && current ? "Archive.Same" : "Archive.Missing"))}"`;
      const cell = (item) =>
        item
          ? `<span class="rn-archive-branch-name" style="--rn-depth: ${item.depth}">${html(item.data.name)} <small>(${t(`Archive.Type.${item.type}`)})</small></span>`
          : "—";
      return `<tr><td>${cell(saved)}</td><td>${cell(current)}</td><td class="rn-archive-status rn-archive-${status}"${tooltip}>${marker}</td></tr>`;
    })
    .join("");
  return `<p class="rn-archive-legend"><span class="rn-archive-same">✓</span> ${t("Archive.LegendSame")} · <span class="rn-archive-missing">×</span> ${t("Archive.LegendMissing")} · <span class="rn-archive-different">≠</span> ${t("Archive.LegendDifferent")}</p><table class="rn-archive-table"><thead><tr><th>${leftLabel}</th><th>${rightLabel}</th><th>${t("Archive.Status")}</th></tr></thead><tbody>${rows}</tbody></table>`;
}
