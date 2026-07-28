window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.createBot = function createBot() {
  const cleanups = [];
  const defaultAlarmAudioSrc = "https://upload.wikimedia.org/wikipedia/commons/5/5c/En-us-red_alert.oga";
  const alarmAudioSrcStorageKey = "minibiaBot.audio.alarmSrc";
  const recentSentChats = [];
  const reconnectButtonSelectors = [
    "button",
    "[role=\"button\"]",
    "input[type=\"button\"]",
    "input[type=\"submit\"]",
    "a",
    ".button",
    ".btn",
  ];
  let alarmAudio = null;
  let reconnectObserver = null;
  let reconnectPollTimerId = null;
  let lastReconnectClickAt = 0;

  function addCleanup(fn) {
    if (typeof fn === "function") {
      cleanups.push(fn);
    }
  }

  function runCleanups() {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch (error) {
        console.error("[minibia-bot] cleanup failed", error);
      }
    }
  }

  function getStoredAlarmAudioSrc() {
    try {
      const value = window.localStorage.getItem(alarmAudioSrcStorageKey);
      return value == null ? defaultAlarmAudioSrc : JSON.parse(value);
    } catch (error) {
      return defaultAlarmAudioSrc;
    }
  }

  function setStoredAlarmAudioSrc(src) {
    window.localStorage.setItem(alarmAudioSrcStorageKey, JSON.stringify(src));
    return src;
  }

  function destroyAlarmAudio() {
    if (!alarmAudio) {
      return;
    }

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
    if (!src) {
      return null;
    }

    if (!alarmAudio) {
      alarmAudio = new Audio(src);
      alarmAudio.preload = "auto";
    } else if (alarmAudio.src !== src) {
      alarmAudio.pause();
      alarmAudio = new Audio(src);
      alarmAudio.preload = "auto";
    }

    return alarmAudio;
  }

  function normalizeChatText(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function rememberSentChat(text) {
    const normalized = normalizeChatText(text);
    if (!normalized) {
      return;
    }

    recentSentChats.push({
      text: normalized,
      at: Date.now(),
    });

    const maxEntries = 20;
    if (recentSentChats.length > maxEntries) {
      recentSentChats.splice(0, recentSentChats.length - maxEntries);
    }
  }

  function isRecentSentChat(text, withinMs = 45000) {
    const normalized = normalizeChatText(text);
    if (!normalized) {
      return false;
    }

    const cutoff = Date.now() - withinMs;
    for (let index = recentSentChats.length - 1; index >= 0; index -= 1) {
      const entry = recentSentChats[index];
      if (entry.at < cutoff) {
        continue;
      }

      if (entry.text === normalized) {
        return true;
      }
    }

    return false;
  }

  function normalizeUiText(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function getSkillWindowValue(skillNames = []) {
    for (const skillName of skillNames) {
      const value =
        document.querySelector(`#skill-window div[skill="${skillName}"] .skill`)?.textContent?.trim() ||
        null;
      if (value) {
        return value;
      }
    }

    return null;
  }

  function parseNumberText(value) {
    if (value == null) {
      return null;
    }

    const normalized = String(value).replace(/[^\d.-]/g, "");
    if (!normalized) {
      return null;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function getElementUiText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    return normalizeUiText(
      element.textContent ||
      element.innerText ||
      element.getAttribute("value") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
    );
  }

  function findReconnectElement() {
    for (const selector of reconnectButtonSelectors) {
      const candidates = document.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (!isVisibleElement(candidate)) {
          continue;
        }

        if (getElementUiText(candidate) === "reconnect") {
          return candidate;
        }
      }
    }

    return null;
  }

  function tryClickReconnect() {
    const now = Date.now();
    if (now - lastReconnectClickAt < 3000) {
      return false;
    }

    const reconnectElement = findReconnectElement();
    if (!reconnectElement) {
      return false;
    }

    reconnectElement.click();
    lastReconnectClickAt = now;
    console.log("[minibia-bot] clicked reconnect");
    return true;
  }

  function startReconnectWatcher() {
    if (reconnectObserver || reconnectPollTimerId) {
      return;
    }

    const runCheck = () => {
      try {
        tryClickReconnect();
      } catch (error) {
        console.error("[minibia-bot] reconnect watcher failed", error);
      }
    };

    reconnectObserver = new MutationObserver(runCheck);
    reconnectObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "value"],
    });

    reconnectPollTimerId = window.setInterval(runCheck, 2000);
    runCheck();
  }

  function stopReconnectWatcher() {
    if (reconnectObserver) {
      reconnectObserver.disconnect();
      reconnectObserver = null;
    }

    if (reconnectPollTimerId) {
      window.clearInterval(reconnectPollTimerId);
      reconnectPollTimerId = null;
    }
  }

  startReconnectWatcher();

  // __imB counter reset - keeps the input metrics counter clean
  let __imbResetInterval = null;
  
  function startImbReset(intervalMs = 1000) {
    if (__imbResetInterval) return;
    
    __imbResetInterval = setInterval(() => {
      if (typeof __imB !== 'undefined') {
        __imB = 0;
      }
    }, intervalMs);
  }
  
  function stopImbReset() {
    if (__imbResetInterval) {
      clearInterval(__imbResetInterval);
      __imbResetInterval = null;
    }
  }
  
  // Auto-start the reset
  startImbReset(1000);

  return {
    version: "0.3.0",
    addCleanup,
    destroy() {
      if (this.panic?.stop) {
        this.panic.stop();
      }

      if (this.rune?.stop) {
        this.rune.stop({ persistEnabled: false });
      }

      if (this.heal?.stop) {
        this.heal.stop({ persistEnabled: false });
      }

      if (this.invisible?.stop) {
        this.invisible.stop({ persistEnabled: false });
      }

      if (this.attack?.stop) {
        this.attack.stop({ persistEnabled: false });
      }

      if (this.cave?.stop) {
        this.cave.stop({ persistEnabled: false });
      }

      if (this.equipRing?.stop) {
        this.equipRing.stop({ persistEnabled: false });
      }

      if (this.eat?.stop) {
        this.eat.stop({ persistEnabled: false });
      }

      if (this.talk?.stop) {
        this.talk.stop({ persistEnabled: false });
      }

      if (this.ui?.destroy) {
        this.ui.destroy();
      }

      stopReconnectWatcher();
      stopImbReset();
      destroyAlarmAudio();
      runCleanups();
    },
    log(...args) {
      console.log("[minibia-bot]", ...args);
    },
    storage: {
      get(key, fallback = null) {
        try {
          const value = window.localStorage.getItem(key);
          return value == null ? fallback : JSON.parse(value);
        } catch (error) {
          return fallback;
        }
      },
      set(key, value) {
        window.localStorage.setItem(key, JSON.stringify(value));
        return value;
      },
      remove(key) {
        window.localStorage.removeItem(key);
      },
    },
    getPlayerPosition() {
      return window.gameClient?.player?.getPosition?.() || null;
    },
    getPlayerState() {
      return window.gameClient?.player?.state || null;
    },
    getPlayerName() {
      return (
        String(
          this.getPlayerState()?.name ||
          window.gameClient?.player?.name ||
          window.gameClient?.player?.state?.name ||
          ""
        ).trim() || null
      );
    },
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
    sendChat(text) {
      const channelManager = window.gameClient?.interface?.channelManager;
      if (!channelManager || !text) {
        return false;
      }

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
    clickHotbar(index) {
      const button = window.gameClient?.interface?.hotbarManager?.slots?.[index]?.canvas?.canvas;
      if (!button) {
        return false;
      }

      button.click();
      return true;
    },
    getAlarmAudioSrc() {
      return getStoredAlarmAudioSrc();
    },
    setAlarmAudioSrc(src) {
      const nextSrc = String(src || "").trim();
      if (!nextSrc) {
        return false;
      }

      setStoredAlarmAudioSrc(nextSrc);
      destroyAlarmAudio();
      this.log("alarm audio updated", nextSrc);
      return true;
    },
    unlockAudio() {
      try {
        const audio = getAlarmAudio();
        if (!audio) {
          return false;
        }

        audio.muted = true;
        const playResult = audio.play();

        if (playResult && typeof playResult.then === "function") {
          playResult
            .then(() => {
              audio.pause();
              audio.currentTime = 0;
              audio.muted = false;
            })
            .catch((error) => {
              audio.muted = false;
              this.log("audio unlock failed", error?.message || error);
            });
        } else {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        }

        return true;
      } catch (error) {
        console.error("[minibia-bot] audio unlock failed", error);
        return false;
      }
    },
    playAlarm() {
      try {
        const audio = getAlarmAudio();
        if (!audio) {
          return false;
        }

        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
        const playResult = audio.play();

        if (playResult && typeof playResult.catch === "function") {
          playResult.catch((error) => {
            this.log("alarm playback failed", error?.message || error);
          });
        }

        return true;
      } catch (error) {
        console.error("[minibia-bot] alarm failed", error);
        return false;
      }
    },
    imbReset: {
      start: () => startImbReset(1000),
      stop: stopImbReset,
      reset: () => { if (typeof __imB !== 'undefined') __imB = 0; }
    },
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installPzModule = function installPzModule(bot) {
  const homeStorageKey = "minibiaBot.pz.home";

  function getLoadedTiles() {
    const chunks = window.gameClient?.world?.chunks || [];
    const tiles = [];

    for (const chunk of chunks) {
      if (!chunk?.tiles) continue;

      for (const tile of chunk.tiles) {
        if (tile?.__position) {
          tiles.push(tile);
        }
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
      .filter((tile) => hasPzFlag(tile) && tile.__position?.z === me.z)
      .map((tile) => {
        const p = tile.__position;
        return {
          tile,
          x: p.x,
          y: p.y,
          z: p.z,
          flags: tile.flags || 0,
          dist: Math.abs(p.x - me.x) + Math.abs(p.y - me.y),
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

    if (!candidates.length) {
      bot.log("No PZ candidates found");
      return false;
    }

    for (const candidate of candidates) {
      if (goToTile(candidate.tile)) {
        bot.log("selected PZ", {
          x: candidate.x,
          y: candidate.y,
          z: candidate.z,
          flags: candidate.flags,
          dist: candidate.dist,
        });
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
    if (!pos) {
      bot.log("Could not read current position");
      return null;
    }

    return setHomePz(pos.x, pos.y, pos.z);
  }

  function getHomePz() {
    return bot.storage.get(homeStorageKey, null);
  }

  function clearHomePz() {
    bot.storage.remove(homeStorageKey);
    bot.log("home PZ cleared");
  }

  function getNearestPzTo(x, y, z) {
    const candidates = getLoadedTiles()
      .filter((tile) => hasPzFlag(tile) && tile.__position?.z === z)
      .map((tile) => {
        const p = tile.__position;
        return {
          tile,
          x: p.x,
          y: p.y,
          z: p.z,
          flags: tile.flags || 0,
          dist: Math.abs(p.x - x) + Math.abs(p.y - y),
        };
      })
      .sort((a, b) => a.dist - b.dist);

    return candidates[0] || null;
  }

  function goToHomePz() {
    const home = getHomePz();
    if (!home) {
      bot.log("No home PZ set");
      return false;
    }

    const candidate = getNearestPzTo(home.x, home.y, home.z);
    if (!candidate) {
      bot.log("No loaded PZ found near saved home", home);
      return false;
    }

    bot.log("home candidate", {
      x: candidate.x,
      y: candidate.y,
      z: candidate.z,
      flags: candidate.flags,
      distFromHome: candidate.dist,
    });

    return goToTile(candidate.tile);
  }

  function printPzCandidates(limit = 10) {
    const rows = getPzCandidates()
      .slice(0, limit)
      .map((candidate) => ({
        x: candidate.x,
        y: candidate.y,
        z: candidate.z,
        flags: candidate.flags,
        dist: candidate.dist,
      }));

    console.table(rows);
    return rows;
  }

  bot.pz = {
    getLoadedTiles,
    getPzCandidates,
    goToTile,
    goToNearestPz,
    setHomePz,
    setHomePzCurrentSpot,
    getHomePz,
    clearHomePz,
    getNearestPzTo,
    goToHomePz,
    printPzCandidates,
  };

  bot.goToNearestPz = goToNearestPz;
  bot.setHomePz = setHomePz;
  bot.setHomePzCurrentSpot = setHomePzCurrentSpot;
  bot.getHomePz = getHomePz;
  bot.clearHomePz = clearHomePz;
  bot.goToHomePz = goToHomePz;
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installXrayModule = function installXrayModule(bot) {
  const configStorageKey = "minibiaBot.xray.config";
  const overlayRootId = "minibia-bot-xray-overlay";
  const overlayStyleId = "minibia-bot-xray-overlay-style";
  const overlayState = {
    running: false,
    timerId: null,
  };
  const config = Object.assign(
    {
      overlayEnabled: false,
      selectedFloor: null,
    },
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
    if (value == null || value === "" || value === "all") {
      return null;
    }

    const floor = Number(value);
    if (!Number.isFinite(floor)) {
      return null;
    }

    return Math.trunc(floor);
  }

  function isWithinVisibleRange(me, pos) {
    if (!me || !pos) {
      return false;
    }

    const dx = Math.abs(pos.x - me.x);
    const dy = Math.abs(pos.y - me.y);
    return dx <= 8 && dy <= 6;
  }

  function getTrackedCreatures() {
    const myState = bot.getPlayerState();
    const myId = window.gameClient?.player?.id;
    const myName = normalizeName(myState?.name);

    return Object.values(window.gameClient?.world?.activeCreatures || {}).filter((creature) => {
      if (!creature) return false;
      if (creature.id === myId) return false;

      const name = normalizeName(creature.name);
      if (name && name === myName) return false;

      return true;
    });
  }

  function getVisibleCreatures() {
    const me = bot.getPlayerPosition();
    if (!me) {
      return [];
    }

    // Keep the visible query strict; panic logic relies on this staying screen-limited.
    return getTrackedCreatures().filter((creature) => isWithinVisibleRange(me, creature.__position));
  }

  function getVisiblePlayers(options = {}) {
    const { sameFloorOnly = false } = options;
    const me = bot.getPlayerPosition();
    if (!me) {
      return [];
    }

    return getVisibleCreatures().filter((creature) => {
      if (creature?.type !== 0) {
        return false;
      }

      if (!sameFloorOnly) {
        return true;
      }

      return creature.__position?.z === me.z;
    });
  }

  function getVisibleMonsters(options = {}) {
    const { sameFloorOnly = false } = options;
    const me = bot.getPlayerPosition();
    if (!me) {
      return [];
    }

    return getVisibleCreatures().filter((creature) => {
      if (creature?.type === 0) {
        return false;
      }

      if (!sameFloorOnly) {
        return true;
      }

      return creature.__position?.z === me.z;
    });
  }

  function readCreatureHealth(creature) {
    if (!creature) {
      return null;
    }

    const current = [
      creature.health,
      creature.hp,
      creature.currentHealth,
      creature.state?.health,
    ].find((value) => Number.isFinite(Number(value)));

    const max = [
      creature.maxHealth,
      creature.maxHp,
      creature.maximumHealth,
      creature.state?.maxHealth,
    ].find((value) => Number.isFinite(Number(value)));

    const percent = [
      creature.healthPercent,
      creature.hpPercent,
      creature.healthpercentage,
      creature.state?.healthPercent,
    ].find((value) => Number.isFinite(Number(value)));

    if (current != null && max != null) {
      return `${Number(current)}/${Number(max)} HP`;
    }

    if (percent != null) {
      return `${Math.round(Number(percent))}% HP`;
    }

    if (current != null) {
      return `${Number(current)} HP`;
    }

    return null;
  }

  function getCreatureLabel(creature) {
    if (creature?.name) {
      return creature.name;
    }

    return creature?.type === 0 ? "Player" : "Mob";
  }

  function getOverlayCreatures() {
    const me = bot.getPlayerPosition();
    if (!me) {
      return [];
    }

    return getTrackedCreatures().filter((creature) => {
      const pos = creature?.__position;
      if (!pos || pos.z == null) {
        return false;
      }

      if (config.selectedFloor != null && pos.z !== config.selectedFloor) {
        return false;
      }

      if (pos.z !== me.z) {
        return isWithinVisibleRange(me, pos);
      }

      return !isWithinVisibleRange(me, pos);
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getSameFloorOffscreenMarkerText(creature, healthLabel) {
    return healthLabel
      ? `${getCreatureLabel(creature)} ${healthLabel}`
      : `${getCreatureLabel(creature)}`;
  }

  function ensureOverlayStyle() {
    if (document.getElementById(overlayStyleId)) {
      return;
    }

    const style = document.createElement("style");
    style.id = overlayStyleId;
    style.textContent = `
      #${overlayRootId} {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 999998;
      }

      #${overlayRootId} .mb-xray-marker {
        position: fixed;
        transform: translate(-50%, -50%);
        padding: 2px 6px;
        border: 1px solid rgba(255, 211, 128, 0.85);
        border-radius: 999px;
        background: rgba(65, 24, 12, 0.72);
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
        color: #ffe7ae;
        font: 11px/1.2 Verdana, sans-serif;
        white-space: nowrap;
      }

      #${overlayRootId} .mb-xray-marker.mb-xray-marker-offscreen {
        border-color: rgba(123, 235, 178, 0.92);
        background: rgba(11, 61, 43, 0.8);
        color: #d8ffea;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureOverlayRoot() {
    let root = document.getElementById(overlayRootId);
    if (root) {
      return root;
    }

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
      .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 200 && rect.height >= 150)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

    return canvases[0]?.rect || null;
  }

  function renderOverlay() {
    if (!overlayState.running) {
      return;
    }

    const root = ensureOverlayRoot();
    const me = bot.getPlayerPosition();
    const viewportRect = getViewportRect();
    const creatures = getOverlayCreatures();
    root.innerHTML = "";

    if (!me || !viewportRect || !creatures.length) {
      return;
    }

    const tileWidth = viewportRect.width / 17;
    const tileHeight = viewportRect.height / 13;
    const edgePadding = 48;

    creatures.forEach((creature) => {
      const pos = creature?.__position;
      if (!pos) return;

      const dx = pos.x - me.x;
      const dy = pos.y - me.y;
      const healthLabel = readCreatureHealth(creature);
      const marker = document.createElement("div");
      marker.className = "mb-xray-marker";

      if (pos.z === me.z) {
        marker.classList.add("mb-xray-marker-offscreen");
        marker.textContent = getSameFloorOffscreenMarkerText(creature, healthLabel);
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
          ? `${getCreatureLabel(creature)} (${floorLabel}) ${healthLabel}`
          : `${getCreatureLabel(creature)} (${floorLabel})`;
        marker.style.left = `${viewportRect.left + ((dx + 8.5) * tileWidth)}px`;
        marker.style.top = `${viewportRect.top + ((dy + 6.5) * tileHeight)}px`;
      }

      root.appendChild(marker);
    });
  }

  function startOverlay() {
    config.overlayEnabled = true;
    persistConfig();

    if (overlayState.running) {
      return false;
    }

    overlayState.running = true;
    ensureOverlayStyle();
    renderOverlay();
    overlayState.timerId = window.setInterval(renderOverlay, 250);
    return true;
  }

  function stopOverlay() {
    config.overlayEnabled = false;
    persistConfig();

    if (!overlayState.running && overlayState.timerId == null) {
      return false;
    }

    overlayState.running = false;
    if (overlayState.timerId != null) {
      window.clearInterval(overlayState.timerId);
      overlayState.timerId = null;
    }

    destroyOverlayElements();
    return true;
  }

  function setOverlayEnabled(enabled) {
    const nextEnabled = !!enabled;

    if (nextEnabled) {
      if (overlayState.running) {
        config.overlayEnabled = true;
        persistConfig();
        return true;
      }

      return startOverlay();
    }

    if (!overlayState.running) {
      config.overlayEnabled = false;
      persistConfig();
      destroyOverlayElements();
      return true;
    }

    return stopOverlay();
  }

  function setSelectedFloor(floor) {
    config.selectedFloor = normalizeSelectedFloor(floor);
    persistConfig();

    if (overlayState.running) {
      renderOverlay();
    }

    return config.selectedFloor;
  }

  function status() {
    return {
      visibleCreatures: getVisibleCreatures().map((creature) => ({
        id: creature.id,
        name: creature.name,
        type: creature.type,
        position: creature.__position || null,
      })),
      visiblePlayers: getVisiblePlayers().map((player) => ({
        id: player.id,
        name: player.name,
        position: player.__position || null,
      })),
      visiblePlayersCurrentFloor: getVisiblePlayers({ sameFloorOnly: true }).map((player) => ({
        id: player.id,
        name: player.name,
        position: player.__position || null,
      })),
      visibleMonsters: getVisibleMonsters().map((creature) => ({
        id: creature.id,
        name: creature.name,
        type: creature.type,
        position: creature.__position || null,
      })),
      visibleMonstersCurrentFloor: getVisibleMonsters({ sameFloorOnly: true }).map((creature) => ({
        id: creature.id,
        name: creature.name,
        type: creature.type,
        position: creature.__position || null,
      })),
      overlayCreatures: getOverlayCreatures().map((creature) => ({
        id: creature.id,
        name: creature.name,
        type: creature.type,
        position: creature.__position || null,
      })),
      config: { ...config },
      overlayRunning: overlayState.running,
    };
  }

  bot.xray = {
    getVisibleCreatures,
    getVisiblePlayers,
    getVisibleMonsters,
    getOverlayCreatures,
    startOverlay,
    stopOverlay,
    setOverlayEnabled,
    setSelectedFloor,
    status,
    config,
  };

  if (config.overlayEnabled) {
    startOverlay();
  } else {
    destroyOverlayElements();
  }
  bot.addCleanup(stopOverlay);
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

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
  };

  const config = Object.assign(
    {
      tickMs: 200,
      triggerCooldownMs: 4000,
      returnToOriginEnabled: false,
      returnDelayMs: 300000,
      returnDelayJitterMs: 30000,
      returnRetryCooldownMs: 2000,
      unknownPlayerEnabled: false,
      healthLossEnabled: false,
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
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return { x, y, z };
  }

  function isSamePosition(left, right) {
    return !!left && !!right && left.x === right.x && left.y === right.y && left.z === right.z;
  }

  function getTrustedNames() {
    return Array.from(
      new Set(
        (config.trustedNames || [])
          .map((name) => normalizeName(name))
          .filter(Boolean)
      )
    );
  }

  function getGameMasterNames() {
    return Array.from(
      new Set(
        (config.gameMasterNames || [])
          .map((name) => normalizeName(name))
          .filter(Boolean)
      )
    );
  }

  function getVisiblePlayers() {
    const me = bot.getPlayerPosition();
    const players = bot.xray?.getVisiblePlayers?.() || [];
    if (!me) {
      return players;
    }

    return players.filter((creature) => {
      const z = Number(creature?.__position?.z);
      //return Number.isFinite(z) && Math.abs(z - me.z) <= 1;
	  return Number.isFinite(z) && z === me.z;
    });
  }

  function getUnknownVisiblePlayers() {
    const trusted = new Set(getTrustedNames());

    return getVisiblePlayers().filter((creature) => {
      const name = normalizeName(creature?.name);
      return !!name && !trusted.has(name);
    });
  }

  function getTrustedVisiblePlayers() {
    const trusted = new Set(getTrustedNames());

    return getVisiblePlayers().filter((creature) => {
      const name = normalizeName(creature?.name);
      return !!name && trusted.has(name);
    });
  }

  function getVisibleGameMasters() {
    const gameMasters = new Set(getGameMasterNames());

    return getVisiblePlayers().filter((creature) => {
      const name = normalizeName(creature?.name);
      return !!name && gameMasters.has(name);
    });
  }

  function getRecentChannelMessages() {
    return (window.gameClient?.interface?.channelManager?.channels || []).flatMap((channel) =>
      (channel?.__contents || []).map((entry) => ({
        channelName: channel?.name || null,
        message: String(entry?.message || ""),
        time: entry?.__time || null,
      }))
    );
  }

  function parseDamageMessage(entry) {
    const match = entry.message.match(
      /^You lose\s+(\d+)\s+hitpoints\s+due to an attack by\s+(.+?)\.$/i
    );

    if (!match) {
      return null;
    }

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

  function getReturnDelayMs() {
    const baseDelayMs = normalizeDelayMs(config.returnDelayMs, 0);
    const jitterMs = normalizeDelayMs(config.returnDelayJitterMs, 0);
    if (!jitterMs) {
      return baseDelayMs;
    }

    const randomOffset = Math.floor(Math.random() * ((jitterMs * 2) + 1)) - jitterMs;
    return Math.max(0, baseDelayMs + randomOffset);
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
    if (!config.returnToOriginEnabled) {
      clearPendingReturn();
      return;
    }

    if (!state.pendingReturnOrigin && origin) {
      state.pendingReturnOrigin = origin;
      state.pendingReturnModules = snapshotInterruptedModules();
    }

    if (!state.pendingReturnOrigin) {
      return;
    }

    state.lastThreatAt = now;
    state.returnNotBeforeAt = now + getReturnDelayMs();
  }

  function isReturnCoastClear() {
    return !getVisibleGameMasters().length && !getUnknownVisiblePlayers().length;
  }

  function restoreInterruptedModules() {
    if (state.pendingReturnModules?.caveRunning) {
      bot.cave?.start?.();
    }

    if (state.pendingReturnModules?.equipRingRunning) {
      bot.equipRing?.start?.();
      bot.ui?.refreshEquipRingStatus?.();
    }
  }

  function tryReturnToOrigin(now = Date.now()) {
    if (!config.returnToOriginEnabled || !state.pendingReturnOrigin || !state.returnNotBeforeAt) {
      return false;
    }

    if (now < state.returnNotBeforeAt) {
      return false;
    }

    if (!isReturnCoastClear()) {
      return false;
    }

    if (now - state.lastReturnAttemptAt < normalizeDelayMs(config.returnRetryCooldownMs, 2000)) {
      return false;
    }

    const currentPosition = normalizePosition(bot.getPlayerPosition());
    if (isSamePosition(currentPosition, state.pendingReturnOrigin)) {
      bot.log("panic return completed", {
        origin: state.pendingReturnOrigin,
        threatAgeMs: now - state.lastThreatAt,
      });
      restoreInterruptedModules();
      clearPendingReturn();
      return true;
    }

    state.lastReturnAttemptAt = now;
    const moved =
      !!bot.cave?.goToPosition?.(state.pendingReturnOrigin) ||
      !!bot.pz?.goToTile?.({ __position: state.pendingReturnOrigin });

    if (moved) {
      bot.log("panic returning to origin", {
        origin: state.pendingReturnOrigin,
        threatAgeMs: now - state.lastThreatAt,
      });
      return true;
    }

    bot.log("panic return pathing failed", { origin: state.pendingReturnOrigin });
    return false;
  }

  function triggerPanic(reason, details = {}) {
    const now = Date.now();
    armPendingReturn(now);

    if (now - state.lastTriggerAt < config.triggerCooldownMs) {
      return false;
    }

    state.lastTriggerAt = now;
    bot.playAlarm?.();
    bot.log("panic triggered", { reason, ...details });

    if (bot.cave?.stop) {
      bot.cave.stop({ persistEnabled: false });
    }

    if (bot.equipRing?.stop) {
      bot.equipRing.stop({ persistEnabled: false });
      bot.ui?.refreshEquipRingStatus?.();
    }

    return !!bot.pz?.goToHomePz?.();
  }

  function triggerGameMasterKillSwitch(players) {
    const detectedPlayers = (players || []).map((player) => player?.name).filter(Boolean);

    bot.playAlarm?.();
    bot.log("game master kill switch triggered", { players: detectedPlayers });

    if (bot.rune?.stop) {
      bot.rune.stop();
    }

    if (bot.eat?.stop) {
      bot.eat.stop();
    }

    if (bot.invisible?.stop) {
      bot.invisible.stop();
    }

    if (bot.magicShield?.stop) {
      bot.magicShield.stop();
    }

    if (bot.cave?.stop) {
      bot.cave.stop();
    }

    if (bot.attack?.stop) {
      bot.attack.stop();
    }

    if (bot.equipRing?.stop) {
      bot.equipRing.stop();
    }

    clearPendingReturn();
    config.unknownPlayerEnabled = false;
    config.healthLossEnabled = false;
    persistConfig();
    stop();

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

  function checkGameMasters() {
    if (!getGameMasterNames().length) {
      return false;
    }

    const visibleGameMasters = getVisibleGameMasters();
    if (!visibleGameMasters.length) {
      return false;
    }

    return triggerGameMasterKillSwitch(visibleGameMasters);
  }

  function checkUnknownPlayers() {
    if (!config.unknownPlayerEnabled) {
      return false;
    }

    const unknownPlayers = getUnknownVisiblePlayers();
    if (!unknownPlayers.length) {
      return false;
    }

    return triggerPanic("unknown-player", {
      players: unknownPlayers.map((player) => player.name),
    });
  }

  function checkHealthLoss() {
    if (!config.healthLossEnabled) {
      return false;
    }

    const playerState = bot.getPlayerState();
    const currentHealth = Number(playerState?.health ?? 0);

    if (state.lastHealth == null) {
      state.lastHealth = currentHealth;
      return false;
    }

    const lostHealth = currentHealth < state.lastHealth;
    state.lastHealth = currentHealth;

    if (!lostHealth) {
      return false;
    }

    const latestDamageEvent = getLatestDamageEvent();
    if (latestDamageEvent && latestDamageEvent.key !== state.lastDamageEventKey) {
      state.lastDamageEventKey = latestDamageEvent.key;

      const trustedNames = new Set(getTrustedNames());
      const attackerName = normalizeName(latestDamageEvent.attackerName);

      if (attackerName && trustedNames.has(attackerName)) {
        bot.log("ignored health-loss panic because attacker is trusted", {
          attacker: latestDamageEvent.attackerName,
          amount: latestDamageEvent.amount,
          currentHealth,
        });
        return false;
      }

      return triggerPanic("health-loss", {
        currentHealth,
        attacker: latestDamageEvent.attackerName,
        amount: latestDamageEvent.amount,
      });
    }

    const unknownPlayers = getUnknownVisiblePlayers();
    if (!unknownPlayers.length) {
      const trustedPlayers = getTrustedVisiblePlayers();
      if (trustedPlayers.length) {
        bot.log("ignored health-loss panic because only trusted players are nearby", {
          players: trustedPlayers.map((player) => player.name),
          currentHealth,
        });
        return false;
      }
    }

    return triggerPanic("health-loss", { currentHealth });
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
  }

  function tick() {
    if (!state.running) return;

    try {
      const triggered = checkGameMasters() || checkUnknownPlayers() || checkHealthLoss();
      if (!triggered) {
        tryReturnToOrigin();
      }
    } finally {
      scheduleNextTick();
    }
  }

  function shouldRun() {
    return !!(getGameMasterNames().length || config.unknownPlayerEnabled || config.healthLossEnabled);
  }

  function start() {
    if (state.running) {
      return false;
    }

    state.running = true;
    state.lastHealth = Number(bot.getPlayerState()?.health ?? 0);
    state.lastDamageEventKey = getLatestDamageEvent()?.key || null;
    bot.log("panic runner started", { ...config });
    tick();
    return true;
  }

  function stop() {
    if (!state.running && state.timerId == null) {
      state.lastHealth = null;
      return false;
    }

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
    if (shouldRun()) {
      start();
    } else {
      stop();
    }
  }

  function updateConfig(nextConfig = {}) {
    const next = { ...nextConfig };

    if (Array.isArray(next.trustedNames)) {
      next.trustedNames = next.trustedNames
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    }

    if (Array.isArray(next.gameMasterNames)) {
      next.gameMasterNames = next.gameMasterNames
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    }

    if ("triggerCooldownMs" in next) {
      next.triggerCooldownMs = normalizeDelayMs(next.triggerCooldownMs, config.triggerCooldownMs);
    }

    if ("returnDelayMs" in next) {
      next.returnDelayMs = normalizeDelayMs(next.returnDelayMs, config.returnDelayMs);
    }

    if ("returnDelayJitterMs" in next) {
      next.returnDelayJitterMs = normalizeDelayMs(next.returnDelayJitterMs, config.returnDelayJitterMs);
    }

    if ("returnRetryCooldownMs" in next) {
      next.returnRetryCooldownMs = normalizeDelayMs(
        next.returnRetryCooldownMs,
        config.returnRetryCooldownMs
      );
    }

    Object.assign(config, next);
    if (!config.returnToOriginEnabled) {
      clearPendingReturn();
    }
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
      visiblePlayers: getVisiblePlayers().map((player) => ({
        id: player.id,
        name: player.name,
        position: player.__position || null,
      })),
      unknownVisiblePlayers: getUnknownVisiblePlayers().map((player) => ({
        id: player.id,
        name: player.name,
        position: player.__position || null,
      })),
      trustedVisiblePlayers: getTrustedVisiblePlayers().map((player) => ({
        id: player.id,
        name: player.name,
        position: player.__position || null,
      })),
      visibleGameMasters: getVisibleGameMasters().map((player) => ({
        id: player.id,
        name: player.name,
        position: player.__position || null,
      })),
      latestDamageEvent: getLatestDamageEvent(),
      lastTriggerAt: state.lastTriggerAt,
      pendingReturn: state.pendingReturnOrigin
        ? {
            origin: { ...state.pendingReturnOrigin },
            modules: state.pendingReturnModules ? { ...state.pendingReturnModules } : null,
            returnNotBeforeAt: state.returnNotBeforeAt,
            lastThreatAt: state.lastThreatAt,
            lastReturnAttemptAt: state.lastReturnAttemptAt,
            coastClear: isReturnCoastClear(),
          }
        : null,
    };
  }

  if (shouldRun()) {
    start();
  }

  bot.panic = {
    start,
    stop,
    status,
    updateConfig,
    getVisiblePlayers,
    getUnknownVisiblePlayers,
    getTrustedVisiblePlayers,
    getVisibleGameMasters,
    getTrustedNames,
    getGameMasterNames,
    config,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installRuneModule = function installRuneModule(bot) {
  const configStorageKey = "minibiaBot.rune.config";
  const state = {
    running: false,
    timerId: null,
    lastRuneAt: 0,
  };
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

    const hp = playerState
      ? { current: playerState.health ?? 0, max: playerState.maxHealth ?? 0 }
      : null;

    const mana = playerState
      ? { current: playerState.mana ?? 0, max: playerState.maxMana ?? 0 }
      : null;

    const foodText =
      document.querySelector('#skill-window div[skill="food"] .skill')?.textContent?.trim() ||
      null;

    let food = null;
    if (foodText) {
      const match = foodText.match(/^(\d{1,2}):(\d{2})$/);
      food = match
        ? {
            text: foodText,
            seconds: Number(match[1]) * 60 + Number(match[2]),
          }
        : { text: foodText, seconds: null };
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
    const cooldownElapsedMs = now - state.lastRuneAt;
    const cooldownRemainingMs = Math.max(0, config.runeCooldownMs - cooldownElapsedMs);
    const cooldownReady = cooldownRemainingMs === 0;

    return {
      hasStats: true,
      enoughHp,
      enoughMana,
      enoughFood,
      cooldownReady,
      cooldownRemainingMs,
      canMakeRune: enoughHp && enoughMana && enoughFood && cooldownReady,
    };
  }

  function canMakeRune(now = Date.now()) {
    return getGateStatus(now).canMakeRune;
  }

  function tryMakeRune() {
    if (!canMakeRune()) {
      return false;
    }

    const sent = bot.sendChat(config.runeSpellWords);
    if (sent) {
      state.lastRuneAt = Date.now();
    }

    return sent;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
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
    if (document.hidden) {
      return;
    }

    runImmediateTick();
  }

  function attachResumeListeners() {
    if (resumeListenersAttached) {
      return;
    }

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) {
      return;
    }

    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;

    try {
      tryMakeRune();
    } catch (error) {
      bot.log("rune tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 250;
    persistConfig();

    if (state.running) {
      bot.log("rune maker already running");
      return false;
    }

    state.running = true;
    attachResumeListeners();
    bot.log("rune maker started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    detachResumeListeners();

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }
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
  if (Object.prototype.hasOwnProperty.call(nextConfig, "targetHotbarSlot")) {
    nextConfig.targetHotbarSlot =
      normalizeHotbarSlot(nextConfig.targetHotbarSlot) ?? config.targetHotbarSlot;
  }

  if (Object.prototype.hasOwnProperty.call(nextConfig, "runeHotbarSlot")) {
    nextConfig.runeHotbarSlot = normalizeHotbarSlot(nextConfig.runeHotbarSlot);
  }

  if (Object.prototype.hasOwnProperty.call(nextConfig, "maxTargetDistance")) {
    nextConfig.maxTargetDistance = Math.max(
      1,
      Math.trunc(Number(nextConfig.maxTargetDistance) || config.maxTargetDistance || 5)
    );
  }

  if (Object.prototype.hasOwnProperty.call(nextConfig, "preferredTargetNames")) {
    if (Array.isArray(nextConfig.preferredTargetNames)) {
      nextConfig.preferredTargetNames = nextConfig.preferredTargetNames
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    } else {
      nextConfig.preferredTargetNames = String(nextConfig.preferredTargetNames || "")
        .split(/[\n,]/)
        .map((name) => name.trim())
        .filter(Boolean);
    }
  }

  if (Object.prototype.hasOwnProperty.call(nextConfig, "preferredMatchMode")) {
    if (
      nextConfig.preferredMatchMode !== "exact" &&
      nextConfig.preferredMatchMode !== "includes"
    ) {
      nextConfig.preferredMatchMode = "exact";
    }
  }

  Object.assign(config, nextConfig);
  persistConfig();

  bot.log("auto attack config updated", { ...config });

  return { ...config };
}

  if (config.enabled) {
    start();
  }

  bot.rune = {
    start,
    stop,
    status,
    readStats,
    getGateStatus,
    canMakeRune,
    tryMakeRune,
    config,
    updateConfig,
  };

  bot.startRuneLoop = start;
  bot.stopRuneLoop = stop;
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

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

  // Clean up old legacy keys
  delete config.hpHotbarSlot;
  delete config.manaHotbarSlot;
  delete config.minHp;
  delete config.minMana;

  // Backward compatibility (if old rules exist)
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
    // Since we don't have type, we check both HP and mana increases
    const hpUp = stats.hp ? stats.hp.current > attempt.hpBefore : false;
    const manaUp = stats.mana ? stats.mana.current > attempt.manaBefore : false;
    // If the action was a spell/hotkey that could restore either, we consider success if either increased.
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

    // If spell, check mana cost
    if (rule.spellWords && rule.spellWords.trim()) {
      const cost = Math.max(1, Number(rule.manaCost) || 0);
      if (stats.mana.current < cost) return false;
    }

    // Don't try to heal if HP is 0 (dead)
    if (stats.hp.current <= 0) return false;

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
          attemptedAt: now,
          slot,
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
        attemptedAt: now,
        slot,
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

  // ... (keep scheduleNextTick, tick, start, stop, status, updateConfig as before, but updateConfig must not expect 'type')
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
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installAutoInvisibleModule = function installAutoInvisibleModule(bot) {
  const configStorageKey = "minibiaBot.invisible.config";
  const INVISIBLE_CONDITION_ID = 4;
  const state = {
    running: false,
    timerId: null,
    lastCastAt: 0,
  };
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
    const invisibleConditionId = getInvisibleConditionId();

    if (conditions?.has) {
      return conditions.has(invisibleConditionId);
    }

    if (player?.hasCondition) {
      return player.hasCondition(invisibleConditionId);
    }

    return false;
  }

  function getGateStatus(now = Date.now()) {
    const cooldownRemainingMs = Math.max(0, config.recastCooldownMs - (now - state.lastCastAt));
    const cooldownReady = cooldownRemainingMs === 0;
    const invisibleActive = isInvisibleActive();

    return {
      invisibleActive,
      cooldownReady,
      cooldownRemainingMs,
      canCast: !invisibleActive && cooldownReady,
    };
  }

  function canCastInvisible(now = Date.now()) {
    return getGateStatus(now).canCast;
  }

  function tryCastInvisible(now = Date.now()) {
    if (!config.enabled || !canCastInvisible(now)) {
      return false;
    }

    const sent = bot.sendChat(config.spellWords);
    if (sent) {
      state.lastCastAt = now;
      bot.log("cast invisible spell", { spellWords: config.spellWords });
    }

    return sent;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
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
    if (document.hidden) {
      return;
    }

    runImmediateTick();
  }

  function attachResumeListeners() {
    if (resumeListenersAttached) {
      return;
    }

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) {
      return;
    }

    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;

    try {
      tryCastInvisible();
    } catch (error) {
      bot.log("auto invisible tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();

    if (state.running) {
      bot.log("auto invisible already running");
      return false;
    }

    state.running = true;
    attachResumeListeners();
    bot.log("auto invisible started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    detachResumeListeners();

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

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
    if (Object.prototype.hasOwnProperty.call(nextConfig, "spellWords")) {
      nextConfig.spellWords = String(nextConfig.spellWords || "").trim() || config.spellWords;
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, "recastCooldownMs")) {
      nextConfig.recastCooldownMs = Math.max(0, Number(nextConfig.recastCooldownMs) || 0);
    }

    Object.assign(config, nextConfig);
    config.tickMs = 500;
    persistConfig();
    bot.log("auto invisible config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) {
    start();
  }

  bot.invisible = {
    start,
    stop,
    status,
    updateConfig,
    isInvisibleActive,
    canCastInvisible,
    tryCastInvisible,
    config,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installAutoMagicShieldModule = function installAutoMagicShieldModule(bot) {
  const configStorageKey = "minibiaBot.magicShield.config";
  const MAGIC_SHIELD_FALLBACK_DURATION_MS = 180000;
  const state = {
    running: false,
    timerId: null,
    lastCastAt: 0,
    assumedActiveUntil: 0,
  };
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
    const conditionManagerPrototype = window.ConditionManager?.prototype;
    const playerConditions = window.gameClient?.player?.conditions;
    const candidateKeys = [
      "MAGIC_SHIELD",
      "MANA_SHIELD",
      "MAGICSHIELD",
      "MANASHIELD",
      "UTAMO_VITA",
    ];

    for (const key of candidateKeys) {
      const value = conditionManagerPrototype?.[key] ?? playerConditions?.[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }

    return null;
  }

  function isMagicShieldActive(now = Date.now()) {
    const player = window.gameClient?.player;
    const conditions = player?.conditions;
    const magicShieldConditionId = getMagicShieldConditionId();

    if (magicShieldConditionId != null) {
      if (conditions?.has) {
        return conditions.has(magicShieldConditionId);
      }

      if (player?.hasCondition) {
        return player.hasCondition(magicShieldConditionId);
      }
    }

    return now < state.assumedActiveUntil;
  }

  function getGateStatus(now = Date.now()) {
    const cooldownRemainingMs = Math.max(0, config.recastCooldownMs - (now - state.lastCastAt));
    const cooldownReady = cooldownRemainingMs === 0;
    const magicShieldActive = isMagicShieldActive(now);

    return {
      magicShieldActive,
      cooldownReady,
      cooldownRemainingMs,
      canCast: !magicShieldActive && cooldownReady,
    };
  }

  function canCastMagicShield(now = Date.now()) {
    return getGateStatus(now).canCast;
  }

  function tryCastMagicShield(now = Date.now()) {
    if (!config.enabled || !canCastMagicShield(now)) {
      return false;
    }

    const sent = bot.sendChat(config.spellWords);
    if (sent) {
      state.lastCastAt = now;
      state.assumedActiveUntil = now + MAGIC_SHIELD_FALLBACK_DURATION_MS;
      bot.log("cast magic shield spell", { spellWords: config.spellWords });
    }

    return sent;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
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
    if (document.hidden) {
      return;
    }

    runImmediateTick();
  }

  function attachResumeListeners() {
    if (resumeListenersAttached) {
      return;
    }

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) {
      return;
    }

    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;

    try {
      tryCastMagicShield();
    } catch (error) {
      bot.log("auto magic shield tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();

    if (state.running) {
      bot.log("auto magic shield already running");
      return false;
    }

    state.running = true;
    attachResumeListeners();
    bot.log("auto magic shield started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    detachResumeListeners();

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

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
    if (Object.prototype.hasOwnProperty.call(nextConfig, "spellWords")) {
      nextConfig.spellWords = String(nextConfig.spellWords || "").trim() || config.spellWords;
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, "recastCooldownMs")) {
      nextConfig.recastCooldownMs = Math.max(0, Number(nextConfig.recastCooldownMs) || 0);
    }

    Object.assign(config, nextConfig);
    config.tickMs = 500;
    persistConfig();
    bot.log("auto magic shield config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) {
    start();
  }

  bot.magicShield = {
    start,
    stop,
    status,
    updateConfig,
    isMagicShieldActive,
    canCastMagicShield,
    tryCastMagicShield,
    config,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

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

    // Preferred targeting:
    // These mobs are sorted first, but non-preferred mobs are still allowed.
    preferredTargetNames: [],
    preferredMatchMode: "exact", // "exact" or "includes"
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
    const value = Number(slot);
    if (!Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.trunc(value);
    if (normalized < 1 || normalized > 12) {
      return null;
    }

    return normalized;
  }

function normalizeCreatureName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function getPreferredTargetNames() {
  if (!Array.isArray(config.preferredTargetNames)) {
    return [];
  }

  return config.preferredTargetNames
    .map((name) => String(name || "").trim())
    .filter(Boolean);
}

function isPreferredCreature(creature) {
  const preferredNames = getPreferredTargetNames();

  if (!creature?.name || preferredNames.length === 0) {
    return false;
  }

  const creatureName = normalizeCreatureName(creature.name);

  return preferredNames.some((preferredName) => {
    const normalizedPreferred = normalizeCreatureName(preferredName);

    if (!normalizedPreferred) {
      return false;
    }

    if (config.preferredMatchMode === "includes") {
      return (
        creatureName === normalizedPreferred ||
        creatureName.includes(normalizedPreferred)
      );
    }

    return creatureName === normalizedPreferred;
  });
}

function getCreatureDistanceFromPlayer(creature) {
  const player = window.gameClient?.player;

  if (!player || !creature) {
    return Number.POSITIVE_INFINITY;
  }

  if (typeof player.getPosition !== "function" || typeof creature.getPosition !== "function") {
    return Number.POSITIVE_INFINITY;
  }

  const playerPos = player.getPosition();
  const creaturePos = creature.getPosition();

  if (!playerPos || !creaturePos || playerPos.z !== creaturePos.z) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(
    Math.abs(Number(playerPos.x) - Number(creaturePos.x)),
    Math.abs(Number(playerPos.y) - Number(creaturePos.y))
  );
}

function getCreaturePriorityScore(creature) {
  const distance = getCreatureDistanceFromPlayer(creature);
  const preferred = isPreferredCreature(creature);

  /*
   * Lower score = better.
   *
   * Preferred creatures get a large bonus,
   * but normal creatures are still valid when no preferred creature is nearby.
   */
  const preferredBonus = preferred ? -1000 : 0;

  return preferredBonus + distance;
}

function sortMonstersByPriority(monsters) {
  return [...monsters].sort((a, b) => {
    const scoreA = getCreaturePriorityScore(a);
    const scoreB = getCreaturePriorityScore(b);

    if (scoreA !== scoreB) {
      return scoreA - scoreB;
    }

    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
}

function getNearbyMonsters() {
  const monsters = bot.xray?.getVisibleMonsters?.({ sameFloorOnly: true }) || [];

  return sortMonstersByPriority(monsters);
}

  function normalizePosition(value) {
    if (!value) {
      return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return {
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z),
    };
  }

  function getPositionKey(position) {
    return position ? `${position.x},${position.y},${position.z}` : null;
  }

  function isAdjacentTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return false;
    }

    const dx = Math.abs(Number(from.x) - Number(to.x));
    const dy = Math.abs(Number(from.y) - Number(to.y));
    return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
  }

  function getTileDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.max(
      Math.abs(Number(from.x) - Number(to.x)),
      Math.abs(Number(from.y) - Number(to.y))
    );
  }

  function isSameCreature(left, right) {
    if (!left || !right) {
      return false;
    }

    return left === right || left.id === right.id;
  }

  function findNearbyMonster(creature) {
    if (!creature) {
      return null;
    }

    const nearbyMonsters = getNearbyMonsters();
    return nearbyMonsters.find((monster) => isSameCreature(monster, creature)) || null;
  }

  function findNearbyMonsterById(id) {
    if (id == null) {
      return null;
    }

    return getNearbyMonsters().find((monster) => monster?.id === id) || null;
  }

  function getCurrentTarget() {
    return window.gameClient?.player?.__target || null;
  }

  function getCurrentFollowTarget() {
    return window.gameClient?.player?.__followTarget || null;
  }

  function pruneSkippedTargets(now = Date.now()) {
    for (const [id, expiresAt] of state.skippedTargetIds.entries()) {
      if (expiresAt <= now) {
        state.skippedTargetIds.delete(id);
      }
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
    if (!window.gameClient?.player || typeof window.gameClient.send !== "function") {
      return false;
    }

    if (typeof FollowPacket !== "function") {
      return false;
    }

    if (!getCurrentFollowTarget()) {
      return false;
    }

    window.gameClient.player.setFollowTarget(null);
    window.gameClient.send(new FollowPacket(0));
    return true;
  }

  function clearCurrentTarget() {
    if (!window.gameClient?.player || typeof window.gameClient.send !== "function") {
      return false;
    }

    if (typeof TargetPacket !== "function") {
      return false;
    }

    if (!getCurrentTarget()) {
      return false;
    }

    window.gameClient.player.setTarget(null);
    window.gameClient.send(new TargetPacket(0));
    return true;
  }

  function markCombatActive(now = Date.now()) {
    if (!state.combatStartedAt) {
      state.combatStartedAt = now;
    }
  }

  function getCombatTargetCount() {
    return getEngagedTarget() ? 1 : 0;
  }

  function isCombatActive() {
    if (!config.enabled || !state.running) {
      return false;
    }

    return !!getEngagedTarget();
  }

  function syncCombatState(now = Date.now()) {
    if (isCombatActive()) {
      markCombatActive(now);
      return true;
    }

    state.combatStartedAt = 0;
    return false;
  }

  function getEngagedTarget() {
    const currentTarget = getCurrentTarget();
    if (currentTarget) {
      state.engagedTargetId = currentTarget.id;
      return currentTarget;
    }

    if (state.engagedTargetId == null) {
      return null;
    }

    const followTarget = getCurrentFollowTarget();
    if (followTarget && followTarget.id === state.engagedTargetId) {
      return findNearbyMonster(followTarget) || followTarget;
    }

    const nearbyTarget = findNearbyMonsterById(state.engagedTargetId);
    if (nearbyTarget) {
      return nearbyTarget;
    }

    clearEngagedTarget();
    return null;
  }



// New targeting system

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
      dx: null,
      dy: null,
      distance: Number.POSITIVE_INFINITY,
      preferred: false,
      score: Number.POSITIVE_INFINITY,
      ...extra
    };

    return returnDetails ? details : details.valid;
  }

  if (!target) {
    return result(false, { reason: "no target" });
  }

  if (!player) {
    return result(false, { reason: "no player" });
  }

  if (!world) {
    return result(false, { reason: "no world" });
  }

  if (target.id == null) {
    return result(false, { reason: "missing id" });
  }

  if (typeof target.getPosition !== "function") {
    return result(false, { reason: "target has no getPosition" });
  }

  if (typeof player.getPosition !== "function") {
    return result(false, { reason: "player has no getPosition" });
  }

  const playerPos = player.getPosition();
  const targetPos = target.getPosition();

  if (!playerPos || !targetPos) {
    return result(false, { reason: "missing position" });
  }

  if (targetPos.z !== playerPos.z) {
    return result(false, { reason: "different floor" });
  }

  if (
    target.state &&
    typeof target.state.health === "number" &&
    target.state.health <= 0
  ) {
    return result(false, { reason: "dead target" });
  }

  if (
    world.activeCreatures &&
    target.id !== player.id &&
    !Object.prototype.hasOwnProperty.call(world.activeCreatures, target.id)
  ) {
    return result(false, { reason: "not in activeCreatures" });
  }

  let dx = null;
  let dy = null;
  let distance = Number.POSITIVE_INFINITY;

  try {
    const projectedPlayer = playerPos.projected();
    const projectedTarget = targetPos.projected();

    dx = Math.abs(projectedPlayer.x - projectedTarget.x);
    dy = Math.abs(projectedPlayer.y - projectedTarget.y);

    distance = Math.max(
      Math.abs(Number(playerPos.x) - Number(targetPos.x)),
      Math.abs(Number(playerPos.y) - Number(targetPos.y))
    );
  } catch {
    return result(false, { reason: "projection failed" });
  }

  const visible = dx < maxDx && dy < maxDy;

  if (!visible) {
    return result(false, {
      reason: `off screen dx=${dx} dy=${dy}`,
      dx,
      dy,
      distance
    });
  }

  const preferred = isPreferredCreature(target);
  const score = getCreaturePriorityScore(target);

  return result(true, {
    reason: preferred ? "valid preferred" : "valid normal",
    dx,
    dy,
    distance,
    preferred,
    score
  });
}


function setCurrentTarget(target) {
  if (!target || !window.gameClient?.player || typeof window.gameClient.send !== "function") {
    return false;
  }

  if (typeof TargetPacket !== "function") {
    return false;
  }

  const targetInfo = isTargetValidAndOnScreen(target, {
    preferredNames: config.preferredTargetNames || [],
    requirePreferred: false,
    returnDetails: true,
    maxDx: 7,
    maxDy: 5
  });

  if (!targetInfo.valid) {
    console.log("[target] rejected", {
      reason: targetInfo.reason,
      id: target?.id,
      name: target?.name,
      dx: targetInfo.dx,
      dy: targetInfo.dy,
      position: typeof target?.getPosition === "function" ? target.getPosition() : null
    });

    if (state.engagedTargetId === target.id) {
      clearEngagedTarget();
    }

    return false;
  }

  window.gameClient.player.setTarget(target);
  window.gameClient.send(new TargetPacket(target.id));

  state.engagedTargetId = target.id;

  console.log("[target] accepted", {
    id: target.id,
    name: target.name,
    preferred: targetInfo.preferred,
    score: targetInfo.score,
    distance: targetInfo.distance
  });

  return true;
}

///










function getValidatedEngagedTargetInfo() {
  const target = getEngagedTarget();

  if (!target) {
    return {
      valid: false,
      target: null,
      reason: "no engaged target"
    };
  }

  const info = isTargetValidAndOnScreen(target, {
    returnDetails: true,
    maxDx: 7,
    maxDy: 5
  });

  if (!info.valid) {
    return {
      valid: false,
      target,
      reason: info.reason,
      info
    };
  }

  return {
    valid: true,
    target,
    reason: "valid",
    info
  };
}


//
//
//
function setCurrentFollowTarget(target) {
  if (!target || !window.gameClient?.player || typeof window.gameClient.send !== "function") {
    return false;
  }

  if (typeof FollowPacket !== "function") {
    return false;
  }

  const targetInfo = isTargetValidAndOnScreen(target, {
    returnDetails: true,
    maxDx: 7,
    maxDy: 5
  });

  if (!targetInfo.valid) {
    console.log("[follow] rejected invalid follow target", {
      reason: targetInfo.reason,
      id: target?.id,
      name: target?.name,
      dx: targetInfo.dx,
      dy: targetInfo.dy
    });

    if (state.engagedTargetId === target.id) {
      clearEngagedTarget();
    }

    return false;
  }

  if (isSameCreature(getCurrentFollowTarget(), target)) {
    return true;
  }

  window.gameClient.player.setFollowTarget(target);
  window.gameClient.send(new FollowPacket(target.id));
  return true;
}

  function skipTarget(target, reason, now = Date.now(), skipMs = 500) {
    if (!target?.id) {
      return false;
    }

    const until = now + Math.max(500, Number(skipMs) || 0);
    state.skippedTargetIds.set(target.id, until);

    const clearedTarget = isSameCreature(getCurrentTarget(), target) ? clearCurrentTarget() : false;
    const clearedFollow = isSameCreature(getCurrentFollowTarget(), target) ? clearCurrentFollowTarget() : false;

    if (state.engagedTargetId === target.id) {
      clearEngagedTarget();
    } else if (state.lastFollowTargetId === target.id) {
      resetFollowProgress();
    }

    bot.log("skipping auto attack target", {
      id: target.id,
      name: target.name || "Mob",
      reason,
      skippedForMs: Math.max(500, Number(skipMs) || 0),
      clearedTarget,
      clearedFollow,
    });
    return true;
  }

  function isTargetSkipped(target, now = Date.now()) {
    pruneSkippedTargets(now);
    return !!target?.id && (state.skippedTargetIds.get(target.id) || 0) > now;
  }

  function getMonsterCandidates(now = Date.now()) {
  pruneSkippedTargets(now);

  return getNearbyMonsters()
    .filter((monster) => !isTargetSkipped(monster, now))
    .filter((monster) => {
      const info = isTargetValidAndOnScreen(monster, {
        returnDetails: true,
        maxDx: 7,
        maxDy: 5
      });

      return info.valid;
    })
    .sort((left, right) => {
      const leftScore = getCreaturePriorityScore(left);
      const rightScore = getCreaturePriorityScore(right);

      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }

      return Number(left?.id || 0) - Number(right?.id || 0);
    });
}

  function shouldGiveUpTarget(target) {
    const maxTargetDistance = Math.max(1, Number(config.maxTargetDistance) || 5);
    const playerPosition = normalizePosition(bot.getPlayerPosition());
    const targetPosition = normalizePosition(target?.getPosition?.() || target?.__position);
    if (!playerPosition || !targetPosition) {
      return false;
    }

    return getTileDistance(playerPosition, targetPosition) > maxTargetDistance;
  }

  function resetTargetIfTooFar() {
    const currentTarget = getCurrentTarget();
    if (currentTarget && shouldGiveUpTarget(currentTarget)) {
      skipTarget(currentTarget, "target too far", Date.now(), 500);
      bot.log("gave up distant auto attack target", {
        id: currentTarget.id,
        name: currentTarget.name || "Mob",
        position: normalizePosition(currentTarget.getPosition?.() || currentTarget.__position),
        maxTargetDistance: Math.max(1, Number(config.maxTargetDistance) || 5),
      });
      return true;
    }

    const engagedTarget = getEngagedTarget();
    if (engagedTarget && shouldGiveUpTarget(engagedTarget)) {
      skipTarget(engagedTarget, "engaged target too far", Date.now(), 500);
      bot.log("gave up distant auto attack target", {
        id: engagedTarget.id,
        name: engagedTarget.name || "Mob",
        position: normalizePosition(engagedTarget.getPosition?.() || engagedTarget.__position),
        maxTargetDistance: Math.max(1, Number(config.maxTargetDistance) || 5),
      });
      return true;
    }

    return false;
  }

  function getTileFromPosition(position) {
    if (!position || typeof Position !== "function") {
      return null;
    }

    return window.gameClient?.world?.getTileFromWorldPosition?.(
      new Position(position.x, position.y, position.z)
    ) || null;
  }

  function findReachableAdjacentPosition(targetPosition, playerPosition) {
    if (!targetPosition || !playerPosition) {
      return null;
    }

    const offsets = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];

    offsets.sort((a, b) => {
      const da = Math.abs(targetPosition.x + a.x - playerPosition.x) +
        Math.abs(targetPosition.y + a.y - playerPosition.y);
      const db = Math.abs(targetPosition.x + b.x - playerPosition.x) +
        Math.abs(targetPosition.y + b.y - playerPosition.y);
      return da - db;
    });

    const pathfinder = window.gameClient?.world?.pathfinder;
    const startTile = getTileFromPosition(playerPosition);
    if (!pathfinder || !startTile || typeof pathfinder.search !== "function") {
      return null;
    }

    for (const offset of offsets) {
      const candidatePosition = {
        x: targetPosition.x + offset.x,
        y: targetPosition.y + offset.y,
        z: targetPosition.z,
      };
      const tile = getTileFromPosition(candidatePosition);
      if (!tile?.isWalkable?.()) {
        continue;
      }

      if (candidatePosition.x === playerPosition.x && candidatePosition.y === playerPosition.y) {
        return candidatePosition;
      }

      try {
        const path = pathfinder.search(startTile, tile);
        if (Array.isArray(path) && path.length > 0) {
          return candidatePosition;
        }
      } catch (error) {
        bot.log("auto attack reachability check failed", {
          ...candidatePosition,
          error: error?.message || error,
        });
        return null;
      }
    }

    return null;
  }


  function syncMeleeChase(now = Date.now()) {
    if (!config.meleeMode) {
      return false;
    }

const engaged = getValidatedEngagedTargetInfo();

if (!engaged.valid) {
  if (engaged.target) {
    skipTarget(engaged.target, engaged.reason || "invalid engaged target", now, 1000);
  } else {
    clearEngagedTarget();
  }

  return false;
}

const target = engaged.target;


    const playerPosition = normalizePosition(bot.getPlayerPosition());
    const targetPosition = normalizePosition(target.getPosition?.() || target.__position);
    if (!playerPosition || !targetPosition || playerPosition.z !== targetPosition.z) {
      return false;
    }

    const giveUpDelayMs = Math.max(500, (Number(config.tickMs) || 0) * 10);

    if (isAdjacentTile(playerPosition, targetPosition)) {
      state.lastChaseDestinationKey = null;
      clearCurrentFollowTarget();
      resetFollowProgress();
      return false;
    }

    const adjacentPosition = findReachableAdjacentPosition(targetPosition, playerPosition);
    if (!adjacentPosition) {
      if (!state.lastFollowStallAt) {
        state.lastFollowStallAt = now;
        return false;
      }

      if (now - state.lastFollowStallAt > giveUpDelayMs) {
        return skipTarget(target, "no reachable adjacent tile", now);
      }

      return false;
    }

    const currentDistance = getTileDistance(playerPosition, targetPosition);
    if (state.lastFollowTargetId !== target.id) {
      state.lastFollowTargetId = target.id;
      state.lastFollowDistance = currentDistance;
      state.lastFollowProgressAt = now;
      state.lastFollowStallAt = 0;
    } else if (currentDistance < state.lastFollowDistance) {
      state.lastFollowDistance = currentDistance;
      state.lastFollowProgressAt = now;
      state.lastFollowStallAt = 0;
    }

    const followed = setCurrentFollowTarget(target);
    if (followed) {
      state.lastChaseAt = now;
      state.lastChaseDestinationKey = getPositionKey(adjacentPosition);
      bot.log("following auto attack target", {
        id: target.id,
        name: target.name || "Mob",
        followTargetId: target.id,
      });
    }

    if (state.lastFollowDistance <= currentDistance) {
      if (!state.lastFollowStallAt) {
        state.lastFollowStallAt = now;
      } else if (now - state.lastFollowStallAt > giveUpDelayMs) {
        return skipTarget(target, "follow made no progress", now);
      }
    }

    return followed;
  }

  function canAttack(now = Date.now()) {
    const slot = normalizeHotbarSlot(config.targetHotbarSlot);
    if (!slot) {
      return false;
    }

    if (now - state.lastTargetHotkeyAt < Math.max(0, Number(config.targetCooldownMs) || 0)) {
      return false;
    }

    if (config.meleeMode) {
      return getMonsterCandidates(now).length > 0 && !getCurrentTarget();
    }

    return getNearbyMonsters().length > 0;
  }

  function triggerAttack(now = Date.now()) {
    if (!canAttack(now)) {
      return false;
    }

    const engagedTarget = getEngagedTarget();
    const preferredTarget = engagedTarget && !isTargetSkipped(engagedTarget, now)
      ? engagedTarget
      : (getMonsterCandidates(now)[0] || null);
    if (preferredTarget && setCurrentTarget(preferredTarget)) {
      state.lastTargetHotkeyAt = now;
      markCombatActive(now);
      bot.log("selected auto attack target", {
        id: preferredTarget.id,
        name: preferredTarget.name || "Mob",
        reason: isSameCreature(preferredTarget, engagedTarget) ? "engaged target" : "nearest candidate",
      });
      return true;
    }

    if (config.meleeMode) {
      return false;
    }

    const slot = normalizeHotbarSlot(config.targetHotbarSlot);
    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      const monsters = getNearbyMonsters();
      state.lastTargetHotkeyAt = now;
      markCombatActive(now);
      bot.log("used auto attack target hotkey", {
        slot,
        nearbyMonsters: monsters.map((creature) => creature.name || "Mob"),
      });
    }

    return clicked;
  }

  function canUseRune(now = Date.now()) {
    const slot = normalizeHotbarSlot(config.runeHotbarSlot);
    if (!slot || !getCurrentTarget()) {
      return false;
    }

    if (now - state.lastRuneHotkeyAt < Math.max(0, Number(config.runeCooldownMs) || 0)) {
      return false;
    }

    return true;
  }

  function triggerRune(now = Date.now()) {
    if (!canUseRune(now)) {
      return false;
    }

    const slot = normalizeHotbarSlot(config.runeHotbarSlot);
    const clicked = bot.clickHotbar(slot - 1);
    if (clicked) {
      state.lastRuneHotkeyAt = now;
      markCombatActive(now);
      bot.log("used auto attack rune hotkey", {
        slot,
        target: getCurrentTarget()?.name || "Mob",
      });
    }

    return clicked;
  }

  function tryAttack() {
    if (!config.enabled) {
      return false;
    }

    const now = Date.now();
    if (resetTargetIfTooFar()) {
      return true;
    }

    syncCombatState(now);

    if (config.meleeMode) {
      const chased = syncMeleeChase(now);
      if (getCurrentTarget()) {
        return false;
      }

      if (chased) {
        return triggerAttack(now) || true;
      }
    }

    if (getCurrentTarget()) {
      return triggerRune(now);
    }

    return triggerAttack(now);
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
  }

  function tick() {
    if (!state.running) return;

    try {
      tryAttack();
    } catch (error) {
      bot.log("auto attack tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    persistConfig();

    if (state.running) {
      bot.log("auto attack already running");
      return false;
    }

    state.running = true;
    bot.log("auto attack started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

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
      currentTarget: getCurrentTarget()
        ? {
            id: getCurrentTarget().id,
            name: getCurrentTarget().name,
            type: getCurrentTarget().type,
            position: getCurrentTarget().__position || null,
          }
        : null,
      nearbyMonsters: getNearbyMonsters().map((creature) => ({
        id: creature.id,
        name: creature.name,
        type: creature.type,
        position: creature.__position || null,
      })),
    };
  }

  function updateConfig(nextConfig = {}) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, "targetHotbarSlot")) {
      nextConfig.targetHotbarSlot = normalizeHotbarSlot(nextConfig.targetHotbarSlot) ?? config.targetHotbarSlot;
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, "runeHotbarSlot")) {
      nextConfig.runeHotbarSlot = normalizeHotbarSlot(nextConfig.runeHotbarSlot);
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, "maxTargetDistance")) {
      nextConfig.maxTargetDistance = Math.max(1, Math.trunc(Number(nextConfig.maxTargetDistance) || config.maxTargetDistance || 5));
    }

    Object.assign(config, nextConfig);
    persistConfig();
    bot.log("auto attack config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) {
    start();
  }

  bot.addCleanup(() => {
    stop({ persistEnabled: false });
  });

  bot.attack = {
    start,
    stop,
    status,
    updateConfig,
    tryAttack,
    canAttack,
    triggerAttack,
    canUseRune,
    triggerRune,
    getNearbyMonsters,
    getCurrentTarget,
    getCurrentFollowTarget,
    isCombatActive,
    syncMeleeChase,
    normalizeHotbarSlot,
    config,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

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
    /\bstone pile\b/i,
    /\bloose stone pile\b/i,
    /\bgravel pile\b/i,
    /\bdirt pile\b/i,
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
  };
  const minimapOverlayState = {
    timerId: null,
  };

  const config = Object.assign(
    {
      tickMs: 500,
      repathMs: 1500,
      waypointTolerance: 0,
      enabled: false,
      activePresetName: defaultPresetName,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 500;

  function normalizePresetName(value) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    return normalized || null;
  }

  function cloneValue(value) {
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  function normalizePreset(value) {
    if (!value) {
      return null;
    }

    const name = normalizePresetName(value.name);
    if (!name) {
      return null;
    }

    return {
      name,
      route: normalizeRoute(value.route),
      transitions: normalizeTransitions(value.transitions),
    };
  }

  function normalizePresets(value) {
    const entries = Array.isArray(value) ? value : [];
    const deduped = new Map();

    entries.map(normalizePreset).filter(Boolean).forEach((preset) => {
      deduped.set(preset.name.toLowerCase(), preset);
    });

    return Array.from(deduped.values());
  }

  let route = normalizeRoute(bot.storage.get(routeStorageKey, []));
  let transitions = normalizeTransitions(bot.storage.get(transitionStorageKey, []));
  let presets = normalizePresets(bot.storage.get(presetStorageKey, []));

  if (!presets.length && (route.length || transitions.length)) {
    presets = [{
      name: defaultPresetName,
      route: route.map((waypoint) => cloneValue(waypoint)),
      transitions: transitions.map((transition) => cloneValue(transition)),
    }];
  }

  function getPresetNames() {
    return presets.map((preset) => preset.name);
  }

  function getPresetByName(name) {
    const normalizedName = normalizePresetName(name);
    if (!normalizedName) {
      return null;
    }

    return presets.find((preset) => preset.name.toLowerCase() === normalizedName.toLowerCase()) || null;
  }

  function getActivePresetName() {
    const configuredName = normalizePresetName(config.activePresetName);
    if (configuredName && getPresetByName(configuredName)) {
      return getPresetByName(configuredName).name;
    }

    if (presets.length) {
      return presets[0].name;
    }

    return configuredName || defaultPresetName;
  }

  function persistPresets() {
    bot.storage.set(
      presetStorageKey,
      presets.map((preset) => ({
        name: preset.name,
        route: preset.route.map((waypoint) => ({ ...waypoint })),
        transitions: preset.transitions.map((transition) => cloneValue(transition)),
      }))
    );
  }

  function persistLegacyActivePreset() {
    bot.storage.set(routeStorageKey, route.map((waypoint) => ({ ...waypoint })));
    bot.storage.set(transitionStorageKey, transitions.map((transition) => cloneValue(transition)));
  }

  function setActivePresetName(name) {
    config.activePresetName = normalizePresetName(name) || defaultPresetName;
    persistConfig();
    return config.activePresetName;
  }

  function upsertPreset(name, nextRoute = route, nextTransitions = transitions) {
    const normalizedName = normalizePresetName(name);
    if (!normalizedName) {
      return null;
    }

    const preset = {
      name: normalizedName,
      route: normalizeRoute(nextRoute).map((waypoint) => cloneValue(waypoint)),
      transitions: normalizeTransitions(nextTransitions).map((transition) => cloneValue(transition)),
    };
    const existingIndex = presets.findIndex((entry) => entry.name.toLowerCase() === normalizedName.toLowerCase());

    if (existingIndex >= 0) {
      presets[existingIndex] = preset;
    } else {
      presets.push(preset);
    }

    persistPresets();
    return preset;
  }

  function persistActivePreset() {
    upsertPreset(getActivePresetName(), route, transitions);
    persistLegacyActivePreset();
  }

  function loadPresetState(name) {
    const preset = getPresetByName(name);
    if (!preset) {
      return null;
    }

    route = normalizeRoute(preset.route);
    transitions = normalizeTransitions(preset.transitions);
    state.currentIndex = 0;
    state.direction = 1;
    state.pendingTransitionSource = null;
    setActivePresetName(preset.name);
    persistLegacyActivePreset();
    return preset;
  }

  const initialActivePreset = getActivePresetName();
  if (loadPresetState(initialActivePreset)) {
    config.activePresetName = initialActivePreset;
  } else {
    setActivePresetName(initialActivePreset);
  }

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function persistRoute() {
    persistActivePreset();
  }

  function normalizePosition(value) {
    if (!value) {
      return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    return {
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z),
    };
  }

  function normalizeWaypoint(waypoint) {
    return normalizePosition(waypoint);
  }

  function normalizeRoute(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map(normalizeWaypoint).filter(Boolean);
  }

  function normalizeTransition(transition) {
    if (!transition) {
      return null;
    }

    const from = normalizePosition(transition.from || transition);
    const to = normalizePosition(transition.to || {
      x: transition.targetX,
      y: transition.targetY,
      z: transition.targetZ,
    });

    if (!from || !to || from.z === to.z) {
      return null;
    }

    const count = Math.max(1, Math.trunc(Number(transition.count) || 1));
    const lastSeenAt = Math.max(0, Math.trunc(Number(transition.lastSeenAt) || Date.now()));

    return { from, to, count, lastSeenAt };
  }

  function normalizeTransitions(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const deduped = new Map();
    value.map(normalizeTransition).filter(Boolean).forEach((transition) => {
      deduped.set(getPositionKey(transition.from), transition);
    });
    return Array.from(deduped.values());
  }

  function getRoute() {
    return route.map((waypoint) => cloneValue(waypoint));
  }

  function getTransitions() {
    return transitions.map((transition) => cloneValue(transition));
  }

  function persistTransitions() {
    persistActivePreset();
  }

  function savePreset(name, options = {}) {
    const preset = upsertPreset(name, route, transitions);
    if (!preset) {
      bot.log("cave preset name is required");
      return null;
    }

    if (options.activate !== false) {
      setActivePresetName(preset.name);
      persistLegacyActivePreset();
    }

    bot.log("cave preset saved", {
      name: preset.name,
      waypoints: preset.route.length,
      transitions: preset.transitions.length,
    });
    return {
      name: preset.name,
      route: preset.route.map((waypoint) => cloneValue(waypoint)),
      transitions: preset.transitions.map((transition) => cloneValue(transition)),
    };
  }

  function createPreset(name) {
    const normalizedName = normalizePresetName(name);
    if (!normalizedName) {
      bot.log("cave preset name is required");
      return null;
    }

    if (getPresetByName(normalizedName)) {
      bot.log("cave preset already exists", { name: normalizedName });
      return null;
    }

    if (state.running) {
      stop();
    }

    const preset = upsertPreset(normalizedName, [], []);
    if (!preset) {
      return null;
    }

    loadPresetState(preset.name);
    bot.log("cave preset created", { name: preset.name });
    return {
      name: preset.name,
      route: [],
      transitions: [],
    };
  }

  function loadPreset(name) {
    const preset = getPresetByName(name);
    if (!preset) {
      bot.log("cave preset not found", { name });
      return null;
    }

    if (state.running) {
      stop();
    }

    loadPresetState(preset.name);
    bot.log("cave preset loaded", {
      name: preset.name,
      waypoints: route.length,
      transitions: transitions.length,
    });
    return {
      name: preset.name,
      route: getRoute(),
      transitions: getTransitions(),
    };
  }

  function deletePreset(name) {
    const preset = getPresetByName(name);
    if (!preset) {
      bot.log("cave preset not found", { name });
      return false;
    }

    presets = presets.filter((entry) => entry.name.toLowerCase() !== preset.name.toLowerCase());
    persistPresets();

    if (preset.name.toLowerCase() === getActivePresetName().toLowerCase()) {
      const fallbackPreset = presets[0] || null;
      if (state.running) {
        stop();
      }

      if (fallbackPreset) {
        loadPresetState(fallbackPreset.name);
      } else {
        route = [];
        transitions = [];
        state.currentIndex = 0;
        state.direction = 1;
        state.pendingTransitionSource = null;
        setActivePresetName(defaultPresetName);
        persistLegacyActivePreset();
      }
    }

    bot.log("cave preset deleted", { name: preset.name });
    return true;
  }

  function getCurrentWaypoint() {
    if (!route.length) {
      return null;
    }

    if (state.currentIndex < 0 || state.currentIndex >= route.length) {
      state.currentIndex = 0;
    }

    return route[state.currentIndex] || null;
  }

  function getPositionKey(position) {
    return position ? `${position.x},${position.y},${position.z}` : null;
  }

  function getDistance(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.abs(Number(from.x) - Number(to.x)) + Math.abs(Number(from.y) - Number(to.y));
  }

  function isBesideOrSameTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return false;
    }

    return Math.abs(Number(from.x) - Number(to.x)) <= 1 &&
      Math.abs(Number(from.y) - Number(to.y)) <= 1;
  }

  function isAdjacentTile(from, to) {
    if (!from || !to || Number(from.z) !== Number(to.z)) {
      return false;
    }

    const dx = Math.abs(Number(from.x) - Number(to.x));
    const dy = Math.abs(Number(from.y) - Number(to.y));
    return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
  }

  function getDistanceToWaypoint(position, waypoint) {
    if (!position || !waypoint) {
      return null;
    }

    return getDistance(position, waypoint);
  }

  function isSameTile(a, b) {
    if (!a || !b) {
      return false;
    }

    return Number(a.x) === Number(b.x) &&
      Number(a.y) === Number(b.y) &&
      Number(a.z) === Number(b.z);
  }

  function findClosestWaypointIndex(position) {
    if (!position || !route.length) {
      return 0;
    }

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    route.forEach((waypoint, index) => {
      const distance = getDistanceToWaypoint(position, waypoint);
      if (!Number.isFinite(distance)) {
        return;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  function getTileAt(position) {
    if (!position) {
      return null;
    }

    return window.gameClient?.world?.getTileFromWorldPosition?.(
      new Position(position.x, position.y, position.z)
    ) || null;
  }

  function getTilePosition(tile) {
    return normalizePosition(tile?.__position);
  }

  function getThingDefinition(itemId) {
    if (!itemId) {
      return null;
    }

    return (
      window.gameClient?.itemDefinitionsByCid?.[itemId] ||
      window.gameClient?.itemDefinitionsBySid?.[itemId] ||
      window.gameClient?.itemDefinitions?.[itemId] ||
      null
    );
  }

  function getThingName(thing) {
    const definition = getThingDefinition(thing?.id);
    return String(definition?.properties?.name || thing?.name || "").trim().toLowerCase();
  }

  function isLadderThing(thing) {
    if (!thing?.id) {
      return false;
    }

    if (ladderItemIds.has(Number(thing.id))) {
      return true;
    }

    return getThingName(thing).includes("ladder");
  }

  function isFloorChangeThing(thing) {
    const definition = getThingDefinition(thing?.id);
    return !!definition?.properties?.floorchange || isLadderThing(thing);
  }

  function isFloorChangeTile(tile) {
    const tilePosition = getTilePosition(tile);
    if (!tilePosition) {
      return false;
    }

    if (isFloorChangeThing(tile)) {
      return true;
    }

    return Array.isArray(tile.items) && tile.items.some((item) => isFloorChangeThing(item));
  }

  function getTileThings(tile) {
    if (!tile) {
      return [];
    }

    const things = [];
    if (tile.id) {
      things.push(tile);
    }
    if (Array.isArray(tile.items)) {
      tile.items.forEach((item) => {
        if (item) {
          things.push(item);
        }
      });
    }
    return things;
  }

  function tileHasNamedThing(tile, needle) {
    const value = String(needle || "").trim().toLowerCase();
    if (!value) {
      return false;
    }

    return getTileThings(tile).some((thing) => getThingName(thing).includes(value));
  }

  function isLadderTile(tile) {
    return getTileThings(tile).some((thing) => isLadderThing(thing));
  }

  function isStairsTile(tile) {
    return tileHasNamedThing(tile, "stairs");
  }

  function isHoleTile(tile) {
    return tileHasNamedThing(tile, "hole");
  }

  function isRopeSpotTile(tile) {
    return tileHasNamedThing(tile, "rope spot");
  }

  function isRopeTargetTile(tile) {
    return isHoleTile(tile) || isRopeSpotTile(tile);
  }

  function isShovelTargetThing(thing) {
    const name = getThingName(thing);
    if (!name) {
      return false;
    }

    return shovelTargetNamePatterns.some((pattern) => pattern.test(name));
  }

  function isShovelTargetTile(tile) {
    return getTileThings(tile).some((thing) => isShovelTargetThing(thing));
  }

  function isTransitionCandidateTile(tile, waypoint, position) {
    if (!tile) {
      return false;
    }

    if (isFloorChangeTile(tile)) {
      return true;
    }

    const hasWaypointDelta =
      waypoint &&
      position &&
      Number.isFinite(waypoint.z) &&
      Number.isFinite(position.z);

    if (!hasWaypointDelta) {
      return false;
    }

    if (waypoint.z > position.z) {
      return isShovelTargetTile(tile);
    }

    if (waypoint.z < position.z) {
      return isRopeTargetTile(tile);
    }

    return false;
  }

  function getFloorChangeTileBias(tile, position, waypoint) {
    if (!tile || !position || !waypoint || position.z === waypoint.z) {
      return 0;
    }

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
        if (tile?.__position) {
          tiles.push(tile);
        }
      }
    }

    return tiles;
  }

  function ensureMinimapOverlayStyle() {
    if (document.getElementById(minimapOverlayStyleId)) {
      return;
    }

    const style = document.createElement("style");
    style.id = minimapOverlayStyleId;
    style.textContent = `
      #${minimapOverlayRootId} {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 999997;
      }

      #${minimapOverlayRootId} canvas {
        position: fixed;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureMinimapOverlayRoot() {
    let root = document.getElementById(minimapOverlayRootId);
    if (root) {
      return root;
    }

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
    if (!(canvas instanceof HTMLCanvasElement)) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return { canvas, rect };
  }

  function getWaypointCanvasPoint(waypoint, viewport, playerPosition, minimap) {
    if (!waypoint || !viewport || !playerPosition || !minimap) {
      return null;
    }

    if (waypoint.z !== minimap.__renderLayer) {
      return null;
    }

    const zoomScale = 1 << (Number(minimap.__zoomLevel) || 0);
    const center = minimap.center || { x: 0, y: 0 };
    const internalWidth = Number(viewport.canvas.width) || 160;
    const internalHeight = Number(viewport.canvas.height) || 160;
    const internalX = (internalWidth / 2) + (waypoint.x - playerPosition.x - Number(center.x || 0)) * zoomScale;
    const internalY = (internalHeight / 2) + (waypoint.y - playerPosition.y - Number(center.y || 0)) * zoomScale;

    return {
      x: internalX * (viewport.rect.width / internalWidth),
      y: internalY * (viewport.rect.height / internalHeight),
    };
  }

  function renderMinimapOverlay() {
    const viewport = getMinimapViewport();
    const minimap = window.gameClient?.renderer?.minimap;
    const playerPosition = normalizePosition(bot.getPlayerPosition());
    const root = ensureMinimapOverlayRoot();
    const canvas = root.querySelector("canvas");

    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }

    if (!viewport || !minimap || !playerPosition || !route.length) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    const rect = viewport.rect;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    canvas.style.left = `${Math.round(rect.left)}px`;
    canvas.style.top = `${Math.round(rect.top)}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const visibleWaypoints = route
      .map((waypoint, index) => ({
        waypoint,
        index,
        point: getWaypointCanvasPoint(waypoint, viewport, playerPosition, minimap),
      }))
      .filter((entry) => entry.point);

    if (!visibleWaypoints.length) {
      return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    for (let index = 1; index < visibleWaypoints.length; index += 1) {
      const previous = visibleWaypoints[index - 1];
      const current = visibleWaypoints[index];
      if (current.index !== previous.index + 1) {
        continue;
      }

      context.strokeStyle = "rgba(92, 228, 196, 0.7)";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(previous.point.x, previous.point.y);
      context.lineTo(current.point.x, current.point.y);
      context.stroke();
    }

    visibleWaypoints.forEach(({ point, index }) => {
      const isCurrent = state.running && index === state.currentIndex;
      const radius = isCurrent ? 7 : 5;

      context.fillStyle = isCurrent ? "#ffcf5a" : "#2bd1c4";
      context.strokeStyle = isCurrent ? "#6a2400" : "#083f49";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();

      context.fillStyle = "#ffffff";
      context.font = "bold 11px Verdana, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(index + 1), point.x, point.y);
    });

    context.restore();
  }

  function startMinimapOverlay() {
    if (minimapOverlayState.timerId != null) {
      return;
    }

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

  function getNearbyTransitionTiles(position, waypoint, radius = 8) {
    if (!position) {
      return [];
    }

    return getLoadedTiles()
      .map((tile) => ({ tile, position: getTilePosition(tile) }))
      .filter((entry) =>
        entry.position &&
        entry.position.z === position.z &&
        Math.abs(entry.position.x - position.x) <= radius &&
        Math.abs(entry.position.y - position.y) <= radius &&
        isTransitionCandidateTile(entry.tile, waypoint, position)
      );
  }

  function findTransitionTileNearPosition(position, waypoint, radius = 1) {
    if (!position) {
      return null;
    }

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    getNearbyTransitionTiles(position, waypoint, radius).forEach((entry) => {
      const distance = getDistance(position, entry.position);
      if (!Number.isFinite(distance)) {
        return;
      }

      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    });

    return best;
  }

  function findBestKnownTransition(position, waypoint) {
    if (!position || !waypoint) {
      return null;
    }

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    transitions.forEach((transition) => {
      if (transition.from.z !== position.z || transition.to.z !== waypoint.z) {
        return;
      }

      const playerDistance = getDistance(position, transition.from);
      const landingDistance = getDistance(transition.to, waypoint);
      if (!Number.isFinite(playerDistance) || !Number.isFinite(landingDistance)) {
        return;
      }

      const score = playerDistance * 10 + landingDistance;
      if (score < bestScore) {
        bestScore = score;
        best = transition;
      }
    });

    return best;
  }

  function findNearbyTransitionTile(position, waypoint) {
    if (!position || !waypoint) {
      return null;
    }

    const waypointDistance = Math.abs(position.x - waypoint.x) + Math.abs(position.y - waypoint.y);
    const radius = Math.max(4, Math.min(20, waypointDistance + 2));
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    getNearbyTransitionTiles(position, waypoint, radius).forEach((entry) => {
      const playerDistance = getDistance(position, entry.position);
      const tileToWaypointDistance =
        Math.abs(entry.position.x - waypoint.x) + Math.abs(entry.position.y - waypoint.y);
      const score =
        playerDistance * 10 +
        tileToWaypointDistance +
        getFloorChangeTileBias(entry.tile, position, waypoint);

      if (score < bestScore) {
        bestScore = score;
        best = {
          tile: entry.tile,
          position: entry.position,
          playerDistance,
          waypointDistance: tileToWaypointDistance,
        };
      }
    });

    return best;
  }

  function isAtWaypoint(position, waypoint) {
    const distance = getDistanceToWaypoint(position, waypoint);
    if (!Number.isFinite(distance)) {
      return false;
    }

    return distance <= Math.max(0, Number(config.waypointTolerance) || 0);
  }

  function goToWaypoint(waypoint) {
    const from = bot.getPlayerPosition();
    if (!from || !waypoint) {
      return false;
    }

    const to = new Position(waypoint.x, waypoint.y, waypoint.z);

    try {
      window.gameClient?.world?.pathfinder?.findPath?.(from, to);
      state.lastPathAt = Date.now();
      bot.log("cave pathing to waypoint", {
        ...waypoint,
        index: state.currentIndex + 1,
        total: route.length,
      });
      return true;
    } catch (error) {
      bot.log("cave pathing failed", { ...waypoint, error: error?.message || error });
      return false;
    }
  }

  function goToPosition(position) {
    if (!position) {
      return false;
    }

    return goToWaypoint(position);
  }

  function markPendingTransitionSource(source) {
    const normalized = normalizePosition(source);
    if (!normalized) {
      return;
    }

    state.pendingTransitionSource = {
      ...normalized,
      at: Date.now(),
    };
  }

  function upsertTransition(from, to) {
    const normalizedFrom = normalizePosition(from);
    const normalizedTo = normalizePosition(to);
    if (!normalizedFrom || !normalizedTo || normalizedFrom.z === normalizedTo.z) {
      return null;
    }

    const key = getPositionKey(normalizedFrom);
    const index = transitions.findIndex((transition) => getPositionKey(transition.from) === key);
    const next = {
      from: normalizedFrom,
      to: normalizedTo,
      count: index >= 0 ? transitions[index].count + 1 : 1,
      lastSeenAt: Date.now(),
    };

    if (index >= 0) {
      transitions[index] = next;
    } else {
      transitions.push(next);
    }

    persistTransitions();
    bot.log("cave learned floor transition", next);
    return cloneValue(next);
  }

  function resolveObservedTransitionSource(previousPosition) {
    const pending = normalizePosition(state.pendingTransitionSource);
    if (pending && pending.z === previousPosition.z) {
      return pending;
    }

    const currentTile = getTileAt(previousPosition);
    if (currentTile && isFloorChangeTile(currentTile)) {
      return previousPosition;
    }

    const nearby = findTransitionTileNearPosition(previousPosition, null, 1);
    if (nearby?.position) {
      return nearby.position;
    }

    return null;
  }

  function observePosition() {
    const current = normalizePosition(bot.getPlayerPosition());
    if (!current) {
      return;
    }

    const previous = state.lastObservedPosition;
    if (previous && !isSameTile(previous, current) && previous.z !== current.z) {
      const source = resolveObservedTransitionSource(previous);
      if (source) {
        upsertTransition(source, current);
      }
      state.pendingTransitionSource = null;
    }

    state.lastObservedPosition = current;
  }

  function getEquipment() {
    return window.gameClient?.player?.equipment || null;
  }

  function getOpenContainers() {
    return Array.from(window.gameClient?.player?.__openedContainers || []);
  }

  function findAdjacentWalkablePosition(targetPosition, playerPosition) {
    if (!targetPosition || !playerPosition) {
      return null;
    }

    const offsets = [
      { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
    ];

    offsets.sort((a, b) => {
      const da = Math.abs(targetPosition.x + a.x - playerPosition.x) +
        Math.abs(targetPosition.y + a.y - playerPosition.y);
      const db = Math.abs(targetPosition.x + b.x - playerPosition.x) +
        Math.abs(targetPosition.y + b.y - playerPosition.y);
      return da - db;
    });

    for (const offset of offsets) {
      const position = new Position(
        targetPosition.x + offset.x,
        targetPosition.y + offset.y,
        targetPosition.z
      );
      const tile = window.gameClient?.world?.getTileFromWorldPosition?.(position);
      if (tile?.isWalkable?.()) {
        return normalizePosition(position);
      }
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
    const equipment = getEquipment();

    if (equipment?.slots) {
      for (let slotIndex = 0; slotIndex < equipment.slots.length; slotIndex += 1) {
        const item = equipment.getSlotItem?.(slotIndex);
        if (predicate(item)) {
          return { which: equipment, index: slotIndex, item, location: "equipment" };
        }
      }
    }

    for (const container of getOpenContainers()) {
      const slots = container?.slots || [];
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const item = container.getSlotItem?.(slotIndex);
        if (predicate(item)) {
          return { which: container, index: slotIndex, item, location: "container" };
        }
      }
    }

    return null;
  }

  function findRopeSource() {
    return findToolSource(isRopeItem);
  }

  function findShovelSource() {
    return findToolSource(isShovelItem);
  }

  function useToolOnTile(tool, targetTile, targetPosition, actionLabel, now = Date.now()) {
    if (!tool || !targetTile || !targetPosition) {
      return false;
    }

    const playerPosition = normalizePosition(bot.getPlayerPosition());
    if (!playerPosition) {
      return false;
    }

    if (!isAdjacentTile(playerPosition, targetPosition)) {
      const adjacentPosition = findAdjacentWalkablePosition(targetPosition, playerPosition);
      if (adjacentPosition) {
        return goToPosition(adjacentPosition);
      }
    }

    window.gameClient?.mouse?.__handleItemUseWith?.(
      { which: tool.which, index: tool.index },
      { which: targetTile, index: 0xFF }
    );
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(targetPosition);
    bot.log(actionLabel, {
      source: targetPosition,
      toolLocation: tool.location,
      toolSlot: tool.index,
      toolName: getThingName(tool.item),
    });
    return true;
  }

  function useRopeOnTile(targetTile, targetPosition, now = Date.now()) {
    return useToolOnTile(
      findRopeSource(),
      targetTile,
      targetPosition,
      "cave roped transition tile",
      now
    );
  }

  function useShovelOnTile(targetTile, targetPosition, now = Date.now()) {
    return useToolOnTile(
      findShovelSource(),
      targetTile,
      targetPosition,
      "cave shoveled transition tile",
      now
    );
  }

  function useFloorChangeTile(target, waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    const targetPosition = normalizePosition(target?.position);
    const targetTile = target?.tile || (targetPosition ? getTileAt(targetPosition) : null);
    if (!position || !targetPosition || !targetTile) {
      return false;
    }

    if (now - state.lastStairsUseAt < 1200) {
      return true;
    }

    if (waypoint?.z < position.z && isRopeTargetTile(targetTile)) {
      return useRopeOnTile(targetTile, targetPosition, now);
    }

    if (!isFloorChangeTile(targetTile)) {
      if (waypoint?.z > position.z && isShovelTargetTile(targetTile)) {
        return useShovelOnTile(targetTile, targetPosition, now);
      }
      return false;
    }

    if (isLadderTile(targetTile)) {
      window.gameClient?.mouse?.use?.({ which: targetTile, index: 0xFF });
      state.lastStairsUseAt = now;
      state.lastPathAt = now;
      markPendingTransitionSource(targetPosition);
      bot.log("cave used ladder tile", {
        source: targetPosition,
        targetZ: waypoint?.z ?? null,
      });
      return true;
    }

    if (!isSameTile(position, targetPosition)) {
      return goToPosition(targetPosition);
    }

    const currentTile = getTileAt(position);
    if (!currentTile || !isFloorChangeTile(currentTile)) {
      return false;
    }

    window.gameClient?.mouse?.use?.({ which: currentTile, index: 0xFF });
    state.lastStairsUseAt = now;
    state.lastPathAt = now;
    markPendingTransitionSource(position);
    bot.log("cave used floor-change tile", {
      source: position,
      targetZ: waypoint?.z ?? null,
    });
    return true;
  }

  function handleFloorChange(waypoint, now = Date.now()) {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position || !waypoint || position.z === waypoint.z) {
      return false;
    }

    const visibleCandidate = findNearbyTransitionTile(position, waypoint);
    if (visibleCandidate) {
      const moved = useFloorChangeTile(visibleCandidate, waypoint, now);
      if (moved) {
        bot.log("cave probing visible floor-change tile", {
          tileX: visibleCandidate.position.x,
          tileY: visibleCandidate.position.y,
          tileZ: visibleCandidate.position.z,
          targetZ: waypoint.z,
        });
        return true;
      }
    }

    const knownTransition = findBestKnownTransition(position, waypoint);
    if (knownTransition) {
      const target = {
        tile: getTileAt(knownTransition.from),
        position: knownTransition.from,
      };
      const moved = useFloorChangeTile(target, waypoint, now);
      if (moved) {
        bot.log("cave using learned floor transition", {
          from: knownTransition.from,
          to: knownTransition.to,
          waypoint,
        });
        return true;
      }

      bot.log("cave learned transition unavailable, falling back to live scan", {
        from: knownTransition.from,
        to: knownTransition.to,
        waypoint,
      });
    }
    return false;
  }

  function advanceWaypoint() {
    if (!route.length) {
      return null;
    }

    if (route.length === 1) {
      return route[0];
    }

    let nextIndex = state.currentIndex + state.direction;

    if (nextIndex >= route.length) {
      state.direction = -1;
      nextIndex = route.length - 2;
    } else if (nextIndex < 0) {
      state.direction = 1;
      nextIndex = 1;
    }

    state.currentIndex = Math.max(0, Math.min(route.length - 1, nextIndex));

    const nextWaypoint = getCurrentWaypoint();
    bot.log("cave advanced waypoint", {
      index: state.currentIndex + 1,
      total: route.length,
      direction: state.direction,
      waypoint: nextWaypoint,
    });
    return nextWaypoint;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
  }

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

      if (isAtWaypoint(position, waypoint)) {
        waypoint = advanceWaypoint();
      }

      if (!waypoint) {
        return;
      }

      if (position && waypoint.z !== position.z) {
        handleFloorChange(waypoint, now);
        return;
      }

      const shouldRepath =
        now - state.lastPathAt >= config.repathMs ||
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

  function startObserver() {
    if (state.observerTimerId != null) {
      return;
    }

    state.observerTimerId = window.setInterval(() => {
      try {
        observePosition();
      } catch (error) {
        bot.log("cave observer failed", error?.message || error);
      }
    }, 200);
  }

  function stopObserver() {
    if (state.observerTimerId == null) {
      return;
    }

    window.clearInterval(state.observerTimerId);
    state.observerTimerId = null;
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 500;
    persistConfig();

    if (!route.length) {
      bot.log("cave bot cannot start without waypoints");
      return false;
    }

    if (state.running) {
      bot.log("cave bot already running");
      return false;
    }

    const position = normalizePosition(bot.getPlayerPosition());
    state.running = true;
    state.currentIndex = findClosestWaypointIndex(position);
    state.direction = state.currentIndex >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) {
      state.direction = 1;
    }
    state.lastPathAt = 0;
    state.lastPositionKey = getPositionKey(position);
    state.lastProgressAt = Date.now();
    state.pausedForCombat = false;
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
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }
    state.pausedForCombat = false;
    bot.log("cave bot stopped");
    return true;
  }

  function addWaypoint(waypoint) {
    const normalized = normalizeWaypoint(waypoint);
    if (!normalized) {
      return null;
    }

    route.push(normalized);
    persistRoute();
    bot.log("cave waypoint added", { ...normalized, total: route.length });
    return cloneValue(normalized);
  }

  function addWaypointCurrentSpot() {
    const position = normalizePosition(bot.getPlayerPosition());
    if (!position) {
      bot.log("could not read current position for cave waypoint");
      return null;
    }

    return addWaypoint(position);
  }

  function clearWaypoints() {
    route = [];
    state.currentIndex = 0;
    state.direction = 1;
    persistRoute();
    bot.log("cave route cleared");

    if (state.running) {
      stop();
    }

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
    if (!route.length) {
      return null;
    }

    const removed = route.pop();
    if (state.currentIndex >= route.length) {
      state.currentIndex = Math.max(0, route.length - 1);
    }
    if (route.length <= 1) {
      state.direction = 1;
    }
    persistRoute();
    bot.log("cave waypoint removed", removed);

    if (!route.length && state.running) {
      stop();
    }

    return removed;
  }

  function setCurrentIndex(index) {
    if (!route.length) {
      state.currentIndex = 0;
      state.direction = 1;
      return 0;
    }

    const nextIndex = Math.max(0, Math.min(route.length - 1, Math.trunc(Number(index) || 0)));
    state.currentIndex = nextIndex;
    state.direction = nextIndex >= route.length - 1 ? -1 : 1;
    if (route.length <= 1) {
      state.direction = 1;
    }
    return state.currentIndex;
  }

  function status() {
    const position = normalizePosition(bot.getPlayerPosition());
    const waypoint = getCurrentWaypoint();

    return {
      running: state.running,
      config: { ...config },
      route: getRoute(),
      transitions: getTransitions(),
      presetNames: getPresetNames(),
      activePresetName: getActivePresetName(),
      currentIndex: state.currentIndex,
      direction: state.direction,
      currentWaypoint: cloneValue(waypoint),
      distanceToWaypoint: getDistanceToWaypoint(position, waypoint),
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

  startObserver();
  bot.addCleanup(stopObserver);
  startMinimapOverlay();
  bot.addCleanup(stopMinimapOverlay);

  if (config.enabled && route.length) {
    start();
  }

  bot.cave = {
    start,
    stop,
    status,
    updateConfig,
    config,
    getRoute,
    getTransitions,
    getPresetNames,
    getActivePresetName,
    getCurrentWaypoint,
    createPreset,
    savePreset,
    loadPreset,
    deletePreset,
    addWaypoint,
    addWaypointCurrentSpot,
    clearWaypoints,
    clearTransitions,
    removeLastWaypoint,
    setCurrentIndex,
    goToWaypoint,
    goToPosition,
    handleFloorChange,
    findClosestWaypointIndex,
    findRopeSource,
    findShovelSource,
    inspectNearbyTiles: (radius = 1) => {
      const position = normalizePosition(bot.getPlayerPosition());
      if (!position) {
        return [];
      }

      return getLoadedTiles()
        .map((tile) => ({ tile, position: getTilePosition(tile) }))
        .filter((entry) =>
          entry.position &&
          entry.position.z === position.z &&
          Math.abs(entry.position.x - position.x) <= radius &&
          Math.abs(entry.position.y - position.y) <= radius
        )
        .map((entry) => ({
          position: entry.position,
          isFloorChange: isFloorChangeTile(entry.tile),
          isHole: isHoleTile(entry.tile),
          isRopeTarget: isRopeTargetTile(entry.tile),
          isShovelTarget: isShovelTargetTile(entry.tile),
          names: getTileThings(entry.tile).map((thing) => getThingName(thing)).filter(Boolean),
        }));
    },
    isAtWaypoint,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installEquipRingModule = function installEquipRingModule(bot) {
  const configStorageKey = "minibiaBot.equipRing.config";
  const RING_SLOT = 8;
  const state = {
    running: false,
    timerId: null,
    lastEquipAt: 0,
  };
  let resumeListenersAttached = false;

  const config = Object.assign(
    {
      tickMs: 1000,
      equipCooldownMs: 1500,
      enabled: false,
    },
    bot.storage.get(configStorageKey, {})
  );
  config.tickMs = 1000;

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function getEquipment() {
    return window.gameClient?.player?.equipment || null;
  }

  function getOpenContainers() {
    return Array.from(window.gameClient?.player?.__openedContainers || []);
  }

  function getItemDefinition(item) {
    if (!item) return null;

    return (
      window.gameClient?.itemDefinitionsBySid?.[item.sid] ||
      window.gameClient?.itemDefinitions?.[item.id] ||
      null
    );
  }

  function getItemName(item) {
    const definition = getItemDefinition(item);
    return definition?.properties?.name || item?.name || "";
  }

  function isRingItem(item) {
    if (!item) {
      return false;
    }

    const definition = getItemDefinition(item);
    const slotType = String(
      definition?.properties?.slotType ||
      definition?.properties?.slot ||
      ""
    ).trim().toLowerCase();

    if (slotType === "ring") {
      return true;
    }

    return /\bring\b/i.test(getItemName(item));
  }

  function getEquippedRing() {
    const equipment = getEquipment();
    return equipment?.getSlotItem?.(RING_SLOT) || null;
  }

  function hasEquippedRing() {
    return !!getEquippedRing();
  }

  function findBestRingSource() {
    const equipment = getEquipment();
    if (!equipment) {
      return null;
    }

    let best = null;
    let bestCount = -1;

    const consider = (container, slotIndex, item) => {
      if (!isRingItem(item)) {
        return;
      }

      const count = (typeof item.getCount === "function" ? item.getCount() : item.count) || 1;
      if (count > bestCount) {
        bestCount = count;
        best = { container, slotIndex, item, count, name: getItemName(item) };
      }
    };

    for (let slotIndex = 0; slotIndex < equipment.slots.length; slotIndex += 1) {
      if (slotIndex === RING_SLOT) continue;
      consider(equipment, slotIndex, equipment.getSlotItem(slotIndex));
    }

    getOpenContainers().forEach((container) => {
      (container?.slots || []).forEach((slot, slotIndex) => {
        consider(container, slotIndex, container.getSlotItem(slotIndex));
      });
    });

    return best;
  }

  function getGateStatus(now = Date.now()) {
    const equipment = getEquipment();
    const source = findBestRingSource();
    const cooldownRemainingMs = Math.max(0, config.equipCooldownMs - (now - state.lastEquipAt));

    return {
      hasEquipment: !!equipment,
      hasRingEquipped: hasEquippedRing(),
      hasRingAvailable: !!source,
      cooldownReady: cooldownRemainingMs === 0,
      cooldownRemainingMs,
      source,
      canEquip: !!equipment && !hasEquippedRing() && !!source && cooldownRemainingMs === 0,
    };
  }

  function canEquipRing(now = Date.now()) {
    return getGateStatus(now).canEquip;
  }

  function tryEquipRing(now = Date.now()) {
    if (!config.enabled || !canEquipRing(now)) {
      return false;
    }

    const equipment = getEquipment();
    const source = findBestRingSource();
    if (!equipment || !source) {
      return false;
    }

    const from = {
      which: source.container,
      index: source.slotIndex,
    };
    const to = {
      which: equipment,
      index: RING_SLOT,
    };
    const count = source.count || 1;

    window.gameClient.send(new ItemMovePacket(from, to, count));
    state.lastEquipAt = now;
    bot.log("equipped ring", {
      name: source.name,
      fromContainerId: source.container?.__containerId ?? null,
      fromSlot: source.slotIndex,
    });
    return true;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
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
    if (document.hidden) {
      return;
    }

    runImmediateTick();
  }

  function attachResumeListeners() {
    if (resumeListenersAttached) {
      return;
    }

    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("focus", handleResume);
    window.addEventListener("pageshow", handleResume);
    resumeListenersAttached = true;
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) {
      return;
    }

    document.removeEventListener("visibilitychange", handleResume);
    window.removeEventListener("focus", handleResume);
    window.removeEventListener("pageshow", handleResume);
    resumeListenersAttached = false;
  }

  function tick() {
    if (!state.running) return;

    try {
      tryEquipRing();
    } catch (error) {
      bot.log("equip ring tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 1000;
    persistConfig();

    if (state.running) {
      bot.log("equip ring already running");
      return false;
    }

    state.running = true;
    attachResumeListeners();
    bot.log("equip ring started", { ...config });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    detachResumeListeners();

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }
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

  if (config.enabled) {
    start();
  }

  bot.equipRing = {
    start,
    stop,
    status,
    updateConfig,
    config,
    getEquippedRing,
    hasEquippedRing,
    findBestRingSource,
    getGateStatus,
    canEquipRing,
    tryEquipRing,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installAutoEatModule = function installAutoEatModule(bot) {
  const configStorageKey = "minibiaBot.eat.config";
  const state = {
    running: false,
    timerId: null,
    lastFoodAt: 0,
  };

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
    const value = Number(slot);
    if (!Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.trunc(value);
    if (normalized < 1 || normalized > 12) {
      return null;
    }

    return normalized;
  }

  function readFoodTimer() {
    const foodText =
      document.querySelector('#skill-window div[skill="food"] .skill')?.textContent?.trim() ||
      null;

    if (!foodText) return null;

    const match = foodText.match(/^(\d{1,2}):(\d{2})$/);
    return match
      ? {
          text: foodText,
          seconds: Number(match[1]) * 60 + Number(match[2]),
        }
      : { text: foodText, seconds: null };
  }

  function isSated() {
    const player = window.gameClient?.player;
    const conditions = player?.conditions;

    if (conditions?.has && conditions.SATED != null) {
      return conditions.has(conditions.SATED);
    }

    const food = readFoodTimer();
    if (food?.seconds != null) {
      return food.seconds > 0;
    }

    return true;
  }

  function tryEat() {
    if (!config.enabled) {
      return false;
    }

    if (isSated()) {
      return false;
    }

    if (Date.now() - state.lastFoodAt < config.eatCooldownMs) {
      return false;
    }

    const slot = normalizeHotbarSlot(config.eatHotbarSlot);
    if (!slot) {
      return false;
    }

    const slotIndex = slot - 1;
    const clicked = bot.clickHotbar(slotIndex);

    if (clicked) {
      state.lastFoodAt = Date.now();
      bot.log("used eat hotkey", { slot });
    }

    return clicked;
  }

  function scheduleNextTick() {
    if (!state.running) return;

    state.timerId = window.setTimeout(() => {
      tick();
    }, config.tickMs);
  }

  function tick() {
    if (!state.running) return;

    try {
      tryEat();
    } catch (error) {
      bot.log("auto eat tick failed", error?.message || error);
    } finally {
      scheduleNextTick();
    }
  }

  function start(overrides = {}) {
    Object.assign(config, overrides, { enabled: true });
    config.tickMs = 1000;
    persistConfig();

    if (state.running) {
      bot.log("auto eat already running");
      return false;
    }

    state.running = true;
    bot.log("auto eat started", { eatCooldownMs: config.eatCooldownMs, eatHotbarSlot: config.eatHotbarSlot });
    tick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }
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
    if (Object.prototype.hasOwnProperty.call(nextConfig, "eatHotbarSlot")) {
      nextConfig.eatHotbarSlot = normalizeHotbarSlot(nextConfig.eatHotbarSlot) ?? config.eatHotbarSlot;
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, "eatCooldownMs")) {
      nextConfig.eatCooldownMs = Math.max(0, Number(nextConfig.eatCooldownMs) || 0);
    }

    Object.assign(config, nextConfig);
    config.tickMs = 1000;
    persistConfig();
    bot.log("auto eat config updated", { ...config });
    return { ...config };
  }

  if (config.enabled) {
    start();
  }

  bot.eat = {
    start,
    stop,
    status,
    updateConfig,
    isSated,
    tryEat,
    normalizeHotbarSlot,
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
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installTalkModule = function installTalkModule(bot) {
  const configStorageKey = "minibiaBot.talk.config";
  const legacyDefaultModels = ["gemini-3-pro-preview", "gemini-2.0-flash"];
  const defaultModel = "gemini-2.5-flash-lite";
  const defaultSystemPrompt =
    "You are a normal Tibia MMORPG player chatting in Minibia in live in-game chat. Every reply must sound like Tibia player chat: casual, brief, informal, fully lowercase, and natural for a real player typing quickly. Use plain text only. Keep it under 90 characters and under 12 words. Prefer short Tibia-style phrasing, light slang, abbreviations, and simple punctuation when natural. Avoid polished grammar, title case, or assistant-like wording. Write like someone typing mid-hunt or while afk for a sec. Never say you are a bot or AI.";
  const defaultGreetingPrompt =
    "Respond to greetings like a Tibia MMORPG player in chat. Be short, casual, friendly, and in-character for fast Tibia-style game chat. Use lowercase. One sentence only. Plain text only.";
  const defaultQuestionPrompt =
    "Respond to questions like a Tibia MMORPG player in chat, but stay vague and noncommittal. Keep it brief, casual, and a little evasive. Use lowercase and do not explain much. One short sentence only. Plain text only. If asked whether you are a bot, reply with no.";
  const defaultStatementPrompt =
    "Respond to statements like a Tibia MMORPG player in chat. Keep it short, casual, reactive, and natural for live Tibia-style game chat. Use lowercase. One sentence only. Plain text only.";
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
    },
    bot.storage.get(configStorageKey, {})
  );

  function persistConfig() {
    bot.storage.set(configStorageKey, { ...config });
  }

  function normalizeText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function sanitizeConfig() {
    config.apiKey = String(config.apiKey || "").trim();
    config.model = String(config.model || defaultModel).trim() || defaultModel;
    if (legacyDefaultModels.includes(config.model)) {
      config.model = defaultModel;
    }
    config.pollMs = Math.max(minPollMs, Number(config.pollMs) || minPollMs);
    config.replyCooldownMs = Math.max(0, Number(config.replyCooldownMs) || 1500);
    config.systemPrompt = String(config.systemPrompt || defaultSystemPrompt).trim() || defaultSystemPrompt;
    config.greetingPrompt = String(config.greetingPrompt || defaultGreetingPrompt).trim() || defaultGreetingPrompt;
    config.questionPrompt = String(config.questionPrompt || defaultQuestionPrompt).trim() || defaultQuestionPrompt;
    config.statementPrompt = String(config.statementPrompt || defaultStatementPrompt).trim() || defaultStatementPrompt;
  }

  function trimSeen() {
    const maxSeenEntries = 200;
    if (state.seenKeys.length > maxSeenEntries) {
      state.seenKeys = state.seenKeys.slice(-maxSeenEntries);
    }

    if (state.seenSignatures.length > maxSeenEntries) {
      state.seenSignatures = state.seenSignatures.slice(-maxSeenEntries);
    }
  }

  function getSelfNames() {
    return new Set(
      ["you", bot.getPlayerName?.(), window.gameClient?.player?.name, window.gameClient?.player?.state?.name]
        .map((name) => normalizeText(name))
        .filter(Boolean)
    );
  }

  function extractSenderFromMessage(message) {
    const text = String(message || "").trim();
    if (!text) {
      return { sender: null, body: "" };
    }

    const patterns = [
      /^\[[^\]]+\]\s*([^:\n]{2,40}):\s+(.+)$/i,
      /^([^:\n]{2,40}):\s+(.+)$/i,
      /^([^:\n]{2,40})\s+says:\s+(.+)$/i,
      /^From\s+([^:\n]{2,40}):\s+(.+)$/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          sender: String(match[1] || "").trim() || null,
          body: String(match[2] || "").trim(),
        };
      }
    }

    return { sender: null, body: text };
  }

  function getRawChatEntries() {
    return (window.gameClient?.interface?.channelManager?.channels || []).flatMap((channel) =>
      (channel?.__contents || []).map((entry, index) => ({
        channelName: channel?.name || null,
        entry,
        index,
      }))
    );
  }

  function toChatMessage(rawEntry) {
    const entry = rawEntry?.entry || {};
    const rawMessage = String(entry?.message || entry?.text || "").trim();
    const parsed = extractSenderFromMessage(rawMessage);
    const sender =
      String(entry?.author || entry?.sender || entry?.name || parsed.sender || "").trim() || null;
    const body = String(entry?.text || parsed.body || rawMessage).trim();
    const time = entry?.__time || entry?.time || null;
    const senderType = entry?.type;
    const key = [
      rawEntry?.channelName || "",
      time || "",
      sender || "",
      rawMessage || "",
      rawEntry?.index || 0,
    ].join("|");

    return {
      key,
      channelName: rawEntry?.channelName || null,
      sender,
      body,
      rawMessage,
      time,
      senderType,
    };
  }

  function getChatMessages() {
    return getRawChatEntries().map(toChatMessage).filter((message) => message.body);
  }

  function getMessageTimestamp(message) {
    const rawTime = message?.time;
    if (typeof rawTime === "number" && Number.isFinite(rawTime)) {
      return rawTime < 1e12 ? rawTime * 1000 : rawTime;
    }

    if (rawTime instanceof Date) {
      return rawTime.getTime();
    }

    const parsed = Date.parse(String(rawTime || ""));
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
    if (!message) {
      return;
    }

    if (message.key && !state.seenKeys.includes(message.key)) {
      state.seenKeys.push(message.key);
    }

    const signature = getMessageSignature(message);
    if (signature && !state.seenSignatures.includes(signature)) {
      state.seenSignatures.push(signature);
    }

    trimSeen();
  }

  function rememberSeenMessages(messages) {
    messages.forEach((message) => rememberSeenMessage(message));
  }

  function isSelfMessage(message) {
    if (getSelfNames().has(normalizeText(message?.sender))) {
      return true;
    }

    return [message?.body, message?.rawMessage].some((text) => bot.isRecentSentChat?.(text, 20000));
  }

  function isTrustedSender(message) {
    const senderName = normalizeText(message?.sender);
    if (!senderName) {
      return false;
    }

    const trustedNames = bot.panic?.getTrustedNames?.() || [];
    return trustedNames.includes(senderName);
  }

  function isNpcMessage(message) {
    const npcType = window.CONST?.TYPES?.NPC;
    return npcType != null && message?.senderType === npcType;
  }

  function isWithinVisibleRange(me, pos) {
    if (!me || !pos) {
      return false;
    }

    const dx = Math.abs(pos.x - me.x);
    const dy = Math.abs(pos.y - me.y);
    return dx <= 8 && dy <= 6;
  }

  function isSenderVisiblePlayer(message) {
    const me = bot.getPlayerPosition?.();
    const myId = window.gameClient?.player?.id;
    const senderName = normalizeText(message?.sender);
    const playerType = window.CONST?.TYPES?.PLAYER;

    if (!me || !senderName || playerType == null) {
      return false;
    }

    return Object.values(window.gameClient?.world?.activeCreatures || {}).some((creature) => {
      if (!creature) {
        return false;
      }

      if (creature.id === myId || creature.type !== playerType) {
        return false;
      }

      if (normalizeText(creature.name) !== senderName) {
        return false;
      }

      return isWithinVisibleRange(me, creature.__position);
    });
  }

  function getDefaultMessages() {
    return getChatMessages().filter((message) => message.channelName === "Default");
  }

  function getNewestPendingMessage() {
    const pendingMessages = getDefaultMessages().filter((message) => {
      if (!message?.body || !message?.key) {
        return false;
      }

      if (hasSeenMessage(message)) {
        return false;
      }

      if (!message.sender || isSelfMessage(message) || isNpcMessage(message) || isTrustedSender(message)) {
        rememberSeenMessage(message);
        return false;
      }

      const timestamp = getMessageTimestamp(message);
      if (timestamp && Date.now() - timestamp > maxMessageAgeMs) {
        rememberSeenMessage(message);
        return false;
      }

      return true;
    });

    if (!pendingMessages.length) {
      return null;
    }

    return {
      targetMessage: pendingMessages[pendingMessages.length - 1],
      pendingMessages,
    };
  }

  function buildClassifierPrompt(targetMessage, contextMessages) {
    const transcript = contextMessages
      .map((message) => `${message.sender || "player"}: ${message.body}`)
      .join("\n");

    return [
      "Channel: Default",
      "Recent chat:",
      transcript || "(none)",
      "",
      `Last message from ${targetMessage.sender}: ${targetMessage.body}`,
      "Classify the last message as exactly one label:",
      "greeting",
      "question",
      "statement",
      "Reply with the label only.",
    ].join("\n");
  }

  function getTypePrompt(messageType) {
    if (messageType === "greeting") {
      return config.greetingPrompt;
    }

    if (messageType === "question") {
      return config.questionPrompt;
    }

    return config.statementPrompt;
  }

  function buildReplyPrompt(targetMessage, contextMessages, messageType) {
    const transcript = contextMessages
      .map((message) => `${message.sender || "player"}: ${message.body}`)
      .join("\n");

    return [
      config.systemPrompt,
      getTypePrompt(messageType),
      "",
      "Channel: Default",
      `Message type: ${messageType}`,
      "Recent chat:",
      transcript || "(none)",
      "",
      `Last message from ${targetMessage.sender}: ${targetMessage.body}`,
      "Reply with one short sentence only.",
      "Avoid repeating the same wording again and again.",
      "Reply text only:",
    ].join("\n");
  }

  async function generateText(prompt, generationConfig = {}) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: Object.assign(
            {
              temperature: 0.9,
              topP: 0.95,
              maxOutputTokens: 40,
            },
            generationConfig
          ),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return (
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => String(part?.text || ""))
        .join(" ")
        .trim() || ""
    );
  }

  async function classifyMessageType(targetMessage, contextMessages) {
    const rawType = normalizeText(
      await generateText(buildClassifierPrompt(targetMessage, contextMessages), {
        temperature: 0.1,
        topP: 0.8,
        maxOutputTokens: 8,
      })
    );

    if (rawType === "greeting" || rawType === "question" || rawType === "statement") {
      return rawType;
    }

    if (isGreeting(targetMessage?.body)) {
      return "greeting";
    }

    if (/\?/.test(String(targetMessage?.body || ""))) {
      return "question";
    }

    return "statement";
  }

  function sanitizeReply(text) {
    const singleLine = String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();

    if (!singleLine) {
      return "";
    }

    const firstSentence = singleLine.split(/(?<=[.!?])\s+/)[0] || singleLine;
    const trimmed = firstSentence.slice(0, 90).trim();
    if (!trimmed) {
      return "";
    }

    if (trimmed === "?") {
      return bot.isRecentSentChat?.("?", 20000) ? "" : "?";
    }

    const styled = trimmed
      .toLowerCase()
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\bi am\b/g, "im")
      .replace(/\byou are\b/g, "youre")
      .replace(/\bdo not\b/g, "dont")
      .replace(/\bcannot\b/g, "cant")
      .replace(/\bgoing to\b/g, "gonna")
      .replace(/\bwant to\b/g, "wanna")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/([!?.,]){2,}/g, "$1")
      .trim();

    const normalized = normalizeText(styled);
    if (!normalized || /^[^a-z0-9]+$/i.test(styled)) {
      return "";
    }

    if (/\b(bot|ai|assistant|language model|automation|script)\b/i.test(styled)) {
      return "";
    }

    if (bot.isRecentSentChat?.(styled, 20000)) {
      return "";
    }

    return styled;
  }

  function pickUnusedReply(replies, withinMs = 30000, fallback = "?") {
    for (const reply of replies) {
      if (!bot.isRecentSentChat?.(reply, withinMs)) {
        return reply;
      }
    }

    return fallback;
  }

  function isGreeting(text) {
    return /^(hi|hey|yo|sup|howdy|hello|hiya)\b/i.test(String(text || "").trim());
  }

  function isBotQuestion(text) {
    return /\b(are you|u)\b.*\bbot\b|\bbot\b.*\?|\bare you a bot\b/i.test(String(text || ""));
  }

  function isSimpleReaction(text) {
    return /^(based|true|real|lol|lmao|xd|nice|ok|kk|k)\b[!.?]*$/i.test(String(text || "").trim());
  }

  function pickFallbackReply(targetMessage, messageType) {
    const messageText = String(targetMessage?.body || "").trim();

    if (isBotQuestion(messageText)) {
      return pickUnusedReply(denyBotReplies, 30000, "no");
    }

    if (messageType === "greeting" || isGreeting(messageText)) {
      return pickUnusedReply(greetingReplies, 15000, "yo");
    }

    if (isSimpleReaction(messageText)) {
      return pickUnusedReply(agreeReplies, 15000, "true");
    }

    if (messageType === "question" || /\?$/.test(messageText)) {
      return pickUnusedReply(vagueQuestionReplies, 20000, "maybe");
    }

    return pickUnusedReply(["lol", "maybe", "ya", "true", "kinda"], 30000, "lol");
  }

  async function maybeRespond() {
    if (!state.running || state.pending || !config.enabled || !config.apiKey) {
      return false;
    }

    if (Date.now() - state.lastReplyAt < config.replyCooldownMs) {
      return false;
    }

    const pending = getNewestPendingMessage();
    if (!pending?.targetMessage) {
      return false;
    }

    state.pending = true;

    try {
      const contextMessages = getDefaultMessages().slice(-6);
      if (!isSenderVisiblePlayer(pending.targetMessage)) {
        rememberSeenMessages(pending.pendingMessages);
        bot.log("talk skipped reply", {
          sender: pending.targetMessage.sender,
          message: pending.targetMessage.body,
          reason: "sender-not-visible",
        });
        return false;
      }

      const messageType = await classifyMessageType(pending.targetMessage, contextMessages);
      const rawReply = isBotQuestion(pending.targetMessage.body)
        ? "no"
        : await generateText(buildReplyPrompt(pending.targetMessage, contextMessages, messageType));
      const reply = sanitizeReply(rawReply) || pickFallbackReply(pending.targetMessage, messageType);

      rememberSeenMessages(pending.pendingMessages);

      if (!reply) {
        bot.log("talk skipped reply", {
          sender: pending.targetMessage.sender,
          message: pending.targetMessage.body,
          messageType,
          rawReply,
        });
        return false;
      }

      const sent = bot.sendChat(reply);
      if (sent) {
        state.lastReplyAt = Date.now();
        bot.log("talk replied", {
          sender: pending.targetMessage.sender,
          message: pending.targetMessage.body,
          messageType,
          reply,
        });
      }

      return sent;
    } finally {
      state.pending = false;
    }
  }

  function scheduleNextTick() {
    if (!state.running) {
      return;
    }

    state.timerId = window.setTimeout(async () => {
      try {
        await maybeRespond();
      } catch (error) {
        bot.log("talk request failed", error?.message || error);
      }

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

    if (!config.apiKey) {
      bot.log("talk module requires a Gemini API key");
      return false;
    }

    if (state.running) {
      return false;
    }

    state.running = true;
    seedSeenMessages();
    bot.log("talk module started", {
      model: config.model,
      channel: "Default",
    });
    scheduleNextTick();
    return true;
  }

  function stop(options = {}) {
    const shouldPersistEnabled = options.persistEnabled !== false;
    state.running = false;

    if (shouldPersistEnabled) {
      config.enabled = false;
      persistConfig();
    }

    if (state.timerId != null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    return true;
  }

  function status() {
    return {
      running: state.running,
      pending: state.pending,
      lastReplyAt: state.lastReplyAt,
      config: {
        ...config,
        apiKey: config.apiKey ? "***configured***" : "",
      },
    };
  }

  function updateConfig(nextConfig = {}) {
    Object.assign(config, nextConfig);
    sanitizeConfig();
    persistConfig();
    return status().config;
  }

  sanitizeConfig();

  if (config.enabled && config.apiKey) {
    start();
  }

  bot.talk = {
    start,
    stop,
    status,
    updateConfig,
    getChatMessages,
    config,
  };
};
window.__minibiaBotBundle = window.__minibiaBotBundle || {};

window.__minibiaBotBundle.installPanel = function installPanel(bot) {
  const panelPositionKey = "minibiaBot.ui.panelPosition";
  const panelCollapsedKey = "minibiaBot.ui.panelCollapsed";

  function destroy() {
    document.getElementById("minibia-bot-panel")?.remove();
    document.getElementById("minibia-bot-style")?.remove();
  }
  
	function parsePreferredTargetNames(value) {
	  return String(value || "")
		.split(/[\n,]/)
		.map((name) => name.trim())
		.filter(Boolean)
		.filter((name, index, array) => {
		  return array.findIndex(
			(other) => other.toLowerCase() === name.toLowerCase()
		  ) === index;
		});
	}

	function refreshAutoAttackPreferredStatus(options = {}) {
	  const force = options.force === true;

	  const preferredNamesInput = document.getElementById(
		"minibia-bot-auto-attack-preferred-names"
	  );

	  const preferredMatchModeSelect = document.getElementById(
		"minibia-bot-auto-attack-preferred-match-mode"
	  );

	  const preferredStatus = document.getElementById(
		"minibia-bot-auto-attack-preferred-status"
	  );

	  const attackConfig =
		bot.attack?.status?.().config ||
		bot.attack?.config ||
		{};

	  const preferredNames = Array.isArray(attackConfig.preferredTargetNames)
		? attackConfig.preferredTargetNames
		: [];

	  const preferredMatchMode =
		attackConfig.preferredMatchMode === "includes"
		  ? "includes"
		  : "exact";

	  if (
		preferredNamesInput &&
		(force || document.activeElement !== preferredNamesInput)
	  ) {
		preferredNamesInput.value = preferredNames.join(", ");
	  }

	  if (preferredMatchModeSelect) {
		preferredMatchModeSelect.value = preferredMatchMode;
	  }

	  if (preferredStatus) {
		const namesText = preferredNames.length
		  ? preferredNames.join(", ")
		  : "none";

		const modeText =
		  preferredMatchMode === "includes"
			? "contains text"
			: "exact name";

		preferredStatus.textContent =
		  `Preferred mobs: ${namesText} | Mode: ${modeText}`;
	  }
	}

	function saveAutoAttackPreferredConfig() {
	  const preferredNamesInput = document.getElementById(
		"minibia-bot-auto-attack-preferred-names"
	  );

	  const preferredMatchModeSelect = document.getElementById(
		"minibia-bot-auto-attack-preferred-match-mode"
	  );

	  const preferredTargetNames = parsePreferredTargetNames(
		preferredNamesInput?.value || ""
	  );

	  const preferredMatchMode =
		preferredMatchModeSelect?.value === "includes"
		  ? "includes"
		  : "exact";

	  bot.attack?.updateConfig?.({
		preferredTargetNames,
		preferredMatchMode
	  });

	  refreshAutoAttackPreferredStatus({ force: true });

	  bot.log?.("auto attack preferred targets updated", {
		preferredTargetNames,
		preferredMatchMode
	  });
	}

// --- Heal UI functions (no type) ---
let healEditIndex = null;

function getHealRuleFormValues() {
  const slot = parseInt(document.getElementById("minibia-bot-heal-slot")?.value || "1", 10) || 1;
  const spellWords = document.getElementById("minibia-bot-heal-spell")?.value.trim() || "";
  const manaCost = parseInt(document.getElementById("minibia-bot-heal-manacost")?.value || "0", 10) || 0;
  const minHp = parseInt(document.getElementById("minibia-bot-heal-minhp")?.value || "0", 10) || 0;
  const maxHp = parseInt(document.getElementById("minibia-bot-heal-maxhp")?.value || "100", 10) || 100;
  const minMana = parseInt(document.getElementById("minibia-bot-heal-minmana")?.value || "0", 10) || 0;
  const maxMana = parseInt(document.getElementById("minibia-bot-heal-maxmana")?.value || "100", 10) || 100;
  return { slot, spellWords, manaCost, minHp, maxHp, minMana, maxMana };
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
  if (rules.length === 0) {
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

    // Slot
    const slotLabel = document.createElement("span");
    slotLabel.textContent = `Slot ${rule.slot}`;
    slotLabel.style.cssText = "font-weight:bold;color:#d4c48a;";
    info.appendChild(slotLabel);

    // Action
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

    // HP range
    const hp = document.createElement("span");
    hp.textContent = `HP ${rule.minHpPercent}‑${rule.maxHpPercent}%`;
    hp.style.cssText = "background:#2a1a1a;padding:0 4px;border-radius:3px;color:#ffb0b0;";
    info.appendChild(hp);

    // MP range
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

  if (values.spellWords && values.manaCost <= 0) {
    bot.log("Please enter a Mana Cost for the spell.");
    return;
  }

  const newRule = {
    slot: values.slot,
    spellWords: values.spellWords,
    manaCost: values.manaCost,
    minHpPercent: values.minHp,
    maxHpPercent: values.maxHp,
    minManaPercent: values.minMana,
    maxManaPercent: values.maxMana,
  };

  let rules = (bot.heal?.config?.healRules || []).slice();
  if (healEditIndex !== null) {
    rules[healEditIndex] = newRule;
  } else {
    rules.push(newRule);
  }
  bot.heal.updateConfig({ healRules: rules });
  refreshHealRules();
  refreshAutoHealStatus();
  clearHealRuleForm();
}

function refreshAutoHealStatus() {
  const toggle = document.getElementById("minibia-bot-auto-heal-enabled");
  if (toggle) toggle.checked = !!bot.heal?.status?.().running;
}

  // --- end heal UI functions ---

	function refreshAutoAttackStatus() {
	  const status = bot.attack?.status?.();
	  const attackConfig =
		status?.config ||
		bot.attack?.config ||
		{};

	  const autoAttackEnabledInput = document.getElementById(
		"minibia-bot-auto-attack-enabled"
	  );

	  const autoAttackMeleeInput = document.getElementById(
		"minibia-bot-auto-attack-melee"
	  );

	  const autoAttackHotkeyInput = document.getElementById(
		"minibia-bot-auto-attack-hotkey"
	  );

	  const autoAttackRuneHotkeyInput = document.getElementById(
		"minibia-bot-auto-attack-rune-hotkey"
	  );

	  if (autoAttackEnabledInput) {
		autoAttackEnabledInput.checked = !!status?.running;
	  }

	  if (autoAttackMeleeInput) {
		autoAttackMeleeInput.checked = attackConfig.meleeMode !== false;
	  }

	  if (
		autoAttackHotkeyInput &&
		document.activeElement !== autoAttackHotkeyInput
	  ) {
		autoAttackHotkeyInput.value = String(
		  attackConfig.targetHotbarSlot ?? 3
		);
	  }

	  if (
		autoAttackRuneHotkeyInput &&
		document.activeElement !== autoAttackRuneHotkeyInput
	  ) {
		autoAttackRuneHotkeyInput.value =
		  attackConfig.runeHotbarSlot
			? String(attackConfig.runeHotbarSlot)
			: "";
	  }

	  refreshAutoAttackPreferredStatus();

	  if (typeof refreshTitlebarRunIndicators === "function") {
		refreshTitlebarRunIndicators();
	  }
	}



  function refreshHomeLabel() {
    const homeLabel = document.getElementById("minibia-bot-home");
    if (!homeLabel) return;

    const home = bot.pz?.getHomePz?.();
    homeLabel.textContent = home
      ? `Panic Runner Home: ${home.x}, ${home.y}, ${home.z}`
      : "Panic Runner Home: not set";
  }

  function refreshPanicStatus() {
    const unknownToggle = document.getElementById("minibia-bot-panic-unknown");
    const healthToggle = document.getElementById("minibia-bot-panic-health");
    const returnToggle = document.getElementById("minibia-bot-panic-return");
    const status = bot.panic?.status?.();

    if (unknownToggle) {
      unknownToggle.checked = !!status?.config?.unknownPlayerEnabled;
    }

    if (healthToggle) {
      healthToggle.checked = !!status?.config?.healthLossEnabled;
    }

    if (returnToggle) {
      returnToggle.checked = !!status?.config?.returnToOriginEnabled;
    }
  }

  function refreshXrayStatus() {
    const status = bot.xray?.status?.();
    const me = bot.getPlayerPosition?.();
    const overlayButton = document.getElementById("minibia-bot-xray-overlay-toggle");
    const overlayLabel = document.getElementById("minibia-bot-xray-overlay-status");
    const floorSelect = document.getElementById("minibia-bot-xray-floor-select");
    const formatFloorOffset = (floor) => {
      if (!me || floor == null) {
        return null;
      }

      const offset = me.z - floor;
      return offset === 0 ? "0" : offset > 0 ? `+${offset}` : `${offset}`;
    };

    if (overlayButton) {
      overlayButton.textContent = status?.config?.overlayEnabled ? "Disable Overlay" : "Enable Overlay";
    }

    if (overlayLabel) {
      const floorLabel = status?.config?.selectedFloor == null
        ? "all floors"
        : `${formatFloorOffset(status.config.selectedFloor) ?? "?"}`;
      overlayLabel.textContent = `${status?.config?.overlayEnabled ? "Overlay: on" : "Overlay: off"} • ${floorLabel}`;
    }

    if (floorSelect) {
      const floors = Array.from(
        new Set(
          (status?.visibleCreatures || [])
            .map((creature) => creature?.position?.z)
            .filter((floor) => floor != null)
        )
      ).sort((a, b) => a - b);
      const selectedFloor = status?.config?.selectedFloor;

      if (selectedFloor != null && !floors.includes(selectedFloor)) {
        floors.push(selectedFloor);
        floors.sort((a, b) => a - b);
      }

      floorSelect.innerHTML = "";

      const allOption = document.createElement("option");
      allOption.value = "all";
      allOption.textContent = "All floors";
      floorSelect.appendChild(allOption);

      floors.forEach((floor) => {
        const option = document.createElement("option");
        option.value = String(floor);
        const offsetLabel = formatFloorOffset(floor);
        option.textContent = offsetLabel == null
          ? String(floor)
          : offsetLabel;
        floorSelect.appendChild(option);
      });

      floorSelect.value = selectedFloor == null ? "all" : String(selectedFloor);
    }
  }

  function renderTrustedNames() {
    const list = document.getElementById("minibia-bot-panic-trusted-list");
    if (!list) return;

    const trustedNames = bot.panic?.config?.trustedNames || [];
    list.innerHTML = "";

    if (!trustedNames.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "No trusted names saved.";
      list.appendChild(empty);
      return;
    }

    trustedNames.forEach((name, index) => {
      const row = document.createElement("div");
      row.className = "mb-list-row";

      const label = document.createElement("span");
      label.textContent = name;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "mb-small-button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => {
        const nextNames = trustedNames.filter((_, currentIndex) => currentIndex !== index);
        bot.panic.updateConfig({ trustedNames: nextNames });
        renderTrustedNames();
      });

      row.appendChild(label);
      row.appendChild(removeButton);
      list.appendChild(row);
    });
  }

  function renderGameMasterNames() {
    const list = document.getElementById("minibia-bot-panic-gm-list");
    if (!list) return;

    const gameMasterNames = bot.panic?.config?.gameMasterNames || [];
    list.innerHTML = "";

    if (!gameMasterNames.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = "No game master names saved.";
      list.appendChild(empty);
      return;
    }

    gameMasterNames.forEach((name, index) => {
      const row = document.createElement("div");
      row.className = "mb-list-row";

      const label = document.createElement("span");
      label.textContent = name;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "mb-small-button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => {
        const nextNames = gameMasterNames.filter((_, currentIndex) => currentIndex !== index);
        bot.panic.updateConfig({ gameMasterNames: nextNames });
        renderGameMasterNames();
      });

      row.appendChild(label);
      row.appendChild(removeButton);
      list.appendChild(row);
    });
  }

  function refreshRuneStatus() {
    const runeToggle = document.getElementById("minibia-bot-rune-enabled");
    const running = !!bot.rune?.status?.().running;

    if (runeToggle) {
      runeToggle.checked = running;
    }
  }

  function refreshAutoEatStatus() {
    const autoEatToggle = document.getElementById("minibia-bot-auto-eat-enabled");
    if (!autoEatToggle) return;

    autoEatToggle.checked = !!bot.eat?.status?.().running;
  }

  function refreshAutoInvisibleStatus() {
    const autoInvisibleToggle = document.getElementById("minibia-bot-auto-invisible-enabled");
    if (!autoInvisibleToggle) return;

    autoInvisibleToggle.checked = !!bot.invisible?.status?.().running;
  }

  function refreshAutoMagicShieldStatus() {
    const autoMagicShieldToggle = document.getElementById("minibia-bot-auto-magic-shield-enabled");
    if (!autoMagicShieldToggle) return;

    autoMagicShieldToggle.checked = !!bot.magicShield?.status?.().running;
  }

  function refreshCaveStatus() {
    const statusLabel = document.getElementById("minibia-bot-cave-status");
    const startButton = document.getElementById("minibia-bot-cave-start");
    const stopButton = document.getElementById("minibia-bot-cave-stop");
    const route = bot.cave?.getRoute?.() || [];
    const status = bot.cave?.status?.();

    if (statusLabel) {
      if (!route.length) {
        statusLabel.textContent = "Status: no waypoints";
      } else if (status?.running) {
        const waypointNumber = (status.currentIndex ?? 0) + 1;
        const distanceLabel =
          Number.isFinite(status?.distanceToWaypoint) && status.distanceToWaypoint >= 0
            ? `, dist ${status.distanceToWaypoint}`
            : "";
        statusLabel.textContent = `Status: running (${waypointNumber}/${route.length}${distanceLabel})`;
      } else {
        statusLabel.textContent = `Status: idle (${route.length} waypoint${route.length === 1 ? "" : "s"})`;
      }
    }

    if (startButton) {
      startButton.disabled = !route.length || !!status?.running;
    }

    if (stopButton) {
      stopButton.disabled = !status?.running;
    }
  }

  function refreshCavePresetControls() {
    const select = document.getElementById("minibia-bot-cave-preset-select");
    const label = document.getElementById("minibia-bot-cave-preset-status");
    const deleteButton = document.getElementById("minibia-bot-cave-preset-delete");
    const status = bot.cave?.status?.();
    const presetNames = status?.presetNames || bot.cave?.getPresetNames?.() || [];
    const activePresetName = status?.activePresetName || bot.cave?.getActivePresetName?.() || "Default";

    if (select) {
      const previousValue = select.value;
      select.innerHTML = "";

      if (!presetNames.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No saved presets";
        select.appendChild(option);
        select.disabled = true;
      } else {
        presetNames.forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        });
        select.disabled = false;
        const nextValue = presetNames.includes(activePresetName) ? activePresetName : previousValue;
        if (nextValue) {
          select.value = nextValue;
        }
      }
    }

    if (label) {
      label.textContent = presetNames.length
        ? `Preset: ${activePresetName} (${presetNames.length} saved)`
        : `Preset: ${activePresetName}`;
    }

    if (deleteButton) {
      deleteButton.disabled = !presetNames.length || !select?.value;
    }
  }

  function refreshCaveClosestStatus() {
    const label = document.getElementById("minibia-bot-cave-closest");
    if (!label) return;

    const position = bot.getPlayerPosition?.();
    const route = bot.cave?.getRoute?.() || [];

    if (!position) {
      label.textContent = "Closest start: current position unavailable";
      return;
    }

    if (!route.length) {
      label.textContent = "Closest start: no waypoints";
      return;
    }

    const closestIndex = bot.cave?.findClosestWaypointIndex?.(position) ?? 0;
    const waypoint = route[closestIndex];

    if (!waypoint) {
      label.textContent = "Closest start: unavailable";
      return;
    }

    label.textContent = `Closest start: ${closestIndex + 1}. ${waypoint.x}, ${waypoint.y}, ${waypoint.z}`;
  }

  function refreshCaveTransitionStatus() {
    const label = document.getElementById("minibia-bot-cave-transition-status");
    if (!label) return;

    const transitions = bot.cave?.getTransitions?.() || [];
    if (!transitions.length) {
      label.textContent = "Transitions learned: none";
      return;
    }

    const latest = transitions
      .slice()
      .sort((a, b) => Number(b?.lastSeenAt || 0) - Number(a?.lastSeenAt || 0))[0];

    if (!latest?.from || !latest?.to) {
      label.textContent = `Transitions learned: ${transitions.length}`;
      return;
    }

    const extra = transitions.length > 1 ? ` (+${transitions.length - 1} more)` : "";
    label.textContent =
      `Transitions learned: ${latest.from.x}, ${latest.from.y}, ${latest.from.z} -> ` +
      `${latest.to.x}, ${latest.to.y}, ${latest.to.z}${extra}`;
  }

  function refreshEquipRingStatus() {
    const equipRingToggle = document.getElementById("minibia-bot-equip-ring-enabled");
    if (!equipRingToggle) return;

    equipRingToggle.checked = !!bot.equipRing?.status?.().running;
  }

  function refreshTalkStatus() {
    const talkToggle = document.getElementById("minibia-bot-talk-enabled");
    const statusLabel = document.getElementById("minibia-bot-talk-status");
    const status = bot.talk?.status?.();

    if (talkToggle) {
      talkToggle.checked = !!status?.running;
    }

    if (statusLabel) {
      if (!status?.config?.apiKey) {
        statusLabel.textContent = "Status: API key missing";
      } else if (status?.pending) {
        statusLabel.textContent = "Status: generating";
      } else if (status?.running) {
        statusLabel.textContent = "Status: listening to Default";
      } else {
        statusLabel.textContent = "Status: idle";
      }
    }
  }

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

    const getFloorOffset = (creature) => (creature.position?.z || 0) - me.z;
    const getFloorDistance = (creature) => Math.abs(getFloorOffset(creature));

    const visibleCreatures = creatures
      .filter((creature) => {
        const floor = creature?.position?.z;
        if (floor == null) {
          return false;
        }

        if (selectedFloor != null) {
          return floor === selectedFloor;
        }

        return floor !== me.z;
      })
      .sort((a, b) => {
      const floorDistanceDiff = getFloorDistance(a) - getFloorDistance(b);
      if (floorDistanceDiff !== 0) return floorDistanceDiff;

      const floorOffsetDiff = getFloorOffset(a) - getFloorOffset(b);
      if (floorOffsetDiff !== 0) return floorOffsetDiff;

      const aDist = Math.abs((a.position?.x || 0) - me.x) + Math.abs((a.position?.y || 0) - me.y);
      const bDist = Math.abs((b.position?.x || 0) - me.x) + Math.abs((b.position?.y || 0) - me.y);
      return aDist - bDist;
    });

    if (!visibleCreatures.length) {
      const empty = document.createElement("div");
      empty.className = "mb-small-note";
      empty.textContent = selectedFloor == null
        ? "No off-floor creatures."
        : `No creatures on floor ${selectedFloor}.`;
      list.appendChild(empty);
      return;
    }

    let currentFloor = null;

    visibleCreatures.forEach((creature) => {
      const floor = creature.position?.z;
      if (floor !== currentFloor) {
        currentFloor = floor;
        const floorOffset = me.z - floor;
        const floorOffsetLabel =
          floorOffset === 0 ? "0" : floorOffset > 0 ? `+${floorOffset}` : `${floorOffset}`;

        const floorLabel = document.createElement("div");
        floorLabel.className = "mb-floor-label";
        floorLabel.textContent = floorOffsetLabel;
        list.appendChild(floorLabel);
      }

      const row = document.createElement("div");
      row.className = "mb-creature-row";

      const name = document.createElement("div");
      name.className = "mb-creature-name";
      name.textContent = creature.name || (creature.type === 0 ? "Player" : "Mob");

      const meta = document.createElement("div");
      meta.className = "mb-small-note";
      meta.textContent = `${creature.type === 0 ? "Player" : "Mob"} at ${creature.position.x}, ${creature.position.y}, ${creature.position.z}`;

      row.appendChild(name);
      row.appendChild(meta);
      list.appendChild(row);
    });
  }

  function setPanelCollapsed(panel, collapsed) {
    if (!panel) return;

    const body = panel.querySelector(".mb-body");
    const toggle = panel.querySelector("#minibia-bot-collapse");
    const nextCollapsed = !!collapsed;

    panel.dataset.collapsed = nextCollapsed ? "true" : "false";

    if (body) {
      body.hidden = nextCollapsed;
    }

    if (toggle) {
      toggle.textContent = nextCollapsed ? "+" : "−";
      toggle.setAttribute("aria-label", nextCollapsed ? "Maximize panel" : "Minimize panel");
      toggle.setAttribute("title", nextCollapsed ? "Maximize" : "Minimize");
    }

    savePanelCollapsed(nextCollapsed);
  }

  function applySavedPanelPosition(panel, key = panelPositionKey) {
    const position = getSavedPanelPosition(key);
    if (!position) return;

    if (typeof position.top === "number") {
      panel.style.top = `${position.top}px`;
    }

    if (typeof position.left === "number") {
      panel.style.left = `${position.left}px`;
      panel.style.right = "auto";
    }
  }

  function clampPanelPosition(panel, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);

    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  function enableDrag(panel, key = panelPositionKey) {
    const handle = panel.querySelector(".mb-title");
    if (!handle) return;

    let dragState = null;

    const onMouseMove = (event) => {
      if (!dragState) return;

      const next = clampPanelPosition(
        panel,
        event.clientX - dragState.offsetX,
        event.clientY - dragState.offsetY
      );

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

    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;

      const rect = panel.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };

      event.preventDefault();
    });

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    bot.addCleanup(() => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    });
  }

// --- UI helper functions (needed for panel positioning and collapse) ---

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
  const nextCollapsed = !!collapsed;

  panel.dataset.collapsed = nextCollapsed ? "true" : "false";

  if (body) {
    body.hidden = nextCollapsed;
  }

  if (toggle) {
    toggle.textContent = nextCollapsed ? "+" : "−";
    toggle.setAttribute("aria-label", nextCollapsed ? "Maximize panel" : "Minimize panel");
    toggle.setAttribute("title", nextCollapsed ? "Maximize" : "Minimize");
  }

  savePanelCollapsed(nextCollapsed);
}

function applySavedPanelPosition(panel, key = panelPositionKey) {
  const position = getSavedPanelPosition(key);
  if (!position) return;

  if (typeof position.top === "number") {
    panel.style.top = `${position.top}px`;
  }

  if (typeof position.left === "number") {
    panel.style.left = `${position.left}px`;
    panel.style.right = "auto";
  }
}

function clampPanelPosition(panel, left, top) {
  const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);

  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

function enableDrag(panel, key = panelPositionKey) {
  const handle = panel.querySelector(".mb-title");
  if (!handle) return;

  let dragState = null;

  const onMouseMove = (event) => {
    if (!dragState) return;

    const next = clampPanelPosition(
      panel,
      event.clientX - dragState.offsetX,
      event.clientY - dragState.offsetY
    );

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

  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;

    const rect = panel.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };

    event.preventDefault();
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

  const stopButton = panel.querySelector("#minibia-bot-collapsed-stop");
  if (!stopButton) return;

  stopButton.style.display = panel.dataset.collapsed === "true" ? "" : "none";
}

function refreshTitlebarRunIndicators() {
  const panel = document.getElementById("minibia-bot-panel");
  if (!panel) return;

  const caveIndicator = panel.querySelector("#minibia-bot-title-cave-status");
  const attackIndicator = panel.querySelector("#minibia-bot-title-attack-status");

  let caveRunning = false;
  let attackRunning = false;

  try {
    caveRunning = !!bot.cave?.status?.().running;
  } catch {}

  try {
    attackRunning = !!bot.attack?.status?.().running;
  } catch {}

  if (caveIndicator) {
    caveIndicator.dataset.running = caveRunning ? "true" : "false";
    caveIndicator.title = caveRunning ? "Cavebot running" : "Cavebot stopped";
  }

  if (attackIndicator) {
    attackIndicator.dataset.running = attackRunning ? "true" : "false";
    attackIndicator.title = attackRunning ? "Targeting running" : "Targeting stopped";
  }
}

  function inject() {
    destroy();

    const style = document.createElement("style");
    style.id = "minibia-bot-style";
    style.textContent = `

#minibia-bot-panel {
  position: fixed;
  z-index: 999999;
  top: 16px;
  right: 16px;
  width: 500px;
  max-width: calc(100vw - 32px);
  padding: 8px;
  border: 1px solid rgba(224, 200, 148, 0.45);
  border-radius: 10px;
  background: rgba(18, 13, 8, 0.96);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  color: #f8e6b8;
  font: 12px/1.35 Verdana, sans-serif;
  user-select: none;
}

#minibia-bot-panel[data-collapsed="true"] {
  width: 240px;
}

#minibia-bot-panel .mb-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 8px;
}

#minibia-bot-panel[data-collapsed="true"] .mb-titlebar {
  margin-bottom: 0;
}

#minibia-bot-panel .mb-titlebar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
}

#minibia-bot-panel .mb-title-status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

#minibia-bot-panel .mb-run-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid rgba(224, 200, 148, 0.22);
  border-radius: 999px;
  background: rgba(8, 7, 6, 0.55);
  color: #b7a67d;
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}

#minibia-bot-panel .mb-run-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5b5547;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.45);
}

#minibia-bot-panel .mb-run-indicator[data-running="true"] {
  color: #d7ffd7;
  border-color: rgba(90, 220, 120, 0.42);
  background: rgba(20, 70, 28, 0.35);
}

#minibia-bot-panel .mb-run-indicator[data-running="true"] .mb-run-dot {
  background: #39e86f;
  box-shadow:
    0 0 0 1px rgba(0,0,0,0.45),
    0 0 7px rgba(57, 232, 111, 0.8);
}

#minibia-bot-panel .mb-title-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

#minibia-bot-panel .mb-title {
  margin: 0;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: move;
  color: #ffe7ad;
}

#minibia-bot-panel .mb-title-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

#minibia-bot-panel .mb-icon-button {
  width: 24px;
  min-width: 24px;
  padding: 2px 0;
  border-radius: 6px;
  font-weight: 700;
  line-height: 1;
}

#minibia-bot-panel .mb-body {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

#minibia-bot-panel .mb-body[hidden] {
  display: none !important;
}

#minibia-bot-panel .mb-tab-menu {
  display: grid;
  gap: 6px;
}

#minibia-bot-panel .mb-tab-button {
  width: 100%;
  padding: 8px 9px;
  border-radius: 7px;
  text-align: left;
  font-size: 11px;
  line-height: 1.15;
  background: rgba(255, 244, 212, 0.07);
}

