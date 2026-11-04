import { MODULE_ID, reportError } from "../core/context.mjs";

const KEY = "soundQueue";
let transition = Promise.resolve();
// The GM uses one write lane for local edits and player requests.
let incoming = Promise.resolve();
const pending = new Map();

export function queueState() {
  return game.settings.get(MODULE_ID, KEY) ?? { entries: [], linked: null };
}

export function queueSound(entry) {
  if (!entry) return null;
  return game.playlists.get(entry.playlistId)?.sounds.get(entry.soundId);
}

export function canManageQueueSound(sound, user = game.user) {
  if (!sound?.parent || !user) return false;
  if (user.isGM) return true;
  return user.hasPermission("PLAYLIST_CREATE") && sound.parent.testUserPermission(user, "OWNER");
}

export function visibleQueueEntries(entries = queueState().entries) {
  return entries
    .map((entry, index) => ({ entry, index, sound: queueSound(entry) }))
    .filter(({ sound }) => canManageQueueSound(sound));
}

export function soundEntry(sound) {
  return { playlistId: sound.parent.id, soundId: sound.id };
}

export function sameSound(a, b) {
  return a?.playlistId === b?.playlistId && a?.soundId === b?.soundId;
}

export function changeQueue(change) {
  // Serialize read-modify-write operations so rapid clicks cannot overwrite earlier queue edits.
  const run = transition.then(async () => {
    if (game.user.isGM) {
      // Read after earlier GM writes finish, so a local click cannot overwrite a player's edit.
      const write = incoming.then(async () => {
        const current = queueState();
        const next = change({ entries: [...current.entries], linked: current.linked });
        await game.settings.set(MODULE_ID, KEY, next);
      });
      incoming = write.catch(() => {});
      await write;
      return;
    }
    const current = queueState();
    const next = change({ entries: [...current.entries], linked: current.linked });
    // This branch is for non-GMs who can write world settings themselves.
    if (game.user.hasPermission("SETTINGS_MODIFY")) {
      await game.settings.set(MODULE_ID, KEY, next);
      return;
    }
    const gm = [...game.users].find((user) => user.active && user.isGM);
    if (!gm) throw new Error("An active GM is required to update the play queue.");
    const requestId = foundry.utils.randomID();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Play queue update timed out."));
      }, 10000);
      pending.set(requestId, { resolve, reject, timeout });
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "queue-change",
        sender: game.user.id,
        target: gm.id,
        requestId,
        before: current,
        after: next,
      });
    });
  });
  // Keep later edits running after a failure.
  // The caller reports this rejection once.
  transition = run.catch(() => {});
  return run;
}

export function receiveQueueMessage(message) {
  if (message.type === "queue-result" && message.target === game.user.id) {
    const request = pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.requestId);
    if (message.ok) request.resolve();
    else request.reject(new Error(`Play queue update was rejected: ${message.reason ?? "unknown reason"}.`));
    return;
  }
  if (message.type !== "queue-change" || !game.user.isGM || message.target !== game.user.id) return;
  incoming = incoming
    .then(async () => {
      const sender = game.users.get(message.sender);
      const reason = queueChangeRejection(message, sender);
      try {
        if (!reason) await game.settings.set(MODULE_ID, KEY, message.after);
        game.socket.emit(`module.${MODULE_ID}`, {
          type: "queue-result",
          sender: game.user.id,
          target: sender?.id,
          requestId: message.requestId,
          ok: !reason,
          reason,
        });
      } catch (cause) {
        reportError(cause);
        game.socket.emit(`module.${MODULE_ID}`, {
          type: "queue-result",
          sender: game.user.id,
          target: sender?.id,
          requestId: message.requestId,
          ok: false,
          reason: "world setting write failed",
        });
      }
    })
    .catch(reportError);
}

