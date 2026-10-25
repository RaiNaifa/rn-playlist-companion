import { MODULE_ID, reportError, state, t } from "../core/context.mjs";
import { archivedBranch, forgetArchiveEntry, restoreArchived } from "../library/archive.mjs";
import { reloadGlobalPlaylists } from "../library/global-library.mjs";
import { missingIndexedPlaylists, readArchive, serialize, serializeFolders } from "../storage/global-store.mjs";
import { branchComparison, soundTable } from "./archive-comparison.mjs";

const html = (value) => foundry.utils.escapeHTML(String(value ?? ""));
const dialog = () => foundry.applications.api.DialogV2;
const dateLabel = (date) =>
  new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));

export function registerArchiveSettings() {
  class ArchiveSettingsMenu extends foundry.applications.api.ApplicationV2 {
    render() {
      openArchiveDialog().catch(reportError);
      return this;
    }
  }
  game.settings.registerMenu(MODULE_ID, "globalArchive", {
    name: "RNPLAYCOMP.Archive.Title",
    label: "RNPLAYCOMP.UI.OpenArchive",
    hint: "RNPLAYCOMP.Settings.GlobalArchive.Hint",
    icon: "fa-solid fa-box-archive",
    type: ArchiveSettingsMenu,
    restricted: true,
  });
}

function reason(entry) {
  const text = t(`Archive.Reason.${entry.reason}`);
  return entry.world ? `${text} (${html(entry.worldName ?? entry.world)})` : text;
}

function branchSummary(entry, entries) {
  const batch = archivedBranch(entries, entry);
  const folders = batch.filter((item) => item.type === "folder").length;
  const playlists = batch.filter((item) => item.type === "playlist").length;
  return `<p>${t("Archive.BranchCount", { folders, playlists })}</p>${branchComparison(
    entry.id,
    batch.filter((item) => item.type === "folder").map((item) => item.data),
    batch.filter((item) => item.type === "playlist").map((item) => item.data),
    serializeFolders(),
    serialize(),
    t("Archive.Saved"),
    t("Archive.Current"),
  )}`;
}

async function inspect(entry, entries, { readOnly = false } = {}) {
  const current = entry.type === "playlist" ? state.playlists.get(entry.id) : state.folders.get(entry.id);
  const blocked = entry.type === "playlist" ? state.blockedPlaylists.get(entry.id) : state.blockedFolders.get(entry.id);
  const currentData = current?.toObject() ?? blocked;
  const playlistIds = new Set(
    archivedBranch(entries, entry)
      .filter((item) => item.type === "playlist")
      .map((item) => item.id),
  );
  const linkedScenes = [...game.scenes].filter((scene) => playlistIds.has(scene._source.playlist)).length;
  const content = `<div class="rn-archive-dialog">
    ${readOnly ? `<p>${t("Archive.ReadOnlyUntilRepaired")}</p>` : ""}
    <p><strong>${html(entry.name)}</strong><br><small>${html(dateLabel(entry.archivedAt))} · ${reason(entry)}</small></p>
    ${entry.restoredAs ? `<p>${t("Archive.RestoredAs", { id: html(entry.restoredAs) })}</p>` : ""}
    ${entry.type === "playlist" ? soundTable(entry.data, currentData) : branchSummary(entry, entries)}
    ${linkedScenes ? `<label><input type="checkbox" name="relinkScenes"> ${t("Archive.RelinkScenes", { count: linkedScenes })}</label>` : ""}
    <p>${t("Archive.SnapshotKept")}</p>
  </div>`;
  const action = await dialog().wait({
    window: { title: t("Archive.Details"), resizable: true },
    position: { width: 700 },
    content,
    buttons: [
      ...(!readOnly
        ? [
            {
              action: "separate",
              label: t(currentData ? "Archive.RestoreSeparate" : "Archive.RestoreGlobal"),
              icon: "fa-solid fa-copy",
              callback: (_event, button) => ({
                action: "separate",
                relinkScenes: Boolean(button.form.querySelector("[name=relinkScenes]")?.checked),
              }),
            },
          ]
        : []),
      ...(!readOnly && current
        ? [
            {
              action: "replace",
              label: t("Archive.ReplaceCurrent"),
              icon: "fa-solid fa-rotate-left",
              callback: (_event, button) => ({
                action: "replace",
                relinkScenes: Boolean(button.form.querySelector("[name=relinkScenes]")?.checked),
              }),
            },
          ]
        : []),
      ...(!readOnly ? [{ action: "forget", label: t("Archive.Forget"), icon: "fa-solid fa-trash" }] : []),
      { action: "back", label: t("Archive.Back"), default: true },
    ],
  });
  if (action?.action === "separate" || action?.action === "replace") {
    const confirmed = await dialog().confirm({
      window: { title: t("Archive.ConfirmTitle") },
      content: `<p class="rn-confirm-message">${t(action.action === "replace" ? "Archive.ReplaceWarning" : currentData ? "Archive.SeparateWarning" : "Archive.RestoreWarning")}</p>`,
      yes: { label: t("Archive.Confirm") },
    });
    if (confirmed) await restoreArchived(entry.archiveId, action.action, { relinkScenes: action.relinkScenes });
  } else if (action === "forget") {
    const confirmed = await dialog().confirm({
      window: { title: t("Archive.Forget") },
      content: `<p class="rn-confirm-message">${t(entry.type === "folder" ? "Archive.ForgetBranchWarning" : "Archive.ForgetWarning")}</p>`,
      yes: { label: t("Archive.Forget") },
    });
    if (confirmed) await forgetArchiveEntry(entry.archiveId);
  }
}

export async function openArchiveDialog() {
  if (!game.user.isGM) return;
  while (true) {
    const health = await missingIndexedPlaylists();
    if (health.missingIndex || health.ids.length) await reloadGlobalPlaylists();
    const entries = (await readArchive()).entries;
    const cards = entries
      .map(
        (
          entry,
          index,
        ) => `<label class="rn-archive-entry"><input type="radio" name="archiveId" value="${html(entry.archiveId)}" ${index === 0 ? "checked" : ""}>
        <span class="rn-archive-entry-text"><strong>${html(entry.name)}</strong><small>${t(`Archive.Type.${entry.type}`)} · ${html(dateLabel(entry.archivedAt))}<br>${reason(entry)}</small></span></label>`,
      )
      .join("");
    const content = `<div class="rn-archive-dialog"><p>${t("Archive.Intro")}</p>
      ${entries.length ? `<div class="rn-archive-entries">${cards}</div>` : `<p>${t("Archive.Empty")}</p>`}</div>`;
    const chosen = await dialog().wait({
      window: { title: t("Archive.Title") },
      position: { width: 620 },
      content,
      buttons: [
        ...(entries.length
          ? [
              {
                action: "open",
                label: t("Archive.Open"),
                callback: (_event, button) => button.form.querySelector("[name=archiveId]:checked")?.value,
              },
            ]
          : []),
        { action: "close", label: t("Archive.Close"), default: true },
      ],
    });
    if (!chosen || chosen === "close") return;
    const entry = entries.find((item) => item.archiveId === chosen);
    if (entry) await inspect(entry, entries, { readOnly: !state.ready });
  }
}