#minibia-bot-panel .mb-tab-button[data-active="true"] {
  background: linear-gradient(180deg, #8a7044, #554329);
  border-color: rgba(224, 200, 148, 0.75);
  color: #fff3cf;
}

#minibia-bot-panel .mb-tab-content {
  min-width: 0;
  max-height: min(72vh, 560px);
  overflow-y: auto;
  padding-right: 4px;
}

#minibia-bot-panel .mb-tab-panel {
  display: none;
}

#minibia-bot-panel .mb-tab-panel[data-active="true"] {
  display: grid;
  gap: 10px;
}

#minibia-bot-panel .mb-section {
  padding: 12px;
  border: 1px solid rgba(224, 200, 148, 0.18);
  border-radius: 8px;
  background: rgba(8, 7, 6, 0.86);
}

#minibia-bot-panel .mb-label {
  margin: 0 0 10px;
  color: #ffe5a8;
  font-weight: 700;
  font-size: 13px;
}

#minibia-bot-panel .mb-stack {
  display: grid;
  gap: 10px;
}

#minibia-bot-panel .mb-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

#minibia-bot-panel .mb-button-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

#minibia-bot-panel .mb-utility-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 86px;
  gap: 10px;
  align-items: end;
}

#minibia-bot-panel .mb-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

