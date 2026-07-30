/**
 * ==================================================================================
 * This file is a self-contained bundle that:
 * 1. Defines a core bot factory (createBot)
 * 2. Installs functional modules (PZ, Xray, Panic, Rune, Heal, Invisible,
 *    Magic Shield, Auto Attack, Cave, Equip Ring, Auto Eat, Talk, and UI Panel)
 * 3. Bootstraps the bot on page load and provides a hot-reload mechanism
 * 
 * All persistent settings are stored in localStorage under keys like:
 *   minibiaBot.*.config
 * 
 * The bot is exposed globally as `window.minibiaBot`.
 * ==================================================================================
 */

// --- Global namespace for the bundle ---
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

/**
 * ==================================================================================
 * 1. CORE BOT FACTORY (createBot)
 *    Creates the base bot object with utility methods, storage, chat, reconnect,
 *    alarm audio, and cleanup. It also starts a watcher to auto‑reconnect and a
 *    counter reset for the in‑game input metrics (`__imB`).
 * ==================================================================================
 */
window.__minibiaBotBundle.createBot = function createBot() {
  // ---- PRIVATE STATE ----
  const cleanups = [];                                      // Functions to run on destroy
  const defaultAlarmAudioSrc = "https://upload.wikimedia.org/wikipedia/commons/5/5c/En-us-red_alert.oga";
  const alarmAudioSrcStorageKey = "minibiaBot.audio.alarmSrc";
  const recentSentChats = [];                               // Tracks recently sent messages (avoid duplicates)
  const reconnectButtonSelectors = [                        // CSS selectors to find a reconnect button
    "button", "[role=\"button\"]", "input[type=\"button\"]",
    "input[type=\"submit\"]", "a", ".button", ".btn",
  ];
  let alarmAudio = null;                                    // Audio element for alarm sounds
  let reconnectObserver = null;                             // MutationObserver for reconnect detection
  let reconnectPollTimerId = null;                          // Interval timer for reconnect polling
  let lastReconnectClickAt = 0;                             // Throttle reconnect clicks

  // ---- CLEANUP SYSTEM ----
  function addCleanup(fn) {
    if (typeof fn === "function") cleanups.push(fn);
  }

  function runCleanups() {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn(); } catch (error) {
        console.error("[minibia-bot] cleanup failed", error);
      }
    }
  }

  // ---- ALARM AUDIO ----
  function getStoredAlarmAudioSrc() {
    try {
      const value = window.localStorage.getItem(alarmAudioSrcStorageKey);
      return value == null ? defaultAlarmAudioSrc : JSON.parse(value);
    } catch { return defaultAlarmAudioSrc; }
  }

  function setStoredAlarmAudioSrc(src) {
    window.localStorage.setItem(alarmAudioSrcStorageKey, JSON.stringify(src));
    return src;
  }

  function destroyAlarmAudio() {
    if (!alarmAudio) return;
    try {
      alarmAudio.pause();
      alarmAudio.removeAttribute("src");
      alarmAudio.load();
    } catch (error) {
      console.error("[minibia-bot] audio cleanup failed", error);
    }
    alarmAudio = null;
  }

  function getAlarmAudio() {
    const src = getStoredAlarmAudioSrc();
    if (!src) return null;
    if (!alarmAudio || alarmAudio.src !== src) {
      if (alarmAudio) alarmAudio.pause();
      alarmAudio = new Audio(src);
      alarmAudio.preload = "auto";
    }
    return alarmAudio;
  }

  // ---- CHAT HELPERS (deduplication) ----
  function normalizeChatText(text) {
    return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function rememberSentChat(text) {
    const normalized = normalizeChatText(text);
    if (!normalized) return;
    recentSentChats.push({ text: normalized, at: Date.now() });
    const maxEntries = 20;
    if (recentSentChats.length > maxEntries) {
      recentSentChats.splice(0, recentSentChats.length - maxEntries);
    }
  }

  function isRecentSentChat(text, withinMs = 45000) {
    const normalized = normalizeChatText(text);
    if (!normalized) return false;
    const cutoff = Date.now() - withinMs;
    for (let i = recentSentChats.length - 1; i >= 0; i--) {
      const entry = recentSentChats[i];
      if (entry.at < cutoff) continue;
      if (entry.text === normalized) return true;
    }
    return false;
  }

  // ---- UI TEXT NORMALIZATION (for button text matching) ----
  function normalizeUiText(text) {
    return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  // ---- SKILL WINDOW SCRAPING ----
  function getSkillWindowValue(skillNames = []) {
    for (const skillName of skillNames) {
      const el = document.querySelector(`#skill-window div[skill="${skillName}"] .skill`);
      const value = el?.textContent?.trim();
      if (value) return value;
    }
    return null;
  }

  function parseNumberText(value) {
    if (value == null) return null;
    const normalized = String(value).replace(/[^\d.-]/g, "");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // ---- VISIBILITY & UI TEXT EXTRACTION ----
  function isVisibleElement(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function getElementUiText(element) {
    if (!(element instanceof Element)) return "";
    return normalizeUiText(
      element.textContent ||
      element.innerText ||
      element.getAttribute("value") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
    );
  }

  // ---- RECONNECT WATCHER ----
  function findReconnectElement() {
    for (const selector of reconnectButtonSelectors) {
      const candidates = document.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (!isVisibleElement(candidate)) continue;
        if (getElementUiText(candidate) === "reconnect") return candidate;
      }
    }
    return null;
  }

  function tryClickReconnect() {
    const now = Date.now();
    if (now - lastReconnectClickAt < 3000) return false;
    const el = findReconnectElement();
    if (!el) return false;
    el.click();
    lastReconnectClickAt = now;
    console.log("[minibia-bot] clicked reconnect");
    return true;
  }

  function startReconnectWatcher() {
    if (reconnectObserver || reconnectPollTimerId) return;
    const runCheck = () => { try { tryClickReconnect(); } catch (e) { console.error("[minibia-bot] reconnect watcher failed", e); } };
    reconnectObserver = new MutationObserver(runCheck);
    reconnectObserver.observe(document.documentElement || document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "value"]
    });
    reconnectPollTimerId = window.setInterval(runCheck, 2000);
    runCheck();
  }

  function stopReconnectWatcher() {
    if (reconnectObserver) { reconnectObserver.disconnect(); reconnectObserver = null; }
    if (reconnectPollTimerId) { window.clearInterval(reconnectPollTimerId); reconnectPollTimerId = null; }
  }
  startReconnectWatcher();

  // ---- __imB COUNTER RESET (prevents input spam detection) ----
  let __imbResetInterval = null;
  function startImbReset(intervalMs = 1000) {
    if (__imbResetInterval) return;
    __imbResetInterval = setInterval(() => {
      if (typeof __imB !== 'undefined') __imB = 0;
    }, intervalMs);
  }
  function stopImbReset() {
    if (__imbResetInterval) { clearInterval(__imbResetInterval); __imbResetInterval = null; }
  }
  startImbReset(1000);

  // ---- PUBLIC API ----
  return {
    version: "0.3.0",
    addCleanup,

    /** Destroy the bot and all its modules (call before reload) */
    destroy() {
      if (this.panic?.stop) this.panic.stop();
      if (this.rune?.stop) this.rune.stop({ persistEnabled: false });
      if (this.heal?.stop) this.heal.stop({ persistEnabled: false });
      if (this.invisible?.stop) this.invisible.stop({ persistEnabled: false });
      if (this.attack?.stop) this.attack.stop({ persistEnabled: false });
      if (this.cave?.stop) this.cave.stop({ persistEnabled: false });
      if (this.equipRing?.stop) this.equipRing.stop({ persistEnabled: false });
      if (this.eat?.stop) this.eat.stop({ persistEnabled: false });
      if (this.talk?.stop) this.talk.stop({ persistEnabled: false });
      if (this.ui?.destroy) this.ui.destroy();
      stopReconnectWatcher();
      stopImbReset();
      destroyAlarmAudio();
      runCleanups();
    },

    log(...args) {
      console.log("[minibia-bot]", ...args);
    },

    /** Simple localStorage wrapper with JSON serialisation */
    storage: {
      get(key, fallback = null) {
        try {
          const value = window.localStorage.getItem(key);
          return value == null ? fallback : JSON.parse(value);
        } catch { return fallback; }
      },
      set(key, value) {
        window.localStorage.setItem(key, JSON.stringify(value));
        return value;
      },
      remove(key) {
        window.localStorage.removeItem(key);
      }
    },

    /** Game client accessors */
    getPlayerPosition() {
      return window.gameClient?.player?.getPosition?.() || null;
    },
    getPlayerState() {
      return window.gameClient?.player?.state || null;
    },
    getPlayerName() {
      return String(
        this.getPlayerState()?.name ||
        window.gameClient?.player?.name ||
        window.gameClient?.player?.state?.name ||
        ""
      ).trim() || null;
    },

    /** Snapshot of HP, mana, skills (uses skill window fallback) */
    getPlayerSnapshot() {
      const playerState = this.getPlayerState() || {};
      const levelText = getSkillWindowValue(["level"]);
      const magicLevelText = getSkillWindowValue(["magic", "magic-level", "mlvl"]);
      const experienceText = getSkillWindowValue(["experience", "exp"]);
      const capacityText = getSkillWindowValue(["capacity", "cap"]);
      return {
        name: this.getPlayerName(),
        level: parseNumberText(playerState.level) ?? parseNumberText(levelText),
        magicLevel: parseNumberText(playerState.magicLevel ?? playerState.magic_level) ?? parseNumberText(magicLevelText),
        health: parseNumberText(playerState.health),
        maxHealth: parseNumberText(playerState.maxHealth),
        mana: parseNumberText(playerState.mana),
        maxMana: parseNumberText(playerState.maxMana),
        experience: parseNumberText(playerState.experience ?? playerState.exp) ?? parseNumberText(experienceText),
        capacity: parseNumberText(playerState.capacity ?? playerState.cap) ?? parseNumberText(capacityText),
        food: getSkillWindowValue(["food"]),
      };
    },

    /** Send a chat message via the default channel, remembering it for deduplication */
    sendChat(text) {
      const channelManager = window.gameClient?.interface?.channelManager;
      if (!channelManager || !text) return false;
      channelManager.sendMessageText(text);
      rememberSentChat(text);
      this.log("sent chat:", text);
      return true;
    },

    isRecentSentChat(text, withinMs) {
      return isRecentSentChat(text, withinMs);
    },

    clickReconnect() {
      return tryClickReconnect();
    },

    /** Click a hotbar slot by index (0‑based) */
    clickHotbar(index) {
      const button = window.gameClient?.interface?.hotbarManager?.slots?.[index]?.canvas?.canvas;
      if (!button) return false;
      button.click();
      return true;
    },

    /** Alarm audio management */
    getAlarmAudioSrc() { return getStoredAlarmAudioSrc(); },
    setAlarmAudioSrc(src) {
      const nextSrc = String(src || "").trim();
      if (!nextSrc) return false;
      setStoredAlarmAudioSrc(nextSrc);
      destroyAlarmAudio();
      this.log("alarm audio updated", nextSrc);
      return true;
    },

    /** Unlock audio autoplay by playing a muted sound */
    unlockAudio() {
      try {
        const audio = getAlarmAudio();
        if (!audio) return false;
        audio.muted = true;
        const playResult = audio.play();
        if (playResult && typeof playResult.then === "function") {
          playResult.then(() => { audio.pause(); audio.currentTime = 0; audio.muted = false; })
                   .catch(() => { audio.muted = false; });
        } else {
          audio.pause(); audio.currentTime = 0; audio.muted = false;
        }
        return true;
      } catch (error) {
        console.error("[minibia-bot] audio unlock failed", error);
        return false;
      }
    },

    /** Play the alarm sound */
    playAlarm() {
      try {
        const audio = getAlarmAudio();
        if (!audio) return false;
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
        const playResult = audio.play();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch((error) => this.log("alarm playback failed", error?.message || error));
        }
        return true;
      } catch (error) {
        console.error("[minibia-bot] alarm failed", error);
        return false;
      }
    },

    /** Control the __imB reset interval */
    imbReset: {
      start: () => startImbReset(1000),
      stop: stopImbReset,
      reset: () => { if (typeof __imB !== 'undefined') __imB = 0; }
    }
  };
};

/**
 * ==================================================================================
 * 2. PZ MODULE (Protection Zone)
 *    Finds, paths to, and remembers PZ tiles. Also allows setting a "home" PZ.
 * ==================================================================================
 */
window.__minibiaBotBundle.installPzModule = function installPzModule(bot) {
  const homeStorageKey = "minibiaBot.pz.home";

  function getLoadedTiles() {
    const chunks = window.gameClient?.world?.chunks || [];
    const tiles = [];
    for (const chunk of chunks) {
      if (!chunk?.tiles) continue;
      for (const tile of chunk.tiles) {
        if (tile?.__position) tiles.push(tile);
      }
    }
    return tiles;
  }

  function hasPzFlag(tile) {
    return !!tile && ((tile.flags || 0) & 1) !== 0;
  }

  function getPzCandidates() {
    const me = bot.getPlayerPosition();
    if (!me) return [];
    return getLoadedTiles()
      .filter(t => hasPzFlag(t) && t.__position?.z === me.z)
      .map(t => {
        const p = t.__position;
        return {
          tile: t,
          x: p.x, y: p.y, z: p.z,
          flags: t.flags || 0,
          dist: Math.abs(p.x - me.x) + Math.abs(p.y - me.y)
        };
      })
      .sort((a, b) => a.dist - b.dist);
  }

  function goToTile(tile) {
    if (!tile?.__position) return false;
    const from = bot.getPlayerPosition();
    if (!from) return false;
    const p = tile.__position;
    const to = new Position(p.x, p.y, p.z);
    try {
      window.gameClient?.world?.pathfinder?.findPath?.(from, to);
      bot.log("pathing to", { x: p.x, y: p.y, z: p.z, flags: tile.flags });
      return true;
    } catch (error) {
      bot.log("pathing failed", { x: p.x, y: p.y, z: p.z, error: error?.message });
      return false;
    }
  }

  function goToNearestPz(maxAttempts = 20) {
    const candidates = getPzCandidates().slice(0, maxAttempts);
    if (!candidates.length) { bot.log("No PZ candidates found"); return false; }
    for (const candidate of candidates) {
      if (goToTile(candidate.tile)) {
        bot.log("selected PZ", candidate);
        return true;
      }
    }
    bot.log("No PZ candidate accepted by pathfinder");
    return false;
  }

  function setHomePz(x, y, z) {
    const home = { x, y, z };
    bot.storage.set(homeStorageKey, home);
    bot.log("home PZ set", home);
    return home;
  }

  function setHomePzCurrentSpot() {
    const pos = bot.getPlayerPosition();
    if (!pos) { bot.log("Could not read current position"); return null; }
    return setHomePz(pos.x, pos.y, pos.z);
  }

  function getHomePz() { return bot.storage.get(homeStorageKey, null); }
  function clearHomePz() { bot.storage.remove(homeStorageKey); bot.log("home PZ cleared"); }

  function getNearestPzTo(x, y, z) {
    const candidates = getLoadedTiles()
      .filter(t => hasPzFlag(t) && t.__position?.z === z)
      .map(t => {
        const p = t.__position;
        return { tile: t, x: p.x, y: p.y, z: p.z, flags: t.flags || 0,
                 dist: Math.abs(p.x - x) + Math.abs(p.y - y) };
      })
      .sort((a, b) => a.dist - b.dist);
    return candidates[0] || null;
  }

  function goToHomePz() {
    const home = getHomePz();
    if (!home) { bot.log("No home PZ set"); return false; }
    const candidate = getNearestPzTo(home.x, home.y, home.z);
    if (!candidate) { bot.log("No loaded PZ found near saved home", home); return false; }
    bot.log("home candidate", candidate);
    return goToTile(candidate.tile);
  }

  function printPzCandidates(limit = 10) {
    const rows = getPzCandidates().slice(0, limit).map(c => ({
      x: c.x, y: c.y, z: c.z, flags: c.flags, dist: c.dist
    }));
    console.table(rows);
    return rows;
  }

  // Expose public API
  bot.pz = {
    getLoadedTiles, getPzCandidates, goToTile, goToNearestPz,
    setHomePz, setHomePzCurrentSpot, getHomePz, clearHomePz,
    getNearestPzTo, goToHomePz, printPzCandidates
  };
  // Convenience aliases
  bot.goToNearestPz = goToNearestPz;
  bot.setHomePz = setHomePz;
  bot.setHomePzCurrentSpot = setHomePzCurrentSpot;
  bot.getHomePz = getHomePz;
  bot.clearHomePz = clearHomePz;
  bot.goToHomePz = goToHomePz;
};

/**
 * ==================================================================================
 * 3. XRAY MODULE
 *    Tracks creatures (players and monsters) and draws an overlay showing
 *    off‑screen and on‑other‑floor creatures. Supports floor filtering.
 * ==================================================================================
 */
