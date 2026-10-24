import assert from "node:assert/strict";
import test from "node:test";
import {
  activePreview,
  applyDucking,
  stopPreview,
  stopPreviewForPlayback,
  togglePreview,
} from "../scripts/audio/preview.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a late-loaded preview cannot start after another sound was selected", async () => {
  const firstLoad = deferred();
  const secondLoad = deferred();
  const played = [];
  const stopped = [];
  const fades = [];
  const scheduled = [];
  const longFade = deferred();
  let duckStrength = 75;
  let musicVolume = 0.5;
  let ambientVolume = 0.6;
  let interfaceVolume = 0.4;
  const gain = {
    setValueAtTime(value) {
      this.value = value;
    },
  };
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};

    createGain() {
      return { gain, connect() {} };
    }

    async resume() {}
  };
  const channel = () => ({
    currentTime: 0,
    gainNode: {
      gain: {
        setValueAtTime(value) {
          this.value = value;
        },
      },
    },
  });
  globalThis.game = {
    audio: {
      unlock: Promise.resolve(),
      globalMute: false,
      music: channel(),
      environment: channel(),
      interface: channel(),
      create: ({ src }) => ({
        playing: false,
        duration: 4,
        currentTime: 0,
        addEventListener() {},
        load: () => (src === "first.ogg" ? firstLoad.promise : secondLoad.promise),
        async play(options) {
          this.playing = true;
          played.push({ src, options });
        },
        async stop() {
          this.playing = false;
          stopped.push(src);
        },
        async fade(volume, options) {
          fades.push({ src, volume, options });
          if (src === "longfade.ogg" && volume === 0) await longFade.promise;
        },
        schedule(_callback, time) {
          scheduled.push({ src, time });
        },
      }),
    },
    settings: {
      get: (_module, name) => {
        if (name === "globalPlaylistVolume") return musicVolume;
        if (name === "globalAmbientVolume") return ambientVolume;
        if (name === "globalInterfaceVolume") return interfaceVolume;
        if (name === "previewVolume") return 0.5;
        if (name === "duckMusic") return true;
        if (name === "duckStrength") return duckStrength;
        return undefined;
      },
    },
  };
  globalThis.ui = {
    notifications: {
      error(message) {
        throw new Error(message);
      },
    },
  };

  const first = togglePreview({ uuid: "first", path: "first.ogg", volume: 1 });
  await Promise.resolve();
  await Promise.resolve();
  const second = togglePreview({ uuid: "second", path: "second.ogg", volume: 1 });
  await Promise.resolve();
  await Promise.resolve();
  secondLoad.resolve();
  await second;
  firstLoad.resolve();
  await first;

  assert.deepEqual(
    played.map((item) => item.src),
    ["second.ogg"],
  );
  assert.equal(activePreview(), "second");
  assert.equal(game.audio.music.gainNode.gain.value, 0.125);
  assert.equal(game.audio.environment.gainNode.gain.value, 0.15);
  assert.equal(game.audio.interface.gainNode.gain.value, 0.1);
  await togglePreview({ uuid: "second", path: "second.ogg" });
  assert.deepEqual(stopped, ["first.ogg", "second.ogg"]);
  assert.equal(activePreview(), null);
  assert.equal(game.audio.music.gainNode.gain.value, 0.5);
  assert.equal(game.audio.environment.gainNode.gain.value, 0.6);
  assert.equal(game.audio.interface.gainNode.gain.value, 0.4);
  await togglePreview({ uuid: "faded", path: "faded.ogg", volume: 1, fade: 3000 });
  assert.equal(played.at(-1).options.fade, 2000);
  assert.deepEqual(scheduled.at(-1), { src: "faded.ogg", time: 2 });
  await togglePreview({ uuid: "faded", path: "faded.ogg" });
  assert.deepEqual(fades.at(-1), { src: "faded.ogg", volume: 0, options: { duration: 2000 } });
  stopPreview();

  const matched = { uuid: "matched", id: "sound", parent: { id: "playlist" }, path: "matched.ogg" };
  await togglePreview(matched);
  stopPreviewForPlayback("another-playlist", [{ _id: "sound", playing: true }]);
  stopPreviewForPlayback("playlist", [{ _id: "another-sound", playing: true }]);
  assert.equal(activePreview(), "matched");
  stopPreviewForPlayback("playlist", [{ _id: "sound", playing: true }]);
  assert.equal(activePreview(), null);

  const pending = togglePreview({ ...matched, path: "first.ogg" });
  stopPreviewForPlayback("playlist", [{ _id: "sound", playing: true }]);
  await pending;
  assert.equal(activePreview(), null);

  await togglePreview({ uuid: "longfade", path: "longfade.ogg", fade: 3000 });
  await togglePreview({ uuid: "longfade", path: "longfade.ogg" });
  assert.equal(game.audio.music.gainNode.gain.value, 0.125);
  duckStrength = 50;
  musicVolume = 0.8;
  ambientVolume = 0.3;
  interfaceVolume = 0.2;
  applyDucking();
  assert.equal(game.audio.music.gainNode.gain.value, 0.4);
  assert.equal(game.audio.environment.gainNode.gain.value, 0.15);
  assert.equal(game.audio.interface.gainNode.gain.value, 0.1);
  longFade.resolve();
  await new Promise(setImmediate);
  assert.equal(game.audio.music.gainNode.gain.value, 0.8);
  assert.equal(game.audio.environment.gainNode.gain.value, 0.3);
  assert.equal(game.audio.interface.gainNode.gain.value, 0.2);
});