#minibia-bot-panel .mb-mini-field {
  width: 86px;
}

#minibia-bot-panel .mb-field-label {
  color: #e9d39b;
  font-size: 11px;
  line-height: 1.2;
}

#minibia-bot-panel input,
#minibia-bot-panel textarea,
#minibia-bot-panel select {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid rgba(224, 200, 148, 0.48);
  border-radius: 8px;
  background: #080706;
  color: #fff2c7;
  font: inherit;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.65);
  caret-color: #fff2c7;
}

#minibia-bot-panel input::placeholder,
#minibia-bot-panel textarea::placeholder {
  color: rgba(255, 226, 176, 0.48);
}

#minibia-bot-panel input:focus,
#minibia-bot-panel textarea:focus,
#minibia-bot-panel select:focus {
  outline: none;
  border-color: rgba(255, 220, 140, 0.9);
  box-shadow:
    inset 0 1px 2px rgba(0,0,0,0.65),
    0 0 0 2px rgba(255, 200, 90, 0.18);
}

#minibia-bot-panel textarea {
  min-height: 90px;
  resize: vertical;
}

#minibia-bot-panel .mb-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f3dfad;
  white-space: normal;
}

#minibia-bot-panel .mb-toggle-main {
  margin-bottom: 2px;
}

#minibia-bot-panel input[type="checkbox"] {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #18c99a;
}

