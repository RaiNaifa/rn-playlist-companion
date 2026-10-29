import assert from "node:assert/strict";
import test from "node:test";
import { installBoundedPlayback } from "../scripts/audio/bounded-playback.mjs";

test("streamed Sound loops inside boundaries and ends once when repeat is off", async () => {
  class PlaylistSound {
    _createSound() {
      const sound = new EventTarget();
      sound.element = Object.assign(new EventTarget(), { currentTime: 0 });
      sound.context = { currentTime: 10 };
      sound.duration = 10;
      sound.play = async (options) => {
        sound.options = options;
        sound.playing = true;
        sound.element.currentTime = options.offset;
        return sound;
      };
      sound.stop = async () => {
        sound.playing = false;
        sound.dispatchEvent(new Event("stop"));
      };
      sound.fade = async () => {};
      return sound;
    }
    _scheduleFadeOut() {}
    sync() {}
  }
  globalThis.foundry = { documents: { PlaylistSound } };
  installBoundedPlayback();
  let ended = 0;
  const document = new PlaylistSound();
  document.path = "music.ogg";
  document.flags = { "rn-playlist-companion": { bounds: { start: 1, end: 3, path: "music.ogg" } } };
  document.repeat = true;
  document.playing = true;
  document.parent = {
    isOwner: true,
    _onSoundEnd: () => {
      ended++;
    },
  };
  const sound = document._createSound();
  await sound.play({ loop: true });
  assert.equal(sound.options.loop, false);
  assert.equal(sound.element.currentTime, 1);
  sound.element.currentTime = 3.02;
  sound.element.dispatchEvent(new Event("timeupdate"));
  assert.equal(sound.element.currentTime, 1);
  assert.equal(ended, 0);
  document.repeat = false;
  sound.element.currentTime = 3.01;
  sound.element.dispatchEvent(new Event("timeupdate"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ended, 1);
  assert.equal(sound.playing, false);
});

test("streamed repeat fades out and back in on every bounded loop", async () => {
  class PlaylistSound {
    _createSound() {
      const sound = new EventTarget();
      sound.element = Object.assign(new EventTarget(), { currentTime: 0 });
      sound.context = { currentTime: 10 };
      sound.fadeCalls = [];
      sound.play = async (options) => {
        sound.playing = true;
        sound.element.currentTime = options.offset;
        return sound;
      };
      sound.fade = async (volume, options) => sound.fadeCalls.push([volume, options.duration]);
      return sound;
    }
    _scheduleFadeOut() {}
    sync() {}
  }
  globalThis.foundry = { documents: { PlaylistSound } };
  installBoundedPlayback();
  const document = new PlaylistSound();
  document.path = "music.ogg";
  document.flags = { "rn-playlist-companion": { bounds: { start: 1, end: 3, path: "music.ogg" } } };
  document.repeat = true;
  document.fade = 2000;
  document.volume = 0.7;
  const sound = document._createSound();
  await sound.play();
  const tick = (position) => {
    sound.element.currentTime = position;
    sound.element.dispatchEvent(new Event("timeupdate"));
  };
  tick(1.1);
  tick(2.1);
  tick(3.01);
  tick(2.2);
  assert.deepEqual(
    sound.fadeCalls.map(([volume, duration]) => [volume, Math.round(duration)]),
    [
      [0, 900],
      [0.7, 1000],
      [0, 800],
    ],
  );
  sound.dispatchEvent(new Event("stop"));
});

test("buffered loop keeps absolute playback position for pause and resume", async () => {
  class BufferSound extends EventTarget {
    buffer = { duration: 30 };
    context = { currentTime: 100 };
    playing = false;
    fadeCalls = [];
    get currentTime() {
      return this.context.currentTime - this.startTime;
    }
    async play(options) {
      this.options = options;
      this.loop = options.loop;
      this.startTime = this.context.currentTime - (options.offset + (this.pausedTime ?? 0));
      this.pausedTime = undefined;
      this.playing = true;
      return this;
    }
    async stop() {}
    async fade(volume, options) {
      this.fadeCalls.push([volume, options.duration]);
    }
  }
  class PlaylistSound {
    _createSound() {
      return new BufferSound();
    }
    _scheduleFadeOut() {}
    sync() {}
  }
  globalThis.foundry = { documents: { PlaylistSound } };
  installBoundedPlayback();
  const document = new PlaylistSound();
  document.path = "music.ogg";
  document.flags = { "rn-playlist-companion": { bounds: { start: 10, end: 20, path: "music.ogg" } } };
  document.repeat = true;
  document.fade = 2000;
  document.volume = 0.6;
  const sound = document._createSound();
  await sound.play();
  sound.context.currentTime = 113;
  assert.equal(sound.currentTime, 13);
  sound.pausedTime = sound.currentTime;
  sound.playing = false;
  await sound.play();
  assert.equal(sound.options.offset, 0);
  assert.equal(sound.currentTime, 13);
  sound.context.currentTime = 119.1;
  await new Promise((resolve) => setTimeout(resolve, 40));
  sound.context.currentTime = 120.1;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(
    sound.fadeCalls.map(([volume]) => volume),
    [0, 0.6],
  );
  sound.dispatchEvent(new Event("stop"));
});

test("a non-repeating buffered section reaches its natural end without an early stop", async () => {
  class BufferSound extends EventTarget {
    buffer = { duration: 30 };
    context = { currentTime: 0 };
    get currentTime() {
      return this.context.currentTime - this.startTime;
    }
    async play(options) {
      this.options = options;
      this.startTime = -options.offset;
      this.playing = true;
      return this;
    }
    async stop() {
      assert.fail("The buffer must finish naturally");
    }
    async fade() {}
  }
  class PlaylistSound {
    _createSound() {
      return new BufferSound();
    }
    _scheduleFadeOut() {}
    sync() {}
  }
  globalThis.foundry = { documents: { PlaylistSound } };
  installBoundedPlayback();
  const document = new PlaylistSound();
  document.path = "music.ogg";
  document.flags = { "rn-playlist-companion": { bounds: { start: 10, end: 20, path: "music.ogg" } } };
  document.repeat = false;
  document.playing = true;
  const sound = document._createSound();
  await sound.play();
  assert.equal(sound.options.duration, 10);
  sound.context.currentTime = 10;
  await new Promise((resolve) => setTimeout(resolve, 40));
  sound.dispatchEvent(new Event("end"));
});

test("enabling Repeat during a finite buffered section starts its next cycle", async () => {
  class BufferSound extends EventTarget {
    buffer = { duration: 30 };
    context = { currentTime: 0 };
    plays = 0;
    async play(options) {
      this.options = options;
      this.plays++;
      this.playing = true;
      return this;
    }
    async fade() {}
  }
  class PlaylistSound {
    _createSound() {
      return new BufferSound();
    }
    _scheduleFadeOut() {}
    sync() {}
    async _onEnd() {
      assert.fail("Repeat must not advance the playlist");
    }
  }
  globalThis.foundry = { documents: { PlaylistSound } };
  installBoundedPlayback();
  const document = new PlaylistSound();
  document.path = "music.ogg";
  document.flags = { "rn-playlist-companion": { bounds: { start: 10, end: 20, path: "music.ogg" } } };
  document.playing = true;
  document.repeat = false;
  document.sound = document._createSound();
  await document.sound.play();
  assert.equal(document.sound.options.duration, 10);
  document.repeat = true;
  document.sound.playing = false;
  await document._onEnd();
  assert.equal(document.sound.plays, 2);
  assert.equal(document.sound.options.loop, true);
  document.sound.dispatchEvent(new Event("stop"));
});
