import { MODULE_ID, t } from "../core/context.mjs";
import { readBounds } from "./bounds.mjs";

const controllers = new WeakMap();
const warned = new WeakSet();

function dispose(sound) {
  const controller = controllers.get(sound);
  if (!controller) return;
  clearInterval(controller.timer);
  sound.element?.removeEventListener("timeupdate", controller.check);
  controllers.delete(sound);
}

export function installBoundedPlayback() {
  const PlaylistSound = foundry.documents.PlaylistSound;
  const originalCreate = PlaylistSound.prototype._createSound;
  const originalFadeOut = PlaylistSound.prototype._scheduleFadeOut;
  const originalSync = PlaylistSound.prototype.sync;
  const originalEnd = PlaylistSound.prototype._onEnd;
  PlaylistSound.prototype._onEnd = async function (...args) {
    // A buffered section started without Repeat has a finite source duration.
    // Enabling Repeat while it plays cannot remove that duration, so start its
    // next cycle when the existing source ends instead of advancing the playlist.
    if (this.playing && this.repeat && readBounds(this) && this.sound?.buffer) {
      await this.sound.play();
      return;
    }
    return originalEnd.apply(this, args);
  };
  PlaylistSound.prototype.sync = function (...args) {
    const bounds = readBounds(this, this.sound?.buffer?.duration ?? this.sound?.element?.duration);
    const sound = this.sound;
    if (bounds && this.playing && sound?.playing) {
      const controller = controllers.get(sound);
      // A streaming element must never use the browser's full-file loop.
      sound.loop = Boolean(sound.buffer && this.repeat);
      if (controller?.fading) return;
      sound.fade(this.volume, { duration: 500 }).catch(console.error);
      return;
    }
    const result = originalSync.apply(this, args);
    if (bounds && this.sound?.element && this.sound.loop) this.sound.loop = false;
    return result;
  };
  PlaylistSound.prototype._scheduleFadeOut = function (...args) {
    if (readBounds(this)) return;
    return originalFadeOut.apply(this, args);
  };
  PlaylistSound.prototype._createSound = function (...args) {
    const sound = originalCreate.apply(this, args);
    if (!sound) return sound;
    const originalPlay = sound.play.bind(sound);
    const thisDocument = this;
    const originalCurrentTime = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sound), "currentTime")?.get;
    if (originalCurrentTime)
      Object.defineProperty(sound, "currentTime", {
        configurable: true,
        get() {
          const bounds = readBounds(thisDocument, sound.buffer?.duration);
          if (!bounds || !sound.buffer || !sound.loop || !sound.playing) return originalCurrentTime.call(sound);
          if (Number.isFinite(sound.pausedTime)) return sound.pausedTime;
          const length = bounds.end - bounds.start;
          const elapsed = sound.context.currentTime - sound.startTime - bounds.start;
          return bounds.start + (((elapsed % length) + length) % length);
        },
      });
    let wasBounded = false;
    let completed = false;
    const finish = async () => {
      if (completed || this.repeat || !this.playing || !this.parent?.isOwner) return;
      completed = true;
      dispose(sound);
      await this.parent._onSoundEnd(this);
    };
    sound.play = async (options = {}) => {
      dispose(sound);
      completed = false;
      const bounds = readBounds(this, sound.buffer?.duration ?? sound.element?.duration);
      if (!bounds) {
        if (this.flags?.[MODULE_ID]?.bounds && game.user.isGM && !warned.has(this)) {
          warned.add(this);
          ui.notifications.warn(t("Bounds.InvalidPlayback", { name: this.name }));
        }
        const next = wasBounded ? { ...options, loopStart: 0, loopEnd: Infinity } : options;
        wasBounded = false;
        return originalPlay(next);
      }
      wasBounded = true;
      const resume = Number.isFinite(sound.pausedTime);
      const offset = resume
        ? 0
        : Number.isFinite(options.offset) && options.offset > 0
          ? Math.max(bounds.start, options.offset)
          : bounds.start;
      const buffering = Boolean(sound.buffer);
      const startedRepeated = Boolean(this.repeat);
      // Foundry does not await HTMLAudioElement.play(). A quick stop at a short
      // boundary can reject its promise even though stopping was intentional.
      if (!buffering && sound.element?.play && !sound.element.__rnBoundedPlay) {
        const element = sound.element;
        const play = element.play.bind(element);
        element.play = (...args) => {
          const pending = play(...args);
          pending?.catch((error) => {
            if (error?.name !== "AbortError") console.error(error);
          });
          return pending;
        };
        element.__rnBoundedPlay = true;
      }
      const playing = await originalPlay({
        ...options,
        loop: buffering && this.repeat,
        loopStart: bounds.start,
        loopEnd: bounds.end,
        offset,
        duration: buffering && !this.repeat ? bounds.end - (resume ? sound.pausedTime : offset) : undefined,
      });
      if (!playing.playing) return playing;
      let fading = false;
      let ending = false;
      let previousPosition = null;
      const currentFade = () => Math.min(this.fade ?? this.parent?.fade ?? 0, (bounds.end - bounds.start) * 500);
      const controller = { timer: null, check: null, fading: false };
      const check = async () => {
        if (controllers.get(sound) !== controller || !sound.playing) return;
        const position = sound.element ? sound.element.currentTime : sound.currentTime;
        if (!Number.isFinite(position)) return;
        if (this.repeat) {
          const fade = currentFade();
          const wrapped = position < previousPosition || (sound.element && position >= bounds.end);
          if (position >= bounds.end) {
            if (sound.element) {
              sound.element.currentTime = bounds.start;
              sound.startTime = sound.context.currentTime - bounds.start;
            }
          }
          if (wrapped) {
            fading = false;
            controller.fading = false;
            if (fade > 0) sound.fade(this.volume, { duration: fade }).catch(console.error);
          } else if (!fading && fade > 0 && position >= bounds.end - fade / 1000) {
            fading = true;
            controller.fading = true;
            sound
              .fade(0, { duration: Math.max(0, Math.min(fade, (bounds.end - position) * 1000)) })
              .catch(console.error);
          }
          previousPosition = sound.element ? sound.element.currentTime : position;
          return;
        }
        const fade = currentFade();
        if (!fading && fade > 0 && position >= bounds.end - fade / 1000) {
          fading = true;
          controller.fading = true;
          sound.fade(0, { duration: Math.max(0, Math.min(fade, (bounds.end - position) * 1000)) }).catch(console.error);
        }
        if (ending || position < bounds.end) return;
        ending = true;
        if (buffering && !startedRepeated) return; // The scheduled buffer end dispatches "end".
        dispose(sound);
        await sound.stop({ fade: 0 });
        await finish();
      };
      controller.check = check;
      controllers.set(sound, controller);
      sound.element?.addEventListener("timeupdate", check);
      controller.timer = setInterval(check, 25);
      return playing;
    };
    sound.addEventListener("pause", () => dispose(sound));
    sound.addEventListener("stop", () => dispose(sound));
    sound.addEventListener("end", () => dispose(sound));
    return sound;
  };
}