#minibia-bot-panel button {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid rgba(224, 200, 148, 0.35);
  border-radius: 8px;
  background: linear-gradient(180deg, #635133, #3f321f);
  color: #fff0ca;
  font: inherit;
  cursor: pointer;
}

#minibia-bot-panel button:hover {
  background: linear-gradient(180deg, #755f3d, #4f4028);
}

#minibia-bot-panel .mb-small-button {
  width: auto;
  padding: 6px 8px;
  border-radius: 6px;
}

#minibia-bot-panel .mb-inline {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

#minibia-bot-panel .mb-list {
  display: grid;
  gap: 6px;
}

#minibia-bot-panel .mb-list-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  color: #d3c49d;
}

#minibia-bot-panel .mb-creature-row {
  padding: 6px 8px;
  border: 1px solid rgba(224, 200, 148, 0.14);
  border-radius: 8px;
  background: rgba(255, 244, 212, 0.04);
}

#minibia-bot-panel .mb-creature-name {
  color: #f7eccf;
  word-break: break-word;
}

#minibia-bot-panel .mb-floor-label {
  margin-top: 4px;
  color: #e2cf9c;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

#minibia-bot-panel #minibia-bot-visible-creatures-list,
#minibia-bot-panel #minibia-bot-panic-trusted-list,
#minibia-bot-panel #minibia-bot-panic-gm-list {
  max-height: 150px;
  overflow-y: auto;
  padding-right: 2px;
}

