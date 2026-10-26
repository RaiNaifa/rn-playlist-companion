const channelIcons = {
  environment: "fa-wind",
  interface: "fa-bell",
};

export function decorateSoundChannelIcons(element) {
  for (const row of element.querySelectorAll(".sound[data-playlist-id][data-sound-id]")) {
    const icon = row.querySelector(":scope > header > i.fa-music, :scope > header > i.rn-channel-icon");
    if (!icon) continue;
    const sound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    const name = soundChannelIconClass(sound);
    if (icon.classList.contains(name)) continue;
    icon.classList.remove("fa-music", ...Object.values(channelIcons));
    icon.classList.add(name, "rn-channel-icon");
  }
}

export function soundChannelIconClass(sound) {
  // Foundry plays a sound through its own channel, or the playlist channel when that field is blank.
  return channelIcons[sound?.channel || sound?.parent?.channel] ?? "fa-music";
}
