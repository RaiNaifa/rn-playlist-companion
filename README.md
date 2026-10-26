# RN Playlist Companion

![Verified with Foundry VTT v13 and v14](https://img.shields.io/badge/Foundry%20VTT-v13%20%7C%20v14-green)

Enhance Foundry VTT’s built-in playlists and improve their performance. Preview sounds before playing them, make playlists global across your worlds, and control their visibility.

## Manual Installation

In Foundry VTT, open **Add-on Modules → Install Module**, paste the following URL into **Manifest URL**, and click **Install**:

```
https://github.com/RaiNaifa/rn-playlist-companion/releases/latest/download/module.json
```

## Features

### Global Playlists

- Global playlists and folders can be used across all your worlds.
- Playlists or an entire folder branch can be changed between global and local as needed.
- Global playlist data is stored in `Data/rn-global-playlists/`, outside the module folder. Audio files stay in their original locations.
- The data folder is hidden from players in Foundry’s File Browser by default.
- Global playlists have a built-in archive for recovering deleted or replaced versions.
- ID conflicts between global and local items can be resolved automatically or by the GM.
- ⚠️ World backups do not include global playlists. To view and restore saved versions of global playlists, open Global Playlist Archive in the module settings.

### Playlists Visibility

- Playlists and folders can be hidden from the sidebar without being deleted.
- Visibility is set independently in each world, including for global playlists and folders.
- GMs can find hidden items through search or temporarily show them in the sidebar.
- A hidden playlist remains visible while it is playing, so its sounds can still be controlled.

### Sound Preview

- Sounds can be previewed locally alongside other playback.
- Preview has its own volume control and appears in **Currently Playing**.
- Audio Ducking: Preview can temporarily lower Music, Environment, and Interface sounds.
- Audio Ducking is optional, and its strength is configured separately for each client.

### Playlists Performance

- Collapsed playlists do not render their sound rows, helping Foundry’s interface stay responsive when the playlist sidebar is open, even with many sounds.
- Expanded playlists share one row budget across the visible area. Sounds outside it stay available through scrolling and search.
- Known issue: Minor stutters may occasionally occur when scrolling through a large number of sounds.

### Audio Buffering

- The audio streaming threshold can be adjusted manually. By default, Foundry streams audio files longer than 600 seconds (10 minutes).
- Streaming can help sounds start sooner for clients because playback can begin before the full file downloads.
- Lowering the threshold also reduces audio buffer memory use. Raising it keeps more sounds fully loaded in memory.
- Inspired by Nordiii's [Audio duration until stream](https://github.com/Nordiii/audio-duration-until-stream-setting). Included here so playlist audio settings can be managed in one module. Implemented independently.

## Minor Improvements

- Long sound and playlist names scroll on hover when they do not fit in the sidebar.
- GMs can hover over a playlist or sound name to see its description in a compact tooltip.
- Sound icons reflect their audio channel.