#minibia-bot-panel .mb-small-note,
#minibia-bot-panel .mb-note {
  color: #cdbb8b;
  font-size: 11px;
  line-height: 1.35;
}

#minibia-bot-panel .mb-collapsed-stop-button {
  background: linear-gradient(180deg, #7a2f2f, #4e1f1f);
  border-color: rgba(255, 120, 120, 0.55);
  color: #ffd6d6;
}

#minibia-bot-panel .mb-collapsed-stop-button:hover {
  background: linear-gradient(180deg, #963b3b, #642727);
}

#minibia-bot-panel[data-collapsed="false"] .mb-collapsed-stop-button {
  display: none;
}

@media (max-width: 760px) {
  #minibia-bot-panel {
    width: min(560px, calc(100vw - 32px));
  }

  #minibia-bot-panel .mb-body {
    grid-template-columns: 1fr;
  }

  #minibia-bot-panel .mb-tab-menu {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  #minibia-bot-panel .mb-tab-button {
    text-align: center;
  }

  #minibia-bot-panel .mb-form-grid,
  #minibia-bot-panel .mb-button-grid,
  #minibia-bot-panel .mb-utility-row {
    grid-template-columns: 1fr;
  }

  #minibia-bot-panel .mb-mini-field {
    width: 100%;
  }
}


    `;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "minibia-bot-panel";
panel.innerHTML = `
<div class="mb-titlebar">
  <div class="mb-title">MBot</div>

  <div class="mb-title-status">
    <span class="mb-run-indicator" id="minibia-bot-title-cave-status" data-running="false">
      <span class="mb-run-dot"></span>
      <span class="mb-run-label">Cave</span>
    </span>

    <span class="mb-run-indicator" id="minibia-bot-title-attack-status" data-running="false">
      <span class="mb-run-dot"></span>
      <span class="mb-run-label">Target</span>
    </span>
  </div>

  <div class="mb-title-actions">
    <button type="button" class="mb-icon-button mb-collapsed-stop-button" id="minibia-bot-collapsed-stop" title="Stop Cave + Attack" aria-label="Stop Cave and Attack">■</button>
    <button type="button" class="mb-icon-button" id="minibia-bot-collapse" aria-label="Minimize panel" title="Minimize">−</button>
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

