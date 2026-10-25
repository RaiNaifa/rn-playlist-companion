import { state, t } from "../core/context.mjs";
import { resolveLocalConflict } from "../library/conflicts.mjs";
import { serialize, serializeFolders } from "../storage/global-store.mjs";
import { branchComparison, soundTable } from "./archive-comparison.mjs";

const html = (value) => foundry.utils.escapeHTML(String(value ?? ""));
const dialog = () => foundry.applications.api.DialogV2;
export async function openConflictDialog({ showEmpty = false } = {}) {
  if (!game.user.isGM) return;
  if (showEmpty && !state.conflicts.length) {
    await dialog().prompt({
      window: { title: t("Archive.ConflictTitle") },
      content: `<p>${t("Archive.NoConflicts")}</p>`,
    });
    return;
  }
  const deferred = new Set();
  while (true) {
    const conflict = state.conflicts.find((item) => !deferred.has(`${item.type}:${item.id}`));
    if (!conflict) return;
    const content = `<div class="rn-archive-dialog"><p>${t("Archive.ConflictIntro")}</p>
      <table><tbody><tr><th>${t("Archive.Local")}</th><td>${html(conflict.local)}</td></tr>
      <tr><th>${t("Archive.Global")}</th><td>${html(conflict.global)}</td></tr>
      <tr><th>ID</th><td>${html(conflict.id)}</td></tr></tbody></table>
      <p>${t("Archive.ConflictKeep")}</p></div>`;
    const action = await dialog().wait({
      window: { title: t("Archive.ConflictTitle") },
      position: { width: 550 },
      content,
      buttons: [
        { action: "compare", label: t("Archive.CompareConflicts"), icon: "fa-solid fa-table-columns" },
        { action: "both", label: t("Archive.KeepBoth"), icon: "fa-solid fa-copy" },
        { action: "later", label: t("Archive.KeepLocal"), default: true },
      ],
    });
    if (action === "compare") {
      const local = conflict.type === "playlist" ? game.playlists.get(conflict.id) : game.folders.get(conflict.id);
      const global =
        conflict.type === "playlist" ? state.blockedPlaylists.get(conflict.id) : state.blockedFolders.get(conflict.id);
      const localData = local?.toObject();
      const globalData = global?.toObject?.() ?? global;
      const comparison =
        conflict.type === "playlist"
          ? soundTable(localData, globalData, t("Archive.LocalShort"), t("Archive.GlobalShort"))
          : branchComparison(
              conflict.id,
              game.folders
                .filter((item) => item.type === "Playlist" && !state.folders.has(item.id))
                .map((item) => item.toObject()),
              game.playlists.filter((item) => !state.playlists.has(item.id)).map((item) => item.toObject()),
              serializeFolders(),
              serialize(),
              t("Archive.LocalShort"),
              t("Archive.GlobalShort"),
            );
      await dialog().wait({
        window: { title: t("Archive.CompareConflicts"), resizable: true },
        position: { width: 700 },
        content: `<div class="rn-archive-dialog">${comparison}</div>`,
        buttons: [{ action: "back", label: t("Archive.Back"), default: true }],
      });
      continue;
    }
    if (action === "later") {
      deferred.add(`${conflict.type}:${conflict.id}`);
      continue;
    }
    if (action !== "both") return;
    await resolveLocalConflict(conflict.type, conflict.id);
  }
}