window.__minibiaBotBundle.installXrayModule = function installXrayModule(bot) {
  const configStorageKey = "minibiaBot.xray.config";
  const overlayRootId = "minibia-bot-xray-overlay";
  const overlayStyleId = "minibia-bot-xray-overlay-style";
  const overlayState = { running: false, timerId: null };

  const config = Object.assign(
    { overlayEnabled: false, selectedFloor: null },
    bot.storage.get(configStorageKey, {})
  );
  config.selectedFloor = normalizeSelectedFloor(config.selectedFloor);

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function normalizeSelectedFloor(value) {
    if (value == null || value === "" || value === "all") return null;
    const floor = Number(value);
    if (!Number.isFinite(floor)) return null;
    return Math.trunc(floor);
  }

  function isWithinVisibleRange(me, pos) {
    if (!me || !pos) return false;
    const dx = Math.abs(pos.x - me.x);
    const dy = Math.abs(pos.y - me.y);
    return dx <= 8 && dy <= 6;   // Tibia screen radius
  }

  function getTrackedCreatures() {
    const myState = bot.getPlayerState();
    const myId = window.gameClient?.player?.id;
    const myName = normalizeName(myState?.name);
    return Object.values(window.gameClient?.world?.activeCreatures || {})
      .filter(creature => {
        if (!creature) return false;
        if (creature.id === myId) return false;
        const name = normalizeName(creature.name);
        if (name && name === myName) return false;
        return true;
      });
  }

  /** Creatures visible on screen (within viewport) */
  function getVisibleCreatures() {
    const me = bot.getPlayerPosition();
    if (!me) return [];
    return getTrackedCreatures().filter(c => isWithinVisibleRange(me, c.__position));
  }

  /** Visible players (type === 0) – optionally only same floor */
  function getVisiblePlayers(options = {}) {
    const { sameFloorOnly = false } = options;
    const me = bot.getPlayerPosition();
    if (!me) return [];
    return getVisibleCreatures().filter(c => {
      if (c?.type !== 0) return false;
      if (!sameFloorOnly) return true;
      return c.__position?.z === me.z;
    });
  }

  /** Visible monsters (type !== 0) – optionally only same floor */
  function getVisibleMonsters(options = {}) {
    const { sameFloorOnly = false } = options;
    const me = bot.getPlayerPosition();
    if (!me) return [];
    return getVisibleCreatures().filter(c => {
      if (c?.type === 0) return false;
      if (!sameFloorOnly) return true;
      return c.__position?.z === me.z;
    });
  }

  function readCreatureHealth(creature) {
    // Try multiple properties to get current/max/percent
    const current = [creature.health, creature.hp, creature.currentHealth, creature.state?.health]
      .find(v => Number.isFinite(Number(v)));
    const max = [creature.maxHealth, creature.maxHp, creature.maximumHealth, creature.state?.maxHealth]
      .find(v => Number.isFinite(Number(v)));
    const percent = [creature.healthPercent, creature.hpPercent, creature.healthpercentage, creature.state?.healthPercent]
      .find(v => Number.isFinite(Number(v)));
    if (current != null && max != null) return `${Number(current)}/${Number(max)} HP`;
    if (percent != null) return `${Math.round(Number(percent))}% HP`;
    if (current != null) return `${Number(current)} HP`;
    return null;
  }

  function getCreatureLabel(creature) {
    return creature?.name || (creature?.type === 0 ? "Player" : "Mob");
  }

  /** Creatures to be displayed on the overlay (off‑floor or off‑screen) */
  function getOverlayCreatures() {
    const me = bot.getPlayerPosition();
    if (!me) return [];
    return getTrackedCreatures().filter(c => {
      const pos = c?.__position;
      if (!pos || pos.z == null) return false;
      if (config.selectedFloor != null && pos.z !== config.selectedFloor) return false;
      if (pos.z !== me.z) {
        return isWithinVisibleRange(me, pos);  // other floors within visible radius
      }
      return !isWithinVisibleRange(me, pos);   // same floor but off‑screen
    });
  }

  // ---- OVERLAY RENDERING ----
  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  function ensureOverlayStyle() {
    if (document.getElementById(overlayStyleId)) return;
    const style = document.createElement("style");
    style.id = overlayStyleId;
    style.textContent = `
      #${overlayRootId} { position: fixed; inset: 0; pointer-events: none; z-index: 999998; }
      #${overlayRootId} .mb-xray-marker {
        position: fixed; transform: translate(-50%, -50%);
        padding: 2px 6px; border: 1px solid rgba(255,211,128,0.85);
        border-radius: 999px; background: rgba(65,24,12,0.72);
        box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
        color: #ffe7ae; font: 11px/1.2 Verdana, sans-serif;
        white-space: nowrap;
      }
      #${overlayRootId} .mb-xray-marker.mb-xray-marker-offscreen {
        border-color: rgba(123,235,178,0.92);
        background: rgba(11,61,43,0.8); color: #d8ffea;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureOverlayRoot() {
    let root = document.getElementById(overlayRootId);
    if (root) return root;
    root = document.createElement("div");
    root.id = overlayRootId;
    document.body.appendChild(root);
    return root;
  }

  function destroyOverlayElements() {
    document.getElementById(overlayRootId)?.remove();
    document.getElementById(overlayStyleId)?.remove();
  }

  function getViewportRect() {
    const canvases = Array.from(document.querySelectorAll("canvas"))
      .map(c => ({ canvas: c, rect: c.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 200 && rect.height >= 150)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    return canvases[0]?.rect || null;
  }

  function renderOverlay() {
    if (!overlayState.running) return;
    const root = ensureOverlayRoot();
    const me = bot.getPlayerPosition();
    const viewportRect = getViewportRect();
    const creatures = getOverlayCreatures();
    root.innerHTML = "";
    if (!me || !viewportRect || !creatures.length) return;

    const tileWidth = viewportRect.width / 17;
    const tileHeight = viewportRect.height / 13;
    const edgePadding = 48;

    creatures.forEach(c => {
      const pos = c.__position;
      if (!pos) return;
      const dx = pos.x - me.x;
      const dy = pos.y - me.y;
      const healthLabel = readCreatureHealth(c);
      const marker = document.createElement("div");
      marker.className = "mb-xray-marker";

      if (pos.z === me.z) {
        marker.classList.add("mb-xray-marker-offscreen");
        marker.textContent = healthLabel ? `${getCreatureLabel(c)} ${healthLabel}` : `${getCreatureLabel(c)}`;
        marker.style.left = `${clamp(
          viewportRect.left + ((dx + 8.5) * tileWidth),
          viewportRect.left + edgePadding,
          viewportRect.right - edgePadding
        )}px`;
        marker.style.top = `${clamp(
          viewportRect.top + ((dy + 6.5) * tileHeight),
          viewportRect.top + edgePadding,
          viewportRect.bottom - edgePadding
        )}px`;
      } else {
        const floorOffset = me.z - pos.z;
        const floorLabel = floorOffset === 0 ? "0" : floorOffset > 0 ? `+${floorOffset}` : `${floorOffset}`;
        marker.textContent = healthLabel
          ? `${getCreatureLabel(c)} (${floorLabel}) ${healthLabel}`
          : `${getCreatureLabel(c)} (${floorLabel})`;
        marker.style.left = `${viewportRect.left + ((dx + 8.5) * tileWidth)}px`;
        marker.style.top = `${viewportRect.top + ((dy + 6.5) * tileHeight)}px`;
      }
      root.appendChild(marker);
    });
  }

  function startOverlay() {
    config.overlayEnabled = true;
    persistConfig();
    if (overlayState.running) return false;
    overlayState.running = true;
    ensureOverlayStyle();
    renderOverlay();
    overlayState.timerId = window.setInterval(renderOverlay, 250);
    return true;
  }

  function stopOverlay() {
    config.overlayEnabled = false;
    persistConfig();
    if (!overlayState.running && overlayState.timerId == null) return false;
    overlayState.running = false;
    if (overlayState.timerId != null) {
      window.clearInterval(overlayState.timerId);
      overlayState.timerId = null;
    }
    destroyOverlayElements();
    return true;
  }

  function setOverlayEnabled(enabled) {
    const next = !!enabled;
    if (next) return startOverlay();
    return stopOverlay();
  }

  function setSelectedFloor(floor) {
    config.selectedFloor = normalizeSelectedFloor(floor);
    persistConfig();
    if (overlayState.running) renderOverlay();
    return config.selectedFloor;
  }

  function status() {
    return {
      visibleCreatures: getVisibleCreatures().map(c => ({ id: c.id, name: c.name, type: c.type, position: c.__position })),
      visiblePlayers: getVisiblePlayers().map(p => ({ id: p.id, name: p.name, position: p.__position })),
      visiblePlayersCurrentFloor: getVisiblePlayers({ sameFloorOnly: true }).map(p => ({ id: p.id, name: p.name, position: p.__position })),
      visibleMonsters: getVisibleMonsters().map(m => ({ id: m.id, name: m.name, type: m.type, position: m.__position })),
      visibleMonstersCurrentFloor: getVisibleMonsters({ sameFloorOnly: true }).map(m => ({ id: m.id, name: m.name, type: m.type, position: m.__position })),
      overlayCreatures: getOverlayCreatures().map(c => ({ id: c.id, name: c.name, type: c.type, position: c.__position })),
      config: { ...config },
      overlayRunning: overlayState.running,
    };
  }

  // Public API
  bot.xray = {
    getVisibleCreatures, getVisiblePlayers, getVisibleMonsters,
    getOverlayCreatures, startOverlay, stopOverlay, setOverlayEnabled,
    setSelectedFloor, status, config
  };

  // Auto‑start if enabled
  if (config.overlayEnabled) startOverlay();
  else destroyOverlayElements();
  bot.addCleanup(stopOverlay);
};

/**
 * ==================================================================================
 * 4. PANIC MODULE
 *    Monitors for threats (unknown players, health loss, game masters) and
 *    triggers an alarm, stops running modules, and optionally returns to a safe
 *    position. Also includes a sound‑only "player on‑screen" alert.
 * ==================================================================================
 */
window.__minibiaBotBundle.installPanicModule = function installPanicModule(bot) {
  const configStorageKey = "minibiaBot.panic.config";
  const state = {
    running: false,
    timerId: null,
    lastHealth: null,
    lastTriggerAt: 0,
    lastDamageEventKey: null,
    pendingReturnOrigin: null,
    pendingReturnModules: null,
    returnNotBeforeAt: 0,
    lastThreatAt: 0,
    lastReturnAttemptAt: 0,
    lastPlayerAlertAt: 0,
  };

  const config = Object.assign(
    {
      tickMs: 200,
      triggerCooldownMs: 4000,
      returnToOriginEnabled: false,
      returnDelayMs: 300000,          // 5 minutes
      returnDelayJitterMs: 30000,     // ±30 seconds
      returnRetryCooldownMs: 2000,
      unknownPlayerEnabled: false,
      healthLossEnabled: false,
      playerAlertEnabled: false,
      playerAlertCooldownMs: 60000,
      trustedNames: [],
      gameMasterNames: [],
    },
    bot.storage.get(configStorageKey, {})
  );

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function normalizeDelayMs(value, fallback = 0) {
    const next = Math.trunc(Number(value));
    return Number.isFinite(next) ? Math.max(0, next) : fallback;
  }

  function normalizePosition(position) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    const z = Number(position?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }

  function isSamePosition(left, right) {
    return !!left && !!right && left.x === right.x && left.y === right.y && left.z === right.z;
  }

  function getTrustedNames() {
    return Array.from(new Set((config.trustedNames || []).map(n => normalizeName(n)).filter(Boolean)));
  }

  function getGameMasterNames() {
    return Array.from(new Set((config.gameMasterNames || []).map(n => normalizeName(n)).filter(Boolean)));
  }

  // ---- VISIBLE PLAYER FILTERING ----
  function getVisiblePlayers() {
    const me = bot.getPlayerPosition();
    const players = bot.xray?.getVisiblePlayers?.() || [];
    if (!me) return players;
    return players.filter(c => {
      const z = Number(c?.__position?.z);
      return Number.isFinite(z) && z === me.z;
    });
  }

  function getUnknownVisiblePlayers() {
    const trusted = new Set(getTrustedNames());
    return getVisiblePlayers().filter(c => {
      const name = normalizeName(c?.name);
      return !!name && !trusted.has(name);
    });
  }

  function getTrustedVisiblePlayers() {
    const trusted = new Set(getTrustedNames());
    return getVisiblePlayers().filter(c => {
      const name = normalizeName(c?.name);
      return !!name && trusted.has(name);
    });
  }

  function getVisibleGameMasters() {
    const gms = new Set(getGameMasterNames());
    return getVisiblePlayers().filter(c => {
      const name = normalizeName(c?.name);
      return !!name && gms.has(name);
    });
  }

  // ---- CHAT DAMAGE PARSING ----
  function getRecentChannelMessages() {
    return (window.gameClient?.interface?.channelManager?.channels || [])
      .flatMap(channel =>
        (channel?.__contents || []).map(entry => ({
          channelName: channel?.name || null,
          message: String(entry?.message || ""),
          time: entry?.__time || null,
        }))
      );
  }

  function parseDamageMessage(entry) {
    const match = entry.message.match(/^You lose\s+(\d+)\s+hitpoints\s+due to an attack by\s+(.+?)\.$/i);
    if (!match) return null;
    return {
      amount: Number(match[1]),
      attackerName: match[2].trim(),
      time: entry.time,
      channelName: entry.channelName,
      key: `${entry.time || "no-time"}|${entry.message}`,
      message: entry.message,
    };
  }

  function getLatestDamageEvent() {
    const messages = getRecentChannelMessages()
      .map(parseDamageMessage)
      .filter(Boolean)
      .sort((a, b) => {
        const aTime = a.time ? Date.parse(a.time) : 0;
        const bTime = b.time ? Date.parse(b.time) : 0;
        return bTime - aTime;
      });
    return messages[0] || null;
  }

  // ---- RETURN TO ORIGIN LOGIC ----
  function getReturnDelayMs() {
    const base = normalizeDelayMs(config.returnDelayMs, 0);
    const jitter = normalizeDelayMs(config.returnDelayJitterMs, 0);
    if (!jitter) return base;
    const randomOffset = Math.floor(Math.random() * ((jitter * 2) + 1)) - jitter;
    return Math.max(0, base + randomOffset);
  }

  function clearPendingReturn() {
    state.pendingReturnOrigin = null;
    state.pendingReturnModules = null;
    state.returnNotBeforeAt = 0;
    state.lastThreatAt = 0;
    state.lastReturnAttemptAt = 0;
  }

  function snapshotInterruptedModules() {
    return {
      caveRunning: !!bot.cave?.status?.().running,
      equipRingRunning: !!bot.equipRing?.status?.().running,
    };
  }

  function armPendingReturn(now = Date.now(), origin = normalizePosition(bot.getPlayerPosition())) {
    if (!config.returnToOriginEnabled) { clearPendingReturn(); return; }
    if (!state.pendingReturnOrigin && origin) {
      state.pendingReturnOrigin = origin;
      state.pendingReturnModules = snapshotInterruptedModules();
    }
    if (!state.pendingReturnOrigin) return;
    state.lastThreatAt = now;
    state.returnNotBeforeAt = now + getReturnDelayMs();
  }

  function isReturnCoastClear() {
    return !getVisibleGameMasters().length && !getUnknownVisiblePlayers().length;
  }

  function restoreInterruptedModules() {
    if (state.pendingReturnModules?.caveRunning) bot.cave?.start?.();
    if (state.pendingReturnModules?.equipRingRunning) {
      bot.equipRing?.start?.();
      bot.ui?.refreshEquipRingStatus?.();
    }
  }

  function tryReturnToOrigin(now = Date.now()) {
    if (!config.returnToOriginEnabled || !state.pendingReturnOrigin || !state.returnNotBeforeAt) return false;
    if (now < state.returnNotBeforeAt) return false;
    if (!isReturnCoastClear()) return false;
    if (now - state.lastReturnAttemptAt < normalizeDelayMs(config.returnRetryCooldownMs, 2000)) return false;

    const currentPos = normalizePosition(bot.getPlayerPosition());
    if (isSamePosition(currentPos, state.pendingReturnOrigin)) {
      bot.log("panic return completed", { origin: state.pendingReturnOrigin, threatAgeMs: now - state.lastThreatAt });
      restoreInterruptedModules();
      clearPendingReturn();
      return true;
    }
    state.lastReturnAttemptAt = now;
    const moved = !!bot.cave?.goToPosition?.(state.pendingReturnOrigin) ||
                  !!bot.pz?.goToTile?.({ __position: state.pendingReturnOrigin });
    if (moved) {
      bot.log("panic returning to origin", { origin: state.pendingReturnOrigin, threatAgeMs: now - state.lastThreatAt });
      return true;
    }
    bot.log("panic return pathing failed", { origin: state.pendingReturnOrigin });
    return false;
  }

  // ---- TRIGGER FUNCTIONS ----
  function triggerPanic(reason, details = {}) {
    const now = Date.now();
    armPendingReturn(now);
    if (now - state.lastTriggerAt < config.triggerCooldownMs) return false;
    state.lastTriggerAt = now;
    bot.playAlarm?.();
    bot.log("panic triggered", { reason, ...details });
    if (bot.cave?.stop) bot.cave.stop({ persistEnabled: false });
    if (bot.equipRing?.stop) {
      bot.equipRing.stop({ persistEnabled: false });
      bot.ui?.refreshEquipRingStatus?.();
    }
    return !!bot.pz?.goToHomePz?.();
  }

  function triggerGameMasterKillSwitch(players) {
    const detectedPlayers = (players || []).map(p => p?.name).filter(Boolean);
    bot.playAlarm?.();
    bot.log("game master kill switch triggered", { players: detectedPlayers });
    // Stop all modules
    if (bot.rune?.stop) bot.rune.stop();
    if (bot.eat?.stop) bot.eat.stop();
    if (bot.invisible?.stop) bot.invisible.stop();
    if (bot.magicShield?.stop) bot.magicShield.stop();
    if (bot.cave?.stop) bot.cave.stop();
    if (bot.attack?.stop) bot.attack.stop();
    if (bot.equipRing?.stop) bot.equipRing.stop();
    clearPendingReturn();
    config.unknownPlayerEnabled = false;
    config.healthLossEnabled = false;
    persistConfig();
    stop();   // stop the panic loop itself
    // Refresh UI
    bot.ui?.refreshPanicStatus?.();
    bot.ui?.refreshRuneStatus?.();
    bot.ui?.refreshAutoEatStatus?.();
    bot.ui?.refreshAutoInvisibleStatus?.();
    bot.ui?.refreshAutoMagicShieldStatus?.();
    bot.ui?.refreshAutoAttackStatus?.();
    bot.ui?.refreshCaveStatus?.();
    bot.ui?.refreshEquipRingStatus?.();
    return true;
  }

  // ---- CHECK FUNCTIONS (called on each tick) ----
  function checkGameMasters() {
    if (!getGameMasterNames().length) return false;
    const visible = getVisibleGameMasters();
    if (!visible.length) return false;
    return triggerGameMasterKillSwitch(visible);
  }

  function checkUnknownPlayers() {
    if (!config.unknownPlayerEnabled) return false;
    const unknown = getUnknownVisiblePlayers();
    if (!unknown.length) return false;
    return triggerPanic("unknown-player", { players: unknown.map(p => p.name) });
  }

  function checkHealthLoss() {
    if (!config.healthLossEnabled) return false;
    const playerState = bot.getPlayerState();
    const currentHealth = Number(playerState?.health ?? 0);
    if (state.lastHealth == null) { state.lastHealth = currentHealth; return false; }
    const lostHealth = currentHealth < state.lastHealth;
    state.lastHealth = currentHealth;
    if (!lostHealth) return false;

    const latestDamage = getLatestDamageEvent();
    if (latestDamage && latestDamage.key !== state.lastDamageEventKey) {
      state.lastDamageEventKey = latestDamage.key;
      const trusted = new Set(getTrustedNames());
      const attacker = normalizeName(latestDamage.attackerName);
      if (attacker && trusted.has(attacker)) {
        bot.log("ignored health-loss panic because attacker is trusted", {
          attacker: latestDamage.attackerName, amount: latestDamage.amount, currentHealth
        });
        return false;
      }
      return triggerPanic("health-loss", {
        currentHealth, attacker: latestDamage.attackerName, amount: latestDamage.amount
      });
    }

    const unknown = getUnknownVisiblePlayers();
    if (!unknown.length) {
      const trustedPlayers = getTrustedVisiblePlayers();
      if (trustedPlayers.length) {
        bot.log("ignored health-loss panic because only trusted players are nearby", {
          players: trustedPlayers.map(p => p.name), currentHealth
        });
        return false;
      }
    }
    return triggerPanic("health-loss", { currentHealth });
  }

  // ---- TICK LOOP ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }

  function tick() {
    if (!state.running) return;
    const now = Date.now();
    try {
      const triggered = checkGameMasters() || checkUnknownPlayers() || checkHealthLoss();
      if (!triggered) tryReturnToOrigin(now);

      // Player on‑screen alert (sound only, does NOT stop any module)
      if (config.playerAlertEnabled) {
        const myId = window.gameClient?.player?.id;
        const allPlayers = bot.xray?.getVisiblePlayers?.() || [];
        const otherPlayers = allPlayers.filter(p => p.id !== myId);
        if (otherPlayers.length > 0 && now - state.lastPlayerAlertAt >= config.playerAlertCooldownMs) {
          state.lastPlayerAlertAt = now;
          bot.playAlarm?.();
          bot.log("player on-screen alert", { players: otherPlayers.map(p => p.name) });
        }
      }
    } finally {
      scheduleNextTick();
    }
  }

  function shouldRun() {
    return !!(getGameMasterNames().length || config.unknownPlayerEnabled || config.healthLossEnabled);
  }

  function start() {
    if (state.running) return false;
    state.running = true;
    state.lastHealth = Number(bot.getPlayerState()?.health ?? 0);
    state.lastDamageEventKey = getLatestDamageEvent()?.key || null;
    bot.log("panic runner started", { ...config });
    tick();
    return true;
  }

  function stop() {
    if (!state.running && state.timerId == null) { state.lastHealth = null; return false; }
    state.running = false;
    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }
    state.lastHealth = null;
    state.lastDamageEventKey = null;
    clearPendingReturn();
    bot.log("panic runner stopped");
    return true;
  }

  function syncRunningState() {
    if (shouldRun()) start();
    else stop();
  }

  function updateConfig(nextConfig = {}) {
    const next = { ...nextConfig };
    if (Array.isArray(next.trustedNames)) {
      next.trustedNames = next.trustedNames.map(n => String(n || "").trim()).filter(Boolean);
    }
    if (Array.isArray(next.gameMasterNames)) {
      next.gameMasterNames = next.gameMasterNames.map(n => String(n || "").trim()).filter(Boolean);
    }
    if (next.triggerCooldownMs !== undefined) {
      next.triggerCooldownMs = normalizeDelayMs(next.triggerCooldownMs, config.triggerCooldownMs);
    }
    if (next.returnDelayMs !== undefined) {
      next.returnDelayMs = normalizeDelayMs(next.returnDelayMs, config.returnDelayMs);
    }
    if (next.returnDelayJitterMs !== undefined) {
      next.returnDelayJitterMs = normalizeDelayMs(next.returnDelayJitterMs, config.returnDelayJitterMs);
    }
    if (next.returnRetryCooldownMs !== undefined) {
      next.returnRetryCooldownMs = normalizeDelayMs(next.returnRetryCooldownMs, config.returnRetryCooldownMs);
    }
    if (next.playerAlertEnabled !== undefined) {
      next.playerAlertEnabled = !!next.playerAlertEnabled;
    }
    if (next.playerAlertCooldownMs !== undefined) {
      next.playerAlertCooldownMs = Math.max(10000, Number(next.playerAlertCooldownMs) || 60000);
    }
    Object.assign(config, next);
    if (!config.returnToOriginEnabled) clearPendingReturn();
    persistConfig();
    syncRunningState();
    bot.log("panic runner config updated", { ...config });
    return { ...config };
  }

  function status() {
    return {
      running: state.running,
      config: {
        ...config,
        trustedNames: [...config.trustedNames],
        gameMasterNames: [...config.gameMasterNames],
      },
      visiblePlayers: getVisiblePlayers().map(p => ({ id: p.id, name: p.name, position: p.__position })),
      unknownVisiblePlayers: getUnknownVisiblePlayers().map(p => ({ id: p.id, name: p.name, position: p.__position })),
      trustedVisiblePlayers: getTrustedVisiblePlayers().map(p => ({ id: p.id, name: p.name, position: p.__position })),
      visibleGameMasters: getVisibleGameMasters().map(p => ({ id: p.id, name: p.name, position: p.__position })),
      latestDamageEvent: getLatestDamageEvent(),
      lastTriggerAt: state.lastTriggerAt,
      pendingReturn: state.pendingReturnOrigin ? {
        origin: { ...state.pendingReturnOrigin },
        modules: state.pendingReturnModules ? { ...state.pendingReturnModules } : null,
        returnNotBeforeAt: state.returnNotBeforeAt,
        lastThreatAt: state.lastThreatAt,
        lastReturnAttemptAt: state.lastReturnAttemptAt,
        coastClear: isReturnCoastClear(),
      } : null,
      playerAlertEnabled: config.playerAlertEnabled,
      playerAlertCooldownMs: config.playerAlertCooldownMs,
      lastPlayerAlertAt: state.lastPlayerAlertAt,
    };
  }

  if (shouldRun()) start();

  bot.panic = {
    start, stop, status, updateConfig,
    getVisiblePlayers, getUnknownVisiblePlayers, getTrustedVisiblePlayers,
    getVisibleGameMasters, getTrustedNames, getGameMasterNames,
    config,
  };
};

/**
 * ==================================================================================
 * 5. RUNE MODULE (Magic Level Trainer)
 *    Repeatedly casts a spell (e.g., "adori vita vis") when health, mana, and
 *    food are sufficient, respecting cooldowns.
 * ==================================================================================
 */
window.__minibiaBotBundle.installRuneModule = function installRuneModule(bot) {
  const configStorageKey = "minibiaBot.rune.config";
  const state = { running: false, timerId: null, lastRuneAt: 0 };
  let resumeListenersAttached = false;

  const config = Object.assign(
    {
      tickMs: 250,
      minHpPercent: 50,
      minFoodSeconds: 30,
      runeSpellWords: "adori vita vis",
      runeManaCost: 600,
      runeCooldownMs: 3500,
      enabled: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 250;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function readStats() {
    const playerState = bot.getPlayerState();
    const hp = playerState ? { current: playerState.health ?? 0, max: playerState.maxHealth ?? 0 } : null;
    const mana = playerState ? { current: playerState.mana ?? 0, max: playerState.maxMana ?? 0 } : null;
    const foodText = document.querySelector('#skill-window div[skill="food"] .skill')?.textContent?.trim() || null;
    let food = null;
    if (foodText) {
      const match = foodText.match(/^(\d{1,2}):(\d{2})$/);
      food = match ? { text: foodText, seconds: Number(match[1]) * 60 + Number(match[2]) } : { text: foodText, seconds: null };
    }
    return { hp, mana, food };
  }

  function getGateStatus(now = Date.now()) {
    const { hp, mana, food } = readStats();
    if (!hp || !mana) {
      return {
        hasStats: false,
        enoughHp: false,
        enoughMana: false,
        enoughFood: false,
        cooldownReady: false,
        cooldownRemainingMs: config.runeCooldownMs,
        canMakeRune: false,
      };
    }
    const hpPercent = hp.max > 0 ? (hp.current / hp.max) * 100 : 0;
    const enoughHp = hpPercent >= config.minHpPercent;
    const enoughMana = mana.current >= config.runeManaCost;
    const enoughFood = food?.seconds == null || food.seconds >= config.minFoodSeconds;
    const cooldownElapsed = now - state.lastRuneAt;
    const cooldownRemaining = Math.max(0, config.runeCooldownMs - cooldownElapsed);
    const cooldownReady = cooldownRemaining === 0;
    return {
      hasStats: true,
      enoughHp,
      enoughMana,
      enoughFood,
      cooldownReady,
      cooldownRemainingMs: cooldownRemaining,
      canMakeRune: enoughHp && enoughMana && enoughFood && cooldownReady,
    };
  }

  function canMakeRune(now = Date.now()) {
    return getGateStatus(now).canMakeRune;
  }

  function tryMakeRune() {
    if (!canMakeRune()) return false;
    const sent = bot.sendChat(config.runeSpellWords);
    if (sent) state.lastRuneAt = Date.now();
    return sent;
  }

  // ---- RESUME LISTENERS (to catch up after tab focus) ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }

  function runImmediateTick() {
    if (!state.running) return;
    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }
    tick();
  }

  function handleResume() {
    if (document.hidden) return;
    runImmediateTick();
  }

  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;
    try { tryMakeRune(); } catch (e) { bot.log("rune tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 250;
    persistConfig();
    if (state.running) { bot.log("rune maker already running"); return false; }
    state.running = true;
    attachResumeListeners();
    bot.log("rune maker started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }
    detachResumeListeners();
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    bot.log("rune maker stopped");
    return true;
  }

  function status() {
    return {
      running: state.running,
      config: { ...config },
      stats: readStats(),
      gates: getGateStatus(),
      lastRuneAt: state.lastRuneAt,
    };
  }

  function updateConfig(nextConfig = {}) {
    // Also used by the attack module – we keep it for compatibility.
    // This function is overridden by the attack module's updateConfig later.
    Object.assign(config, nextConfig);
    persistConfig();
    bot.log("rune config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.rune = {
    start, stop, status, readStats, getGateStatus, canMakeRune, tryMakeRune,
    config, updateConfig,
  };
  bot.startRuneLoop = start;
  bot.stopRuneLoop = stop;
};

/**
 * ==================================================================================
 * 6. HEAL MODULE
 *    Manages a list of heal rules. Each rule defines a hotbar slot (or spell words),
 *    HP and MP percentage ranges, and a mana cost. Rules are evaluated in order,
 *    and the first matching rule triggers. Supports confirming if the heal succeeded.
 * ==================================================================================
 */
window.__minibiaBotBundle.installHealModule = function installHealModule(bot) {
  const configStorageKey = "minibiaBot.heal.config";
  const state = {
    running: false,
    timerId: null,
    lastHealAt: {},
    lastAttemptAt: {},
    pendingAttempt: {},
  };

  const config = Object.assign(
    {
      tickMs: 50,
      healCooldownMs: 1200,
      healRetryMs: 200,
      healConfirmMs: 250,
      enabled: false,
      healRules: []
    },
    bot.storage.get(configStorageKey, {})
  );

  // Clean old legacy keys
  delete config.hpHotbarSlot;
  delete config.manaHotbarSlot;
  delete config.minHp;
  delete config.minMana;

  // Backward compatibility: convert old threshold-based rules to range-based
  if (config.healRules && config.healRules.length > 0) {
    const first = config.healRules[0];
    if (first.thresholdPercent !== undefined && first.minHpPercent === undefined) {
      config.healRules = config.healRules.map(r => ({
        slot: r.slot || 1,
        spellWords: r.spellWords || "",
        manaCost: 0,
        minHpPercent: r.type === "hp" ? 0 : 0,
        maxHpPercent: r.type === "hp" ? r.thresholdPercent : 100,
        minManaPercent: r.type === "mana" ? 0 : 0,
        maxManaPercent: r.type === "mana" ? r.thresholdPercent : 100,
      }));
      bot.storage.set(configStorageKey, config);
    }
  }

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function readStats() {
    const ps = bot.getPlayerSnapshot?.();
    return ps ? {
      hp: { current: Number(ps.health ?? 0), max: Number(ps.maxHealth ?? 0) },
      mana: { current: Number(ps.mana ?? 0), max: Number(ps.maxMana ?? 0) },
    } : { hp: null, mana: null };
  }

  function normalizeHotbarSlot(slot) {
    const v = Number(slot);
    if (!Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < 1 || n > 12) return null;
    return n;
  }

  function getHpPercent(stats) {
    if (!stats?.hp || !stats.hp.max) return 100;
    return (stats.hp.current / stats.hp.max) * 100;
  }

  function getManaPercent(stats) {
    if (!stats?.mana || !stats.mana.max) return 100;
    return (stats.mana.current / stats.mana.max) * 100;
  }

  function hasPending() {
    return Object.keys(state.pendingAttempt).some(k => state.pendingAttempt[k] !== null);
  }

  function didSucceed(stats, attempt) {
    if (!stats || !attempt) return false;
    const hpUp = stats.hp ? stats.hp.current > attempt.hpBefore : false;
    const manaUp = stats.mana ? stats.mana.current > attempt.manaBefore : false;
    return hpUp || manaUp;
  }

  function resolvePending(stats, now) {
    Object.keys(state.pendingAttempt).forEach(slotKey => {
      const a = state.pendingAttempt[slotKey];
      if (!a) return;
      if (didSucceed(stats, a)) {
        state.lastHealAt[slotKey] = a.attemptedAt;
        state.pendingAttempt[slotKey] = null;
        bot.log("confirmed heal", { slot: a.slot });
      } else if (now - a.attemptedAt >= (config.healConfirmMs || 250)) {
        state.pendingAttempt[slotKey] = null;
        bot.log("heal did not register", { slot: a.slot });
      }
    });
  }

  function canUseRule(rule, now, stats) {
    const slot = normalizeHotbarSlot(rule.slot);
    if (!slot) return false;
    const key = String(slot);
    if (state.pendingAttempt[key]) return false;
    if (now - (state.lastHealAt[key] || 0) < config.healCooldownMs) return false;
    if (now - (state.lastAttemptAt[key] || 0) < (config.healRetryMs || 200)) return false;

    const hp = getHpPercent(stats);
    const mana = getManaPercent(stats);
    const minHp = Number(rule.minHpPercent) ?? 0;
    const maxHp = Number(rule.maxHpPercent) ?? 100;
    const minMana = Number(rule.minManaPercent) ?? 0;
    const maxMana = Number(rule.maxManaPercent) ?? 100;

    if (hp < minHp || hp > maxHp) return false;
    if (mana < minMana || mana > maxMana) return false;

    // Spell requires mana
    if (rule.spellWords && rule.spellWords.trim()) {
      const cost = Math.max(1, Number(rule.manaCost) || 0);
      if (stats.mana.current < cost) return false;
    }
    if (stats.hp.current <= 0) return false; // dead
    return true;
  }

  function triggerRule(rule, now, stats) {
    if (!canUseRule(rule, now, stats)) return false;
    const slot = normalizeHotbarSlot(rule.slot);
    const key = String(slot);

    if (rule.spellWords && rule.spellWords.trim()) {
      const sent = bot.sendChat(rule.spellWords.trim());
      if (sent) {
        state.lastAttemptAt[key] = now;
        state.pendingAttempt[key] = {
          attemptedAt: now, slot,
          hpBefore: stats.hp.current,
          manaBefore: stats.mana.current,
        };
        bot.log("cast spell", { slot, words: rule.spellWords });
      }
      return sent;
    }

    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      state.lastAttemptAt[key] = now;
      state.pendingAttempt[key] = {
        attemptedAt: now, slot,
        hpBefore: stats.hp.current,
        manaBefore: stats.mana.current,
      };
      bot.log("pressed hotkey", { slot });
    }
    return clicked;
  }

  function tryHeal() {
    if (!config.enabled) return false;
    const now = Date.now();
    const stats = readStats();
    resolvePending(stats, now);
    if (hasPending()) return false;

    for (const rule of config.healRules || []) {
      if (!rule || !rule.slot) continue;
      if (triggerRule(rule, now, stats)) return true;
    }
    return false;
  }

  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = setTimeout(() => tick(), config.tickMs);
  }

  function tick() {
    if (!state.running) return;
    try { tryHeal(); } catch (e) { bot.log("auto heal tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    persistConfig();
    if (state.running) return false;
    state.running = true;
    bot.log("auto heal started", { rules: config.healRules });
    tick();
    return true;
  }

  function stop(options = {}) {
    const persist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId) clearTimeout(state.timerId);
    state.timerId = null;
    if (persist) { config.enabled = false; persistConfig(); }
    bot.log("auto heal stopped");
    return true;
  }

  function status() {
    const stats = readStats();
    return {
      running: state.running,
      config: { ...config },
      stats,
      hpPercent: getHpPercent(stats),
      manaPercent: getManaPercent(stats),
      lastHealAt: { ...state.lastHealAt },
      pendingAttempt: { ...state.pendingAttempt },
    };
  }

  function updateConfig(next) {
    if (next.healRules) {
      next.healRules = next.healRules.map(r => ({
        slot: normalizeHotbarSlot(r.slot) || 1,
        spellWords: String(r.spellWords || "").trim(),
        manaCost: Math.max(0, Number(r.manaCost) || 0),
        minHpPercent: Math.max(0, Math.min(100, Number(r.minHpPercent) ?? 0)),
        maxHpPercent: Math.max(0, Math.min(100, Number(r.maxHpPercent) ?? 100)),
        minManaPercent: Math.max(0, Math.min(100, Number(r.minManaPercent) ?? 0)),
        maxManaPercent: Math.max(0, Math.min(100, Number(r.maxManaPercent) ?? 100)),
      }));
    }
    Object.assign(config, next);
    delete config.hpHotbarSlot;
    delete config.manaHotbarSlot;
    delete config.minHp;
    delete config.minMana;
    persistConfig();
    bot.log("auto heal config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.heal = {
    start, stop, status, updateConfig,
    readStats, tryHeal, config,
  };
};

/**
 * ==================================================================================
 * 7. AUTO INVISIBLE MODULE
 *    Casts "utana vid" when the invisible condition is not active.
 * ==================================================================================
 */
window.__minibiaBotBundle.installAutoInvisibleModule = function installAutoInvisibleModule(bot) {
  const configStorageKey = "minibiaBot.invisible.config";
  const INVISIBLE_CONDITION_ID = 4;
  const state = { running: false, timerId: null, lastCastAt: 0 };
  let resumeListenersAttached = false;

  const config = Object.assign(
    {
      tickMs: 500,
      spellWords: "utana vid",
      recastCooldownMs: 2000,
      enabled: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 500;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function getInvisibleConditionId() {
    return window.ConditionManager?.prototype?.INVISIBLE ?? INVISIBLE_CONDITION_ID;
  }

  function isInvisibleActive() {
    const player = window.gameClient?.player;
    const conditions = player?.conditions;
    const id = getInvisibleConditionId();
    if (conditions?.has) return conditions.has(id);
    if (player?.hasCondition) return player.hasCondition(id);
    return false;
  }

  function getGateStatus(now = Date.now()) {
    const cooldown = Math.max(0, config.recastCooldownMs - (now - state.lastCastAt));
    const ready = cooldown === 0;
    const active = isInvisibleActive();
    return { invisibleActive: active, cooldownReady: ready, cooldownRemainingMs: cooldown, canCast: !active && ready };
  }

  function canCastInvisible(now) { return getGateStatus(now).canCast; }
  function tryCastInvisible(now = Date.now()) {
    if (!config.enabled || !canCastInvisible(now)) return false;
    const sent = bot.sendChat(config.spellWords);
    if (sent) state.lastCastAt = now;
    return sent;
  }

  // ---- Resume listeners (identical to rune module) ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }

  function runImmediateTick() {
    if (!state.running) return;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    tick();
  }

  function handleResume() { if (!document.hidden) runImmediateTick(); }

  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }
  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;
    try { tryCastInvisible(); } catch (e) { bot.log("auto invisible tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();
    if (state.running) { bot.log("auto invisible already running"); return false; }
    state.running = true;
    attachResumeListeners();
    bot.log("auto invisible started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    detachResumeListeners();
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    bot.log("auto invisible stopped");
    return true;
  }

  function status() {
    return {
      running: state.running,
      config: { ...config },
      gates: getGateStatus(),
      lastCastAt: state.lastCastAt,
    };
  }

  function updateConfig(nextConfig = {}) {
    if (nextConfig.spellWords !== undefined) nextConfig.spellWords = String(nextConfig.spellWords || "").trim() || config.spellWords;
    if (nextConfig.recastCooldownMs !== undefined) nextConfig.recastCooldownMs = Math.max(0, Number(nextConfig.recastCooldownMs) || 0);
    Object.assign(config, nextConfig);
    config.tickMs = 500;
    persistConfig();
    bot.log("auto invisible config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.invisible = {
    start, stop, status, updateConfig,
    isInvisibleActive, canCastInvisible, tryCastInvisible,
    config,
  };
};

/**
 * ==================================================================================
 * 8. AUTO MAGIC SHIELD MODULE
 *    Casts "utamo vita" when the magic shield condition is not active.
 *    Falls back to an assumed duration (3 minutes) if condition detection fails.
 * ==================================================================================
 */
window.__minibiaBotBundle.installAutoMagicShieldModule = function installAutoMagicShieldModule(bot) {
  const configStorageKey = "minibiaBot.magicShield.config";
  const MAGIC_SHIELD_FALLBACK_DURATION_MS = 180000;
  const state = { running: false, timerId: null, lastCastAt: 0, assumedActiveUntil: 0 };
  let resumeListenersAttached = false;

  const config = Object.assign(
    {
      tickMs: 500,
      spellWords: "utamo vita",
      recastCooldownMs: 2000,
      enabled: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 500;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function getMagicShieldConditionId() {
    const prototype = window.ConditionManager?.prototype;
    const playerConditions = window.gameClient?.player?.conditions;
    const candidates = ["MAGIC_SHIELD", "MANA_SHIELD", "MAGICSHIELD", "MANASHIELD", "UTAMO_VITA"];
    for (const key of candidates) {
      const value = prototype?.[key] ?? playerConditions?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  }

  function isMagicShieldActive(now = Date.now()) {
    const player = window.gameClient?.player;
    const conditions = player?.conditions;
    const id = getMagicShieldConditionId();
    if (id != null) {
      if (conditions?.has) return conditions.has(id);
      if (player?.hasCondition) return player.hasCondition(id);
    }
    return now < state.assumedActiveUntil;
  }

  function getGateStatus(now = Date.now()) {
    const cooldown = Math.max(0, config.recastCooldownMs - (now - state.lastCastAt));
    const ready = cooldown === 0;
    const active = isMagicShieldActive(now);
    return { magicShieldActive: active, cooldownReady: ready, cooldownRemainingMs: cooldown, canCast: !active && ready };
  }

  function canCastMagicShield(now) { return getGateStatus(now).canCast; }
  function tryCastMagicShield(now = Date.now()) {
    if (!config.enabled || !canCastMagicShield(now)) return false;
    const sent = bot.sendChat(config.spellWords);
    if (sent) {
      state.lastCastAt = now;
      state.assumedActiveUntil = now + MAGIC_SHIELD_FALLBACK_DURATION_MS;
    }
    return sent;
  }

  // ---- Resume listeners (identical) ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }
  function runImmediateTick() {
    if (!state.running) return;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    tick();
  }
  function handleResume() { if (!document.hidden) runImmediateTick(); }

  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }
  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;
    try { tryCastMagicShield(); } catch (e) { bot.log("auto magic shield tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();
    if (state.running) { bot.log("auto magic shield already running"); return false; }
    state.running = true;
    attachResumeListeners();
    bot.log("auto magic shield started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    detachResumeListeners();
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    bot.log("auto magic shield stopped");
    return true;
  }

  function status() {
    return {
      running: state.running,
      config: { ...config },
      gates: getGateStatus(),
      lastCastAt: state.lastCastAt,
      assumedActiveUntil: state.assumedActiveUntil,
    };
  }

  function updateConfig(nextConfig = {}) {
    if (nextConfig.spellWords !== undefined) nextConfig.spellWords = String(nextConfig.spellWords || "").trim() || config.spellWords;
    if (nextConfig.recastCooldownMs !== undefined) nextConfig.recastCooldownMs = Math.max(0, Number(nextConfig.recastCooldownMs) || 0);
    Object.assign(config, nextConfig);
    config.tickMs = 500;
    persistConfig();
    bot.log("auto magic shield config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.magicShield = {
    start, stop, status, updateConfig,
    isMagicShieldActive, canCastMagicShield, tryCastMagicShield,
    config,
  };
};

/**
 * ==================================================================================
 * 9. AUTO ATTACK MODULE
 *    Automatically targets and attacks monsters. Supports melee mode (follow +
 *    attack), rune usage, preferred targets, and anti‑kill‑steal.
 * ==================================================================================
 */
window.__minibiaBotBundle.installAutoAttackModule = function installAutoAttackModule(bot) {
  const configStorageKey = "minibiaBot.attack.config";
  const state = {
    running: false,
    timerId: null,
    lastTargetHotkeyAt: 0,
    lastRuneHotkeyAt: 0,
    engagedTargetId: null,
    combatStartedAt: 0,
    lastChaseAt: 0,
    lastChaseDestinationKey: null,
    lastFollowTargetId: null,
    lastFollowDistance: Number.POSITIVE_INFINITY,
    lastFollowProgressAt: 0,
    lastFollowStallAt: 0,
    skippedTargetIds: new Map(),
  };

  const storedConfig = bot.storage.get(configStorageKey, {}) || {};
  const config = Object.assign(
    {
      tickMs: 500,
      targetHotbarSlot: 3,
      runeHotbarSlot: null,
      targetCooldownMs: 1200,
      runeCooldownMs: 1200,
      maxTargetDistance: 5,
      meleeMode: true,
      enabled: false,
      preferredTargetNames: [],
      preferredMatchMode: "exact",
      antiKSEnabled: true,
      antiKSSelfRange: 2,
      antiKSOtherRange: 2,
    },
    storedConfig
  );
  if (config.targetHotbarSlot == null && storedConfig.hotbarSlot != null) {
    config.targetHotbarSlot = storedConfig.hotbarSlot;
  }

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeHotbarSlot(slot) {
    const v = Number(slot);
    if (!Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < 1 || n > 12) return null;
    return n;
  }

  // ---- PREFERRED TARGETS ----
  function normalizeCreatureName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function getPreferredTargetNames() {
    if (!Array.isArray(config.preferredTargetNames)) return [];
    return config.preferredTargetNames.map(n => String(n || "").trim()).filter(Boolean);
  }

  function isPreferredCreature(creature) {
    const preferred = getPreferredTargetNames();
    if (!creature?.name || !preferred.length) return false;
    const name = normalizeCreatureName(creature.name);
    return preferred.some(p => {
      const pnorm = normalizeCreatureName(p);
      if (!pnorm) return false;
      if (config.preferredMatchMode === "includes") {
        return name === pnorm || name.includes(pnorm);
      }
      return name === pnorm;
    });
  }

  function getCreatureDistanceFromPlayer(creature) {
    const player = window.gameClient?.player;
    if (!player || !creature) return Number.POSITIVE_INFINITY;
    if (typeof player.getPosition !== "function" || typeof creature.getPosition !== "function") return Infinity;
    const pPos = player.getPosition();
    const cPos = creature.getPosition();
    if (!pPos || !cPos || pPos.z !== cPos.z) return Infinity;
    return Math.max(Math.abs(pPos.x - cPos.x), Math.abs(pPos.y - cPos.y));
  }

  function getCreaturePriorityScore(creature) {
    const distance = getCreatureDistanceFromPlayer(creature);
    const preferred = isPreferredCreature(creature);
    const bonus = preferred ? -1000 : 0;
    return bonus + distance;
  }

  function sortMonstersByPriority(monsters) {
    return [...monsters].sort((a, b) => {
      const sa = getCreaturePriorityScore(a);
      const sb = getCreaturePriorityScore(b);
      if (sa !== sb) return sa - sb;
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    });
  }

  function getNearbyMonsters() {
    const monsters = bot.xray?.getVisibleMonsters?.({ sameFloorOnly: true }) || [];
    return sortMonstersByPriority(monsters);
  }

  // ---- POSITION HELPERS ----
  function normalizePosition(value) {
    if (!value) return null;
    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) };
  }

  function getPositionKey(position) {
    return position ? `${position.x},${position.y},${position.z}` : null;
  }

  function isAdjacentTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return false;
    const dx = Math.abs(from.x - to.x);
    const dy = Math.abs(from.y - to.y);
    return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
  }

  function getTileDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return Number.POSITIVE_INFINITY;
    return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
  }

  function isSameCreature(left, right) {
    return !!(left && right && (left === right || left.id === right.id));
  }

  function findNearbyMonster(creature) {
    if (!creature) return null;
    const nearby = getNearbyMonsters();
    return nearby.find(m => isSameCreature(m, creature)) || null;
  }

  function findNearbyMonsterById(id) {
    if (id == null) return null;
    return getNearbyMonsters().find(m => m?.id === id) || null;
  }

  // ---- TARGET / FOLLOW ----
  function getCurrentTarget() {
    return window.gameClient?.player?.__target || null;
  }

  function getCurrentFollowTarget() {
    return window.gameClient?.player?.__followTarget || null;
  }

  function pruneSkippedTargets(now = Date.now()) {
    for (const [id, expiresAt] of state.skippedTargetIds) {
      if (expiresAt <= now) state.skippedTargetIds.delete(id);
    }
  }

  function resetFollowProgress() {
    state.lastFollowTargetId = null;
    state.lastFollowDistance = Number.POSITIVE_INFINITY;
    state.lastFollowProgressAt = 0;
    state.lastFollowStallAt = 0;
  }

  function clearEngagedTarget() {
    state.engagedTargetId = null;
    state.combatStartedAt = 0;
    state.lastChaseDestinationKey = null;
    resetFollowProgress();
  }

  function clearCurrentFollowTarget() {
    if (!window.gameClient?.player || typeof window.gameClient.send !== "function") return false;
    if (typeof FollowPacket !== "function") return false;
    if (!getCurrentFollowTarget()) return false;
    window.gameClient.player.setFollowTarget(null);
    window.gameClient.send(new FollowPacket(0));
    return true;
  }

  function clearCurrentTarget() {
    if (!window.gameClient?.player || typeof window.gameClient.send !== "function") return false;
    if (typeof TargetPacket !== "function") return false;
    if (!getCurrentTarget()) return false;
    window.gameClient.player.setTarget(null);
    window.gameClient.send(new TargetPacket(0));
    return true;
  }

  function markCombatActive(now = Date.now()) {
    if (!state.combatStartedAt) state.combatStartedAt = now;
  }

  function getCombatTargetCount() {
    return getEngagedTarget() ? 1 : 0;
  }

  function isCombatActive() {
    if (!config.enabled || !state.running) return false;
    return !!getEngagedTarget();
  }

  function syncCombatState(now = Date.now()) {
    if (isCombatActive()) { markCombatActive(now); return true; }
    state.combatStartedAt = 0;
    return false;
  }

  function getEngagedTarget() {
    const current = getCurrentTarget();
    if (current) { state.engagedTargetId = current.id; return current; }
    if (state.engagedTargetId == null) return null;
    const follow = getCurrentFollowTarget();
    if (follow && follow.id === state.engagedTargetId) {
      return findNearbyMonster(follow) || follow;
    }
    const nearby = findNearbyMonsterById(state.engagedTargetId);
    if (nearby) return nearby;
    clearEngagedTarget();
    return null;
  }

  // ---- TARGET VALIDATION & SELECTION ----
  function isTargetValidAndOnScreen(target, options = {}) {
    const client = window.gameClient;
    const player = client?.player;
    const world = client?.world;
    const returnDetails = options.returnDetails === true;
    const maxDx = Number.isFinite(options.maxDx) ? options.maxDx : 7;
    const maxDy = Number.isFinite(options.maxDy) ? options.maxDy : 5;

    function result(valid, extra = {}) {
      const details = {
        valid,
        reason: valid ? "valid" : "invalid",
        dx: null, dy: null, distance: Number.POSITIVE_INFINITY,
        preferred: false, score: Number.POSITIVE_INFINITY,
        ...extra,
      };
      return returnDetails ? details : details.valid;
    }

    if (!target) return result(false, { reason: "no target" });
    if (!player) return result(false, { reason: "no player" });
    if (!world) return result(false, { reason: "no world" });
    if (target.id == null) return result(false, { reason: "missing id" });
    if (typeof target.getPosition !== "function") return result(false, { reason: "target has no getPosition" });
    if (typeof player.getPosition !== "function") return result(false, { reason: "player has no getPosition" });

    const playerPos = player.getPosition();
    const targetPos = target.getPosition();
    if (!playerPos || !targetPos) return result(false, { reason: "missing position" });
    if (targetPos.z !== playerPos.z) return result(false, { reason: "different floor" });
    if (target.state && typeof target.state.health === "number" && target.state.health <= 0) {
      return result(false, { reason: "dead target" });
    }
    if (world.activeCreatures && target.id !== player.id &&
        !Object.prototype.hasOwnProperty.call(world.activeCreatures, target.id)) {
      return result(false, { reason: "not in activeCreatures" });
    }

    let dx, dy, distance = Number.POSITIVE_INFINITY;
    try {
      const pp = playerPos.projected();
      const tp = targetPos.projected();
      dx = Math.abs(pp.x - tp.x);
      dy = Math.abs(pp.y - tp.y);
      distance = Math.max(Math.abs(playerPos.x - targetPos.x), Math.abs(playerPos.y - targetPos.y));
    } catch { return result(false, { reason: "projection failed" }); }

    const visible = dx < maxDx && dy < maxDy;
    if (!visible) {
      return result(false, { reason: `off screen dx=${dx} dy=${dy}`, dx, dy, distance });
    }
    const preferred = isPreferredCreature(target);
    const score = getCreaturePriorityScore(target);
    return result(true, { reason: preferred ? "valid preferred" : "valid normal", dx, dy, distance, preferred, score });
  }

  function setCurrentTarget(target) {
    if (!target || !window.gameClient?.player || typeof window.gameClient.send !== "function") return false;
    if (typeof TargetPacket !== "function") return false;
    const info = isTargetValidAndOnScreen(target, { returnDetails: true, maxDx: 7, maxDy: 5 });
    if (!info.valid) {
      console.log("[target] rejected", { reason: info.reason, id: target?.id, name: target?.name, dx: info.dx, dy: info.dy });
      if (state.engagedTargetId === target.id) clearEngagedTarget();
      return false;
    }
    window.gameClient.player.setTarget(target);
    window.gameClient.send(new TargetPacket(target.id));
    state.engagedTargetId = target.id;
    console.log("[target] accepted", { id: target.id, name: target.name, preferred: info.preferred, score: info.score, distance: info.distance });
    return true;
  }

  function getValidatedEngagedTargetInfo() {
    const target = getEngagedTarget();
    if (!target) return { valid: false, target: null, reason: "no engaged target" };
    const info = isTargetValidAndOnScreen(target, { returnDetails: true, maxDx: 7, maxDy: 5 });
    if (!info.valid) return { valid: false, target, reason: info.reason, info };
    return { valid: true, target, reason: "valid", info };
  }

  function setCurrentFollowTarget(target) {
    if (!target || !window.gameClient?.player || typeof window.gameClient.send !== "function") return false;
    if (typeof FollowPacket !== "function") return false;
    const info = isTargetValidAndOnScreen(target, { returnDetails: true, maxDx: 7, maxDy: 5 });
    if (!info.valid) {
      console.log("[follow] rejected invalid follow target", { reason: info.reason, id: target?.id, name: target?.name });
      if (state.engagedTargetId === target.id) clearEngagedTarget();
      return false;
    }
    if (isSameCreature(getCurrentFollowTarget(), target)) return true;
    window.gameClient.player.setFollowTarget(target);
    window.gameClient.send(new FollowPacket(target.id));
    return true;
  }

  // ---- SKIP LOGIC ----
  function skipTarget(target, reason, now = Date.now(), skipMs = 500) {
    if (!target?.id) return false;
    const until = now + Math.max(500, Number(skipMs) || 0);
    state.skippedTargetIds.set(target.id, until);
    const clearedTarget = isSameCreature(getCurrentTarget(), target) ? clearCurrentTarget() : false;
    const clearedFollow = isSameCreature(getCurrentFollowTarget(), target) ? clearCurrentFollowTarget() : false;
    if (state.engagedTargetId === target.id) clearEngagedTarget();
    else if (state.lastFollowTargetId === target.id) resetFollowProgress();
    bot.log("skipping auto attack target", {
      id: target.id, name: target.name || "Mob", reason,
      skippedForMs: Math.max(500, Number(skipMs) || 0),
      clearedTarget, clearedFollow,
    });
    return true;
  }

  function isTargetSkipped(target, now = Date.now()) {
    pruneSkippedTargets(now);
    return !!target?.id && (state.skippedTargetIds.get(target.id) || 0) > now;
  }

  // ---- MONSTER CANDIDATES (with Anti-KS) ----
  function getMonsterCandidates(now = Date.now()) {
    pruneSkippedTargets(now);
    const me = bot.getPlayerPosition();
    if (!me) return [];
    const visiblePlayers = bot.xray?.getVisiblePlayers?.({ sameFloorOnly: true }) || [];
    const myId = window.gameClient?.player?.id;
    const otherPlayers = visiblePlayers.filter(p => p.id !== myId);
    const hasOtherPlayers = otherPlayers.length > 0 && config.antiKSEnabled;

    return getNearbyMonsters()
      .filter(m => !isTargetSkipped(m, now))
      .filter(m => {
        const info = isTargetValidAndOnScreen(m, { returnDetails: true, maxDx: 7, maxDy: 5 });
        if (!info.valid) return false;

        // Anti-KS
        if (hasOtherPlayers) {
          const mPos = m.getPosition?.() || m.__position;
          if (!mPos) return false;
          const selfRange = config.antiKSSelfRange ?? 2;
          const otherRange = config.antiKSOtherRange ?? 2;
          const dist = Math.max(Math.abs(me.x - mPos.x), Math.abs(me.y - mPos.y));
          if (dist > selfRange) return false;
          for (const player of otherPlayers) {
            const pPos = player.getPosition?.() || player.__position;
            if (!pPos) continue;
            const dx = Math.abs(pPos.x - mPos.x);
            const dy = Math.abs(pPos.y - mPos.y);
            if (dx <= otherRange && dy <= otherRange) return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const sa = getCreaturePriorityScore(a);
        const sb = getCreaturePriorityScore(b);
        if (sa !== sb) return sa - sb;
        return Number(a?.id || 0) - Number(b?.id || 0);
      });
  }

  // ---- GIVE UP / DISTANCE ----
  function shouldGiveUpTarget(target) {
    const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);
    const playerPos = normalizePosition(bot.getPlayerPosition());
    const targetPos = normalizePosition(target?.getPosition?.() || target?.__position);
    if (!playerPos || !targetPos) return false;
    return getTileDistance(playerPos, targetPos) > maxDist;
  }

  function resetTargetIfTooFar() {
    const current = getCurrentTarget();
    if (current && shouldGiveUpTarget(current)) {
      skipTarget(current, "target too far", Date.now(), 500);
      return true;
    }
    const engaged = getEngagedTarget();
    if (engaged && shouldGiveUpTarget(engaged)) {
      skipTarget(engaged, "engaged target too far", Date.now(), 500);
      return true;
    }
    return false;
  }

  // ---- MELEE CHASE ----
  function getTileFromPosition(position) {
    if (!position || typeof Position !== "function") return null;
    return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(position.x, position.y, position.z)) || null;
  }

  function findReachableAdjacentPosition(targetPos, playerPos) {
    if (!targetPos || !playerPos) return null;
    const offsets = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];
    offsets.sort((a, b) => {
      const da = Math.abs(targetPos.x + a.x - playerPos.x) + Math.abs(targetPos.y + a.y - playerPos.y);
      const db = Math.abs(targetPos.x + b.x - playerPos.x) + Math.abs(targetPos.y + b.y - playerPos.y);
      return da - db;
    });
    const pf = window.gameClient?.world?.pathfinder;
    const startTile = getTileFromPosition(playerPos);
    if (!pf || !startTile || typeof pf.search !== "function") return null;
    for (const offset of offsets) {
      const candidate = { x: targetPos.x + offset.x, y: targetPos.y + offset.y, z: targetPos.z };
      const tile = getTileFromPosition(candidate);
      if (!tile?.isWalkable?.()) continue;
      if (candidate.x === playerPos.x && candidate.y === playerPos.y) return candidate;
      try {
        const path = pf.search(startTile, tile);
        if (Array.isArray(path) && path.length > 0) return candidate;
      } catch (e) {
        bot.log("auto attack reachability check failed", { ...candidate, error: e?.message || e });
        return null;
      }
    }
    return null;
  }

  function syncMeleeChase(now = Date.now()) {
    if (!config.meleeMode) return false;
    const engaged = getValidatedEngagedTargetInfo();
    if (!engaged.valid) {
      if (engaged.target) skipTarget(engaged.target, engaged.reason || "invalid engaged target", now, 1000);
      else clearEngagedTarget();
      return false;
    }
    const target = engaged.target;
    const playerPos = normalizePosition(bot.getPlayerPosition());
    const targetPos = normalizePosition(target.getPosition?.() || target.__position);
    if (!playerPos || !targetPos || playerPos.z !== targetPos.z) return false;
    const giveUpDelay = Math.max(500, (Number(config.tickMs) || 0) * 10);

    if (isAdjacentTile(playerPos, targetPos)) {
      state.lastChaseDestinationKey = null;
      clearCurrentFollowTarget();
      resetFollowProgress();
      return false;
    }

    const adjPos = findReachableAdjacentPosition(targetPos, playerPos);
    if (!adjPos) {
      if (!state.lastFollowStallAt) state.lastFollowStallAt = now;
      else if (now - state.lastFollowStallAt > giveUpDelay) {
        return skipTarget(target, "no reachable adjacent tile", now);
      }
      return false;
    }

    const currentDist = getTileDistance(playerPos, targetPos);
    if (state.lastFollowTargetId !== target.id) {
      state.lastFollowTargetId = target.id;
      state.lastFollowDistance = currentDist;
      state.lastFollowProgressAt = now;
      state.lastFollowStallAt = 0;
    } else if (currentDist < state.lastFollowDistance) {
      state.lastFollowDistance = currentDist;
      state.lastFollowProgressAt = now;
      state.lastFollowStallAt = 0;
    }

    const followed = setCurrentFollowTarget(target);
    if (followed) {
      state.lastChaseAt = now;
      state.lastChaseDestinationKey = getPositionKey(adjPos);
      bot.log("following auto attack target", { id: target.id, name: target.name || "Mob", followTargetId: target.id });
    }

    if (state.lastFollowDistance <= currentDist) {
      if (!state.lastFollowStallAt) state.lastFollowStallAt = now;
      else if (now - state.lastFollowStallAt > giveUpDelay) {
        return skipTarget(target, "follow made no progress", now);
      }
    }
    return followed;
  }

  // ---- ATTACK / RUNE ACTIONS ----
  function canAttack(now = Date.now()) {
    const slot = normalizeHotbarSlot(config.targetHotbarSlot);
    if (!slot) return false;
    if (now - state.lastTargetHotkeyAt < Math.max(0, Number(config.targetCooldownMs) || 0)) return false;
    if (config.meleeMode) {
      return getMonsterCandidates(now).length > 0 && !getCurrentTarget();
    }
    return getNearbyMonsters().length > 0;
  }

  function triggerAttack(now = Date.now()) {
    if (!canAttack(now)) return false;
    const engaged = getEngagedTarget();
    const preferred = engaged && !isTargetSkipped(engaged, now)
      ? engaged
      : (getMonsterCandidates(now)[0] || null);
    if (preferred && setCurrentTarget(preferred)) {
      state.lastTargetHotkeyAt = now;
      markCombatActive(now);
      bot.log("selected auto attack target", {
        id: preferred.id, name: preferred.name || "Mob",
        reason: isSameCreature(preferred, engaged) ? "engaged target" : "nearest candidate",
      });
      return true;
    }
    if (config.meleeMode) return false;
    const slot = normalizeHotbarSlot(config.targetHotbarSlot);
    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      state.lastTargetHotkeyAt = now;
      markCombatActive(now);
      bot.log("used auto attack target hotkey", { slot, nearbyMonsters: getNearbyMonsters().map(c => c.name || "Mob") });
    }
    return clicked;
  }

  function canUseRune(now = Date.now()) {
    const slot = normalizeHotbarSlot(config.runeHotbarSlot);
    if (!slot || !getCurrentTarget()) return false;
    if (now - state.lastRuneHotkeyAt < Math.max(0, Number(config.runeCooldownMs) || 0)) return false;
    return true;
  }

  function triggerRune(now = Date.now()) {
    if (!canUseRune(now)) return false;
    const slot = normalizeHotbarSlot(config.runeHotbarSlot);
    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      state.lastRuneHotkeyAt = now;
      markCombatActive(now);
      bot.log("used auto attack rune hotkey", { slot, target: getCurrentTarget()?.name || "Mob" });
    }
    return clicked;
  }

  function tryAttack() {
    if (!config.enabled) return false;
    const now = Date.now();
    if (resetTargetIfTooFar()) return true;
    syncCombatState(now);

    if (config.meleeMode) {
      const chased = syncMeleeChase(now);
      if (getCurrentTarget()) return false;
      if (chased) return triggerAttack(now) || true;
    }
    if (getCurrentTarget()) return triggerRune(now);
    return triggerAttack(now);
  }

  // ---- LOOP ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }

  function tick() {
    if (!state.running) return;
    try { tryAttack(); } catch (e) { bot.log("auto attack tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    persistConfig();
    if (state.running) { bot.log("auto attack already running"); return false; }
    state.running = true;
    bot.log("auto attack started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    clearEngagedTarget();
    state.lastChaseAt = 0;
    clearCurrentFollowTarget();
    state.skippedTargetIds.clear();
    bot.log("auto attack stopped");
    return true;
  }

  function status() {
    const combatActive = syncCombatState(Date.now());
    return {
      running: state.running,
      config: { ...config },
      lastTargetHotkeyAt: state.lastTargetHotkeyAt,
      lastRuneHotkeyAt: state.lastRuneHotkeyAt,
      engagedTargetId: state.engagedTargetId,
      combatActive,
      combatStartedAt: state.combatStartedAt || 0,
      combatDurationMs: state.combatStartedAt ? Math.max(0, Date.now() - state.combatStartedAt) : 0,
      targetCount: getCombatTargetCount(),
      lastChaseAt: state.lastChaseAt,
      currentTarget: getCurrentTarget() ? {
        id: getCurrentTarget().id,
        name: getCurrentTarget().name,
        type: getCurrentTarget().type,
        position: getCurrentTarget().__position || null,
      } : null,
      nearbyMonsters: getNearbyMonsters().map(c => ({
        id: c.id, name: c.name, type: c.type, position: c.__position,
      })),
    };
  }

  function updateConfig(nextConfig = {}) {
    if (nextConfig.targetHotbarSlot !== undefined) {
      nextConfig.targetHotbarSlot = normalizeHotbarSlot(nextConfig.targetHotbarSlot) ?? config.targetHotbarSlot;
    }
    if (nextConfig.runeHotbarSlot !== undefined) {
      nextConfig.runeHotbarSlot = normalizeHotbarSlot(nextConfig.runeHotbarSlot);
    }
    if (nextConfig.maxTargetDistance !== undefined) {
      nextConfig.maxTargetDistance = Math.max(1, Math.trunc(Number(nextConfig.maxTargetDistance) || config.maxTargetDistance || 5));
    }
    if (nextConfig.antiKSEnabled !== undefined) {
      nextConfig.antiKSEnabled = !!nextConfig.antiKSEnabled;
    }
    if (nextConfig.antiKSSelfRange !== undefined) {
      nextConfig.antiKSSelfRange = Math.max(1, Math.trunc(Number(nextConfig.antiKSSelfRange) || 2));
    }
    if (nextConfig.antiKSOtherRange !== undefined) {
      nextConfig.antiKSOtherRange = Math.max(1, Math.trunc(Number(nextConfig.antiKSOtherRange) || 2));
    }
    Object.assign(config, nextConfig);
    persistConfig();
    bot.log("auto attack config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.addCleanup(() => stop({ persistEnabled: false }));

  bot.attack = {
    start, stop, status, updateConfig,
    tryAttack, canAttack, triggerAttack,
    canUseRune, triggerRune,
    getNearbyMonsters, getCurrentTarget, getCurrentFollowTarget,
    isCombatActive, syncMeleeChase, normalizeHotbarSlot,
    config,
  };
};

/**
 * ==================================================================================
 * 10. CAVE MODULE
 *     Follows a route of waypoints, handles floor transitions (ladders, stairs,
 *     ropes, shovels), learns transitions, supports presets, and draws a minimap
 *     overlay. Optionally loops the route.
 * ==================================================================================
 */
window.__minibiaBotBundle.installCaveModule = function installCaveModule(bot) {
  const configStorageKey = "minibiaBot.cave.config";
  const routeStorageKey = "minibiaBot.cave.route";
  const transitionStorageKey = "minibiaBot.cave.transitions";
  const presetStorageKey = "minibiaBot.cave.presets";
  const defaultPresetName = "Default";
  const minimapOverlayRootId = "minibia-bot-cave-minimap-overlay";
  const minimapOverlayStyleId = "minibia-bot-cave-minimap-overlay-style";
  const ladderItemIds = new Set([1948, 1968]);
  const ropeNamePattern = /\brope\b/i;
  const shovelNamePattern = /\bshovel\b/i;
  const shovelTargetNamePatterns = [
    /\bstone pile\b/i, /\bloose stone pile\b/i, /\bgravel pile\b/i, /\bdirt pile\b/i,
  ];

  const state = {
    running: false,
    timerId: null,
    observerTimerId: null,
    currentIndex: 0,
    direction: 1,
    lastPathAt: 0,
    lastPositionKey: null,
    lastProgressAt: 0,
    lastStairsUseAt: 0,
    lastObservedPosition: null,
    pendingTransitionSource: null,
    pausedForCombat: false,
    lastWaypointTarget: null,
    lastSkipCheckAt: 0,
    skipAttemptCount: 0,
    pathAttemptStart: 0,
  };
  const minimapOverlayState = { timerId: null };

  const config = Object.assign(
    {
      tickMs: 500,
      repathMs: 1500,
      waypointTolerance: 0,
      enabled: false,
      activePresetName: defaultPresetName,
      loopMode: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 500;

  // ---- PRESET MANAGEMENT ----
  function normalizePresetName(value) {
    const norm = String(value || "").trim().replace(/\s+/g, " ");
    return norm || null;
  }

  function cloneValue(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  function normalizePreset(value) {
    if (!value) return null;
    const name = normalizePresetName(value.name);
    if (!name) return null;
    return {
      name,
      route: normalizeRoute(value.route),
      transitions: normalizeTransitions(value.transitions),
    };
  }

  function normalizePresets(value) {
    const entries = Array.isArray(value) ? value : [];
    const deduped = new Map();
    entries.map(normalizePreset).filter(Boolean).forEach(p => deduped.set(p.name.toLowerCase(), p));
    return Array.from(deduped.values());
  }

  let route = normalizeRoute(bot.storage.get(routeStorageKey, []));
  let transitions = normalizeTransitions(bot.storage.get(transitionStorageKey, []));
  let presets = normalizePresets(bot.storage.get(presetStorageKey, []));
  if (!presets.length && (route.length || transitions.length)) {
    presets = [{
      name: defaultPresetName,
      route: route.map(w => cloneValue(w)),
      transitions: transitions.map(t => cloneValue(t)),
    }];
  }

  function getPresetNames() { return presets.map(p => p.name); }
  function getPresetByName(name) {
    const n = normalizePresetName(name);
    if (!n) return null;
    return presets.find(p => p.name.toLowerCase() === n.toLowerCase()) || null;
  }

  function getActivePresetName() {
    const configured = normalizePresetName(config.activePresetName);
    if (configured && getPresetByName(configured)) return getPresetByName(configured).name;
    if (presets.length) return presets[0].name;
    return configured || defaultPresetName;
  }

  function persistPresets() {
    bot.storage.set(presetStorageKey, presets.map(p => ({
      name: p.name,
      route: p.route.map(w => ({ ...w })),
      transitions: p.transitions.map(t => cloneValue(t)),
    })));
  }

  function persistLegacyActivePreset() {
    bot.storage.set(routeStorageKey, route.map(w => ({ ...w })));
    bot.storage.set(transitionStorageKey, transitions.map(t => cloneValue(t)));
  }

  function setActivePresetName(name) {
    config.activePresetName = normalizePresetName(name) || defaultPresetName;
    persistConfig();
    return config.activePresetName;
  }

  function upsertPreset(name, nextRoute = route, nextTransitions = transitions) {
    const norm = normalizePresetName(name);
    if (!norm) return null;
    const preset = {
      name: norm,
      route: normalizeRoute(nextRoute).map(w => cloneValue(w)),
      transitions: normalizeTransitions(nextTransitions).map(t => cloneValue(t)),
    };
    const idx = presets.findIndex(p => p.name.toLowerCase() === norm.toLowerCase());
    if (idx >= 0) presets[idx] = preset;
    else presets.push(preset);
    persistPresets();
    return preset;
  }

  function persistActivePreset() {
    upsertPreset(getActivePresetName(), route, transitions);
    persistLegacyActivePreset();
  }

  function loadPresetState(name) {
    const preset = getPresetByName(name);
    if (!preset) return null;
    route = normalizeRoute(preset.route);
    transitions = normalizeTransitions(preset.transitions);
    state.currentIndex = 0;
    state.direction = 1;
    state.pendingTransitionSource = null;
    setActivePresetName(preset.name);
    persistLegacyActivePreset();
    return preset;
  }

  const initialPreset = getActivePresetName();
  if (loadPresetState(initialPreset)) {
    config.activePresetName = initialPreset;
  } else {
    setActivePresetName(initialPreset);
  }

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function persistRoute() { persistActivePreset(); }

  // ---- POSITION HELPERS ----
  function normalizePosition(value) {
    if (!value) return null;
    const x = Number(value.x), y = Number(value.y), z = Number(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x: Math.trunc(x), y: Math.trunc(y), z: Math.trunc(z) };
  }

  function normalizeWaypoint(waypoint) { return normalizePosition(waypoint); }
  function normalizeRoute(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeWaypoint).filter(Boolean);
  }

  function normalizeTransition(transition) {
    if (!transition) return null;
    const from = normalizePosition(transition.from || transition);
    const to = normalizePosition(transition.to || {
      x: transition.targetX,
      y: transition.targetY,
      z: transition.targetZ,
    });
    if (!from || !to || from.z === to.z) return null;
    const count = Math.max(1, Math.trunc(Number(transition.count) || 1));
    const lastSeenAt = Math.max(0, Math.trunc(Number(transition.lastSeenAt) || Date.now()));
    return { from, to, count, lastSeenAt };
  }

  function normalizeTransitions(value) {
    if (!Array.isArray(value)) return [];
    const deduped = new Map();
    value.map(normalizeTransition).filter(Boolean).forEach(t => deduped.set(getPositionKey(t.from), t));
    return Array.from(deduped.values());
  }

  function getRoute() { return route.map(w => cloneValue(w)); }
  function getTransitions() { return transitions.map(t => cloneValue(t)); }
  function persistTransitions() { persistActivePreset(); }

  // ---- PRESET CRUD ----
  function savePreset(name, options = {}) {
    const preset = upsertPreset(name, route, transitions);
    if (!preset) { bot.log("cave preset name is required"); return null; }
    if (options.activate !== false) {
      setActivePresetName(preset.name);
      persistLegacyActivePreset();
    }
    bot.log("cave preset saved", { name: preset.name, waypoints: preset.route.length, transitions: preset.transitions.length });
    return { name: preset.name, route: preset.route.map(w => cloneValue(w)), transitions: preset.transitions.map(t => cloneValue(t)) };
  }

  function createPreset(name) {
    const norm = normalizePresetName(name);
    if (!norm) { bot.log("cave preset name is required"); return null; }
    if (getPresetByName(norm)) { bot.log("cave preset already exists", { name: norm }); return null; }
    if (state.running) stop();
    const preset = upsertPreset(norm, [], []);
    if (!preset) return null;
    loadPresetState(preset.name);
    bot.log("cave preset created", { name: preset.name });
    return { name: preset.name, route: [], transitions: [] };
  }

  function loadPreset(name) {
    const preset = getPresetByName(name);
    if (!preset) { bot.log("cave preset not found", { name }); return null; }
    if (state.running) stop();
    loadPresetState(preset.name);
    bot.log("cave preset loaded", { name: preset.name, waypoints: route.length, transitions: transitions.length });
    return { name: preset.name, route: getRoute(), transitions: getTransitions() };
  }

  function deletePreset(name) {
    const preset = getPresetByName(name);
    if (!preset) { bot.log("cave preset not found", { name }); return false; }
    presets = presets.filter(p => p.name.toLowerCase() !== preset.name.toLowerCase());
    persistPresets();
    if (preset.name.toLowerCase() === getActivePresetName().toLowerCase()) {
      const fallback = presets[0] || null;
      if (state.running) stop();
      if (fallback) loadPresetState(fallback.name);
      else {
        route = []; transitions = [];
        state.currentIndex = 0; state.direction = 1;
        state.pendingTransitionSource = null;
        setActivePresetName(defaultPresetName);
        persistLegacyActivePreset();
      }
    }
    bot.log("cave preset deleted", { name: preset.name });
    return true;
  }

  // ---- WAYPOINT HELPERS ----
  function getCurrentWaypoint() {
    if (!route.length) return null;
    if (state.currentIndex < 0 || state.currentIndex >= route.length) state.currentIndex = 0;
    return route[state.currentIndex] || null;
  }

  function getPositionKey(position) {
    return position ? `${position.x},${position.y},${position.z}` : null;
  }

  function getDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return Number.POSITIVE_INFINITY;
    return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
  }

  function isBesideOrSameTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return false;
    return Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1;
  }

  function isAdjacentTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) return false;
    const dx = Math.abs(from.x - to.x), dy = Math.abs(from.y - to.y);
    return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
  }

  function getDistanceToWaypoint(position, waypoint) {
    if (!position || !waypoint) return null;
    return getDistance(position, waypoint);
  }

  function isSameTile(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.z === b.z;
  }

  function findClosestWaypointIndex(position) {
    if (!position || !route.length) return 0;
    let bestIdx = 0, bestDist = Infinity;
    route.forEach((wp, i) => {
      const d = getDistanceToWaypoint(position, wp);
      if (Number.isFinite(d) && d < bestDist) { bestDist = d; bestIdx = i; }
    });
    return bestIdx;
  }

  // ---- TILE / ITEM HELPERS ----
  function getTileAt(position) {
    if (!position) return null;
    return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(position.x, position.y, position.z)) || null;
  }

  function getTilePosition(tile) { return normalizePosition(tile?.__position); }

  function getThingDefinition(itemId) {
    if (!itemId) return null;
    return window.gameClient?.itemDefinitionsByCid?.[itemId] ||
           window.gameClient?.itemDefinitionsBySid?.[itemId] ||
           window.gameClient?.itemDefinitions?.[itemId] || null;
  }

  function getThingName(thing) {
    const def = getThingDefinition(thing?.id);
    return String(def?.properties?.name || thing?.name || "").trim().toLowerCase();
  }

  function isLadderThing(thing) {
    if (!thing?.id) return false;
    if (ladderItemIds.has(Number(thing.id))) return true;
    return getThingName(thing).includes("ladder");
  }

  function isFloorChangeThing(thing) {
    const def = getThingDefinition(thing?.id);
    return !!def?.properties?.floorchange || isLadderThing(thing);
  }

  function isFloorChangeTile(tile) {
    const pos = getTilePosition(tile);
    if (!pos) return false;
    if (isFloorChangeThing(tile)) return true;
    return Array.isArray(tile.items) && tile.items.some(item => isFloorChangeThing(item));
  }

  function getTileThings(tile) {
    if (!tile) return [];
    const things = [];
    if (tile.id) things.push(tile);
    if (Array.isArray(tile.items)) {
      tile.items.forEach(item => { if (item) things.push(item); });
    }
    return things;
  }

  function tileHasNamedThing(tile, needle) {
    const val = String(needle || "").trim().toLowerCase();
    if (!val) return false;
    return getTileThings(tile).some(t => getThingName(t).includes(val));
  }

  function isLadderTile(tile) { return getTileThings(tile).some(t => isLadderThing(t)); }
  function isStairsTile(tile) { return tileHasNamedThing(tile, "stairs"); }
  function isHoleTile(tile) { return tileHasNamedThing(tile, "hole"); }
  function isRopeSpotTile(tile) { return tileHasNamedThing(tile, "rope spot"); }
  function isRopeTargetTile(tile) { return isHoleTile(tile) || isRopeSpotTile(tile); }

  function isShovelTargetThing(thing) {
    const name = getThingName(thing);
    if (!name) return false;
    return shovelTargetNamePatterns.some(p => p.test(name));
  }
  function isShovelTargetTile(tile) {
    return getTileThings(tile).some(t => isShovelTargetThing(t));
  }

  function isTransitionCandidateTile(tile, waypoint, position) {
    if (!tile) return false;
    if (isFloorChangeTile(tile)) return true;
    if (!waypoint || !position || !Number.isFinite(waypoint.z) || !Number.isFinite(position.z)) return false;
    if (waypoint.z > position.z) return isShovelTargetTile(tile);
    if (waypoint.z < position.z) return isRopeTargetTile(tile);
    return false;
  }

  function getFloorChangeTileBias(tile, position, waypoint) {
    if (!tile || !position || !waypoint || position.z === waypoint.z) return 0;
    const goingDown = waypoint.z > position.z;
    const goingUp = waypoint.z < position.z;
    if (goingDown) {
      if (isLadderTile(tile)) return -30;
      if (isHoleTile(tile)) return -20;
      if (isStairsTile(tile)) return 25;
    }
    if (goingUp) {
      if (isStairsTile(tile)) return -20;
      if (isHoleTile(tile)) return 20;
    }
    return 0;
  }

  function getLoadedTiles() {
    const chunks = window.gameClient?.world?.chunks || [];
    const tiles = [];
    for (const chunk of chunks) {
      if (!chunk?.tiles) continue;
      for (const tile of chunk.tiles) {
        if (tile?.__position) tiles.push(tile);
      }
    }
    return tiles;
  }

  // ---- MINIMAP OVERLAY ----
  function ensureMinimapOverlayStyle() {
    if (document.getElementById(minimapOverlayStyleId)) return;
    const style = document.createElement("style");
    style.id = minimapOverlayStyleId;
    style.textContent = `
      #${minimapOverlayRootId} { position: fixed; inset: 0; pointer-events: none; z-index: 999997; }
      #${minimapOverlayRootId} canvas { position: fixed; pointer-events: none; }
    `;
    document.head.appendChild(style);
  }

  function ensureMinimapOverlayRoot() {
    let root = document.getElementById(minimapOverlayRootId);
    if (root) return root;
    root = document.createElement("div");
    root.id = minimapOverlayRootId;
    root.innerHTML = '<canvas></canvas>';
    document.body.appendChild(root);
    return root;
  }

  function destroyMinimapOverlayElements() {
    document.getElementById(minimapOverlayRootId)?.remove();
    document.getElementById(minimapOverlayStyleId)?.remove();
  }

  function getMinimapCanvas() {
    return window.gameClient?.renderer?.minimap?.minimap?.canvas || document.getElementById("minimap") || null;
  }

  function getMinimapViewport() {
    const canvas = getMinimapCanvas();
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { canvas, rect };
  }

  function getWaypointCanvasPoint(waypoint, viewport, playerPos, minimap) {
    if (!waypoint || !viewport || !playerPos || !minimap) return null;
    if (waypoint.z !== minimap.__renderLayer) return null;
    const zoom = 1 << (Number(minimap.__zoomLevel) || 0);
    const center = minimap.center || { x: 0, y: 0 };
    const iw = Number(viewport.canvas.width) || 160;
    const ih = Number(viewport.canvas.height) || 160;
    const ix = (iw / 2) + (waypoint.x - playerPos.x - Number(center.x || 0)) * zoom;
    const iy = (ih / 2) + (waypoint.y - playerPos.y - Number(center.y || 0)) * zoom;
    return { x: ix * (viewport.rect.width / iw), y: iy * (viewport.rect.height / ih) };
  }

  function renderMinimapOverlay() {
    const viewport = getMinimapViewport();
    const minimap = window.gameClient?.renderer?.minimap;
    const playerPos = normalizePosition(bot.getPlayerPosition());
    const root = ensureMinimapOverlayRoot();
    const canvas = root.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!viewport || !minimap || !playerPos || !route.length) {
      canvas.width = 0; canvas.height = 0; return;
    }
    const rect = viewport.rect;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; canvas.height = ph;
    }
    canvas.style.left = `${Math.round(rect.left)}px`;
    canvas.style.top = `${Math.round(rect.top)}px`;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const visible = route.map((wp, i) => ({ waypoint: wp, index: i, point: getWaypointCanvasPoint(wp, viewport, playerPos, minimap) }))
      .filter(e => e.point);
    if (!visible.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < visible.length; i++) {
      const prev = visible[i-1], cur = visible[i];
      if (cur.index !== prev.index + 1) continue;
      ctx.strokeStyle = "rgba(92, 228, 196, 0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(prev.point.x, prev.point.y);
      ctx.lineTo(cur.point.x, cur.point.y);
      ctx.stroke();
    }
    visible.forEach(({ point, index }) => {
      const isCurrent = state.running && index === state.currentIndex;
      const radius = isCurrent ? 7 : 5;
      ctx.fillStyle = isCurrent ? "#ffcf5a" : "#2bd1c4";
      ctx.strokeStyle = isCurrent ? "#6a2400" : "#083f49";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px Verdana, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1), point.x, point.y);
    });
    ctx.restore();
  }

  function startMinimapOverlay() {
    if (minimapOverlayState.timerId != null) return;
    ensureMinimapOverlayStyle();
    renderMinimapOverlay();
    minimapOverlayState.timerId = window.setInterval(renderMinimapOverlay, 250);
  }
  function stopMinimapOverlay() {
    if (minimapOverlayState.timerId != null) {
      window.clearInterval(minimapOverlayState.timerId);
      minimapOverlayState.timerId = null;
    }
    destroyMinimapOverlayElements();
  }

  // ---- TRANSITION HANDLING ----
  function getNearbyTransitionTiles(position, waypoint, radius = 8) {
    if (!position) return [];
    return getLoadedTiles()
      .map(t => ({ tile: t, position: getTilePosition(t) }))
      .filter(e =>
        e.position &&
        e.position.z === position.z &&
        Math.abs(e.position.x - position.x) <= radius &&
        Math.abs(e.position.y - position.y) <= radius &&
        isTransitionCandidateTile(e.tile, waypoint, position)
      );
  }

  function findTransitionTileNearPosition(position, waypoint, radius = 1) {
    if (!position) return null;
    let best = null, bestDist = Infinity;
    getNearbyTransitionTiles(position, waypoint, radius).forEach(e => {
      const d = getDistance(position, e.position);
      if (Number.isFinite(d) && d < bestDist) { bestDist = d; best = e; }
    });
    return best;
  }

  function findBestKnownTransition(position, waypoint) {
    if (!position || !waypoint) return null;
    let best = null, bestScore = Infinity;
    transitions.forEach(t => {
      if (t.from.z !== position.z || t.to.z !== waypoint.z) return;
      const playerDist = getDistance(position, t.from);
      const landingDist = getDistance(t.to, waypoint);
      if (!Number.isFinite(playerDist) || !Number.isFinite(landingDist)) return;
      const score = playerDist * 10 + landingDist;
      if (score < bestScore) { bestScore = score; best = t; }
    });
    return best;
  }

  function findNearbyTransitionTile(position, waypoint) {
    if (!position || !waypoint) return null;
    const wpDist = Math.abs(position.x - waypoint.x) + Math.abs(position.y - waypoint.y);
    const radius = Math.max(4, Math.min(20, wpDist + 2));
    let best = null, bestScore = Infinity;
    getNearbyTransitionTiles(position, waypoint, radius).forEach(e => {
      const pd = getDistance(position, e.position);
      const twd = Math.abs(e.position.x - waypoint.x) + Math.abs(e.position.y - waypoint.y);
      const score = pd * 10 + twd + getFloorChangeTileBias(e.tile, position, waypoint);
      if (score < bestScore) { bestScore = score; best = { tile: e.tile, position: e.position, playerDistance: pd, waypointDistance: twd }; }
    });
    return best;
  }

  function isAtWaypoint(position, waypoint) {
    const d = getDistanceToWaypoint(position, waypoint);
    if (!Number.isFinite(d)) return false;
    return d <= Math.max(0, Number(config.waypointTolerance) || 0);
  }

  function goToWaypoint(waypoint) {
    const from = bot.getPlayerPosition();
    if (!from || !waypoint) return false;
    const to = new Position(waypoint.x, waypoint.y, waypoint.z);
    try {
      window.gameClient?.world?.pathfinder?.findPath?.(from, to);
      state.lastPathAt = Date.now();
      bot.log("cave pathing to waypoint", { ...waypoint, index: state.currentIndex + 1, total: route.length });
      return true;
    } catch (error) {
      bot.log("cave pathing failed", { ...waypoint, error: error?.message || error });
      return false;
    }
  }

  function goToPosition(position) {
    if (!position) return false;
    return goToWaypoint(position);
  }

  function markPendingTransitionSource(source) {
    const norm = normalizePosition(source);
    if (!norm) return;
    state.pendingTransitionSource = { ...norm, at: Date.now() };
  }

  function upsertTransition(from, to) {
    const f = normalizePosition(from), t = normalizePosition(to);
    if (!f || !t || f.z === t.z) return null;
    const key = getPositionKey(f);
    const idx = transitions.findIndex(tr => getPositionKey(tr.from) === key);
    const next = {
      from: f, to: t,
      count: idx >= 0 ? transitions[idx].count + 1 : 1,
      lastSeenAt: Date.now(),
    };
    if (idx >= 0) transitions[idx] = next;
    else transitions.push(next);
    persistTransitions();
    bot.log("cave learned floor transition", next);
    return cloneValue(next);
  }

  function resolveObservedTransitionSource(prevPos) {
    const pending = normalizePosition(state.pendingTransitionSource);
    if (pending && pending.z === prevPos.z) return pending;
    const tile = getTileAt(prevPos);
    if (tile && isFloorChangeTile(tile)) return prevPos;
    const nearby = findTransitionTileNearPosition(prevPos, null, 1);
    if (nearby?.position) return nearby.position;
    return null;
  }

  function observePosition() {
    const current = normalizePosition(bot.getPlayerPosition());
    if (!current) return;
    const previous = state.lastObservedPosition;
    if (previous && !isSameTile(previous, current) && previous.z !== current.z) {
      const source = resolveObservedTransitionSource(previous);
      if (source) upsertTransition(source, current);
      state.pendingTransitionSource = null;
    }
    state.lastObservedPosition = current;
  }

  // ---- TOOL HANDLING (rope / shovel) ----
  function getEquipment() { return window.gameClient?.player?.equipment || null; }
  function getOpenContainers() { return Array.from(window.gameClient?.player?.__openedContainers || []); }

  function findAdjacentWalkablePosition(targetPos, playerPos) {
    if (!targetPos || !playerPos) return null;
    const offsets = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];
    offsets.sort((a, b) => {
      const da = Math.abs(targetPos.x + a.x - playerPos.x) + Math.abs(targetPos.y + a.y - playerPos.y);
      const db = Math.abs(targetPos.x + b.x - playerPos.x) + Math.abs(targetPos.y + b.y - playerPos.y);
      return da - db;
    });
    for (const off of offsets) {
      const pos = new Position(targetPos.x + off.x, targetPos.y + off.y, targetPos.z);
      const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
      if (tile?.isWalkable?.()) return normalizePosition(pos);
    }
    return null;
  }

  function isRopeItem(item) {
    const name = getThingName(item);
    return !!name && ropeNamePattern.test(name);
  }
  function isShovelItem(item) {
    const name = getThingName(item);
    return !!name && shovelNamePattern.test(name);
  }

  function findToolSource(predicate) {
    const eq = getEquipment();
    if (eq?.slots) {
      for (let i = 0; i < eq.slots.length; i++) {
        const item = eq.getSlotItem?.(i);
        if (predicate(item)) return { which: eq, index: i, item, location: "equipment" };
      }
    }
    for (const container of getOpenContainers()) {
      const slots = container?.slots || [];
      for (let i = 0; i < slots.length; i++) {
        const item = container.getSlotItem?.(i);
        if (predicate(item)) return { which: container, index: i, item, location: "container" };
      }
    }
    return null;
  }

  function findRopeSource() { return findToolSource(isRopeItem); }
  function findShovelSource() { return findToolSource(isShovelItem); }

  function useToolOnTile(tool, targetTile, targetPosition, actionLabel, now = Date.now()) {
    if (!tool || !targetTile || !targetPosition) return false;
    const playerPos = normalizePosition(bot.getPlayerPosition());
    if (!playerPos) return false;
    if (!isAdjacentTile(playerPos, targetPosition)) {
      const adj = findAdjacentWalkablePosition(targetPosition, playerPos);
      if (adj) return goToPosition(adj);
    }
    window.gameClient?.mouse?.__handleItemUseWith?.(
      { which: tool.which, index: tool.index },
      { which: targetTile, index: 0xFF }
    );
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(targetPosition);
    bot.log(actionLabel, { source: targetPosition, toolLocation: tool.location, toolSlot: tool.index, toolName: getThingName(tool.item) });
    return true;
  }

  function useRopeOnTile(targetTile, targetPosition, now) {
    return useToolOnTile(findRopeSource(), targetTile, targetPosition, "cave roped transition tile", now);
  }
  function useShovelOnTile(targetTile, targetPosition, now) {
    return useToolOnTile(findShovelSource(), targetTile, targetPosition, "cave shoveled transition tile", now);
  }

  function useFloorChangeTile(target, waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    const targetPos = normalizePosition(target?.position);
    const targetTile = target?.tile || (targetPos ? getTileAt(targetPos) : null);
    if (!position || !targetPos || !targetTile) return false;
    if (now - state.lastStairsUseAt < 1200) return true;

    if (waypoint?.z < position.z && isRopeTargetTile(targetTile)) {
      return useRopeOnTile(targetTile, targetPos, now);
    }
    if (!isFloorChangeTile(targetTile)) {
      if (waypoint?.z > position.z && isShovelTargetTile(targetTile)) {
        return useShovelOnTile(targetTile, targetPos, now);
      }
      return false;
    }
    if (isLadderTile(targetTile)) {
      window.gameClient?.mouse?.use?.({ which: targetTile, index: 0xFF });
      state.lastStairsUseAt = now;
      state.lastPathAt = now;
      markPendingTransitionSource(targetPos);
      bot.log("cave used ladder tile", { source: targetPos, targetZ: waypoint?.z ?? null });
      return true;
    }
    if (!isSameTile(position, targetPos)) return goToPosition(targetPos);
    const curTile = getTileAt(position);
    if (!curTile || !isFloorChangeTile(curTile)) return false;
    window.gameClient?.mouse?.use?.({ which: curTile, index: 0xFF });
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(position);
    bot.log("cave used floor-change tile", { source: position, targetZ: waypoint?.z ?? null });
    return true;
  }

  function handleFloorChange(waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position || !waypoint || position.z === waypoint.z) return false;
    const visible = findNearbyTransitionTile(position, waypoint);
    if (visible) {
      const moved = useFloorChangeTile(visible, waypoint, now);
      if (moved) {
        bot.log("cave probing visible floor-change tile", {
          tileX: visible.position.x, tileY: visible.position.y, tileZ: visible.position.z,
          targetZ: waypoint.z,
        });
        return true;
      }
    }
    const known = findBestKnownTransition(position, waypoint);
    if (known) {
      const target = { tile: getTileAt(known.from), position: known.from };
      const moved = useFloorChangeTile(target, waypoint, now);
      if (moved) {
        bot.log("cave using learned floor transition", { from: known.from, to: known.to, waypoint });
        return true;
      }
      bot.log("cave learned transition unavailable, falling back to live scan", { from: known.from, to: known.to, waypoint });
    }
    return false;
  }

  // ---- WAYPOINT NAVIGATION ----
  function advanceWaypoint() {
    if (!route.length) return null;
    if (route.length === 1) return route[0];
    let next = state.currentIndex + state.direction;
    if (next >= route.length) {
      if (config.loopMode) {
        next = 0;
      } else {
        state.direction = -1;
        next = route.length - 2;
      }
    } else if (next < 0) {
      if (config.loopMode) {
        next = route.length - 1;
      } else {
        state.direction = 1;
        next = 1;
      }
    }
    state.currentIndex = Math.max(0, Math.min(route.length - 1, next));
    state.pathAttemptStart = 0;
    const wp = getCurrentWaypoint();
    bot.log("cave advanced waypoint", { index: state.currentIndex + 1, total: route.length, direction: state.direction, waypoint: wp });
    return wp;
  }

  // ---- MAIN LOOP ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }

  /**
   * The main cave tick: observes position, pauses for combat, checks waypoint
   * proximity, handles floor changes, and repaths. Includes a guarded skip
   * logic that waits for pathfinder to give up (__finalDestination === null)
   * and for a time threshold before skipping.
   */
  function tick() {
    if (!state.running) return;

    try {
      observePosition();

      if (!route.length) {
        stop();
        return;
      }

      const position = normalizePosition(bot.getPlayerPosition());
      const positionKey = getPositionKey(position);
      const now = Date.now();
      const attackStatus = bot.attack?.status?.() || null;
      const shouldPauseForCombat =
        !!attackStatus?.combatActive &&
        Number(attackStatus?.combatDurationMs || 0) < 60000;

      if (shouldPauseForCombat) {
        if (!state.pausedForCombat) {
          state.pausedForCombat = true;
          bot.log("cave paused for auto attack", {
            combatDurationMs: Number(attackStatus?.combatDurationMs || 0),
            targetCount: Number(attackStatus?.targetCount || 0),
          });
        }
        return;
      }

      if (state.pausedForCombat) {
        state.pausedForCombat = false;
        bot.log("cave resumed after auto attack", {
          combatDurationMs: Number(attackStatus?.combatDurationMs || 0),
          targetCount: Number(attackStatus?.targetCount || 0),
        });
      }

      if (positionKey && positionKey !== state.lastPositionKey) {
        state.lastPositionKey = positionKey;
        state.lastProgressAt = now;
      }

      let waypoint = getCurrentWaypoint();
      if (!waypoint) {
        stop();
        return;
      }

      // Check if we are at waypoint
      if (isAtWaypoint(position, waypoint)) {
        state.lastWaypointTarget = null;
        state.pathAttemptStart = 0;
        waypoint = advanceWaypoint();
        if (!waypoint) {
          stop();
          return;
        }
        state.lastWaypointTarget = waypoint;
        state.pathAttemptStart = now;
        goToWaypoint(waypoint);
        return;
      }

      // Handle floor change if needed (do NOT skip floor-change waypoints)
      if (position && waypoint.z !== position.z) {
        state.lastWaypointTarget = null;
        state.pathAttemptStart = 0;
        handleFloorChange(waypoint, now);
        return;
      }

      // --- Pathfinder skip logic (only if on the same floor) ---
      const pf = window.gameClient?.world?.pathfinder;

      // If pathfinder is still searching, wait
      if (pf && (pf.__isProcessing || pf.__isMinimapSearching)) {
        return;
      }

      // If we haven't set a target waypoint yet, set it now
      if (state.lastWaypointTarget === null || !isSameTile(state.lastWaypointTarget, waypoint)) {
        state.lastWaypointTarget = waypoint;
        state.pathAttemptStart = now;
        goToWaypoint(waypoint);
        return;
      }

      // Check if we should skip this waypoint
      if (state.lastWaypointTarget && position && pf) {
        const dist = getDistanceToWaypoint(position, state.lastWaypointTarget);
        if (dist !== null && dist > (config.waypointTolerance || 0)) {
          const timeSinceLastPath = now - state.lastPathAt;
          const timeSinceAttemptStart = now - state.pathAttemptStart;
          // Only skip if we haven't sent a path in 5 seconds,
          // have been trying for 5 seconds, and pf has no destination.
          if (timeSinceLastPath > 5000 && timeSinceAttemptStart > 5000 && pf.__finalDestination === null) {
            bot.log("Pathfinder gave up, skipping to next waypoint", {
              waypoint: state.lastWaypointTarget,
              timeSinceLastPath,
              timeSinceAttemptStart,
            });
            state.lastWaypointTarget = null;
            state.pathAttemptStart = 0;
            const nextWp = advanceWaypoint();
            if (nextWp) goToWaypoint(nextWp);
            else stop();
            return;
          }
        } else {
          // We reached the waypoint – clear target
          state.lastWaypointTarget = null;
          state.pathAttemptStart = 0;
        }
      }

      // Repath if needed
      const shouldRepath = now - state.lastPathAt >= config.repathMs ||
                           !state.lastProgressAt ||
                           now - state.lastProgressAt >= config.repathMs;
      if (shouldRepath) {
        goToWaypoint(waypoint);
      }
    } catch (error) {
      bot.log("cave tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  // ---- OBSERVER (learn transitions in background) ----
  function startObserver() {
    if (state.observerTimerId != null) return;
    state.observerTimerId = window.setInterval(() => {
      try { observePosition(); } catch (e) { bot.log("cave observer failed", e?.message || e); }
    }, 200);
  }

  function stopObserver() {
    if (state.observerTimerId == null) return;
    window.clearInterval(state.observerTimerId);
    state.observerTimerId = null;
  }

  // ---- PUBLIC API ----
  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();
    if (!route.length) { bot.log("cave bot cannot start without waypoints"); return false; }
    if (state.running) { bot.log("cave bot already running"); return false; }
    const pos = normalizePosition(bot.getPlayerPosition());
    state.running = true;
    state.currentIndex = findClosestWaypointIndex(pos);
    state.direction = state.currentIndex >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) state.direction = 1;
    state.lastPathAt = 0;
    state.lastPositionKey = getPositionKey(pos);
    state.lastProgressAt = Date.now();
    state.pausedForCombat = false;
    state.pathAttemptStart = 0;
    bot.log("cave bot started", {
      waypoints: route.length,
      currentIndex: state.currentIndex + 1,
      direction: state.direction,
      waypoint: getCurrentWaypoint(),
    });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    state.pausedForCombat = false;
    bot.log("cave bot stopped");
    return true;
  }

  function addWaypoint(waypoint) {
    const norm = normalizeWaypoint(waypoint);
    if (!norm) return null;
    route.push(norm);
    persistRoute();
    bot.log("cave waypoint added", { ...norm, total: route.length });
    return cloneValue(norm);
  }

  function addWaypointCurrentSpot() {
    const pos = normalizePosition(bot.getPlayerPosition());
    if (!pos) { bot.log("could not read current position for cave waypoint"); return null; }
    return addWaypoint(pos);
  }

  function clearWaypoints() {
    route = [];
    state.currentIndex = 0;
    state.direction = 1;
    persistRoute();
    bot.log("cave route cleared");
    if (state.running) stop();
    return [];
  }

  function clearTransitions() {
    transitions = [];
    state.pendingTransitionSource = null;
    persistTransitions();
    bot.log("cave learned transitions cleared");
    return [];
  }

  function removeLastWaypoint() {
    if (!route.length) return null;
    const removed = route.pop();
    if (state.currentIndex >= route.length) state.currentIndex = Math.max(0, route.length - 1);
    if (route.length <= 1) state.direction = 1;
    persistRoute();
    bot.log("cave waypoint removed", removed);
    if (!route.length && state.running) stop();
    return removed;
  }

  function setCurrentIndex(index) {
    if (!route.length) { state.currentIndex = 0; state.direction = 1; return 0; }
    const next = Math.max(0, Math.min(route.length - 1, Math.trunc(Number(index) || 0)));
    state.currentIndex = next;
    state.direction = next >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) state.direction = 1;
    return state.currentIndex;
  }

  function status() {
    const pos = normalizePosition(bot.getPlayerPosition());
    const wp = getCurrentWaypoint();
    return {
      running: state.running,
      config: { ...config },
      route: getRoute(),
      transitions: getTransitions(),
      presetNames: getPresetNames(),
      activePresetName: getActivePresetName(),
      currentIndex: state.currentIndex,
      direction: state.direction,
      currentWaypoint: cloneValue(wp),
      distanceToWaypoint: getDistanceToWaypoint(pos, wp),
      lastPathAt: state.lastPathAt,
      lastProgressAt: state.lastProgressAt,
      pendingTransitionSource: cloneValue(state.pendingTransitionSource),
      pausedForCombat: state.pausedForCombat,
    };
  }

  function updateConfig(nextConfig = {}) {
    Object.assign(config, nextConfig);
    config.tickMs = 500;
    persistConfig();
    bot.log("cave config updated", { ...config });
    return { ...config };
  }

  // ---- WAYPOINT REORDER/DELETE ----
  function moveWaypointUp(index) {
    if (!route.length || index <= 0 || index >= route.length) return false;
    const temp = route[index];
    route[index] = route[index - 1];
    route[index - 1] = temp;
    if (state.currentIndex === index) state.currentIndex = index - 1;
    else if (state.currentIndex === index - 1) state.currentIndex = index;
    persistRoute();
    return true;
  }

  function moveWaypointDown(index) {
    if (!route.length || index < 0 || index >= route.length - 1) return false;
    const temp = route[index];
    route[index] = route[index + 1];
    route[index + 1] = temp;
    if (state.currentIndex === index) state.currentIndex = index + 1;
    else if (state.currentIndex === index + 1) state.currentIndex = index;
    persistRoute();
    return true;
  }

  function deleteWaypoint(index) {
    if (!route.length || index < 0 || index >= route.length) return false;
    route.splice(index, 1);
    if (state.currentIndex >= route.length) state.currentIndex = Math.max(0, route.length - 1);
    if (route.length === 0) {
      state.currentIndex = 0; state.direction = 1;
      if (state.running) stop();
    }
    persistRoute();
    return true;
  }

  function setLoopMode(enabled) {
    config.loopMode = !!enabled;
    persistConfig();
    bot.log("cave loop mode set", { loopMode: config.loopMode });
    return config.loopMode;
  }

  function getLoopMode() { return config.loopMode; }

  // ---- INSPECT NEARBY TILES (debug) ----
  function inspectNearbyTiles(radius = 1) {
    const pos = normalizePosition(bot.getPlayerPosition());
    if (!pos) return [];
    return getLoadedTiles()
      .map(t => ({ tile: t, position: getTilePosition(t) }))
      .filter(e => e.position && e.position.z === pos.z &&
        Math.abs(e.position.x - pos.x) <= radius &&
        Math.abs(e.position.y - pos.y) <= radius)
      .map(e => ({
        position: e.position,
        isFloorChange: isFloorChangeTile(e.tile),
        isHole: isHoleTile(e.tile),
        isRopeTarget: isRopeTargetTile(e.tile),
        isShovelTarget: isShovelTargetTile(e.tile),
        names: getTileThings(e.tile).map(t => getThingName(t)).filter(Boolean),
      }));
  }

  // ---- STARTUP ----
  startObserver();
  bot.addCleanup(stopObserver);
  startMinimapOverlay();
  bot.addCleanup(stopMinimapOverlay);
  if (config.enabled && route.length) start();

  bot.cave = {
    start, stop, status, updateConfig, config,
    getRoute, getTransitions, getPresetNames, getActivePresetName, getCurrentWaypoint,
    createPreset, savePreset, loadPreset, deletePreset,
    addWaypoint, addWaypointCurrentSpot, clearWaypoints, clearTransitions,
    removeLastWaypoint, setCurrentIndex,
    goToWaypoint, goToPosition, handleFloorChange,
    findClosestWaypointIndex, findRopeSource, findShovelSource,
    moveWaypointUp, moveWaypointDown, deleteWaypoint,
    setLoopMode, getLoopMode,
    inspectNearbyTiles,
    isAtWaypoint,
  };
};

/**
 * ==================================================================================
 * 11. EQUIP RING MODULE
 *     Finds a ring in equipment or open containers and equips it to the ring slot.
 * ==================================================================================
 */
window.__minibiaBotBundle.installEquipRingModule = function installEquipRingModule(bot) {
  const configStorageKey = "minibiaBot.equipRing.config";
  const RING_SLOT = 8;
  const state = { running: false, timerId: null, lastEquipAt: 0 };
  let resumeListenersAttached = false;

  const config = Object.assign(
    { tickMs: 1000, equipCooldownMs: 1500, enabled: false },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 1000;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function getEquipment() { return window.gameClient?.player?.equipment || null; }
  function getOpenContainers() { return Array.from(window.gameClient?.player?.__openedContainers || []); }

  function getItemDefinition(item) {
    if (!item) return null;
    return window.gameClient?.itemDefinitionsBySid?.[item.sid] ||
           window.gameClient?.itemDefinitions?.[item.id] || null;
  }

  function getItemName(item) {
    const def = getItemDefinition(item);
    return def?.properties?.name || item?.name || "";
  }

  function isRingItem(item) {
    if (!item) return false;
    const def = getItemDefinition(item);
    const slotType = String(def?.properties?.slotType || def?.properties?.slot || "").trim().toLowerCase();
    if (slotType === "ring") return true;
    return /\bring\b/i.test(getItemName(item));
  }

  function getEquippedRing() {
    const eq = getEquipment();
    return eq?.getSlotItem?.(RING_SLOT) || null;
  }
  function hasEquippedRing() { return !!getEquippedRing(); }

  function findBestRingSource() {
    const eq = getEquipment();
    if (!eq) return null;
    let best = null, bestCount = -1;
    const consider = (container, slotIndex, item) => {
      if (!isRingItem(item)) return;
      const count = (typeof item.getCount === "function" ? item.getCount() : item.count) || 1;
      if (count > bestCount) { bestCount = count; best = { container, slotIndex, item, count, name: getItemName(item) }; }
    };
    for (let i = 0; i < eq.slots.length; i++) {
      if (i === RING_SLOT) continue;
      consider(eq, i, eq.getSlotItem(i));
    }
    getOpenContainers().forEach(container => {
      (container?.slots || []).forEach((slot, i) => {
        consider(container, i, container.getSlotItem(i));
      });
    });
    return best;
  }

  function getGateStatus(now = Date.now()) {
    const eq = getEquipment();
    const source = findBestRingSource();
    const cd = Math.max(0, config.equipCooldownMs - (now - state.lastEquipAt));
    return {
      hasEquipment: !!eq,
      hasRingEquipped: hasEquippedRing(),
      hasRingAvailable: !!source,
      cooldownReady: cd === 0,
      cooldownRemainingMs: cd,
      source,
      canEquip: !!eq && !hasEquippedRing() && !!source && cd === 0,
    };
  }

  function canEquipRing(now) { return getGateStatus(now).canEquip; }
  function tryEquipRing(now = Date.now()) {
    if (!config.enabled || !canEquipRing(now)) return false;
    const eq = getEquipment();
    const source = findBestRingSource();
    if (!eq || !source) return false;
    const from = { which: source.container, index: source.slotIndex };
    const to = { which: eq, index: RING_SLOT };
    const count = source.count || 1;
    window.gameClient.send(new ItemMovePacket(from, to, count));
    state.lastEquipAt = now;
    bot.log("equipped ring", { name: source.name, fromContainerId: source.container?.__containerId ?? null, fromSlot: source.slotIndex });
    return true;
  }

  // ---- Resume listeners (boilerplate) ----
  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }
  function runImmediateTick() {
    if (!state.running) return;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    tick();
  }
  function handleResume() { if (!document.hidden) runImmediateTick(); }

  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }
  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;
    try { tryEquipRing(); } catch (e) { bot.log("equip ring tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 1000;
    persistConfig();
    if (state.running) { bot.log("equip ring already running"); return false; }
    state.running = true;
    attachResumeListeners();
    bot.log("equip ring started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    detachResumeListeners();
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    bot.log("equip ring stopped");
    return true;
  }

  function status() {
    return {
      running: state.running,
      config: { ...config },
      gates: getGateStatus(),
      equippedRing: getEquippedRing(),
      lastEquipAt: state.lastEquipAt,
    };
  }

  function updateConfig(nextConfig = {}) {
    Object.assign(config, nextConfig);
    config.tickMs = 1000;
    persistConfig();
    bot.log("equip ring config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.equipRing = {
    start, stop, status, updateConfig,
    config,
    getEquippedRing, hasEquippedRing,
    findBestRingSource, getGateStatus, canEquipRing, tryEquipRing,
  };
};

/**
 * ==================================================================================
 * 12. AUTO EAT MODULE
 *     Uses a hotbar slot when the food timer reaches 0 (or no SATED condition).
 * ==================================================================================
 */
window.__minibiaBotBundle.installAutoEatModule = function installAutoEatModule(bot) {
  const configStorageKey = "minibiaBot.eat.config";
  const state = { running: false, timerId: null, lastFoodAt: 0 };

  const config = Object.assign(
    {
      tickMs: 1000,
      eatCooldownMs: 60000,
      eatHotbarSlot: 10,
      enabled: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 1000;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeHotbarSlot(slot) {
    const v = Number(slot);
    if (!Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < 1 || n > 12) return null;
    return n;
  }

  function readFoodTimer() {
    const text = document.querySelector('#skill-window div[skill="food"] .skill')?.textContent?.trim() || null;
    if (!text) return null;
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    return match ? { text, seconds: Number(match[1]) * 60 + Number(match[2]) } : { text, seconds: null };
  }

  function isSated() {
    const player = window.gameClient?.player;
    const conditions = player?.conditions;
    if (conditions?.has && conditions.SATED != null) return conditions.has(conditions.SATED);
    const food = readFoodTimer();
    if (food?.seconds != null) return food.seconds > 0;
    return true;
  }

  function tryEat() {
    if (!config.enabled) return false;
    if (isSated()) return false;
    if (Date.now() - state.lastFoodAt < config.eatCooldownMs) return false;
    const slot = normalizeHotbarSlot(config.eatHotbarSlot);
    if (!slot) return false;
    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      state.lastFoodAt = Date.now();
      bot.log("used eat hotkey", { slot });
    }
    return clicked;
  }

  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(() => tick(), config.tickMs);
  }

  function tick() {
    if (!state.running) return;
    try { tryEat(); } catch (e) { bot.log("auto eat tick failed", e?.message || e); }
    finally { scheduleNextTick(); }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 1000;
    persistConfig();
    if (state.running) { bot.log("auto eat already running"); return false; }
    state.running = true;
    bot.log("auto eat started", { eatCooldownMs: config.eatCooldownMs, eatHotbarSlot: config.eatHotbarSlot });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    bot.log("auto eat stopped");
    return true;
  }

  function status() {
    return {
      running: state.running,
      config: { ...config },
      lastFoodAt: state.lastFoodAt,
      isSated: isSated(),
    };
  }

  function updateConfig(nextConfig = {}) {
    if (nextConfig.eatHotbarSlot !== undefined) {
      nextConfig.eatHotbarSlot = normalizeHotbarSlot(nextConfig.eatHotbarSlot) ?? config.eatHotbarSlot;
    }
    if (nextConfig.eatCooldownMs !== undefined) {
      nextConfig.eatCooldownMs = Math.max(0, Number(nextConfig.eatCooldownMs) || 0);
    }
    Object.assign(config, nextConfig);
    config.tickMs = 1000;
    persistConfig();
    bot.log("auto eat config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) start();

  bot.eat = {
    start, stop, status, updateConfig,
    isSated, tryEat, normalizeHotbarSlot,
    config,
  };
  bot.startAutoEat = start;
  bot.stopAutoEat = stop;
  if (bot.rune) {
    bot.rune.startAutoEat = start;
    bot.rune.stopAutoEat = stop;
    bot.rune.tryEat = tryEat;
    bot.rune.isSated = isSated;
  }
};

/**
 * ==================================================================================
 * 13. TALK MODULE
 *     Uses Gemini API to reply to chat messages in the "Default" channel.
 *     Classifies messages as greeting, question, or statement and generates a
 *     short, casual reply. Supports ignoring specific phrases.
 * ==================================================================================
 */
window.__minibiaBotBundle.installTalkModule = function installTalkModule(bot) {
  const configStorageKey = "minibiaBot.talk.config";
  const legacyDefaultModels = ["gemini-3-pro-preview", "gemini-2.0-flash"];
  const defaultModel = "gemini-2.5-flash-lite";
  const defaultSystemPrompt =
    "You are a normal Tibia MMORPG player chatting in Minibia in live in-game chat. " +
    "Every reply must sound like Tibia player chat: casual, brief, informal, fully lowercase, " +
    "and natural for a real player typing quickly. Use plain text only. Keep it under 90 characters " +
    "and under 12 words. Prefer short Tibia-style phrasing, light slang, abbreviations, " +
    "and simple punctuation when natural. Avoid polished grammar, title case, or assistant-like wording. " +
    "Write like someone typing mid-hunt or while afk for a sec. Never say you are a bot or AI.";
  const defaultGreetingPrompt =
    "Respond to greetings like a Tibia MMORPG player in chat. Be short, casual, friendly, " +
    "and in-character for fast Tibia-style game chat. Use lowercase. One sentence only. Plain text only.";
  const defaultQuestionPrompt =
    "Respond to questions like a Tibia MMORPG player in chat, but stay vague and noncommittal. " +
    "Keep it brief, casual, and a little evasive. Use lowercase and do not explain much. " +
    "One short sentence only. Plain text only. If asked whether you are a bot, reply with no.";
  const defaultStatementPrompt =
    "Respond to statements like a Tibia MMORPG player in chat. Keep it short, casual, reactive, " +
    "and natural for live Tibia-style game chat. Use lowercase. One sentence only. Plain text only.";

  const minPollMs = 1000;
  const maxMessageAgeMs = 2 * 60 * 1000;

  const state = {
    running: false,
    pending: false,
    timerId: null,
    lastReplyAt: 0,
    seenKeys: [],
    seenSignatures: [],
  };

  const greetingReplies = ["yo", "sup", "hey", "hiya", "yo lol"];
  const agreeReplies = ["true", "fr", "based", "ya", "real"];
  const vagueQuestionReplies = ["maybe", "not sure", "hard to say", "could be"];
  const denyBotReplies = ["no", "nope", "nah"];

  const config = Object.assign(
    {
      enabled: false,
      apiKey: "",
      model: defaultModel,
      pollMs: minPollMs,
      replyCooldownMs: 1500,
      systemPrompt: defaultSystemPrompt,
      greetingPrompt: defaultGreetingPrompt,
      questionPrompt: defaultQuestionPrompt,
      statementPrompt: defaultStatementPrompt,
      ignoredPhrases: ["munch."],
    },
    bot.storage.get(configStorageKey, {})
  );

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function sanitizeConfig() {
    config.apiKey = String(config.apiKey || "").trim();
    config.model = String(config.model || defaultModel).trim() || defaultModel;
    if (legacyDefaultModels.includes(config.model)) config.model = defaultModel;
    config.pollMs = Math.max(minPollMs, Number(config.pollMs) || minPollMs);
    config.replyCooldownMs = Math.max(0, Number(config.replyCooldownMs) || 1500);
    config.systemPrompt = String(config.systemPrompt || defaultSystemPrompt).trim() || defaultSystemPrompt;
    config.greetingPrompt = String(config.greetingPrompt || defaultGreetingPrompt).trim() || defaultGreetingPrompt;
    config.questionPrompt = String(config.questionPrompt || defaultQuestionPrompt).trim() || defaultQuestionPrompt;
    config.statementPrompt = String(config.statementPrompt || defaultStatementPrompt).trim() || defaultStatementPrompt;
    config.ignoredPhrases = Array.isArray(config.ignoredPhrases)
      ? config.ignoredPhrases.map(p => String(p).trim().toLowerCase()).filter(Boolean)
      : [];
  }

  function trimSeen() {
    const maxSeen = 200;
    if (state.seenKeys.length > maxSeen) state.seenKeys = state.seenKeys.slice(-maxSeen);
    if (state.seenSignatures.length > maxSeen) state.seenSignatures = state.seenSignatures.slice(-maxSeen);
  }

  function getSelfNames() {
    return new Set(["you", bot.getPlayerName?.(), window.gameClient?.player?.name, window.gameClient?.player?.state?.name]
      .map(n => normalizeText(n)).filter(Boolean));
  }

  function extractSenderFromMessage(message) {
    const text = String(message || "").trim();
    if (!text) return { sender: null, body: "" };
    const patterns = [
      /^\[[^\]]+\]\s*([^:\n]{2,40}):\s+(.+)$/i,
      /^([^:\n]{2,40}):\s+(.+)$/i,
      /^([^:\n]{2,40})\s+says:\s+(.+)$/i,
      /^From\s+([^:\n]{2,40}):\s+(.+)$/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return { sender: String(m[1] || "").trim() || null, body: String(m[2] || "").trim() };
    }
    return { sender: null, body: text };
  }

  function getRawChatEntries() {
    return (window.gameClient?.interface?.channelManager?.channels || [])
      .flatMap(ch => (ch?.__contents || []).map((entry, i) => ({ channelName: ch?.name || null, entry, index: i })));
  }

  function toChatMessage(rawEntry) {
    const entry = rawEntry?.entry || {};
    const raw = String(entry?.message || entry?.text || "").trim();
    const parsed = extractSenderFromMessage(raw);
    const sender = String(entry?.author || entry?.sender || entry?.name || parsed.sender || "").trim() || null;
    const body = String(entry?.text || parsed.body || raw).trim();
    const time = entry?.__time || entry?.time || null;
    const senderType = entry?.type;
    const key = [rawEntry?.channelName || "", time || "", sender || "", raw || "", rawEntry?.index || 0].join("|");
    return { key, channelName: rawEntry?.channelName || null, sender, body, rawMessage: raw, time, senderType };
  }

  function getChatMessages() {
    return getRawChatEntries().map(toChatMessage).filter(m => m.body);
  }

  function getMessageTimestamp(message) {
    const raw = message?.time;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
    if (raw instanceof Date) return raw.getTime();
    const parsed = Date.parse(String(raw || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getMessageSignature(message) {
    return [
      normalizeText(message?.channelName),
      normalizeText(message?.sender),
      normalizeText(message?.body || message?.rawMessage),
      String(getMessageTimestamp(message) || ""),
    ].join("|");
  }

  function hasSeenMessage(message) {
    return state.seenKeys.includes(message?.key) || state.seenSignatures.includes(getMessageSignature(message));
  }

  function rememberSeenMessage(message) {
    if (!message) return;
    if (message.key && !state.seenKeys.includes(message.key)) state.seenKeys.push(message.key);
    const sig = getMessageSignature(message);
    if (sig && !state.seenSignatures.includes(sig)) state.seenSignatures.push(sig);
    trimSeen();
  }

  function rememberSeenMessages(messages) {
    messages.forEach(m => rememberSeenMessage(m));
  }

  function isSelfMessage(message) {
    if (getSelfNames().has(normalizeText(message?.sender))) return true;
    return [message?.body, message?.rawMessage].some(t => bot.isRecentSentChat?.(t, 20000));
  }

  function isTrustedSender(message) {
    const name = normalizeText(message?.sender);
    if (!name) return false;
    const trusted = bot.panic?.getTrustedNames?.() || [];
    return trusted.includes(name);
  }

  function isNpcMessage(message) {
    const npcType = window.CONST?.TYPES?.NPC;
    return npcType != null && message?.senderType === npcType;
  }

  function isWithinVisibleRange(me, pos) {
    if (!me || !pos) return false;
    const dx = Math.abs(pos.x - me.x), dy = Math.abs(pos.y - me.y);
    return dx <= 8 && dy <= 6;
  }

  function isSenderVisiblePlayer(message) {
    const me = bot.getPlayerPosition?.();
    const myId = window.gameClient?.player?.id;
    const sender = normalizeText(message?.sender);
    const playerType = window.CONST?.TYPES?.PLAYER;
    if (!me || !sender || playerType == null) return false;
    return Object.values(window.gameClient?.world?.activeCreatures || {}).some(creature => {
      if (!creature || creature.id === myId || creature.type !== playerType) return false;
      if (normalizeText(creature.name) !== sender) return false;
      return isWithinVisibleRange(me, creature.__position);
    });
  }

  function getDefaultMessages() {
    return getChatMessages().filter(m => m.channelName === "Default");
  }

  function getNewestPendingMessage() {
    const pending = getDefaultMessages().filter(message => {
      if (!message?.body || !message?.key) return false;
      if (hasSeenMessage(message)) return false;

      // Skip ignored phrases
      const ignored = config.ignoredPhrases || [];
      const bodyLower = message.body.toLowerCase();
      if (ignored.some(p => bodyLower.includes(p))) {
        rememberSeenMessage(message);
        return false;
      }

      if (!message.sender || isSelfMessage(message) || isNpcMessage(message) || isTrustedSender(message)) {
        rememberSeenMessage(message);
        return false;
      }

      const ts = getMessageTimestamp(message);
      if (ts && Date.now() - ts > maxMessageAgeMs) {
        rememberSeenMessage(message);
        return false;
      }
      return true;
    });
    if (!pending.length) return null;
    return { targetMessage: pending[pending.length - 1], pendingMessages: pending };
  }

  function buildClassifierPrompt(targetMessage, contextMessages) {
    const transcript = contextMessages.map(m => `${m.sender || "player"}: ${m.body}`).join("\n");
    return [
      "Channel: Default",
      "Recent chat:", transcript || "(none)", "",
      `Last message from ${targetMessage.sender}: ${targetMessage.body}`,
      "Classify the last message as exactly one label:",
      "greeting", "question", "statement",
      "Reply with the label only.",
    ].join("\n");
  }

  function getTypePrompt(messageType) {
    if (messageType === "greeting") return config.greetingPrompt;
    if (messageType === "question") return config.questionPrompt;
    return config.statementPrompt;
  }

  function buildReplyPrompt(targetMessage, contextMessages, messageType) {
    const transcript = contextMessages.map(m => `${m.sender || "player"}: ${m.body}`).join("\n");
    return [
      config.systemPrompt,
      getTypePrompt(messageType), "",
      "Channel: Default", `Message type: ${messageType}`,
      "Recent chat:", transcript || "(none)", "",
      `Last message from ${targetMessage.sender}: ${targetMessage.body}`,
      "Reply with one short sentence only.",
      "Avoid repeating the same wording again and again.",
      "Reply text only:",
    ].join("\n");
  }

  async function generateText(prompt, generationConfig = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: Object.assign({ temperature: 0.9, topP: 0.95, maxOutputTokens: 40 }, generationConfig),
      }),
    });
    if (!resp.ok) throw new Error(`Gemini request failed (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.map(p => String(p?.text || "")).join(" ").trim() || "";
  }

  async function classifyMessageType(targetMessage, contextMessages) {
    const raw = normalizeText(
      await generateText(buildClassifierPrompt(targetMessage, contextMessages), {
        temperature: 0.1, topP: 0.8, maxOutputTokens: 8,
      })
    );
    if (raw === "greeting" || raw === "question" || raw === "statement") return raw;
    if (isGreeting(targetMessage?.body)) return "greeting";
    if (/\?/.test(String(targetMessage?.body || ""))) return "question";
    return "statement";
  }

  function sanitizeReply(text) {
    const single = String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    if (!single) return "";
    const first = single.split(/(?<=[.!?])\s+/)[0] || single;
    const trimmed = first.slice(0, 90).trim();
    if (!trimmed) return "";
    if (trimmed === "?") return bot.isRecentSentChat?.("?", 20000) ? "" : "?";
    const styled = trimmed
      .toLowerCase()
      .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/\bi am\b/g, "im").replace(/\byou are\b/g, "youre")
      .replace(/\bdo not\b/g, "dont").replace(/\bcannot\b/g, "cant")
      .replace(/\bgoing to\b/g, "gonna").replace(/\bwant to\b/g, "wanna")
      .replace(/\s+([,.!?])/g, "$1").replace(/([!?.,]){2,}/g, "$1")
      .trim();
    if (!styled || /^[^a-z0-9]+$/i.test(styled)) return "";
    if (/\b(bot|ai|assistant|language model|automation|script)\b/i.test(styled)) return "";
    if (bot.isRecentSentChat?.(styled, 20000)) return "";
    return styled;
  }

  function pickUnusedReply(replies, withinMs = 30000, fallback = "?") {
    for (const r of replies) {
      if (!bot.isRecentSentChat?.(r, withinMs)) return r;
    }
    return fallback;
  }

  function isGreeting(text) {
    return /^(hi|hey|yo|sup|howdy|hello|hiya|hey man|hey bro)\b/i.test(String(text || "").trim());
  }

  function isBotQuestion(text) {
    return /\b(are you|u)\b.*\bbot\b|\bbot\b.*\?|\bare you a bot\b/i.test(String(text || ""));
  }

  function isSimpleReaction(text) {
    return /^(XD|true|fr|lol|lmao|xd|nice|ok|kk|k)\b[!.?]*$/i.test(String(text || "").trim());
  }

  function pickFallbackReply(targetMessage, messageType) {
    const msg = String(targetMessage?.body || "").trim();
    if (isBotQuestion(msg)) return pickUnusedReply(denyBotReplies, 30000, "no");
    if (messageType === "greeting" || isGreeting(msg)) return pickUnusedReply(greetingReplies, 15000, "yo");
    if (isSimpleReaction(msg)) return pickUnusedReply(agreeReplies, 15000, "true");
    if (messageType === "question" || /\?$/.test(msg)) return pickUnusedReply(vagueQuestionReplies, 20000, "maybe");
    return pickUnusedReply(["lol", "maybe", "ya", "true", "kinda"], 30000, "lol");
  }

  async function maybeRespond() {
    if (!state.running || state.pending || !config.enabled || !config.apiKey) return false;
    if (Date.now() - state.lastReplyAt < config.replyCooldownMs) return false;
    const pending = getNewestPendingMessage();
    if (!pending?.targetMessage) return false;
    state.pending = true;
    try {
      const context = getDefaultMessages().slice(-6);
      if (!isSenderVisiblePlayer(pending.targetMessage)) {
        rememberSeenMessages(pending.pendingMessages);
        bot.log("talk skipped reply", {
          sender: pending.targetMessage.sender,
          message: pending.targetMessage.body,
          reason: "sender-not-visible",
        });
        return false;
      }
      const type = await classifyMessageType(pending.targetMessage, context);
      const rawReply = isBotQuestion(pending.targetMessage.body)
        ? "no"
        : await generateText(buildReplyPrompt(pending.targetMessage, context, type));
      const reply = sanitizeReply(rawReply) || pickFallbackReply(pending.targetMessage, type);
      rememberSeenMessages(pending.pendingMessages);
      if (!reply) {
        bot.log("talk skipped reply", { sender: pending.targetMessage.sender, message: pending.targetMessage.body, messageType: type, rawReply });
        return false;
      }
      const sent = bot.sendChat(reply);
      if (sent) {
        state.lastReplyAt = Date.now();
        bot.log("talk replied", { sender: pending.targetMessage.sender, message: pending.targetMessage.body, messageType: type, reply });
      }
      return sent;
    } finally {
      state.pending = false;
    }
  }

  function scheduleNextTick() {
    if (!state.running) return;
    state.timerId = window.setTimeout(async () => {
      try { await maybeRespond(); } catch (e) { bot.log("talk request failed", e?.message || e); }
      scheduleNextTick();
    }, config.pollMs);
  }

  function seedSeenMessages() {
    rememberSeenMessages(getDefaultMessages());
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    sanitizeConfig();
    persistConfig();
    if (!config.apiKey) { bot.log("talk module requires a Gemini API key"); return false; }
    if (state.running) return false;
    state.running = true;
    seedSeenMessages();
    bot.log("talk module started", { model: config.model, channel: "Default" });
    scheduleNextTick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersist = options.persistEnabled !== false;
    state.running = false;
    if (shouldPersist) { config.enabled = false; persistConfig(); }
    if (state.timerId != null) { window.clearTimeout(state.timerId); state.timerId = null; }
    return true;
  }

  function status() {
    return {
      running: state.running,
      pending: state.pending,
      lastReplyAt: state.lastReplyAt,
      config: { ...config, apiKey: config.apiKey ? "***configured***" : "" },
    };
  }

  function updateConfig(nextConfig = {}) {
    Object.assign(config, nextConfig);
    sanitizeConfig();
    persistConfig();
    return status().config;
  }

  sanitizeConfig();
  if (config.enabled && config.apiKey) start();

  bot.talk = {
    start, stop, status, updateConfig,
    getChatMessages, config,
  };
};