<!-- HEALING TAB -->
<div class="mb-tab-panel" data-tab-panel="healing">
  <div class="mb-section">
    <div class="mb-label">Auto Heal</div>

    <label class="mb-toggle mb-toggle-main">
      <input type="checkbox" id="minibia-bot-auto-heal-enabled" />
      <span>Enable Auto Heal</span>
    </label>

    <div id="minibia-bot-heal-rules-list" class="mb-list" style="margin:8px 0;"></div>

    <div class="mb-section" style="padding:10px;background:rgba(255,255,255,0.03);">
      <div class="mb-label" style="font-size:12px;margin-bottom:6px;">Add / Edit Rule</div>

      <!-- Row 1: Slot, Spell Words, Mana Cost -->
      <div style="display:grid;grid-template-columns:80px 1fr 80px;gap:6px;margin-bottom:6px;">
        <label class="mb-field" for="minibia-bot-heal-slot">
          <span class="mb-field-label">Slot</span>
          <input type="number" id="minibia-bot-heal-slot" min="1" max="12" value="1" />
        </label>
        <label class="mb-field" for="minibia-bot-heal-spell">
          <span class="mb-field-label">Spell Words (optional)</span>
          <input type="text" id="minibia-bot-heal-spell" placeholder="ex: exura" />
        </label>
        <label class="mb-field" for="minibia-bot-heal-manacost">
          <span class="mb-field-label">Mana Cost</span>
          <input type="number" id="minibia-bot-heal-manacost" min="1" value="0" placeholder="0" />
        </label>
      </div>

      <!-- Row 2: HP min/max, MP min/max -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:6px;">
        <label class="mb-field" for="minibia-bot-heal-minhp">
          <span class="mb-field-label">Min HP %</span>
          <input type="number" id="minibia-bot-heal-minhp" min="0" max="100" value="0" />
        </label>
        <label class="mb-field" for="minibia-bot-heal-maxhp">
          <span class="mb-field-label">Max HP %</span>
          <input type="number" id="minibia-bot-heal-maxhp" min="0" max="100" value="100" />
        </label>
        <label class="mb-field" for="minibia-bot-heal-minmana">
          <span class="mb-field-label">Min MP %</span>
          <input type="number" id="minibia-bot-heal-minmana" min="0" max="100" value="0" />
        </label>
        <label class="mb-field" for="minibia-bot-heal-maxmana">
          <span class="mb-field-label">Max MP %</span>
          <input type="number" id="minibia-bot-heal-maxmana" min="0" max="100" value="100" />
        </label>
      </div>

      <div style="display:flex;gap:6px;">
        <button type="button" id="minibia-bot-heal-save" style="flex:1;">Add Rule</button>
        <button type="button" id="minibia-bot-heal-cancel" style="flex:0;width:auto;padding:8px 12px;">Cancel</button>
      </div>
    </div>

    <div class="mb-small-note" style="margin-top:6px;">
      Rules are checked in order. First rule whose HP and MP ranges match will trigger.
      If spell words are given, mana cost must be set (and current mana must be ≥ that).
    </div>
  </div>
