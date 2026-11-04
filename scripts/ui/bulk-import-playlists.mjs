import { reportError, t } from "../core/context.mjs";

const FilePicker = () => foundry.applications.apps.FilePicker;

function directoryName(path) {
  return decodeURIComponent(path.replace(/\/$/, "").split("/").at(-1) || path);
}

function isAudio(path) {
  const extension = path.split(/[?#]/, 1)[0].split(".").at(-1)?.toLowerCase();
  return Object.hasOwn(CONST.AUDIO_FILE_EXTENSIONS, extension);
}

export async function scanPlaylistDirectory(path) {
  // Browse server-visible User Data so imported sound paths remain usable by Foundry.
  const listing = await FilePicker().browse("data", path);
  const children = [];
  for (const directory of listing.dirs ?? []) children.push(await scanPlaylistDirectory(directory));
  return {
    name: directoryName(path),
    files: (listing.files ?? []).filter(isAudio),
    children,
  };
}

export function planPlaylistImport(tree, createEmpty = false) {
  const folders = [];
  const playlists = [];
  function visit(node, parent = null) {
    const includedChildren = node.children.filter((child) => hasContent(child) || createEmpty);
    // A directory with subdirectories becomes a Foundry folder. Its own audio, if any, becomes a playlist inside it.
    const needsFolder = includedChildren.length > 0;
    const folderKey = needsFolder ? [...(parent ?? []), node.name] : parent;
    if (needsFolder) folders.push({ key: folderKey, parent, name: node.name });
    // Empty leaf directories become playlists only when the user explicitly enables that option.
    if (node.files.length || (createEmpty && !includedChildren.length)) {
      playlists.push({ name: node.name, folderKey, files: node.files });
    }
    for (const child of includedChildren) visit(child, folderKey);
  }
  function hasContent(node) {
    return node.files.length > 0 || node.children.some(hasContent);
  }
  if (hasContent(tree) || createEmpty) visit(tree);
  return { folders, playlists };
}

export function renderImportTree(tree, createEmpty = false) {
  const escapeHTML = foundry.utils.escapeHTML;
  const hasContent = (node) => node.files.length > 0 || node.children.some(hasContent);
  function renderNode(node) {
    const children = node.children.filter((child) => createEmpty || hasContent(child));
    const folder = children.length > 0;
    const playlist = node.files.length > 0 || (createEmpty && !folder);
    const rows = [];
    if (folder) {
      const ownPlaylist = playlist ? renderPlaylist(node) : "";
      rows.push(
        `<li><span class="rn-import-folder"><i class="fa-solid fa-folder" aria-hidden="true"></i> ${escapeHTML(node.name)}</span><ul>${ownPlaylist}${children.map(renderNode).join("")}</ul></li>`,
      );
    } else if (playlist) rows.push(renderPlaylist(node));
    return rows.join("");
  }
  function renderPlaylist(node) {
    return `<li><span class="rn-import-playlist"><i class="fa-solid fa-music" aria-hidden="true"></i> ${escapeHTML(node.name)} <small>${escapeHTML(t("BulkImport.SoundCount", { count: node.files.length }))}</small></span></li>`;
  }
  return hasContent(tree) || createEmpty
    ? `<ul class="rn-import-tree">${renderNode(tree)}</ul>`
    : `<p class="rn-import-empty">${escapeHTML(t("BulkImport.NoAudio"))}</p>`;
}

async function chooseDirectory() {
  return foundry.applications.api.DialogV2.prompt({
    window: { title: t("BulkImport.Title") },
    content: `<p>${foundry.utils.escapeHTML(t("BulkImport.Description"))}</p>
      <file-picker name="directory" type="folder" placeholder="${foundry.utils.escapeHTML(t("BulkImport.PathPlaceholder"))}"></file-picker>`,
    ok: {
      label: t("BulkImport.ShowPreview"),
      callback: (_event, button) => {
        const field = button.form.querySelector('file-picker[name="directory"]');
        // A typed path has no picker instance.
        // In that case it is interpreted in the User Data source.
        return { path: String(field.value ?? "").trim(), source: field.picker?.activeSource ?? "data" };
      },
    },
  });
}

async function confirmImport(tree) {
  // Both previews are rendered up front. CSS switches them with the checkbox without rescanning the server.
  const normal = planPlaylistImport(tree);
  const withEmpty = planPlaylistImport(tree, true);
  const sounds = normal.playlists.reduce((total, playlist) => total + playlist.files.length, 0);
  return foundry.applications.api.DialogV2.prompt({
    window: { title: t("BulkImport.Title") },
    content: `<div class="rn-import-preview">
      <p>${foundry.utils.escapeHTML(t("BulkImport.Source", { name: tree.name }))}</p>
      <label class="rn-bulk-import-option"><input type="checkbox" name="createEmpty"> ${foundry.utils.escapeHTML(t("BulkImport.CreateEmpty"))}</label>
      <p class="rn-import-heading">${foundry.utils.escapeHTML(t("BulkImport.WillCreate"))}</p>
      <div class="rn-import-default">${renderImportTree(tree)}</div>
      <div class="rn-import-with-empty">${renderImportTree(tree, true)}</div>
      <p class="rn-import-count rn-import-default">${foundry.utils.escapeHTML(t("BulkImport.Count", { folders: normal.folders.length, playlists: normal.playlists.length, sounds }))}</p>
      <p class="rn-import-count rn-import-with-empty">${foundry.utils.escapeHTML(t("BulkImport.Count", { folders: withEmpty.folders.length, playlists: withEmpty.playlists.length, sounds }))}</p>
    </div>`,
    ok: {
      label: t("BulkImport.Import"),
      callback: (_event, button) => button.form.elements.createEmpty.checked,
    },
  });
}

export async function importPlaylistDirectory(tree, createEmpty = false) {
  const plan = planPlaylistImport(tree, createEmpty);
  const maxDepth = CONST.FOLDER_MAX_DEPTH;
  if (plan.folders.some((folder) => folder.key.length > maxDepth)) {
    throw new Error(t("BulkImport.TooDeep", { depth: maxDepth }));
  }
  const folderIds = new Map();
  let sounds = 0;
  // The plan is parent-first. Resolve each planned path to its new Foundry ID before creating descendants.
  for (const folder of plan.folders) {
    const created = await Folder.create({
      name: folder.name,
      type: "Playlist",
      folder: folder.parent ? folderIds.get(folder.parent.join("/")) : null,
    });
    folderIds.set(folder.key.join("/"), created.id);
  }
  for (const entry of plan.playlists) {
    const playlist = await Playlist.create({
      name: entry.name,
      folder: entry.folderKey ? folderIds.get(entry.folderKey.join("/")) : null,
    });
    if (entry.files.length) {
      const imported = await playlist.bulkImportSounds(entry.files);
      sounds += imported.length;
    }
  }
  return { folders: plan.folders.length, playlists: plan.playlists.length, sounds };
}

export async function openBulkImportPlaylists() {
  if (!game.user.isGM) return;
  try {
    const selection = await chooseDirectory();
    if (!selection) return;
    if (!selection.path) throw new Error(t("BulkImport.SelectFolder"));
    if (selection.source !== "data") throw new Error(t("BulkImport.DataOnly"));
    const tree = await scanPlaylistDirectory(selection.path);
    const createEmpty = await confirmImport(tree);
    if (createEmpty == null) return;
    const result = await importPlaylistDirectory(tree, createEmpty);
    ui.notifications.info(t("BulkImport.Complete", result));
  } catch (cause) {
    reportError(cause);
  }
}
