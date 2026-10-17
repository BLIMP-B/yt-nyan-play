const { contextBridge } = require('electron');

// Run before site scripts so detached Audio elements are observable too.
// This exposes no Node, IPC, filesystem or account access to the page.
contextBridge.executeInMainWorld({ func: () => {
  const tracked = new Set();
  const remember = media => {
    if (!tracked.has(media)) {
      // Discard completed old instances first; keep the registry bounded.
      for (const item of tracked) if (item.ended) tracked.delete(item);
      if (tracked.size >= 64) tracked.delete(tracked.values().next().value);
      tracked.add(media);
    }
    return media;
  };
  Object.defineProperty(window, '__nyanMediaElements', { value: () => [...tracked] });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) { remember(this); return Reflect.apply(play, this, args); };
  window.Audio = new Proxy(window.Audio, { construct(target, args, constructor) { return remember(Reflect.construct(target, args, constructor)); } });
} });