</div>

      <div class="mb-tab-panel" data-tab-panel="panic">
        <div class="mb-section">
          <div class="mb-label" id="minibia-bot-home">Panic Runner Home: not set</div>

          <div class="mb-stack">
            <button type="button" id="minibia-bot-set-home">Set Home</button>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-panic-unknown" />
              <span>Unknown Player</span>
            </label>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-panic-health" />
              <span>Lose Health</span>
            </label>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-panic-return" />
              <span>Auto Return</span>
            </label>

            <div class="mb-inline">
              <input type="text" id="minibia-bot-panic-trusted-input" placeholder="Trusted name" />
              <button type="button" class="mb-small-button" id="minibia-bot-panic-trusted-add">Add</button>
            </div>

            <div class="mb-list" id="minibia-bot-panic-trusted-list"></div>
          </div>
        </div>

        <div class="mb-section">
          <div class="mb-label">GM Kill Switch</div>

          <div class="mb-stack">
            <div class="mb-inline">
              <input type="text" id="minibia-bot-panic-gm-input" placeholder="Game master name" />
              <button type="button" class="mb-small-button" id="minibia-bot-panic-gm-add">Add</button>
            </div>

            <div class="mb-list" id="minibia-bot-panic-gm-list"></div>
          </div>
        </div>
      </div>

      <div class="mb-tab-panel" data-tab-panel="xray">
        <div class="mb-section">
          <div class="mb-label">Xray</div>

          <div class="mb-stack">
            <button type="button" class="mb-small-button" id="minibia-bot-xray-overlay-toggle">Disable Overlay</button>
            <div class="mb-small-note" id="minibia-bot-xray-overlay-status">Overlay: on</div>

            <label class="mb-field" for="minibia-bot-xray-floor-select">
              <span class="mb-field-label">Floor Filter</span>
              <select id="minibia-bot-xray-floor-select">
                <option value="all">All floors</option>
              </select>
            </label>

            <div class="mb-list" id="minibia-bot-visible-creatures-list"></div>
          </div>
        </div>
      </div>

      <div class="mb-tab-panel" data-tab-panel="utility">
        <div class="mb-section">
          <div class="mb-label">Bot</div>
          <button type="button" id="minibia-bot-reload">Reload Bot</button>
        </div>

        <div class="mb-section">
          <div class="mb-label">Magic Level Trainer</div>

          <label class="mb-toggle mb-toggle-main">
            <input type="checkbox" id="minibia-bot-rune-enabled" />
            <span>Enable Trainer</span>
          </label>

          <div class="mb-form-grid">
            <label class="mb-field" for="minibia-bot-rune-spell">
              <span class="mb-field-label">Spell Words</span>
              <input type="text" id="minibia-bot-rune-spell" placeholder="Spell words" />
            </label>

            <label class="mb-field" for="minibia-bot-rune-mana">
              <span class="mb-field-label">Mana Cost</span>
              <input type="number" id="minibia-bot-rune-mana" min="0" placeholder="Mana" />
            </label>
          </div>
        </div>

        <div class="mb-section">
          <div class="mb-label">Utility Modules</div>

          <div class="mb-stack">
            <div class="mb-utility-row">
              <label class="mb-toggle">
                <input type="checkbox" id="minibia-bot-auto-eat-enabled" />
                <span>Auto Eat</span>
              </label>

              <label class="mb-field mb-mini-field" for="minibia-bot-auto-eat-hotkey">
                <span class="mb-field-label">Hotkey</span>
                <input type="number" id="minibia-bot-auto-eat-hotkey" min="1" max="12" placeholder="10" />
              </label>
            </div>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-auto-invisible-enabled" />
              <span>Auto Invisible</span>
            </label>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-auto-magic-shield-enabled" />
              <span>Auto Utamo Vita</span>
            </label>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-equip-ring-enabled" />
              <span>Equip Ring</span>
            </label>
          </div>
        </div>
      </div>

      <div class="mb-tab-panel" data-tab-panel="cave">
        <div class="mb-section">
          <div class="mb-label">Cave Bot</div>

          <div class="mb-stack">
            <label class="mb-field" for="minibia-bot-cave-preset-select">
              <span class="mb-field-label">Preset</span>
              <select id="minibia-bot-cave-preset-select"></select>
            </label>

            <div class="mb-button-grid">
              <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-new">New</button>
              <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-delete">Delete</button>
            </div>

            <div class="mb-button-grid">
              <button type="button" class="mb-small-button" id="minibia-bot-cave-record">Record Spot</button>
              <button type="button" class="mb-small-button" id="minibia-bot-cave-remove-last">Remove Last</button>
            </div>

            <div class="mb-small-note" id="minibia-bot-cave-closest">Closest start: no waypoints</div>
            <div class="mb-small-note" id="minibia-bot-cave-transition-status">Transitions learned: none</div>

            <div class="mb-button-grid">
              <button type="button" class="mb-small-button" id="minibia-bot-cave-start">Start</button>
              <button type="button" class="mb-small-button" id="minibia-bot-cave-stop">Stop</button>
            </div>

            <div class="mb-small-note" id="minibia-bot-cave-status">Status: no waypoints</div>
          </div>
        </div>
      </div>

      <div class="mb-tab-panel" data-tab-panel="targeting">
        <div class="mb-section">
          <div class="mb-label">Auto Attack</div>

          <div class="mb-stack">
            <label class="mb-toggle mb-toggle-main">
              <input type="checkbox" id="minibia-bot-auto-attack-enabled" />
              <span>Enable Auto Attack</span>
            </label>

            <label class="mb-toggle">
              <input type="checkbox" id="minibia-bot-auto-attack-melee" />
              <span>Melee Mode</span>
            </label>

            <div class="mb-form-grid">
              <label class="mb-field" for="minibia-bot-auto-attack-hotkey">
                <span class="mb-field-label">Target Hotkey</span>
                <input type="number" id="minibia-bot-auto-attack-hotkey" min="1" max="12" placeholder="3" />
              </label>

              <label class="mb-field" for="minibia-bot-auto-attack-rune-hotkey">
                <span class="mb-field-label">Rune Hotkey</span>
                <input type="number" id="minibia-bot-auto-attack-rune-hotkey" min="1" max="12" placeholder="4" />
              </label>
            </div>
			<div class="mb-section">
			  <div class="mb-label">Target Priority</div>

			  <div class="mb-stack">
				<label class="mb-field" for="minibia-bot-auto-attack-preferred-names">
				  <span class="mb-field-label">Preferred Mobs</span>
				  <textarea
					id="minibia-bot-auto-attack-preferred-names"
					placeholder="Orc Shaman, Amazon, Orc Spearman"
				  ></textarea>
				</label>

				<label class="mb-field" for="minibia-bot-auto-attack-preferred-match-mode">
				  <span class="mb-field-label">Match Mode</span>
				  <select id="minibia-bot-auto-attack-preferred-match-mode">
					<option value="exact">Exact name</option>
					<option value="includes">Contains text</option>
				  </select>
				</label>

				<button
				  type="button"
				  class="mb-small-button"
				  id="minibia-bot-auto-attack-preferred-save"
				>
				  Save Target Priority
				</button>

				<div
				  class="mb-small-note"
				  id="minibia-bot-auto-attack-preferred-status"
				>
				  Preferred mobs: none
				</div>

				<div class="mb-small-note">
				  Preferred mobs are ranked first, but other visible mobs are still allowed.
				</div>
			  </div>
			</div>



            <div class="mb-small-note">
              Existing attack module settings.
            </div>
          </div>
        </div>
      </div>

      <div class="mb-tab-panel" data-tab-panel="talk">
        <div class="mb-section">
          <div class="mb-label">Talk</div>

          <div class="mb-stack">
            <label class="mb-toggle mb-toggle-main">
              <input type="checkbox" id="minibia-bot-talk-enabled" />
              <span>Enable Auto Reply</span>
            </label>

            <label class="mb-field" for="minibia-bot-talk-api-key">
              <span class="mb-field-label">Gemini API Key</span>
              <input type="password" id="minibia-bot-talk-api-key" placeholder="Gemini API key" />
            </label>

            <label class="mb-field" for="minibia-bot-talk-prompt">
              <span class="mb-field-label">Reply Style Prompt</span>
              <textarea id="minibia-bot-talk-prompt" placeholder="Reply style prompt"></textarea>
            </label>

            <div class="mb-small-note" id="minibia-bot-talk-status">Status: idle</div>
            <div class="mb-small-note">Replies only to the newest unseen message in Default chat.</div>
          </div>
        </div>
      </div>

    </div>
  </div>