function queueChangeRejection(message, sender) {
  if (!sender?.hasPermission("PLAYLIST_CREATE")) return "playlist management permission missing";
  if (!Array.isArray(message.before?.entries) || !Array.isArray(message.after?.entries)) return "invalid queue data";
  const current = queueState();
  const entries = (state) => state.entries.map((entry) => ({ playlistId: entry.playlistId, soundId: entry.soundId }));
  if (
    JSON.stringify(entries(message.before)) !== JSON.stringify(entries(current)) ||
    (!sameSound(message.before.linked, current.linked) && (message.before.linked || current.linked))
  )
    return "queue changed while editing";
  if (
    !message.after.entries.every(
      (entry) => entry && typeof entry.playlistId === "string" && typeof entry.soundId === "string",
    )
  )
    return "invalid sound entry";
  const hidden = (state) => entries(state).filter((entry) => !canManageQueueSound(queueSound(entry), sender));
  if (JSON.stringify(hidden(message.before)) !== JSON.stringify(hidden(message.after)))
    return "hidden queue entries changed";
  if (
    message.after.linked &&
    !canManageQueueSound(queueSound(message.after.linked), sender) &&
    !sameSound(message.before.linked, message.after.linked)
  )
    return "linked sound is not owned";
  if (
    message.before.linked &&
    !canManageQueueSound(queueSound(message.before.linked), sender) &&
    !sameSound(message.before.linked, message.after.linked)
  ) {
    const withoutPlayed = [...message.before.entries];
    const playedIndex = withoutPlayed.findIndex((entry) => sameSound(entry, message.after.linked));
    if (playedIndex >= 0) withoutPlayed.splice(playedIndex, 1);
    if (
      playedIndex < 0 ||
      !canManageQueueSound(queueSound(message.after.linked), sender) ||
      JSON.stringify(withoutPlayed) !== JSON.stringify(message.after.entries)
    )
      return "hidden linked sound changed";
  }
  return null;
}

export function addToQueue(sound) {
  if (!canManageQueueSound(sound)) return Promise.resolve(false);
  return changeQueue((state) => {
    state.entries.push(soundEntry(sound));
    return state;
  });
}

export function toggleQueueLink(sound) {
  if (!canManageQueueSound(sound)) return Promise.resolve(false);
  return changeQueue((state) => {
    const entry = soundEntry(sound);
    state.linked = sameSound(state.linked, entry) ? null : entry;
    return state;
  });
}

async function startQueuedSound(index) {
  const current = queueState();
  const selected =
    index == null
      ? visibleQueueEntries(current.entries)[0]
      : visibleQueueEntries(current.entries).find((item) => item.index === index);
  if (!selected) return;
  // Keep the chosen occurrence stable if another edit moves or duplicates the same sound.
  const occurrence = current.entries
    .slice(0, selected.index + 1)
    .filter((entry) => sameSound(entry, selected.entry)).length;
  let linked;
  let next;
  // Commit removal and relinking together; never stop the old sound if the write fails.
  await changeQueue((state) => {
    let seen = 0;
    const position = state.entries.findIndex((entry) => sameSound(entry, selected.entry) && ++seen === occurrence);
    if (position < 0 || !canManageQueueSound(queueSound(state.entries[position])))
      throw new Error("Selected queued sound is no longer available.");
    linked = queueSound(state.linked);
    [next] = state.entries.splice(position, 1);
    state.linked = next;
    return state;
  });
  if (linked?.playing && canManageQueueSound(linked)) await linked.parent.stopSound(linked);
  const sound = queueSound(next);
  if (sound) await sound.parent.playSound(sound);
}

export function playQueueNext() {
  return startQueuedSound(null);
}

export function playQueueEntry(index) {
  return startQueuedSound(index);
}

export function installQueuePlayback() {
  game.settings.register(MODULE_ID, KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: { entries: [], linked: null },
    onChange: () => ui.playlists?.render(),
  });
  const Playlist = foundry.documents.Playlist;
  const originalEnd = Playlist.prototype._onSoundEnd;
  Playlist.prototype._onSoundEnd = async function (sound) {
    const linked = queueState().linked;
    // Only this sound may replace its playlist's normal end-of-track behavior.
    if (!sameSound(linked, soundEntry(sound)) || sound.repeat) return originalEnd.call(this, sound);
    if (!visibleQueueEntries().length) {
      // An exhausted queue ends playback instead of advancing the normal playlist.
      await changeQueue((state) => {
        if (sameSound(state.linked, soundEntry(sound))) state.linked = null;
        return state;
      });
      await this.stopSound(sound);
      return this;
    }
    await playQueueNext();
    return this;
  };
}
