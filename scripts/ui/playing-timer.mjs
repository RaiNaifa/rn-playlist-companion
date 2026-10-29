import { readBounds } from "../audio/bounds.mjs";

export function boundedPlayingTime(playlistSound) {
  const audio = playlistSound?.sound;
  if (!audio) return null;
  const bounds = readBounds(playlistSound, audio.buffer?.duration ?? audio.element?.duration);
  if (!bounds) return null;
  const duration = bounds.end - bounds.start;
  const position = playlistSound.playing ? audio.currentTime : playlistSound.pausedTime;
  return {
    current: Number.isFinite(position) ? Math.max(0, Math.min(duration, position - bounds.start)) : null,
    duration,
  };
}

export function patchPlayingTimer(Directory) {
  const prepare = Directory.prototype._preparePlaylistContext;
  Directory.prototype._preparePlaylistContext = function (root, playlist) {
    const result = prepare.call(this, root, playlist);
    const entries = new Set([
      ...(result.sounds ?? []),
      ...(this._playing?.context ?? []).filter((entry) => entry.playlistId === playlist.id),
    ]);
    for (const entry of entries) {
      const sound = playlist.sounds.get(entry.id);
      const time = boundedPlayingTime(sound);
      if (!time) continue;
      const formattedDuration = this.constructor.formatTimestamp(time.duration);
      entry.duration = formattedDuration;
      entry.durationTime = formattedDuration;
      if (time.current !== null) entry.currentTime = this.constructor.formatTimestamp(time.current);
    }
    return result;
  };

  const update = Directory.prototype.updateTimestamps;
  Directory.prototype.updateTimestamps = function (...args) {
    const result = update.apply(this, args);
    for (const widget of document.querySelectorAll(".playlists-sidebar .currently-playing")) {
      for (const row of widget.querySelectorAll(".sound:not(.rn-preview-playing)[data-playlist-id][data-sound-id]")) {
        const sound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
        const time = boundedPlayingTime(sound);
        if (!time) continue;
        const current = row.querySelector(".current");
        if (current && time.current !== null) current.textContent = this.constructor.formatTimestamp(time.current);
        const duration = row.querySelector(".duration");
        if (duration) duration.textContent = this.constructor.formatTimestamp(time.duration);
      }
    }
    return result;
  };
}