`;
document.body.appendChild(panel);

function refreshTitlebarRunIndicators() {
  const caveIndicator = panel.querySelector("#minibia-bot-title-cave-status");
  const attackIndicator = panel.querySelector("#minibia-bot-title-attack-status");

  let caveRunning = false;
  let attackRunning = false;

  try {
    caveRunning = !!bot.cave?.status?.().running;
  } catch {}

  try {
    attackRunning = !!bot.attack?.status?.().running;
  } catch {}

  if (caveIndicator) {
    caveIndicator.dataset.running = caveRunning ? "true" : "false";
    caveIndicator.title = caveRunning ? "Cavebot running" : "Cavebot stopped";
  }

  if (attackIndicator) {
    attackIndicator.dataset.running = attackRunning ? "true" : "false";
    attackIndicator.title = attackRunning ? "Targeting running" : "Targeting stopped";
  }
}
  

function setActiveBotTab(tabId) {
  panel.querySelectorAll(".mb-tab-button").forEach((button) => {
    button.dataset.active = button.dataset.tabButton === tabId ? "true" : "false";
  });

  panel.querySelectorAll(".mb-tab-panel").forEach((tabPanel) => {
    tabPanel.dataset.active = tabPanel.dataset.tabPanel === tabId ? "true" : "false";
  });

  try {
    localStorage.setItem("minibia-bot-active-tab", tabId);
  } catch {}
}

panel.querySelectorAll(".mb-tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    setActiveBotTab(button.dataset.tabButton);
  });
});

const savedBotTab = (() => {
  try {
    return localStorage.getItem("minibia-bot-active-tab") || "healing";
  } catch {
    return "healing";
  }
})();

setActiveBotTab(savedBotTab);

function stopCaveAndAttackManual() {
  try {
    bot.cave?.stop?.();
    console.log("[minibia-bot-ui] cave stopped manually from collapsed panel");
  } catch (error) {
    console.warn("[minibia-bot-ui] failed to stop cave", error);
  }

  try {
    bot.attack?.stop?.();
    console.log("[minibia-bot-ui] attack stopped manually from collapsed panel");
  } catch (error) {
    console.warn("[minibia-bot-ui] failed to stop attack", error);
  }

  try {
    refreshCaveStatus?.();
    refreshAutoAttackStatus?.();
    refreshTitlebarRunIndicators?.();
  } catch {}
}

panel.querySelector("#minibia-bot-collapsed-stop")?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  stopCaveAndAttackManual();
});


function formatPreferredTargetNames(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return "";
  }

  return names.join(", ");
}

function getAttackConfigForUi() {
  return bot.attack?.status?.().config || bot.attack?.config || {};
}




function appendSection(targetPanel, section) {
  if (!targetPanel || !section) {
    return;
  }

  targetPanel.appendChild(section);
}

	
function getWholeSection(selector) {
  const element = panel.querySelector(selector);
  return element ? element.closest(".mb-section, .mb-actions.mb-column-section") : null;
}

function createPanelTab(id) {
  const tabPanel = document.createElement("div");
  tabPanel.className = "mb-tab-panel";
  tabPanel.dataset.tabPanel = id;
  return tabPanel;
}

function updateCollapsedStopButton(panel) {
  if (!panel) return;

  const stopButton = panel.querySelector("#minibia-bot-collapsed-stop");
  if (!stopButton) return;

  stopButton.style.display = panel.dataset.collapsed === "true" ? "" : "none";
}



function findSection(panel, selector) {
  const element = panel.querySelector(selector);

  if (!element) {
    console.warn("[minibia-bot-ui] selector not found:", selector);
    return null;
  }

  /*
   * Prefer full logical section.
   * This is important for cavebot:
   * #minibia-bot-cave-preset-select should pull the whole Cave Bot block.
   */
  const section =
    element.closest(".mb-section") ||
    element.closest(".mb-actions.mb-column-section") ||
    element.closest(".mb-column-section") ||
    element.parentElement;

  if (!section) {
    console.warn("[minibia-bot-ui] section not found for:", selector);
  }

  return section;
}

function appendIfFound(target, section) {
  if (!target || !section) {
    return;
  }

  if (section.dataset.movedToTab === "true") {
    return;
  }

  section.dataset.movedToTab = "true";
  target.appendChild(section);
}

function addEmptyTabNotes(panels) {
  Object.entries(panels).forEach(([id, panelElement]) => {
    if (panelElement.children.length > 0) {
      return;
    }

    const note = document.createElement("div");
    note.className = "mb-section";
    note.innerHTML = `
      <div class="mb-label">${id}</div>
      <div class="mb-small-note">No controls were found for this tab.</div>
    `;

    panelElement.appendChild(note);
  });
}

function addEmptyTabNotes(panels) {
  Object.entries(panels).forEach(([id, panelElement]) => {
    if (panelElement.children.length > 0) return;

    const note = document.createElement("div");
    note.className = "mb-section";
    note.innerHTML = `
      <div class="mb-label">${id}</div>
      <div class="mb-small-note">No controls available in this tab.</div>
    `;

    panelElement.appendChild(note);
  });
}

function addCollapseSafetyNote(parent) {
  if (!parent) return;

  const note = document.createElement("div");
  note.className = "mb-section";
  note.innerHTML = `
    <div class="mb-label">Panel Safety</div>
    <div class="mb-small-note">
      When this panel is collapsed, Cave Bot and Auto Attack are stopped automatically.
    </div>
  `;

  parent.appendChild(note);
}

    const unlockAudio = () => {
      bot.unlockAudio?.();
    };

    panel.addEventListener("pointerdown", unlockAudio, { passive: true });
    panel.addEventListener("keydown", unlockAudio);

    bot.addCleanup(() => {
      panel.removeEventListener("pointerdown", unlockAudio);
      panel.removeEventListener("keydown", unlockAudio);
    });

    applySavedPanelPosition(panel);
    enableDrag(panel);

	const savedCollapsed = getSavedPanelCollapsed();
	setPanelCollapsed(panel, savedCollapsed);
	updateCollapsedStopButton(panel);

	

// selectors
    const spellInput = panel.querySelector("#minibia-bot-rune-spell");
    const manaInput = panel.querySelector("#minibia-bot-rune-mana");
    const runeEnabledInput = panel.querySelector("#minibia-bot-rune-enabled");
    const autoEatEnabledInput = panel.querySelector("#minibia-bot-auto-eat-enabled");
    const autoEatHotkeyInput = panel.querySelector("#minibia-bot-auto-eat-hotkey");
    const autoInvisibleEnabledInput = panel.querySelector("#minibia-bot-auto-invisible-enabled");
    const autoMagicShieldEnabledInput = panel.querySelector("#minibia-bot-auto-magic-shield-enabled");
    const equipRingEnabledInput = panel.querySelector("#minibia-bot-equip-ring-enabled");
    const autoHealEnabledInput = panel.querySelector("#minibia-bot-auto-heal-enabled");
    const healAddRuleBtn = panel.querySelector("#minibia-bot-heal-add-rule"); // removed, but keep for compatibility
    const healRulesList = panel.querySelector("#minibia-bot-heal-rules-list");
    const autoAttackEnabledInput = panel.querySelector("#minibia-bot-auto-attack-enabled");
    const autoAttackMeleeInput = panel.querySelector("#minibia-bot-auto-attack-melee");
    const autoAttackHotkeyInput = panel.querySelector("#minibia-bot-auto-attack-hotkey");
    const autoAttackRuneHotkeyInput = panel.querySelector("#minibia-bot-auto-attack-rune-hotkey");
    const talkEnabledInput = panel.querySelector("#minibia-bot-talk-enabled");
    const talkApiKeyInput = panel.querySelector("#minibia-bot-talk-api-key");
    const talkPromptInput = panel.querySelector("#minibia-bot-talk-prompt");
    const panicGmNameInput = panel.querySelector("#minibia-bot-panic-gm-input");
    const panicGmAddButton = panel.querySelector("#minibia-bot-panic-gm-add");
    const panicUnknownInput = panel.querySelector("#minibia-bot-panic-unknown");
    const panicHealthInput = panel.querySelector("#minibia-bot-panic-health");
    const panicReturnInput = panel.querySelector("#minibia-bot-panic-return");
    const panicTrustedInput = panel.querySelector("#minibia-bot-panic-trusted-input");
    const panicTrustedAddButton = panel.querySelector("#minibia-bot-panic-trusted-add");
    const xrayOverlayButton = panel.querySelector("#minibia-bot-xray-overlay-toggle");
    const xrayFloorSelect = panel.querySelector("#minibia-bot-xray-floor-select");
    const collapseButton = panel.querySelector("#minibia-bot-collapse");
    const reloadButton = panel.querySelector("#minibia-bot-reload");
    const caveRecordButton = panel.querySelector("#minibia-bot-cave-record");
    const caveRemoveLastButton = panel.querySelector("#minibia-bot-cave-remove-last");
    const caveStartButton = panel.querySelector("#minibia-bot-cave-start");
    const caveStopButton = panel.querySelector("#minibia-bot-cave-stop");
    const cavePresetSelect = panel.querySelector("#minibia-bot-cave-preset-select");
    const cavePresetNewButton = panel.querySelector("#minibia-bot-cave-preset-new");
    const cavePresetDeleteButton = panel.querySelector("#minibia-bot-cave-preset-delete");
	const preferredSaveButton = panel.querySelector("#minibia-bot-auto-attack-preferred-save");
	const preferredNamesInput = panel.querySelector("#minibia-bot-auto-attack-preferred-names");
	const preferredMatchModeSelect = panel.querySelector("#minibia-bot-auto-attack-preferred-match-mode");

    // new heal UI elements
    const healTypeSelect = panel.querySelector("#minibia-bot-heal-type");
    const healSlotInput = panel.querySelector("#minibia-bot-heal-slot");
    const healSpellInput = panel.querySelector("#minibia-bot-heal-spell");
    const healThresholdInput = panel.querySelector("#minibia-bot-heal-threshold");
    const healMinManaInput = panel.querySelector("#minibia-bot-heal-minmana");
    const healSaveButton = panel.querySelector("#minibia-bot-heal-save");
    const healCancelButton = panel.querySelector("#minibia-bot-heal-cancel");

//event listeners



	if (collapseButton) {
	  collapseButton.addEventListener("click", () => {
		const isCollapsed = panel.dataset.collapsed === "true";
		setPanelCollapsed(panel, !isCollapsed);
		updateCollapsedStopButton(panel);
	  });
	}

	if (preferredSaveButton) {
	  preferredSaveButton.onclick = () => {
		saveAutoAttackPreferredConfig();
	  };
	}

	if (preferredNamesInput) {
	  preferredNamesInput.onchange = () => {
		saveAutoAttackPreferredConfig();
	  };

	  preferredNamesInput.onkeydown = (event) => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
		  event.preventDefault();
		  saveAutoAttackPreferredConfig();
		}
	  };
	}

	if (preferredMatchModeSelect) {
	  preferredMatchModeSelect.onchange = () => {
		saveAutoAttackPreferredConfig();
	  };
	}

    if (reloadButton) {
      reloadButton.addEventListener("click", () => {
        window.minibiaBotReload?.();
      });
    }

    function addTrustedName() {
      const rawName = panicTrustedInput?.value?.trim() || "";
      if (!rawName) {
        return;
      }

      const currentNames = bot.panic?.config?.trustedNames || [];
      const exists = currentNames.some(
        (name) => String(name).trim().toLowerCase() === rawName.toLowerCase()
      );

      if (!exists) {
        bot.panic.updateConfig({ trustedNames: [...currentNames, rawName] });
      }

      if (panicTrustedInput) {
        panicTrustedInput.value = "";
      }

      renderTrustedNames();
    }

    function addGameMasterName() {
      const rawName = panicGmNameInput?.value?.trim() || "";
      if (!rawName) {
        return;
      }

      const currentNames = bot.panic?.config?.gameMasterNames || [];
      const exists = currentNames.some(
        (name) => String(name).trim().toLowerCase() === rawName.toLowerCase()
      );

      if (!exists) {
        bot.panic.updateConfig({ gameMasterNames: [...currentNames, rawName] });
      }

      if (panicGmNameInput) {
        panicGmNameInput.value = "";
      }

      renderGameMasterNames();
    }

    if (panicGmAddButton) {
      panicGmAddButton.addEventListener("click", addGameMasterName);
    }

    if (panicGmNameInput) {
      panicGmNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addGameMasterName();
        }
      });
    }

    if (panicTrustedAddButton) {
      panicTrustedAddButton.addEventListener("click", addTrustedName);
    }

    if (panicTrustedInput) {
      panicTrustedInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addTrustedName();
        }
      });
    }

    if (spellInput) {
      spellInput.value = bot.rune?.config?.runeSpellWords || "";
      spellInput.addEventListener("change", () => {
        bot.rune.updateConfig({ runeSpellWords: spellInput.value.trim() });
      });
    }

    if (manaInput) {
      manaInput.value = String(bot.rune?.config?.runeManaCost ?? 0);
      manaInput.addEventListener("change", () => {
        const runeManaCost = Math.max(0, Number(manaInput.value) || 0);
        manaInput.value = String(runeManaCost);
        bot.rune.updateConfig({ runeManaCost });
      });
    }

    if (runeEnabledInput) {
      runeEnabledInput.checked = !!bot.rune?.status?.().running;
      runeEnabledInput.addEventListener("change", () => {
        const runeSpellWords = spellInput?.value?.trim() || bot.rune.config.runeSpellWords;
        const runeManaCost = Math.max(0, Number(manaInput?.value) || bot.rune.config.runeManaCost || 0);

        if (runeEnabledInput.checked) {
          bot.rune.start({ runeSpellWords, runeManaCost });
        } else {
          bot.rune.stop();
        }

        refreshRuneStatus();
      });
    }

    if (autoEatHotkeyInput) {
      autoEatHotkeyInput.value = String(bot.eat?.config?.eatHotbarSlot ?? 10);
      autoEatHotkeyInput.addEventListener("change", () => {
        const eatHotbarSlot = Math.min(12, Math.max(1, Number(autoEatHotkeyInput.value) || 1));
        autoEatHotkeyInput.value = String(eatHotbarSlot);
        bot.eat.updateConfig({ eatHotbarSlot });
      });
    }

    if (autoEatEnabledInput) {
      autoEatEnabledInput.checked = !!bot.eat?.status?.().running;
      autoEatEnabledInput.addEventListener("change", () => {
        const eatHotbarSlot = Math.min(
          12,
          Math.max(1, Number(autoEatHotkeyInput?.value) || bot.eat.config.eatHotbarSlot || 1)
        );

        if (autoEatEnabledInput.checked) {
          bot.eat.start({ eatHotbarSlot });
        } else {
          bot.eat.stop();
        }

        refreshAutoEatStatus();
      });
    }

    if (autoInvisibleEnabledInput) {
      autoInvisibleEnabledInput.checked = !!bot.invisible?.status?.().running;
      autoInvisibleEnabledInput.addEventListener("change", () => {
        if (autoInvisibleEnabledInput.checked) {
          bot.invisible.start();
        } else {
          bot.invisible.stop();
        }

        refreshAutoInvisibleStatus();
      });
    }

    if (autoMagicShieldEnabledInput) {
      autoMagicShieldEnabledInput.checked = !!bot.magicShield?.status?.().running;
      autoMagicShieldEnabledInput.addEventListener("change", () => {
        if (autoMagicShieldEnabledInput.checked) {
          bot.magicShield.start();
        } else {
          bot.magicShield.stop();
        }

        refreshAutoMagicShieldStatus();
      });
    }

    if (equipRingEnabledInput) {
      equipRingEnabledInput.checked = !!bot.equipRing?.status?.().running;
      equipRingEnabledInput.addEventListener("change", () => {
        if (equipRingEnabledInput.checked) {
          bot.equipRing.start();
        } else {
          bot.equipRing.stop();
        }

        refreshEquipRingStatus();
      });
    }

    if (caveRecordButton) {
      caveRecordButton.addEventListener("click", () => {
        bot.cave.addWaypointCurrentSpot();
        refreshCavePresetControls();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

    if (caveRemoveLastButton) {
      caveRemoveLastButton.addEventListener("click", () => {
        bot.cave.removeLastWaypoint();
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

    if (caveStartButton) {
      caveStartButton.addEventListener("click", () => {
        bot.cave.start();
		refreshTitlebarRunIndicators();
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

    if (caveStopButton) {
      caveStopButton.addEventListener("click", () => {
        bot.cave.stop();
		refreshTitlebarRunIndicators();
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

    if (cavePresetSelect) {
      cavePresetSelect.addEventListener("change", () => {
        const name = cavePresetSelect.value || "";
        const activePresetName = bot.cave?.getActivePresetName?.() || "";
        if (!name || name === activePresetName) {
          refreshCavePresetControls();
          return;
        }

        const loadedPreset = bot.cave.loadPreset(name);
        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

    if (cavePresetNewButton) {
      cavePresetNewButton.addEventListener("click", () => {
        const name = window.prompt("Name the new cave preset:");
        if (name == null) {
          return;
        }

        const createdPreset = bot.cave.createPreset(name);
        if (!createdPreset) {
          return;
        }

        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

    if (cavePresetDeleteButton) {
      cavePresetDeleteButton.addEventListener("click", () => {
        const name = cavePresetSelect?.value || "";
        if (!name) {
          return;
        }

        const deleted = bot.cave.deletePreset(name);
        if (!deleted) {
          return;
        }

        refreshCavePresetControls();
        refreshCaveStatus();
        refreshCaveClosestStatus();
        refreshCaveTransitionStatus();
      });
    }

// Heal UI: save / cancel
const healSave = panel.querySelector("#minibia-bot-heal-save");
const healCancel = panel.querySelector("#minibia-bot-heal-cancel");
if (healSave) healSave.addEventListener("click", saveHealRule);
if (healCancel) healCancel.addEventListener("click", clearHealRuleForm);

// Auto Heal enable toggle
const autoHealToggle = panel.querySelector("#minibia-bot-auto-heal-enabled");
if (autoHealToggle) {
  autoHealToggle.checked = !!bot.heal?.status?.().running;
  autoHealToggle.addEventListener("change", () => {
    if (autoHealToggle.checked) bot.heal.start();
    else bot.heal.stop();
    refreshAutoHealStatus();
  });
}

// Initial refresh
refreshHealRules();
refreshAutoHealStatus();

    if (autoAttackHotkeyInput) {
      autoAttackHotkeyInput.value = String(bot.attack?.config?.targetHotbarSlot ?? 3);
      autoAttackHotkeyInput.addEventListener("change", () => {
        const targetHotbarSlot = Math.min(12, Math.max(1, Number(autoAttackHotkeyInput.value) || 1));
        autoAttackHotkeyInput.value = String(targetHotbarSlot);
        bot.attack.updateConfig({ targetHotbarSlot });
      });
    }

    if (autoAttackRuneHotkeyInput) {
      autoAttackRuneHotkeyInput.value = bot.attack?.config?.runeHotbarSlot
        ? String(bot.attack.config.runeHotbarSlot)
        : "";
      autoAttackRuneHotkeyInput.addEventListener("change", () => {
        const rawValue = Number(autoAttackRuneHotkeyInput.value);
        const runeHotbarSlot = Number.isFinite(rawValue) && rawValue >= 1 && rawValue <= 12
          ? Math.trunc(rawValue)
          : null;
        autoAttackRuneHotkeyInput.value = runeHotbarSlot ? String(runeHotbarSlot) : "";
        bot.attack.updateConfig({ runeHotbarSlot });
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
        const targetHotbarSlot = Math.min(
          12,
          Math.max(1, Number(autoAttackHotkeyInput?.value) || bot.attack.config.targetHotbarSlot || 1)
        );
        const runeHotbarSlot = (() => {
          const rawValue = Number(autoAttackRuneHotkeyInput?.value);
          if (Number.isFinite(rawValue) && rawValue >= 1 && rawValue <= 12) {
            return Math.trunc(rawValue);
          }

          return bot.attack.config.runeHotbarSlot ?? null;
        })();
        const meleeMode = !!autoAttackMeleeInput?.checked;

        if (autoAttackEnabledInput.checked) {
          bot.attack.start({ targetHotbarSlot, runeHotbarSlot, meleeMode });
		  refreshTitlebarRunIndicators();
        } else {
          bot.attack.stop();
		  refreshTitlebarRunIndicators();
        }

        refreshAutoAttackStatus();
		refreshAutoAttackPreferredStatus({ force: true });
      });
    }

    if (talkApiKeyInput) {
      talkApiKeyInput.value = bot.talk?.config?.apiKey || "";
      talkApiKeyInput.addEventListener("change", () => {
        bot.talk.updateConfig({ apiKey: talkApiKeyInput.value.trim() });
        refreshTalkStatus();
      });
    }

    if (talkPromptInput) {
      talkPromptInput.value = bot.talk?.config?.systemPrompt || "";
      talkPromptInput.addEventListener("change", () => {
        bot.talk.updateConfig({ systemPrompt: talkPromptInput.value.trim() });
      });
    }

    if (talkEnabledInput) {
      talkEnabledInput.checked = !!bot.talk?.status?.().running;
      talkEnabledInput.addEventListener("change", () => {
        if (talkEnabledInput.checked) {
          bot.talk.updateConfig({
            apiKey: talkApiKeyInput?.value?.trim() || "",
            systemPrompt: talkPromptInput?.value?.trim() || bot.talk.config.systemPrompt || "",
          });
          const started = bot.talk.start();
          if (!started) {
            talkEnabledInput.checked = false;
          }
        } else {
          bot.talk.stop();
        }

        refreshTalkStatus();
      });
    }

    if (panicUnknownInput) {
      panicUnknownInput.checked = !!bot.panic?.status?.().config?.unknownPlayerEnabled;
      panicUnknownInput.addEventListener("change", () => {
        bot.panic.updateConfig({ unknownPlayerEnabled: panicUnknownInput.checked });
        refreshPanicStatus();
      });
    }

    if (panicHealthInput) {
      panicHealthInput.checked = !!bot.panic?.status?.().config?.healthLossEnabled;
      panicHealthInput.addEventListener("change", () => {
        bot.panic.updateConfig({ healthLossEnabled: panicHealthInput.checked });
        refreshPanicStatus();
      });
    }

    if (panicReturnInput) {
      panicReturnInput.checked = !!bot.panic?.status?.().config?.returnToOriginEnabled;
      panicReturnInput.addEventListener("change", () => {
        bot.panic.updateConfig({ returnToOriginEnabled: panicReturnInput.checked });
        refreshPanicStatus();
      });
    }

    if (xrayOverlayButton) {
      xrayOverlayButton.addEventListener("click", () => {
        const enabled = !!bot.xray?.status?.().config?.overlayEnabled;
        bot.xray?.setOverlayEnabled?.(!enabled);
        refreshXrayStatus();
      });
    }

    if (xrayFloorSelect) {
      xrayFloorSelect.addEventListener("change", () => {
        const rawValue = xrayFloorSelect.value;
        bot.xray?.setSelectedFloor?.(rawValue === "all" ? null : Number(rawValue));
        refreshXrayStatus();
        refreshVisibleCreatures();
      });
    }

    panel.querySelector("#minibia-bot-set-home")?.addEventListener("click", () => {
      bot.pz.setHomePzCurrentSpot();
      refreshHomeLabel();
    });
	
	panel.querySelector("#minibia-bot-auto-attack-preferred-save")
	?.addEventListener("click", () => {
	saveAutoAttackPreferredConfig();
	});

	panel.querySelector("#minibia-bot-auto-attack-preferred-names")
	  ?.addEventListener("change", () => {
		saveAutoAttackPreferredConfig();
	});

	panel.querySelector("#minibia-bot-auto-attack-preferred-match-mode")
	  ?.addEventListener("change", () => {
		saveAutoAttackPreferredConfig();
	});

    refreshHomeLabel();
    refreshPanicStatus();
    refreshXrayStatus();
    renderGameMasterNames();
    renderTrustedNames();
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

	const visibleCreaturesTimerId = window.setInterval(refreshVisibleCreatures, 1000);
	bot.addCleanup(() => {
	  window.clearInterval(visibleCreaturesTimerId);
	});

	const talkStatusTimerId = window.setInterval(refreshTalkStatus, 1000);
	bot.addCleanup(() => {
	  window.clearInterval(talkStatusTimerId);
	});

	const caveStatusTimerId = window.setInterval(() => {
	  refreshCaveStatus();
	  refreshCavePresetControls();
	  refreshCaveClosestStatus();
	  refreshCaveTransitionStatus();
	}, 1000);
	bot.addCleanup(() => {
	  window.clearInterval(caveStatusTimerId);
	});

	/*
	 * Titlebar Cave / Target indicators
	 */
	const titlebarStatusTimerId = window.setInterval(refreshTitlebarRunIndicators, 500);
	bot.addCleanup(() => {
	  window.clearInterval(titlebarStatusTimerId);
	});

	refreshTitlebarRunIndicators();

  }

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

// Reload bootstrapping remains unchanged
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

    persistedEnabledModules.forEach(([moduleName]) => {
      const enabled = status?.[moduleName]?.config?.enabled;
      if (typeof enabled === "boolean") {
        snapshot[moduleName] = enabled;
      }
    });

    return snapshot;
  }

  function restorePersistedEnabledSnapshot(snapshot) {
    persistedEnabledModules.forEach(([moduleName, storageKey]) => {
      if (typeof snapshot?.[moduleName] !== "boolean") {
        return;
      }

      try {
        const rawValue = window.localStorage.getItem(storageKey);
        const config = rawValue ? JSON.parse(rawValue) : {};
        config.enabled = snapshot[moduleName];
        window.localStorage.setItem(storageKey, JSON.stringify(config));
      } catch (error) {
        console.error("[minibia-bot] failed to restore persisted enabled state", {
          module: moduleName,
          error,
        });
      }
    });
  }

  function boot(currentBundle = bundle) {
    const previousEnabledSnapshot = getPersistedEnabledSnapshot(window.minibiaBot);

    if (window.minibiaBot?.destroy) {
      window.minibiaBot.destroy();
    }

    restorePersistedEnabledSnapshot(previousEnabledSnapshot);

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
      pz: {
        home: bot.pz.getHomePz(),
      },
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

    console.log("[minibia-bot] ready", {
      version: bot.version,
      modules: ["pz", "xray", "panic", "rune", "heal", "invisible", "magicShield", "attack", "cave", "equipRing", "eat", "talk", "ui"],
    });
    console.log("minibiaBot.reload()");
    console.log("minibiaBot.xray.status()");
    console.log("minibiaBot.panic.status()");
    console.log("minibiaBot.pz.goToNearestPz()");
    console.log("minibiaBot.pz.setHomePzCurrentSpot()");
    console.log("minibiaBot.pz.goToHomePz()");
    console.log("minibiaBot.rune.start()");
    console.log("minibiaBot.rune.stop()");
    console.log("minibiaBot.heal.start()");
    console.log("minibiaBot.heal.stop()");
    console.log("minibiaBot.invisible.start()");
    console.log("minibiaBot.invisible.stop()");
    console.log("minibiaBot.magicShield.start()");
    console.log("minibiaBot.magicShield.stop()");
    console.log("minibiaBot.attack.start()");
    console.log("minibiaBot.attack.stop()");
    console.log("minibiaBot.cave.addWaypointCurrentSpot()");
    console.log("minibiaBot.cave.start()");
    console.log("minibiaBot.cave.stop()");
    console.log("minibiaBot.equipRing.start()");
    console.log("minibiaBot.equipRing.stop()");
    console.log("minibiaBot.eat.start()");
    console.log("minibiaBot.eat.stop()");
    console.log("minibiaBot.talk.updateConfig({ apiKey: \"...\" })");
    console.log("minibiaBot.talk.start()");
    console.log("minibiaBot.talk.stop()");
    return bot;
  }

  window.__minibiaBotReloadBundle = bundle;
  window.minibiaBotReload = () => boot(window.__minibiaBotReloadBundle || bundle);
  delete window.__minibiaBotBundle;
  boot(bundle);
})();

// InfernalScript (unchanged)
(() => {
  const TAG = "[InfernalScript]";

  const state = {
    installed: false,
    stopping: false,
    lastStopPacketAt: 0,
    forceStopUntil: 0
  };

  console.log(`${TAG} page hook loaded`);

  function waitForClient() {
    const client =
      window.gameClient ||
      window.GameClient?.instance ||
      window.client;

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

  try {
    if (typeof p.getTarget === "function") {
      target = p.getTarget();
    }
  } catch {}

  if (!target && p.__target !== null && p.__target !== undefined) {
    target = p.__target;
  }

  if (!target) return false;

  if (!isTargetOnScreen(client, target)) {
	  state.pausedForCombat = false
 //   console.log(
 //     "starting cavebot again",
 //     target.name || target.id || target
 //   );

    return false;
  }
  state.pausedForCombat = true
  return true;
}


function isTargetOnScreen(client, target) {
  const p = client.player;

  if (!p || !target) return false;

  try {
    if (typeof p.canSeeSmall === "function") {
      return p.canSeeSmall(target);
    }

    if (typeof p.canSee === "function") {
      return p.canSee(target);
    }
  } catch {}

  // Fallback manual screen-distance check based on Creature.canSee()
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
      if (typeof StopWalkPacket === "function") {
        client.send(new StopWalkPacket());
        //console.log(`${TAG} sent StopWalkPacket`);
      }
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

      // Cancel server-side mapclick/autowalk.
      sendStopWalk(client, forcePacket);

      // Clear autowalk/server-mapclick state.
      try { pf.__isAutoWalking = false; } catch {}
      try { pf.__autoWalkStepsRemaining = 0; } catch {}
      try { pf.__autowalkStartPosition = null; } catch {}
      try { pf.__autowalkStartedAt = 0; } catch {}

      // Clear final destination.
      try { pf.__finalDestination = null; } catch {}

      // Clear path cache.
      try {
        if (Array.isArray(pf.__pathfindCache)) {
          pf.__pathfindCache.length = 0;
        } else {
          pf.__pathfindCache = [];
        }
      } catch {}

      // Clear minimap continuation.
      try { pf.__minimapWaypoints = null; } catch {}
      try { pf.__recentMinimapStarts = []; } catch {}
      try { pf.__lastCancelPosition = null; } catch {}
      try { pf.__lastRetryDest = null; } catch {}
      try { pf.__lastRetryTime = 0; } catch {}

      // Clear hybrid prediction.
      try { pf.__hybridPath = null; } catch {}
      try { pf.__hybridNeedsAlign = false; } catch {}

      // Clear buffered future movement only.
      // Do NOT touch p.__movementEvent or p.__position.
      // Touching those causes snapping/teleporting.
      try { p.__movementBuffer = null; } catch {}
      try { p.__lookDirectionBuffer = null; } catch {}

      // Clear pending mouse walk-to actions.
      try {
        if (client.mouse) {
          client.mouse.__pendingUseObject = null;
          client.mouse.__pendingUsePosition = null;
          client.mouse.__pendingUseWithSource = null;
          client.mouse.__pendingMoveFrom = null;
        }
      } catch {}

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

      get() {
        return targetValue;
      },

      set(value) {
        targetValue = value;

        if (value !== null && value !== undefined) {
          //console.log(`${TAG} target active`, value?.name || value?.id || value);

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

    let finalDestinationValue = pf.__finalDestination ?? null;
    let isAutoWalkingValue = pf.__isAutoWalking ?? false;
    let pathfindCacheValue = Array.isArray(pf.__pathfindCache)
      ? pf.__pathfindCache
      : [];
    let hybridPathValue = pf.__hybridPath ?? null;

    Object.defineProperty(pf, "__finalDestination", {
      configurable: true,

      get() {
        return hasTarget(client) ? null : finalDestinationValue;
      },

      set(value) {
        if (hasTarget(client)) {
          finalDestinationValue = null;
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }

        finalDestinationValue = value;
      }
    });

    Object.defineProperty(pf, "__isAutoWalking", {
      configurable: true,

      get() {
        return hasTarget(client) ? false : isAutoWalkingValue;
      },

      set(value) {
        if (hasTarget(client)) {
          isAutoWalkingValue = false;
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }

        isAutoWalkingValue = value;
      }
    });

    Object.defineProperty(pf, "__pathfindCache", {
      configurable: true,

      get() {
        if (hasTarget(client)) {
          pathfindCacheValue.length = 0;
        }

        return pathfindCacheValue;
      },

      set(value) {
        if (hasTarget(client)) {
          pathfindCacheValue = [];
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }

        pathfindCacheValue = Array.isArray(value) ? value : [];
      }
    });

    Object.defineProperty(pf, "__hybridPath", {
      configurable: true,

      get() {
        return hasTarget(client) ? null : hybridPathValue;
      },

      set(value) {
        if (hasTarget(client)) {
          hybridPathValue = null;
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return;
        }

        hybridPathValue = value;
      }
    });

    pf.__stopOnTargetPropertyGuarded = true;

    console.log(`${TAG} guarded pathfinder properties`);
  }

  function patchGameClientSend(client) {
    if (!client || typeof client.send !== "function" || client.__stopOnTargetSendPatched) {
      return;
    }

    const originalSend = client.send;

    client.send = function (packet) {
      const packetName = packet?.constructor?.name || "";

      // Always allow StopWalkPacket.
      if (packetName === "StopWalkPacket") {
        return originalSend.call(this, packet);
      }

      // Block fresh mapclick/autowalk packets while target exists.
      if (
        hasTarget(client) &&
        (
          packetName === "AutoWalkPacket" ||
          packetName === "WalkToDestinationPacket"
        )
      ) {
        console.log(`${TAG} blocked outgoing ${packetName}`);
        state.forceStopUntil = performance.now() + 1000;
        hardStop(client, true);
        return false;
      }

      return originalSend.call(this, packet);
    };

    client.__stopOnTargetSendPatched = true;

    console.log(`${TAG} patched gameClient.send`);
  }

  function patchPathfinder(client) {
    const pf = client.world?.pathfinder;
    if (!pf || pf.__stopOnTargetFunctionsPatched) return;

    const methodsToBlock = [
      "findPath",
      "handlePathfind",
      "__predictHybridStep",
      "__findPathViaMinimap",
      "__continueAlongWaypoints",
      "getNextMove"
    ];

    for (const key of methodsToBlock) {
      if (typeof pf[key] !== "function") continue;

      const original = pf[key];

      pf[key] = function (...args) {
        if (hasTarget(client)) {
          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return false;
        }

        return original.apply(this, args);
      };

      console.log(`${TAG} patched pathfinder.${key}`);
    }

    if (typeof pf.setPathfindCache === "function") {
      const originalSetPathfindCache = pf.setPathfindCache;

      pf.setPathfindCache = function (path) {
        if (hasTarget(client)) {
          if (path === null) {
            return originalSetPathfindCache.call(this, path);
          }

          state.forceStopUntil = performance.now() + 800;
          hardStop(client, true);
          return false;
        }

        return originalSetPathfindCache.call(this, path);
      };

      console.log(`${TAG} patched pathfinder.setPathfindCache`);
    }

    pf.__stopOnTargetFunctionsPatched = true;
  }

  function patchPacketHandler(client) {
    const handler =
      client.networkManager?.packetHandler ||
      client.packetHandler;

    if (!handler || handler.__stopOnTargetPacketHandlerPatched) return;

    // Important:
    // Block incoming server autowalk path setup,
    // but DO NOT block handleCreatureServerMove.
    // Blocking creature movement causes teleporting.
    const methodsToBlock = [
      "handleAutoWalkPath"
    ];

    for (const key of methodsToBlock) {
      if (typeof handler[key] !== "function") continue;

      const original = handler[key];

      handler[key] = function (...args) {
        if (hasTarget(client)) {
          console.log(`${TAG} blocked incoming ${key}`);
          state.forceStopUntil = performance.now() + 1000;
          hardStop(client, true);
          return false;
        }

        return original.apply(this, args);
      };

      console.log(`${TAG} patched packetHandler.${key}`);
    }

    handler.__stopOnTargetPacketHandlerPatched = true;
  }

  function patchPlayerUnlockMovement(client) {
    const p = client.player;

    if (!p || typeof p.unlockMovement !== "function" || p.__stopOnTargetUnlockPatched) {
      return;
    }

    const originalUnlockMovement = p.unlockMovement;

    p.unlockMovement = function (...args) {
      if (hasTarget(client)) {
        // Clear future path state before original unlockMovement runs.
        // Original unlockMovement still gets to do normal end-of-step cleanup.
        hardStop(client, false);

        try {
          this.__movementBuffer = null;
          this.__lookDirectionBuffer = null;
        } catch {}

        return originalUnlockMovement.apply(this, args);
      }

      return originalUnlockMovement.apply(this, args);
    };

    p.__stopOnTargetUnlockPatched = true;

    console.log(`${TAG} patched player.unlockMovement - smooth cleanup mode`);
  }

  function startStopLoop(client) {
    let lastHadTarget = false;

    setInterval(() => {
      const active = hasTarget(client);
      const now = performance.now();

      if (active) {
        const shouldForce =
          !lastHadTarget ||
          now < state.forceStopUntil;

        // Keep cancelling mapclick while target exists.
        hardStop(client, shouldForce);
      }

      lastHadTarget = active;
    }, 100);

    console.log(`${TAG} target stop loop running - balanced interval mode`);
  }

  waitForClient();
})();