/**
 * ==================================================================================
 * 14. UI PANEL
 *     Injects a draggable, collapsible panel with tabs for each module.
 *     Provides real‑time controls, status indicators, and refresh functions.
 * ==================================================================================
 */
window.__minibiaBotBundle.installPanel = function installPanel(bot) {
  const panelPositionKey = "minibiaBot.ui.panelPosition";
  const panelCollapsedKey = "minibiaBot.ui.panelCollapsed";

  // ---- UTILITY FUNCTIONS ----
  function destroy() {
    document.getElementById("minibia-bot-panel")?.remove();
    document.getElementById("minibia-bot-style")?.remove();
  }

  function parsePreferredTargetNames(value) {
    return String(value || "")
      .split(/[\n,]/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter((name, idx, arr) => arr.findIndex(o => o.toLowerCase() === name.toLowerCase()) === idx);
  }

  // ---- REFRESH FUNCTIONS (tie UI to bot state) ----
  function refreshAutoAttackPreferredStatus(options = {}) {
    const force = options.force === true;
    const input = document.getElementById("minibia-bot-auto-attack-preferred-names");
    const modeSelect = document.getElementById("minibia-bot-auto-attack-preferred-match-mode");
    const statusLabel = document.getElementById("minibia-bot-auto-attack-preferred-status");
    const attackConfig = bot.attack?.status?.().config || bot.attack?.config || {};
    const preferred = Array.isArray(attackConfig.preferredTargetNames) ? attackConfig.preferredTargetNames : [];
    const mode = attackConfig.preferredMatchMode === "includes" ? "includes" : "exact";
    if (input && (force || document.activeElement !== input)) input.value = preferred.join(", ");
    if (modeSelect) modeSelect.value = mode;
    if (statusLabel) {
      const names = preferred.length ? preferred.join(", ") : "none";
      const modeText = mode === "includes" ? "contains text" : "exact name";
      statusLabel.textContent = `Preferred mobs: ${names} | Mode: ${modeText}`;
    }
  }

  function saveAutoAttackPreferredConfig() {
    const input = document.getElementById("minibia-bot-auto-attack-preferred-names");
    const modeSelect = document.getElementById("minibia-bot-auto-attack-preferred-match-mode");
    const preferred = parsePreferredTargetNames(input?.value || "");
    const mode = modeSelect?.value === "includes" ? "includes" : "exact";
    bot.attack?.updateConfig?.({ preferredTargetNames: preferred, preferredMatchMode: mode });
    refreshAutoAttackPreferredStatus({ force: true });
    bot.log?.("auto attack preferred targets updated", { preferredTargetNames: preferred, preferredMatchMode: mode });
  }

  // ---- HEAL UI ----
  let healEditIndex = null;

  function getHealRuleFormValues() {
    const slot = parseInt(document.getElementById("minibia-bot-heal-slot")?.value || "1", 10) || 1;
    const spell = document.getElementById("minibia-bot-heal-spell")?.value.trim() || "";
    const manaCost = parseInt(document.getElementById("minibia-bot-heal-manacost")?.value || "0", 10) || 0;
    const minHp = parseInt(document.getElementById("minibia-bot-heal-minhp")?.value || "0", 10) || 0;
    const maxHp = parseInt(document.getElementById("minibia-bot-heal-maxhp")?.value || "100", 10) || 100;
    const minMana = parseInt(document.getElementById("minibia-bot-heal-minmana")?.value || "0", 10) || 0;
    const maxMana = parseInt(document.getElementById("minibia-bot-heal-maxmana")?.value || "100", 10) || 100;
    return { slot, spellWords: spell, manaCost, minHp, maxHp, minMana, maxMana };
  }

  function setHealRuleFormValues(rule) {
    document.getElementById("minibia-bot-heal-slot").value = rule.slot || 1;
    document.getElementById("minibia-bot-heal-spell").value = rule.spellWords || "";
    document.getElementById("minibia-bot-heal-manacost").value = rule.manaCost || 0;
    document.getElementById("minibia-bot-heal-minhp").value = rule.minHpPercent ?? 0;
    document.getElementById("minibia-bot-heal-maxhp").value = rule.maxHpPercent ?? 100;
    document.getElementById("minibia-bot-heal-minmana").value = rule.minManaPercent ?? 0;
    document.getElementById("minibia-bot-heal-maxmana").value = rule.maxManaPercent ?? 100;
  }

  function clearHealRuleForm() {
    document.getElementById("minibia-bot-heal-slot").value = "1";
    document.getElementById("minibia-bot-heal-spell").value = "";
    document.getElementById("minibia-bot-heal-manacost").value = "0";
    document.getElementById("minibia-bot-heal-minhp").value = "0";
    document.getElementById("minibia-bot-heal-maxhp").value = "100";
    document.getElementById("minibia-bot-heal-minmana").value = "0";
    document.getElementById("minibia-bot-heal-maxmana").value = "100";
    document.getElementById("minibia-bot-heal-save").textContent = "Add Rule";
    healEditIndex = null;
  }

  function refreshHealRules() {
    const list = document.getElementById("minibia-bot-heal-rules-list");
    if (!list) return;
    const rules = bot.heal?.config?.healRules || [];
    list.innerHTML = "";
    if (!rules.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "No heal rules configured.";
      list.appendChild(empty);
      return;
    }
    rules.forEach((rule, index) => {
      const row = document.createElement("div");
      row.className = "mb-list-row";
      row.style.cssText = "display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);";
      const info = document.createElement("div");
      info.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px;";
      const slotLabel = document.createElement("span");
      slotLabel.textContent = `Slot ${rule.slot}`;
      slotLabel.style.cssText = "font-weight:bold;color:#d4c48a;";
      info.appendChild(slotLabel);
      if (rule.spellWords) {
        const spell = document.createElement("span");
        spell.textContent = `"${rule.spellWords}"`;
        spell.style.cssText = "color:#aad4ff;";
        info.appendChild(spell);
        if (rule.manaCost > 0) {
          const cost = document.createElement("span");
          cost.textContent = `(${rule.manaCost} MP)`;
          cost.style.cssText = "opacity:0.7;";
          info.appendChild(cost);
        }
      } else {
        const action = document.createElement("span");
        action.textContent = "(hotkey)";
        action.style.cssText = "opacity:0.6;";
        info.appendChild(action);
      }
      const hp = document.createElement("span");
      hp.textContent = `HP ${rule.minHpPercent}‑${rule.maxHpPercent}%`;
      hp.style.cssText = "background:#2a1a1a;padding:0 4px;border-radius:3px;color:#ffb0b0;";
      info.appendChild(hp);
      const mp = document.createElement("span");
      mp.textContent = `MP ${rule.minManaPercent}‑${rule.maxManaPercent}%`;
      mp.style.cssText = "background:#1a1a2a;padding:0 4px;border-radius:3px;color:#b0b0ff;";
      info.appendChild(mp);
      row.appendChild(info);
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "mb-small-button";
      editBtn.textContent = "Edit";
      editBtn.style.cssText = "width:auto;padding:2px 8px;";
      editBtn.addEventListener("click", () => {
        healEditIndex = index;
        setHealRuleFormValues(rule);
        document.getElementById("minibia-bot-heal-save").textContent = "Update Rule";
      });
      row.appendChild(editBtn);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mb-small-button";
      removeBtn.textContent = "\u2715";
      removeBtn.title = "Remove rule";
      removeBtn.style.cssText = "width:24px;padding:2px;background:#5a2020;color:#ff8888;border-color:#883030;";
      removeBtn.addEventListener("click", () => {
        const current = (bot.heal?.config?.healRules || []).slice();
        current.splice(index, 1);
        bot.heal.updateConfig({ healRules: current });
        refreshHealRules();
        refreshAutoHealStatus();
        clearHealRuleForm();
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  function saveHealRule() {
    const values = getHealRuleFormValues();
    if (values.slot < 1 || values.slot > 12) { bot.log("Slot must be 1-12."); return; }
    if (values.minHp < 0 || values.minHp > 100 || values.maxHp < 0 || values.maxHp > 100) { bot.log("HP % must be 0-100."); return; }
    if (values.minHp > values.maxHp) { bot.log("Min HP cannot be greater than Max HP."); return; }
    if (values.minMana < 0 || values.minMana > 100 || values.maxMana < 0 || values.maxMana > 100) { bot.log("MP % must be 0-100."); return; }
    if (values.minMana > values.maxMana) { bot.log("Min MP cannot be greater than Max MP."); return; }
    if (values.spellWords && values.manaCost <= 0) { bot.log("Please enter a Mana Cost for the spell."); return; }
    const newRule = {
      slot: values.slot,
      spellWords: values.spellWords,
      manaCost: values.manaCost,
      minHpPercent: values.minHp,
      maxHpPercent: values.maxHp,
      minManaPercent: values.minMana,
      maxManaPercent: values.maxMana,
    };
    const rules = (bot.heal?.config?.healRules || []).slice();
    if (healEditIndex !== null) rules[healEditIndex] = newRule;
    else rules.push(newRule);
    bot.heal.updateConfig({ healRules: rules });
    refreshHealRules();
    refreshAutoHealStatus();
    clearHealRuleForm();
  }

  function refreshAutoHealStatus() {
    const toggle = document.getElementById("minibia-bot-auto-heal-enabled");
    if (toggle) toggle.checked = !!bot.heal?.status?.().running;
  }

  // ---- AUTO ATTACK STATUS ----
  function refreshAutoAttackStatus() {
    const status = bot.attack?.status?.();
    const attackConfig = status?.config || bot.attack?.config || {};
    const inputs = {
      enabled: document.getElementById("minibia-bot-auto-attack-enabled"),
      melee: document.getElementById("minibia-bot-auto-attack-melee"),
      hotkey: document.getElementById("minibia-bot-auto-attack-hotkey"),
      runeHotkey: document.getElementById("minibia-bot-auto-attack-rune-hotkey"),
      maxDist: document.getElementById("minibia-bot-auto-attack-maxdist"),
      antiKS: document.getElementById("minibia-bot-auto-attack-antiks"),
      antiKSSelf: document.getElementById("minibia-bot-auto-attack-antiks-self"),
      antiKSOther: document.getElementById("minibia-bot-auto-attack-antiks-other"),
    };
    if (inputs.enabled) inputs.enabled.checked = !!status?.running;
    if (inputs.melee) inputs.melee.checked = attackConfig.meleeMode !== false;
    if (inputs.hotkey && document.activeElement !== inputs.hotkey) {
      inputs.hotkey.value = String(attackConfig.targetHotbarSlot ?? 3);
    }
    if (inputs.runeHotkey && document.activeElement !== inputs.runeHotkey) {
      inputs.runeHotkey.value = attackConfig.runeHotbarSlot ? String(attackConfig.runeHotbarSlot) : "";
    }
    if (inputs.maxDist && document.activeElement !== inputs.maxDist) {
      inputs.maxDist.value = attackConfig.maxTargetDistance ?? 5;
    }
    if (inputs.antiKS) inputs.antiKS.checked = attackConfig.antiKSEnabled !== false;
    if (inputs.antiKSSelf && document.activeElement !== inputs.antiKSSelf) {
      inputs.antiKSSelf.value = attackConfig.antiKSSelfRange ?? 2;
    }
    if (inputs.antiKSOther && document.activeElement !== inputs.antiKSOther) {
      inputs.antiKSOther.value = attackConfig.antiKSOtherRange ?? 2;
    }
    refreshAutoAttackPreferredStatus();
    if (typeof refreshTitlebarRunIndicators === "function") refreshTitlebarRunIndicators();
  }

  // ---- PANIC / HOME / XRAY / etc. ----
  function refreshHomeLabel() {
    const label = document.getElementById("minibia-bot-home");
    if (!label) return;
    const home = bot.pz?.getHomePz?.();
    label.textContent = home ? `Panic Runner Home: ${home.x}, ${home.y}, ${home.z}` : "Panic Runner Home: not set";
  }

  function refreshPanicStatus() {
    const status = bot.panic?.status?.();
    const unknown = document.getElementById("minibia-bot-panic-unknown");
    const health = document.getElementById("minibia-bot-panic-health");
    const ret = document.getElementById("minibia-bot-panic-return");
    const alertToggle = document.getElementById("minibia-bot-panic-player-alert");
    const cooldownInput = document.getElementById("minibia-bot-panic-player-cooldown");
    if (unknown) unknown.checked = !!status?.config?.unknownPlayerEnabled;
    if (health) health.checked = !!status?.config?.healthLossEnabled;
    if (ret) ret.checked = !!status?.config?.returnToOriginEnabled;
    if (alertToggle) alertToggle.checked = !!status?.config?.playerAlertEnabled;
    if (cooldownInput && document.activeElement !== cooldownInput) {
      const sec = Math.round((status?.config?.playerAlertCooldownMs || 60000) / 1000);
      cooldownInput.value = sec;
    }
  }

  function refreshXrayStatus() {
    const status = bot.xray?.status?.();
    const me = bot.getPlayerPosition?.();
    const overlayBtn = document.getElementById("minibia-bot-xray-overlay-toggle");
    const overlayLabel = document.getElementById("minibia-bot-xray-overlay-status");
    const floorSelect = document.getElementById("minibia-bot-xray-floor-select");
    if (overlayBtn) overlayBtn.textContent = status?.config?.overlayEnabled ? "Disable Overlay" : "Enable Overlay";
    if (overlayLabel) {
      const floorLabel = status?.config?.selectedFloor == null
        ? "all floors"
        : (me ? (me.z - status.config.selectedFloor) : "?");
      overlayLabel.textContent = `${status?.config?.overlayEnabled ? "Overlay: on" : "Overlay: off"} • ${floorLabel}`;
    }
    if (floorSelect) {
      const floors = Array.from(new Set((status?.visibleCreatures || []).map(c => c?.position?.z).filter(z => z != null)))
        .sort((a,b) => a-b);
      const selected = status?.config?.selectedFloor;
      if (selected != null && !floors.includes(selected)) floors.push(selected);
      floors.sort((a,b) => a-b);
      floorSelect.innerHTML = `<option value="all">All floors</option>`;
      floors.forEach(f => {
        const opt = document.createElement("option");
        opt.value = String(f);
        const offset = me ? me.z - f : 0;
        opt.textContent = offset === 0 ? String(f) : (offset > 0 ? `+${offset}` : `${offset}`);
        floorSelect.appendChild(opt);
      });
      floorSelect.value = selected == null ? "all" : String(selected);
    }
  }

  function renderTrustedNames() {
    const list = document.getElementById("minibia-bot-panic-trusted-list");
    if (!list) return;
    const names = bot.panic?.config?.trustedNames || [];
    list.innerHTML = "";
    if (!names.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "No trusted names saved.";
      list.appendChild(empty);
      return;
    }
    names.forEach((name, idx) => {
      const row = document.createElement("div");
      row.className = "mb-list-row";
      const label = document.createElement("span");
      label.textContent = name;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mb-small-button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        const next = names.filter((_, i) => i !== idx);
        bot.panic.updateConfig({ trustedNames: next });
        renderTrustedNames();
      });
      row.appendChild(label); row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  function renderGameMasterNames() {
    const list = document.getElementById("minibia-bot-panic-gm-list");
    if (!list) return;
    const names = bot.panic?.config?.gameMasterNames || [];
    list.innerHTML = "";
    if (!names.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "No game master names saved.";
      list.appendChild(empty);
      return;
    }
    names.forEach((name, idx) => {
      const row = document.createElement("div");
      row.className = "mb-list-row";
      const label = document.createElement("span");
      label.textContent = name;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "mb-small-button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        const next = names.filter((_, i) => i !== idx);
        bot.panic.updateConfig({ gameMasterNames: next });
        renderGameMasterNames();
      });
      row.appendChild(label); row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  function refreshRuneStatus() {
    const toggle = document.getElementById("minibia-bot-rune-enabled");
    if (toggle) toggle.checked = !!bot.rune?.status?.().running;
  }

  function refreshAutoEatStatus() {
    const toggle = document.getElementById("minibia-bot-auto-eat-enabled");
    if (toggle) toggle.checked = !!bot.eat?.status?.().running;
  }

  function refreshAutoInvisibleStatus() {
    const toggle = document.getElementById("minibia-bot-auto-invisible-enabled");
    if (toggle) toggle.checked = !!bot.invisible?.status?.().running;
  }

  function refreshAutoMagicShieldStatus() {
    const toggle = document.getElementById("minibia-bot-auto-magic-shield-enabled");
    if (toggle) toggle.checked = !!bot.magicShield?.status?.().running;
  }

  function refreshEquipRingStatus() {
    const toggle = document.getElementById("minibia-bot-equip-ring-enabled");
    if (toggle) toggle.checked = !!bot.equipRing?.status?.().running;
  }

  function refreshTalkStatus() {
    const toggle = document.getElementById("minibia-bot-talk-enabled");
    const label = document.getElementById("minibia-bot-talk-status");
    const status = bot.talk?.status?.();
    if (toggle) toggle.checked = !!status?.running;
    if (label) {
      if (!status?.config?.apiKey) label.textContent = "Status: API key missing";
      else if (status?.pending) label.textContent = "Status: generating";
      else if (status?.running) label.textContent = "Status: listening to Default";
      else label.textContent = "Status: idle";
    }
  }

  function refreshTalkIgnoredPhrases() {
    const input = document.getElementById("minibia-bot-talk-ignored");
    if (!input) return;
    const phrases = bot.talk?.config?.ignoredPhrases || [];
    input.value = phrases.join(", ");
  }

  function saveTalkIgnoredPhrases() {
    const input = document.getElementById("minibia-bot-talk-ignored");
    if (!input) return;
    const raw = input.value.trim();
    const phrases = raw.split(/[,;]/).map(p => p.trim().toLowerCase()).filter(Boolean);
    bot.talk.updateConfig({ ignoredPhrases: phrases });
    refreshTalkIgnoredPhrases();
  }

  // ---- CAVE UI ----
  function refreshCavePresetControls() {
    const select = document.getElementById("minibia-bot-cave-preset-select");
    const label = document.getElementById("minibia-bot-cave-preset-status");
    const delBtn = document.getElementById("minibia-bot-cave-preset-delete");
    const status = bot.cave?.status?.();
    const names = status?.presetNames || bot.cave?.getPresetNames?.() || [];
    const active = status?.activePresetName || bot.cave?.getActivePresetName?.() || "Default";
    if (select) {
      const prev = select.value;
      select.innerHTML = "";
      if (!names.length) {
        const opt = document.createElement("option");
        opt.value = ""; opt.textContent = "No saved presets";
        select.appendChild(opt);
        select.disabled = true;
      } else {
        names.forEach(n => {
          const opt = document.createElement("option");
          opt.value = n; opt.textContent = n;
          select.appendChild(opt);
        });
        select.disabled = false;
        select.value = names.includes(active) ? active : (prev || names[0]);
      }
    }
    if (label) label.textContent = names.length ? `Preset: ${active} (${names.length} saved)` : `Preset: ${active}`;
    if (delBtn) delBtn.disabled = !names.length || !select?.value;
  }

  function refreshCaveClosestStatus() {
    const label = document.getElementById("minibia-bot-cave-closest");
    if (!label) return;
    const pos = bot.getPlayerPosition?.();
    const route = bot.cave?.getRoute?.() || [];
    if (!pos) { label.textContent = "Closest start: current position unavailable"; return; }
    if (!route.length) { label.textContent = "Closest start: no waypoints"; return; }
    const idx = bot.cave?.findClosestWaypointIndex?.(pos) ?? 0;
    const wp = route[idx];
    if (!wp) { label.textContent = "Closest start: unavailable"; return; }
    label.textContent = `Closest start: ${idx+1}. ${wp.x}, ${wp.y}, ${wp.z}`;
  }

  function refreshCaveTransitionStatus() {
    const label = document.getElementById("minibia-bot-cave-transition-status");
    if (!label) return;
    const trans = bot.cave?.getTransitions?.() || [];
    if (!trans.length) { label.textContent = "Transitions learned: none"; return; }
    const latest = trans.slice().sort((a,b) => (b?.lastSeenAt || 0) - (a?.lastSeenAt || 0))[0];
    if (!latest?.from || !latest?.to) { label.textContent = `Transitions learned: ${trans.length}`; return; }
    const extra = trans.length > 1 ? ` (+${trans.length-1} more)` : "";
    label.textContent = `Transitions learned: ${latest.from.x}, ${latest.from.y}, ${latest.from.z} -> ${latest.to.x}, ${latest.to.y}, ${latest.to.z}${extra}`;
  }

  // ---- CAVE WAYPOINT LIST ----
  let selectedWaypointIndex = null;

  function refreshCaveWaypointList() {
    const container = document.getElementById("minibia-bot-cave-waypoint-list");
    if (!container) return;
    const route = bot.cave?.getRoute?.() || [];
    const status = bot.cave?.status?.();
    const current = status?.currentIndex ?? 0;
    container.innerHTML = "";
    if (!route.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "No waypoints recorded.";
      container.appendChild(empty);
      selectedWaypointIndex = null;
      return;
    }
    route.forEach((wp, idx) => {
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer;${idx === current ? 'background:rgba(255,200,80,0.2);border:1px solid #ffcf5a;' : ''}`;
      row.dataset.index = idx;
      const num = document.createElement("span");
      num.textContent = `${idx+1}.`;
      num.style.cssText = "font-weight:bold;min-width:20px;";
      const coords = document.createElement("span");
      coords.textContent = `${wp.x}, ${wp.y}, ${wp.z}`;
      if (idx === current) coords.style.cssText = "color:#ffcf5a;font-weight:bold;";
      const distSpan = document.createElement("span");
      distSpan.style.cssText = "margin-left:auto;font-size:10px;opacity:0.6;";
      const pos = bot.getPlayerPosition?.();
      if (pos && wp.z === pos.z) {
        const dx = Math.abs(pos.x - wp.x), dy = Math.abs(pos.y - wp.y);
        distSpan.textContent = `dist ${dx+dy}`;
      }
      row.appendChild(num); row.appendChild(coords); row.appendChild(distSpan);
      row.addEventListener("click", () => {
        container.querySelectorAll("[data-selected]").forEach(el => el.dataset.selected = "false");
        row.dataset.selected = "true";
        selectedWaypointIndex = idx;
        bot.cave.setCurrentIndex(idx);
        if (bot.cave?.status?.().running) bot.cave.goToWaypoint(route[idx]);
        refreshCaveStatus();
        refreshCaveWaypointList();
        refreshTitlebarRunIndicators();
      });
      if (idx === current && selectedWaypointIndex === null) {
        row.dataset.selected = "true";
        selectedWaypointIndex = idx;
      }
      container.appendChild(row);
    });
    if (selectedWaypointIndex !== null && (selectedWaypointIndex < 0 || selectedWaypointIndex >= route.length)) {
      selectedWaypointIndex = null;
    }
  }

  function moveSelectedWaypoint(direction) {
    if (selectedWaypointIndex === null) { bot.log("No waypoint selected. Click a waypoint first."); return; }
    const route = bot.cave?.getRoute?.() || [];
    if (selectedWaypointIndex < 0 || selectedWaypointIndex >= route.length) return;
    if (direction === "up" && selectedWaypointIndex === 0) return;
    if (direction === "down" && selectedWaypointIndex === route.length - 1) return;
    let moved = false;
    if (direction === "up") {
      moved = bot.cave.moveWaypointUp(selectedWaypointIndex);
      if (moved) selectedWaypointIndex--;
    } else {
      moved = bot.cave.moveWaypointDown(selectedWaypointIndex);
      if (moved) selectedWaypointIndex++;
    }
    if (moved) {
      refreshCaveWaypointList();
      refreshCaveStatus();
      refreshCaveClosestStatus();
      refreshCaveTransitionStatus();
    }
  }

  function deleteSelectedWaypoint() {
    if (selectedWaypointIndex === null) { bot.log("No waypoint selected."); return; }
    const route = bot.cave?.getRoute?.() || [];
    if (selectedWaypointIndex < 0 || selectedWaypointIndex >= route.length) return;
    const deleted = bot.cave.deleteWaypoint(selectedWaypointIndex);
    if (deleted) {
      selectedWaypointIndex = null;
      refreshCaveWaypointList();
      refreshCaveStatus();
      refreshCaveClosestStatus();
      refreshCaveTransitionStatus();
    }
  }

  function refreshCaveStatus() {
    const toggle = document.getElementById("minibia-bot-cave-toggle");
    const label = document.getElementById("minibia-bot-cave-status");
    const route = bot.cave?.getRoute?.() || [];
    const status = bot.cave?.status?.();
    if (toggle) toggle.checked = !!status?.running;
    if (label) {
      if (!route.length) label.textContent = "Status: no waypoints";
      else if (status?.running) {
        const wpNum = (status.currentIndex ?? 0) + 1;
        const dist = Number.isFinite(status?.distanceToWaypoint) && status.distanceToWaypoint >= 0 ? `, dist ${status.distanceToWaypoint}` : "";
        label.textContent = `Status: running (${wpNum}/${route.length}${dist})`;
      } else {
        label.textContent = `Status: idle (${route.length} waypoint${route.length===1?"":"s"})`;
      }
    }
  }

  // ---- VISIBLE CREATURES LIST ----
  function refreshVisibleCreatures() {
    const list = document.getElementById("minibia-bot-visible-creatures-list");
    if (!list) return;
    const me = bot.getPlayerPosition?.();
    const status = bot.xray?.status?.();
    const creatures = status?.visibleCreatures || [];
    const selectedFloor = status?.config?.selectedFloor;
    list.innerHTML = "";
    if (!me) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "Current position unavailable.";
      list.appendChild(empty);
      return;
    }
    const getFloorOffset = (c) => (c.position?.z || 0) - me.z;
    const getFloorDist = (c) => Math.abs(getFloorOffset(c));
    const filtered = creatures
      .filter(c => {
        const floor = c?.position?.z;
        if (floor == null) return false;
        if (selectedFloor != null) return floor === selectedFloor;
        return floor !== me.z;
      })
      .sort((a,b) => {
        const fd = getFloorDist(a) - getFloorDist(b);
        if (fd !== 0) return fd;
        const fo = getFloorOffset(a) - getFloorOffset(b);
        if (fo !== 0) return fo;
        const ad = Math.abs((a.position?.x || 0) - me.x) + Math.abs((a.position?.y || 0) - me.y);
        const bd = Math.abs((b.position?.x || 0) - me.x) + Math.abs((b.position?.y || 0) - me.y);
        return ad - bd;
      });
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = selectedFloor == null ? "No off-floor creatures." : `No creatures on floor ${selectedFloor}.`;
      list.appendChild(empty);
      return;
    }
    let currentFloor = null;
    filtered.forEach(c => {
      const floor = c.position?.z;
      if (floor !== currentFloor) {
        currentFloor = floor;
        const offset = me.z - floor;
        const label = offset === 0 ? "0" : offset > 0 ? `+${offset}` : `${offset}`;
        const fl = document.createElement("div");
        fl.className = "mb-floor-label";
        fl.textContent = label;
        list.appendChild(fl);
      }
      const row = document.createElement("div");
      row.className = "mb-creature-row";
      const name = document.createElement("div");
      name.className = "mb-creature-name";
      name.textContent = c.name || (c.type === 0 ? "Player" : "Mob");
      const meta = document.createElement("div");
      meta.className = "mb-small-note";
      meta.textContent = `${c.type === 0 ? "Player" : "Mob"} at ${c.position.x}, ${c.position.y}, ${c.position.z}`;
      row.appendChild(name); row.appendChild(meta);
      list.appendChild(row);
    });
  }

  // ---- PANEL POSITION / COLLAPSE ----
  function savePanelPosition(position, key = panelPositionKey) {
    bot.storage.set(key, position);
  }
  function getSavedPanelPosition(key = panelPositionKey) {
    return bot.storage.get(key, null);
  }
  function savePanelCollapsed(collapsed) {
    bot.storage.set(panelCollapsedKey, !!collapsed);
  }
  function getSavedPanelCollapsed() {
    return !!bot.storage.get(panelCollapsedKey, false);
  }

  function setPanelCollapsed(panel, collapsed) {
    if (!panel) return;
    const body = panel.querySelector(".mb-body");
    const toggle = panel.querySelector("#minibia-bot-collapse");
    const next = !!collapsed;
    panel.dataset.collapsed = next ? "true" : "false";
    if (body) body.hidden = next;
    if (toggle) {
      toggle.textContent = next ? "+" : "−";
      toggle.setAttribute("aria-label", next ? "Maximize panel" : "Minimize panel");
      toggle.title = next ? "Maximize" : "Minimize";
    }
    savePanelCollapsed(next);
  }

  function applySavedPanelPosition(panel, key = panelPositionKey) {
    const pos = getSavedPanelPosition(key);
    if (!pos) return;
    if (typeof pos.top === "number") panel.style.top = `${pos.top}px`;
    if (typeof pos.left === "number") { panel.style.left = `${pos.left}px`; panel.style.right = "auto"; }
  }

  function clampPanelPosition(panel, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    return { left: Math.min(Math.max(0, left), maxLeft), top: Math.min(Math.max(0, top), maxTop) };
  }

  function enableDrag(panel, key = panelPositionKey) {
    const handle = panel.querySelector(".mb-title");
    if (!handle) return;
    let dragState = null;
    const onMouseMove = (e) => {
      if (!dragState) return;
      const next = clampPanelPosition(panel, e.clientX - dragState.offsetX, e.clientY - dragState.offsetY);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.style.right = "auto";
    };
    const onMouseUp = () => {
      if (!dragState) return;
      dragState = null;
      const rect = panel.getBoundingClientRect();
      savePanelPosition({ left: rect.left, top: rect.top }, key);
    };
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      dragState = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    bot.addCleanup(() => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    });
  }

  function updateCollapsedStopButton(panel) {
    if (!panel) return;
    const btn = panel.querySelector("#minibia-bot-collapsed-stop");
    if (!btn) return;
    btn.style.display = panel.dataset.collapsed === "true" ? "" : "none";
  }

  // ---- TITLE BAR RUN INDICATORS (clickable) ----
  function refreshTitlebarRunIndicators() {
    const panel = document.getElementById("minibia-bot-panel");
    if (!panel) return;
    const caveInd = panel.querySelector("#minibia-bot-title-cave-status");
    const attackInd = panel.querySelector("#minibia-bot-title-attack-status");
    let caveRunning = false, attackRunning = false;
    try { caveRunning = !!bot.cave?.status?.().running; } catch {}
    try { attackRunning = !!bot.attack?.status?.().running; } catch {}
    if (caveInd) {
      caveInd.dataset.running = caveRunning ? "true" : "false";
      caveInd.title = caveRunning ? "Cavebot running" : "Cavebot stopped";
    }
    if (attackInd) {
      attackInd.dataset.running = attackRunning ? "true" : "false";
      attackInd.title = attackRunning ? "Targeting running" : "Targeting stopped";
    }
  }

  function stopCaveAndAttackManual() {
    try { bot.cave?.stop?.(); } catch (e) { console.warn("[minibia-bot-ui] failed to stop cave", e); }
    try { bot.attack?.stop?.(); } catch (e) { console.warn("[minibia-bot-ui] failed to stop attack", e); }
    try { refreshCaveStatus?.(); refreshAutoAttackStatus?.(); refreshTitlebarRunIndicators?.(); } catch {}
  }

  // ---- INJECT THE PANEL ----
  function inject() {
    destroy();

    // Inject styles
    const style = document.createElement("style");
    style.id = "minibia-bot-style";
    style.textContent = `
      #minibia-bot-panel {
        position: fixed; z-index: 999999; top: 16px; right: 16px;
        width: 500px; max-width: calc(100vw - 32px); padding: 8px;
        border: 1px solid rgba(224,200,148,0.45); border-radius: 10px;
        background: rgba(18,13,8,0.96); box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        color: #f8e6b8; font: 12px/1.35 Verdana, sans-serif; user-select: none;
      }
      #minibia-bot-panel .mb-run-indicator { cursor: pointer; transition: background 0.15s, border-color 0.15s; }
      #minibia-bot-panel .mb-run-indicator:hover { background: rgba(255,255,255,0.08); border-color: rgba(224,200,148,0.6); }
      #minibia-bot-panel[data-collapsed="true"] { width: 240px; }
      #minibia-bot-panel .mb-titlebar { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 8px; margin: 0 0 8px; }
      #minibia-bot-panel[data-collapsed="true"] .mb-titlebar { margin-bottom: 0; }
      #minibia-bot-panel .mb-title-status { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
      #minibia-bot-panel .mb-run-indicator { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border: 1px solid rgba(224,200,148,0.22); border-radius: 999px; background: rgba(8,7,6,0.55); color: #b7a67d; font-size: 10px; line-height: 1.2; white-space: nowrap; }
      #minibia-bot-panel .mb-run-dot { width: 7px; height: 7px; border-radius: 50%; background: #5b5547; box-shadow: 0 0 0 1px rgba(0,0,0,0.45); }
      #minibia-bot-panel .mb-run-indicator[data-running="true"] { color: #d7ffd7; border-color: rgba(90,220,120,0.42); background: rgba(20,70,28,0.35); }
      #minibia-bot-panel .mb-run-indicator[data-running="true"] .mb-run-dot { background: #39e86f; box-shadow: 0 0 0 1px rgba(0,0,0,0.45), 0 0 7px rgba(57,232,111,0.8); }
      #minibia-bot-panel .mb-title-actions { display: flex; gap: 6px; align-items: center; }
      #minibia-bot-panel .mb-title { margin: 0; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; cursor: move; color: #ffe7ad; }
      #minibia-bot-panel .mb-icon-button { width: 24px; min-width: 24px; padding: 2px 0; border-radius: 6px; font-weight: 700; line-height: 1; }
      #minibia-bot-panel .mb-body { display: grid; grid-template-columns: 112px minmax(0,1fr); gap: 10px; align-items: start; }
      #minibia-bot-panel .mb-body[hidden] { display: none !important; }
      #minibia-bot-panel .mb-tab-menu { display: grid; gap: 6px; }
      #minibia-bot-panel .mb-tab-button { width: 100%; padding: 8px 9px; border-radius: 7px; text-align: left; font-size: 11px; line-height: 1.15; background: rgba(255,244,212,0.07); }
      #minibia-bot-panel .mb-tab-button[data-active="true"] { background: linear-gradient(180deg,#8a7044,#554329); border-color: rgba(224,200,148,0.75); color: #fff3cf; }
      #minibia-bot-panel .mb-tab-content { min-width: 0; max-height: min(72vh,560px); overflow-y: auto; padding-right: 4px; }
      #minibia-bot-panel .mb-tab-panel { display: none; }
      #minibia-bot-panel .mb-tab-panel[data-active="true"] { display: grid; gap: 10px; }
      #minibia-bot-panel .mb-section { padding: 12px; border: 1px solid rgba(224,200,148,0.18); border-radius: 8px; background: rgba(8,7,6,0.86); }
      #minibia-bot-panel .mb-label { margin: 0 0 10px; color: #ffe5a8; font-weight: 700; font-size: 13px; }
      #minibia-bot-panel .mb-stack { display: grid; gap: 10px; }
      #minibia-bot-panel .mb-form-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
      #minibia-bot-panel .mb-button-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
      #minibia-bot-panel .mb-utility-row { display: grid; grid-template-columns: minmax(0,1fr) 86px; gap: 10px; align-items: end; }
      #minibia-bot-panel .mb-field { display: grid; gap: 4px; min-width: 0; }
      #minibia-bot-panel .mb-mini-field { width: 86px; }
      #minibia-bot-panel .mb-field-label { color: #e9d39b; font-size: 11px; line-height: 1.2; }
      #minibia-bot-panel input, #minibia-bot-panel textarea, #minibia-bot-panel select {
        width: 100%; box-sizing: border-box; padding: 8px 10px;
        border: 1px solid rgba(224,200,148,0.48); border-radius: 8px;
        background: #080706; color: #fff2c7; font: inherit;
        box-shadow: inset 0 1px 2px rgba(0,0,0,0.65); caret-color: #fff2c7;
      }
      #minibia-bot-panel input::placeholder, #minibia-bot-panel textarea::placeholder { color: rgba(255,226,176,0.48); }
      #minibia-bot-panel input:focus, #minibia-bot-panel textarea:focus, #minibia-bot-panel select:focus {
        outline: none; border-color: rgba(255,220,140,0.9);
        box-shadow: inset 0 1px 2px rgba(0,0,0,0.65), 0 0 0 2px rgba(255,200,90,0.18);
      }
      #minibia-bot-panel textarea { min-height: 90px; resize: vertical; }
      #minibia-bot-panel .mb-toggle { display: flex; align-items: center; gap: 8px; color: #f3dfad; white-space: normal; }
      #minibia-bot-panel .mb-toggle-main { margin-bottom: 2px; }
      #minibia-bot-panel input[type="checkbox"] { width: 14px; height: 14px; margin: 0; accent-color: #18c99a; }
      #minibia-bot-panel button { width: 100%; padding: 8px 10px; border: 1px solid rgba(224,200,148,0.35); border-radius: 8px; background: linear-gradient(180deg,#635133,#3f321f); color: #fff0ca; font: inherit; cursor: pointer; }
      #minibia-bot-panel button:hover { background: linear-gradient(180deg,#755f3d,#4f4028); }
      #minibia-bot-panel .mb-small-button { width: auto; padding: 6px 8px; border-radius: 6px; }
      #minibia-bot-panel .mb-inline { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: center; }
      #minibia-bot-panel .mb-list { display: grid; gap: 6px; }
      #minibia-bot-panel .mb-list-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 6px; align-items: center; color: #d3c49d; }
      #minibia-bot-panel .mb-creature-row { padding: 6px 8px; border: 1px solid rgba(224,200,148,0.14); border-radius: 8px; background: rgba(255,244,212,0.04); }
      #minibia-bot-panel .mb-creature-name { color: #f7eccf; word-break: break-word; }
      #minibia-bot-panel .mb-floor-label { margin-top: 4px; color: #e2cf9c; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
      #minibia-bot-panel #minibia-bot-visible-creatures-list,
      #minibia-bot-panel #minibia-bot-panic-trusted-list,
      #minibia-bot-panel #minibia-bot-panic-gm-list { max-height: 150px; overflow-y: auto; padding-right: 2px; }
      #minibia-bot-panel .mb-small-note, #minibia-bot-panel .mb-note { color: #cdbb8b; font-size: 11px; line-height: 1.35; }
      #minibia-bot-panel .mb-collapsed-stop-button { background: linear-gradient(180deg,#7a2f2f,#4e1f1f); border-color: rgba(255,120,120,0.55); color: #ffd6d6; }
      #minibia-bot-panel .mb-collapsed-stop-button:hover { background: linear-gradient(180deg,#963b3b,#642727); }
      #minibia-bot-panel[data-collapsed="false"] .mb-collapsed-stop-button { display: none; }
      @media (max-width:760px) {
        #minibia-bot-panel { width: min(560px,calc(100vw - 32px)); }
        #minibia-bot-panel .mb-body { grid-template-columns: 1fr; }
        #minibia-bot-panel .mb-tab-menu { grid-template-columns: repeat(3,minmax(0,1fr)); }
        #minibia-bot-panel .mb-tab-button { text-align: center; }
        #minibia-bot-panel .mb-form-grid, #minibia-bot-panel .mb-button-grid, #minibia-bot-panel .mb-utility-row { grid-template-columns: 1fr; }
        #minibia-bot-panel .mb-mini-field { width: 100%; }
      }
    `;
    document.head.appendChild(style);

    // ---- PANEL HTML (full) ----
    const panel = document.createElement("div");
    panel.id = "minibia-bot-panel";
    panel.innerHTML = `
<div class="mb-titlebar">
  <div class="mb-title">MBot</div>
  <div class="mb-title-status">
    <span class="mb-run-indicator" id="minibia-bot-title-cave-status" data-running="false"><span class="mb-run-dot"></span><span class="mb-run-label">Cave</span></span>
    <span class="mb-run-indicator" id="minibia-bot-title-attack-status" data-running="false"><span class="mb-run-dot"></span><span class="mb-run-label">Target</span></span>
  </div>
  <div class="mb-title-actions">
    <button type="button" class="mb-icon-button mb-collapsed-stop-button" id="minibia-bot-collapsed-stop" title="Stop Cave + Attack">■</button>
    <button type="button" class="mb-icon-button" id="minibia-bot-collapse" title="Minimize">−</button>
  </div>
</div>
<div class="mb-body">
  <div class="mb-tab-menu">
    <button type="button" class="mb-tab-button" data-tab-button="healing">Healing</button>
    <button type="button" class="mb-tab-button" data-tab-button="panic">Panic</button>
    <button type="button" class="mb-tab-button" data-tab-button="xray">Xray</button>
    <button type="button" class="mb-tab-button" data-tab-button="utility">Utility</button>
    <button type="button" class="mb-tab-button" data-tab-button="cave">Cavebot</button>
    <button type="button" class="mb-tab-button" data-tab-button="targeting">Targeting</button>
    <button type="button" class="mb-tab-button" data-tab-button="talk">Talk</button>
  </div>
  <div class="mb-tab-content">
    <!-- Healing Tab -->
    <div class="mb-tab-panel" data-tab-panel="healing">
      <div class="mb-section">
        <div class="mb-label">Auto Heal</div>
        <label class="mb-toggle mb-toggle-main"><input type="checkbox" id="minibia-bot-auto-heal-enabled" /><span>Enable Auto Heal</span></label>
        <div id="minibia-bot-heal-rules-list" class="mb-list" style="margin:8px 0;"></div>
        <div class="mb-section" style="padding:10px;background:rgba(255,255,255,0.03);">
          <div class="mb-label" style="font-size:12px;margin-bottom:6px;">Add / Edit Rule</div>
          <div style="display:grid;grid-template-columns:80px 1fr 80px;gap:6px;margin-bottom:6px;">
            <label class="mb-field" for="minibia-bot-heal-slot"><span class="mb-field-label">Slot</span><input type="number" id="minibia-bot-heal-slot" min="1" max="12" value="1" /></label>
            <label class="mb-field" for="minibia-bot-heal-spell"><span class="mb-field-label">Spell Words (optional)</span><input type="text" id="minibia-bot-heal-spell" placeholder="ex: exura" /></label>
            <label class="mb-field" for="minibia-bot-heal-manacost"><span class="mb-field-label">Mana Cost</span><input type="number" id="minibia-bot-heal-manacost" min="1" value="0" placeholder="0" /></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:6px;">
            <label class="mb-field" for="minibia-bot-heal-minhp"><span class="mb-field-label">Min HP %</span><input type="number" id="minibia-bot-heal-minhp" min="0" max="100" value="0" /></label>
            <label class="mb-field" for="minibia-bot-heal-maxhp"><span class="mb-field-label">Max HP %</span><input type="number" id="minibia-bot-heal-maxhp" min="0" max="100" value="100" /></label>
            <label class="mb-field" for="minibia-bot-heal-minmana"><span class="mb-field-label">Min MP %</span><input type="number" id="minibia-bot-heal-minmana" min="0" max="100" value="0" /></label>
            <label class="mb-field" for="minibia-bot-heal-maxmana"><span class="mb-field-label">Max MP %</span><input type="number" id="minibia-bot-heal-maxmana" min="0" max="100" value="100" /></label>
          </div>
          <div style="display:flex;gap:6px;"><button type="button" id="minibia-bot-heal-save" style="flex:1;">Add Rule</button><button type="button" id="minibia-bot-heal-cancel" style="flex:0;width:auto;padding:8px 12px;">Cancel</button></div>
        </div>
        <div class="mb-small-note" style="margin-top:6px;">Rules are checked in order. First rule whose HP and MP ranges match will trigger. If spell words are given, mana cost must be set (and current mana must be ≥ that).</div>
      </div>
    </div>

    <!-- Panic Tab -->
    <div class="mb-tab-panel" data-tab-panel="panic">
      <div class="mb-section">
        <div class="mb-label" id="minibia-bot-home">Panic Runner Home: not set</div>
        <div class="mb-stack">
          <button type="button" id="minibia-bot-set-home">Set Home</button>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-unknown" /><span>Unknown Player</span></label>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-health" /><span>Lose Health</span></label>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-return" /><span>Auto Return</span></label>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-player-alert" /><span>Player On‑Screen Alert (sound only)</span></label>
          <div style="display:flex;gap:6px;align-items:center;"><label style="font-size:11px;color:#e9d39b;">Cooldown (seconds)</label><input type="number" id="minibia-bot-panic-player-cooldown" min="10" value="60" style="width:60px;padding:2px 4px;font-size:11px;" /></div>
          <div class="mb-inline"><input type="text" id="minibia-bot-panic-trusted-input" placeholder="Trusted name" /><button type="button" class="mb-small-button" id="minibia-bot-panic-trusted-add">Add</button></div>
          <div class="mb-list" id="minibia-bot-panic-trusted-list"></div>
        </div>
      </div>
      <div class="mb-section">
        <div class="mb-label">GM Kill Switch</div>
        <div class="mb-stack">
          <div class="mb-inline"><input type="text" id="minibia-bot-panic-gm-input" placeholder="Game master name" /><button type="button" class="mb-small-button" id="minibia-bot-panic-gm-add">Add</button></div>
          <div class="mb-list" id="minibia-bot-panic-gm-list"></div>
        </div>
      </div>
    </div>

    <!-- Xray Tab -->
    <div class="mb-tab-panel" data-tab-panel="xray">
      <div class="mb-section">
        <div class="mb-label">Xray</div>
        <div class="mb-stack">
          <button type="button" class="mb-small-button" id="minibia-bot-xray-overlay-toggle">Disable Overlay</button>
          <div class="mb-small-note" id="minibia-bot-xray-overlay-status">Overlay: on</div>
          <label class="mb-field" for="minibia-bot-xray-floor-select"><span class="mb-field-label">Floor Filter</span><select id="minibia-bot-xray-floor-select"><option value="all">All floors</option></select></label>
          <div class="mb-list" id="minibia-bot-visible-creatures-list"></div>
        </div>
      </div>
    </div>

    <!-- Utility Tab -->
    <div class="mb-tab-panel" data-tab-panel="utility">
      <div class="mb-section"><div class="mb-label">Bot</div><button type="button" id="minibia-bot-reload">Reload Bot</button></div>
      <div class="mb-section">
        <div class="mb-label">Magic Level Trainer</div>
        <label class="mb-toggle mb-toggle-main"><input type="checkbox" id="minibia-bot-rune-enabled" /><span>Enable Trainer</span></label>
        <div class="mb-form-grid">
          <label class="mb-field" for="minibia-bot-rune-spell"><span class="mb-field-label">Spell Words</span><input type="text" id="minibia-bot-rune-spell" placeholder="Spell words" /></label>
          <label class="mb-field" for="minibia-bot-rune-mana"><span class="mb-field-label">Mana Cost</span><input type="number" id="minibia-bot-rune-mana" min="0" placeholder="Mana" /></label>
        </div>
      </div>
      <div class="mb-section">
        <div class="mb-label">Utility Modules</div>
        <div class="mb-stack">
          <div class="mb-utility-row"><label class="mb-toggle"><input type="checkbox" id="minibia-bot-auto-eat-enabled" /><span>Auto Eat</span></label><label class="mb-field mb-mini-field" for="minibia-bot-auto-eat-hotkey"><span class="mb-field-label">Hotkey</span><input type="number" id="minibia-bot-auto-eat-hotkey" min="1" max="12" placeholder="10" /></label></div>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-auto-invisible-enabled" /><span>Auto Invisible</span></label>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-auto-magic-shield-enabled" /><span>Auto Utamo Vita</span></label>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-equip-ring-enabled" /><span>Equip Ring</span></label>
        </div>
      </div>
    </div>

    <!-- Cave Tab -->
    <div class="mb-tab-panel" data-tab-panel="cave">
      <div class="mb-section">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="mb-label" style="margin:0;">Cave Bot</div>
          <div style="display:flex;gap:12px;align-items:center;">
            <label class="mb-toggle" style="margin:0;font-size:11px;"><input type="checkbox" id="minibia-bot-cave-loop" /><span>Loop</span></label>
            <label class="mb-toggle" style="margin:0;font-size:11px;"><input type="checkbox" id="minibia-bot-cave-toggle" /><span>Enable</span></label>
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin:6px 0;">
          <select id="minibia-bot-cave-preset-select" style="flex:1;padding:4px 6px;font-size:11px;"></select>
          <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-new" style="padding:2px 8px;font-size:10px;">New</button>
          <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-delete" style="padding:2px 8px;font-size:10px;">Del</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin:4px 0;">
          <label style="font-size:11px;color:#e9d39b;">Skip if within</label>
          <input type="number" id="minibia-bot-cave-tolerance" min="0" max="5" step="1" value="0" style="width:50px;padding:2px 4px;font-size:11px;" />
          <span style="font-size:11px;color:#cdbb8b;">tiles</span>
        </div>
        <div style="margin:6px 0;">
          <div class="mb-label" style="font-size:11px;margin:0 0 4px;">Waypoints</div>
          <div id="minibia-bot-cave-waypoint-list" style="max-height:120px;overflow-y:auto;border:1px solid rgba(224,200,148,0.2);border-radius:4px;padding:2px;font-size:11px;"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin:4px 0;">
          <button type="button" class="mb-small-button" id="minibia-bot-cave-add" style="padding:4px;">+ Add</button>
          <button type="button" class="mb-small-button" id="minibia-bot-cave-move-up" style="padding:4px;">▲</button>
          <button type="button" class="mb-small-button" id="minibia-bot-cave-move-down" style="padding:4px;">▼</button>
          <button type="button" class="mb-small-button" id="minibia-bot-cave-delete-selected" style="padding:4px;background:#5a2020;border-color:#883030;">✕</button>
        </div>
        <div style="font-size:10px;color:#cdbb8b;margin-top:4px;display:grid;gap:2px;">
          <div id="minibia-bot-cave-status">Status: no waypoints</div>
          <div id="minibia-bot-cave-closest">Closest start: none</div>
          <div id="minibia-bot-cave-transition-status">Transitions learned: none</div>
        </div>
      </div>
    </div>

    <!-- Targeting Tab -->
    <div class="mb-tab-panel" data-tab-panel="targeting">
      <div class="mb-section">
        <div class="mb-label">Auto Attack</div>
        <div class="mb-stack">
          <label class="mb-toggle mb-toggle-main"><input type="checkbox" id="minibia-bot-auto-attack-enabled" /><span>Enable Auto Attack</span></label>
          <label class="mb-toggle"><input type="checkbox" id="minibia-bot-auto-attack-melee" /><span>Melee Mode</span></label>
          <div class="mb-form-grid">
            <label class="mb-field" for="minibia-bot-auto-attack-hotkey"><span class="mb-field-label">Target Hotkey</span><input type="number" id="minibia-bot-auto-attack-hotkey" min="1" max="12" placeholder="3" /></label>
            <label class="mb-field" for="minibia-bot-auto-attack-rune-hotkey"><span class="mb-field-label">Rune Hotkey</span><input type="number" id="minibia-bot-auto-attack-rune-hotkey" min="1" max="12" placeholder="4" /></label>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; align-items:end;">
            <label class="mb-field" for="minibia-bot-auto-attack-maxdist"><span class="mb-field-label">Max Target Distance</span><input type="number" id="minibia-bot-auto-attack-maxdist" min="1" max="10" value="5" /></label>
            <div style="display:flex; align-items:center;"><label class="mb-toggle" style="margin:0;"><input type="checkbox" id="minibia-bot-auto-attack-antiks" /><span>Anti-KS</span></label></div>
            <div style="display:flex; gap:8px; align-items:center; justify-content:flex-end;">
              <label class="mb-field" style="flex:1; min-width:0;"><span class="mb-field-label">Self Range</span><input type="number" id="minibia-bot-auto-attack-antiks-self" min="1" max="5" value="2" /></label>
              <label class="mb-field" style="flex:1; min-width:0;"><span class="mb-field-label">Other Range</span><input type="number" id="minibia-bot-auto-attack-antiks-other" min="1" max="5" value="2" /></label>
            </div>
          </div>
          <div class="mb-section" style="margin-top:8px;">
            <div class="mb-label">Target Priority</div>
            <div class="mb-stack">
              <label class="mb-field" for="minibia-bot-auto-attack-preferred-names"><span class="mb-field-label">Preferred Mobs</span><textarea id="minibia-bot-auto-attack-preferred-names" placeholder="Orc Shaman, Amazon, Orc Spearman"></textarea></label>
              <label class="mb-field" for="minibia-bot-auto-attack-preferred-match-mode"><span class="mb-field-label">Match Mode</span><select id="minibia-bot-auto-attack-preferred-match-mode"><option value="exact">Exact name</option><option value="includes">Contains text</option></select></label>
              <button type="button" class="mb-small-button" id="minibia-bot-auto-attack-preferred-save">Save Target Priority</button>
              <div class="mb-small-note" id="minibia-bot-auto-attack-preferred-status">Preferred mobs: none</div>
              <div class="mb-small-note">Preferred mobs are ranked first, but other visible mobs are still allowed.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Talk Tab -->
    <div class="mb-tab-panel" data-tab-panel="talk">
      <div class="mb-section">
        <div class="mb-label">Talk</div>
        <div class="mb-stack">
          <label class="mb-toggle mb-toggle-main"><input type="checkbox" id="minibia-bot-talk-enabled" /><span>Enable Auto Reply</span></label>
          <label class="mb-field" for="minibia-bot-talk-api-key"><span class="mb-field-label">Gemini API Key</span><input type="password" id="minibia-bot-talk-api-key" placeholder="Gemini API key" /></label>
          <label class="mb-field" for="minibia-bot-talk-prompt"><span class="mb-field-label">Reply Style Prompt</span><textarea id="minibia-bot-talk-prompt" placeholder="Reply style prompt"></textarea></label>
          <label class="mb-field" for="minibia-bot-talk-ignored"><span class="mb-field-label">Ignore messages containing (comma separated)</span><input type="text" id="minibia-bot-talk-ignored" placeholder="munch., yum, burp" /></label>
          <div class="mb-small-note" id="minibia-bot-talk-status">Status: idle</div>
          <div class="mb-small-note">Replies only to the newest unseen message in Default chat.</div>
        </div>
      </div>
    </div>
  </div>
</div>
`;
    document.body.appendChild(panel);

    // ---- SETUP UI BEHAVIOR ----
    // Tab switching
    function setActiveBotTab(tabId) {
      panel.querySelectorAll(".mb-tab-button").forEach(btn => btn.dataset.active = btn.dataset.tabButton === tabId ? "true" : "false");
      panel.querySelectorAll(".mb-tab-panel").forEach(tp => tp.dataset.active = tp.dataset.tabPanel === tabId ? "true" : "false");
      try { localStorage.setItem("minibia-bot-active-tab", tabId); } catch {}
    }
    panel.querySelectorAll(".mb-tab-button").forEach(btn => {
      btn.addEventListener("click", () => setActiveBotTab(btn.dataset.tabButton));
    });
    const savedTab = (() => { try { return localStorage.getItem("minibia-bot-active-tab") || "healing"; } catch { return "healing"; } })();
    setActiveBotTab(savedTab);

    // Collapse button
    const collapseBtn = panel.querySelector("#minibia-bot-collapse");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", () => {
        const isCollapsed = panel.dataset.collapsed === "true";
        setPanelCollapsed(panel, !isCollapsed);
        updateCollapsedStopButton(panel);
      });
    }

    // Collapsed stop button
    const stopBtn = panel.querySelector("#minibia-bot-collapsed-stop");
    if (stopBtn) {
      stopBtn.addEventListener("click", (e) => {
        e.preventDefault();
        stopCaveAndAttackManual();
      });
    }

    // Title bar click toggles
    const titleCave = panel.querySelector("#minibia-bot-title-cave-status");
    const titleAttack = panel.querySelector("#minibia-bot-title-attack-status");
    if (titleCave) {
      titleCave.addEventListener("click", () => {
        const running = !!bot.cave?.status?.().running;
        running ? bot.cave.stop() : bot.cave.start();
        refreshTitlebarRunIndicators();
        refreshCaveStatus();
        refreshCaveWaypointList();
      });
    }
    if (titleAttack) {
      titleAttack.addEventListener("click", () => {
        const running = !!bot.attack?.status?.().running;
        running ? bot.attack.stop() : bot.attack.start();
        refreshTitlebarRunIndicators();
        refreshAutoAttackStatus();
      });
    }

    // ---- EVENT LISTENERS ----
	
    // Heal UI
    const healSave = panel.querySelector("#minibia-bot-heal-save");
    const healCancel = panel.querySelector("#minibia-bot-heal-cancel");
    if (healSave) healSave.addEventListener("click", saveHealRule);
    if (healCancel) healCancel.addEventListener("click", clearHealRuleForm);

    const autoHealToggle = panel.querySelector("#minibia-bot-auto-heal-enabled");
    if (autoHealToggle) {
      autoHealToggle.checked = !!bot.heal?.status?.().running;
      autoHealToggle.addEventListener("change", () => {
        if (autoHealToggle.checked) bot.heal.start();
        else bot.heal.stop();
        refreshAutoHealStatus();
      });
    }

    // Auto Attack
    const autoAttackEnabledInput = panel.querySelector("#minibia-bot-auto-attack-enabled");
    const autoAttackMeleeInput = panel.querySelector("#minibia-bot-auto-attack-melee");
    const autoAttackHotkeyInput = panel.querySelector("#minibia-bot-auto-attack-hotkey");
    const autoAttackRuneHotkeyInput = panel.querySelector("#minibia-bot-auto-attack-rune-hotkey");
    const maxDistInput = panel.querySelector("#minibia-bot-auto-attack-maxdist");
    const antiKSInput = panel.querySelector("#minibia-bot-auto-attack-antiks");
    const antiKSSelfInput = panel.querySelector("#minibia-bot-auto-attack-antiks-self");
    const antiKSOtherInput = panel.querySelector("#minibia-bot-auto-attack-antiks-other");

    if (autoAttackHotkeyInput) {
      autoAttackHotkeyInput.value = String(bot.attack?.config?.targetHotbarSlot ?? 3);
      autoAttackHotkeyInput.addEventListener("change", () => {
        const val = Math.min(12, Math.max(1, Number(autoAttackHotkeyInput.value) || 1));
        autoAttackHotkeyInput.value = String(val);
        bot.attack.updateConfig({ targetHotbarSlot: val });
      });
    }
    if (autoAttackRuneHotkeyInput) {
      autoAttackRuneHotkeyInput.value = bot.attack?.config?.runeHotbarSlot ? String(bot.attack.config.runeHotbarSlot) : "";
      autoAttackRuneHotkeyInput.addEventListener("change", () => {
        const raw = Number(autoAttackRuneHotkeyInput.value);
        const slot = Number.isFinite(raw) && raw >= 1 && raw <= 12 ? Math.trunc(raw) : null;
        autoAttackRuneHotkeyInput.value = slot ? String(slot) : "";
        bot.attack.updateConfig({ runeHotbarSlot: slot });
      });
    }
    if (autoAttackMeleeInput) {
      autoAttackMeleeInput.checked = bot.attack?.config?.meleeMode !== false;
      autoAttackMeleeInput.addEventListener("change", () => {
        bot.attack.updateConfig({ meleeMode: autoAttackMeleeInput.checked });
      });
    }
    if (autoAttackEnabledInput) {
      autoAttackEnabledInput.checked = !!bot.attack?.status?.().running;
      autoAttackEnabledInput.addEventListener("change", () => {
        const targetSlot = Math.min(12, Math.max(1, Number(autoAttackHotkeyInput?.value) || bot.attack.config.targetHotbarSlot || 1));
        const runeSlot = (() => {
          const raw = Number(autoAttackRuneHotkeyInput?.value);
          return Number.isFinite(raw) && raw >= 1 && raw <= 12 ? Math.trunc(raw) : null;
        })();
        const melee = !!autoAttackMeleeInput?.checked;
        if (autoAttackEnabledInput.checked) bot.attack.start({ targetHotbarSlot: targetSlot, runeHotbarSlot: runeSlot, meleeMode: melee });
        else bot.attack.stop();
        refreshAutoAttackStatus();
        refreshTitlebarRunIndicators();
      });
    }
    if (maxDistInput) {
      maxDistInput.value = bot.attack?.config?.maxTargetDistance ?? 5;
      maxDistInput.addEventListener("change", () => {
        const val = Math.min(10, Math.max(1, Number(maxDistInput.value) || 5));
        maxDistInput.value = val;
        bot.attack.updateConfig({ maxTargetDistance: val });
      });
    }
    if (antiKSInput) {
      antiKSInput.checked = bot.attack?.config?.antiKSEnabled !== false;
      antiKSInput.addEventListener("change", () => {
        bot.attack.updateConfig({ antiKSEnabled: antiKSInput.checked });
      });
    }
    if (antiKSSelfInput) {
      antiKSSelfInput.value = bot.attack?.config?.antiKSSelfRange ?? 2;
      antiKSSelfInput.addEventListener("change", () => {
        const val = Math.min(5, Math.max(1, Number(antiKSSelfInput.value) || 2));
        antiKSSelfInput.value = val;
        bot.attack.updateConfig({ antiKSSelfRange: val });
      });
    }
    if (antiKSOtherInput) {
      antiKSOtherInput.value = bot.attack?.config?.antiKSOtherRange ?? 2;
      antiKSOtherInput.addEventListener("change", () => {
        const val = Math.min(5, Math.max(1, Number(antiKSOtherInput.value) || 2));
        antiKSOtherInput.value = val;
        bot.attack.updateConfig({ antiKSOtherRange: val });
      });
    }

    // Panic player alert
    const playerAlertToggle = panel.querySelector("#minibia-bot-panic-player-alert");
    const playerCooldownInput = panel.querySelector("#minibia-bot-panic-player-cooldown");
    if (playerAlertToggle) {
      playerAlertToggle.checked = bot.panic?.config?.playerAlertEnabled ?? false;
      playerAlertToggle.addEventListener("change", () => {
        bot.panic.updateConfig({ playerAlertEnabled: playerAlertToggle.checked });
      });
    }
    if (playerCooldownInput) {
      playerCooldownInput.value = (bot.panic?.config?.playerAlertCooldownMs ?? 60000) / 1000;
      playerCooldownInput.addEventListener("change", () => {
        const sec = Math.max(10, Number(playerCooldownInput.value) || 60);
        playerCooldownInput.value = sec;
        bot.panic.updateConfig({ playerAlertCooldownMs: sec * 1000 });
      });
    }

    // Talk ignored phrases
    const talkIgnoredInput = panel.querySelector("#minibia-bot-talk-ignored");
    if (talkIgnoredInput) {
      talkIgnoredInput.value = (bot.talk?.config?.ignoredPhrases || []).join(", ");
      talkIgnoredInput.addEventListener("change", saveTalkIgnoredPhrases);
      talkIgnoredInput.addEventListener("blur", saveTalkIgnoredPhrases);
    }

    // Cave bot waypoint actions
    const addBtn = panel.querySelector("#minibia-bot-cave-add");
    const moveUpBtn = panel.querySelector("#minibia-bot-cave-move-up");
    const moveDownBtn = panel.querySelector("#minibia-bot-cave-move-down");
    const delBtn = panel.querySelector("#minibia-bot-cave-delete-selected");
    if (addBtn) addBtn.addEventListener("click", () => {
      bot.cave.addWaypointCurrentSpot();
      refreshCaveWaypointList();
      refreshCaveStatus();
      refreshCaveClosestStatus();
      refreshCaveTransitionStatus();
      refreshCavePresetControls();
    });
    if (moveUpBtn) moveUpBtn.addEventListener("click", () => moveSelectedWaypoint("up"));
    if (moveDownBtn) moveDownBtn.addEventListener("click", () => moveSelectedWaypoint("down"));
    if (delBtn) delBtn.addEventListener("click", deleteSelectedWaypoint);

    // Cave preset
    const presetSelect = panel.querySelector("#minibia-bot-cave-preset-select");
    const presetNew = panel.querySelector("#minibia-bot-cave-preset-new");
    const presetDelete = panel.querySelector("#minibia-bot-cave-preset-delete");
    if (presetSelect) {
      presetSelect.addEventListener("change", () => {
        const name = presetSelect.value;
        if (!name) return;
        bot.cave.loadPreset(name);
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
        refreshCaveWaypointList();
      });
    }
    if (presetNew) {
      presetNew.addEventListener("click", () => {
        const name = window.prompt("Name the new cave preset:");
        if (name == null) return;
        bot.cave.createPreset(name);
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
        refreshCaveWaypointList();
      });
    }
    if (presetDelete) {
      presetDelete.addEventListener("click", () => {
        const name = presetSelect?.value;
        if (!name) return;
        bot.cave.deletePreset(name);
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
        refreshCaveWaypointList();
      });
    }

    // Cave tolerance
    const toleranceInput = panel.querySelector("#minibia-bot-cave-tolerance");
    if (toleranceInput) {
      toleranceInput.value = bot.cave?.config?.waypointTolerance ?? 0;
      toleranceInput.addEventListener("change", () => {
        const val = Math.min(5, Math.max(0, Number(toleranceInput.value) || 0));
        toleranceInput.value = val;
        bot.cave.updateConfig({ waypointTolerance: val });
      });
    }

    // Cave toggle
    const caveToggle = panel.querySelector("#minibia-bot-cave-toggle");
    if (caveToggle) {
      caveToggle.checked = !!bot.cave?.status?.().running;
      caveToggle.addEventListener("change", () => {
        if (caveToggle.checked) bot.cave.start();
        else bot.cave.stop();
        refreshCaveStatus();
        refreshCaveWaypointList();
        refreshTitlebarRunIndicators();
      });
    }

    // Cave loop toggle
    const loopToggle = panel.querySelector("#minibia-bot-cave-loop");
    if (loopToggle) {
      loopToggle.checked = bot.cave?.getLoopMode?.() ?? false;
      loopToggle.addEventListener("change", () => {
        bot.cave.setLoopMode(loopToggle.checked);
      });
    }

    // ---- OLDER EXISTING LISTENERS (reload, trusted, GM, rune, eat, invisible, shield, equip, talk, panic, xray, home) ----

    // ---- INITIAL REFRESHES ----
    refreshHomeLabel();
    refreshPanicStatus();
    refreshXrayStatus();
    renderTrustedNames();
    renderGameMasterNames();
    refreshRuneStatus();
    refreshAutoHealStatus();
    refreshHealRules();
    refreshAutoInvisibleStatus();
    refreshAutoMagicShieldStatus();
    refreshAutoAttackStatus();
    refreshAutoAttackPreferredStatus({ force: true });
    refreshAutoEatStatus();
    refreshCaveStatus();
    refreshEquipRingStatus();
    refreshTalkStatus();
    refreshVisibleCreatures();
    refreshCavePresetControls();
    refreshCaveClosestStatus();
    refreshCaveTransitionStatus();
    refreshCaveWaypointList();
    refreshTalkIgnoredPhrases();
    refreshTitlebarRunIndicators();

    // Periodic refreshes
    const visibleTimer = window.setInterval(refreshVisibleCreatures, 1000);
    bot.addCleanup(() => window.clearInterval(visibleTimer));
    const talkTimer = window.setInterval(refreshTalkStatus, 1000);
    bot.addCleanup(() => window.clearInterval(talkTimer));
    const caveTimer = window.setInterval(() => {
      refreshCaveStatus();
      refreshCavePresetControls();
      refreshCaveClosestStatus();
      refreshCaveTransitionStatus();
      refreshCaveWaypointList();
      const loopToggle = document.getElementById("minibia-bot-cave-loop");
      if (loopToggle) loopToggle.checked = bot.cave?.getLoopMode?.() ?? false;
    }, 1000);
    bot.addCleanup(() => window.clearInterval(caveTimer));
    const titleTimer = window.setInterval(refreshTitlebarRunIndicators, 500);
    bot.addCleanup(() => window.clearInterval(titleTimer));

    // Position, drag, collapse
    applySavedPanelPosition(panel);
    enableDrag(panel);
    const savedCollapsed = getSavedPanelCollapsed();
    setPanelCollapsed(panel, savedCollapsed);
    updateCollapsedStopButton(panel);

    // Audio unlock
    const unlockAudio = () => bot.unlockAudio?.();
    panel.addEventListener("pointerdown", unlockAudio, { passive: true });
    panel.addEventListener("keydown", unlockAudio);
    bot.addCleanup(() => {
      panel.removeEventListener("pointerdown", unlockAudio);
      panel.removeEventListener("keydown", unlockAudio);
    });
  }

  // ---- PUBLIC UI API ----
  bot.ui = {
    inject,
    destroy,
    refreshHomeLabel,
    refreshPanicStatus,
    refreshXrayStatus,
    refreshRuneStatus,
    refreshAutoHealStatus,
    refreshAutoInvisibleStatus,
    refreshAutoMagicShieldStatus,
    refreshAutoAttackStatus,
    refreshAutoAttackPreferredStatus,
    refreshAutoEatStatus,
    refreshCaveStatus,
    refreshCavePresetControls,
    refreshEquipRingStatus,
    refreshTalkStatus,
    refreshVisibleCreatures,
    refreshCaveClosestStatus,
    refreshCaveTransitionStatus,
    getSavedPanelPosition,
    getSavedPanelCollapsed,
    setPanelCollapsed: (collapsed) => {
      const panel = document.getElementById("minibia-bot-panel");
      setPanelCollapsed(panel, collapsed);
    },
  };
};

/**
 * ==================================================================================
 * 15. BOOTSTRAP
 *     Creates the bot, installs all modules, and exposes it globally.
 *     Also implements hot‑reload.
 * ==================================================================================
 */
(() => {
  const bundle = window.__minibiaBotBundle || window.__minibiaBotReloadBundle || {};
  const persistedEnabledModules = [
    ["rune", "minibiaBot.rune.config"],
    ["heal", "minibiaBot.heal.config"],
    ["invisible", "minibiaBot.invisible.config"],
    ["magicShield", "minibiaBot.magicShield.config"],
    ["attack", "minibiaBot.attack.config"],
    ["cave", "minibiaBot.cave.config"],
    ["equipRing", "minibiaBot.equipRing.config"],
    ["eat", "minibiaBot.eat.config"],
    ["talk", "minibiaBot.talk.config"],
  ];

  function getPersistedEnabledSnapshot(bot) {
    const snapshot = {};
    const status = typeof bot?.status === "function" ? bot.status() : null;
    persistedEnabledModules.forEach(([name]) => {
      const enabled = status?.[name]?.config?.enabled;
      if (typeof enabled === "boolean") snapshot[name] = enabled;
    });
    return snapshot;
  }

  function restorePersistedEnabledSnapshot(snapshot) {
    persistedEnabledModules.forEach(([name, storageKey]) => {
      if (typeof snapshot?.[name] !== "boolean") return;
      try {
        const raw = window.localStorage.getItem(storageKey);
        const config = raw ? JSON.parse(raw) : {};
        config.enabled = snapshot[name];
        window.localStorage.setItem(storageKey, JSON.stringify(config));
      } catch (e) {
        console.error("[minibia-bot] failed to restore persisted enabled state", { module: name, error: e });
      }
    });
  }

  function boot(currentBundle = bundle) {
    const prevSnapshot = getPersistedEnabledSnapshot(window.minibiaBot);
    if (window.minibiaBot?.destroy) window.minibiaBot.destroy();
    restorePersistedEnabledSnapshot(prevSnapshot);

    const bot = currentBundle.createBot();
    currentBundle.installPzModule(bot);
    currentBundle.installXrayModule(bot);
    currentBundle.installPanicModule(bot);
    currentBundle.installRuneModule(bot);
    currentBundle.installHealModule(bot);
    currentBundle.installAutoInvisibleModule(bot);
    currentBundle.installAutoMagicShieldModule(bot);
    currentBundle.installAutoAttackModule(bot);
    currentBundle.installCaveModule(bot);
    currentBundle.installEquipRingModule(bot);
    currentBundle.installAutoEatModule(bot);
    currentBundle.installTalkModule(bot);
    currentBundle.installPanel(bot);

    bot.ui.inject();

    bot.start = (...args) => bot.rune.start(...args);
    bot.stop = (...args) => bot.rune.stop(...args);
    bot.reload = () => window.minibiaBotReload?.();
    bot.status = () => ({
      version: bot.version,
      pz: { home: bot.pz.getHomePz() },
      xray: bot.xray.status(),
      panic: bot.panic.status(),
      rune: bot.rune.status(),
      heal: bot.heal.status(),
      invisible: bot.invisible.status(),
      magicShield: bot.magicShield.status(),
      attack: bot.attack.status(),
      cave: bot.cave.status(),
      equipRing: bot.equipRing.status(),
      eat: bot.eat.status(),
      talk: bot.talk.status(),
    });

    window.minibiaBot = bot;
    window.pzBot = bot.pz;
    console.log("[minibia-bot] ready", { version: bot.version, modules: ["pz","xray","panic","rune","heal","invisible","magicShield","attack","cave","equipRing","eat","talk","ui"] });
    console.log("minibiaBot.reload()");
    return bot;
  }

  window.__minibiaBotReloadBundle = bundle;
  window.minibiaBotReload = () => boot(window.__minibiaBotReloadBundle || bundle);
  delete window.__minibiaBotBundle;
  boot(bundle);
})();

/**
 * ==================================================================================
 * 16. INFERNAL SCRIPT – MOVEMENT PATCH
 *     Hooks into the game client to force‑stop auto‑walking when the player has
 *     a target. Prevents cave bot and pathfinder from moving while in combat.
 * ==================================================================================
 */
(() => {
  const TAG = "[InfernalScript]";
  const state = { installed: false, stopping: false, lastStopPacketAt: 0, forceStopUntil: 0 };

  console.log(`${TAG} page hook loaded`);

  function waitForClient() {
    const client = window.gameClient || window.GameClient?.instance || window.client;
    if (!client || !client.player || !client.world?.pathfinder) {
      requestAnimationFrame(waitForClient);
      return;
    }
    install(client);
  }

  function install(client) {
    if (state.installed) return;
    state.installed = true;
    console.log(`${TAG} gameClient found`);

    guardPlayerTarget(client);
    guardPathfinderProperties(client);
    patchGameClientSend(client);
    patchPathfinder(client);
    patchPacketHandler(client);
    patchPlayerUnlockMovement(client);
    startStopLoop(client);
    console.log(`${TAG} FULL CONTROL ACTIVE - balanced smooth mode`);
  }

  function hasTarget(client) {
    const p = client.player;
    if (!p) return false;
    let target = null;
    try { if (typeof p.getTarget === "function") target = p.getTarget(); } catch {}
    if (!target && p.__target !== null && p.__target !== undefined) target = p.__target;
    if (!target) return false;
    if (!isTargetOnScreen(client, target)) {
      state.pausedForCombat = false;
      return false;
    }
    state.pausedForCombat = true;
    return true;
  }

  function isTargetOnScreen(client, target) {
    const p = client.player;
    if (!p || !target) return false;
    try {
      if (typeof p.canSeeSmall === "function") return p.canSeeSmall(target);
      if (typeof p.canSee === "function") return p.canSee(target);
    } catch {}
    try {
      const pp = p.getPosition().projected();
      const tp = target.getPosition().projected();
      const dx = Math.abs(pp.x - tp.x);
      const dy = Math.abs(pp.y - tp.y);
      return dx < 8 && dy < 6;
    } catch {}
    return false;
  }

  function sendStopWalk(client, force = false) {
    const now = performance.now();
    if (!force && now - state.lastStopPacketAt < 250) return;
    state.lastStopPacketAt = now;
    try {
      if (typeof StopWalkPacket === "function") client.send(new StopWalkPacket());
    } catch (e) {
      console.warn(`${TAG} failed to send StopWalkPacket`, e);
    }
  }

  function hardStop(client, forcePacket = false) {
    if (state.stopping) return;
    state.stopping = true;
    try {
      const p = client.player;
      const pf = client.world?.pathfinder;
      if (!p || !pf) return;
      sendStopWalk(client, forcePacket);
      // Clear all pathfinding state
      pf.__isAutoWalking = false;
      pf.__autoWalkStepsRemaining = 0;
      pf.__autowalkStartPosition = null;
      pf.__autowalkStartedAt = 0;
      pf.__finalDestination = null;
      pf.__pathfindCache = [];
      pf.__minimapWaypoints = null;
      pf.__recentMinimapStarts = [];
      pf.__lastCancelPosition = null;
      pf.__lastRetryDest = null;
      pf.__lastRetryTime = 0;
      pf.__hybridPath = null;
      pf.__hybridNeedsAlign = false;
      p.__movementBuffer = null;
      p.__lookDirectionBuffer = null;
      if (client.mouse) {
        client.mouse.__pendingUseObject = null;
        client.mouse.__pendingUsePosition = null;
        client.mouse.__pendingUseWithSource = null;
        client.mouse.__pendingMoveFrom = null;
      }
    } finally {
      state.stopping = false;
    }
  }

  function guardPlayerTarget(client) {
    const p = client.player;
    if (!p || p.__stopOnTargetTargetGuarded) return;
    let targetValue = p.__target ?? null;
    Object.defineProperty(p, "__target", {
      configurable: true,
      get() { return targetValue; },
      set(value) {
        targetValue = value;
        if (value !== null && value !== undefined) {
          state.forceStopUntil = performance.now() + 1200;
          queueMicrotask(() => hardStop(client, true));
        }
      }
    });
    p.__stopOnTargetTargetGuarded = true;
    console.log(`${TAG} guarded player.__target`);
  }

  function guardPathfinderProperties(client) {
    const pf = client.world?.pathfinder;
    if (!pf || pf.__stopOnTargetPropertyGuarded) return;
    let finalDest = pf.__finalDestination ?? null;
    let isAutoWalking = pf.__isAutoWalking ?? false;
    let pathCache = Array.isArray(pf.__pathfindCache) ? pf.__pathfindCache : [];
    let hybridPath = pf.__hybridPath ?? null;

    Object.defineProperty(pf, "__finalDestination", {
      configurable: true,
      get() { return hasTarget(client) ? null : finalDest; },
      set(v) {
        if (hasTarget(client)) {
          finalDest = null;
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }
        finalDest = v;
      }
    });
    Object.defineProperty(pf, "__isAutoWalking", {
      configurable: true,
      get() { return hasTarget(client) ? false : isAutoWalking; },
      set(v) {
        if (hasTarget(client)) {
          isAutoWalking = false;
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }
        isAutoWalking = v;
      }
    });
    Object.defineProperty(pf, "__pathfindCache", {
      configurable: true,
      get() {
        if (hasTarget(client)) pathCache.length = 0;
        return pathCache;
      },
      set(v) {
        if (hasTarget(client)) {
          pathCache = [];
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }
        pathCache = Array.isArray(v) ? v : [];
      }
    });
    Object.defineProperty(pf, "__hybridPath", {
      configurable: true,
      get() { return hasTarget(client) ? null : hybridPath; },
      set(v) {
        if (hasTarget(client)) {
          hybridPath = null;
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }
        hybridPath = v;
      }
    });
    pf.__stopOnTargetPropertyGuarded = true;
    console.log(`${TAG} guarded pathfinder properties`);
  }

  function patchGameClientSend(client) {
    if (!client || typeof client.send !== "function" || client.__stopOnTargetSendPatched) return;
    const orig = client.send;
    client.send = function(packet) {
      const name = packet?.constructor?.name || "";
      if (name === "StopWalkPacket") return orig.call(this, packet);
      if (hasTarget(client) && (name === "AutoWalkPacket" || name === "WalkToDestinationPacket")) {
        console.log(`${TAG} blocked outgoing ${name}`);
        state.forceStopUntil = performance.now() + 1000;
        hardStop(client, true);
        return false;
      }
      return orig.call(this, packet);
    };
    client.__stopOnTargetSendPatched = true;
    console.log(`${TAG} patched gameClient.send`);
  }

  function patchPathfinder(client) {
    const pf = client.world?.pathfinder;
    if (!pf || pf.__stopOnTargetFunctionsPatched) return;
    const methods = ["findPath","handlePathfind","__predictHybridStep","__findPathViaMinimap","__continueAlongWaypoints","getNextMove"];
    methods.forEach(key => {
      if (typeof pf[key] !== "function") return;
      const orig = pf[key];
      pf[key] = function(...args) {
        if (hasTarget(client)) {
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return false;
        }
        return orig.apply(this, args);
      };
    });
    if (typeof pf.setPathfindCache === "function") {
      const orig = pf.setPathfindCache;
      pf.setPathfindCache = function(path) {
        if (hasTarget(client) && path !== null) {
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return false;
        }
        return orig.call(this, path);
      };
    }
    pf.__stopOnTargetFunctionsPatched = true;
    console.log(`${TAG} patched pathfinder functions`);
  }

  function patchPacketHandler(client) {
    const handler = client.networkManager?.packetHandler || client.packetHandler;
    if (!handler || handler.__stopOnTargetPacketHandlerPatched) return;
    const methods = ["handleAutoWalkPath"];
    methods.forEach(key => {
      if (typeof handler[key] !== "function") return;
      const orig = handler[key];
      handler[key] = function(...args) {
        if (hasTarget(client)) {
          console.log(`${TAG} blocked incoming ${key}`);
          state.forceStopUntil = performance.now() + 1000;
          hardStop(client, true);
          return false;
        }
        return orig.apply(this, args);
      };
    });
    handler.__stopOnTargetPacketHandlerPatched = true;
    console.log(`${TAG} patched packetHandler`);
  }

  function patchPlayerUnlockMovement(client) {
    const p = client.player;
    if (!p || typeof p.unlockMovement !== "function" || p.__stopOnTargetUnlockPatched) return;
    const orig = p.unlockMovement;
    p.unlockMovement = function(...args) {
      if (hasTarget(client)) {
        hardStop(client, false);
        this.__movementBuffer = null;
        this.__lookDirectionBuffer = null;
        return orig.apply(this, args);
      }
      return orig.apply(this, args);
    };
    p.__stopOnTargetUnlockPatched = true;
    console.log(`${TAG} patched player.unlockMovement - smooth cleanup mode`);
  }

  function startStopLoop(client) {
    let lastHad = false;
    setInterval(() => {
      const active = hasTarget(client);
      const now = performance.now();
      if (active) {
        const force = !lastHad || now < state.forceStopUntil;
        hardStop(client, force);
      }
      lastHad = active;
    }, 100);
    console.log(`${TAG} target stop loop running - balanced interval mode`);
  }

  waitForClient();
})();
