# RN Playlist Companion

![Verified with Foundry VTT v14](https://img.shields.io/badge/Foundry%20VTT-v14-green)

Enhance Foundry VTT’s built-in playlists and improve their performance. Preview sounds before playing them, make playlists global across your worlds, and control their visibility.

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

## Minor Improvements

- Long sound names scroll on hover when they do not fit in the sidebar.
