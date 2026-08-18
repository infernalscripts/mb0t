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
    const cleanups = []; // Functions to run on destroy
    // ---- ALARM AUDIO (Multiple Sounds) ----
    const defaultAlarmAudioSrc = "https://upload.wikimedia.org/wikipedia/commons/5/5c/En-us-red_alert.oga";
    const playerAlarmSrc = "https://upload.wikimedia.org/wikipedia/commons/f/fc/Female_voice_saying_Player_on_screen.wav";
    const gmAlarmSrc = "https://upload.wikimedia.org/wikipedia/commons/2/2d/Female_Voice_saying_Gamemaster_Detected.wav";
    const antiBotAlarmSrc = "https://upload.wikimedia.org/wikipedia/commons/e/e3/Female_voice_saying_Anti-Bot_check.wav";
    const playerAttackAlarmSrc = "https://upload.wikimedia.org/wikipedia/commons/d/d6/Female_voice_saying_%22Player_Attack%22.wav";
    const messageAlarmSrc = "https://upload.wikimedia.org/wikipedia/commons/7/7d/Female_Voice_saying_%22Message%22.wav";
    const alarmAudioSrcStorageKey = "minibiaBot.audio.alarmSrc";
    const playerAlarmStorageKey = "minibiaBot.audio.playerAlarmSrc";
    const gmAlarmStorageKey = "minibiaBot.audio.gmAlarmSrc";
    const antiBotAlarmStorageKey = "minibiaBot.audio.antiBotAlarmSrc";
    const reconnectEnabledStorageKey = "minibiaBot.reconnect.enabled";
    const recentSentChats = []; // Tracks recently sent messages (avoid duplicates)
    const reconnectButtonSelectors = [// CSS selectors to find a reconnect button
        "button", "[role=\"button\"]", "input[type=\"button\"]",
        "input[type=\"submit\"]", "a", ".button", ".btn",
    ];
    function getReconnectEnabled() {
        try {
            const value = window.localStorage.getItem(reconnectEnabledStorageKey);
            return value === "true"; // default false
        } catch {
            return false;
        }
    }

    function setReconnectEnabled(enabled) {
        window.localStorage.setItem(reconnectEnabledStorageKey, JSON.stringify(!!enabled));
    }
    let alarmAudio = null; // Audio element for alarm sounds
    let reconnectObserver = null; // MutationObserver for reconnect detection
    let reconnectPollTimerId = null; // Interval timer for reconnect polling
    let lastReconnectClickAt = 0; // Throttle reconnect clicks

    // ---- CLEANUP SYSTEM ----
    function addCleanup(fn) {
        if (typeof fn === "function")
            cleanups.push(fn);
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

    // ---- ALARM AUDIO ----
    function getStoredAlarmAudioSrc() {
        try {
            const value = window.localStorage.getItem(alarmAudioSrcStorageKey);
            return value == null ? defaultAlarmAudioSrc : JSON.parse(value);
        } catch {
            return defaultAlarmAudioSrc;
        }
    }

    function setStoredAlarmAudioSrc(src) {
        window.localStorage.setItem(alarmAudioSrcStorageKey, JSON.stringify(src));
        return src;
    }

    function destroyAlarmAudio() {
        if (!alarmAudio)
            return;
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
        if (!src)
            return null;
        if (!alarmAudio || alarmAudio.src !== src) {
            if (alarmAudio)
                alarmAudio.pause();
            alarmAudio = new Audio(src);
            alarmAudio.preload = "auto";
        }
        return alarmAudio;
    }

    function setupGlobalAudioUnlock() {
        const unlock = () => {
            this.unlockAudio();
            // Remove listeners after first unlock to avoid spamming
            document.removeEventListener("click", unlock);
            document.removeEventListener("touchstart", unlock);
            document.removeEventListener("keydown", unlock);
        };
        document.addEventListener("click", unlock);
        document.addEventListener("touchstart", unlock);
        document.addEventListener("keydown", unlock);
    }

    // ---- CHAT HELPERS (deduplication) ----
    function normalizeChatText(text) {
        return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    }

    function rememberSentChat(text) {
        const normalized = normalizeChatText(text);
        if (!normalized)
            return;
        recentSentChats.push({
            text: normalized,
            at: Date.now()
        });
        const maxEntries = 20;
        if (recentSentChats.length > maxEntries) {
            recentSentChats.splice(0, recentSentChats.length - maxEntries);
        }
    }

    function isRecentSentChat(text, withinMs = 45000) {
        const normalized = normalizeChatText(text);
        if (!normalized)
            return false;
        const cutoff = Date.now() - withinMs;
        for (let i = recentSentChats.length - 1; i >= 0; i--) {
            const entry = recentSentChats[i];
            if (entry.at < cutoff)
                continue;
            if (entry.text === normalized)
                return true;
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
            if (value)
                return value;
        }
        return null;
    }

    function parseNumberText(value) {
        if (value == null)
            return null;
        const normalized = String(value).replace(/[^\d.-]/g, "");
        if (!normalized)
            return null;
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    // ---- VISIBILITY & UI TEXT EXTRACTION ----
    function isVisibleElement(element) {
        if (!(element instanceof Element))
            return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return false;
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }

    function getElementUiText(element) {
        if (!(element instanceof Element))
            return "";
        return normalizeUiText(
            element.textContent ||
            element.innerText ||
            element.getAttribute("value") ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            "");
    }

    // ---- RECONNECT WATCHER ----
    function findReconnectElement() {
        for (const selector of reconnectButtonSelectors) {
            const candidates = document.querySelectorAll(selector);
            for (const candidate of candidates) {
                if (!isVisibleElement(candidate))
                    continue;
                if (getElementUiText(candidate) === "reconnect")
                    return candidate;
            }
        }
        return null;
    }

    function tryClickReconnect() {
        const now = Date.now();
        if (now - lastReconnectClickAt < 3000)
            return false;
        const el = findReconnectElement();
        if (!el)
            return false;
        el.click();
        lastReconnectClickAt = now;
        console.log("[minibia-bot] clicked reconnect");
        return true;
    }

    function startReconnectWatcher() {
        if (reconnectObserver || reconnectPollTimerId)
            return;
        const runCheck = () => {
            try {
                // Only try to reconnect if we're actually disconnected
                const isConnected = window.gameClient?.networkManager?.isConnected?.();
                if (isConnected === false) {
                    tryClickReconnect();
                }
            } catch (e) {
                console.error("[minibia-bot] reconnect watcher failed", e);
            }
        };
        reconnectObserver = new MutationObserver(runCheck);
        reconnectObserver.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "hidden", "aria-hidden", "value"]
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

    if (getReconnectEnabled()) {
        startReconnectWatcher();
    }

    // ---- __imB COUNTER RESET (prevents input spam detection) ----
    let __imbResetInterval = null;
    function startImbReset(intervalMs = 5000) {
        if (__imbResetInterval)
            return;
        __imbResetInterval = setInterval(() => {
            if (typeof __imB !== 'undefined')
                __imB = 0;
            if (typeof __provTicks !== 'undefined')
                __provTicks = 0;
        }, intervalMs);
    }
    function stopImbReset() {
        if (__imbResetInterval) {
            clearInterval(__imbResetInterval);
            __imbResetInterval = null;
        }
    }
    startImbReset(1000);

    // ---- PATCH gameClient.send to manipulate __imA/__imB ----
    let originalSend = null;
    if (window.gameClient && typeof window.gameClient.send === 'function') {
        originalSend = window.gameClient.send;
        window.gameClient.send = function (packet) {
            // Call the original send
            originalSend.call(this, packet);

            // ---- Extract opcode safely ----
            let opcode = -1;
            if (packet && typeof packet.getBuffer === 'function') {
                const buf = packet.getBuffer();
                if (buf && buf.length > 0)
                    opcode = buf[0];
            } else if (packet && packet.opcode !== undefined) {
                opcode = packet.opcode;
            } else if (packet && packet.length > 0) {
                opcode = packet[0];
            }

            // ---- Classify direct-intent opcodes ----
            // Use window.CONST if available, otherwise fallback to numeric values
            const CLIENT = (typeof CONST !== 'undefined' && CONST.PROTOCOL?.CLIENT)
             ? CONST.PROTOCOL.CLIENT
             : {
                TARGET: 0x01,
                CAST_SPELL: 0x02,
                THING_USE_WITH: 0x03,
                THING_USE_ON_CREATURE: 0x04,
                CHANNEL_MESSAGE: 0x05
            };

            const classified = [
                CLIENT.TARGET,
                CLIENT.CAST_SPELL,
                CLIENT.THING_USE_WITH,
                CLIENT.THING_USE_ON_CREATURE,
                CLIENT.CHANNEL_MESSAGE
            ];

            if (classified.includes(opcode)) {
                if (typeof __imA !== 'undefined')
                    __imA++;
                if (typeof __imB !== 'undefined')
                    __imB = 0;
            }
        };

        // Add cleanup to restore original send when bot is destroyed
        addCleanup(() => {
            if (window.gameClient && originalSend) {
                window.gameClient.send = originalSend;
            }
        });
    } else {
        console.warn('[minibia-bot] gameClient.send not available – counter patch skipped');
    }

    // ---- DEADMAN SWITCH BYPASS ----
    function applyDeadmanBypass() {
        try {
            if (typeof Keyboard !== 'undefined' && Keyboard.prototype) {
                Keyboard.prototype.MOVEMENT_RECOVERY_ENABLED = false;
                Keyboard.prototype.MOVEMENT_DEADMAN_SILENCE_MS = 99999999;
                Keyboard.prototype.MOVEMENT_DEADMAN_ARM_MS = 99999999;
                console.log('[minibia-bot] Deadman switch disabled via prototype');
            }
            // Also apply to the current instance if it exists
            const kb = window.gameClient?.keyboard;
            if (kb) {
                kb.MOVEMENT_RECOVERY_ENABLED = false;
                kb.MOVEMENT_DEADMAN_SILENCE_MS = 99999999;
                kb.MOVEMENT_DEADMAN_ARM_MS = 99999999;
                kb.__checkMovementDeadman = function () {};
                console.log('[minibia-bot] Deadman switch disabled on instance');
            }
        } catch (e) {
            // Ignore
        }
    }
    applyDeadmanBypass();

    // Periodically refresh keyboard timestamps (defense in depth)
    let deadmanRefreshInterval = null;
    function startDeadmanRefresh(intervalMs = 500) {
        if (deadmanRefreshInterval)
            return;
        deadmanRefreshInterval = setInterval(() => {
            try {
                const kb = window.gameClient?.keyboard;
                if (kb) {
                    const now = performance.now();
                    kb.__lastInputAt = now;
                    kb.__lastFreshPressAt = now;
                }
            } catch (e) { /* ignore */
            }
        }, intervalMs);
    }
    startDeadmanRefresh(500);

    // Clean up the interval when the bot is destroyed
    addCleanup(() => {
        if (deadmanRefreshInterval) {
            clearInterval(deadmanRefreshInterval);
            deadmanRefreshInterval = null;
        }
    });

    // ---- ITEM FINDER ----
    function findItemById(itemId) {
        const eq = window.gameClient?.player?.equipment;
        const containers = window.gameClient?.player?.__openedContainers || [];
        if (eq) {
            for (let i = 0; i < eq.slots.length; i++) {
                const item = eq.getSlotItem(i);
                if (item && item.id === itemId)
                    return {
                        container: eq,
                        slot: i,
                        item
                    };
            }
        }
        const arr = Array.isArray(containers) ? containers : Array.from(containers);
        for (const container of arr) {
            if (!container || typeof container.size !== 'number')
                continue;
            for (let i = 0; i < container.size; i++) {
                const item = container.getSlotItem(i);
                if (item && item.id === itemId)
                    return {
                        container,
                        slot: i,
                        item
                    };
            }
        }
        return null;
    }

    function useItemFromSource(source) {
        if (!source)
            return false;
        try {
            if (window.gameClient?.mouse?.use) {
                window.gameClient.mouse.use({
                    which: source.container,
                    index: source.slot
                });
                return true;
            }
            if (window.gameClient?.send && typeof UsePacket === 'function') {
                window.gameClient.send(new UsePacket(source.container, source.slot));
                return true;
            }
            return false;
        } catch (e) {
            this.log('useItem failed', e);
            return false;
        }
    }

    // ---- TILE HELPERS ----
    function getTileAtPosition(pos) {
        if (!pos)
            return null;
        return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(pos.x, pos.y, pos.z)) || null;
    }

    function getChebyshevDistance(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return Number.POSITIVE_INFINITY;
        return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    }

    function isAdjacentTile(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return false;
        const dx = Math.abs(from.x - to.x);
        const dy = Math.abs(from.y - to.y);
        return dx <= 1 && dy <= 1;
    }

    function getTopItemOnTile(tile) {
        if (!tile)
            return null;
        if (tile.id)
            return tile;
        if (Array.isArray(tile.items) && tile.items.length > 0) {
            return tile.items[0];
        }
        return null;
    }

    function getItemId(thing) {
        return thing?.id ?? null;
    }

    function useItemOnTile(source, tile) {
        if (!source || !tile)
            return false;
        try {
            const from = {
                which: source.container,
                index: source.slot
            };
            const to = {
                which: tile,
                index: 0xFF
            };
            if (window.gameClient?.mouse?.__handleItemUseWith) {
                window.gameClient.mouse.__handleItemUseWith(from, to);
                return true;
            }
            if (window.gameClient?.send && typeof ThingUseWithPacket === 'function') {
                window.gameClient.send(new ThingUseWithPacket(from, to));
                return true;
            }
            return false;
        } catch (e) {
            this.log('useItemOnTile failed', e);
            return false;
        }
    }

    function useTile(tile) {
        if (!tile)
            return false;
        try {
            if (window.gameClient?.mouse?.use) {
                window.gameClient.mouse.use({
                    which: tile,
                    index: 0xFF
                });
                return true;
            }
            if (window.gameClient?.send && typeof UsePacket === 'function') {
                window.gameClient.send(new UsePacket(tile, 0xFF));
                return true;
            }
            return false;
        } catch (e) {
            this.log('useTile failed', e);
            return false;
        }
    }

    // ---- PUBLIC API ----
    return {
        version: "0.7.7",
        addCleanup,

        /** Destroy the bot and all its modules (call before reload) */
        destroy() {
            if (this.panic?.stop)
                this.panic.stop();
            if (this.rune?.stop)
                this.rune.stop({
                    persistEnabled: false
                });
            if (this.heal?.stop)
                this.heal.stop({
                    persistEnabled: false
                });
            if (this.invisible?.stop)
                this.invisible.stop({
                    persistEnabled: false
                });
            if (this.attack?.stop)
                this.attack.stop({
                    persistEnabled: false
                });
            if (this.cave?.stop)
                this.cave.stop({
                    persistEnabled: false
                });
            if (this.equipRing?.stop)
                this.equipRing.stop({
                    persistEnabled: false
                });
            if (this.eat?.stop)
                this.eat.stop({
                    persistEnabled: false
                });
            if (this.talk?.stop)
                this.talk.stop({
                    persistEnabled: false
                });
            if (this.ui?.destroy)
                this.ui.destroy();
            stopReconnectWatcher();
            stopImbReset();
            destroyAlarmAudio();
            runCleanups();
        },

        log(...args) {
            console.log("[mbot]", ...args);
        },

        /** Simple localStorage wrapper with JSON serialisation */
        storage: {
            get(key, fallback = null) {
                try {
                    const value = window.localStorage.getItem(key);
                    return value == null ? fallback : JSON.parse(value);
                } catch {
                    return fallback;
                }
            },
            set(key, value) {
                window.localStorage.setItem(key, JSON.stringify(value));
                return value;
            },
            remove(key) {
                window.localStorage.removeItem(key);
            }
        },

        reconnect: {
            enable: () => {
                setReconnectEnabled(true);
                startReconnectWatcher();
            },
            disable: () => {
                setReconnectEnabled(false);
                stopReconnectWatcher();
            },
            isEnabled: getReconnectEnabled,
            start: startReconnectWatcher,
            stop: stopReconnectWatcher,
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
                "").trim() || null;
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
            if (!channelManager || !text)
                return false;
            channelManager.sendMessageText(text);
            rememberSentChat(text);
            //this.log("sent chat:", text);
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
            if (!button)
                return false;
            button.click();
            return true;
        },

        /** Alarm audio management */
        getAlarmAudioSrc() {
            return getStoredAlarmAudioSrc();
        },
        setAlarmAudioSrc(src) {
            const nextSrc = String(src || "").trim();
            if (!nextSrc)
                return false;
            setStoredAlarmAudioSrc(nextSrc);
            destroyAlarmAudio();
            this.log("alarm audio updated", nextSrc);
            return true;
        },

        /** Unlock audio autoplay by playing a muted sound */
        unlockAudio() {
            try {
                if (!this.__unlockAudio) {
                    this.__unlockAudio = new Audio();
                }
                const audio = this.__unlockAudio;
                audio.muted = true;
                const playResult = audio.play();
                if (playResult && typeof playResult.then === "function") {
                    playResult.then(() => {
                        audio.pause();
                        audio.currentTime = 0;
                        audio.muted = false;
                    }).catch(() => {
                        audio.muted = false;
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

        /** Play the alarm sound */
        playAlarm() {
            try {
                const audio = getAlarmAudio();
                if (!audio)
                    return false;
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

        /** Play the player-on-screen alarm */
        playPlayerAlarm() {
            return this._playSpecificAlarm(playerAlarmSrc, "playerAlarm");
        },

        /** Play the gamemaster-detected alarm */
        playGMAlarm() {
            return this._playSpecificAlarm(gmAlarmSrc, "gmAlarm");
        },

        /** Play the anti-bot-check alarm */
        playAntiBotAlarm() {
            return this._playSpecificAlarm(antiBotAlarmSrc, "antiBotAlarm");
        },

        /** Play the player-attack alarm */
        playPlayerAttackAlarm() {
            return this._playSpecificAlarm(playerAttackAlarmSrc, "playerAttackAlarm");
        },

        /** Play the message alert alarm */
        playMessageAlarm() {
            return this._playSpecificAlarm(messageAlarmSrc, "messageAlarm");
        },

        /** Internal helper for specific alarms */
        _playSpecificAlarm(src, label) {
            try {
                // Create a shared audio element if it doesn't exist
                if (!this.__specificAlarmAudio) {
                    this.__specificAlarmAudio = new Audio();
                    this.__specificAlarmAudio.preload = "auto";
                }
                const audio = this.__specificAlarmAudio;

                // Unlock the audio context (uses a standalone method below)
                this.unlockAudio();

                // Update source if changed
                if (audio.src !== src) {
                    audio.src = src;
                    audio.load();
                }

                audio.currentTime = 0;
                audio.volume = 1;
                const playPromise = audio.play();
                if (playPromise && typeof playPromise.catch === "function") {
                    playPromise.catch((error) => {
                        console.error(`[minibia-bot] ${label} playback failed:`, error);
                        this.log(`${label} playback failed`, error?.message || error);
                    });
                }
                return true;
            } catch (error) {
                console.error(`[minibia-bot] ${label} creation failed:`, error);
                this.log(`${label} creation failed`, error?.message || error);
                return false;
            }
        },

        /** Control the __imB reset interval */
        imbReset: {
            start: () => startImbReset(1000),
            stop: stopImbReset,
            reset: () => {
                if (typeof __imB !== 'undefined')
                    __imB = 0;
            }
        },

        // ---- GLOBAL ALIASES ----
        level() {
            const snap = this.getPlayerSnapshot();
            return snap?.level ?? null;
        },
        experience() {
            const snap = this.getPlayerSnapshot();
            return snap?.experience ?? null;
        },
        health() {
            const snap = this.getPlayerSnapshot();
            return snap?.health ?? null;
        },
        healthPercent() {
            const snap = this.getPlayerSnapshot();
            if (snap?.maxHealth && snap.maxHealth > 0)
                return (snap.health / snap.maxHealth) * 100;
            return null;
        },
        healthMax() {
            const snap = this.getPlayerSnapshot();
            return snap?.maxHealth ?? null;
        },
        mana() {
            const snap = this.getPlayerSnapshot();
            return snap?.mana ?? null;
        },
        manaPercent() {
            const snap = this.getPlayerSnapshot();
            if (snap?.maxMana && snap.maxMana > 0)
                return (snap.mana / snap.maxMana) * 100;
            return null;
        },
        manaMax() {
            const snap = this.getPlayerSnapshot();
            return snap?.maxMana ?? null;
        },
        cap() {
            const snap = this.getPlayerSnapshot();
            return snap?.capacity ?? null;
        },
        position() {
            return this.getPlayerPosition();
        },
        say(text) {
            return this.sendChat(text);
        },
        print(...args) {
            console.log(...args);
        },

        // ---- USE ITEM (right-click from inventory) ----
        use(itemId) {
            const source = findItemById(itemId);
            if (!source) {
                this.log(`Item ${itemId} not found in equipment or open containers.`);
                return false;
            }
            return useItemFromSource(source);
        },

        // ---- USE ITEM ON TILE ----
        useItemOnPosition(itemId, x, y, z) {
            const pos = {
                x,
                y,
                z
            };
            const tile = getTileAtPosition(pos);
            if (!tile) {
                this.log(`Tile at ${x},${y},${z} is not loaded.`);
                return false;
            }
            const source = findItemById(itemId);
            if (!source) {
                this.log(`Item ${itemId} not found.`);
                return false;
            }
            return useItemOnTile(source, tile);
        },

        // ---- USE POSITION (right-click on tile) ----
        usePosition(x, y, z) {
            const pos = {
                x,
                y,
                z
            };
            const tile = getTileAtPosition(pos);
            if (!tile) {
                this.log(`Tile at ${x},${y},${z} is not loaded.`);
                return false;
            }
            return useTile(tile);
        },

        // ---- GET ITEM ID AT POSITION ----
        getItemAtPosition(x, y, z) {
            const pos = {
                x,
                y,
                z
            };
            const tile = getTileAtPosition(pos);
            if (!tile)
                return null;
            const top = getTopItemOnTile(tile);
            return top ? getItemId(top) : null;
        },

        // ---- WAIT (pause cavebot) ----
        wait(ms) {
            if (typeof ms !== 'number' || ms < 0) {
                this.log('wait() requires a positive number of milliseconds.');
                return false;
            }
            this._waitUntil = Date.now() + ms;
            this.log(`Cavebot paused for ${ms}ms until ${new Date(this._waitUntil).toLocaleTimeString()}`);
            setTimeout(() => {
                this._waitUntil = 0;
                this.log('Cavebot wait expired, resuming.');
            }, ms);
            return true;
        },
        // ---- COUNT ITEMS IN OPEN CONTAINERS ----
        itemCount(itemId) {
            let total = 0;
            const containers = window.gameClient?.player?.__openedContainers;
            if (!containers)
                return 0;
            const containerArr = Array.isArray(containers) ? containers : Array.from(containers);
            for (const container of containerArr) {
                if (!container || typeof container.size !== 'number')
                    continue;
                for (let i = 0; i < container.size; i++) {
                    const item = container.getSlotItem(i);
                    if (item && item.id === itemId) {
                        // Use getCount() if available, otherwise fallback to count property or 1
                        const count = (typeof item.getCount === 'function') ? item.getCount() : (item.count || 1);
                        total += count;
                    }
                }
            }
            return total;
        },

        follow: function (name) {
            const targetName = String(name || "").trim();
            if (!targetName) {
                this.log("follow: name required.");
                return false;
            }
            const creatures = window.gameClient?.world?.activeCreatures || {};
            const player = window.gameClient?.player;
            if (!player) {
                this.log("follow: player not found.");
                return false;
            }
            // Find creature by name (case-insensitive)
            let target = null;
            for (const id in creatures) {
                const c = creatures[id];
                if (c.name && c.name.toLowerCase() === targetName.toLowerCase()) {
                    target = c;
                    break;
                }
            }
            if (!target) {
                this.log(`follow: player "${targetName}" not found on screen.`);
                return false;
            }
            if (target.id === player.id) {
                this.log("follow: cannot follow yourself.");
                return false;
            }
            // Set follow target and send packet
            try {
                player.setFollowTarget(target);
                window.gameClient.send(new FollowPacket(target.id));
                this.log(`Following ${targetName}.`);
                return true;
            } catch (e) {
                this.log("follow: failed to send FollowPacket", e);
                return false;
            }
        },

        stopFollow: function () {
            const player = window.gameClient?.player;
            if (!player)
                return false;
            try {
                player.setFollowTarget(null);
                window.gameClient.send(new FollowPacket(0));
                this.log("Stopped following.");
                return true;
            } catch (e) {
                this.log("stopFollow: failed", e);
                return false;
            }
        },

        // ---- GO TO WAYPOINT BY LABEL ----
        goToLabel(labelname) {
            if (!labelname) {
                this.log("goToLabel: label name required.");
                return false;
            }
            const route = this.cave?.getRoute?.();
            if (!route || !route.length) {
                this.log("goToLabel: no route loaded.");
                return false;
            }
            const normalized = String(labelname).trim().toLowerCase();
            const index = route.findIndex(wp => {
                const wpLabel = wp.label ? String(wp.label).trim().toLowerCase() : "";
                return wpLabel === normalized;
            });
            if (index === -1) {
                this.log(`goToLabel: label "${labelname}" not found in route.`);
                return false;
            }
            const wp = route[index];
            this.cave.setCurrentIndex(index);
            this.log(`goToLabel: jumping to "${labelname}" (index ${index})`);
            // If the cavebot is running, start pathing to that waypoint
            if (this.cave?.status?.().running) {
                this.cave.goToWaypoint(wp);
            } else {
                // If cavebot is stopped, just set the index – user can start later
                this.log("goToLabel: cavebot not running, only index updated.");
            }
            return true;
        },

        // ---- GET INDEX BY LABEL (helper) ----
        getWaypointIndexByLabel(labelname) {
            if (!labelname)
                return -1;
            const route = this.cave?.getRoute?.();
            if (!route || !route.length)
                return -1;
            const normalized = String(labelname).trim().toLowerCase();
            return route.findIndex(wp => {
                const wpLabel = wp.label ? String(wp.label).trim().toLowerCase() : "";
                return wpLabel === normalized;
            });
        },

        getAlarmAudio, // expose the internal function
    }
};

/**
 * =============================================== ===================================
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
            if (!chunk?.tiles)
                continue;
            for (const tile of chunk.tiles) {
                if (tile?.__position)
                    tiles.push(tile);
            }
        }
        return tiles;
    }

    function hasPzFlag(tile) {
        return !!tile && ((tile.flags || 0) & 1) !== 0;
    }

    function getPzCandidates() {
        const me = bot.getPlayerPosition();
        if (!me)
            return [];
        return getLoadedTiles()
        .filter(t => hasPzFlag(t) && t.__position?.z === me.z)
        .map(t => {
            const p = t.__position;
            return {
                tile: t,
                x: p.x,
                y: p.y,
                z: p.z,
                flags: t.flags || 0,
                dist: Math.abs(p.x - me.x) + Math.abs(p.y - me.y)
            };
        })
        .sort((a, b) => a.dist - b.dist);
    }

    function goToTile(tile) {
        if (!tile?.__position)
            return false;
        const from = bot.getPlayerPosition();
        if (!from)
            return false;
        const p = tile.__position;
        const to = new Position(p.x, p.y, p.z);
        try {
            window.gameClient?.world?.pathfinder?.findPath?.(from, to);
            bot.log("pathing to", {
                x: p.x,
                y: p.y,
                z: p.z,
                flags: tile.flags
            });
            return true;
        } catch (error) {
            bot.log("pathing failed", {
                x: p.x,
                y: p.y,
                z: p.z,
                error: error?.message
            });
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
                bot.log("selected PZ", candidate);
                return true;
            }
        }
        bot.log("No PZ candidate accepted by pathfinder");
        return false;
    }

    function setHomePz(x, y, z) {
        const home = {
            x,
            y,
            z
        };
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
            .filter(t => hasPzFlag(t) && t.__position?.z === z)
            .map(t => {
                const p = t.__position;
                return {
                    tile: t,
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    flags: t.flags || 0,
                    dist: Math.abs(p.x - x) + Math.abs(p.y - y)
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
        bot.log("home candidate", candidate);
        return goToTile(candidate.tile);
    }

    function printPzCandidates(limit = 10) {
        const rows = getPzCandidates().slice(0, limit).map(c => ({
                    x: c.x,
                    y: c.y,
                    z: c.z,
                    flags: c.flags,
                    dist: c.dist
                }));
        console.table(rows);
        return rows;
    }

    // Expose public API
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
        printPzCandidates
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
    const overlayState = {
        running: false,
        timerId: null
    };

    const config = Object.assign({
        overlayEnabled: false,
        selectedFloor: null
    },
            bot.storage.get(configStorageKey, {}));
    config.selectedFloor = normalizeSelectedFloor(config.selectedFloor);

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function normalizeName(name) {
        return String(name || "").trim().toLowerCase();
    }

    function normalizeSelectedFloor(value) {
        if (value == null || value === "" || value === "all")
            return null;
        const floor = Number(value);
        if (!Number.isFinite(floor))
            return null;
        return Math.trunc(floor);
    }

    function isWithinVisibleRange(me, pos) {
        if (!me || !pos)
            return false;
        const dx = Math.abs(pos.x - me.x);
        const dy = Math.abs(pos.y - me.y);
        return dx <= 8 && dy <= 6; // Tibia screen radius
    }

    function getTrackedCreatures() {
        const myState = bot.getPlayerState();
        const myId = window.gameClient?.player?.id;
        const myName = normalizeName(myState?.name);
        return Object.values(window.gameClient?.world?.activeCreatures || {})
        .filter(creature => {
            if (!creature)
                return false;
            if (creature.id === myId)
                return false;
            const name = normalizeName(creature.name);
            if (name && name === myName)
                return false;
            return true;
        });
    }

    /** Creatures visible on screen (within viewport) */
    function getVisibleCreatures() {
        const me = bot.getPlayerPosition();
        if (!me)
            return [];
        return getTrackedCreatures().filter(c => isWithinVisibleRange(me, c.__position));
    }

    /** Visible players (type === 0) – optionally only same floor */
    function getVisiblePlayers(options = {}) {
        const { sameFloorOnly = false } = options;
        const me = bot.getPlayerPosition();
        if (!me)
            return [];
        return getVisibleCreatures().filter(c => {
            if (c?.type !== 0)
                return false;
            if (!sameFloorOnly)
                return true;
            return c.__position?.z === me.z;
        });
    }

    /** Visible monsters (type !== 0) – optionally only same floor */
    function getVisibleMonsters(options = {}) {
        const { sameFloorOnly = false } = options;
        const me = bot.getPlayerPosition();
        if (!me)
            return [];
        return getVisibleCreatures().filter(c => {
            if (c?.type === 0)
                return false;
            if (!sameFloorOnly)
                return true;
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
        if (current != null && max != null)
            return `${Number(current)}/${Number(max)} HP`;
        if (percent != null)
            return `${Math.round(Number(percent))}% HP`;
        if (current != null)
            return `${Number(current)} HP`;
        return null;
    }

    function getCreatureLabel(creature) {
        return creature?.name || (creature?.type === 0 ? "Player" : "Mob");
    }

    /** Creatures to be displayed on the overlay (off‑floor or off‑screen) */
    function getOverlayCreatures() {
        const me = bot.getPlayerPosition();
        if (!me)
            return [];
        return getTrackedCreatures().filter(c => {
            const pos = c?.__position;
            if (!pos || pos.z == null)
                return false;
            if (config.selectedFloor != null && pos.z !== config.selectedFloor)
                return false;
            if (pos.z !== me.z) {
                return isWithinVisibleRange(me, pos); // other floors within visible radius
            }
            return !isWithinVisibleRange(me, pos); // same floor but off‑screen
        });
    }

    // ---- OVERLAY RENDERING ----
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function ensureOverlayStyle() {
        if (document.getElementById(overlayStyleId))
            return;
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
        if (root)
            return root;
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
            .map(c => ({
                    canvas: c,
                    rect: c.getBoundingClientRect()
                }))
            .filter(({
                    rect
                }) => rect.width >= 200 && rect.height >= 150)
            .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
        return canvases[0]?.rect || null;
    }

    function renderOverlay() {
        if (!overlayState.running)
            return;
        const root = ensureOverlayRoot();
        const me = bot.getPlayerPosition();
        const viewportRect = getViewportRect();
        const creatures = getOverlayCreatures();
        root.innerHTML = "";
        if (!me || !viewportRect || !creatures.length)
            return;

        const tileWidth = viewportRect.width / 17;
        const tileHeight = viewportRect.height / 13;
        const edgePadding = 48;

        creatures.forEach(c => {
            const pos = c.__position;
            if (!pos)
                return;
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
                        viewportRect.right - edgePadding)}px`;
                marker.style.top = `${clamp(
                        viewportRect.top + ((dy + 6.5) * tileHeight),
                        viewportRect.top + edgePadding,
                        viewportRect.bottom - edgePadding)}px`;
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
        if (overlayState.running)
            return false;
        overlayState.running = true;
        ensureOverlayStyle();
        renderOverlay();
        overlayState.timerId = window.setInterval(renderOverlay, 250);
        return true;
    }

    function stopOverlay() {
        config.overlayEnabled = false;
        persistConfig();
        if (!overlayState.running && overlayState.timerId == null)
            return false;
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
        if (next)
            return startOverlay();
        return stopOverlay();
    }

    function setSelectedFloor(floor) {
        config.selectedFloor = normalizeSelectedFloor(floor);
        persistConfig();
        if (overlayState.running)
            renderOverlay();
        return config.selectedFloor;
    }

    function status() {
        return {
            visibleCreatures: getVisibleCreatures().map(c => ({
                    id: c.id,
                    name: c.name,
                    type: c.type,
                    position: c.__position
                })),
            visiblePlayers: getVisiblePlayers().map(p => ({
                    id: p.id,
                    name: p.name,
                    position: p.__position
                })),
            visiblePlayersCurrentFloor: getVisiblePlayers({
                sameFloorOnly: true
            }).map(p => ({
                    id: p.id,
                    name: p.name,
                    position: p.__position
                })),
            visibleMonsters: getVisibleMonsters().map(m => ({
                    id: m.id,
                    name: m.name,
                    type: m.type,
                    position: m.__position
                })),
            visibleMonstersCurrentFloor: getVisibleMonsters({
                sameFloorOnly: true
            }).map(m => ({
                    id: m.id,
                    name: m.name,
                    type: m.type,
                    position: m.__position
                })),
            overlayCreatures: getOverlayCreatures().map(c => ({
                    id: c.id,
                    name: c.name,
                    type: c.type,
                    position: c.__position
                })),
            config: {
                ...config
            },
            overlayRunning: overlayState.running,
        };
    }

    // Public API
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
        config
    };

    // Auto‑start if enabled
    if (config.overlayEnabled)
        startOverlay();
    else
        destroyOverlayElements();
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

    const config = Object.assign({
        tickMs: 200,
        triggerCooldownMs: 4000,
        returnToOriginEnabled: false,
        returnDelayMs: 300000, // 5 minutes
        returnDelayJitterMs: 30000, // ±30 seconds
        returnRetryCooldownMs: 2000,
        unknownPlayerEnabled: false,
        healthLossEnabled: false,
        playerAlertEnabled: false,
        playerAlertCooldownMs: 60000,
        trustedNames: [],
        gameMasterNames: [],
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
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
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
            return null;
        return {
            x,
            y,
            z
        };
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
        if (!me)
            return players;
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
                })));
    }

    function parseDamageMessage(entry) {
        const match = entry.message.match(/^You lose\s+(\d+)\s+hitpoints\s+due to an attack by\s+(.+?)\.$/i);
        if (!match)
            return null;
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
        if (!jitter)
            return base;
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
        if (!config.returnToOriginEnabled) {
            clearPendingReturn();
            return;
        }
        if (!state.pendingReturnOrigin && origin) {
            state.pendingReturnOrigin = origin;
            state.pendingReturnModules = snapshotInterruptedModules();
        }
        if (!state.pendingReturnOrigin)
            return;
        state.lastThreatAt = now;
        state.returnNotBeforeAt = now + getReturnDelayMs();
    }

    function isReturnCoastClear() {
        return !getVisibleGameMasters().length && !getUnknownVisiblePlayers().length;
    }

    function restoreInterruptedModules() {
        if (state.pendingReturnModules?.caveRunning)
            bot.cave?.start?.();
        if (state.pendingReturnModules?.equipRingRunning) {
            bot.equipRing?.start?.();
            bot.ui?.refreshEquipRingStatus?.();
        }
    }

    function tryReturnToOrigin(now = Date.now()) {
        if (!config.returnToOriginEnabled || !state.pendingReturnOrigin || !state.returnNotBeforeAt)
            return false;
        if (now < state.returnNotBeforeAt)
            return false;
        if (!isReturnCoastClear())
            return false;
        if (now - state.lastReturnAttemptAt < normalizeDelayMs(config.returnRetryCooldownMs, 2000))
            return false;

        const currentPos = normalizePosition(bot.getPlayerPosition());
        if (isSamePosition(currentPos, state.pendingReturnOrigin)) {
            bot.log("panic return completed", {
                origin: state.pendingReturnOrigin,
                threatAgeMs: now - state.lastThreatAt
            });
            restoreInterruptedModules();
            clearPendingReturn();
            return true;
        }
        state.lastReturnAttemptAt = now;
        const moved = !!bot.cave?.goToPosition?.(state.pendingReturnOrigin) ||
            !!bot.pz?.goToTile?.({
                __position: state.pendingReturnOrigin
            });
        if (moved) {
            bot.log("panic returning to origin", {
                origin: state.pendingReturnOrigin,
                threatAgeMs: now - state.lastThreatAt
            });
            return true;
        }
        bot.log("panic return pathing failed", {
            origin: state.pendingReturnOrigin
        });
        return false;
    }

    // ---- TRIGGER FUNCTIONS ----
    function triggerPanic(reason, details = {}) {
        const now = Date.now();
        armPendingReturn(now);
        if (now - state.lastTriggerAt < config.triggerCooldownMs)
            return false;
        state.lastTriggerAt = now;
        bot.playAlarm?.();
        bot.log("panic triggered", {
            reason,
            ...details
        });
        if (bot.cave?.stop)
            bot.cave.stop({
                persistEnabled: false
            });
        if (bot.equipRing?.stop) {
            bot.equipRing.stop({
                persistEnabled: false
            });
            bot.ui?.refreshEquipRingStatus?.();
        }
        return !!bot.pz?.goToHomePz?.();
    }

    function triggerGameMasterKillSwitch(players) {
        const detectedPlayers = (players || []).map(p => p?.name).filter(Boolean);
        bot.playGMAlarm?.();
        bot.log("game master kill switch triggered", {
            players: detectedPlayers
        });
        // Stop all modules
        if (bot.rune?.stop)
            bot.rune.stop();
        if (bot.eat?.stop)
            bot.eat.stop();
        if (bot.invisible?.stop)
            bot.invisible.stop();
        if (bot.magicShield?.stop)
            bot.magicShield.stop();
        if (bot.cave?.stop)
            bot.cave.stop();
        if (bot.attack?.stop)
            bot.attack.stop();
        if (bot.equipRing?.stop)
            bot.equipRing.stop();
        if (bot.slimeTrainer?.stop)
            bot.slimeTrainer.stop();
        clearPendingReturn();
        config.unknownPlayerEnabled = false;
        config.healthLossEnabled = false;
        persistConfig();
        stop(); // stop the panic loop itself
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
        if (!getGameMasterNames().length)
            return false;
        const visible = getVisibleGameMasters();
        if (!visible.length)
            return false;
        return triggerGameMasterKillSwitch(visible);
    }

    function checkUnknownPlayers() {
        if (!config.unknownPlayerEnabled)
            return false;
        const unknown = getUnknownVisiblePlayers();
        if (!unknown.length)
            return false;
        return triggerPanic("unknown-player", {
            players: unknown.map(p => p.name)
        });
    }

    function checkHealthLoss() {
        if (!config.healthLossEnabled)
            return false;
        const playerState = bot.getPlayerState();
        const currentHealth = Number(playerState?.health ?? 0);
        if (state.lastHealth == null) {
            state.lastHealth = currentHealth;
            return false;
        }
        const lostHealth = currentHealth < state.lastHealth;
        state.lastHealth = currentHealth;
        if (!lostHealth)
            return false;

        const latestDamage = getLatestDamageEvent();
        if (latestDamage && latestDamage.key !== state.lastDamageEventKey) {
            state.lastDamageEventKey = latestDamage.key;
            const trusted = new Set(getTrustedNames());
            const attacker = normalizeName(latestDamage.attackerName);
            if (attacker && trusted.has(attacker)) {
                bot.log("ignored health-loss panic because attacker is trusted", {
                    attacker: latestDamage.attackerName,
                    amount: latestDamage.amount,
                    currentHealth
                });
                return false;
            }
            return triggerPanic("health-loss", {
                currentHealth,
                attacker: latestDamage.attackerName,
                amount: latestDamage.amount
            });
        }

        const unknown = getUnknownVisiblePlayers();
        if (!unknown.length) {
            const trustedPlayers = getTrustedVisiblePlayers();
            if (trustedPlayers.length) {
                bot.log("ignored health-loss panic because only trusted players are nearby", {
                    players: trustedPlayers.map(p => p.name),
                    currentHealth
                });
                return false;
            }
        }
        return triggerPanic("health-loss", {
            currentHealth
        });
    }

    // ---- TICK LOOP ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }

    function tick() {
        if (!state.running)
            return;
        const now = Date.now();
        try {
            const triggered = checkGameMasters() || checkUnknownPlayers() || checkHealthLoss();
            if (!triggered)
                tryReturnToOrigin(now);

            // ---- Player on‑screen alert (sound only, does NOT stop any module) ----
            if (config.playerAlertEnabled) {
                const myId = window.gameClient?.player?.id;
                // Get visible players on the SAME floor only
                const allPlayers = bot.xray?.getVisiblePlayers?.({
                    sameFloorOnly: true
                }) || [];
                // Exclude self and trusted players
                const trustedNames = new Set(getTrustedNames()); // getTrustedNames returns normalized names
                const otherPlayers = allPlayers.filter(p => {
                    if (p.id === myId)
                        return false;
                    const name = normalizeName(p.name);
                    return !trustedNames.has(name);
                });
                if (otherPlayers.length > 0 && now - state.lastPlayerAlertAt >= config.playerAlertCooldownMs) {
                    state.lastPlayerAlertAt = now;
                    bot.playPlayerAlarm?.();
                    bot.log("player on-screen alert", {
                        players: otherPlayers.map(p => p.name)
                    });
                }
            }
        } finally {
            scheduleNextTick();
        }
    }

    function shouldRun() {
        // Run if any panic trigger is enabled OR if playerAlert is enabled
        return !!(getGameMasterNames().length ||
            config.unknownPlayerEnabled ||
            config.healthLossEnabled ||
            config.playerAlertEnabled);
    }

    function start() {
        if (state.running)
            return false;
        state.running = true;
        state.lastHealth = Number(bot.getPlayerState()?.health ?? 0);
        state.lastDamageEventKey = getLatestDamageEvent()?.key || null;
        bot.log("panic runner started", {
            ...config
        });
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
        if (shouldRun())
            start();
        else
            stop();
    }

    function updateConfig(nextConfig = {}) {
        const next = {
            ...nextConfig
        };
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
        if (!config.returnToOriginEnabled)
            clearPendingReturn();
        persistConfig();
        syncRunningState();
        bot.log("panic runner config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config,
                trustedNames: [...config.trustedNames],
                gameMasterNames: [...config.gameMasterNames],
            },
            visiblePlayers: getVisiblePlayers().map(p => ({
                    id: p.id,
                    name: p.name,
                    position: p.__position
                })),
            unknownVisiblePlayers: getUnknownVisiblePlayers().map(p => ({
                    id: p.id,
                    name: p.name,
                    position: p.__position
                })),
            trustedVisiblePlayers: getTrustedVisiblePlayers().map(p => ({
                    id: p.id,
                    name: p.name,
                    position: p.__position
                })),
            visibleGameMasters: getVisibleGameMasters().map(p => ({
                    id: p.id,
                    name: p.name,
                    position: p.__position
                })),
            latestDamageEvent: getLatestDamageEvent(),
            lastTriggerAt: state.lastTriggerAt,
            pendingReturn: state.pendingReturnOrigin ? {
                origin: {
                    ...state.pendingReturnOrigin
                },
                modules: state.pendingReturnModules ? {
                    ...state.pendingReturnModules
                }
                 : null,
                returnNotBeforeAt: state.returnNotBeforeAt,
                lastThreatAt: state.lastThreatAt,
                lastReturnAttemptAt: state.lastReturnAttemptAt,
                coastClear: isReturnCoastClear(),
            }
             : null,
            playerAlertEnabled: config.playerAlertEnabled,
            playerAlertCooldownMs: config.playerAlertCooldownMs,
            lastPlayerAlertAt: state.lastPlayerAlertAt,
        };
    }

    if (shouldRun())
        start();

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

window.__minibiaBotBundle.installPlayerAttackMonitorModule = function installPlayerAttackMonitorModule(bot) {
    const configStorageKey = "minibiaBot.playerAttack.config";
    const state = {
        running: false,
        timerId: null,
        lastDamageKey: null,
    };

    // Load config
    const config = Object.assign({
        enabled: false
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            enabled: config.enabled
        });
    }

    // ---- Helpers (same as before) ----
    function normalizeName(name) {
        return String(name || "").trim().toLowerCase();
    }

    function parseDamageEvent(entry) {
        const match = entry.message.match(/^You lose\s+(\d+)\s+hitpoints\s+due to an attack by\s+(.+?)\.$/i);
        if (!match)
            return null;
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
        const channels = window.gameClient?.interface?.channelManager?.channels || [];
        const messages = channels
            .flatMap(channel => (channel?.__contents || []).map(entry => ({
                        channelName: channel?.name || null,
                        message: String(entry?.message || ""),
                        time: entry?.__time || null,
                    })))
            .map(parseDamageEvent)
            .filter(Boolean)
            .sort((a, b) => {
                const aTime = a.time ? Date.parse(a.time) : 0;
                const bTime = b.time ? Date.parse(b.time) : 0;
                return bTime - aTime;
            });
        return messages[0] || null;
    }

    function isAttackerPlayer(attackerName) {
        if (!attackerName)
            return false;
        const creatures = Object.values(window.gameClient?.world?.activeCreatures || {});
        const normalized = normalizeName(attackerName);
        for (const creature of creatures) {
            if (creature?.name && normalizeName(creature.name) === normalized) {
                return creature.type === 0;
            }
        }
        return false;
    }

    function checkForPlayerAttack() {
        if (!config.enabled || !state.running)
            return;
        const event = getLatestDamageEvent();
        if (!event)
            return;
        if (event.key === state.lastDamageKey)
            return;
        state.lastDamageKey = event.key;

        const trustedNames = bot.panic?.getTrustedNames?.() || [];
        const isTrusted = trustedNames.some(t => normalizeName(t) === normalizeName(event.attackerName));
        if (isTrusted)
            return;

        if (isAttackerPlayer(event.attackerName)) {
            bot.playPlayerAttackAlarm();
            bot.log("PLAYER ATTACK!", {
                attacker: event.attackerName,
                amount: event.amount
            });
        }
    }

    function tick() {
        if (!state.running)
            return;
        try {
            checkForPlayerAttack();
        } catch (e) {
            bot.log("Player attack monitor error", e);
        }
        state.timerId = setTimeout(tick, 2000);
    }

    function start() {
        if (state.running)
            return false;
        config.enabled = true;
        persistConfig();
        state.running = true;
        bot.log("Player attack monitor started");
        tick();
        return true;
    }

    function stop() {
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        config.enabled = false;
        persistConfig();
        bot.log("Player attack monitor stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            }
        };
    }

    // Auto-start if enabled
    if (config.enabled)
        start();

    bot.playerAttackMonitor = {
        start,
        stop,
        status,
        config
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
    const state = {
        running: false,
        timerId: null,
        lastRuneAt: 0
    };
    let resumeListenersAttached = false;

    const config = Object.assign({
        tickMs: 250,
        minHpPercent: 50,
        minFoodSeconds: 30,
        runeSpellWords: "adori vita vis",
        runeManaCost: 98,
        runeCooldownMs: 3500,
        enabled: false,
    },
            bot.storage.get(configStorageKey, {}));
    config.tickMs = 250;

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function readStats() {
        const playerState = bot.getPlayerState();
        const hp = playerState ? {
            current: playerState.health ?? 0,
            max: playerState.maxHealth ?? 0
        }
         : null;
        const mana = playerState ? {
            current: playerState.mana ?? 0,
            max: playerState.maxMana ?? 0
        }
         : null;
        const foodText = document.querySelector('#skill-window div[skill="food"] .skill')?.textContent?.trim() || null;
        let food = null;
        if (foodText) {
            const match = foodText.match(/^(\d{1,2}):(\d{2})$/);
            food = match ? {
                text: foodText,
                seconds: Number(match[1]) * 60 + Number(match[2])
            }
             : {
                text: foodText,
                seconds: null
            };
        }
        return {
            hp,
            mana,
            food
        };
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
        const enoughMana = bot.manaPercent() >= config.runeManaCost;
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
        if (!canMakeRune())
            return false;
        const sent = bot.sendChat(config.runeSpellWords);
        if (sent)
            state.lastRuneAt = Date.now();
        return sent;
    }

    // ---- RESUME LISTENERS (to catch up after tab focus) ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }

    function runImmediateTick() {
        if (!state.running)
            return;
        if (state.timerId != null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        tick();
    }

    function handleResume() {
        if (document.hidden)
            return;
        runImmediateTick();
    }

    function attachResumeListeners() {
        if (resumeListenersAttached)
            return;
        document.addEventListener("visibilitychange", handleResume);
        window.addEventListener("focus", handleResume);
        window.addEventListener("pageshow", handleResume);
        resumeListenersAttached = true;
    }

    function detachResumeListeners() {
        if (!resumeListenersAttached)
            return;
        document.removeEventListener("visibilitychange", handleResume);
        window.removeEventListener("focus", handleResume);
        window.removeEventListener("pageshow", handleResume);
        resumeListenersAttached = false;
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryMakeRune();
        } catch (e) {
            bot.log("rune tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        config.tickMs = 250;
        persistConfig();
        if (state.running) {
            bot.log("rune maker already running");
            return false;
        }
        state.running = true;
        attachResumeListeners();
        bot.log("rune maker started", {
            ...config
        });
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
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("rune maker stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
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
        bot.log("rune config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

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

    const config = Object.assign({
        tickMs: 50,
        healCooldownMs: 1200,
        healRetryMs: 200,
        healConfirmMs: 250,
        enabled: false,
        healRules: []
    },
            bot.storage.get(configStorageKey, {}));

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
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function readStats() {
        const ps = bot.getPlayerSnapshot?.();
        return ps ? {
            hp: {
                current: Number(ps.health ?? 0),
                max: Number(ps.maxHealth ?? 0)
            },
            mana: {
                current: Number(ps.mana ?? 0),
                max: Number(ps.maxMana ?? 0)
            },
        }
         : {
            hp: null,
            mana: null
        };
    }

    function normalizeHotbarSlot(slot) {
        const v = Number(slot);
        if (!Number.isFinite(v))
            return null;
        const n = Math.trunc(v);
        if (n < 1 || n > 12)
            return null;
        return n;
    }

    function getHpPercent(stats) {
        if (!stats?.hp || !stats.hp.max)
            return 100;
        return (stats.hp.current / stats.hp.max) * 100;
    }

    function getManaPercent(stats) {
        if (!stats?.mana || !stats.mana.max)
            return 100;
        return (stats.mana.current / stats.mana.max) * 100;
    }

    function hasPending() {
        return Object.keys(state.pendingAttempt).some(k => state.pendingAttempt[k] !== null);
    }

    function didSucceed(stats, attempt) {
        if (!stats || !attempt)
            return false;
        const hpUp = stats.hp ? stats.hp.current > attempt.hpBefore : false;
        const manaUp = stats.mana ? stats.mana.current > attempt.manaBefore : false;
        return hpUp || manaUp;
    }

    function resolvePending(stats, now) {
        Object.keys(state.pendingAttempt).forEach(slotKey => {
            const a = state.pendingAttempt[slotKey];
            if (!a)
                return;
            if (didSucceed(stats, a)) {
                state.lastHealAt[slotKey] = a.attemptedAt;
                state.pendingAttempt[slotKey] = null;
                //bot.log("confirmed heal", { slot: a.slot });
            } else if (now - a.attemptedAt >= (config.healConfirmMs || 250)) {
                state.pendingAttempt[slotKey] = null;
                //bot.log("heal did not register", { slot: a.slot });
            }
        });
    }

    function canUseRule(rule, now, stats) {
        const slot = normalizeHotbarSlot(rule.slot);
        if (!slot)
            return false;
        const key = String(slot);
        if (state.pendingAttempt[key])
            return false;
        if (now - (state.lastHealAt[key] || 0) < config.healCooldownMs)
            return false;
        if (now - (state.lastAttemptAt[key] || 0) < (config.healRetryMs || 200))
            return false;

        const hp = getHpPercent(stats);
        const mana = getManaPercent(stats);
        const minHp = Number(rule.minHpPercent) ?? 0;
        const maxHp = Number(rule.maxHpPercent) ?? 100;
        const minMana = Number(rule.minManaPercent) ?? 0;
        const maxMana = Number(rule.maxManaPercent) ?? 100;

        if (hp < minHp || hp > maxHp)
            return false;
        if (mana < minMana || mana > maxMana)
            return false;

        // Spell requires mana
        if (rule.spellWords && rule.spellWords.trim()) {
            const cost = Math.max(1, Number(rule.manaCost) || 0);
            if (stats.mana.current < cost)
                return false;
        }
        if (stats.hp.current <= 0)
            return false; // dead
        return true;
    }

    function triggerRule(rule, now, stats) {
        if (!canUseRule(rule, now, stats))
            return false;
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
                //bot.log("cast spell", { slot, words: rule.spellWords });
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
            bot.log("pressed hotkey", {
                slot
            });
        }
        return clicked;
    }

    function tryHeal() {
        if (!config.enabled)
            return false;
        const now = Date.now();
        const stats = readStats();
        resolvePending(stats, now);
        if (hasPending())
            return false;

        for (const rule of config.healRules || []) {
            if (!rule || !rule.slot)
                continue;
            if (triggerRule(rule, now, stats))
                return true;
        }
        return false;
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = setTimeout(() => tick(), config.tickMs);
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryHeal();
        } catch (e) {
            bot.log("auto heal tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        persistConfig();
        if (state.running)
            return false;
        state.running = true;
        bot.log("auto heal started", {
            rules: config.healRules
        });
        tick();
        return true;
    }

    function stop(options = {}) {
        const persist = options.persistEnabled !== false;
        state.running = false;
        if (state.timerId)
            clearTimeout(state.timerId);
        state.timerId = null;
        if (persist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("auto heal stopped");
        return true;
    }

    function status() {
        const stats = readStats();
        return {
            running: state.running,
            config: {
                ...config
            },
            stats,
            hpPercent: getHpPercent(stats),
            manaPercent: getManaPercent(stats),
            lastHealAt: {
                ...state.lastHealAt
            },
            pendingAttempt: {
                ...state.pendingAttempt
            },
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
        bot.log("auto heal config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

    bot.heal = {
        start,
        stop,
        status,
        updateConfig,
        readStats,
        tryHeal,
        config,
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
    const state = {
        running: false,
        timerId: null,
        lastCastAt: 0
    };
    let resumeListenersAttached = false;

    const config = Object.assign({
        tickMs: 500,
        spellWords: "utana vid",
        recastCooldownMs: 2000,
        enabled: false,
    },
            bot.storage.get(configStorageKey, {}));
    config.tickMs = 500;

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getInvisibleConditionId() {
        return window.ConditionManager?.prototype?.INVISIBLE ?? INVISIBLE_CONDITION_ID;
    }

    function isInvisibleActive() {
        const player = window.gameClient?.player;
        const conditions = player?.conditions;
        const id = getInvisibleConditionId();
        if (conditions?.has)
            return conditions.has(id);
        if (player?.hasCondition)
            return player.hasCondition(id);
        return false;
    }

    function getGateStatus(now = Date.now()) {
        const cooldown = Math.max(0, config.recastCooldownMs - (now - state.lastCastAt));
        const ready = cooldown === 0;
        const active = isInvisibleActive();
        return {
            invisibleActive: active,
            cooldownReady: ready,
            cooldownRemainingMs: cooldown,
            canCast: !active && ready
        };
    }

    function canCastInvisible(now) {
        return getGateStatus(now).canCast;
    }
    function tryCastInvisible(now = Date.now()) {
        if (!config.enabled || !canCastInvisible(now))
            return false;
        const sent = bot.sendChat(config.spellWords);
        if (sent)
            state.lastCastAt = now;
        return sent;
    }

    // ---- Resume listeners (identical to rune module) ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }

    function runImmediateTick() {
        if (!state.running)
            return;
        if (state.timerId != null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        tick();
    }

    function handleResume() {
        if (!document.hidden)
            runImmediateTick();
    }

    function attachResumeListeners() {
        if (resumeListenersAttached)
            return;
        document.addEventListener("visibilitychange", handleResume);
        window.addEventListener("focus", handleResume);
        window.addEventListener("pageshow", handleResume);
        resumeListenersAttached = true;
    }
    function detachResumeListeners() {
        if (!resumeListenersAttached)
            return;
        document.removeEventListener("visibilitychange", handleResume);
        window.removeEventListener("focus", handleResume);
        window.removeEventListener("pageshow", handleResume);
        resumeListenersAttached = false;
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryCastInvisible();
        } catch (e) {
            bot.log("auto invisible tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        config.tickMs = 500;
        persistConfig();
        if (state.running) {
            bot.log("auto invisible already running");
            return false;
        }
        state.running = true;
        attachResumeListeners();
        bot.log("auto invisible started", {
            ...config
        });
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
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("auto invisible stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            gates: getGateStatus(),
            lastCastAt: state.lastCastAt,
        };
    }

    function updateConfig(nextConfig = {}) {
        if (nextConfig.spellWords !== undefined)
            nextConfig.spellWords = String(nextConfig.spellWords || "").trim() || config.spellWords;
        if (nextConfig.recastCooldownMs !== undefined)
            nextConfig.recastCooldownMs = Math.max(0, Number(nextConfig.recastCooldownMs) || 0);
        Object.assign(config, nextConfig);
        config.tickMs = 500;
        persistConfig();
        bot.log("auto invisible config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

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
    const state = {
        running: false,
        timerId: null,
        lastCastAt: 0,
        assumedActiveUntil: 0
    };
    let resumeListenersAttached = false;

    const config = Object.assign({
        tickMs: 500,
        spellWords: "utamo vita",
        recastCooldownMs: 2000,
        enabled: false,
    },
            bot.storage.get(configStorageKey, {}));
    config.tickMs = 500;

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getMagicShieldConditionId() {
        const prototype = window.ConditionManager?.prototype;
        const playerConditions = window.gameClient?.player?.conditions;
        const candidates = ["MAGIC_SHIELD", "MANA_SHIELD", "MAGICSHIELD", "MANASHIELD", "UTAMO_VITA"];
        for (const key of candidates) {
            const value = prototype?.[key] ?? playerConditions?.[key];
            if (typeof value === "number" && Number.isFinite(value))
                return value;
        }
        return null;
    }

    function isMagicShieldActive(now = Date.now()) {
        const player = window.gameClient?.player;
        const conditions = player?.conditions;
        const id = getMagicShieldConditionId();
        if (id != null) {
            if (conditions?.has)
                return conditions.has(id);
            if (player?.hasCondition)
                return player.hasCondition(id);
        }
        return now < state.assumedActiveUntil;
    }

    function getGateStatus(now = Date.now()) {
        const cooldown = Math.max(0, config.recastCooldownMs - (now - state.lastCastAt));
        const ready = cooldown === 0;
        const active = isMagicShieldActive(now);
        return {
            magicShieldActive: active,
            cooldownReady: ready,
            cooldownRemainingMs: cooldown,
            canCast: !active && ready
        };
    }

    function canCastMagicShield(now) {
        return getGateStatus(now).canCast;
    }
    function tryCastMagicShield(now = Date.now()) {
        if (!config.enabled || !canCastMagicShield(now))
            return false;
        const sent = bot.sendChat(config.spellWords);
        if (sent) {
            state.lastCastAt = now;
            state.assumedActiveUntil = now + MAGIC_SHIELD_FALLBACK_DURATION_MS;
        }
        return sent;
    }

    // ---- Resume listeners (identical) ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }
    function runImmediateTick() {
        if (!state.running)
            return;
        if (state.timerId != null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        tick();
    }
    function handleResume() {
        if (!document.hidden)
            runImmediateTick();
    }

    function attachResumeListeners() {
        if (resumeListenersAttached)
            return;
        document.addEventListener("visibilitychange", handleResume);
        window.addEventListener("focus", handleResume);
        window.addEventListener("pageshow", handleResume);
        resumeListenersAttached = true;
    }
    function detachResumeListeners() {
        if (!resumeListenersAttached)
            return;
        document.removeEventListener("visibilitychange", handleResume);
        window.removeEventListener("focus", handleResume);
        window.removeEventListener("pageshow", handleResume);
        resumeListenersAttached = false;
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryCastMagicShield();
        } catch (e) {
            bot.log("auto magic shield tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        config.tickMs = 500;
        persistConfig();
        if (state.running) {
            bot.log("auto magic shield already running");
            return false;
        }
        state.running = true;
        attachResumeListeners();
        bot.log("auto magic shield started", {
            ...config
        });
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
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("auto magic shield stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            gates: getGateStatus(),
            lastCastAt: state.lastCastAt,
            assumedActiveUntil: state.assumedActiveUntil,
        };
    }

    function updateConfig(nextConfig = {}) {
        if (nextConfig.spellWords !== undefined)
            nextConfig.spellWords = String(nextConfig.spellWords || "").trim() || config.spellWords;
        if (nextConfig.recastCooldownMs !== undefined)
            nextConfig.recastCooldownMs = Math.max(0, Number(nextConfig.recastCooldownMs) || 0);
        Object.assign(config, nextConfig);
        config.tickMs = 500;
        persistConfig();
        bot.log("auto magic shield config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

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
        kiteWaypointIndex: null, // index of the waypoint we're kiting toward
        kiteTargetReached: false,
        meleeLastDist: Infinity,
        meleeProgressAt: 0,
        meleeStuckAt: 0,
        lastMoveAt: 0,
        lastProgressAt: 0,
        lastTargetHealth: null,
        stuckStartAt: 0,
        lastKiteWaypoint: null,
        kiteTargetKey: null,
        kiteOriginalIndex: null,
    };

    const storedConfig = bot.storage.get(configStorageKey, {}) || {};
    const config = Object.assign({
        tickMs: 150,
        targetHotbarSlot: 3,
        runeHotbarSlot: null,
        targetCooldownMs: 1200,
        runeCooldownMs: 1200,
        maxTargetDistance: 5,
        meleeMode: true,
        enabled: false,
        preferredTargetNames: [],
        preferredMatchMode: "exact",
        ignoredTargetNames: [],
        antiKSEnabled: true,
        antiKSSelfRange: 2,
        antiKSOtherRange: 2,
        kiteMode: false,
        idealDistance: 3,
        useClientChase: true,
        kiteStuckCount: 0,
        unreachableStart: 0,
    },
            storedConfig);
    if (config.targetHotbarSlot == null && storedConfig.hotbarSlot != null) {
        config.targetHotbarSlot = storedConfig.hotbarSlot;
    }

    // ---- Constants for floor-change detection (copied from cave module) ----

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }
    // ---- FLOOR CHANGE DETECTION (copied from cave module) ----
    const ladderItemIds = new Set([1948, 1968, 435, 5542]);
    const teleporterItemIds = new Set([5756]);

    function isFloorChangeTile(tile) {
        if (!tile)
            return false;
        if (ladderItemIds.has(tile.id) || teleporterItemIds.has(tile.id))
            return true;
        if (Array.isArray(tile.items)) {
            for (const item of tile.items) {
                if (ladderItemIds.has(item.id) || teleporterItemIds.has(item.id))
                    return true;
            }
        }
        return false;
    }

    // Safe walkable check: walkable AND not a floor-change tile
    function isSafeToWalkTile(x, y, z, ignoreCreatures = false) {
        const pos = new Position(x, y, z);
        const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
        if (!tile)
            return false;
        if (!tile.isWalkable())
            return false;
        if (tile.isItemBlocked())
            return false;
        if (!ignoreCreatures && tile.isOccupied())
            return false;
        if (isFloorChangeTile(tile))
            return false; // ★ skip holes/ladders/teleporters
        return true;
    }

    let kiteWaypointIndex = null;

    function normalizeHotbarSlot(slot) {
        const v = Number(slot);
        if (!Number.isFinite(v))
            return null;
        const n = Math.trunc(v);
        if (n < 1 || n > 12)
            return null;
        return n;
    }

    // ---- PREFERRED TARGETS ----
    function normalizeCreatureName(name) {
        return String(name || "").trim().toLowerCase();
    }

    function getPreferredTargetNames() {
        if (!Array.isArray(config.preferredTargetNames))
            return [];
        return config.preferredTargetNames.map(n => String(n || "").trim()).filter(Boolean);
    }

    function isPreferredCreature(creature) {
        const preferred = getPreferredTargetNames();
        if (!creature?.name || !preferred.length)
            return false;
        const name = normalizeCreatureName(creature.name);
        return preferred.some(p => {
            const pnorm = normalizeCreatureName(p);
            if (!pnorm)
                return false;
            if (config.preferredMatchMode === "includes") {
                return name === pnorm || name.includes(pnorm);
            }
            return name === pnorm;
        });
    }

    // ---- Helper ----

    function setClientChaseMode(enabled) {
        try {
            const fms = window.gameClient?.interface?.fightModeSelector;
            if (!fms) {
                console.warn("setClientChaseMode: fightModeSelector not found");
                return false;
            }
            const mode = enabled ? 2 : 0;
            //   console.log(`setClientChaseMode: setting chase mode to ${mode}`);
            fms.setChaseMode(mode);
            return true;
        } catch (e) {
            console.error("setClientChaseMode error:", e);
            return false;
        }
    }

    // ---- Tile safety helpers (copied from cave module) ----
    function getTileAtPosition(pos) {
        if (!pos)
            return null;
        return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(pos.x, pos.y, pos.z)) || null;
    }

    function getThingDefinition(itemId) {
        if (!itemId)
            return null;
        return window.gameClient?.itemDefinitionsByCid?.[itemId] ||
        window.gameClient?.itemDefinitionsBySid?.[itemId] ||
        window.gameClient?.itemDefinitions?.[itemId] || null;
    }

    function getThingName(thing) {
        const def = getThingDefinition(thing?.id);
        return String(def?.properties?.name || thing?.name || "").trim().toLowerCase();
    }

    function isLadderThing(thing) {
        if (!thing?.id)
            return false;
        const ladderIds = new Set([1948, 1968]);
        if (ladderIds.has(Number(thing.id)))
            return true;
        return getThingName(thing).includes("ladder");
    }

    function isFloorChangeThing(thing) {
        if (!thing?.id)
            return false;
        const def = getThingDefinition(thing?.id);
        if (def?.properties?.floorchange)
            return true;
        if (ladderItemIds.has(Number(thing.id)))
            return true;
        if (teleporterItemIds.has(Number(thing.id)))
            return true;
        return false;
    }

    function tileHasNamedThing(tile, needle) {
        const val = String(needle || "").trim().toLowerCase();
        if (!val || !tile)
            return false;
        const things = [tile, ...(tile.items || [])];
        return things.some(t => getThingName(t).includes(val));
    }

    function isHoleTile(tile) {
        return tileHasNamedThing(tile, "hole");
    }

    function isRopeTargetTile(tile) {
        return isHoleTile(tile) || tileHasNamedThing(tile, "rope spot");
    }

    function isSafeTileForKite(pos) {
        if (!pos)
            return false;
        const tile = getTileAtPosition(pos);
        if (!tile)
            return false;
        // Must be walkable (allows ignoring creatures later)
        if (!tile.isWalkable())
            return false;
        // Avoid floor-changing tiles (holes, ladders, stairs, rope spots, etc.)
        if (isFloorChangeTile(tile))
            return false;
        return true;
    }

    function getDirection(dx, dy) {
        if (dx === 0 && dy === -1)
            return CONST.DIRECTION.NORTH;
        if (dx === 0 && dy === 1)
            return CONST.DIRECTION.SOUTH;
        if (dx === -1 && dy === 0)
            return CONST.DIRECTION.WEST;
        if (dx === 1 && dy === 0)
            return CONST.DIRECTION.EAST;
        if (dx === -1 && dy === -1)
            return CONST.DIRECTION.NORTHWEST;
        if (dx === 1 && dy === -1)
            return CONST.DIRECTION.NORTHEAST;
        if (dx === -1 && dy === 1)
            return CONST.DIRECTION.SOUTHWEST;
        if (dx === 1 && dy === 1)
            return CONST.DIRECTION.SOUTHEAST;
        return null;
    }

    // ---- Simple walkability ----
    function isTileWalkable(x, y, z, ignoreCreatures = false) {
        const pos = new Position(x, y, z);
        const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
        if (!tile)
            return false;
        if (!tile.isWalkable())
            return false;
        if (tile.isItemBlocked())
            return false;
        if (!ignoreCreatures && tile.isOccupied())
            return false;
        return true;
    }

    // ---- Chase: move directly toward target ----
    function syncChase(now) {
        if (!config.kiteMode)
            return false;
        const target = getEngagedTarget();
        if (!target)
            return false;

        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(target.getPosition?.() || target.__position);
        if (!playerPos || !targetPos || playerPos.z !== targetPos.z)
            return false;

        const dist = getTileDistance(playerPos, targetPos);
        const ideal = Math.max(1, Number(config.idealDistance) || 3);
        if (dist <= ideal + 1)
            return false;

        let dx = targetPos.x - playerPos.x;
        let dy = targetPos.y - playerPos.y;
        let stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
        let stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

        const attempts = [{
                dx: stepX,
                dy: 0
            }, {
                dx: 0,
                dy: stepY
            }, {
                dx: stepX,
                dy: stepY
            }
        ];

        for (const a of attempts) {
            if (a.dx === 0 && a.dy === 0)
                continue;
            const nx = playerPos.x + a.dx;
            const ny = playerPos.y + a.dy;
            // ★ Safe check
            if (isSafeToWalkTile(nx, ny, playerPos.z, false)) {
                const dir = getDirection(a.dx, a.dy);
                if (dir !== null && window.gameClient?.keyboard) {
                    window.gameClient.keyboard.handleMoveKey(dir);
                    return true;
                }
            }
        }
        return false;
    }

    function kiteAwayFallback(targetPos, playerPos, dist) {
        const dx = playerPos.x - targetPos.x;
        const dy = playerPos.y - targetPos.y;
        let stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
        let stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
        const attempts = [{
                dx: stepX,
                dy: 0
            }, {
                dx: 0,
                dy: stepY
            }, {
                dx: stepX,
                dy: stepY
            }
        ];
        for (const a of attempts) {
            if (a.dx === 0 && a.dy === 0)
                continue;
            const nx = playerPos.x + a.dx;
            const ny = playerPos.y + a.dy;
            const candidatePos = {
                x: nx,
                y: ny,
                z: playerPos.z
            };
            if (!isSafeTileForKite(candidatePos))
                continue;
            if (isTileWalkable(nx, ny, playerPos.z, false)) {
                const dir = getDirection(a.dx, a.dy);
                if (dir !== null && window.gameClient?.keyboard) {
                    window.gameClient.keyboard.handleMoveKey(dir);
                    return true;
                }
            }
        }
        return false;
    }

    // ---- REACHABILITY CACHE ----
    const reachCache = new Map();
    function isTargetReachable(target) {
        if (!target)
            return false;
        const key = target.id;
        const now = Date.now();
        if (reachCache.has(key) && reachCache.get(key).expires > now) {
            return reachCache.get(key).reachable;
        }
        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(target.getPosition?.() || target.__position);
        if (!playerPos || !targetPos || playerPos.z !== targetPos.z)
            return false;
        // Quick distance check – if too far, don't bother
        const dist = getTileDistance(playerPos, targetPos);
        const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);
        if (dist > maxDist + 2) {
            reachCache.set(key, {
                reachable: false,
                expires: now + 5000
            });
            return false;
        }
        let reachable = false;
        try {
            const from = new Position(playerPos.x, playerPos.y, playerPos.z);
            const to = new Position(targetPos.x, targetPos.y, targetPos.z);
            const pf = window.gameClient?.world?.pathfinder;
            if (pf && typeof pf.search === 'function') {
                const startTile = pf.getTileFromWorldPosition(from);
                const endTile = pf.getTileFromWorldPosition(to);
                if (startTile && endTile) {
                    const path = pf.search(startTile, endTile);
                    reachable = Array.isArray(path) && path.length > 0;
                }
            }
        } catch (e) {
            // On error, assume reachable to avoid false skips
            reachable = true;
        }
        // Cache for 3 seconds (adjustable)
        reachCache.set(key, {
            reachable,
            expires: now + 3000
        });
        return reachable;
    }

    // ---- Kite: move backward along cave route, or away from target ----
    function syncKite(now) {
        if (!config.kiteMode)
            return false;
        const target = getEngagedTarget();
        if (!target)
            return false;

        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(target.getPosition?.() || target.__position);
        if (!playerPos || !targetPos || playerPos.z !== targetPos.z)
            return false;

        const dist = getTileDistance(playerPos, targetPos);
        const ideal = Math.max(1, Number(config.idealDistance) || 3);
        if (dist >= ideal)
            return false;

        const caveStatus = bot.cave?.status?.();
        const route = bot.cave?.getRoute?.() || [];
        const loopMode = bot.cave?.getLoopMode?.() ?? false;

        if (!caveStatus?.running || !caveStatus?.pausedForCombat || route.length === 0) {
            return kiteAwayFallback(targetPos, playerPos, dist);
        }

        // ---- Store original index when we first start kiting ----
        if (state.kiteOriginalIndex === null && caveStatus?.running) {
            state.kiteOriginalIndex = caveStatus.currentIndex;
            bot.log(`[Kite] original index saved: ${state.kiteOriginalIndex + 1}`);
        }

        let retreatIdx = caveStatus.currentIndex - 1;
        if (loopMode) {
            if (retreatIdx < 0)
                retreatIdx = route.length + retreatIdx; // wrap around
        } else {
            retreatIdx = Math.max(0, Math.min(route.length - 1, retreatIdx));
        }

        state.kiteWaypointIndex = retreatIdx;

        let idx = Math.min(state.kiteWaypointIndex, route.length - 1);
        if (idx < 0)
            idx = 0;

        while (idx >= 0 && route[idx].z !== playerPos.z) {
            idx--;
        }
        if (idx < 0) {
            state.kiteWaypointIndex = null;
            return kiteAwayFallback(targetPos, playerPos, dist);
        }

        let targetWp = route[idx];
        if (!targetWp) {
            state.kiteWaypointIndex = null;
            return false;
        }

        const distToWp = getTileDistance(playerPos, targetWp);
        // ★ Tolerance = 3 (switch sooner)
        const tolerance = Math.max(6, Number(config.waypointTolerance) || 6);

        if (distToWp <= tolerance) {
            // ★ Move to the next retreat waypoint (another -2)
            let nextIdx = idx - 2;
            if (loopMode) {
                if (nextIdx < 0)
                    nextIdx = route.length + nextIdx;
            } else {
                nextIdx = Math.max(0, Math.min(route.length - 1, nextIdx));
            }
            if (nextIdx >= 0 && nextIdx < route.length) {
                state.kiteWaypointIndex = nextIdx;
                bot.cave.setCurrentIndex(nextIdx);
                targetWp = route[nextIdx];
            } else {
                state.kiteWaypointIndex = null;
                return kiteAwayFallback(targetPos, playerPos, dist);
            }
        }

        // ---- MOVE TOWARD THE RETREAT WAYPOINT (CARDINAL-FIRST) ----
        const dx = targetWp.x - playerPos.x;
        const dy = targetWp.y - playerPos.y;
        const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
        const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

        function isValidKiteTile(nx, ny) {
            if (bot.blacklist?.isBlacklisted(nx, ny, playerPos.z))
                return false;
            const candidatePos = {
                x: nx,
                y: ny,
                z: playerPos.z
            };
            if (!isSafeTileForKite(candidatePos))
                return false;
            return isTileWalkable(nx, ny, playerPos.z, false);
        }

        let moved = false;

        // Cardinal attempts
        const cardinalAttempts = [{
                dx: stepX,
                dy: 0
            }, {
                dx: 0,
                dy: stepY
            }
        ];
        for (const a of cardinalAttempts) {
            if (a.dx === 0 && a.dy === 0)
                continue;
            const nx = playerPos.x + a.dx;
            const ny = playerPos.y + a.dy;
            if (isValidKiteTile(nx, ny)) {
                const dir = getDirection(a.dx, a.dy);
                if (dir !== null && window.gameClient?.keyboard) {
                    window.gameClient.keyboard.handleMoveKey(dir);
                    moved = true;
                    break;
                }
            }
        }

        // Diagonal attempts
        if (!moved && stepX !== 0 && stepY !== 0) {
            const diagAttempts = [{
                    dx: stepX,
                    dy: stepY
                }, {
                    dx: stepX,
                    dy: -stepY
                }, {
                    dx: -stepX,
                    dy: stepY
                }, {
                    dx: -stepX,
                    dy: -stepY
                }
            ];
            diagAttempts.sort((a, b) => {
                const da = Math.abs(targetWp.x - (playerPos.x + a.dx)) + Math.abs(targetWp.y - (playerPos.y + a.dy));
                const db = Math.abs(targetWp.x - (playerPos.x + b.dx)) + Math.abs(targetWp.y - (playerPos.y + b.dy));
                return da - db;
            });
            for (const a of diagAttempts) {
                const nx = playerPos.x + a.dx;
                const ny = playerPos.y + a.dy;
                if (isValidKiteTile(nx, ny)) {
                    const dir = getDirection(a.dx, a.dy);
                    if (dir !== null && window.gameClient?.keyboard) {
                        window.gameClient.keyboard.handleMoveKey(dir);
                        moved = true;
                        break;
                    }
                }
            }
        }

        // Fallback: all 8 directions
        if (!moved) {
            const fallbackOffsets = [
                [0, -1], [1, 0], [0, 1], [-1, 0],
                [-1, -1], [1, -1], [-1, 1], [1, 1]
            ];
            for (const off of fallbackOffsets) {
                const nx = playerPos.x + off[0];
                const ny = playerPos.y + off[1];
                if (isValidKiteTile(nx, ny)) {
                    const dir = getDirection(off[0], off[1]);
                    if (dir !== null && window.gameClient?.keyboard) {
                        window.gameClient.keyboard.handleMoveKey(dir);
                        moved = true;
                        break;
                    }
                }
            }
        }

        // Stuck detection
        if (!moved) {
            if (!state.kiteStuckCount)
                state.kiteStuckCount = 0;
            state.kiteStuckCount++;
            if (state.kiteStuckCount > 5) {
                bot.log("Kite: retreat waypoint blocked, skipping to previous waypoint");
                state.kiteWaypointIndex = (state.kiteWaypointIndex - 2 + route.length) % route.length;
                state.kiteStuckCount = 0;
            }
        } else {
            state.kiteStuckCount = 0;
        }

        return moved;
    }

    function tryAttack() {
        if (!config.enabled)
            return false;
        const now = Date.now();

        // 1) Clear target if too far
        if (resetTargetIfTooFar(now))
            return true;

        syncCombatState(now);

        // 2) Movement
        if (config.kiteMode && getEngagedTarget()) {
            if (syncChase(now))
                return true;
            if (syncKite(now))
                return true;
        } else if (config.meleeMode && !config.kiteMode) {
            syncMeleeChase(now);
        }

        // 3) Validate current target
        let current = getCurrentTarget(); // use 'let' so we can reassign later if needed
        if (!current) {
            // ---- NEW: Restore original index if no target ----
            if (state.kiteOriginalIndex !== null) {
                restoreKiteIndex();
            }
            state.lastProgressAt = 0;
            state.lastDistance = undefined;
            state.lastTargetHealth = null;
            state.unreachableStart = 0;
            return triggerAttack(now);
        }
        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(current.getPosition?.() || current.__position);
        if (!playerPos || !targetPos) {
            skipTarget(current, "missing position", now, 3000);
            state.unreachableStart = 0;
            return false;
        }

        const dist = getTileDistance(playerPos, targetPos);
        const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);

        // ★ NEW: For melee mode without client chase, skip target as soon as it's out of melee range
        if (config.meleeMode && !config.useClientChase && dist > maxDist) {
            skipTarget(current, "melee target out of range (no chase)", now, 500);
            state.unreachableStart = 0;
            return false;
        }

        // Skip only if clearly out of range (maxDist + 1)
        if (dist > maxDist + 1) {
            skipTarget(current, "target too far (distance check)", now, 2000);
            state.unreachableStart = 0;
            return false;
        }

        // ---- REACHABILITY CHECK (new) ----
        if (dist <= maxDist + 2 && !isTargetReachable(current)) {
            if (!state.unreachableStart)
                state.unreachableStart = now;
            if (now - state.unreachableStart > 3000) {
                skipTarget(current, "unreachable (wall)", now, 2000);
                state.unreachableStart = 0;
                return false;
            }
            // Still unreachable but not timed out – don't attack, but keep target
            return false;
        } else {
            state.unreachableStart = 0;
        }

        // 4) Stuck detection – but only if there is another monster to switch to
        const health = current.state?.health ?? current.health ?? null;
        let progress = false;

        // Initialize tracking for new target
        if (state.lastDistance === undefined || state.engagedTargetId !== current.id) {
            state.lastDistance = dist;
            state.lastProgressAt = now;
            state.lastTargetHealth = health;
            state.engagedTargetId = current.id;
            state.lastPlayerPos = playerPos;
        } else {
            // Progress: distance decreased, health dropped, or player moved
            if (dist < state.lastDistance - 0.5)
                progress = true;
            if (health !== null && state.lastTargetHealth !== null && health < state.lastTargetHealth - 1)
                progress = true;
            if (playerPos.x !== state.lastPlayerPos.x || playerPos.y !== state.lastPlayerPos.y) {
                progress = true;
            }

            if (progress) {
                state.lastProgressAt = now;
            }

            // Update stored values
            state.lastDistance = dist;
            state.lastTargetHealth = health;
            state.lastPlayerPos = playerPos;

            // Stuck timeout: 4 seconds
            const timeStuck = now - state.lastProgressAt;

            // Only skip if we've been stuck for >4s AND there is another visible monster
            if (timeStuck > 6000) {
                const candidates = getMonsterCandidates(now);
                const hasAlternative = candidates.some(m => m.id !== current.id);
                if (hasAlternative) {
                    skipTarget(current, "no progress for 4s, alternative exists", now, 2000);
                    state.unreachableStart = 0;
                    return false;
                } else {
                    state.lastProgressAt = now;
                    bot.log("No alternative target – sticking to", current.name);
                }
            }
        }

        // 5) Optional: switch to a better target
        const candidates = getMonsterCandidates(now);
        if (candidates.length) {
            const best = candidates[0];
            const currentInfo = isTargetValidAndOnScreen(current, {
                returnDetails: true,
                maxDx: 7,
                maxDy: 5,
                skipReachability: true
            });
            const bestInfo = isTargetValidAndOnScreen(best, {
                returnDetails: true,
                maxDx: 7,
                maxDy: 5,
                skipReachability: true
            });

            if (bestInfo.valid && currentInfo.valid) {
                const currentDist = currentInfo.distance;
                const bestDist = bestInfo.distance;

                // Switch if:
                // 1) best is preferred and current isn't, OR
                // 2) best is at least 1 tile closer (was +3), OR
                // 3) best is adjacent (<=1) and current is not adjacent (>1)
                if ((bestInfo.preferred && !currentInfo.preferred) ||
                    (bestDist !== undefined && currentDist !== undefined && (bestDist + 1) < currentDist) ||
                    (bestDist !== undefined && bestDist <= 1 && currentDist > 1)) {
                    skipTarget(current, "switching to better target", now, 500);
                    state.unreachableStart = 0;
                    return false;
                }
            }
        }

        // 6) Attack
        if (getCurrentTarget()) {
            if (config.runeHotbarSlot && triggerRune(now))
                return true;
            return triggerAttack(now);
        } else {
            return triggerAttack(now);
        }
    }

    function getCaveRetreatDirection() {
        try {
            if (!bot.cave?.status?.().running)
                return null;
            const route = bot.cave.getRoute?.() || [];
            const status = bot.cave.status?.();
            if (!route.length || !status)
                return null;
            const currentIdx = status.currentIndex;
            // Find the previous waypoint (or stay at 0)
            let targetIdx = Math.max(0, currentIdx - 1);
            // If at start, go to current waypoint? But we want retreat, so if at start, we can't go back; maybe use current waypoint as fallback.
            // We'll use the previous waypoint if exists, else current (or null)
            if (targetIdx < 0)
                return null;
            const prev = route[targetIdx];
            if (!prev)
                return null;
            const playerPos = normalizePosition(bot.getPlayerPosition());
            if (!playerPos)
                return null;
            const dx = prev.x - playerPos.x;
            const dy = prev.y - playerPos.y;
            // Only provide direction if it's the same floor
            if (prev.z !== playerPos.z)
                return null;
            // Convert to step direction (sign)
            let stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
            let stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
            // If we're already on the previous waypoint, no retreat needed
            if (stepX === 0 && stepY === 0)
                return null;
            return {
                dx: stepX,
                dy: stepY
            };
        } catch (e) {
            return null;
        }
    }

    function getCreatureDistanceFromPlayer(creature) {
        const player = window.gameClient?.player;
        if (!player || !creature)
            return Number.POSITIVE_INFINITY;
        if (typeof player.getPosition !== "function" || typeof creature.getPosition !== "function")
            return Infinity;
        const pPos = player.getPosition();
        const cPos = creature.getPosition();
        if (!pPos || !cPos || pPos.z !== cPos.z)
            return Infinity;
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
            if (sa !== sb)
                return sa - sb;
            return String(a?.name || "").localeCompare(String(b?.name || ""));
        });
    }

    function getNearbyMonsters() {
        const monsters = bot.xray?.getVisibleMonsters?.({
            sameFloorOnly: true
        }) || [];
        return sortMonstersByPriority(monsters);
    }

    // ---- POSITION HELPERS ----
    function normalizePosition(value) {
        if (!value)
            return null;
        const x = Number(value.x);
        const y = Number(value.y);
        const z = Number(value.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
            return null;
        return {
            x: Math.trunc(x),
            y: Math.trunc(y),
            z: Math.trunc(z)
        };
    }

    function getPositionKey(position) {
        return position ? `${position.x},${position.y},${position.z}` : null;
    }

    function isAdjacentTile(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return false;
        const dx = Math.abs(from.x - to.x);
        const dy = Math.abs(from.y - to.y);
        return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
    }

    function getTileDistance(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return Number.POSITIVE_INFINITY;
        return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    }

    function getDistance(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return Number.POSITIVE_INFINITY;
        return Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    }

    function isSameCreature(left, right) {
        return !!(left && right && (left === right || left.id === right.id));
    }

    function findNearbyMonster(creature) {
        if (!creature)
            return null;
        const nearby = getNearbyMonsters();
        return nearby.find(m => isSameCreature(m, creature)) || null;
    }

    function findNearbyMonsterById(id) {
        if (id == null)
            return null;
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
            if (expiresAt <= now)
                state.skippedTargetIds.delete(id);
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
        state.kiteWaypointIndex = null;
        state.lastProgressAt = 0;
        state.lastDistance = undefined;
        state.lastTargetHealth = null;
        resetFollowProgress();
        clearCurrentFollowTarget();
    }

    function restoreKiteIndex() {
        if (state.kiteOriginalIndex !== null) {
            bot.cave.setCurrentIndex(state.kiteOriginalIndex);
            bot.log(`[Kite] restored original index ${state.kiteOriginalIndex + 1}`);
            state.kiteOriginalIndex = null;
            state.kiteWaypointIndex = null;
        }
    }

    function clearCurrentFollowTarget() {
        if (!window.gameClient?.player || typeof window.gameClient.send !== "function")
            return false;
        if (typeof FollowPacket !== "function")
            return false;
        if (!getCurrentFollowTarget())
            return false;
        window.gameClient.player.setFollowTarget(null);
        window.gameClient.send(new FollowPacket(0));
        return true;
    }

    function clearCurrentTarget() {
        if (!window.gameClient?.player || typeof window.gameClient.send !== "function")
            return false;
        if (typeof TargetPacket !== "function")
            return false;
        if (!getCurrentTarget())
            return false;
        window.gameClient.player.setTarget(null);
        window.gameClient.send(new TargetPacket(0));
        return true;
    }

    function markCombatActive(now = Date.now()) {
        if (!state.combatStartedAt)
            state.combatStartedAt = now;
    }

    function getCombatTargetCount() {
        return getEngagedTarget() ? 1 : 0;
    }

    function isCombatActive() {
        if (!config.enabled || !state.running)
            return false;
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
        const current = getCurrentTarget();
        if (current) {
            state.engagedTargetId = current.id;
            return current;
        }
        if (state.engagedTargetId == null)
            return null;
        const follow = getCurrentFollowTarget();
        if (follow && follow.id === state.engagedTargetId) {
            return findNearbyMonster(follow) || follow;
        }
        const nearby = findNearbyMonsterById(state.engagedTargetId);
        if (nearby)
            return nearby;
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
                dx: null,
                dy: null,
                distance: Number.POSITIVE_INFINITY,
                preferred: false,
                score: Number.POSITIVE_INFINITY,
                ...extra,
            };
            return returnDetails ? details : details.valid;
        }

        if (!target)
            return result(false, {
                reason: "no target"
            });
        if (!player)
            return result(false, {
                reason: "no player"
            });
        if (!world)
            return result(false, {
                reason: "no world"
            });
        if (target.id == null)
            return result(false, {
                reason: "missing id"
            });
        if (typeof target.getPosition !== "function")
            return result(false, {
                reason: "target has no getPosition"
            });
        if (typeof player.getPosition !== "function")
            return result(false, {
                reason: "player has no getPosition"
            });

        const playerPos = player.getPosition();
        const targetPos = target.getPosition();
        if (!playerPos || !targetPos)
            return result(false, {
                reason: "missing position"
            });
        if (targetPos.z !== playerPos.z)
            return result(false, {
                reason: "different floor"
            });
        if (target.state && typeof target.state.health === "number" && target.state.health <= 0) {
            return result(false, {
                reason: "dead target"
            });
        }
        if (world.activeCreatures && target.id !== player.id &&
            !Object.prototype.hasOwnProperty.call(world.activeCreatures, target.id)) {
            return result(false, {
                reason: "not in activeCreatures"
            });
        }

        let dx,
        dy,
        distance = Number.POSITIVE_INFINITY;
        try {
            const pp = playerPos.projected();
            const tp = targetPos.projected();
            dx = Math.abs(pp.x - tp.x);
            dy = Math.abs(pp.y - tp.y);
            distance = Math.max(Math.abs(playerPos.x - targetPos.x), Math.abs(playerPos.y - targetPos.y));
        } catch {
            return result(false, {
                reason: "projection failed"
            });
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
        // ---- REACHABILITY CHECK ----
        if (!options.skipReachability && !isTargetReachable(target)) {
            return result(false, {
                reason: "not reachable",
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
        if (!target || !window.gameClient?.player || typeof window.gameClient.send !== "function")
            return false;
        if (typeof TargetPacket !== "function")
            return false;
        const info = isTargetValidAndOnScreen(target, {
            returnDetails: true,
            maxDx: 7,
            maxDy: 5
        });
        if (!info.valid) {
            console.log("[target] rejected", {
                reason: info.reason,
                id: target?.id,
                name: target?.name,
                dx: info.dx,
                dy: info.dy
            });
            if (state.engagedTargetId === target.id)
                clearEngagedTarget();
            return false;
        }
        window.gameClient.player.setTarget(target);
        window.gameClient.send(new TargetPacket(target.id));
        state.engagedTargetId = target.id;
        console.log("[target] accepted", {
            id: target.id,
            name: target.name,
            preferred: info.preferred,
            score: info.score,
            distance: info.distance
        });
        return true;
    }

    function getValidatedEngagedTargetInfo() {
        const target = getEngagedTarget();
        if (!target)
            return {
                valid: false,
                target: null,
                reason: "no engaged target"
            };
        const info = isTargetValidAndOnScreen(target, {
            returnDetails: true,
            maxDx: 7,
            maxDy: 5
        });
        if (!info.valid)
            return {
                valid: false,
                target,
                reason: info.reason,
                info
            };
        return {
            valid: true,
            target,
            reason: "valid",
            info
        };
    }

    function setCurrentFollowTarget(target) {
        if (!target || !window.gameClient?.player || typeof window.gameClient.send !== "function")
            return false;
        if (typeof FollowPacket !== "function")
            return false;
        const info = isTargetValidAndOnScreen(target, {
            returnDetails: true,
            maxDx: 7,
            maxDy: 5
        });
        if (!info.valid) {
            console.log("[follow] rejected invalid follow target", {
                reason: info.reason,
                id: target?.id,
                name: target?.name
            });
            if (state.engagedTargetId === target.id)
                clearEngagedTarget();
            return false;
        }
        if (isSameCreature(getCurrentFollowTarget(), target))
            return true;
        window.gameClient.player.setFollowTarget(target);
        window.gameClient.send(new FollowPacket(target.id));
        return true;
    }

    // ---- SKIP LOGIC ----
    function skipTarget(target, reason, now = Date.now(), skipMs = 500) {
        if (!target?.id)
            return false;
        const until = now + Math.max(500, Number(skipMs) || 0);
        state.skippedTargetIds.set(target.id, until);
        const clearedTarget = isSameCreature(getCurrentTarget(), target) ? clearCurrentTarget() : false;
        const clearedFollow = isSameCreature(getCurrentFollowTarget(), target) ? clearCurrentFollowTarget() : false;
        if (state.engagedTargetId === target.id)
            clearEngagedTarget();
        else if (state.lastFollowTargetId === target.id)
            resetFollowProgress();
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

    // ---- MONSTER CANDIDATES (with Anti-KS) ----
    function getMonsterCandidates(now = Date.now()) {
        pruneSkippedTargets(now);

        const me = bot.getPlayerPosition();
        if (!me)
            return [];

        // --- BUILD IGNORED SET (Normalized) ---
        const ignoredNames = new Set(
                (config.ignoredTargetNames || [])
                .map(n => normalizeCreatureName(n))
                .filter(Boolean));

        const visiblePlayers = bot.xray?.getVisiblePlayers?.({
            sameFloorOnly: true
        }) || [];
        const myId = window.gameClient?.player?.id;

        // Trusted players (from Panic)
        const trustedNames = bot.panic?.getTrustedNames?.() || [];
        const trustedSet = new Set(trustedNames);

        // Filter out trusted players
        const otherPlayers = visiblePlayers.filter(p => {
            if (p.id === myId)
                return false;
            const name = normalizeCreatureName(p.name);
            return !trustedSet.has(name);
        });

        const hasOtherPlayers = otherPlayers.length > 0 && config.antiKSEnabled;
        const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);

        return getNearbyMonsters()
        .filter((monster) => !isTargetSkipped(monster, now))
        .filter((monster) => {
            // --- IGNORED CHECK: Skip blacklisted monsters ---
            const monsterName = normalizeCreatureName(monster.name);
            if (ignoredNames.has(monsterName))
                return false;

            const info = isTargetValidAndOnScreen(monster, {
                returnDetails: true,
                maxDx: 7,
                maxDy: 5
            });
            if (!info.valid)
                return false;

            const monsterPos = monster.getPosition?.() || monster.__position;
            if (!monsterPos)
                return false;
            const dist = Math.max(Math.abs(me.x - monsterPos.x), Math.abs(me.y - monsterPos.y));
            if (dist > maxDist)
                return false;

            if (hasOtherPlayers) {
                const selfRange = config.antiKSSelfRange ?? 2;
                const otherRange = config.antiKSOtherRange ?? 2;

                if (dist > selfRange)
                    return false;

                for (const player of otherPlayers) {
                    const pPos = player.getPosition?.() || player.__position;
                    if (!pPos)
                        continue;
                    const dx = Math.abs(pPos.x - monsterPos.x);
                    const dy = Math.abs(pPos.y - monsterPos.y);
                    if (dx <= otherRange && dy <= otherRange)
                        return false;
                }
            }
            return true;
        })
        .sort((left, right) => {
            const leftScore = getCreaturePriorityScore(left);
            const rightScore = getCreaturePriorityScore(right);
            if (leftScore !== rightScore)
                return leftScore - rightScore;
            return Number(left?.id || 0) - Number(right?.id || 0);
        });
    }

    // ---- GIVE UP / DISTANCE ----
    function resetTargetIfTooFar(now = Date.now()) {
        const current = getCurrentTarget();
        if (current && shouldGiveUpTarget(current)) {
            skipTarget(current, "target too far", now, 5000);
            return true;
        }
        const engaged = getEngagedTarget();
        if (engaged && shouldGiveUpTarget(engaged)) {
            skipTarget(engaged, "engaged target too far", now, 5000);
            return true;
        }
        return false;
    }

    function shouldGiveUpTarget(target) {
        const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);
        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(target?.getPosition?.() || target?.__position);
        if (!playerPos || !targetPos)
            return true;
        if (playerPos.z !== targetPos.z)
            return true;
        // Only give up if target is more than maxDist + 3 away (lenient)
        const dist = getTileDistance(playerPos, targetPos);
        if (dist > maxDist + 3)
            return true;
        // Also check if target is off-screen (but don't give up immediately – maybe it's just around a corner)
        // We'll only give up if target is off-screen AND we haven't made progress for a while (handled in tryAttack)
        // So here we only use distance.
        return false;
    }

    // ---- MELEE CHASE ----
    function getTileFromPosition(position) {
        if (!position || typeof Position !== "function")
            return null;
        return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(position.x, position.y, position.z)) || null;
    }

    function findReachableAdjacentPosition(targetPos, playerPos) {
        if (!targetPos || !playerPos)
            return null;
        const offsets = [{
                x: 0,
                y: -1
            }, {
                x: 1,
                y: 0
            }, {
                x: 0,
                y: 1
            }, {
                x: -1,
                y: 0
            }, {
                x: -1,
                y: -1
            }, {
                x: 1,
                y: -1
            }, {
                x: -1,
                y: 1
            }, {
                x: 1,
                y: 1
            }
        ];
        offsets.sort((a, b) => {
            const da = Math.abs(targetPos.x + a.x - playerPos.x) + Math.abs(targetPos.y + a.y - playerPos.y);
            const db = Math.abs(targetPos.x + b.x - playerPos.x) + Math.abs(targetPos.y + b.y - playerPos.y);
            return da - db;
        });
        const pf = window.gameClient?.world?.pathfinder;
        const startTile = getTileFromPosition(playerPos);
        if (!pf || !startTile || typeof pf.search !== "function")
            return null;
        for (const offset of offsets) {
            const candidate = {
                x: targetPos.x + offset.x,
                y: targetPos.y + offset.y,
                z: targetPos.z
            };
            const tile = getTileFromPosition(candidate);
            if (!tile?.isWalkable?.())
                continue;
            if (isFloorChangeTile(tile))
                continue; // ★ skip floor-change tiles
            if (candidate.x === playerPos.x && candidate.y === playerPos.y)
                return candidate;
            try {
                const path = pf.search(startTile, tile);
                if (Array.isArray(path) && path.length > 0)
                    return candidate;
            } catch (e) { /* ignore */
            }
        }
        return null;
    }

    function syncMeleeChase(now = Date.now()) {
        if (!config.meleeMode)
            return false;

        const target = getEngagedTarget();
        if (!target)
            return false;

        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(target.getPosition?.() || target.__position);
        if (!playerPos || !targetPos || playerPos.z !== targetPos.z)
            return false;

        const info = isTargetValidAndOnScreen(target, {
            returnDetails: true,
            maxDx: 7,
            maxDy: 5
        });
        if (!info.valid) {
            if (state.engagedTargetId === target.id)
                clearEngagedTarget();
            return false;
        }

        const dist = getTileDistance(playerPos, targetPos);
        const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);

        if (dist > maxDist) {
            skipTarget(target, "too far for melee", now, 3000);
            return false;
        }

        if (dist <= 1) {
            state.meleeLastDist = Infinity;
            state.meleeProgressAt = 0;
            state.meleeStuckAt = 0;
            return false;
        }

        // Anti‑KS (same as before)
        const visiblePlayers = bot.xray?.getVisiblePlayers?.({
            sameFloorOnly: true
        }) || [];
        const myId = window.gameClient?.player?.id;
        const trustedNames = bot.panic?.getTrustedNames?.() || [];
        const trustedSet = new Set(trustedNames);
        const otherPlayers = visiblePlayers.filter(p => {
            if (p.id === myId)
                return false;
            const name = normalizeCreatureName(p.name);
            return !trustedSet.has(name);
        });
        const hasOtherPlayers = otherPlayers.length > 0 && config.antiKSEnabled;

        if (hasOtherPlayers) {
            const selfRange = config.antiKSSelfRange ?? 2;
            const otherRange = config.antiKSOtherRange ?? 2;
            if (dist > selfRange) {
                skipTarget(target, "melee anti‑KS self range", now, 5000);
                return false;
            }
            for (const player of otherPlayers) {
                const pPos = player.getPosition?.() || player.__position;
                if (!pPos)
                    continue;
                const dx = Math.abs(pPos.x - targetPos.x);
                const dy = Math.abs(pPos.y - targetPos.y);
                if (dx <= otherRange && dy <= otherRange) {
                    skipTarget(target, "melee anti‑KS other range", now, 5000);
                    return false;
                }
            }
        }

        // Stuck detection
        if (state.engagedTargetId !== target.id) {
            state.meleeLastDist = dist;
            state.meleeProgressAt = now;
            state.meleeStuckAt = 0;
        } else {
            if (dist < state.meleeLastDist) {
                state.meleeLastDist = dist;
                state.meleeProgressAt = now;
                state.meleeStuckAt = 0;
            } else {
                if (!state.meleeStuckAt)
                    state.meleeStuckAt = now;
                if (now - state.meleeStuckAt > 6000) {
                    skipTarget(target, "melee stuck (no progress)", now, 3000);
                    return false;
                }
            }
        }

        if (now - state.lastMoveAt < 250)
            return false;

        const dx = targetPos.x - playerPos.x;
        const dy = targetPos.y - playerPos.y;
        let stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
        let stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

        const attempts = [{
                dx: stepX,
                dy: 0
            }, {
                dx: 0,
                dy: stepY
            }, {
                dx: stepX,
                dy: stepY
            }
        ];

        for (const a of attempts) {
            if (a.dx === 0 && a.dy === 0)
                continue;
            const nx = playerPos.x + a.dx;
            const ny = playerPos.y + a.dy;
            if (nx === targetPos.x && ny === targetPos.y)
                continue;

            // ★ Use safe check: walkable + not a hole/ladder/teleporter
            if (isSafeToWalkTile(nx, ny, playerPos.z, false)) {
                const dir = getDirection(a.dx, a.dy);
                if (dir !== null && window.gameClient?.keyboard) {
                    window.gameClient.keyboard.handleMoveKey(dir);
                    state.lastChaseAt = now;
                    state.lastMoveAt = now;
                    state.meleeLastDist = dist;
                    state.meleeStuckAt = 0;
                    return true;
                }
            }
        }

        return false;
    }

    // ---- Helper: standard away movement (fallback) ----
    function kiteAwayOnly(target, playerPos, targetPos, dist) {
        const offsets = [
            [0, -1], [1, 0], [0, 1], [-1, 0],
            [-1, -1], [1, -1], [-1, 1], [1, 1]
        ];
        let best = null;
        let bestScore = -Infinity;
        const dxAway = playerPos.x - targetPos.x;
        const dyAway = playerPos.y - targetPos.y;
        const stepX = dxAway > 0 ? 1 : (dxAway < 0 ? -1 : 0);
        const stepY = dyAway > 0 ? 1 : (dyAway < 0 ? -1 : 0);

        for (const off of offsets) {
            const nx = playerPos.x + off[0];
            const ny = playerPos.y + off[1];
            const pos = new Position(nx, ny, playerPos.z);
            const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
            if (!tile)
                continue;
            if (!tile.isWalkable())
                continue;
            if (tile.isOccupied())
                continue;

            const newDist = Math.max(Math.abs(nx - targetPos.x), Math.abs(ny - targetPos.y));
            const distIncrease = newDist - dist;
            let score = distIncrease * 30;
            if (off[0] === 0 || off[1] === 0)
                score += 15;
            if (stepX !== 0 && off[0] === stepX)
                score += 10;
            if (stepY !== 0 && off[1] === stepY)
                score += 10;
            if (distIncrease === 0)
                score += 5;
            score += (Math.random() - 0.5) * 0.1;

            if (score > bestScore) {
                bestScore = score;
                best = {
                    dx: off[0],
                    dy: off[1]
                };
            }
        }

        if (!best)
            return false;
        const dir = getDirection(best.dx, best.dy);
        if (!dir)
            return false;

        if (window.gameClient?.keyboard && typeof window.gameClient.keyboard.handleMoveKey === 'function') {
            window.gameClient.keyboard.handleMoveKey(dir);
            return true;
        }

        const packet = new MovementPacket(dir);
        if (window.gameClient?.send) {
            window.gameClient.send(packet);
            if (window.gameClient?.player) {
                window.gameClient.player.setTurnBuffer(dir);
                const newPos = window.gameClient.player.getPosition().add(new Position(best.dx, best.dy, 0));
                window.gameClient.networkManager.packetHandler.handlePlayerMove(newPos);
            }
            return true;
        }

        return false;
    }

    // Fallback function to move away from enemy
    function syncKiteFallback(now) {
        const target = getEngagedTarget();
        if (!target)
            return false;
        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(target.getPosition?.() || target.__position);
        if (!playerPos || !targetPos || playerPos.z !== targetPos.z)
            return false;
        const dist = getTileDistance(playerPos, targetPos);
        const ideal = Math.max(1, Number(config.idealDistance) || 3);
        if (dist >= ideal)
            return false;

        const offsets = [
            [0, -1], [1, 0], [0, 1], [-1, 0],
            [-1, -1], [1, -1], [-1, 1], [1, 1]
        ];

        let best = null;
        let bestScore = -Infinity;

        const dxAway = playerPos.x - targetPos.x;
        const dyAway = playerPos.y - targetPos.y;
        const stepX = dxAway > 0 ? 1 : (dxAway < 0 ? -1 : 0);
        const stepY = dyAway > 0 ? 1 : (dyAway < 0 ? -1 : 0);

        for (const off of offsets) {
            const nx = playerPos.x + off[0];
            const ny = playerPos.y + off[1];
            const pos = new Position(nx, ny, playerPos.z);
            const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
            if (!tile)
                continue;

            // ---- BLACKLIST CHECK ----
            if (bot.blacklist?.isBlacklisted(nx, ny, playerPos.z))
                continue;
            // ---- END ----

            if (!tile.isWalkable())
                continue;
            if (tile.isOccupied())
                continue;

            const newDist = Math.max(Math.abs(nx - targetPos.x), Math.abs(ny - targetPos.y));
            const distIncrease = newDist - dist;
            let score = distIncrease * 30;
            if (off[0] === 0 || off[1] === 0)
                score += 15;
            if (stepX !== 0 && off[0] === stepX)
                score += 10;
            if (stepY !== 0 && off[1] === stepY)
                score += 10;
            if (distIncrease === 0)
                score += 5;
            score += (Math.random() - 0.5) * 0.1;

            if (score > bestScore) {
                bestScore = score;
                best = {
                    dx: off[0],
                    dy: off[1]
                };
            }
        }

        if (!best)
            return false;

        const dir = getDirection(best.dx, best.dy);
        if (!dir)
            return false;

        if (window.gameClient?.keyboard && typeof window.gameClient.keyboard.handleMoveKey === 'function') {
            window.gameClient.keyboard.handleMoveKey(dir);
            return true;
        }

        const packet = new MovementPacket(dir);
        if (window.gameClient?.send) {
            window.gameClient.send(packet);
            if (window.gameClient?.player) {
                window.gameClient.player.setTurnBuffer(dir);
                const newPos = window.gameClient.player.getPosition().add(new Position(best.dx, best.dy, 0));
                window.gameClient.networkManager.packetHandler.handlePlayerMove(newPos);
            }
            return true;
        }

        return false;
    }

    // ---- ATTACK / RUNE ACTIONS ----
    function canAttack(now = Date.now()) {
        const slot = normalizeHotbarSlot(config.targetHotbarSlot);
        if (!slot)
            return false;
        if (now - state.lastTargetHotkeyAt < Math.max(0, Number(config.targetCooldownMs) || 0))
            return false;
        const candidates = getMonsterCandidates(now);
        return candidates.length > 0 && !getCurrentTarget();
    }

    function triggerAttack(now = Date.now()) {
        if (!canAttack(now))
            return false;
        const candidates = getMonsterCandidates(now);
        if (!candidates.length)
            return false;
        const best = candidates[0];

        // If we already have a target and it's the best, we're done.
        const current = getCurrentTarget();
        if (current && isSameCreature(current, best)) {
            return true;
        }

        // Target the best candidate
        if (setCurrentTarget(best)) {
            state.lastTargetHotkeyAt = now;
            markCombatActive(now);
            bot.log("selected auto attack target", {
                id: best.id,
                name: best.name || "Mob",
                reason: "best candidate"
            });
            return true;
        }
        return false;
    }

    function canUseRune(now = Date.now()) {
        const slot = normalizeHotbarSlot(config.runeHotbarSlot);
        if (!slot || !getCurrentTarget())
            return false;

        const playerPos = normalizePosition(bot.getPlayerPosition());
        const targetPos = normalizePosition(getCurrentTarget().getPosition?.() || getCurrentTarget().__position);
        if (!playerPos || !targetPos)
            return false;

        const dist = getTileDistance(playerPos, targetPos);
        const maxDist = Math.max(1, Number(config.maxTargetDistance) || 5);
        if (dist > maxDist)
            return false;

        if (now - state.lastRuneHotkeyAt < Math.max(0, Number(config.runeCooldownMs) || 0))
            return false;
        return true;
    }

    function triggerRune(now = Date.now()) {
        if (!canUseRune(now))
            return false;

        // Optional debug log
        const targetPos = normalizePosition(getCurrentTarget().getPosition?.() || getCurrentTarget().__position);
        const playerPos = normalizePosition(bot.getPlayerPosition());
        if (playerPos && targetPos) {
            const dist = getTileDistance(playerPos, targetPos);
            //bot.log(`Using rune on target at distance ${dist}`);
        }

        const slot = normalizeHotbarSlot(config.runeHotbarSlot);
        const clicked = bot.clickHotbar(slot - 1);
        if (clicked) {
            state.lastRuneHotkeyAt = now;
            markCombatActive(now);
            //bot.log("used auto attack rune hotkey", { slot, target: getCurrentTarget()?.name || "Mob" });
        }
        return clicked;
    }

    // ---- LOOP ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryAttack();
        } catch (e) {
            bot.log("auto attack tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        persistConfig();
        if (state.running) {
            bot.log("auto attack already running");
            return false;
        }
        state.running = true;
        // Apply chase mode if enabled
        if (config.useClientChase) {
            setClientChaseMode(2);
        }
        bot.log("auto attack started", {
            ...config
        });
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
        setClientChaseMode(0);
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        if (config.useClientChase) {
            try {
                const fms = window.gameClient?.interface?.fightModeSelector;
                if (fms && typeof fms.setChaseMode === 'function') {
                    fms.setChaseMode(0); // disable chase on stop
                }
            } catch (e) {}
        }
        clearEngagedTarget();
        state.lastChaseAt = 0;
        clearCurrentFollowTarget();
        state.kiteWaypointIndex = null;
        state.skippedTargetIds.clear();
        bot.log("auto attack stopped");
        return true;
    }

    function status() {
        const combatActive = syncCombatState(Date.now());
        state.lastProgressAt = 0;
        state.lastDistance = undefined;
        state.lastTargetHealth = null;
        return {
            running: state.running,
            config: {
                ...config
            },
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
            }
             : null,
            nearbyMonsters: getNearbyMonsters().map(c => ({
                    id: c.id,
                    name: c.name,
                    type: c.type,
                    position: c.__position,
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
        if (nextConfig.preferredTargetNames !== undefined) {
            nextConfig.preferredTargetNames = Array.isArray(nextConfig.preferredTargetNames)
                 ? nextConfig.preferredTargetNames.map(n => String(n).trim()).filter(Boolean)
                 : [];
        }
        if (nextConfig.ignoredTargetNames !== undefined) {
            nextConfig.ignoredTargetNames = Array.isArray(nextConfig.ignoredTargetNames)
                 ? nextConfig.ignoredTargetNames.map(n => String(n).trim()).filter(Boolean)
                 : [];
        }
        Object.assign(config, nextConfig);
        persistConfig();
        bot.log("auto attack config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

    bot.addCleanup(() => stop({
            persistEnabled: false
        }));

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
        setClientChaseMode,
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
    const ladderItemIds = new Set([1948, 1968, 435]);
    const holeItemIds = new Set([12396]);
    const teleporterItemIds = new Set([5756]); // turtle teleport – add more IDs as needed
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
        stuckCount: 0,
        lastDistanceToWaypoint: null,
        positionHistory: [],
        _stuckLogged: false,
        standReached: {},
        _standAttempt: null, // { index: number, adjacentAt: number }
        _ropeUsed: null, // index -> true
        _shovelUsed: null, // index -> true
        _shovelState: null,
        _shovelOpened: null,
        _shovelRetry: null, // { index, count, lastTry }
        _ladderUsed: null, // index -> true
        combatCooldownUntil: 0,
    };
    const minimapOverlayState = {
        timerId: null
    };

    const config = Object.assign({
        tickMs: 250,
        repathMs: 500,
        waypointTolerance: 0,
        enabled: false,
        activePresetName: defaultPresetName,
        loopMode: true,
        autoTransitions: true,
        stuckTimeoutMs: 2000,
        maxSkipAttempts: 10,
    },
            bot.storage.get(configStorageKey, {}));
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
        if (!value)
            return null;
        const name = normalizePresetName(value.name);
        if (!name)
            return null;
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
            }
        ];
    }

    function getPresetNames() {
        return presets.map(p => p.name);
    }
    function getPresetByName(name) {
        const n = normalizePresetName(name);
        if (!n)
            return null;
        return presets.find(p => p.name.toLowerCase() === n.toLowerCase()) || null;
    }

    function getActivePresetName() {
        const configured = normalizePresetName(config.activePresetName);
        if (configured && getPresetByName(configured))
            return getPresetByName(configured).name;
        if (presets.length)
            return presets[0].name;
        return configured || defaultPresetName;
    }

    function persistPresets() {
        bot.storage.set(presetStorageKey, presets.map(p => ({
                    name: p.name,
                    route: p.route.map(w => ({
                            ...w
                        })),
                    transitions: p.transitions.map(t => cloneValue(t)),
                })));
    }

    function persistLegacyActivePreset() {
        bot.storage.set(routeStorageKey, route.map(w => ({
                    ...w
                })));
        bot.storage.set(transitionStorageKey, transitions.map(t => cloneValue(t)));
    }

    function setActivePresetName(name) {
        config.activePresetName = normalizePresetName(name) || defaultPresetName;
        persistConfig();
        return config.activePresetName;
    }

    function upsertPreset(name, nextRoute = route, nextTransitions = transitions) {
        const norm = normalizePresetName(name);
        if (!norm)
            return null;
        const preset = {
            name: norm,
            route: normalizeRoute(nextRoute).map(w => cloneValue(w)),
            transitions: normalizeTransitions(nextTransitions).map(t => cloneValue(t)),
        };
        const idx = presets.findIndex(p => p.name.toLowerCase() === norm.toLowerCase());
        if (idx >= 0)
            presets[idx] = preset;
        else
            presets.push(preset);
        persistPresets();
        return preset;
    }

    function persistActivePreset() {
        upsertPreset(getActivePresetName(), route, transitions);
        persistLegacyActivePreset();
    }

    function loadPresetState(name) {
        const preset = getPresetByName(name);
        if (!preset)
            return null;
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
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function persistRoute() {
        persistActivePreset();
    }

    // ---- Simple walkability (copied from attack module) ----
    function isTileWalkable(x, y, z, ignoreCreatures = false) {
        const pos = new Position(x, y, z);
        const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
        if (!tile)
            return false;
        if (!tile.isWalkable())
            return false;
        if (tile.isItemBlocked())
            return false;
        if (!ignoreCreatures && tile.isOccupied())
            return false;
        return true;
    }

    function getDirection(dx, dy) {
        if (dx === 0 && dy === -1)
            return CONST.DIRECTION.NORTH;
        if (dx === 0 && dy === 1)
            return CONST.DIRECTION.SOUTH;
        if (dx === -1 && dy === 0)
            return CONST.DIRECTION.WEST;
        if (dx === 1 && dy === 0)
            return CONST.DIRECTION.EAST;
        if (dx === -1 && dy === -1)
            return CONST.DIRECTION.NORTHWEST;
        if (dx === 1 && dy === -1)
            return CONST.DIRECTION.NORTHEAST;
        if (dx === -1 && dy === 1)
            return CONST.DIRECTION.SOUTHWEST;
        if (dx === 1 && dy === 1)
            return CONST.DIRECTION.SOUTHEAST;
        return null;
    }

    // ---- POSITION HELPERS ----

    function normalizePosition(value) {
        if (!value)
            return null;
        const x = Number(value.x),
        y = Number(value.y),
        z = Number(value.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
            return null;
        return {
            x: Math.trunc(x),
            y: Math.trunc(y),
            z: Math.trunc(z)
        };
    }

    function normalizeWaypoint(waypoint) {
        if (!waypoint)
            return null;
        let x,
        y,
        z,
        label,
        script,
        stand,
        rope,
        shovel,
        ladder;
        if (Array.isArray(waypoint)) {
            [x, y, z] = waypoint;
            stand = rope = shovel = ladder = false;
        } else {
            x = Number(waypoint.x);
            y = Number(waypoint.y);
            z = Number(waypoint.z);
            label = waypoint.label ? String(waypoint.label).trim() : undefined;
            script = waypoint.script !== undefined && waypoint.script !== null ? String(waypoint.script) : undefined;
            stand = waypoint.stand === true;
            rope = waypoint.rope === true;
            shovel = waypoint.shovel === true;
            ladder = waypoint.ladder === true;
        }
        const hasCoords = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
        const hasScript = script !== undefined && script.length > 0;
        if (!hasCoords && !hasScript)
            return null;
        return {
            x: hasCoords ? Math.trunc(x) : undefined,
            y: hasCoords ? Math.trunc(y) : undefined,
            z: hasCoords ? Math.trunc(z) : undefined,
            label: label || (hasScript ? "Script" : undefined),
            script: script,
            stand: !!stand,
            rope: !!rope,
            shovel: !!shovel,
            ladder: !!ladder,
        };
    }

    function normalizeRoute(value) {
        if (!Array.isArray(value))
            return [];
        return value.map(normalizeWaypoint).filter(Boolean);
    }

    function normalizeTransition(transition) {
        if (!transition)
            return null;
        const from = normalizePosition(transition.from || transition);
        const to = normalizePosition(transition.to || {
            x: transition.targetX,
            y: transition.targetY,
            z: transition.targetZ,
        });
        if (!from || !to || from.z === to.z)
            return null;
        const count = Math.max(1, Math.trunc(Number(transition.count) || 1));
        const lastSeenAt = Math.max(0, Math.trunc(Number(transition.lastSeenAt) || Date.now()));
        return {
            from,
            to,
            count,
            lastSeenAt
        };
    }

    function normalizeTransitions(value) {
        if (!Array.isArray(value))
            return [];
        const deduped = new Map();
        value.map(normalizeTransition).filter(Boolean).forEach(t => deduped.set(getPositionKey(t.from), t));
        return Array.from(deduped.values());
    }

    function getRoute() {
        return route.map(w => cloneValue(w));
    }
    function getTransitions() {
        return transitions.map(t => cloneValue(t));
    }
    function persistTransitions() {
        persistActivePreset();
    }

    // ---- PRESET CRUD ----
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
            transitions: preset.transitions.length
        });
        return {
            name: preset.name,
            route: preset.route.map(w => cloneValue(w)),
            transitions: preset.transitions.map(t => cloneValue(t))
        };
    }

    function createPreset(name) {
        const norm = normalizePresetName(name);
        if (!norm) {
            bot.log("cave preset name is required");
            return null;
        }
        if (getPresetByName(norm)) {
            bot.log("cave preset already exists", {
                name: norm
            });
            return null;
        }
        if (state.running)
            stop();
        const preset = upsertPreset(norm, [], []);
        if (!preset)
            return null;
        loadPresetState(preset.name);
        bot.log("cave preset created", {
            name: preset.name
        });
        return {
            name: preset.name,
            route: [],
            transitions: []
        };
    }

    function loadPreset(name) {
        const preset = getPresetByName(name);
        if (!preset) {
            bot.log("cave preset not found", {
                name
            });
            return null;
        }
        if (state.running)
            stop();
        loadPresetState(preset.name);
        bot.log("cave preset loaded", {
            name: preset.name,
            waypoints: route.length,
            transitions: transitions.length
        });
        return {
            name: preset.name,
            route: getRoute(),
            transitions: getTransitions()
        };
    }

    function deletePreset(name) {
        const preset = getPresetByName(name);
        if (!preset) {
            bot.log("cave preset not found", {
                name
            });
            return false;
        }
        presets = presets.filter(p => p.name.toLowerCase() !== preset.name.toLowerCase());
        persistPresets();
        if (preset.name.toLowerCase() === getActivePresetName().toLowerCase()) {
            const fallback = presets[0] || null;
            if (state.running)
                stop();
            if (fallback)
                loadPresetState(fallback.name);
            else {
                route = [];
                transitions = [];
                state.currentIndex = 0;
                state.direction = 1;
                state.pendingTransitionSource = null;
                setActivePresetName(defaultPresetName);
                persistLegacyActivePreset();
            }
        }
        bot.log("cave preset deleted", {
            name: preset.name
        });
        return true;
    }

    function renamePreset(oldName, newName) {
        const old = normalizePresetName(oldName);
        const newN = normalizePresetName(newName);
        if (!old || !newN) {
            bot.log("renamePreset: invalid names");
            return false;
        }
        if (old === newN) {
            bot.log("renamePreset: new name is the same");
            return false;
        }
        const existing = getPresetByName(newN);
        if (existing) {
            bot.log("renamePreset: preset with new name already exists");
            return false;
        }
        const preset = getPresetByName(old);
        if (!preset) {
            bot.log("renamePreset: preset not found");
            return false;
        }
        // Create new preset with new name and same route/transitions
        const newPreset = {
            name: newN,
            route: preset.route.map(w => cloneValue(w)),
            transitions: preset.transitions.map(t => cloneValue(t)),
        };
        // Remove old and add new
        presets = presets.filter(p => p.name.toLowerCase() !== old.toLowerCase());
        presets.push(newPreset);
        persistPresets();
        // If active preset was the old one, update active name
        if (config.activePresetName && config.activePresetName.toLowerCase() === old.toLowerCase()) {
            config.activePresetName = newN;
            persistConfig();
        }
        bot.log(`renamePreset: renamed "${old}" to "${newN}"`);
        return true;
    }

    /**
     * Merge new presets into the existing ones.
     * @param {Array} newPresets – Array of preset objects { name, route, transitions }
     * @param {boolean} skipExisting – If true, presets with matching names are skipped.
     * @returns {{ added: number, skipped: number }}
     */
    function mergePresets(newPresets, skipExisting = true) {
        let added = 0;
        let skipped = 0;

        if (!Array.isArray(newPresets)) {
            bot.log("mergePresets: invalid input, expected array");
            return {
                added: 0,
                skipped: 0
            };
        }

        for (const p of newPresets) {
            const norm = normalizePreset(p);
            if (!norm) {
                bot.log("mergePresets: skipping invalid preset", p);
                continue;
            }

            const existing = getPresetByName(norm.name);
            if (existing && skipExisting) {
                skipped++;
                continue;
            }

            // Add or replace (replace shouldn't happen because we skip existing)
            upsertPreset(norm.name, norm.route, norm.transitions);
            added++;
        }

        persistPresets();
        bot.log(`mergePresets: added ${added}, skipped ${skipped}`);
        return {
            added,
            skipped
        };
    }

    // ---- WAYPOINT HELPERS ----

    function isOrthogonallyAdjacent(from, to) {
        if (!from || !to || from.z !== to.z)
            return false;
        const dx = Math.abs(from.x - to.x);
        const dy = Math.abs(from.y - to.y);
        return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
    }

    function getCurrentWaypoint() {
        if (!route.length)
            return null;
        if (state.currentIndex < 0 || state.currentIndex >= route.length)
            state.currentIndex = 0;
        return route[state.currentIndex] || null;
    }

    function getPositionKey(position) {
        return position ? `${position.x},${position.y},${position.z}` : null;
    }

    function getDistance(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return Number.POSITIVE_INFINITY;
        return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
    }

    function isBesideOrSameTile(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return false;
        return Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1;
    }

    function isAdjacentTile(from, to) {
        if (!from || !to || Number(from.z) !== Number(to.z))
            return false;
        const dx = Math.abs(from.x - to.x),
        dy = Math.abs(from.y - to.y);
        return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
    }

    function getDistanceToWaypoint(position, waypoint) {
        if (!position || !waypoint)
            return null;
        return getDistance(position, waypoint);
    }

    function isSameTile(a, b) {
        return a && b && a.x === b.x && a.y === b.y && a.z === b.z;
    }

    function findClosestWaypointIndex(position) {
        if (!position || !route.length)
            return 0;
        let bestIdx = 0,
        bestDist = Infinity;
        route.forEach((wp, i) => {
            const d = getDistanceToWaypoint(position, wp);
            if (Number.isFinite(d) && d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        });
        return bestIdx;
    }

    // ---- TILE / ITEM HELPERS ----
    function getTileAt(position) {
        if (!position)
            return null;
        return window.gameClient?.world?.getTileFromWorldPosition?.(new Position(position.x, position.y, position.z)) || null;
    }

    function getTilePosition(tile) {
        return normalizePosition(tile?.__position);
    }

    function getThingDefinition(itemId) {
        if (!itemId)
            return null;
        return window.gameClient?.itemDefinitionsByCid?.[itemId] ||
        window.gameClient?.itemDefinitionsBySid?.[itemId] ||
        window.gameClient?.itemDefinitions?.[itemId] || null;
    }

    function getThingName(thing) {
        const def = getThingDefinition(thing?.id);
        return String(def?.properties?.name || thing?.name || "").trim().toLowerCase();
    }

    function isLadderThing(thing) {
        if (!thing?.id)
            return false;
        if (ladderItemIds.has(Number(thing.id)))
            return true;
        return getThingName(thing).includes("ladder");
    }

    function isFloorChangeThing(thing) {
        if (!thing?.id)
            return false;
        // Check known floor‑change properties
        const def = getThingDefinition(thing?.id);
        if (def?.properties?.floorchange)
            return true;
        // Check ladders
        if (ladderItemIds.has(Number(thing.id)))
            return true;
        // Check teleporters
        if (teleporterItemIds.has(Number(thing.id)))
            return true;
        return false;
    }

    function isFloorChangeTile(tile) {
        const pos = getTilePosition(tile);
        if (!pos)
            return false;
        if (isFloorChangeThing(tile))
            return true;
        return Array.isArray(tile.items) && tile.items.some(item => isFloorChangeThing(item));
    }

    function getTileThings(tile) {
        if (!tile)
            return [];
        const things = [];
        if (tile.id)
            things.push(tile);
        if (Array.isArray(tile.items)) {
            tile.items.forEach(item => {
                if (item)
                    things.push(item);
            });
        }
        return things;
    }

    function tileHasNamedThing(tile, needle) {
        const val = String(needle || "").trim().toLowerCase();
        if (!val)
            return false;
        return getTileThings(tile).some(t => getThingName(t).includes(val));
    }

    function isLadderTile(tile) {
        return getTileThings(tile).some(t => isLadderThing(t));
    }
    function isStairsTile(tile) {
        return tileHasNamedThing(tile, "stairs");
    }
    function isHoleTile(tile) {
        if (tileHasNamedThing(tile, "hole"))
            return true;
        // fallback: check if the tile itself or any item has a known hole ID
        const things = [tile, ...(tile.items || [])];
        return things.some(t => t?.id !== undefined && holeItemIds.has(t.id));
    }
    function isRopeSpotTile(tile) {
        return tileHasNamedThing(tile, "rope spot");
    }
    function isRopeTargetTile(tile) {
        return isHoleTile(tile) || isRopeSpotTile(tile);
    }

    function isShovelTargetThing(thing) {
        const name = getThingName(thing);
        if (!name)
            return false;
        return shovelTargetNamePatterns.some(p => p.test(name));
    }
    function isShovelTargetTile(tile) {
        return getTileThings(tile).some(t => isShovelTargetThing(t));
    }

    function isTransitionCandidateTile(tile, waypoint, position) {
        if (!tile)
            return false;
        if (isFloorChangeTile(tile))
            return true;
        if (!waypoint || !position || !Number.isFinite(waypoint.z) || !Number.isFinite(position.z))
            return false;
        if (waypoint.z > position.z)
            return isShovelTargetTile(tile);
        if (waypoint.z < position.z)
            return isRopeTargetTile(tile);
        return false;
    }

    function getFloorChangeTileBias(tile, position, waypoint) {
        if (!tile || !position || !waypoint || position.z === waypoint.z)
            return 0;
        const goingDown = waypoint.z > position.z;
        const goingUp = waypoint.z < position.z;
        if (goingDown) {
            if (isLadderTile(tile))
                return -30;
            if (isHoleTile(tile))
                return -20;
            if (isStairsTile(tile))
                return 25;
        }
        if (goingUp) {
            if (isStairsTile(tile))
                return -20;
            if (isHoleTile(tile))
                return 20;
        }
        return 0;
    }

    function getLoadedTiles() {
        const chunks = window.gameClient?.world?.chunks || [];
        const tiles = [];
        for (const chunk of chunks) {
            if (!chunk?.tiles)
                continue;
            for (const tile of chunk.tiles) {
                if (tile?.__position)
                    tiles.push(tile);
            }
        }
        return tiles;
    }

    // -- container helper

    function getContainerById(containerId) {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return null;
        // Convert to array if needed
        const arr = Array.isArray(containers) ? containers : Array.from(containers);
        return arr.find(c => c.__containerId === containerId) || null;
    }

    // ---- MINIMAP OVERLAY ----
    function ensureMinimapOverlayStyle() {
        if (document.getElementById(minimapOverlayStyleId))
            return;
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
        if (root)
            return root;
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
        if (!(canvas instanceof HTMLCanvasElement))
            return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return null;
        return {
            canvas,
            rect
        };
    }

    function getWaypointCanvasPoint(waypoint, viewport, playerPos, minimap) {
        if (!waypoint || !viewport || !playerPos || !minimap)
            return null;
        if (waypoint.z !== minimap.__renderLayer)
            return null;
        const zoom = 1 << (Number(minimap.__zoomLevel) || 0);
        const center = minimap.center || {
            x: 0,
            y: 0
        };
        const iw = Number(viewport.canvas.width) || 160;
        const ih = Number(viewport.canvas.height) || 160;
        const ix = (iw / 2) + (waypoint.x - playerPos.x - Number(center.x || 0)) * zoom;
        const iy = (ih / 2) + (waypoint.y - playerPos.y - Number(center.y || 0)) * zoom;
        return {
            x: ix * (viewport.rect.width / iw),
            y: iy * (viewport.rect.height / ih)
        };
    }

    function renderMinimapOverlay() {
        const viewport = getMinimapViewport();
        const minimap = window.gameClient?.renderer?.minimap;
        const playerPos = normalizePosition(bot.getPlayerPosition());
        const root = ensureMinimapOverlayRoot();
        const canvas = root.querySelector("canvas");
        if (!(canvas instanceof HTMLCanvasElement))
            return;
        if (!viewport || !minimap || !playerPos || !route.length) {
            canvas.width = 0;
            canvas.height = 0;
            return;
        }
        const rect = viewport.rect;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
        }
        canvas.style.left = `${Math.round(rect.left)}px`;
        canvas.style.top = `${Math.round(rect.top)}px`;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const visible = route.map((wp, i) => ({
                    waypoint: wp,
                    index: i,
                    point: getWaypointCanvasPoint(wp, viewport, playerPos, minimap)
                }))
            .filter(e => e.point);
        if (!visible.length)
            return;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (let i = 1; i < visible.length; i++) {
            const prev = visible[i - 1],
            cur = visible[i];
            if (cur.index !== prev.index + 1)
                continue;
            ctx.strokeStyle = "rgba(92, 228, 196, 0.7)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(prev.point.x, prev.point.y);
            ctx.lineTo(cur.point.x, cur.point.y);
            ctx.stroke();
        }
        visible.forEach(({
                point,
                index
            }) => {
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
        if (minimapOverlayState.timerId != null)
            return;
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
        if (!position)
            return [];
        return getLoadedTiles()
        .map(t => ({
                tile: t,
                position: getTilePosition(t)
            }))
        .filter(e =>
            e.position &&
            e.position.z === position.z &&
            Math.abs(e.position.x - position.x) <= radius &&
            Math.abs(e.position.y - position.y) <= radius &&
            isTransitionCandidateTile(e.tile, waypoint, position));
    }

    function findTransitionTileNearPosition(position, waypoint, radius = 1) {
        if (!position)
            return null;
        let best = null,
        bestDist = Infinity;
        getNearbyTransitionTiles(position, waypoint, radius).forEach(e => {
            const d = getDistance(position, e.position);
            if (Number.isFinite(d) && d < bestDist) {
                bestDist = d;
                best = e;
            }
        });
        return best;
    }

    function findBestKnownTransition(position, waypoint) {
        if (!position || !waypoint)
            return null;
        let best = null,
        bestScore = Infinity;
        transitions.forEach(t => {
            if (t.from.z !== position.z || t.to.z !== waypoint.z)
                return;
            const playerDist = getDistance(position, t.from);
            const landingDist = getDistance(t.to, waypoint);
            if (!Number.isFinite(playerDist) || !Number.isFinite(landingDist))
                return;
            const score = playerDist * 10 + landingDist;
            if (score < bestScore) {
                bestScore = score;
                best = t;
            }
        });
        return best;
    }

    function findNearbyTransitionTile(position, waypoint) {
        if (!position || !waypoint)
            return null;
        const wpDist = Math.abs(position.x - waypoint.x) + Math.abs(position.y - waypoint.y);
        const radius = Math.max(4, Math.min(20, wpDist + 2));
        let best = null,
        bestScore = Infinity;
        getNearbyTransitionTiles(position, waypoint, radius).forEach(e => {
            const pd = getDistance(position, e.position);
            const twd = Math.abs(e.position.x - waypoint.x) + Math.abs(e.position.y - waypoint.y);
            const score = pd * 10 + twd + getFloorChangeTileBias(e.tile, position, waypoint);
            if (score < bestScore) {
                bestScore = score;
                best = {
                    tile: e.tile,
                    position: e.position,
                    playerDistance: pd,
                    waypointDistance: twd
                };
            }
        });
        return best;
    }

    function isAtWaypoint(position, waypoint) {
        const d = getDistanceToWaypoint(position, waypoint);
        if (!Number.isFinite(d))
            return false;
        return d <= Math.max(0, Number(config.waypointTolerance) || 0);
    }

    function goToWaypoint(waypoint) {
        // If this is a script-only waypoint, nothing to move
        if (!waypoint || waypoint.x === undefined || waypoint.x === null) {
            return true;
        }
        // ---- BLACKLIST CHECK ----
        if (bot.blacklist?.isBlacklisted(waypoint.x, waypoint.y, waypoint.z)) {
            bot.log("cave skipping blacklisted waypoint", waypoint);
            state.lastWaypointTarget = null;
            const nextWp = advanceWaypoint();
            if (nextWp)
                return goToWaypoint(nextWp);
            return false;
        }
        // ---- END BLACKLIST CHECK ----

        const from = bot.getPlayerPosition();
        if (!from || !waypoint)
            return false;
        const to = new Position(waypoint.x, waypoint.y, waypoint.z);
        let success = false;
        try {
            window.gameClient?.world?.pathfinder?.findPath?.(from, to);
            state.lastPathAt = Date.now();
            success = true;
        } catch (error) {
            // pathfinder threw – we'll fallback
        }

        // If pathfinder didn't set a path (or failed), try to move one step manually
        if (!success || !window.gameClient?.world?.pathfinder?.__finalDestination) {
            const pf = window.gameClient?.world?.pathfinder;
            // Wait a tiny moment for pathfinder to set its state, then check
            setTimeout(() => {
                if (pf && !pf.__finalDestination) {
                    // Move one step toward waypoint
                    const dx = waypoint.x - from.x;
                    const dy = waypoint.y - from.y;
                    let stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
                    let stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
                    const attempts = [{
                            dx: stepX,
                            dy: 0
                        }, {
                            dx: 0,
                            dy: stepY
                        }, {
                            dx: stepX,
                            dy: stepY
                        }
                    ];
                    for (const a of attempts) {
                        const nx = from.x + a.dx;
                        const ny = from.y + a.dy;
                        if (bot.blacklist?.isBlacklisted(nx, ny, from.z))
                            continue;
                        if (isTileWalkable(nx, ny, from.z, true)) {
                            const dir = getDirection(a.dx, a.dy);
                            if (dir !== null && window.gameClient?.keyboard) {
                                window.gameClient.keyboard.handleMoveKey(dir);
                                state.lastPathAt = Date.now();
                                break;
                            }
                        }
                    }
                }
            }, 50);
        }
        return success;
    }

    function goToPosition(position) {
        if (!position)
            return false;
        return goToWaypoint(position);
    }

    function markPendingTransitionSource(source) {
        const norm = normalizePosition(source);
        if (!norm)
            return;
        state.pendingTransitionSource = {
            ...norm,
            at: Date.now()
        };
    }

    function upsertTransition(from, to) {
        const f = normalizePosition(from),
        t = normalizePosition(to);
        if (!f || !t || f.z === t.z)
            return null;
        const key = getPositionKey(f);
        const idx = transitions.findIndex(tr => getPositionKey(tr.from) === key);
        const next = {
            from: f,
            to: t,
            count: idx >= 0 ? transitions[idx].count + 1 : 1,
            lastSeenAt: Date.now(),
        };
        if (idx >= 0)
            transitions[idx] = next;
        else
            transitions.push(next);
        persistTransitions();
        bot.log("cave learned floor transition", next);
        return cloneValue(next);
    }

    function resolveObservedTransitionSource(prevPos) {
        const pending = normalizePosition(state.pendingTransitionSource);
        if (pending && pending.z === prevPos.z)
            return pending;
        const tile = getTileAt(prevPos);
        if (tile && isFloorChangeTile(tile))
            return prevPos;
        const nearby = findTransitionTileNearPosition(prevPos, null, 1);
        if (nearby?.position)
            return nearby.position;
        return null;
    }

    function observePosition() {
        const current = normalizePosition(bot.getPlayerPosition());
        if (!current)
            return;
        const previous = state.lastObservedPosition;
        if (previous && !isSameTile(previous, current) && previous.z !== current.z) {
            const source = resolveObservedTransitionSource(previous);
            if (source)
                upsertTransition(source, current);
            state.pendingTransitionSource = null;
        }
        state.lastObservedPosition = current;
    }

    // ---- TOOL HANDLING (rope / shovel) ----
    function getEquipment() {
        return window.gameClient?.player?.equipment || null;
    }
    function getOpenContainers() {
        return Array.from(window.gameClient?.player?.__openedContainers || []);
    }

    function findAdjacentWalkablePosition(targetPos, playerPos) {
        if (!targetPos || !playerPos)
            return null;
        const offsets = [{
                x: 0,
                y: -1
            }, {
                x: 1,
                y: 0
            }, {
                x: 0,
                y: 1
            }, {
                x: -1,
                y: 0
            }, {
                x: -1,
                y: -1
            }, {
                x: 1,
                y: -1
            }, {
                x: -1,
                y: 1
            }, {
                x: 1,
                y: 1
            },
        ];
        offsets.sort((a, b) => {
            const da = Math.abs(targetPos.x + a.x - playerPos.x) + Math.abs(targetPos.y + a.y - playerPos.y);
            const db = Math.abs(targetPos.x + b.x - playerPos.x) + Math.abs(targetPos.y + b.y - playerPos.y);
            return da - db;
        });
        for (const off of offsets) {
            const pos = new Position(targetPos.x + off.x, targetPos.y + off.y, targetPos.z);
            const tile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
            if (tile?.isWalkable?.())
                return normalizePosition(pos);
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
                if (predicate(item))
                    return {
                        which: eq,
                        index: i,
                        item,
                        location: "equipment"
                    };
            }
        }
        for (const container of getOpenContainers()) {
            const slots = container?.slots || [];
            for (let i = 0; i < slots.length; i++) {
                const item = container.getSlotItem?.(i);
                if (predicate(item))
                    return {
                        which: container,
                        index: i,
                        item,
                        location: "container"
                    };
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
        if (!tool || !targetTile || !targetPosition)
            return false;
        const playerPos = normalizePosition(bot.getPlayerPosition());
        if (!playerPos)
            return false;
        // Allow use if on the same tile OR adjacent
        if (!isSameTile(playerPos, targetPosition) && !isAdjacentTile(playerPos, targetPosition)) {
            const adj = findAdjacentWalkablePosition(targetPosition, playerPos);
            if (adj)
                return goToPosition(adj);
        }
        window.gameClient?.mouse?.__handleItemUseWith?.({
            which: tool.which,
            index: tool.index
        }, {
            which: targetTile,
            index: 0xFF
        });
        state.lastStairsUseAt = now;
        state.lastPathAt = now;
        markPendingTransitionSource(targetPosition);
        bot.log(actionLabel, {
            source: targetPosition,
            toolLocation: tool.location,
            toolSlot: tool.index,
            toolName: getThingName(tool.item)
        });
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
        if (!position || !targetPos || !targetTile)
            return false;
        if (now - state.lastStairsUseAt < 1200)
            return true;

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
            window.gameClient?.mouse?.use?.({
                which: targetTile,
                index: 0xFF
            });
            state.lastStairsUseAt = now;
            state.lastPathAt = now;
            markPendingTransitionSource(targetPos);
            bot.log("cave used ladder tile", {
                source: targetPos,
                targetZ: waypoint?.z ?? null
            });
            return true;
        }
        if (!isSameTile(position, targetPos))
            return goToPosition(targetPos);
        const curTile = getTileAt(position);
        if (!curTile || !isFloorChangeTile(curTile))
            return false;
        window.gameClient?.mouse?.use?.({
            which: curTile,
            index: 0xFF
        });
        state.lastStairsUseAt = now;
        state.lastPathAt = now;
        markPendingTransitionSource(position);
        bot.log("cave used floor-change tile", {
            source: position,
            targetZ: waypoint?.z ?? null
        });
        return true;
    }

    function handleFloorChange(waypoint, now = Date.now()) {
        const position = normalizePosition(bot.getPlayerPosition());
        if (!position || !waypoint || position.z === waypoint.z)
            return false;

        // Try to find a visible transition tile
        const visible = findNearbyTransitionTile(position, waypoint);
        if (visible) {
            const tile = visible.tile;
            const tilePos = visible.position;
            const isTeleporter = tile && teleporterItemIds.has(Number(tile.id));

            if (isTeleporter) {
                // Walk onto the teleporter tile
                const moved = goToPosition(tilePos);
                if (moved) {
                    bot.log("cave walking onto teleporter tile", {
                        x: tilePos.x,
                        y: tilePos.y,
                        z: tilePos.z,
                        targetZ: waypoint.z
                    });
                    return true;
                }
                // Fallback: if walk fails, try using it anyway (just in case)
            }

            // For non‑teleporter tiles (stairs, ladders, holes), use them
            const moved = useFloorChangeTile(visible, waypoint, now);
            if (moved) {
                bot.log("cave probing visible floor-change tile", {
                    tileX: visible.position.x,
                    tileY: visible.position.y,
                    tileZ: visible.position.z,
                    targetZ: waypoint.z,
                });
                return true;
            }
        }

        // Fallback to learned transition
        const known = findBestKnownTransition(position, waypoint);
        if (known) {
            const target = {
                tile: getTileAt(known.from),
                position: known.from
            };
            const tile = target.tile;
            const isTeleporter = tile && teleporterItemIds.has(Number(tile.id));

            if (isTeleporter) {
                const moved = goToPosition(known.from);
                if (moved) {
                    bot.log("cave walking onto known teleporter tile", {
                        from: known.from,
                        to: known.to,
                        waypoint
                    });
                    return true;
                }
            }

            const moved = useFloorChangeTile(target, waypoint, now);
            if (moved) {
                bot.log("cave using learned floor transition", {
                    from: known.from,
                    to: known.to,
                    waypoint
                });
                return true;
            }
            bot.log("cave learned transition unavailable, falling back to live scan", {
                from: known.from,
                to: known.to,
                waypoint
            });
        }

        return false;
    }

    // ---- WAYPOINT NAVIGATION ----
    function advanceWaypoint() {
        state._standAttempt = null;
        state._ropeUsed = undefined;
        state._shovelUsed = undefined;
        state._shovelOpened = undefined;
        state._shovelRetry = null;
        // Clear reached flag for old index
        if (state.standReached) {
            delete state.standReached[state.currentIndex];
        }
        if (!route.length)
            return null;
        if (route.length === 1)
            return route[0];

        if (config.loopMode) {
            // Always go forward, wrap around to 0 when at the end
            let next = (state.currentIndex + 1) % route.length;
            state.currentIndex = next;
            state.direction = 1; // ensure direction is forward
            state.pathAttemptStart = 0;
            return getCurrentWaypoint();
        } else {
            // Original non‑loop logic (go forward then backward)
            let next = state.currentIndex + state.direction;
            if (next >= route.length) {
                state.direction = -1;
                next = route.length - 2;
            } else if (next < 0) {
                state.direction = 1;
                next = 1;
            }
            state.currentIndex = Math.max(0, Math.min(route.length - 1, next));
            state.pathAttemptStart = 0;
            return getCurrentWaypoint();
        }
    }

    /**
     * Skips to the waypoint closest to the player's current position.
     * Returns the new waypoint, or null if no route exists.
     */
    function skipToClosestWaypoint() {
        const pos = bot.getPlayerPosition();
        if (!pos || !route.length)
            return null;

        // Find the closest waypoint by distance (Manhattan)
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < route.length; i++) {
            const wp = route[i];
            const dist = Math.abs(wp.x - pos.x) + Math.abs(wp.y - pos.y) + Math.abs(wp.z - pos.z) * 10;
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        state.currentIndex = bestIdx;
        state.direction = 1; // reset direction to forward

        const wp = route[bestIdx];
        bot.log(`Cave: skipping to closest waypoint #${bestIdx + 1} (${wp.x}, ${wp.y}, ${wp.z})`);
        goToWaypoint(wp);
        return wp;
    }

    /**
     * Advances to the next waypoint, skipping any that are on a different floor
     * and cannot be reached via a known or visible transition.
     * Returns the new waypoint (or null if none found).
     */
    function advanceToReachableWaypoint(startIndex, direction) {
        let attempts = 0;
        const maxAttempts = config.maxSkipAttempts || 10;
        let idx = startIndex;
        let dir = direction || state.direction || 1;

        while (attempts < maxAttempts) {
            // Move to next waypoint according to direction/loop
            let next = idx + dir;
            if (config.loopMode) {
                if (next >= route.length)
                    next = 0;
                else if (next < 0)
                    next = route.length - 1;
            } else {
                if (next >= route.length || next < 0) {
                    // End of route in non‑loop mode – stop
                    return null;
                }
            }
            // Clamp
            next = Math.max(0, Math.min(route.length - 1, next));

            const candidate = route[next];
            if (!candidate)
                break;

            // If same floor, we can go to it directly
            const pos = bot.getPlayerPosition();
            if (pos && candidate.z === pos.z) {
                state.currentIndex = next;
                state.direction = dir;
                return candidate;
            }

            // If different floor, check if we have a transition
            if (pos) {
                // Try to find a known transition from current floor to candidate floor
                const transition = findBestKnownTransition(pos, candidate);
                if (transition) {
                    // We have a known transition – we can try to use it
                    state.currentIndex = next;
                    state.direction = dir;
                    return candidate;
                }

                // Also check if there is a visible transition tile nearby
                const visible = findNearbyTransitionTile(pos, candidate);
                if (visible) {
                    state.currentIndex = next;
                    state.direction = dir;
                    return candidate;
                }
            }

            // No transition found – skip this waypoint
            bot.log(`Cave: skipping waypoint ${next + 1} (floor ${candidate.z}) – no transition available`);
            attempts++;
            idx = next;
            // Continue looping to the next
        }

        // No reachable waypoint found – stop cavebot
        bot.log("Cave: no reachable waypoint found within max skip attempts – stopping");
        stop();
        return null;
    }
    // ---- MAIN LOOP ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }

    /**
     * The main cave tick: observes position, pauses for combat, checks waypoint
     * proximity, handles floor changes, and repaths. Includes a guarded skip
     * logic that waits for pathfinder to give up (__finalDestination === null)
     * and for a time threshold before skipping.
     */
    function tick() {
        if (!state.running)
            return;

        if (bot._waitUntil && Date.now() < bot._waitUntil) {
            scheduleNextTick();
            return;
        }

        if (state.combatCooldownUntil && Date.now() < state.combatCooldownUntil) {
            scheduleNextTick();
            return;
        }

        // ---- stopMovement helper ----
        function stopMovement() {
            const pf = window.gameClient?.world?.pathfinder;
            if (pf) {
                pf.setPathfindCache(null);
                pf.__isAutoWalking = false;
                pf.__finalDestination = null;
                pf.__hybridPath = null;
            }
            const player = window.gameClient?.player;
            if (player && player.__preWalks) {
                player.__preWalks.length = 0;
            }
            try {
                if (window.gameClient && window.gameClient.send) {
                    window.gameClient.send(new StopWalkPacket());
                }
            } catch (e) {}
            state.lastWaypointTarget = null;
            state.pathAttemptStart = 0;
            state.lastDistanceToWaypoint = null;
            state.lastPathAt = 0;
        }

        // ---- Combat pause ----
        function hasValidTarget() {
            const player = window.gameClient?.player;
            if (!player)
                return false;
            const target = player.__target;
            if (!target) {
                if (state.pausedForCombat) {
                    state.pausedForCombat = false;
                    // Clear prediction queue to avoid extra step
                    if (player.__preWalks)
                        player.__preWalks.length = 0;
                    state.combatCooldownUntil = Date.now() + 200; // 200ms cooldown
                    bot.log("cave resumed (no target) – cooldown 200ms");
                }
                return false;
            }
            const health = target.state?.health ?? target.health;
            if (health !== undefined && health <= 0) {
                if (state.pausedForCombat) {
                    state.pausedForCombat = false;
                    if (player.__preWalks)
                        player.__preWalks.length = 0;
                    state.combatCooldownUntil = Date.now() + 200;
                    bot.log("cave resumed (target dead) – cooldown 200ms");
                }
                return false;
            }
            try {
                const pp = player.getPosition().projected();
                const tp = target.getPosition().projected();
                const onScreen = Math.abs(pp.x - tp.x) < 8 && Math.abs(pp.y - tp.y) < 6;
                if (!onScreen && state.pausedForCombat) {
                    state.pausedForCombat = false;
                    if (player.__preWalks)
                        player.__preWalks.length = 0;
                    state.combatCooldownUntil = Date.now() + 200;
                    bot.log("cave resumed (target off‑screen) – cooldown 200ms");
                }
                return onScreen;
            } catch {
                if (state.pausedForCombat) {
                    state.pausedForCombat = false;
                    if (player.__preWalks)
                        player.__preWalks.length = 0;
                    state.combatCooldownUntil = Date.now() + 200;
                    bot.log("cave resumed (error) – cooldown 200ms");
                }
                return false;
            }
        }

        const shouldPause = hasValidTarget();
        if (shouldPause) {
            if (!state.pausedForCombat) {
                state.pausedForCombat = true;
                stopMovement();
                bot.log("cave paused");
            }
            scheduleNextTick();
            return;
        }

        try {
            observePosition();

            if (!route.length) {
                stop();
                return;
            }

            const position = normalizePosition(bot.getPlayerPosition());
            const positionKey = getPositionKey(position);
            const now = Date.now();

            // ---- Helper: is the player currently targeting something? ----
            //function _hasTarget() {
            //    return !!window.gameClient?.player?.__target || !!bot.attack?.getCurrentTarget?.();
            //}

            // ---- DECLARE WAYPOINT HERE ----
            let waypoint = getCurrentWaypoint();

            // ---- STAND WAYPOINT ----
            if (waypoint && waypoint.stand) {
                const index = state.currentIndex;
                const now = Date.now();

                // ---- Already reached? Advance ----
                if (state.standReached && state.standReached[index]) {
                    bot.log("Stand waypoint already reached, advancing");
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state._standAttempt = null;
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    delete state.standStartAt?.[index];
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                // ---- If position is unavailable, wait for next tick ----
                if (!position) {
                    scheduleNextTick();
                    return;
                }

                // ---- FLOOR CHECK: if waypoint is on different floor, mark reached ----
                if (waypoint.z !== undefined && waypoint.z !== position.z) {
                    bot.log(`Stand waypoint ${index + 1} is on different floor (${waypoint.z} vs ${position.z}), marking reached`);
                    if (!state.standReached)
                        state.standReached = {};
                    state.standReached[index] = true;
                    delete state.standStartAt?.[index];
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state._standAttempt = null;
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                // ---- WALKABILITY CHECK: if tile is not walkable, mark reached ----
                if (waypoint.x !== undefined && waypoint.y !== undefined && waypoint.z !== undefined) {
                    if (!isTileWalkable(waypoint.x, waypoint.y, waypoint.z, true)) {
                        bot.log(`Stand waypoint ${index + 1} is on non-walkable tile, marking reached`);
                        if (!state.standReached)
                            state.standReached = {};
                        state.standReached[index] = true;
                        delete state.standStartAt?.[index];
                        waypoint = advanceWaypoint();
                        if (!waypoint) {
                            stop();
                            return;
                        }
                        state._standAttempt = null;
                        state.lastWaypointTarget = null;
                        state.pathAttemptStart = 0;
                        state.lastDistanceToWaypoint = null;
                        state.stuckCount = 0;
                        state.positionHistory = [];
                        state.skipAttemptCount = 0;
                        if (waypoint.x !== undefined) {
                            state.lastWaypointTarget = waypoint;
                            state.pathAttemptStart = Date.now();
                            state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                            goToWaypoint(waypoint);
                        }
                        return;
                    }
                }

                // ---- Record start time for this waypoint ----
                if (!state.standStartAt)
                    state.standStartAt = {};
                if (!state.standStartAt[index]) {
                    state.standStartAt[index] = now;
                    bot.log(`Stand waypoint ${index + 1} start timer`);
                }

                // ---- Stuck timeout check ----
                const stuckTimeout = config.stuckTimeoutMs || 5000;
                if (now - state.standStartAt[index] > stuckTimeout) {
                    if (!state.standReached)
                        state.standReached = {};
                    state.standReached[index] = true;
                    delete state.standStartAt[index];
                    bot.log(`Stand waypoint timed out after ${stuckTimeout / 1000}s, advancing`);
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state._standAttempt = null;
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                const dx = Math.abs(position.x - waypoint.x);
                const dy = Math.abs(position.y - waypoint.y);
                const dz = position.z === waypoint.z;
                const dist = Math.max(dx, dy);

                // ---- Exact arrival (on the tile) ----
                if (dx === 0 && dy === 0 && dz) {
                    if (!state.standReached)
                        state.standReached = {};
                    state.standReached[index] = true;
                    delete state.standStartAt[index];
                    state._standAttempt = null;
                    bot.log("Stand waypoint reached (exact tile)");
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                // ---- Adjacent – try to step onto it ----
                if (dist <= 1) {
                    state._standAttempt = {
                        index,
                        adjacentAt: Date.now()
                    };
                    goToWaypoint(waypoint);
                    return;
                }

                // ---- Teleport detection: we were adjacent before, now far away ----
                if (state._standAttempt && state._standAttempt.index === index && dist > 1) {
                    if (!state.standReached)
                        state.standReached = {};
                    state.standReached[index] = true;
                    delete state.standStartAt[index];
                    state._standAttempt = null;
                    bot.log("Stand waypoint reached via teleport");
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                // ---- If not adjacent and not on tile, path to it ----
                if (dist > 1) {
                    goToWaypoint(waypoint);
                    return;
                }

                // Fallback: wait for next tick
                return;
            }

            // ---- ROPE WAYPOINT ----
            if (waypoint && waypoint.rope) {
                const index = state.currentIndex;
                const now = Date.now();

                // ---- TIMEOUT TRACKING ----
                if (!state._ropeStartAt)
                    state._ropeStartAt = {};
                if (!state._ropeStartAt[index])
                    state._ropeStartAt[index] = now;
                const stuckTimeout = config.stuckTimeoutMs || 5000;
                if (now - state._ropeStartAt[index] > stuckTimeout) {
                    bot.log(`Rope waypoint ${index + 1} timed out after ${stuckTimeout / 1000}s – skipping`);
                    if (!state._ropeUsed)
                        state._ropeUsed = {};
                    state._ropeUsed[index] = true;
                    delete state._ropeStartAt[index];
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                }

                // ---- ALREADY USED ROPE ----
                if (state._ropeUsed && state._ropeUsed[index]) {
                    delete state._ropeStartAt[index];
                    bot.log("Rope waypoint already used, advancing");
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state._ropeUsed = undefined;
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                }

                // ---- POSITION CHECK ----
                if (!position) {
                    return;
                }

                // ---- TARGET CHECK: pause if we have a target ----
                //if (_hasTarget()) {
                //    bot.log("Rope waypoint paused – target active");
                //    return;
                //}

                // If the waypoint is on a different floor, skip it
                if (waypoint.z !== position.z) {
                    bot.log("Rope waypoint on different floor, skipping");
                    delete state._ropeStartAt[index];
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                }

                // ---- ADJACENCY CHECK (Chebyshev) ----
                const adj = isAdjacentTile(position, waypoint);

                // If not adjacent, try to move to an adjacent walkable tile
                if (!adj) {
                    // Find the best adjacent walkable tile near the rope spot
                    const adjPos = findAdjacentWalkablePosition(waypoint, position);
                    if (adjPos) {
                        bot.log(`Rope waypoint: moving to adjacent tile (${adjPos.x}, ${adjPos.y}, ${adjPos.z})`);
                        goToPosition(adjPos);
                        return;
                    } else {
                        // Fallback: try to path directly to the rope tile (may get stuck if occupied)
                        bot.log("Rope waypoint: no adjacent walkable tile – pathing to rope tile");
                        goToWaypoint(waypoint);
                        return;
                    }
                }

                // ---- WE ARE ADJACENT (including on tile) – use rope ----
                const tile = getTileAt(waypoint);
                if (!tile) {
                    bot.log("Rope waypoint: tile not loaded");
                    return;
                }

                const ropeSource = findRopeSource();
                if (!ropeSource) {
                    bot.log("Rope waypoint: no rope found, marking as used to proceed");
                    if (!state._ropeUsed)
                        state._ropeUsed = {};
                    state._ropeUsed[index] = true;
                    delete state._ropeStartAt[index];
                    return;
                }

                // Use rope on tile
                try {
                    const source = {
                        which: ropeSource.which,
                        index: ropeSource.index
                    };
                    const target = {
                        which: tile,
                        index: 0xFF
                    };
                    if (window.gameClient?.mouse?.__handleItemUseWith) {
                        window.gameClient.mouse.__handleItemUseWith(source, target);
                        bot.log("Rope waypoint: used rope via mouse.__handleItemUseWith");
                    } else if (window.gameClient?.send && typeof ThingUseWithPacket === 'function') {
                        window.gameClient.send(new ThingUseWithPacket(source, target));
                        bot.log("Rope waypoint: used rope via ThingUseWithPacket");
                    } else {
                        bot.log("Rope waypoint: cannot use rope – no method available");
                    }
                    // Mark as used and advance
                    if (!state._ropeUsed)
                        state._ropeUsed = {};
                    state._ropeUsed[index] = true;
                    delete state._ropeStartAt[index];
                    bot.log("Rope waypoint: rope used, advancing");
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                } catch (e) {
                    bot.log("Rope waypoint: error using rope", e.message);
                    if (!state._ropeUsed)
                        state._ropeUsed = {};
                    state._ropeUsed[index] = true;
                    delete state._ropeStartAt[index];
                    return;
                }
            }

            // ---- SHOVEL WAYPOINT ----
            if (waypoint && waypoint.shovel) {
                const index = state.currentIndex;
                const tileDist = Math.max(Math.abs(position.x - waypoint.x), Math.abs(position.y - waypoint.y));

                // ---- CHECK IF ALREADY ENTERED HOLE (z changed) ----
                if (position.z > waypoint.z) {
                    // Fallen into the hole!
                    if (!state._shovelUsed)
                        state._shovelUsed = {};
                    state._shovelUsed[index] = true;
                    state._shovelOpened = undefined;
                    bot.log("Shovel waypoint: entered hole (z changed), advancing");
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                // ---- STEP 2: HOLE IS OPEN, WALK INTO IT ----
                if (state._shovelOpened && state._shovelOpened[index]) {
                    // If we are already on the hole tile (same z) or z changed (fallen), advance
                    if ((position.z === waypoint.z && tileDist === 0) || position.z < waypoint.z) {
                        bot.log("Shovel waypoint: walked into hole, advancing");
                        state._shovelOpened = undefined;
                        if (!state._shovelUsed)
                            state._shovelUsed = {};
                        state._shovelUsed[index] = true;
                        waypoint = advanceWaypoint();
                        if (!waypoint) {
                            stop();
                            return;
                        }
                        state.lastWaypointTarget = null;
                        state.pathAttemptStart = 0;
                        state.lastDistanceToWaypoint = null;
                        state.stuckCount = 0;
                        state.positionHistory = [];
                        state.skipAttemptCount = 0;
                        if (waypoint.x !== undefined) {
                            state.lastWaypointTarget = waypoint;
                            state.pathAttemptStart = Date.now();
                            state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                            goToWaypoint(waypoint);
                        }
                        return;
                    } else {
                        // Hole is open but we are not on it – walk onto it
                        bot.log("Shovel waypoint: walking into opened hole");
                        goToWaypoint(waypoint);
                        return;
                    }
                }

                // ---- STEP 1: OPEN THE HOLE ----
                if (!position) {
                    return;
                }

                // Floor change check – skip if different floor
                if (position.z !== waypoint.z) {
                    bot.log("Shovel waypoint on different floor, skipping");
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = Date.now();
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }

                // ---- We are ON the target tile – move to adjacent walkable tile ----
                if (tileDist === 0) {
                    const adjPos = findAdjacentWalkablePosition(waypoint, position);
                    if (adjPos) {
                        goToPosition(adjPos);
                        return;
                    } else {
                        bot.log("Shovel waypoint: on target but no adjacent walkable tile, marking as used");
                        if (!state._shovelUsed)
                            state._shovelUsed = {};
                        state._shovelUsed[index] = true;
                        return;
                    }
                }

                // ---- We are ADJACENT (including diagonal) – use shovel ----
                if (tileDist === 1) {
                    // ---- TARGET CHECK: pause if we have a target ----
                    //if (_hasTarget()) {
                    //    //bot.log("Shovel waypoint paused – target active");
                    //     return;
                    //}
                    const tile = getTileAt(waypoint);
                    if (!tile) {
                        bot.log("Shovel waypoint: target tile not loaded");
                        return;
                    }

                    const shovelSource = findShovelSource();
                    if (!shovelSource) {
                        bot.log("Shovel waypoint: no shovel found, marking as used");
                        if (!state._shovelUsed)
                            state._shovelUsed = {};
                        state._shovelUsed[index] = true;
                        return;
                    }

                    const used = useToolOnTile(shovelSource, tile, waypoint, "Shovel waypoint used", now);
                    if (used) {
                        if (!state._shovelOpened)
                            state._shovelOpened = {};
                        state._shovelOpened[index] = true;
                        bot.log("Shovel waypoint: hole opened, walking into it");
                        goToWaypoint(waypoint);
                        return;
                    } else {
                        bot.log("Shovel waypoint: shovel use failed, marking as used");
                        if (!state._shovelUsed)
                            state._shovelUsed = {};
                        state._shovelUsed[index] = true;
                        return;
                    }
                }

                // ---- We are FAR (>1) – move to adjacent walkable tile ----
                if (tileDist > 1) {
                    const adjPos = findAdjacentWalkablePosition(waypoint, position);
                    if (adjPos) {
                        goToPosition(adjPos);
                        return;
                    } else {
                        goToWaypoint(waypoint);
                        return;
                    }
                }
            }

            // ---- LADDER WAYPOINT ----
            if (waypoint && waypoint.ladder) {
                const index = state.currentIndex;
                const now = Date.now();

                // ---- TIMEOUT TRACKING ----
                if (!state._ladderStartAt)
                    state._ladderStartAt = {};
                if (!state._ladderStartAt[index])
                    state._ladderStartAt[index] = now;
                const stuckTimeout = config.stuckTimeoutMs || 5000;
                if (now - state._ladderStartAt[index] > stuckTimeout) {
                    bot.log(`Ladder waypoint ${index + 1} timed out after ${stuckTimeout / 1000}s – skipping`);
                    if (!state._ladderUsed)
                        state._ladderUsed = {};
                    state._ladderUsed[index] = true;
                    delete state._ladderStartAt[index];
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                }

                // ---- ALREADY USED LADDER ----
                if (state._ladderUsed && state._ladderUsed[index]) {
                    delete state._ladderStartAt[index];
                    bot.log("Ladder waypoint already used, advancing");
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state._ladderUsed = undefined;
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                }

                if (!position) {
                    return;
                }

                // ---- TARGET CHECK: pause if we have a target ----
                //if (_hasTarget()) {
                //    bot.log("Ladder waypoint paused – target active");
                //    return;
                //}

                // If the waypoint is on a different floor, skip it
                if (waypoint.z !== position.z) {
                    bot.log("Ladder waypoint on different floor, skipping");
                    delete state._ladderStartAt[index];
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                }

                // ---- ADJACENCY CHECK (Chebyshev) ----
                const adj = isAdjacentTile(position, waypoint);

                // If not adjacent, walk to the ladder tile (pathfinder will get us adjacent)
                if (!adj) {
                    goToWaypoint(waypoint);
                    return;
                }

                // ---- WE ARE ADJACENT (including on tile) – use ladder ----
                const tile = getTileAt(waypoint);
                if (!tile) {
                    bot.log("Ladder waypoint: tile not loaded");
                    return;
                }

                // Use ladder from adjacent tile (or on tile)
                try {
                    if (window.gameClient?.mouse?.use) {
                        window.gameClient.mouse.use({
                            which: tile,
                            index: 0xFF
                        });
                    } else if (window.gameClient?.send && typeof UsePacket === 'function') {
                        window.gameClient.send(new UsePacket(tile, 0xFF));
                    } else {
                        bot.log("Ladder waypoint: cannot use tile – no method available");
                    }
                    // Mark as used and advance
                    if (!state._ladderUsed)
                        state._ladderUsed = {};
                    state._ladderUsed[index] = true;
                    delete state._ladderStartAt[index];
                    bot.log("Ladder waypoint: used ladder, advancing");
                    let nextWp = advanceWaypoint();
                    if (!nextWp) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (nextWp.x !== undefined) {
                        state.lastWaypointTarget = nextWp;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, nextWp);
                        goToWaypoint(nextWp);
                    }
                    return;
                } catch (e) {
                    bot.log("Ladder waypoint: error using ladder", e.message);
                    if (!state._ladderUsed)
                        state._ladderUsed = {};
                    state._ladderUsed[index] = true;
                    delete state._ladderStartAt[index];
                    return;
                }
            }

            // ---- BLACKLIST CHECK ----
            if (position && bot.blacklist?.isBlacklisted(position.x, position.y, position.z)) {
                bot.log("cave: standing on blacklisted tile, moving away");
                const offsets = [[0, -1], [1, 0], [0, 1], [-1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
                for (const [dx, dy] of offsets) {
                    const nx = position.x + dx;
                    const ny = position.y + dy;
                    if (!bot.blacklist.isBlacklisted(nx, ny, position.z) && isTileWalkable(nx, ny, position.z, true)) {
                        const dir = getDirection(dx, dy);
                        if (dir !== null && window.gameClient?.keyboard) {
                            window.gameClient.keyboard.handleMoveKey(dir);
                            return;
                        }
                    }
                }
            }

            // ---- PROGRESS TRACKING ----
            if (positionKey) {
                if (!state.positionHistory)
                    state.positionHistory = [];
                state.positionHistory.push({
                    key: positionKey,
                    time: now
                });
                if (state.positionHistory.length > 5)
                    state.positionHistory.shift();
            }

            // Check if we've moved (new tile) or used a floor change
            let madeProgress = false;
            if (positionKey && positionKey !== state.lastPositionKey) {
                madeProgress = true;
                state.lastPositionKey = positionKey;
                state.lastProgressAt = now;
                state.stuckCount = 0;
                state.positionHistory = [];
            }
            if (now - state.lastStairsUseAt < 2000) {
                madeProgress = true;
                state.lastProgressAt = now;
            }

            // ---- STUCK DETECTION ----
            const stuckTimeout = config.stuckTimeoutMs || 5000;
            if (!madeProgress && (now - state.lastProgressAt) > stuckTimeout) {
                // Only skip if we actually have a waypoint and are not in combat
                const currentWp = getCurrentWaypoint();
                if (currentWp) {
                    bot.log(`Cave: stuck on tile for ${(now - state.lastProgressAt) / 1000}s – skipping to closest waypoint`);
                    const nextWp = skipToClosestWaypoint();
                    if (nextWp) {
                        state.lastProgressAt = now;
                        state._stuckLogged = false;
                        return; // tick will continue on next interval
                    } else {
                        stop();
                        return;
                    }
                }
            }

            // ---- NORMAL NAVIGATION ----
            // waypoint is already defined from above, but it might have been changed by stand block.
            // Ensure it's current.
            waypoint = getCurrentWaypoint();
            // ---- SCRIPT-ONLY WAYPOINT ----
            if (waypoint && waypoint.x === undefined) {
                // Execute script if present
                if (waypoint.script) {
                    try {
                        bot.log(`Executing script for script waypoint ${waypoint.label || 'unnamed'}`);
                        const scriptFn = new Function('bot', 'state', waypoint.script);
                        scriptFn(bot, state);
                    } catch (e) {
                        bot.log(`Script error at script waypoint: ${e.message}`);
                    }
                }
                // Advance to next waypoint immediately
                waypoint = advanceWaypoint();
                if (!waypoint) {
                    stop();
                    return;
                }
                state.lastWaypointTarget = null;
                state.pathAttemptStart = 0;
                state.lastDistanceToWaypoint = null;
                state.stuckCount = 0;
                state.positionHistory = [];
                state.skipAttemptCount = 0;
                // If next waypoint has coordinates, start moving to it
                if (waypoint.x !== undefined) {
                    state.lastWaypointTarget = waypoint;
                    state.pathAttemptStart = Date.now();
                    state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                    goToWaypoint(waypoint);
                }
                // If it's another script-only, the next tick will handle it
                return;
            }
            if (!waypoint) {
                stop();
                return;
            }

            // ---- AT WAYPOINT ----
            if (isAtWaypoint(position, waypoint)) {
                state.lastWaypointTarget = null;
                state.pathAttemptStart = 0;
                state.lastDistanceToWaypoint = null;
                state.stuckCount = 0;
                state.positionHistory = [];
                state.skipAttemptCount = 0;

                // ---- EXECUTE SCRIPT IF PRESENT ----
                if (waypoint.script) {
                    try {
                        bot.log(`Executing script for waypoint ${waypoint.label || waypoint.x + ',' + waypoint.y + ',' + waypoint.z}`);
                        const scriptFn = new Function('bot', 'state', waypoint.script);
                        scriptFn(bot, state);
                    } catch (e) {
                        bot.log(`Script error at waypoint: ${e.message}`);
                    }
                }

                // Advance to next waypoint (normal progression)
                waypoint = advanceWaypoint();
                if (!waypoint) {
                    stop();
                    return;
                }
                state.lastWaypointTarget = waypoint;
                state.pathAttemptStart = now;
                state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                goToWaypoint(waypoint);
                return;
            }

            // ---- FLOOR CHANGE ----
            if (position && waypoint.z !== position.z) {
                if (!config.autoTransitions) {
                    // Auto transitions disabled: skip this waypoint and advance
                    bot.log("Auto transitions disabled, skipping waypoint on different floor", {
                        waypoint
                    });
                    waypoint = advanceWaypoint();
                    if (!waypoint) {
                        stop();
                        return;
                    }
                    state.lastWaypointTarget = null;
                    state.pathAttemptStart = 0;
                    state.lastDistanceToWaypoint = null;
                    state.stuckCount = 0;
                    state.positionHistory = [];
                    state.skipAttemptCount = 0;
                    if (waypoint.x !== undefined) {
                        state.lastWaypointTarget = waypoint;
                        state.pathAttemptStart = now;
                        state.lastDistanceToWaypoint = getDistanceToWaypoint(position, waypoint);
                        goToWaypoint(waypoint);
                    }
                    return;
                }
                // Original floor-change handling
                state.lastWaypointTarget = null;
                state.pathAttemptStart = 0;
                state.lastDistanceToWaypoint = null;
                state.stuckCount = 0;
                state.positionHistory = [];
                state.skipAttemptCount = 0;
                handleFloorChange(waypoint, now);
                return;
            }

            // ---- PATHFINDING / REPATH ----
            const pf = window.gameClient?.world?.pathfinder;
            const currentDist = getDistanceToWaypoint(position, waypoint);

            if (state.lastWaypointTarget === null || !isSameTile(state.lastWaypointTarget, waypoint)) {
                state.lastWaypointTarget = waypoint;
                state.pathAttemptStart = now;
                state.lastDistanceToWaypoint = currentDist;
                state.stuckCount = 0;
                state.positionHistory = [];
                goToWaypoint(waypoint);
                return;
            }

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
        if (state.observerTimerId != null)
            return;
        state.observerTimerId = window.setInterval(() => {
            try {
                observePosition();
            } catch (e) {
                bot.log("cave observer failed", e?.message || e);
            }
        }, 200);
    }

    function stopObserver() {
        if (state.observerTimerId == null)
            return;
        window.clearInterval(state.observerTimerId);
        state.observerTimerId = null;
    }

    // ---- PUBLIC API ----
    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
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
        const pos = normalizePosition(bot.getPlayerPosition());
        state.running = true;
        state.currentIndex = findClosestWaypointIndex(pos);
        state.direction = state.currentIndex >= route.length - 1 ? -1 : 1;
        if (route.length <= 1)
            state.direction = 1;
        state.lastPathAt = 0;
        state.lastPositionKey = getPositionKey(pos);
        state.lastProgressAt = Date.now();
        state.pausedForCombat = false;
        state.pathAttemptStart = 0;
        state.currentIndex = findClosestWaypointIndex(pos);
        if (config.loopMode) {
            state.direction = 1; // always forward when looping
        } else {
            state.direction = state.currentIndex >= route.length - 1 ? -1 : 1;
            if (route.length <= 1)
                state.direction = 1;
        }
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
        if (state.timerId != null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        state.pausedForCombat = false;
        bot.log("cave bot stopped");
        return true;
    }

    function addWaypoint(waypoint) {
        const norm = normalizeWaypoint(waypoint);
        if (!norm)
            return null;
        route.push(norm);
        persistRoute();
        bot.log("cave waypoint added", {
            ...norm,
            total: route.length
        });
        return cloneValue(norm);
    }

    function addWaypointCurrentSpot() {
        const pos = normalizePosition(bot.getPlayerPosition());
        if (!pos) {
            bot.log("could not read current position for cave waypoint");
            return null;
        }
        return addWaypoint(pos);
    }

    function clearWaypoints() {
        route = [];
        state.currentIndex = 0;
        state.direction = 1;
        persistRoute();
        bot.log("cave route cleared");
        if (state.running)
            stop();
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
        if (!route.length)
            return null;
        const removed = route.pop();
        if (state.currentIndex >= route.length)
            state.currentIndex = Math.max(0, route.length - 1);
        if (route.length <= 1)
            state.direction = 1;
        persistRoute();
        bot.log("cave waypoint removed", removed);
        if (!route.length && state.running)
            stop();
        return removed;
    }

    function setCurrentIndex(index) {
        if (!route.length) {
            state.currentIndex = 0;
            state.direction = 1;
            return 0;
        }
        const next = Math.max(0, Math.min(route.length - 1, Math.trunc(Number(index) || 0)));
        state.currentIndex = next;
        state.direction = next >= route.length - 1 ? -1 : 1;
        if (route.length <= 1)
            state.direction = 1;
        return state.currentIndex;
    }

    function status() {
        const pos = normalizePosition(bot.getPlayerPosition());
        const wp = getCurrentWaypoint();
        return {
            running: state.running,
            config: {
                ...config
            },
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
        bot.log("cave config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    // ---- WAYPOINT REORDER/DELETE ----
    function moveWaypointUp(index) {
        if (!route.length || index <= 0 || index >= route.length)
            return false;
        const temp = route[index];
        route[index] = route[index - 1];
        route[index - 1] = temp;
        if (state.currentIndex === index)
            state.currentIndex = index - 1;
        else if (state.currentIndex === index - 1)
            state.currentIndex = index;
        persistRoute();
        return true;
    }

    function moveWaypointDown(index) {
        if (!route.length || index < 0 || index >= route.length - 1)
            return false;
        const temp = route[index];
        route[index] = route[index + 1];
        route[index + 1] = temp;
        if (state.currentIndex === index)
            state.currentIndex = index + 1;
        else if (state.currentIndex === index + 1)
            state.currentIndex = index;
        persistRoute();
        return true;
    }

    function deleteWaypoint(index) {
        if (!route.length || index < 0 || index >= route.length)
            return false;
        route.splice(index, 1);
        if (state.currentIndex >= route.length)
            state.currentIndex = Math.max(0, route.length - 1);
        if (route.length === 0) {
            state.currentIndex = 0;
            state.direction = 1;
            if (state.running)
                stop();
        }
        persistRoute();
        return true;
    }

    function setLoopMode(enabled) {
        config.loopMode = !!enabled;
        persistConfig();
        bot.log("cave loop mode set", {
            loopMode: config.loopMode
        });
        return config.loopMode;
    }

    function getLoopMode() {
        return config.loopMode;
    }

    // ---- INSPECT NEARBY TILES (debug) ----
    function inspectNearbyTiles(radius = 1) {
        const pos = normalizePosition(bot.getPlayerPosition());
        if (!pos)
            return [];
        return getLoadedTiles()
        .map(t => ({
                tile: t,
                position: getTilePosition(t)
            }))
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

    function updateWaypoint(index, updates) {
        if (!route.length || index < 0 || index >= route.length) {
            bot.log("Invalid waypoint index.");
            return null;
        }
        const wp = route[index];
        if (updates.label !== undefined) {
            wp.label = updates.label ? String(updates.label).trim() : undefined;
        }
        if (updates.script !== undefined) {
            wp.script = updates.script ? String(updates.script).trim() : undefined;
        }
        persistRoute();
        bot.log("Waypoint updated", {
            index,
            label: wp.label,
            script: wp.script
        });
        return cloneValue(wp);
    }

    // ---- STARTUP ----
    startObserver();
    bot.addCleanup(stopObserver);
    startMinimapOverlay();
    bot.addCleanup(stopMinimapOverlay);
    if (config.enabled && route.length)
        start();

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
        moveWaypointUp,
        moveWaypointDown,
        deleteWaypoint,
        setLoopMode,
        getLoopMode,
        inspectNearbyTiles,
        isAtWaypoint,
        updateWaypoint,
        mergePresets: mergePresets,
        renamePreset: renamePreset,
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
    const state = {
        running: false,
        timerId: null,
        lastEquipAt: 0
    };
    let resumeListenersAttached = false;

    const config = Object.assign({
        tickMs: 1000,
        equipCooldownMs: 1500,
        enabled: false
    },
            bot.storage.get(configStorageKey, {}));
    config.tickMs = 1000;

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getEquipment() {
        return window.gameClient?.player?.equipment || null;
    }
    function getOpenContainers() {
        return Array.from(window.gameClient?.player?.__openedContainers || []);
    }

    function getItemDefinition(item) {
        if (!item)
            return null;
        return window.gameClient?.itemDefinitionsBySid?.[item.sid] ||
        window.gameClient?.itemDefinitions?.[item.id] || null;
    }

    function getItemName(item) {
        const def = getItemDefinition(item);
        return def?.properties?.name || item?.name || "";
    }

    function isRingItem(item) {
        if (!item)
            return false;
        const def = getItemDefinition(item);
        const slotType = String(def?.properties?.slotType || def?.properties?.slot || "").trim().toLowerCase();
        if (slotType === "ring")
            return true;
        return /\bring\b/i.test(getItemName(item));
    }

    function getEquippedRing() {
        const eq = getEquipment();
        return eq?.getSlotItem?.(RING_SLOT) || null;
    }
    function hasEquippedRing() {
        return !!getEquippedRing();
    }

    function findBestRingSource() {
        const eq = getEquipment();
        if (!eq)
            return null;
        let best = null,
        bestCount = -1;
        const consider = (container, slotIndex, item) => {
            if (!isRingItem(item))
                return;
            const count = (typeof item.getCount === "function" ? item.getCount() : item.count) || 1;
            if (count > bestCount) {
                bestCount = count;
                best = {
                    container,
                    slotIndex,
                    item,
                    count,
                    name: getItemName(item)
                };
            }
        };
        for (let i = 0; i < eq.slots.length; i++) {
            if (i === RING_SLOT)
                continue;
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

    function canEquipRing(now) {
        return getGateStatus(now).canEquip;
    }
    function tryEquipRing(now = Date.now()) {
        if (!config.enabled || !canEquipRing(now))
            return false;
        const eq = getEquipment();
        const source = findBestRingSource();
        if (!eq || !source)
            return false;
        const from = {
            which: source.container,
            index: source.slotIndex
        };
        const to = {
            which: eq,
            index: RING_SLOT
        };
        const count = source.count || 1;
        window.gameClient.send(new ItemMovePacket(from, to, count));
        state.lastEquipAt = now;
        bot.log("equipped ring", {
            name: source.name,
            fromContainerId: source.container?.__containerId ?? null,
            fromSlot: source.slotIndex
        });
        return true;
    }

    // ---- Resume listeners (boilerplate) ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }
    function runImmediateTick() {
        if (!state.running)
            return;
        if (state.timerId != null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        tick();
    }
    function handleResume() {
        if (!document.hidden)
            runImmediateTick();
    }

    function attachResumeListeners() {
        if (resumeListenersAttached)
            return;
        document.addEventListener("visibilitychange", handleResume);
        window.addEventListener("focus", handleResume);
        window.addEventListener("pageshow", handleResume);
        resumeListenersAttached = true;
    }
    function detachResumeListeners() {
        if (!resumeListenersAttached)
            return;
        document.removeEventListener("visibilitychange", handleResume);
        window.removeEventListener("focus", handleResume);
        window.removeEventListener("pageshow", handleResume);
        resumeListenersAttached = false;
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryEquipRing();
        } catch (e) {
            bot.log("equip ring tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        config.tickMs = 1000;
        persistConfig();
        if (state.running) {
            bot.log("equip ring already running");
            return false;
        }
        state.running = true;
        attachResumeListeners();
        bot.log("equip ring started", {
            ...config
        });
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
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("equip ring stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            gates: getGateStatus(),
            equippedRing: getEquippedRing(),
            lastEquipAt: state.lastEquipAt,
        };
    }

    function updateConfig(nextConfig = {}) {
        Object.assign(config, nextConfig);
        config.tickMs = 1000;
        persistConfig();
        bot.log("equip ring config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

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

/**
 * ==================================================================================
 * 12. AUTO EAT MODULE
 *     Uses a hotbar slot when the food timer reaches 0 (or no SATED condition).
 * ==================================================================================
 */
window.__minibiaBotBundle.installAutoEatModule = function installAutoEatModule(bot) {
    const configStorageKey = "minibiaBot.eat.config";
    const state = {
        running: false,
        timerId: null,
        lastFoodAt: 0
    };

    const config = Object.assign({
        tickMs: 1000,
        eatCooldownMs: 60000,
        eatHotbarSlot: 10,
        enabled: false,
    },
            bot.storage.get(configStorageKey, {}));
    config.tickMs = 1000;

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function normalizeHotbarSlot(slot) {
        const v = Number(slot);
        if (!Number.isFinite(v))
            return null;
        const n = Math.trunc(v);
        if (n < 1 || n > 12)
            return null;
        return n;
    }

    // ---- Improved food timer reader ----
    function readFoodTimer() {
        // 1) Try internal skill-window property (updated by FOOD_TIMER packet)
        try {
            const skillWin = window.gameClient?.interface?.windowManager?.getWindow?.("skill-window");
            if (skillWin) {
                // Method
                if (typeof skillWin.getFoodTimer === 'function') {
                    const val = skillWin.getFoodTimer();
                    if (typeof val === 'number' && val >= 0) {
                        return {
                            source: 'skillWin.getFoodTimer()',
                            seconds: val
                        };
                    }
                }
                // Property
                if (typeof skillWin.foodTimer === 'number' && skillWin.foodTimer >= 0) {
                    return {
                        source: 'skillWin.foodTimer',
                        seconds: skillWin.foodTimer
                    };
                }
            }
        } catch (e) { /* ignore */
        }

        // 2) Try DOM selector
        const el = document.querySelector('#skill-window div[skill="food"] .skill');
        if (el) {
            const text = el.textContent?.trim() || null;
            if (text) {
                const match = text.match(/^(\d{1,2}):(\d{2})$/);
                if (match) {
                    const seconds = Number(match[1]) * 60 + Number(match[2]);
                    return {
                        source: 'DOM',
                        seconds
                    };
                }
                return {
                    source: 'DOM',
                    seconds: null
                };
            }
        }

        // 3) If all fails, return null
        return null;
    }

    function isSated() {
        // ---- 1) Read food timer ----
        const food = readFoodTimer();
        if (food && food.seconds !== undefined && food.seconds !== null) {
            const sated = food.seconds > 0;
            // Log once per minute if we are using a non‑zero timer to see what's happening
            if (sated && food.seconds < 30) {
                // If timer says we have less than 30 seconds, we should be considered hungry,
                // but the bot may not eat because it thinks we are sated. We'll force hunger
                // if the timer is < 30 seconds to trigger eating earlier.
                // Actually, we want to eat when timer is 0, not before. So keep as is.
            }
            return sated;
        }

        // ---- 2) Fallback to condition check ----
        const player = window.gameClient?.player;
        if (player?.conditions) {
            const satedId = window.ConditionManager?.prototype?.SATED;
            if (satedId !== undefined && player.conditions.has) {
                return player.conditions.has(satedId);
            }
        }

        // ---- 3) If we can't determine, assume hungry ----
        return false;
    }

    function tryEat() {
        if (!config.enabled) {
            bot.log("Eat: disabled");
            return false;
        }
        if (isSated()) {
            // Log only once in a while to avoid spam
            if (!tryEat._lastLoggedSated || Date.now() - tryEat._lastLoggedSated > 30000) {
                tryEat._lastLoggedSated = Date.now();
                const food = readFoodTimer();
                bot.log("Eat: isSated() true, not eating. Food timer:", food);
            }
            return false;
        }
        if (Date.now() - state.lastFoodAt < config.eatCooldownMs) {
            return false;
        }
        const slot = normalizeHotbarSlot(config.eatHotbarSlot);
        if (!slot) {
            bot.log("Eat: invalid hotbar slot", config.eatHotbarSlot);
            return false;
        }
        const clicked = bot.clickHotbar(slot - 1);
        if (clicked) {
            state.lastFoodAt = Date.now();
            bot.log("used eat hotkey", {
                slot
            });
        } else {
            bot.log("Eat: clickHotbar failed for slot", slot);
        }
        return clicked;
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => tick(), config.tickMs);
    }

    function tick() {
        if (!state.running)
            return;
        try {
            tryEat();
        } catch (e) {
            bot.log("auto eat tick failed", e?.message || e);
        } finally {
            scheduleNextTick();
        }
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        config.tickMs = 1000;
        persistConfig();
        if (state.running) {
            bot.log("auto eat already running");
            return false;
        }
        state.running = true;
        bot.log("auto eat started", {
            eatCooldownMs: config.eatCooldownMs,
            eatHotbarSlot: config.eatHotbarSlot
        });
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
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("auto eat stopped");
        return true;
    }

    function status() {
        const food = readFoodTimer();
        return {
            running: state.running,
            config: {
                ...config
            },
            lastFoodAt: state.lastFoodAt,
            isSated: isSated(),
            foodTimer: food,
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
        bot.log("auto eat config updated", {
            ...config
        });
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

    bot.eat = {
        start,
        stop,
        status,
        updateConfig,
        isSated,
        tryEat,
        normalizeHotbarSlot,
        readFoodTimer,
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
/**
 * ==================================================================================
 * FIXES:
 * 1. Greetings bypass Gemini entirely – uses canned replies.
 * 2. SanitizeReply now detects and cleans up multiple greetings.
 * 3. Fallback is more aggressive for low-quality responses.
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

    const config = Object.assign({
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
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function normalizeText(value) {
        return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    }

    function sanitizeConfig() {
        config.apiKey = String(config.apiKey || "").trim();
        config.model = String(config.model || defaultModel).trim() || defaultModel;
        if (legacyDefaultModels.includes(config.model))
            config.model = defaultModel;
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
        if (state.seenKeys.length > maxSeen)
            state.seenKeys = state.seenKeys.slice(-maxSeen);
        if (state.seenSignatures.length > maxSeen)
            state.seenSignatures = state.seenSignatures.slice(-maxSeen);
    }

    function getSelfNames() {
        return new Set(["you", bot.getPlayerName?.(), window.gameClient?.player?.name, window.gameClient?.player?.state?.name]
            .map(n => normalizeText(n)).filter(Boolean));
    }

    function extractSenderFromMessage(message) {
        const text = String(message || "").trim();
        if (!text)
            return {
                sender: null,
                body: ""
            };
        const patterns = [
            /^\[[^\]]+\]\s*([^:\n]{2,40}):\s+(.+)$/i,
            /^([^:\n]{2,40}):\s+(.+)$/i,
            /^([^:\n]{2,40})\s+says:\s+(.+)$/i,
            /^From\s+([^:\n]{2,40}):\s+(.+)$/i,
        ];
        for (const p of patterns) {
            const m = text.match(p);
            if (m)
                return {
                    sender: String(m[1] || "").trim() || null,
                    body: String(m[2] || "").trim()
                };
        }
        return {
            sender: null,
            body: text
        };
    }

    function getRawChatEntries() {
        return (window.gameClient?.interface?.channelManager?.channels || [])
        .flatMap(ch => (ch?.__contents || []).map((entry, i) => ({
                    channelName: ch?.name || null,
                    entry,
                    index: i
                })));
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
        return {
            key,
            channelName: rawEntry?.channelName || null,
            sender,
            body,
            rawMessage: raw,
            time,
            senderType
        };
    }

    function getChatMessages() {
        return getRawChatEntries().map(toChatMessage).filter(m => m.body);
    }

    function getMessageTimestamp(message) {
        const raw = message?.time;
        if (typeof raw === "number" && Number.isFinite(raw))
            return raw < 1e12 ? raw * 1000 : raw;
        if (raw instanceof Date)
            return raw.getTime();
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
        if (!message)
            return;
        if (message.key && !state.seenKeys.includes(message.key))
            state.seenKeys.push(message.key);
        const sig = getMessageSignature(message);
        if (sig && !state.seenSignatures.includes(sig))
            state.seenSignatures.push(sig);
        trimSeen();
    }

    function rememberSeenMessages(messages) {
        messages.forEach(m => rememberSeenMessage(m));
    }

    function isSelfMessage(message) {
        if (getSelfNames().has(normalizeText(message?.sender)))
            return true;
        return [message?.body, message?.rawMessage].some(t => bot.isRecentSentChat?.(t, 20000));
    }

    function isTrustedSender(message) {
        const name = normalizeText(message?.sender);
        if (!name)
            return false;
        const trusted = bot.panic?.getTrustedNames?.() || [];
        return trusted.includes(name);
    }

    function isNpcMessage(message) {
        const npcType = window.CONST?.TYPES?.NPC;
        return npcType != null && message?.senderType === npcType;
    }

    function isWithinVisibleRange(me, pos) {
        if (!me || !pos)
            return false;
        const dx = Math.abs(pos.x - me.x),
        dy = Math.abs(pos.y - me.y);
        return dx <= 8 && dy <= 6;
    }

    function isSenderVisiblePlayer(message) {
        const me = bot.getPlayerPosition?.();
        const myId = window.gameClient?.player?.id;
        const sender = normalizeText(message?.sender);
        const playerType = window.CONST?.TYPES?.PLAYER;
        if (!me || !sender || playerType == null)
            return false;
        return Object.values(window.gameClient?.world?.activeCreatures || {}).some(creature => {
            if (!creature || creature.id === myId || creature.type !== playerType)
                return false;
            if (normalizeText(creature.name) !== sender)
                return false;
            return isWithinVisibleRange(me, creature.__position);
        });
    }

    function getDefaultMessages() {
        return getChatMessages().filter(m => m.channelName === "Default");
    }

    function getNewestPendingMessage() {
        const pending = getDefaultMessages().filter(message => {
            if (!message?.body || !message?.key)
                return false;
            if (hasSeenMessage(message))
                return false;

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
        if (!pending.length)
            return null;
        return {
            targetMessage: pending[pending.length - 1],
            pendingMessages: pending
        };
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
        if (messageType === "greeting")
            return config.greetingPrompt;
        if (messageType === "question")
            return config.questionPrompt;
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
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": config.apiKey
            },
            body: JSON.stringify({
                contents: [{
                        role: "user",
                        parts: [{
                                text: prompt
                            }
                        ]
                    }
                ],
                generationConfig: Object.assign({
                    temperature: 0.9,
                    topP: 0.95,
                    maxOutputTokens: 40
                }, generationConfig),
            }),
        });
        if (!resp.ok)
            throw new Error(`Gemini request failed (${resp.status}): ${await resp.text()}`);
        const data = await resp.json();
        return data?.candidates?.[0]?.content?.parts?.map(p => String(p?.text || "")).join(" ").trim() || "";
    }

    async function classifyMessageType(targetMessage, contextMessages) {
        const raw = normalizeText(
                await generateText(buildClassifierPrompt(targetMessage, contextMessages), {
                    temperature: 0.1,
                    topP: 0.8,
                    maxOutputTokens: 8,
                }));
        if (raw === "greeting" || raw === "question" || raw === "statement")
            return raw;
        if (isGreeting(targetMessage?.body))
            return "greeting";
        if (/\?/.test(String(targetMessage?.body || "")))
            return "question";
        return "statement";
    }

    /**
     * FIX: Improved sanitizer – detects multiple greetings and reduces to one.
     * Also strips any text that looks like a bot disclaimer.
     */
    function sanitizeReply(text) {
        const single = String(text || "")
            .replace(/\s+/g, " ")
            .replace(/^["'`]+|["'`]+$/g, "")
            .trim();
        if (!single)
            return "";

        // Take the first sentence (split by . ! ?)
        const first = single.split(/(?<=[.!?])\s+/)[0] || single;
        let trimmed = first.slice(0, 90).trim();
        if (!trimmed)
            return "";

        // ---- FIX: detect multiple greetings ----
        const greetingWords = ["yo", "hey", "hi", "sup", "hiya", "hello", "howdy", "heya"];
        const words = trimmed.split(/\s+/);
        const greetings = words.filter(w => greetingWords.includes(w.toLowerCase().replace(/[^a-z]/g, "")));
        if (greetings.length > 1) {
            // Keep only the first greeting word + maybe a single following word if it's "lol"
            let firstGreeting = greetings[0];
            // Check if the reply starts with a greeting, but has extra words
            // We'll just return the first greeting word, or "yo" as fallback.
            return firstGreeting || "yo";
        }

        // If the entire reply is just a single greeting word, keep it.
        const cleanLower = trimmed.toLowerCase().replace(/[^a-z]/g, "");
        if (greetingWords.includes(cleanLower)) {
            return trimmed; // keep as-is (e.g., "yo", "hey")
        }

        // ---- General cleanup ----
        const styled = trimmed
            .toLowerCase()
            .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
            .replace(/\bi am\b/g, "im").replace(/\byou are\b/g, "youre")
            .replace(/\bdo not\b/g, "dont").replace(/\bcannot\b/g, "cant")
            .replace(/\bgoing to\b/g, "gonna").replace(/\bwant to\b/g, "wanna")
            .replace(/\s+([,.!?])/g, "$1").replace(/([!?.,]){2,}/g, "$1")
            .trim();

        if (!styled || /^[^a-z0-9]+$/i.test(styled))
            return "";
        if (/\b(bot|ai|assistant|language model|automation|script)\b/i.test(styled))
            return "";
        if (bot.isRecentSentChat?.(styled, 20000))
            return "";
        return styled;
    }

    function pickUnusedReply(replies, withinMs = 30000, fallback = "?") {
        for (const r of replies) {
            if (!bot.isRecentSentChat?.(r, withinMs))
                return r;
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
        if (isBotQuestion(msg))
            return pickUnusedReply(denyBotReplies, 30000, "no");
        if (messageType === "greeting" || isGreeting(msg))
            return pickUnusedReply(greetingReplies, 15000, "yo");
        if (isSimpleReaction(msg))
            return pickUnusedReply(agreeReplies, 15000, "true");
        if (messageType === "question" || /\?$/.test(msg))
            return pickUnusedReply(vagueQuestionReplies, 20000, "maybe");
        return pickUnusedReply(["lol", "maybe", "ya", "true", "kinda"], 30000, "lol");
    }

    async function maybeRespond() {
        if (!state.running || state.pending || !config.enabled || !config.apiKey)
            return false;
        if (Date.now() - state.lastReplyAt < config.replyCooldownMs)
            return false;
        const pending = getNewestPendingMessage();
        if (!pending?.targetMessage)
            return false;
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

            // ---- Classify ----
            const type = await classifyMessageType(pending.targetMessage, context);
            let reply;

            // ---- FIX: skip Gemini for greetings and bot questions ----
            if (isBotQuestion(pending.targetMessage.body)) {
                reply = "no";
            } else if (type === "greeting" || isGreeting(pending.targetMessage.body)) {
                // Use canned greeting only – no AI
                reply = pickFallbackReply(pending.targetMessage, "greeting");
            } else {
                const rawReply = await generateText(buildReplyPrompt(pending.targetMessage, context, type));
                reply = sanitizeReply(rawReply) || pickFallbackReply(pending.targetMessage, type);
            }

            rememberSeenMessages(pending.pendingMessages);

            // ---- Extra safety: if reply is still a mashup, fallback ----
            if (reply) {
                const words = reply.split(/\s+/);
                const greetings = words.filter(w => ["yo", "hey", "hi", "sup", "hiya", "hello", "howdy"].includes(w.toLowerCase().replace(/[^a-z]/g, "")));
                if (greetings.length > 1) {
                    reply = greetings[0];
                }
            }

            if (!reply) {
                bot.log("talk skipped reply (empty after sanitize)", {
                    sender: pending.targetMessage.sender,
                    message: pending.targetMessage.body,
                    messageType: type,
                });
                return false;
            }

            const sent = bot.sendChat(reply);
            if (sent) {
                state.lastReplyAt = Date.now();
                bot.log("talk replied", {
                    sender: pending.targetMessage.sender,
                    message: pending.targetMessage.body,
                    messageType: type,
                    reply,
                });
            }
            return sent;
        } finally {
            state.pending = false;
        }
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(async() => {
            try {
                await maybeRespond();
            } catch (e) {
                bot.log("talk request failed", e?.message || e);
            }
            scheduleNextTick();
        }, config.pollMs);
    }

    function seedSeenMessages() {
        rememberSeenMessages(getDefaultMessages());
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        sanitizeConfig();
        persistConfig();
        if (!config.apiKey) {
            bot.log("talk module requires a Gemini API key");
            return false;
        }
        if (state.running)
            return false;
        state.running = true;
        seedSeenMessages();
        bot.log("talk module started", {
            model: config.model,
            channel: "Default"
        });
        scheduleNextTick();
        return true;
    }

    function stop(options = {}) {
        const shouldPersist = options.persistEnabled !== false;
        state.running = false;
        if (shouldPersist) {
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
                apiKey: config.apiKey ? "***configured***" : ""
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
    if (config.enabled && config.apiKey)
        start();

    bot.talk = {
        start,
        stop,
        status,
        updateConfig,
        getChatMessages,
        config,
    };
};

window.__minibiaBotBundle.installMessageAlertModule = function installMessageAlertModule(bot) {
    const configStorageKey = "minibiaBot.messageAlert.config";
    const state = {
        running: false,
        timerId: null,
        seenKeys: new Set(),
    };

    const config = Object.assign({
        enabled: false
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            enabled: config.enabled
        });
    }

    function normalizeText(text) {
        return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    }

    function getSelfNames() {
        return new Set([
                "you",
                bot.getPlayerName?.(),
                window.gameClient?.player?.name,
                window.gameClient?.player?.state?.name,
            ].map(n => normalizeText(n)).filter(Boolean));
    }

    function getChatMessages() {
        const channels = gameClient.interface.channelManager.channels || [];
        const targetNames = ["Default"];
        const all = [];
        for (const ch of channels) {
            if (!ch?.__contents)
                continue;
            const name = ch.name || ch.__name || "";
            if (!targetNames.includes(name))
                continue;
            for (const entry of ch.__contents) {
                const raw = String(entry?.message || entry?.text || "").trim();
                if (!raw)
                    continue;

                // Try multiple properties to find the sender
                let sender = entry?.author || entry?.sender || entry?.name || entry?.from || entry?.character || null;

                // If still null, attempt to extract from raw using regex (some messages include sender)
                if (!sender) {
                    const match = raw.match(/^([^:\n]{2,40}):\s+(.+)$/);
                    if (match) {
                        sender = match[1].trim();
                        // body already is raw, but we can update body to the stripped version
                        // but we keep raw as full message; we'll set body to the part after colon
                    }
                }

                // If still null, skip (can't identify who sent it)
                if (!sender)
                    continue;

                const body = raw; // keep full raw for now, but we could strip sender if extracted
                const key = [name, sender, body, entry?.__time || ""].join("|");
                all.push({
                    key,
                    channelName: name,
                    sender,
                    body,
                    rawMessage: raw,
                    time: entry?.__time
                });
            }
        }
        return all;
    }

    function isSelfMessage(message) {
        return getSelfNames().has(normalizeText(message?.sender)) ||
        bot.isRecentSentChat?.(message?.body, 20000) ||
        bot.isRecentSentChat?.(message?.rawMessage, 20000);
    }

    function getNewMessages() {
        const all = getChatMessages();
        const newMessages = [];

        // ---- Get ignored phrases from talk module, or fallback to hardcoded ----
        let ignoreWords = ["Munch.", "Chomp.", "Gulp.", "Slurp."];
        try {
            const talkIgnored = bot.talk?.config?.ignoredPhrases;
            if (Array.isArray(talkIgnored) && talkIgnored.length) {
                ignoreWords = talkIgnored.map(w => String(w).trim()).filter(Boolean);
            }
        } catch (e) { /* ignore */
        }

        for (const msg of all) {
            if (state.seenKeys.has(msg.key))
                continue;
            state.seenKeys.add(msg.key);
            if (isSelfMessage(msg))
                continue;
            const upper = msg.body.toUpperCase();
            // Skip if body contains any ignored phrase (case‑insensitive)
            if (ignoreWords.some(word => upper.includes(word.toUpperCase())))
                continue;
            newMessages.push(msg);
        }

        if (state.seenKeys.size > 500) {
            const arr = Array.from(state.seenKeys);
            state.seenKeys = new Set(arr.slice(-300));
        }
        return newMessages;
    }

    function checkForNewMessages() {
        if (!config.enabled || !state.running)
            return;
        const newMsgs = getNewMessages();
        if (!newMsgs.length)
            return;

        //console.log("[MessageAlert] New messages:", newMsgs.map(m => `${m.sender}: ${m.body}`));
        if (typeof bot.playMessageAlarm === 'function') {
            bot.playMessageAlarm();
            //bot.log("New message alert", { count: newMsgs.length, sample: newMsgs[0].sender + ": " + newMsgs[0].body });
        } else {
            console.error("[MessageAlert] bot.playMessageAlarm is not defined!");
        }
    }

    function tick() {
        if (!state.running)
            return;
        try {
            checkForNewMessages();
        } catch (e) {
            bot.log("Message alert error", e);
        }
        state.timerId = setTimeout(tick, 2000);
    }

    function start() {
        if (state.running)
            return false;
        config.enabled = true;
        persistConfig();
        state.running = true;
        // Pre-seed seen messages
        const existing = getChatMessages();
        existing.forEach(m => state.seenKeys.add(m.key));
        bot.log("Message alert monitor started");
        tick();
        return true;
    }

    function stop() {
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        config.enabled = false;
        persistConfig();
        bot.log("Message alert monitor stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            }
        };
    }

    // Public API — expose checkForNewMessages for manual testing
    if (config.enabled)
        start();

    bot.messageAlert = {
        start,
        stop,
        status,
        checkForNewMessages, // <-- now exposed
        config,
    };
};

//*********************
// -- ANTI-BOT ALARM
//*********************

window.__minibiaBotBundle.installAntiBotMonitorModule = function installAntiBotMonitorModule(bot) {
    const configStorageKey = "minibiaBot.antibot.config";
    const state = {
        running: false,
        timerId: null,
        lastTriggerAt: 0,
        cooldownMs: 30000,
    };

    // Load persisted config
    const config = Object.assign({
        enabled: false
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            enabled: config.enabled
        });
    }

    function start() {
        if (state.running)
            return;
        config.enabled = true;
        persistConfig();
        state.running = true;
        bot.log("Anti-Bot monitor started");
        checkChat();
        // Update UI checkbox if exists
        const toggle = document.getElementById("minibia-bot-antibot-enabled");
        if (toggle)
            toggle.checked = true;
    }

    function stop() {
        if (!state.running)
            return;
        config.enabled = false;
        persistConfig();
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        bot.log("Anti-Bot monitor stopped");
        // Update UI checkbox if exists
        const toggle = document.getElementById("minibia-bot-antibot-enabled");
        if (toggle)
            toggle.checked = false;
    }

    function checkChat() {
        if (!state.running)
            return;

        try {
            const channels = window.gameClient?.interface?.channelManager?.channels || [];
            const consoleChannel = channels.find(ch => ch?.name === "Console");
            if (!consoleChannel) {
                scheduleNext();
                return;
            }

            const contents = consoleChannel.__contents || [];
            const now = Date.now();

            for (const entry of contents) {
                const message = String(entry?.message || "").toLowerCase();
                if (message.includes("bot")) {
                    const time = entry?.__time ? new Date(entry.__time).getTime() : 0;
                    if (time && now - time > 5000)
                        continue;
                    if (now - state.lastTriggerAt > state.cooldownMs) {
                        state.lastTriggerAt = now;
                        bot.playAntiBotAlarm?.();
                        bot.log("Anti-Bot check triggered", {
                            message
                        });
                        break;
                    }
                }
            }
        } catch (e) {
            bot.log("Anti-Bot monitor error", e);
        }

        scheduleNext();
    }

    function scheduleNext() {
        if (!state.running)
            return;
        state.timerId = setTimeout(checkChat, 2000);
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            }
        };
    }

    // ---- Auto-start if enabled ----
    if (config.enabled) {
        start();
    }

    // ---- Public API ----
    bot.antiBotMonitor = {
        start,
        stop,
        status,
        config,
    };
};

window.__minibiaBotBundle.installSlimeTrainerModule = function installSlimeTrainerModule(bot) {
    const configStorageKey = "minibiaBot.slimeTrainer.config";
    const state = {
        running: false,
        timerId: null,
        lastAttackAt: 0,
        captureMode: false,
    };

    const config = Object.assign({
        enabled: false,
        motherSlimeId: null,
        motherSlimeName: null,
        tickMs: 300,
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getPlayerPosition() {
        return bot.getPlayerPosition();
    }

    function getVisibleMonsters() {
        let allCreatures = bot.xray?.getVisibleCreatures?.() || [];
        if (!allCreatures.length) {
            const active = window.gameClient?.world?.activeCreatures || {};
            allCreatures = Object.values(active);
        }
        const me = bot.getPlayerPosition();
        if (!me)
            return [];

        return allCreatures.filter(c => {
            const pos = c.__position || c.getPosition?.();
            if (!pos || pos.z !== me.z)
                return false;
            if (c.id === window.gameClient?.player?.id)
                return false;
            return true;
        });
    }

    function isAdjacentTile(pos1, pos2) {
        if (!pos1 || !pos2 || pos1.z !== pos2.z)
            return false;
        return Math.abs(pos1.x - pos2.x) <= 1 && Math.abs(pos1.y - pos2.y) <= 1;
    }

    function attackCreature(creature) {
        if (!creature)
            return false;
        try {
            window.gameClient.player.setTarget(creature);
            window.gameClient.send(new TargetPacket(creature.id));
            state.lastAttackAt = Date.now();
            return true;
        } catch (e) {
            // fallback to hotbar target if available
            try {
                const slot = bot.attack?.config?.targetHotbarSlot || 3;
                const clicked = bot.clickHotbar(slot - 1);
                if (clicked) {
                    state.lastAttackAt = Date.now();
                    return true;
                }
            } catch (e2) {
                bot.log("Slime trainer: attack failed", e2);
            }
            return false;
        }
    }

    function startCaptureMotherSlime() {
        if (state.captureMode)
            return;
        state.captureMode = true;
        bot.log("Slime trainer: click on the Mother Slime to select it, or target it first.");

        const handler = (event) => {
            let creature = null;

            try {
                const worldObject = window.gameClient.mouse.getWorldObject(event);
                if (worldObject && worldObject.which) {
                    if (worldObject.which.constructor.name === "Creature") {
                        creature = worldObject.which;
                    } else if (worldObject.which.constructor.name === "Tile") {
                        const tile = worldObject.which;
                        const pos = tile.getPosition();
                        const creatures = Object.values(window.gameClient.world.activeCreatures || {});
                        for (const c of creatures) {
                            const cPos = c.getPosition?.() || c.__position;
                            if (cPos && cPos.x === pos.x && cPos.y === pos.y && cPos.z === pos.z) {
                                creature = c;
                                break;
                            }
                        }
                    }
                }
            } catch (e) {}

            if (!creature) {
                try {
                    const worldPos = window.gameClient.renderer.screen.getWorldCoordinates(event);
                    if (worldPos && worldPos.__position) {
                        const pos = worldPos.__position;
                        const creatures = Object.values(window.gameClient.world.activeCreatures || {});
                        for (const c of creatures) {
                            const cPos = c.getPosition?.() || c.__position;
                            if (cPos && cPos.x === pos.x && cPos.y === pos.y && cPos.z === pos.z) {
                                creature = c;
                                break;
                            }
                        }
                    }
                } catch (e) {}
            }

            if (!creature) {
                try {
                    const currentTarget = window.gameClient.player.getTarget();
                    if (currentTarget && currentTarget.constructor.name === "Creature") {
                        creature = currentTarget;
                    }
                } catch (e) {}
            }

            if (!creature) {
                bot.log("No creature found. Try clicking directly on the creature or target it first.");
                return;
            }

            config.motherSlimeId = creature.id;
            config.motherSlimeName = creature.name || "Mother Slime";
            persistConfig();
            bot.log(`Mother Slime set: ${config.motherSlimeName} (ID: ${config.motherSlimeId})`);
            state.captureMode = false;
            document.removeEventListener("click", handler, true);
            if (typeof bot.ui?.refreshSlimeTrainerStatus === "function") {
                bot.ui.refreshSlimeTrainerStatus();
            }
        };

        document.addEventListener("click", handler, true);
    }

    function tick() {
        if (!state.running || !config.enabled) {
            scheduleNextTick();
            return;
        }

        const playerPos = getPlayerPosition();
        if (!playerPos) {
            scheduleNextTick();
            return;
        }

        const monsters = getVisibleMonsters();
        const motherId = config.motherSlimeId;

        // Exclude ONLY the mother slime – attack ANY other monster that is adjacent
        const candidates = monsters.filter(c => c.id !== motherId);

        if (!candidates.length) {
            scheduleNextTick();
            return;
        }

        const adjacent = candidates.filter(c => {
            const pos = c.__position || c.getPosition?.();
            if (!pos)
                return false;
            return isAdjacentTile(playerPos, pos);
        });

        if (!adjacent.length) {
            scheduleNextTick();
            return;
        }

        const target = adjacent[0];
        attackCreature(target);

        scheduleNextTick();
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(tick, config.tickMs);
    }

    function start() {
        if (state.running)
            return false;
        config.enabled = true;
        persistConfig();
        state.running = true;
        bot.log("Slime trainer started");
        tick();
        return true;
    }

    function stop(options = {}) {
        const shouldPersist = options.persistEnabled !== false;
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("Slime trainer stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            motherSlimeId: config.motherSlimeId,
            motherSlimeName: config.motherSlimeName,
        };
    }

    function updateConfig(next) {
        Object.assign(config, next);
        persistConfig();
        if (config.enabled && !state.running)
            start();
        if (!config.enabled && state.running)
            stop();
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

    bot.slimeTrainer = {
        start,
        stop,
        status,
        updateConfig,
        startCaptureMotherSlime,
        config,
    };
};

// Light hack

window.__minibiaBotBundle.installLightHackModule = function installLightHackModule(bot) {
    const configStorageKey = "minibiaBot.lightHack.config";
    const state = {
        enabled: false,
        originalIsLightingEnabled: null,
        patched: false,
    };

    const config = Object.assign({
        enabled: false
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getSettings() {
        return window.gameClient?.interface?.settings || null;
    }

    function patch() {
        if (state.patched)
            return true;
        const settings = getSettings();
        if (!settings || typeof settings.isLightingEnabled !== "function") {
            return false;
        }

        // Save original if not already saved
        if (state.originalIsLightingEnabled === null) {
            state.originalIsLightingEnabled = settings.isLightingEnabled.bind(settings);
        }

        // Override the instance method
        settings.isLightingEnabled = function () {
            return false;
        };

        // Also patch the prototype for any new instances (e.g., after a reload)
        const proto = Object.getPrototypeOf(settings);
        if (proto && typeof proto.isLightingEnabled === "function" && !proto.__minibia_light_hack_patched) {
            proto.__minibia_light_hack_original = proto.isLightingEnabled;
            proto.isLightingEnabled = function () {
                return false;
            };
            proto.__minibia_light_hack_patched = true;
        }

        state.patched = true;
        bot.log("LightHack: patched settings.isLightingEnabled");
        forceRender();
        return true;
    }

    function restore() {
        if (!state.patched)
            return;
        const settings = getSettings();
        if (settings && state.originalIsLightingEnabled !== null) {
            settings.isLightingEnabled = state.originalIsLightingEnabled;
        }
        // Restore prototype if we patched it
        const proto = Object.getPrototypeOf(settings);
        if (proto && proto.__minibia_light_hack_original) {
            proto.isLightingEnabled = proto.__minibia_light_hack_original;
            delete proto.__minibia_light_hack_original;
            delete proto.__minibia_light_hack_patched;
        }
        state.patched = false;
        bot.log("LightHack: restored original isLightingEnabled");
        forceRender();
    }

    function forceRender() {
        try {
            const gc = window.gameClient;
            if (gc && typeof gc.render === "function")
                gc.render();
            if (gc && gc.renderer && typeof gc.renderer.render === "function")
                gc.renderer.render();
            const canvas = document.querySelector("canvas#screen");
            if (canvas) {
                const w = canvas.width,
                h = canvas.height;
                canvas.width = w + 1;
                canvas.height = h + 1;
                setTimeout(() => {
                    canvas.width = w;
                    canvas.height = h;
                }, 10);
            }
        } catch (e) {
            bot.log("LightHack: forceRender failed", e);
        }
    }

    function ensurePatched() {
        if (state.patched)
            return;
        if (!patch()) {
            // Retry if settings not ready yet
            setTimeout(ensurePatched, 500);
        }
    }

    function start() {
        if (config.enabled)
            return false;
        config.enabled = true;
        persistConfig();
        ensurePatched();
        bot.log("LightHack enabled");
        return true;
    }

    function stop() {
        if (!config.enabled)
            return false;
        config.enabled = false;
        persistConfig();
        restore();
        bot.log("LightHack disabled");
        return true;
    }

    function status() {
        return {
            running: config.enabled,
            config: {
                ...config
            },
        };
    }

    function updateConfig(next) {
        if (next.enabled !== undefined) {
            if (next.enabled)
                start();
            else
                stop();
        }
        return {
            ...config
        };
    }

    // Auto‑apply on init if enabled
    if (config.enabled) {
        ensurePatched();
        setTimeout(forceRender, 200);
    }

    bot.lightHack = {
        start,
        stop,
        status,
        updateConfig,
        config,
        forceRender,
    };
};

/**
 * ==================================================================================
 * NOTIFICATION MODULE – Shows toast alerts for alarms
 * ==================================================================================
 */
window.__minibiaBotBundle.installNotificationModule = function installNotificationModule(bot) {
    // Create container and styles (idempotent)
    let container = document.getElementById('mb-notification-container');
    let styles = document.getElementById('mb-notification-style');
    if (!styles) {
        const style = document.createElement('style');
        style.id = 'mb-notification-style';
        style.textContent = `
      #mb-notification-container {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        pointer-events: none;
        max-width: 420px;
        width: 90%;
      }
      .mb-notification {
        background: rgba(20, 18, 16, 0.92);
        border-left: 4px solid #ffcc00;
        padding: 12px 16px;
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6);
        color: #eee;
        font: 14px/1.5 Verdana, sans-serif;
        pointer-events: auto;
        transition: opacity 0.3s ease, transform 0.3s ease;
        opacity: 1;
        transform: translateX(0);
        width: 100%;
        box-sizing: border-box;
      }
      .mb-notification.hiding {
        opacity: 0;
        transform: translateX(40px);
      }
      .mb-notification .mb-notif-title {
        font-weight: bold;
        font-size: 14px;
        letter-spacing: 0.5px;
      }
      .mb-notification .mb-notif-msg {
        font-size: 13px;
        opacity: 0.8;
        margin-top: 4px;
      }
      .mb-notification.type-alarm { border-left-color: #ff4444; }
      .mb-notification.type-player { border-left-color: #ffaa44; }
      .mb-notification.type-gm { border-left-color: #cc88ff; }
      .mb-notification.type-antibot { border-left-color: #ffdd44; }
      .mb-notification.type-playerattack { border-left-color: #ff2222; }
      .mb-notification.type-message { border-left-color: #44aaff; }
    `;
        document.head.appendChild(style);
        bot.log('Notification styles injected.');
    }

    if (!container) {
        container = document.createElement('div');
        container.id = 'mb-notification-container';
        document.body.appendChild(container);
    }

    function showNotification(title, message, type = 'alarm', duration = 15000) {
        const item = document.createElement('div');
        item.className = `mb-notification type-${type}`;
        item.innerHTML = `<div class="mb-notif-title">${title}</div><div class="mb-notif-msg">${message}</div>`;
        container.appendChild(item);

        const remove = () => {
            if (!item.parentNode)
                return;
            item.classList.add('hiding');
            setTimeout(() => {
                if (item.parentNode)
                    item.remove();
            }, 300);
        };
        const timer = setTimeout(remove, duration);
        item.addEventListener('click', () => {
            clearTimeout(timer);
            remove();
        });
    }

    // Wrap the existing alarm methods
    const orig = {
        playAlarm: bot.playAlarm,
        playPlayerAlarm: bot.playPlayerAlarm,
        playGMAlarm: bot.playGMAlarm,
        playAntiBotAlarm: bot.playAntiBotAlarm,
        playPlayerAttackAlarm: bot.playPlayerAttackAlarm,
        playMessageAlarm: bot.playMessageAlarm,
    };

    bot.playAlarm = function () {
        showNotification('⚠️ ALARM', 'General alert triggered', 'alarm');
        return orig.playAlarm.call(this);
    };
    bot.playPlayerAlarm = function () {
        showNotification('👤 PLAYER', 'Player on screen', 'player');
        return orig.playPlayerAlarm.call(this);
    };
    bot.playGMAlarm = function () {
        showNotification('🛡️ GM', 'Game Master detected!', 'gm');
        return orig.playGMAlarm.call(this);
    };
    bot.playAntiBotAlarm = function () {
        showNotification('🤖 ANTI‑BOT', 'Anti‑bot check triggered', 'antibot');
        return orig.playAntiBotAlarm.call(this);
    };
    bot.playPlayerAttackAlarm = function () {
        showNotification('⚔️ ATTACK', 'Player attacked you!', 'playerattack');
        return orig.playPlayerAttackAlarm.call(this);
    };
    bot.playMessageAlarm = function () {
        showNotification('💬 MESSAGE', 'New message in chat', 'message');
        return orig.playMessageAlarm.call(this);
    };

    bot.log('Notification system is now active');
};

/**
 * ==================================================================================
 * MOVEMENT PATCH – Balanced
 * Cancels autowalk on target acquisition and blocks autowalk packets while a valid target exists.
 * Does NOT patch findPath – cavebot handles pause.
 * ==================================================================================
 */
window.__minibiaBotBundle.installMovementPatch = function installMovementPatch(bot) {
    (function install() {
        const TAG = "[MovementPatch]";
        let installed = false;

        function waitForClient() {
            const c = window.gameClient || window.GameClient?.instance || window.client;
            if (!c || !c.player || !c.world?.pathfinder) {
                setTimeout(waitForClient, 200);
                return;
            }
            if (installed)
                return;
            installed = true;
            bot.log(`${TAG} installed (balanced)`);
            installPatches(c);
        }

        function installPatches(client) {
            guardPlayerTarget(client);
            patchGameClientSend(client);
            // No findPath patch.
        }

        // Helper: does the player have a valid target (alive, on screen)?
        function hasValidTarget(client) {
            const p = client.player;
            if (!p)
                return false;
            const target = p.__target;
            if (!target)
                return false;
            // Check health
            const health = target.state?.health ?? target.health;
            if (health !== undefined && health <= 0)
                return false;
            // Check on screen
            try {
                const pp = p.getPosition().projected();
                const tp = target.getPosition().projected();
                return Math.abs(pp.x - tp.x) < 8 && Math.abs(pp.y - tp.y) < 6;
            } catch {
                return false;
            }
        }

        // Stop movement: clear pathfinder, send StopWalkPacket, clear prediction queue
        function stopMovement(client) {
            const pf = client.world?.pathfinder;
            if (pf) {
                pf.setPathfindCache(null);
                pf.__isAutoWalking = false;
                pf.__finalDestination = null;
                pf.__hybridPath = null;
            }
            const p = client.player;
            if (p && p.__preWalks) {
                p.__preWalks.length = 0;
            }
            try {
                client.send(new StopWalkPacket());
            } catch (e) {}
        }

        // 1) Guard __target: when a target is set, stop movement immediately
        function guardPlayerTarget(client) {
            const p = client.player;
            if (!p || p.__stopOnTargetTargetGuarded)
                return;

            let targetValue = p.__target ?? null;

            Object.defineProperty(p, "__target", {
                configurable: true,
                get() {
                    return targetValue;
                },
                set(value) {
                    targetValue = value;
                    if (value !== null && value !== undefined) {
                        // Target acquired – cancel autowalk immediately
                        stopMovement(client);
                        // bot.log(`${TAG} target acquired – autowalk cancelled`);
                    }
                }
            });
            p.__stopOnTargetTargetGuarded = true;
        }

        // 2) Block AutoWalkPacket / WalkToDestinationPacket only while a valid target exists
        function patchGameClientSend(client) {
            if (!client || typeof client.send !== "function" || client.__stopOnTargetSendPatched)
                return;

            const originalSend = client.send;

            client.send = function (packet) {
                const packetName = packet?.constructor?.name || "";

                // Always allow StopWalkPacket
                if (packetName === "StopWalkPacket") {
                    return originalSend.call(this, packet);
                }

                // Block autowalk packets only if a valid target exists (alive, on screen)
                if (packetName === "AutoWalkPacket" || packetName === "WalkToDestinationPacket") {
                    if (hasValidTarget(client)) {
                        //bot.log(`${TAG} blocked ${packetName} (valid target active)`);
                        return false; // drop the packet
                    }
                }

                return originalSend.call(this, packet);
            };

            client.__stopOnTargetSendPatched = true;
        }

        waitForClient();
    })();
};

/**
 * ==================================================================================
 * OUTFIT RANDOMIZER – Changes your outfit periodically
 * ==================================================================================
 */
window.__minibiaBotBundle.installOutfitRandomizerModule = function installOutfitRandomizerModule(bot) {
    const configStorageKey = "minibiaBot.outfitRandomizer.config";
    const state = {
        running: false,
        timerId: null,
    };

    const config = Object.assign({
        enabled: false,
        intervalMinutes: 5,
        randomizeMount: true,
        randomizeAddons: true,
    }, bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getOutfits() {
        return gameClient.player?.outfits || [];
    }

    function getMounts() {
        return gameClient.player?.mounts || [];
    }

    function randomizeOutfit() {
        if (!gameClient.player)
            return false;

        const outfits = getOutfits();
        if (!outfits.length) {
            bot.log("Outfit randomizer: no outfits available.");
            return false;
        }

        // 1) Pick random outfit
        const outfitIdx = Math.floor(Math.random() * outfits.length);
        const chosen = outfits[outfitIdx];
        const outfitId = chosen.id;
        const ownedAddons = chosen.addons || 0;

        // 2) Build new outfit object
        const newOutfit = {
            id: outfitId,
            lookTypeEx: 0,
            details: {
                head: Math.floor(Math.random() * 72),
                body: Math.floor(Math.random() * 72),
                legs: Math.floor(Math.random() * 72),
                feet: Math.floor(Math.random() * 72),
            },
            mount: 0,
            mounted: false,
            addonOne: false,
            addonTwo: false,
            verifiedGhost: false,
        };

        // 3) Randomize mount (if any and enabled)
        const mounts = getMounts();
        if (config.randomizeMount && mounts.length) {
            const mountIdx = Math.floor(Math.random() * mounts.length);
            newOutfit.mount = mounts[mountIdx].id;
            newOutfit.mounted = Math.random() < 0.5; // 50% chance to be mounted
        }

        // 4) Randomize addons (only if owned)
        if (config.randomizeAddons) {
            if (ownedAddons & 1)
                newOutfit.addonOne = Math.random() < 0.5;
            if (ownedAddons & 2)
                newOutfit.addonTwo = Math.random() < 0.5;
        }

        // 5) Send the outfit change packet
        try {
            gameClient.send(new OutfitChangePacket(newOutfit));
            bot.log(`Outfit randomizer: changed to outfit ${outfitId} (addons: ${newOutfit.addonOne ? 1 : 0}${newOutfit.addonTwo ? 2 : 0})`);
            return true;
        } catch (e) {
            bot.log("Outfit randomizer: failed to send packet", e);
            return false;
        }
    }

    function scheduleNext() {
        if (!state.running)
            return;
        const ms = Math.max(60000, config.intervalMinutes * 60 * 1000);
        state.timerId = setTimeout(() => {
            try {
                randomizeOutfit();
            } catch (e) {
                bot.log("Outfit randomizer tick error", e);
            }
            scheduleNext();
        }, ms);
    }

    function start() {
        if (state.running)
            return false;
        config.enabled = true;
        persistConfig();
        state.running = true;
        bot.log(`Outfit randomizer started (every ${config.intervalMinutes} min)`);
        // Randomize once immediately on start
        randomizeOutfit();
        scheduleNext();
        return true;
    }

    function stop() {
        if (!state.running)
            return false;
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        config.enabled = false;
        persistConfig();
        bot.log("Outfit randomizer stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
        };
    }

    function updateConfig(next) {
        Object.assign(config, next);
        // Clamp interval
        if (config.intervalMinutes < 1)
            config.intervalMinutes = 1;
        persistConfig();

        if (config.enabled && !state.running)
            start();
        if (!config.enabled && state.running)
            stop();

        return {
            ...config
        };
    }

    // Auto‑start if enabled
    if (config.enabled)
        start();

    // Public API
    bot.outfitRandomizer = {
        start,
        stop,
        status,
        updateConfig,
        randomizeNow: randomizeOutfit,
        config,
    };
};

// ---- ComboBot Module ----
if (typeof window.__minibiaBotBundle === 'undefined') {
    window.__minibiaBotBundle = {};
}

window.__minibiaBotBundle.installComboBotModule = function installComboBotModule(bot) {
    const configStorageKey = "minibiaBot.combo.config";
    const state = {
        running: false,
        channel: null,
        originalSend: null,
        lastTriggerAt: 0,
        retryTimer: null,
        retryCount: 0,
    };

    const config = Object.assign({
        mode: 'follower',
        hotkeySlot: 11,
        minMana: 0,
        cooldownMs: 1500,
        broadcastClear: true,
        channelName: 'minibia-combo-bot',
        autoFollowLeader: false,
        leaderName: '',
    }, bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function log(...args) {
        console.log('%c[ComboBot]', 'color:#4fc3f7', ...args);
    }

    function isLeader() {
        return config.mode === 'leader';
    }

    function getPlayer() {
        return window.gameClient && window.gameClient.player;
    }

    function getWorld() {
        return window.gameClient && window.gameClient.world;
    }

    function sendMessage(msg) {
        if (state.channel)
            state.channel.postMessage(msg);
    }

    // ---- Follower logic ----
    function handleTarget(msg) {
        const player = getPlayer();
        const world = getWorld();
        if (!player || !world)
            return;

        const targetId = msg.id;
        const leaderId = msg.leaderId;

        if (targetId === 0) {
            if (player.__target) {
                player.setTarget(null);
                sendPacket('TargetPacket', 0);
            }
            return;
        }

        const creature = world.getCreature(targetId);
        if (!creature) {
            log('Target creature not found:', targetId);
            return;
        }

        if (player.__target !== creature) {
            player.setTarget(creature);
            sendPacket('TargetPacket', targetId);
            log('Targeting', creature.name, '(', targetId, ')');
        }

        // ---- Auto Follow Leader ----
        if (config.autoFollowLeader && leaderId) {
            log('Auto-follow enabled, leaderId:', leaderId);
            followLeaderById(leaderId);
        } else if (config.autoFollowLeader && config.leaderName) {
            log('Auto-follow via name fallback:', config.leaderName);
            followLeaderByName();
        } else {
            log('Auto-follow not enabled or missing leader info.');
        }

        triggerHotkey();
    }

    function followLeaderById(leaderId) {
        // Try to follow by ID first, but if not found fallback to name
        const world = getWorld();
        if (!world)
            return;
        const player = getPlayer();
        if (!player)
            return;

        const leader = world.getCreature(leaderId);
        if (leader) {
            // Use bot.follow by name (we know the leader's name from config)
            if (config.leaderName) {
                bot.follow(config.leaderName);
            }
            return;
        }
        // Fallback: try by name
        if (config.leaderName) {
            bot.follow(config.leaderName);
        }
    }

    function followLeaderByName() {
        if (config.leaderName) {
            bot.follow(config.leaderName);
        }
    }

    function followLeaderByName() {
        const world = getWorld();
        if (!world) {
            log('World not available.');
            return;
        }

        const leaderName = config.leaderName.trim();
        if (!leaderName) {
            log('Leader name is empty.');
            return;
        }

        const creatures = Object.values(world.activeCreatures || {});
        const leader = creatures.find(c => {
            if (!c.name)
                return false;
            return c.name.toLowerCase() === leaderName.toLowerCase();
        });

        if (!leader) {
            log('Leader not found by name:', leaderName);
            return;
        }

        const player = getPlayer();
        if (!player)
            return;

        if (player.id === leader.id) {
            log('Leader is self – ignoring.');
            return;
        }

        if (player.__followTarget && player.__followTarget.id === leader.id) {
            return;
        }

        player.setFollowTarget(leader);
        sendPacket('FollowPacket', leader.id);
        log('Following leader by name:', leader.name, '(', leader.id, ')');
    }

    function triggerHotkey() {
        const gc = window.gameClient;
        if (!gc || !gc.interface || !gc.interface.hotbarManager)
            return;

        const player = getPlayer();
        if (!player)
            return;

        const now = performance.now();
        if (now - state.lastTriggerAt < config.cooldownMs)
            return;

        if (config.minMana > 0 && player.state.mana < config.minMana) {
            return;
        }

        state.lastTriggerAt = now;
        gc.interface.hotbarManager.__handleClick(config.hotkeySlot);
        log('Triggered hotkey slot', config.hotkeySlot);
    }

    function sendPacket(packetName, ...args) {
        const gc = window.gameClient;
        if (!gc || !gc.send)
            return;
        const packetClass = window[packetName];
        if (!packetClass) {
            log('Packet class not found:', packetName);
            return;
        }
        gc.send(new packetClass(...args));
    }

    // ---- Leader hook ----
    function hookLeader() {
        const gc = window.gameClient;
        if (!gc || typeof gc.send !== 'function') {
            log('gameClient.send not found – will retry.');
            return false;
        }

        if (state.originalSend) {
            gc.send = state.originalSend;
        }

        state.originalSend = gc.send;
        gc.send = function (packet) {
            const buffer = packet.getBuffer();
            if (buffer && buffer[0] === (window.CONST && CONST.PROTOCOL.CLIENT.TARGET)) {
                const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                const targetId = view.getUint32(1, true);
                if (targetId !== 0 || config.broadcastClear) {
                    const leaderId = gc.player ? gc.player.id : 0;
                    sendMessage({
                        type: 'target',
                        id: targetId,
                        leaderId: leaderId
                    });
                }
            }
            state.originalSend.call(this, packet);
        };
        log('Leader hook installed – broadcasting targets with leader ID.');
        return true;
    }

    function hookFollower() {
        log('Follower mode – listening for targets.');
        return true;
    }

    // ---- Communication channel ----
    function setupChannel() {
        if (state.channel) {
            state.channel.close();
            state.channel = null;
        }

        if ('BroadcastChannel' in window) {
            state.channel = new BroadcastChannel(config.channelName);
        } else {
            state.channel = {
                postMessage: (msg) => localStorage.setItem('__comboBot', JSON.stringify(msg)),
                onmessage: null,
                close: () => {}
            };
            window.addEventListener('storage', (e) => {
                if (e.key === '__comboBot' && e.newValue) {
                    const msg = JSON.parse(e.newValue);
                    if (state.channel.onmessage)
                        state.channel.onmessage({
                            data: msg
                        });
                }
            });
        }

        state.channel.onmessage = (event) => {
            const msg = event.data;
            if (!msg || !msg.type)
                return;
            if (msg.type === 'target') {
                if (!isLeader())
                    handleTarget(msg);
            }
        };
        return true;
    }

    // ---- Start / Stop ----
    function start() {
        if (state.running) {
            log('Already running.');
            return false;
        }

        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
            state.retryTimer = null;
            state.retryCount = 0;
        }

        if (!setupChannel()) {
            log('Failed to set up communication channel.');
            return false;
        }

        if (isLeader()) {
            const hooked = hookLeader();
            if (!hooked) {
                state.retryCount++;
                if (state.retryCount > 10) {
                    log('Giving up – gameClient.send not found after 10 retries.');
                    state.channel.close();
                    state.channel = null;
                    return false;
                }
                state.retryTimer = setTimeout(() => {
                    state.retryTimer = null;
                    start();
                }, 2000);
                return false;
            }
        } else {
            if (!hookFollower()) {
                state.channel.close();
                state.channel = null;
                return false;
            }
        }

        state.running = true;
        config.enabled = true;
        persistConfig();
        log(`Started as ${config.mode}.`);
        return true;
    }

    function stop() {
        if (!state.running)
            return false;

        if (state.retryTimer) {
            clearTimeout(state.retryTimer);
            state.retryTimer = null;
            state.retryCount = 0;
        }

        if (state.originalSend && window.gameClient) {
            window.gameClient.send = state.originalSend;
            state.originalSend = null;
        }

        if (state.channel) {
            state.channel.close();
            state.channel = null;
        }

        state.running = false;
        config.enabled = false;
        persistConfig();
        log('Stopped.');
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
        };
    }

    function updateConfig(next) {
        Object.assign(config, next);
        if (config.cooldownMs < 100)
            config.cooldownMs = 100;
        if (config.hotkeySlot < 0)
            config.hotkeySlot = 0;
        if (config.hotkeySlot > 11)
            config.hotkeySlot = 11;
        if (config.leaderName)
            config.leaderName = config.leaderName.trim();
        persistConfig();

        if (state.running) {
            stop();
            start();
        }
        return {
            ...config
        };
    }

    // ---- Manual follow function for testing ----
    function followLeaderNow() {
        const player = getPlayer();
        if (!player) {
            log('Player not found.');
            return;
        }
        // If we have a leader name, try by name
        if (config.leaderName) {
            followLeaderByName();
        } else {
            log('No leader name set. Use the leader name field.');
        }
    }

    if (config.enabled) {
        setTimeout(() => {
            if (!state.running)
                start();
        }, 1000);
    }

    bot.comboBot = {
        start,
        stop,
        status,
        updateConfig,
        config,
        followLeaderNow, // manual follow
    };
};

// Paladin

window.__minibiaBotBundle.installPaladinModule = function installPaladinModule(bot) {
    const configStorageKey = "minibiaBot.paladin.config";
    const LEFT_HAND_SLOT = 5;
    const RIGHT_HAND_SLOT = 4;

    const state = {
        running: false,
        timerId: null,
        lastCraftAt: 0,
        lastEquipAt: 0,
        captureMode: false,
    };

    const config = Object.assign({
        enabled: false,
        tickMs: 2000,
        ammoThreshold: 4,
        craftManaCost: 140,
        craftSpellWords: "exeta con",
        highManaSpellWords: "utani hur",
        highManaThreshold: 98,
        weaponId: null,
        equipWeapon: false,
        equipCooldownMs: 5000,
        equipThreshold: 7,
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getContainerById(containerId) {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return null;
        let arr;
        if (Array.isArray(containers))
            arr = containers;
        else if (containers instanceof Set)
            arr = Array.from(containers);
        else if (containers instanceof Map)
            arr = Array.from(containers.values());
        else if (typeof containers === 'object')
            arr = Object.values(containers);
        else
            return null;
        return arr.find(c => c.__containerId === containerId) || null;
    }

    function getContainersArray() {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return [];
        if (Array.isArray(containers))
            return containers;
        if (containers instanceof Set)
            return Array.from(containers);
        if (containers instanceof Map)
            return Array.from(containers.values());
        if (typeof containers === 'object')
            return Object.values(containers);
        return [];
    }

    function readStats() {
        const ps = bot.getPlayerState();
        if (!ps)
            return null;
        return {
            hp: {
                current: ps.health ?? 0,
                max: ps.maxHealth ?? 0
            },
            mana: {
                current: ps.mana ?? 0,
                max: ps.maxMana ?? 0
            },
        };
    }

    function getManaPercent(stats) {
        if (!stats || stats.mana.max <= 0)
            return 0;
        return (stats.mana.current / stats.mana.max) * 100;
    }

    function getAmmoCount() {
        const eq = window.gameClient?.player?.equipment;
        if (!eq)
            return 0;

        const leftItem = eq.getSlotItem(LEFT_HAND_SLOT);
        const rightItem = eq.getSlotItem(RIGHT_HAND_SLOT);
        const weaponId = config.weaponId;

        let targetId = weaponId;
        if (!targetId) {
            targetId = leftItem ? leftItem.id : (rightItem ? rightItem.id : null);
        }
        if (!targetId)
            return 0;

        let total = 0;
        if (leftItem && leftItem.id === targetId)
            total += leftItem.count || 1;
        if (rightItem && rightItem.id === targetId)
            total += rightItem.count || 1;

        for (const container of getContainersArray()) {
            if (!container || typeof container.size !== 'number')
                continue;
            for (let i = 0; i < container.size; i++) {
                const item = container.getSlotItem(i);
                if (item && item.id === targetId)
                    total += item.count || 1;
            }
        }
        return total;
    }

    function findWeaponInContainers(weaponId, includeRightHand = false) {
        if (!weaponId)
            return null;

        if (includeRightHand) {
            const eq = window.gameClient?.player?.equipment;
            if (eq) {
                const rightItem = eq.getSlotItem(RIGHT_HAND_SLOT);
                if (rightItem && rightItem.id === weaponId) {
                    return {
                        container: eq,
                        slot: RIGHT_HAND_SLOT,
                        item: rightItem
                    };
                }
            }
        }

        for (const container of getContainersArray()) {
            if (!container || typeof container.size !== 'number')
                continue;
            for (let i = 0; i < container.size; i++) {
                const item = container.getSlotItem(i);
                if (item && item.id === weaponId) {
                    return {
                        container,
                        slot: i,
                        item
                    };
                }
            }
        }

        const eq = window.gameClient?.player?.equipment;
        if (eq) {
            for (let i = 0; i < eq.slots.length; i++) {
                if (i === LEFT_HAND_SLOT || i === RIGHT_HAND_SLOT)
                    continue;
                const item = eq.getSlotItem(i);
                if (item && item.id === weaponId) {
                    return {
                        container: eq,
                        slot: i,
                        item
                    };
                }
            }
        }
        return null;
    }

    function equipWeapon(weaponId) {
        if (!weaponId)
            return false;

        const eq = window.gameClient?.player?.equipment;
        if (!eq)
            return false;

        const source = findWeaponInContainers(weaponId, true);
        if (!source)
            return false;

        const from = {
            which: source.container,
            index: source.slot
        };
        const to = {
            which: eq,
            index: LEFT_HAND_SLOT
        };
        const count = source.item.count || 1;

        try {
            if (window.gameClient?.send) {
                window.gameClient.send(new ItemMovePacket(from, to, count));
                state.lastEquipAt = Date.now();
                bot.log("Paladin: equipped weapon (moved from slot " + source.slot + " to left hand)", {
                    weaponId
                });
                return true;
            }
        } catch (e) {
            bot.log("Paladin: ItemMovePacket failed", e);
        }
        return false;
    }

    function startCaptureWeapon() {
        if (state.captureMode)
            return;
        state.captureMode = true;
        bot.log("Paladin: click a weapon slot (any container or equipment) to capture its ID");

        const handler = (event) => {
            const slot = event.target.closest(".slot[slotindex]");
            if (!slot)
                return;
            event.preventDefault();
            event.stopPropagation();

            let containerEl = slot.closest("[containerindex]");
            if (!containerEl)
                containerEl = slot.closest("[containerIndex]");
            if (!containerEl) {
                const eq = window.gameClient?.player?.equipment;
                if (eq) {
                    for (let i = 0; i < eq.slots.length; i++) {
                        const slotEl = eq.slots[i]?.element;
                        if (slotEl && slotEl.contains(slot)) {
                            const item = eq.getSlotItem(i);
                            if (item) {
                                config.weaponId = item.id;
                                persistConfig();
                                bot.log("Paladin: captured weapon ID from equipment", {
                                    weaponId: item.id
                                });
                                const weaponIdInput = document.getElementById("minibia-bot-paladin-weapon-id");
                                if (weaponIdInput)
                                    weaponIdInput.value = item.id;
                                if (typeof bot.ui?.refreshPaladinStatus === "function")
                                    bot.ui.refreshPaladinStatus();
                                state.captureMode = false;
                                document.removeEventListener("click", handler, true);
                                return;
                            }
                        }
                    }
                }
                bot.log("Paladin: no container or equipment slot found");
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            const containerId = Number(containerEl.getAttribute("containerindex") || containerEl.getAttribute("containerIndex"));
            const container = getContainerById(containerId);
            if (!container) {
                bot.log("Paladin: container not found", {
                    containerId
                });
                const available = getContainersArray().map(c => c.__containerId);
                bot.log("Available containers:", available);
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            const slotIndex = Number(slot.getAttribute("slotindex"));
            const item = container.getSlotItem(slotIndex);
            if (!item) {
                bot.log("Paladin: no item in slot");
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            config.weaponId = item.id;
            persistConfig();
            bot.log("Paladin: captured weapon ID", {
                weaponId: item.id
            });
            const weaponIdInput = document.getElementById("minibia-bot-paladin-weapon-id");
            if (weaponIdInput)
                weaponIdInput.value = item.id;
            if (typeof bot.ui?.refreshPaladinStatus === "function")
                bot.ui.refreshPaladinStatus();

            state.captureMode = false;
            document.removeEventListener("click", handler, true);
        };

        document.addEventListener("click", handler, true);
    }

    // ---- Crafting - NO annoying logs ----
    function tryCraft() {
        if (!config.enabled)
            return false;
        const stats = readStats();
        if (!stats)
            return false;
        const manaPercent = getManaPercent(stats);
        const ammo = getAmmoCount();

        if (manaPercent > config.highManaThreshold && config.highManaSpellWords) {
            const sent = bot.sendChat(config.highManaSpellWords.trim());
            if (sent) {
                //bot.log("Paladin: cast high mana spell", { spell: config.highManaSpellWords });
                return true;
            }
        }

        if (ammo <= config.ammoThreshold) {
            if (stats.mana.current >= config.craftManaCost && config.craftSpellWords) {
                const sent = bot.sendChat(config.craftSpellWords.trim());
                if (sent) {
                    bot.log("Paladin: crafted ammo", {
                        ammo,
                        mana: stats.mana.current
                    });
                    return true;
                }
            }
            // SILENT: no log for insufficient mana
        }
        return false;
    }

    // ---- scheduleNextTick MUST be defined before tick ----
    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(tick, config.tickMs);
    }

    // ---- Loop ----
    function tick() {
        if (!state.running)
            return;
        try {
            if (config.equipWeapon && config.weaponId) {
                const eq = window.gameClient?.player?.equipment;
                let leftHandCount = 0;
                let leftHandHasWeapon = false;

                if (eq) {
                    const leftItem = eq.getSlotItem(LEFT_HAND_SLOT);
                    if (leftItem && leftItem.id === config.weaponId) {
                        leftHandCount = leftItem.count || 1;
                        leftHandHasWeapon = true;
                    }
                }

                // Equip only if left hand is empty OR count is below threshold
                if (!leftHandHasWeapon || leftHandCount <= config.equipThreshold) {
                    const now = Date.now();
                    if (now - state.lastEquipAt > (config.equipCooldownMs || 5000)) {
                        equipWeapon(config.weaponId);
                    }
                }
            }
            tryCraft();
        } catch (e) {
            bot.log("Paladin tick failed", e);
        } finally {
            scheduleNextTick();
        }
    }

    // ---- Public API ----
    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        persistConfig();
        if (state.running)
            return false;
        state.running = true;
        bot.log("Paladin started", {
            config
        });
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
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("Paladin stopped");
        return true;
    }

    function status() {
        const stats = readStats();
        return {
            running: state.running,
            config: {
                ...config
            },
            stats,
            manaPercent: stats ? getManaPercent(stats) : 0,
            ammoCount: getAmmoCount(),
        };
    }

    function updateConfig(nextConfig = {}) {
        Object.assign(config, nextConfig);
        config.ammoThreshold = Math.max(0, Number(config.ammoThreshold) || 0);
        config.craftManaCost = Math.max(0, Number(config.craftManaCost) || 0);
        config.highManaThreshold = Math.min(100, Math.max(0, Number(config.highManaThreshold) || 0));
        config.equipCooldownMs = Math.max(1000, Number(config.equipCooldownMs) || 5000);
        config.equipThreshold = Math.max(0, Number(config.equipThreshold) || 0);
        if (config.weaponId !== null && config.weaponId !== undefined) {
            config.weaponId = Number(config.weaponId) || null;
        }
        persistConfig();
        bot.log("Paladin config updated", {
            ...config
        });
        const weaponIdInput = document.getElementById("minibia-bot-paladin-weapon-id");
        if (weaponIdInput)
            weaponIdInput.value = config.weaponId || "";
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

    bot.paladin = {
        start,
        stop,
        status,
        updateConfig,
        config,
        getAmmoCount,
        equipWeapon,
        tryCraft,
        startCaptureWeapon,
    };
};

// Looter

window.__minibiaBotBundle.installLooterModule = function installLooterModule(bot) {
    const configStorageKey = "minibiaBot.looter.config";

    const state = {
        running: false,
        timerId: null,
        destinationId: null,
        destinationTitle: null,
        trackedItems: new Map(),
        captureMode: false,
    };

    // Load config
    const stored = bot.storage.get(configStorageKey, {});
    state.destinationId = stored.destinationId || null;
    state.destinationTitle = stored.destinationTitle || null;
    if (Array.isArray(stored.trackedItems)) {
        for (const [id, name] of stored.trackedItems) {
            state.trackedItems.set(id, name);
        }
    }

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            destinationId: state.destinationId,
            destinationTitle: state.destinationTitle,
            trackedItems: Array.from(state.trackedItems.entries()),
        });
    }

    // ---- Helper: get container by ID (works with number or string) ----
    function getContainerById(containerId) {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return null;
        let arr;
        if (Array.isArray(containers))
            arr = containers;
        else if (containers instanceof Set)
            arr = Array.from(containers);
        else if (containers instanceof Map)
            arr = Array.from(containers.values());
        else if (typeof containers === 'object')
            arr = Object.values(containers);
        else
            return null;

        // Convert to number for comparison (container IDs are numbers)
        const id = Number(containerId);
        if (isNaN(id))
            return null;
        return arr.find(c => c.__containerId === id) || null;
    }

    function getContainersArray() {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return [];
        if (Array.isArray(containers))
            return containers;
        if (containers instanceof Set)
            return Array.from(containers);
        if (containers instanceof Map)
            return Array.from(containers.values());
        if (typeof containers === 'object')
            return Object.values(containers);
        return [];
    }

    // ---- Get destination container (fallback to title if ID fails) ----
    function getDestinationContainer() {
        let dest = null;

        // 1) Try by ID
        if (state.destinationId != null) {
            dest = getContainerById(state.destinationId);
            if (dest)
                return dest;
        }

        // 2) Try by title (if we have one)
        if (state.destinationTitle) {
            const containers = getContainersArray();
            dest = containers.find(c => c.__title === state.destinationTitle);
            if (dest) {
                // Update stored ID to the new one for future lookups
                state.destinationId = dest.__containerId;
                persistConfig();
                return dest;
            }
        }

        return null;
    }

    function findEmptySlot(container) {
        if (!container)
            return -1;
        for (let i = 0; i < container.size; i++) {
            if (!container.getSlotItem(i))
                return i;
        }
        return -1;
    }

    function moveItems() {
        if (!state.running)
            return false;
        const dest = getDestinationContainer();
        if (!dest) {
            if (!state._lastDestLog || Date.now() - state._lastDestLog > 30000) {
                state._lastDestLog = Date.now();
                bot.log("Looter: no destination container found. Make sure it's open and selected.");
            }
            return false;
        }

        const containers = getContainersArray();
        let moved = 0;

        for (const container of containers) {
            if (container.__containerId === dest.__containerId)
                continue;
            for (let slot = 0; slot < container.size; slot++) {
                const item = container.getSlotItem(slot);
                if (!item)
                    continue;
                if (!state.trackedItems.has(item.id))
                    continue;

                const targetSlot = findEmptySlot(dest);
                if (targetSlot === -1) {
                    bot.log("Looter: destination container full");
                    return moved > 0;
                }

                try {
                    if (window.gameClient?.mouse?.sendItemMove) {
                        window.gameClient.mouse.sendItemMove({
                            which: container,
                            index: slot
                        }, {
                            which: dest,
                            index: targetSlot
                        },
                            item.count);
                    } else if (window.gameClient?.send) {
                        const from = {
                            which: container,
                            index: slot
                        };
                        const to = {
                            which: dest,
                            index: targetSlot
                        };
                        window.gameClient.send(new ItemMovePacket(from, to, item.count));
                    }
                    moved++;
                } catch (e) {
                    bot.log("Looter: move failed", e);
                }
            }
        }

        if (moved > 0) {
            bot.log("Looter: moved", moved, "items");
        }
        return moved > 0;
    }

    function tick() {
        if (!state.running)
            return;
        try {
            moveItems();
        } catch (e) {
            bot.log("Looter tick failed", e);
        } finally {
            scheduleNextTick();
        }
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(tick, 1000);
    }

    function start() {
        if (state.running)
            return false;
        state.running = true;
        bot.log("Looter started");
        tick();
        return true;
    }

    function stop() {
        state.running = false;
        if (state.timerId != null) {
            window.clearTimeout(state.timerId);
            state.timerId = null;
        }
        bot.log("Looter stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            destinationId: state.destinationId,
            destinationTitle: state.destinationTitle,
            trackedItems: Array.from(state.trackedItems.entries()),
        };
    }

    function updateConfig(next) {
        if (next.destinationId !== undefined) {
            state.destinationId = next.destinationId;
        }
        if (next.destinationTitle !== undefined) {
            state.destinationTitle = next.destinationTitle;
        }
        if (Array.isArray(next.trackedItems)) {
            state.trackedItems = new Map(next.trackedItems);
        }
        persistConfig();
        return {
            destinationId: state.destinationId,
            destinationTitle: state.destinationTitle,
            trackedItems: Array.from(state.trackedItems.entries())
        };
    }

    // ---- Capture item by clicking ----
    function startCaptureItem() {
        if (state.captureMode)
            return;
        state.captureMode = true;
        bot.log("Looter: click an item slot to track it");

        const handler = (event) => {
            const slot = event.target.closest(".slot[slotindex]");
            if (!slot)
                return;
            event.preventDefault();
            event.stopPropagation();

            const containerEl = slot.closest("[containerindex]");
            if (!containerEl) {
                bot.log("Looter: not in a container");
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            const containerId = Number(containerEl.getAttribute("containerindex"));
            const container = getContainerById(containerId);
            if (!container) {
                bot.log("Looter: container not found", {
                    containerId
                });
                // Debug: list available container IDs
                const available = getContainersArray().map(c => c.__containerId);
                bot.log("Available containers:", available);
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            const slotIndex = Number(slot.getAttribute("slotindex"));
            const item = container.getSlotItem(slotIndex);
            if (!item) {
                bot.log("Looter: no item in slot");
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            const itemName = window.gameClient?.itemDefinitionsBySid?.[item.sid]?.properties?.name || `Item ${item.id}`;
            state.trackedItems.set(item.id, itemName);
            persistConfig();
            bot.log("Looter: added tracked item", {
                id: item.id,
                name: itemName
            });
            state.captureMode = false;
            document.removeEventListener("click", handler, true);
            if (typeof bot.ui?.refreshLooterStatus === "function")
                bot.ui.refreshLooterStatus();
        };

        document.addEventListener("click", handler, true);
    }

    // ---- Select destination container by clicking ----
    function startSelectDestination() {
        if (state.captureMode)
            return;
        state.captureMode = true;
        bot.log("Looter: click a container window to set as destination");

        const handler = (event) => {
            const containerEl = event.target.closest("[containerindex]");
            if (!containerEl)
                return;
            event.preventDefault();
            event.stopPropagation();

            const containerId = Number(containerEl.getAttribute("containerindex"));
            const container = getContainerById(containerId);
            if (!container) {
                bot.log("Looter: container not found", {
                    containerId
                });
                // Debug: list available container IDs
                const available = getContainersArray().map(c => c.__containerId);
                bot.log("Available containers:", available);
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
                return;
            }

            state.destinationId = containerId;
            state.destinationTitle = container.__title || null;
            persistConfig();
            bot.log("Looter: destination set to", {
                containerId,
                title: state.destinationTitle
            });
            state.captureMode = false;
            document.removeEventListener("click", handler, true);
            if (typeof bot.ui?.refreshLooterStatus === "function")
                bot.ui.refreshLooterStatus();
        };

        document.addEventListener("click", handler, true);
    }

    function removeTrackedItem(id) {
        if (state.trackedItems.has(id)) {
            state.trackedItems.delete(id);
            persistConfig();
            if (typeof bot.ui?.refreshLooterStatus === "function")
                bot.ui.refreshLooterStatus();
            return true;
        }
        return false;
    }

    // ---- Public API ----
    bot.looter = {
        start,
        stop,
        status,
        updateConfig,
        startCaptureItem,
        startSelectDestination,
        removeTrackedItem,
        getTrackedItems: () => Array.from(state.trackedItems.entries()),
        getDestinationId: () => state.destinationId,
        getDestinationTitle: () => state.destinationTitle,
    };
};

// -- PINK SKULL DISCONNECT

window.__minibiaBotBundle.installPinkSkullDetectorModule = function installPinkSkullDetectorModule(bot) {
    const configStorageKey = "minibiaBot.pinkSkull.config";
    let checkInterval = null;

    const config = Object.assign({
        enabled: false
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getPinkSkullValue() {
        // Attempt to get the pink skull constant from CONST.SKULL
        if (typeof CONST !== 'undefined' && CONST.SKULL && typeof CONST.SKULL.PINK !== 'undefined') {
            return CONST.SKULL.PINK;
        }
        // Fallback: numeric value from common OTC implementations (often 4)
        return 4;
    }

    function checkSkull() {
        if (!config.enabled)
            return;

        const player = window.gameClient?.player;
        if (!player)
            return;

        const pink = getPinkSkullValue();
        if (player.skull === pink) {
            bot.log("PINK SKULL DETECTED! Disconnecting...");
            bot.playAlarm?.();

            // Stop all modules (like panic does)
            if (bot.cave?.stop)
                bot.cave.stop({
                    persistEnabled: false
                });
            if (bot.attack?.stop)
                bot.attack.stop({
                    persistEnabled: false
                });
            if (bot.rune?.stop)
                bot.rune.stop({
                    persistEnabled: false
                });
            if (bot.heal?.stop)
                bot.heal.stop({
                    persistEnabled: false
                });
            if (bot.invisible?.stop)
                bot.invisible.stop({
                    persistEnabled: false
                });
            if (bot.magicShield?.stop)
                bot.magicShield.stop({
                    persistEnabled: false
                });
            if (bot.equipRing?.stop)
                bot.equipRing.stop({
                    persistEnabled: false
                });
            if (bot.eat?.stop)
                bot.eat.stop({
                    persistEnabled: false
                });
            if (bot.paladin?.stop)
                bot.paladin.stop({
                    persistEnabled: false
                });
            if (bot.looter?.stop)
                bot.looter.stop({
                    persistEnabled: false
                });

            // Disconnect
            try {
                if (window.gameClient && typeof window.gameClient.disconnect === 'function') {
                    window.gameClient.disconnect();
                    bot.log("Game client disconnected.");
                } else {
                    bot.log("Could not disconnect: gameClient.disconnect not available.");
                }
            } catch (e) {
                bot.log("Disconnect failed:", e);
            }

            // Disable the detector to prevent repeated triggers
            config.enabled = false;
            persistConfig();
            if (checkInterval) {
                clearInterval(checkInterval);
                checkInterval = null;
            }
            // Update UI toggle
            if (typeof bot.ui?.refreshPinkSkullStatus === 'function') {
                bot.ui.refreshPinkSkullStatus();
            }
        }
    }

    function start() {
        if (config.enabled)
            return false;
        config.enabled = true;
        persistConfig();
        if (checkInterval)
            clearInterval(checkInterval);
        checkInterval = setInterval(checkSkull, 1000);
        bot.log("Pink Skull Detector enabled");
        return true;
    }

    function stop() {
        if (!config.enabled)
            return false;
        config.enabled = false;
        persistConfig();
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        bot.log("Pink Skull Detector disabled");
        return true;
    }

    function status() {
        return {
            running: config.enabled,
            config: {
                ...config
            },
            profiles: bot.profiles?.list?.() || [],
        };
    }

    function updateConfig(next) {
        if (next.enabled !== undefined) {
            if (next.enabled)
                start();
            else
                stop();
        }
        return {
            ...config
        };
    }

    // Auto-start if enabled
    if (config.enabled) {
        start();
    }

    bot.pinkSkull = {
        start,
        stop,
        status,
        updateConfig,
        config,
    };
};

/**
 * ==================================================================================
 * PROFILE MODULE – Full config save/load
 * ==================================================================================
 */
window.__minibiaBotBundle.installProfileModule = function installProfileModule(bot) {
    const PROFILES_STORAGE_KEY = "minibiaBot.profiles";

    const CONFIG_KEYS = [
        "minibiaBot.rune.config",
        "minibiaBot.heal.config",
        "minibiaBot.invisible.config",
        "minibiaBot.magicShield.config",
        "minibiaBot.attack.config",
        "minibiaBot.cave.config",
        "minibiaBot.cave.route",
        "minibiaBot.cave.transitions",
        "minibiaBot.cave.presets",
        "minibiaBot.equipRing.config",
        "minibiaBot.eat.config",
        "minibiaBot.talk.config",
        "minibiaBot.panic.config",
        "minibiaBot.xray.config",
        "minibiaBot.pz.home",
        "minibiaBot.audio.alarmSrc",
        "minibiaBot.lightHack.config",
        "minibiaBot.pinkSkull.config",
        "minibiaBot.paladin.config",
        "minibiaBot.looter.config",
        "minibiaBot.blacklist.config",
        "minibiaBot.ui.panelPosition",
        "minibiaBot.ui.panelCollapsed",
    ];

    function getAllConfigs() {
        const snapshot = {};
        for (const key of CONFIG_KEYS) {
            try {
                const raw = localStorage.getItem(key);
                snapshot[key] = raw !== null ? JSON.parse(raw) : undefined;
            } catch {
                snapshot[key] = undefined;
            }
        }
        return snapshot;
    }

    function setAllConfigs(snapshot) {
        for (const key of CONFIG_KEYS) {
            const value = snapshot[key];
            if (value === undefined) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, JSON.stringify(value));
            }
        }
    }

    function listProfiles() {
        try {
            const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
            return raw ? Object.keys(JSON.parse(raw)) : [];
        } catch {
            return [];
        }
    }

    function getProfile(name) {
        if (!name)
            return null;
        try {
            const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
            const profiles = raw ? JSON.parse(raw) : {};
            return profiles[name] || null;
        } catch {
            return null;
        }
    }

    function saveProfile(name) {
        if (!name || typeof name !== "string") {
            bot.log("Profile name required");
            return false;
        }
        const nameTrim = name.trim();
        if (!nameTrim)
            return false;

        const snapshot = getAllConfigs();
        let profiles = {};
        try {
            const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
            profiles = raw ? JSON.parse(raw) : {};
        } catch {
            profiles = {};
        }
        profiles[nameTrim] = snapshot;
        localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
        bot.log(`Profile "${nameTrim}" saved`);
        return true;
    }

    function loadProfile(name) {
        if (!name)
            return false;
        const snapshot = getProfile(name);
        if (!snapshot) {
            bot.log(`Profile "${name}" not found`);
            return false;
        }
        setAllConfigs(snapshot);
        bot.log(`Profile "${name}" loaded – reloading bot...`);
        if (typeof window.minibiaBotReload === "function") {
            window.minibiaBotReload();
        } else {
            location.reload();
        }
        return true;
    }

    function deleteProfile(name) {
        if (!name)
            return false;
        let profiles = {};
        try {
            const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
            profiles = raw ? JSON.parse(raw) : {};
        } catch {
            profiles = {};
        }
        if (!profiles[name])
            return false;
        delete profiles[name];
        localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
        bot.log(`Profile "${name}" deleted`);
        return true;
    }

    /**
     * Import waypoint presets from a profile JSON file.
     * Merges them into the current cave presets, skipping duplicates by name.
     * @param {File} file – The .json file to read.
     * @returns {Promise<{ added: number, skipped: number }>}
     */
    function importWaypointsFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (typeof data !== "object" || data === null) {
                        reject(new Error("Invalid file format – not an object."));
                        return;
                    }

                    // Look for cave presets in the imported data
                    const presetsData = data["minibiaBot.cave.presets"];
                    if (!presetsData) {
                        reject(new Error("No cave presets found in this file."));
                        return;
                    }

                    if (!Array.isArray(presetsData) || presetsData.length === 0) {
                        reject(new Error("Cave presets array is empty or invalid."));
                        return;
                    }

                    // Merge into current cave module
                    const result = bot.cave.mergePresets(presetsData, true);
                    resolve(result);
                } catch (err) {
                    reject(new Error(`Import failed: ${err.message}`));
                }
            };
            reader.onerror = () => reject(new Error("File read error"));
            reader.readAsText(file);
        });
    }

    // ---- NEW: Export to file ----
    function exportProfileToFile(name) {
        if (!name) {
            bot.log("Profile name required for export");
            return false;
        }
        const snapshot = getProfile(name);
        if (!snapshot) {
            bot.log(`Profile "${name}" not found`);
            return false;
        }
        const data = JSON.stringify(snapshot, null, 2);
        const blob = new Blob([data], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.profile.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        bot.log(`Profile "${name}" exported to file`);
        return true;
    }

    // ---- NEW: Import from file ----
    function importProfileFromFile(file, profileName) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (typeof data !== "object" || data === null) {
                        reject(new Error("Invalid profile data: not an object"));
                        return;
                    }
                    // Optional: check that it contains at least one known config key
                    const hasConfig = CONFIG_KEYS.some(key => key in data);
                    if (!hasConfig) {
                        reject(new Error("Invalid profile: no recognized config keys"));
                        return;
                    }
                    const name = profileName?.trim() || file.name.replace(/\.profile\.json$/i, "") || "imported";
                    // Load existing profiles
                    let profiles = {};
                    try {
                        const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
                        profiles = raw ? JSON.parse(raw) : {};
                    } catch {
                        profiles = {};
                    }
                    profiles[name] = data;
                    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
                    bot.log(`Profile "${name}" imported from file`);
                    resolve(name);
                } catch (err) {
                    reject(new Error(`Import failed: ${err.message}`));
                }
            };
            reader.onerror = () => reject(new Error("File read error"));
            reader.readAsText(file);
        });
    }

    // Public API
    bot.profiles = {
        list: listProfiles,
        save: saveProfile,
        load: loadProfile,
        delete : deleteProfile,
        get: getProfile,
        getAllConfigs,
        setAllConfigs,
        export: exportProfileToFile,
        import: importProfileFromFile,
        importWaypointsFromFile: importWaypointsFromFile,
    };
};

/**
 * ==================================================================================
 * BLACKLIST MODULE – Avoid walking on specific tiles
 * ==================================================================================
 */
window.__minibiaBotBundle.installBlacklistModule = function installBlacklistModule(bot) {
    const configStorageKey = "minibiaBot.blacklist.config";

    let tiles = [];

    function persist() {
        bot.storage.set(configStorageKey, {
            tiles: tiles.map(t => ({
                    ...t
                }))
        });
    }

    function load() {
        const data = bot.storage.get(configStorageKey, {});
        tiles = Array.isArray(data.tiles) ? data.tiles.map(t => ({
                    x: Number(t.x),
                    y: Number(t.y),
                    z: Number(t.z)
                })).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) : [];
    }

    function isBlacklisted(x, y, z) {
        return tiles.some(t => t.x === x && t.y === y && t.z === z);
    }

    function add(x, y, z) {
        x = Math.trunc(x);
        y = Math.trunc(y);
        z = Math.trunc(z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
            return false;
        if (isBlacklisted(x, y, z))
            return false;
        tiles.push({
            x,
            y,
            z
        });
        persist();
        return true;
    }

    function remove(x, y, z) {
        x = Math.trunc(x);
        y = Math.trunc(y);
        z = Math.trunc(z);
        const before = tiles.length;
        tiles = tiles.filter(t => !(t.x === x && t.y === y && t.z === z));
        if (tiles.length !== before) {
            persist();
            return true;
        }
        return false;
    }

    function clear() {
        tiles = [];
        persist();
    }

    function getTiles() {
        return tiles.map(t => ({
                ...t
            }));
    }

    function addCurrentPosition() {
        const pos = bot.getPlayerPosition();
        if (!pos) {
            bot.log("Could not read current position.");
            return false;
        }
        return add(pos.x, pos.y, pos.z);
    }

    // Load on init
    load();

    // Public API
    bot.blacklist = {
        isBlacklisted,
        add,
        remove,
        clear,
        getTiles,
        addCurrentPosition,
        persist,
    };
};

/**
 * ANTI-AFK MODULE – Prevents logout by turning character when idle
 */
window.__minibiaBotBundle.installAntiAfkModule = function installAntiAfkModule(bot) {
    const configStorageKey = "minibiaBot.antiafk.config";
    const state = {
        running: false,
        timerId: null,
        lastActionAt: 0,
        turnIndex: 0,
    };

    const config = Object.assign({
        enabled: false,
        intervalMs: 60000
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function isIdle() {
        if (!!bot.cave?.status?.().running || !!bot.attack?.status?.().running)
            return false;
        const pf = window.gameClient?.world?.pathfinder;
        if (pf && pf.__isAutoWalking)
            return false;
        return true;
    }

    function sendTurn(dir) {
        try {
            if (window.gameClient?.keyboard?.handleDirectionKey) {
                window.gameClient.keyboard.handleDirectionKey(dir);
                return true;
            }
            if (window.gameClient?.send && typeof TurnPacket === 'function') {
                window.gameClient.send(new TurnPacket(dir));
                return true;
            }
            if (window.gameClient?.keyboard?.handleMoveKey) {
                window.gameClient.keyboard.handleMoveKey(dir);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function performTurn() {
        if (!config.enabled || !state.running)
            return false;
        if (!isIdle()) {
            state.lastActionAt = Date.now();
            return false;
        }
        if (Date.now() - state.lastActionAt < config.intervalMs)
            return false;

        const dirs = [
            CONST.DIRECTION.NORTH,
            CONST.DIRECTION.EAST,
            CONST.DIRECTION.SOUTH,
            CONST.DIRECTION.WEST,
        ];
        const dir = dirs[state.turnIndex % dirs.length];
        state.turnIndex++;

        if (sendTurn(dir)) {
            state.lastActionAt = Date.now();
            bot.log("anti-afk: turned " + Object.keys(CONST.DIRECTION).find(k => CONST.DIRECTION[k] === dir) || dir);
        } else {
            state.turnIndex++; // skip failed direction
        }
        return true;
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = setTimeout(() => {
            try {
                performTurn();
            } catch (e) {
                bot.log("anti-afk tick failed", e);
            }
            scheduleNextTick();
        }, 5000);
    }

    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        persistConfig();
        if (state.running)
            return false;
        state.running = true;
        state.lastActionAt = Date.now();
        state.turnIndex = 0;
        bot.log("anti-afk started", {
            intervalMs: config.intervalMs
        });
        scheduleNextTick();
        return true;
    }

    function stop(options = {}) {
        const shouldPersist = options.persistEnabled !== false;
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("anti-afk stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            lastActionAt: state.lastActionAt,
            turnIndex: state.turnIndex,
            idle: isIdle(),
        };
    }

    function updateConfig(next = {}) {
        if (next.intervalMs !== undefined) {
            next.intervalMs = Math.max(10000, Number(next.intervalMs) || 60000);
        }
        Object.assign(config, next);
        persistConfig();
        return {
            ...config
        };
    }

    if (config.enabled)
        start();

    bot.antiAfk = {
        start,
        stop,
        status,
        updateConfig,
        config,
        performTurn
    };
};

/**
 * ==================================================================================
 * FISHER MODULE – Automatically fishes on a selected tile
 * ==================================================================================
 */
window.__minibiaBotBundle.installFisherModule = function installFisherModule(bot) {
    const configStorageKey = "minibiaBot.fisher.config";
    const FISHING_ROD_ID = 3483;
    const FISH_ITEM_ID = 3578;

    const state = {
        running: false,
        timerId: null,
        captureMode: false,
        lastFishAt: 0,
    };

    const config = Object.assign({
        enabled: false,
        tile: null, // {x, y, z}
        delayMs: 2000,
        fishThreshold: 10,
    },
            bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    // ---- Helpers ----
    function getContainerById(containerId) {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return null;
        const arr = Array.isArray(containers) ? containers : Array.from(containers);
        return arr.find(c => c.__containerId === containerId) || null;
    }

    function getContainersArray() {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return [];
        if (Array.isArray(containers))
            return containers;
        if (containers instanceof Set)
            return Array.from(containers);
        if (containers instanceof Map)
            return Array.from(containers.values());
        if (typeof containers === 'object')
            return Object.values(containers);
        return [];
    }

    function getEquipment() {
        return window.gameClient?.player?.equipment || null;
    }

    function getItemDefinition(item) {
        if (!item)
            return null;
        return window.gameClient?.itemDefinitionsBySid?.[item.sid] ||
        window.gameClient?.itemDefinitions?.[item.id] || null;
    }

    function getItemName(item) {
        const def = getItemDefinition(item);
        return def?.properties?.name || item?.name || "";
    }

    // ---- Find fishing rod in equipment or containers ----
    function findFishingRod() {
        const eq = getEquipment();
        if (eq) {
            for (let i = 0; i < eq.slots.length; i++) {
                const item = eq.getSlotItem(i);
                if (item && item.id === FISHING_ROD_ID) {
                    return {
                        container: eq,
                        slotIndex: i,
                        item
                    };
                }
            }
        }
        for (const container of getContainersArray()) {
            if (!container || typeof container.size !== 'number')
                continue;
            for (let i = 0; i < container.size; i++) {
                const item = container.getSlotItem(i);
                if (item && item.id === FISHING_ROD_ID) {
                    return {
                        container,
                        slotIndex: i,
                        item
                    };
                }
            }
        }
        return null;
    }

    // ---- Count fish (item 3578) in all containers and equipment ----
    function getFishCount() {
        let count = 0;
        const eq = getEquipment();
        if (eq) {
            for (let i = 0; i < eq.slots.length; i++) {
                const item = eq.getSlotItem(i);
                if (item && item.id === FISH_ITEM_ID) {
                    count += item.count || 1;
                }
            }
        }
        for (const container of getContainersArray()) {
            if (!container || typeof container.size !== 'number')
                continue;
            for (let i = 0; i < container.size; i++) {
                const item = container.getSlotItem(i);
                if (item && item.id === FISH_ITEM_ID) {
                    count += item.count || 1;
                }
            }
        }
        return count;
    }

    // ---- Use fishing rod on the selected tile ----
    function useFishingRod() {
        const rod = findFishingRod();
        if (!rod) {
            bot.log("Fisher: No fishing rod found (ID 3483)");
            return false;
        }

        const tile = config.tile;
        if (!tile || typeof tile.x !== 'number' || typeof tile.y !== 'number' || typeof tile.z !== 'number') {
            bot.log("Fisher: No tile selected");
            return false;
        }

        // Get the tile object at the position
        const pos = new Position(tile.x, tile.y, tile.z);
        const worldTile = window.gameClient?.world?.getTileFromWorldPosition?.(pos);
        if (!worldTile) {
            bot.log("Fisher: Tile not loaded or invalid");
            return false;
        }

        // Use rod on tile
        try {
            // Method 1: use mouse.__handleItemUseWith if available
            if (window.gameClient?.mouse?.__handleItemUseWith) {
                const source = {
                    which: rod.container,
                    index: rod.slotIndex
                };
                const target = {
                    which: worldTile,
                    index: 0xFF
                }; // 0xFF means use on tile
                window.gameClient.mouse.__handleItemUseWith(source, target);
                return true;
            }

            // Method 2: send packet directly
            if (window.gameClient?.send && typeof ThingUseWithPacket === 'function') {
                const source = {
                    which: rod.container,
                    index: rod.slotIndex
                };
                const target = {
                    position: pos
                };
                const packet = new ThingUseWithPacket(source, target);
                window.gameClient.send(packet);
                return true;
            }

            bot.log("Fisher: Cannot use item – no method available");
            return false;
        } catch (e) {
            bot.log("Fisher: Error using rod", e);
            return false;
        }
    }

    // ---- Fisher tick ----
    function tick() {
        if (!state.running || !config.enabled)
            return;

        const now = Date.now();
        if (now - state.lastFishAt < config.delayMs) {
            scheduleNextTick();
            return;
        }

        const fishCount = getFishCount();
        if (fishCount >= config.fishThreshold) {
            scheduleNextTick();
            return;
        }

        // Attempt to fish
        const success = useFishingRod();
        if (success) {
            state.lastFishAt = now;
        }

        scheduleNextTick();
    }

    function scheduleNextTick() {
        if (!state.running)
            return;
        state.timerId = setTimeout(tick, 500); // check every 500ms
    }

    // ---- Public API ----
    function start(overrides = {}) {
        Object.assign(config, overrides, {
            enabled: true
        });
        persistConfig();
        if (state.running) {
            bot.log("Fisher already running");
            return false;
        }
        if (!config.tile) {
            bot.log("Fisher: No tile selected – cannot start");
            return false;
        }
        if (!findFishingRod()) {
            bot.log("Fisher: No fishing rod found – cannot start");
            return false;
        }
        state.running = true;
        state.lastFishAt = 0;
        bot.log("Fisher started", {
            tile: config.tile,
            delayMs: config.delayMs,
            threshold: config.fishThreshold
        });
        tick();
        return true;
    }

    function stop(options = {}) {
        const shouldPersist = options.persistEnabled !== false;
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("Fisher stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            fishCount: getFishCount(),
            hasRod: !!findFishingRod(),
        };
    }

    function updateConfig(next = {}) {
        if (next.tile !== undefined) {
            // Ensure tile has x, y, z
            const t = next.tile;
            if (t && typeof t.x === 'number' && typeof t.y === 'number' && typeof t.z === 'number') {
                config.tile = {
                    x: t.x,
                    y: t.y,
                    z: t.z
                };
            } else {
                config.tile = null;
            }
        }
        if (next.delayMs !== undefined) {
            config.delayMs = Math.max(500, Number(next.delayMs) || 2000);
        }
        if (next.fishThreshold !== undefined) {
            config.fishThreshold = Math.max(1, Number(next.fishThreshold) || 10);
        }
        persistConfig();
        return {
            ...config
        };
    }

    // ---- Tile capture ----
    function startTileCapture() {
        if (state.captureMode)
            return;
        state.captureMode = true;
        bot.log("Fisher: Click on a tile in the game world to select it");

        const handler = (event) => {
            // Only handle clicks on the screen canvas
            if (event.target.id !== "screen") {
                bot.log("Fisher: Please click on the game screen, not the UI.");
                return;
            }

            let tilePos = null;

            // Method 1: Use the game's own mouse.getWorldObject (most reliable)
            try {
                const worldObject = gameClient.mouse.getWorldObject(event);
                if (worldObject && worldObject.which && worldObject.which.constructor.name === "Tile") {
                    tilePos = worldObject.which.getPosition();
                    bot.log("Fisher: Got tile via gameClient.mouse.getWorldObject");
                }
            } catch (e) {}

            // Fallback: renderer.screen.getWorldCoordinates
            if (!tilePos) {
                try {
                    const worldPos = gameClient.renderer.screen.getWorldCoordinates(event);
                    if (worldPos && worldPos.__position) {
                        tilePos = worldPos.__position;
                        bot.log("Fisher: Got tile via renderer.screen.getWorldCoordinates");
                    }
                } catch (e) {}
            }

            if (tilePos) {
                config.tile = {
                    x: tilePos.x,
                    y: tilePos.y,
                    z: tilePos.z
                };
                persistConfig();
                bot.log("Fisher: Tile selected", config.tile);
                updateFisherUI(tilePos);
                state.captureMode = false;
                document.removeEventListener("click", handler, true);
            } else {
                bot.log("Fisher: Could not determine tile. Try again or enter coordinates manually.");
            }
        };

        document.addEventListener("click", handler, true);
    }

    // Helper to update the UI elements
    function updateFisherUI(tilePos) {
        const tileDisplay = document.getElementById("minibia-bot-fisher-tile-display");
        if (tileDisplay)
            tileDisplay.textContent = `${tilePos.x}, ${tilePos.y}, ${tilePos.z}`;
        const xInput = document.getElementById("minibia-bot-fisher-tile-x");
        const yInput = document.getElementById("minibia-bot-fisher-tile-y");
        const zInput = document.getElementById("minibia-bot-fisher-tile-z");
        if (xInput)
            xInput.value = tilePos.x;
        if (yInput)
            yInput.value = tilePos.y;
        if (zInput)
            zInput.value = tilePos.z;
    }

    // Load saved config and auto-start if enabled
    if (config.enabled) {
        start();
    }

    // Public API
    bot.fisher = {
        start,
        stop,
        status,
        updateConfig,
        startTileCapture,
        getTile: () => config.tile ? {
            ...config.tile
        }
         : null,
        getFishCount,
        findFishingRod,
        config,
    };
};

/**
 * ==================================================================================
 * STACKER MODULE – excludes container items, but processes their contents
 * (No console spam)
 * ==================================================================================
 */
window.__minibiaBotBundle.installAutoStackerModule = function installAutoStackerModule(bot) {
    const configStorageKey = "minibiaBot.autostacker.config";
    const state = {
        running: false,
        timerId: null,
        convertTimerId: null,
    };

    const config = Object.assign({
        enabled: false,
        tickMs: 5000,
        convertCurrency: false,
        excludedItemIds: [2853, 3504, 2854],
    }, bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, {
            ...config
        });
    }

    function getContainers() {
        const containers = window.gameClient?.player?.__openedContainers;
        if (!containers)
            return [];

        let arr;
        if (Array.isArray(containers))
            arr = containers;
        else if (containers instanceof Set)
            arr = Array.from(containers);
        else if (containers instanceof Map)
            arr = Array.from(containers.values());
        else if (typeof containers === "object")
            arr = Object.values(containers);
        else
            return [];

        return arr;
    }

    function moveItemsInContainer(container, fromSlot, toSlot, count) {
        if (!container || fromSlot === toSlot || count <= 0)
            return false;
        try {
            const from = {
                which: container,
                index: fromSlot
            };
            const to = {
                which: container,
                index: toSlot
            };
            if (window.gameClient?.mouse?.sendItemMove) {
                window.gameClient.mouse.sendItemMove(from, to, count);
                return true;
            }
            if (window.gameClient?.send && typeof ItemMovePacket === "function") {
                window.gameClient.send(new ItemMovePacket(from, to, count));
                return true;
            }
            if (window.gameClient?.mouse?.__handleItemMove) {
                window.gameClient.mouse.__handleItemMove(from, to, count);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function useItem(container, slot) {
        if (!container || slot == null)
            return false;
        try {
            if (window.gameClient?.mouse?.use) {
                window.gameClient.mouse.use({
                    which: container,
                    index: slot
                });
                return true;
            }
            if (window.gameClient?.send && typeof UsePacket === "function") {
                try {
                    window.gameClient.send(new UsePacket(container, slot));
                } catch (e) {
                    window.gameClient.send(new UsePacket({
                            which: container,
                            index: slot
                        }));
                }
                return true;
            }
            if (window.gameClient?.mouse?.__handleUse) {
                window.gameClient.mouse.__handleUse({
                    which: container,
                    index: slot
                });
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function convertCurrencyNow() {
        const containers = getContainers();
        if (!containers.length)
            return false;

        const GOLD_ID = 3031;
        const PLATINUM_ID = 3035;
        const FULL_STACK = 100;
        const excluded = config.excludedItemIds || [];
        let usedAny = false;

        for (const container of containers) {
            const size = container.size || container.slots?.length || 0;
            for (let slot = 0; slot < size; slot++) {
                const item = container.getSlotItem(slot);
                if (!item)
                    continue;
                if (excluded.includes(item.id))
                    continue;

                const id = item.id;
                const count = item.count || 1;

                let shouldConvert = false;
                if (id === GOLD_ID && count === FULL_STACK)
                    shouldConvert = true;
                if (id === PLATINUM_ID && count === FULL_STACK)
                    shouldConvert = true;

                if (shouldConvert) {
                    const used = useItem(container, slot);
                    if (used)
                        usedAny = true;
                }
            }
        }
        return usedAny;
    }

    function stackItems() {
        if (!config.enabled)
            return false;
        const containers = getContainers();
        if (!containers.length)
            return false;

        const excluded = config.excludedItemIds || [];
        let movedAny = false;

        for (const container of containers) {
            const itemMap = new Map();
            const size = container.size || container.slots?.length || 0;

            for (let slot = 0; slot < size; slot++) {
                const item = container.getSlotItem(slot);
                if (!item)
                    continue;
                if (excluded.includes(item.id))
                    continue;

                const id = item.id;
                const count = item.count || 1;
                if (!itemMap.has(id))
                    itemMap.set(id, []);
                itemMap.get(id).push({
                    slot,
                    count
                });
            }

            for (const [itemId, stacks] of itemMap) {
                if (stacks.length <= 1)
                    continue;
                stacks.sort((a, b) => b.count - a.count);
                const maxStack = 100;

                for (let i = 0; i < stacks.length; i++) {
                    const target = stacks[i];
                    if (target.count >= maxStack)
                        continue;
                    let room = maxStack - target.count;

                    for (let j = i + 1; j < stacks.length; j++) {
                        const source = stacks[j];
                        if (source.count === 0)
                            continue;
                        const moveCount = Math.min(source.count, room);
                        if (moveCount <= 0)
                            continue;

                        const moved = moveItemsInContainer(container, source.slot, target.slot, moveCount);
                        if (moved) {
                            movedAny = true;
                            source.count -= moveCount;
                            target.count += moveCount;
                            room -= moveCount;
                            if (room <= 0)
                                break;
                        }
                    }
                }
            }
        }

        // ★ Removed the log – no more console spam
        // Only log if you want to debug, but for now we keep it silent.
        return movedAny;
    }

    function scheduleConvertTick() {
        if (!config.convertCurrency)
            return;
        state.convertTimerId = window.setTimeout(() => {
            try {
                convertCurrencyNow();
            } catch (e) { /* ignore */
            } finally {
                scheduleConvertTick();
            }
        }, config.tickMs);
    }

    function startConvertLoop() {
        if (state.convertTimerId)
            return;
        config.convertCurrency = true;
        persistConfig();
        bot.log("ConvertCurrency loop started");
        scheduleConvertTick();
    }

    function stopConvertLoop() {
        if (state.convertTimerId) {
            clearTimeout(state.convertTimerId);
            state.convertTimerId = null;
        }
        config.convertCurrency = false;
        persistConfig();
        bot.log("ConvertCurrency loop stopped");
    }

    function scheduleStackTick() {
        if (!state.running)
            return;
        state.timerId = window.setTimeout(() => {
            try {
                stackItems();
            } catch (e) { /* ignore */
            } finally {
                scheduleStackTick();
            }
        }, config.tickMs);
    }

    function start() {
        if (state.running)
            return false;
        config.enabled = true;
        persistConfig();
        state.running = true;
        bot.log("AutoStacker started (excluded item IDs: " + (config.excludedItemIds || []).join(", ") + ")");
        stackItems();
        scheduleStackTick();
        return true;
    }

    function stop(options = {}) {
        const shouldPersist = options.persistEnabled !== false;
        state.running = false;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (shouldPersist) {
            config.enabled = false;
            persistConfig();
        }
        bot.log("AutoStacker stopped");
        return true;
    }

    function status() {
        return {
            running: state.running,
            config: {
                ...config
            },
            convertLoopRunning: !!state.convertTimerId,
        };
    }

    function updateConfig(next) {
        if (next.excludedItemIds !== undefined) {
            next.excludedItemIds = Array.isArray(next.excludedItemIds)
                 ? next.excludedItemIds.map(id => Number(id)).filter(Number.isFinite)
                 : [2853, 3504, 2854];
        }
        if (next.convertCurrency !== undefined && next.convertCurrency !== config.convertCurrency) {
            if (next.convertCurrency)
                startConvertLoop();
            else
                stopConvertLoop();
        }
        Object.assign(config, next);
        persistConfig();

        if (config.enabled && !state.running)
            start();
        if (!config.enabled && state.running)
            stop();

        return {
            ...config
        };
    }

    if (config.convertCurrency)
        startConvertLoop();
    if (config.enabled)
        start();

    bot.autoStacker = {
        start,
        stop,
        status,
        updateConfig,
        config,
        stackItems,
        convertCurrencyNow,
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
        .split(/\n/) // split by newline
        .map(s => s.trim()) // trim whitespace
        .filter(Boolean) // remove empty lines
        .filter((name, idx, arr) =>
            arr.findIndex(o => o.toLowerCase() === name.toLowerCase()) === idx); // deduplicate (case-insensitive)
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

        // --- CHANGE: join with newline instead of comma ---
        if (input && (force || document.activeElement !== input)) {
            input.value = preferred.join("\n");
        }

        if (modeSelect)
            modeSelect.value = mode;
        if (statusLabel) {
            const names = preferred.length ? preferred.join(", ") : "none";
            const modeText = mode === "includes" ? "contains text" : "exact name";
            statusLabel.textContent = `Preferred mobs: ${names} | Mode: ${modeText}`;
        }
    }

    function refreshAutoAttackIgnoredStatus(options = {}) {
        const force = options.force === true;
        const input = document.getElementById("minibia-bot-auto-attack-ignored-names");
        const statusLabel = document.getElementById("minibia-bot-auto-attack-ignored-status");
        const attackConfig = bot.attack?.status?.().config || bot.attack?.config || {};
        const ignored = Array.isArray(attackConfig.ignoredTargetNames) ? attackConfig.ignoredTargetNames : [];

        // --- CHANGE: join with newline instead of comma ---
        if (input && (force || document.activeElement !== input)) {
            input.value = ignored.join("\n");
        }

        if (statusLabel) {
            statusLabel.textContent = ignored.length ? `Ignored: ${ignored.join(", ")}` : "Ignored: none";
        }
    }

    function refreshAntiBotStatus() {
        const toggle = document.getElementById("minibia-bot-antibot-enabled");
        if (!toggle)
            return;
        const status = bot.antiBotMonitor?.status?.();
        if (status) {
            toggle.checked = status.running;
        } else {
            toggle.checked = false;
        }
    }

    // ---- Paladin UI ----
    function refreshPaladinStatus() {
        const toggle = document.getElementById("minibia-bot-paladin-enabled");
        const statusLabel = document.getElementById("minibia-bot-paladin-status");
        const ammoLabel = document.getElementById("minibia-bot-paladin-ammo");
        const handCountLabel = document.getElementById("minibia-bot-paladin-hand-count");
        const status = bot.paladin?.status?.();

        if (toggle && document.activeElement !== toggle) {
            toggle.checked = !!status?.running;
        }
        if (statusLabel) {
            statusLabel.textContent = status?.running ? "Status: running" : "Status: idle";
        }
        if (ammoLabel) {
            ammoLabel.textContent = status?.ammoCount ?? 0;
        }
        if (handCountLabel) {
            // Get left hand count
            const eq = window.gameClient?.player?.equipment;
            let leftHandCount = 0;
            if (eq) {
                const leftItem = eq.getSlotItem(5); // LEFT_HAND_SLOT
                const weaponId = bot.paladin?.config?.weaponId;
                if (leftItem && leftItem.id === weaponId) {
                    leftHandCount = leftItem.count || 1;
                }
            }
            handCountLabel.textContent = leftHandCount;
        }
    }

    // ---- Looter UI ----
    function refreshLooterStatus() {
        const toggle = document.getElementById("minibia-bot-looter-enabled");
        const statusLabel = document.getElementById("minibia-bot-looter-status");
        const destLabel = document.getElementById("minibia-bot-looter-dest-status");
        const listContainer = document.getElementById("minibia-bot-looter-item-list");

        const status = bot.looter?.status?.();
        if (toggle && document.activeElement !== toggle) {
            toggle.checked = !!status?.running;
        }
        if (statusLabel) {
            statusLabel.textContent = status?.running ? "Status: running" : "Status: idle";
        }
        if (destLabel) {
            const destId = bot.looter?.getDestinationId?.();
            destLabel.textContent = destId ? `Destination: container ${destId}` : "No destination selected";
        }

        // Render tracked items
        if (listContainer) {
            const items = bot.looter?.getTrackedItems?.() || [];
            listContainer.innerHTML = "";
            if (!items.length) {
                const empty = document.createElement("div");
                empty.className = "mb-small-note";
                empty.textContent = "No items tracked.";
                listContainer.appendChild(empty);
            } else {
                for (const [id, name] of items) {
                    const row = document.createElement("div");
                    row.className = "mb-list-row";
                    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);";
                    const label = document.createElement("span");
                    label.textContent = `${name} (${id})`;
                    const removeBtn = document.createElement("button");
                    removeBtn.type = "button";
                    removeBtn.className = "mb-small-button";
                    removeBtn.textContent = "✕";
                    removeBtn.style.cssText = "width:24px;padding:2px;background:#5a2020;color:#ff8888;border-color:#883030;";
                    removeBtn.addEventListener("click", () => {
                        bot.looter.removeTrackedItem(id);
                        refreshLooterStatus();
                    });
                    row.appendChild(label);
                    row.appendChild(removeBtn);
                    listContainer.appendChild(row);
                }
            }
        }
    }

    function refreshPinkSkullStatus() {
        const toggle = document.getElementById("minibia-bot-pink-skull-enabled");
        if (toggle)
            toggle.checked = !!bot.pinkSkull?.status?.().running;
    }

    function saveAutoAttackPreferredConfig() {
        const input = document.getElementById("minibia-bot-auto-attack-preferred-names");
        const modeSelect = document.getElementById("minibia-bot-auto-attack-preferred-match-mode");
        const preferred = parsePreferredTargetNames(input?.value || "");
        const mode = modeSelect?.value === "includes" ? "includes" : "exact";
        bot.attack?.updateConfig?.({
            preferredTargetNames: preferred,
            preferredMatchMode: mode
        });
        refreshAutoAttackPreferredStatus({
            force: true
        });
        bot.log?.("auto attack preferred targets updated", {
            preferredTargetNames: preferred,
            preferredMatchMode: mode
        });
    }

    function saveAutoAttackIgnoredConfig() {
        const input = document.getElementById("minibia-bot-auto-attack-ignored-names");
        const ignored = parsePreferredTargetNames(input?.value || ""); // Reuse the existing parser
        bot.attack?.updateConfig?.({
            ignoredTargetNames: ignored
        });
        refreshAutoAttackIgnoredStatus({
            force: true
        });
        bot.log?.("auto attack ignored targets updated", {
            ignoredTargetNames: ignored
        });
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
        return {
            slot,
            spellWords: spell,
            manaCost,
            minHp,
            maxHp,
            minMana,
            maxMana
        };
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
        if (!list)
            return;
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
                bot.heal.updateConfig({
                    healRules: current
                });
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
        if (values.slot < 1 || values.slot > 12) {
            bot.log("Slot must be 1-12.");
            return;
        }
        if (values.minHp < 0 || values.minHp > 100 || values.maxHp < 0 || values.maxHp > 100) {
            bot.log("HP % must be 0-100.");
            return;
        }
        if (values.minHp > values.maxHp) {
            bot.log("Min HP cannot be greater than Max HP.");
            return;
        }
        if (values.minMana < 0 || values.minMana > 100 || values.maxMana < 0 || values.maxMana > 100) {
            bot.log("MP % must be 0-100.");
            return;
        }
        if (values.minMana > values.maxMana) {
            bot.log("Min MP cannot be greater than Max MP.");
            return;
        }
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
        const rules = (bot.heal?.config?.healRules || []).slice();
        if (healEditIndex !== null)
            rules[healEditIndex] = newRule;
        else
            rules.push(newRule);
        bot.heal.updateConfig({
            healRules: rules
        });
        refreshHealRules();
        refreshAutoHealStatus();
        clearHealRuleForm();
    }

    function refreshAutoHealStatus() {
        const toggle = document.getElementById("minibia-bot-auto-heal-enabled");
        if (toggle)
            toggle.checked = !!bot.heal?.status?.().running;
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
        const kiteToggle = document.getElementById("minibia-bot-auto-attack-kite");
        const idealDistInput = document.getElementById("minibia-bot-auto-attack-ideal-dist");
        if (kiteToggle)
            kiteToggle.checked = attackConfig.kiteMode !== false;
        if (idealDistInput && document.activeElement !== idealDistInput) {
            idealDistInput.value = attackConfig.idealDistance ?? 3;
        }
        if (inputs.enabled)
            inputs.enabled.checked = !!status?.running;
        if (inputs.melee)
            inputs.melee.checked = attackConfig.meleeMode !== false;
        if (inputs.hotkey && document.activeElement !== inputs.hotkey) {
            inputs.hotkey.value = String(attackConfig.targetHotbarSlot ?? 3);
        }
        if (inputs.runeHotkey && document.activeElement !== inputs.runeHotkey) {
            inputs.runeHotkey.value = attackConfig.runeHotbarSlot ? String(attackConfig.runeHotbarSlot) : "";
        }
        if (inputs.maxDist && document.activeElement !== inputs.maxDist) {
            inputs.maxDist.value = attackConfig.maxTargetDistance ?? 5;
        }
        if (inputs.antiKS)
            inputs.antiKS.checked = attackConfig.antiKSEnabled !== false;
        if (inputs.antiKSSelf && document.activeElement !== inputs.antiKSSelf) {
            inputs.antiKSSelf.value = attackConfig.antiKSSelfRange ?? 2;
        }
        if (inputs.antiKSOther && document.activeElement !== inputs.antiKSOther) {
            inputs.antiKSOther.value = attackConfig.antiKSOtherRange ?? 2;
        }
        refreshAutoAttackPreferredStatus();
        if (typeof refreshTitlebarRunIndicators === "function")
            refreshTitlebarRunIndicators();
    }

    // ---- PANIC / HOME / XRAY / etc. ----
    function refreshHomeLabel() {
        const label = document.getElementById("minibia-bot-home");
        if (!label)
            return;
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
        if (unknown)
            unknown.checked = !!status?.config?.unknownPlayerEnabled;
        if (health)
            health.checked = !!status?.config?.healthLossEnabled;
        if (ret)
            ret.checked = !!status?.config?.returnToOriginEnabled;
        if (alertToggle)
            alertToggle.checked = !!status?.config?.playerAlertEnabled;
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
        if (overlayBtn)
            overlayBtn.textContent = status?.config?.overlayEnabled ? "Disable Overlay" : "Enable Overlay";
        if (overlayLabel) {
            const floorLabel = status?.config?.selectedFloor == null
                 ? "all floors"
                 : (me ? (me.z - status.config.selectedFloor) : "?");
            overlayLabel.textContent = `${status?.config?.overlayEnabled ? "Overlay: on" : "Overlay: off"} • ${floorLabel}`;
        }
        if (floorSelect) {
            const floors = Array.from(new Set((status?.visibleCreatures || []).map(c => c?.position?.z).filter(z => z != null)))
                .sort((a, b) => a - b);
            const selected = status?.config?.selectedFloor;
            if (selected != null && !floors.includes(selected))
                floors.push(selected);
            floors.sort((a, b) => a - b);
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
        if (!list)
            return;
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
                bot.panic.updateConfig({
                    trustedNames: next
                });
                renderTrustedNames();
            });
            row.appendChild(label);
            row.appendChild(removeBtn);
            list.appendChild(row);
        });
    }

    function renderGameMasterNames() {
        const list = document.getElementById("minibia-bot-panic-gm-list");
        if (!list)
            return;
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
                bot.panic.updateConfig({
                    gameMasterNames: next
                });
                renderGameMasterNames();
            });
            row.appendChild(label);
            row.appendChild(removeBtn);
            list.appendChild(row);
        });
    }

    function refreshRuneStatus() {
        const toggle = document.getElementById("minibia-bot-rune-enabled");
        if (toggle)
            toggle.checked = !!bot.rune?.status?.().running;
    }

    function refreshAutoEatStatus() {
        const toggle = document.getElementById("minibia-bot-auto-eat-enabled");
        if (toggle)
            toggle.checked = !!bot.eat?.status?.().running;

        // Also update the hotkey input if it exists and isn't focused
        const hotkeyInput = document.getElementById("minibia-bot-auto-eat-hotkey");
        if (hotkeyInput && document.activeElement !== hotkeyInput) {
            hotkeyInput.value = bot.eat?.config?.eatHotbarSlot ?? 10;
        }
    }

    function refreshAutoInvisibleStatus() {
        const toggle = document.getElementById("minibia-bot-auto-invisible-enabled");
        if (toggle)
            toggle.checked = !!bot.invisible?.status?.().running;
    }

    function refreshAutoMagicShieldStatus() {
        const toggle = document.getElementById("minibia-bot-auto-magic-shield-enabled");
        if (toggle)
            toggle.checked = !!bot.magicShield?.status?.().running;
    }

    function refreshEquipRingStatus() {
        const toggle = document.getElementById("minibia-bot-equip-ring-enabled");
        if (toggle)
            toggle.checked = !!bot.equipRing?.status?.().running;
    }

    function refreshTalkStatus() {
        const toggle = document.getElementById("minibia-bot-talk-enabled");
        const label = document.getElementById("minibia-bot-talk-status");
        const status = bot.talk?.status?.();

        // Only update checkbox if it's not currently focused (to avoid flicker)
        if (toggle && document.activeElement !== toggle) {
            toggle.checked = !!status?.running;
        }

        if (label) {
            if (!status?.config?.apiKey) {
                label.textContent = "Status: API key missing";
            } else if (status?.pending) {
                label.textContent = "Status: generating";
            } else if (status?.running) {
                label.textContent = "Status: listening to Default";
            } else {
                label.textContent = "Status: idle";
            }
        }
    }

    function refreshTalkIgnoredPhrases() {
        const input = document.getElementById("minibia-bot-talk-ignored");
        if (!input)
            return;
        const phrases = bot.talk?.config?.ignoredPhrases || [];
        input.value = phrases.join(", ");
    }

    function saveTalkIgnoredPhrases() {
        const input = document.getElementById("minibia-bot-talk-ignored");
        if (!input)
            return;
        const raw = input.value.trim();
        const phrases = raw.split(/[,;]/).map(p => p.trim().toLowerCase()).filter(Boolean);
        bot.talk.updateConfig({
            ignoredPhrases: phrases
        });
        refreshTalkIgnoredPhrases();
    }

    function refreshLightHackStatus() {
        const toggle = document.getElementById("minibia-bot-light-hack-enabled");
        if (toggle)
            toggle.checked = !!bot.lightHack?.status?.().running;
    }

    // ---- CAVE UI ----

    function getDirectionOffset(dir) {
        const offsets = {
            NW: {
                dx: -1,
                dy: -1
            },
            N: {
                dx: 0,
                dy: -1
            },
            NE: {
                dx: 1,
                dy: -1
            },
            W: {
                dx: -1,
                dy: 0
            },
            C: {
                dx: 0,
                dy: 0
            },
            E: {
                dx: 1,
                dy: 0
            },
            SW: {
                dx: -1,
                dy: 1
            },
            S: {
                dx: 0,
                dy: 1
            },
            SE: {
                dx: 1,
                dy: 1
            }
        };
        return offsets[dir] || {
            dx: 0,
            dy: 0
        };
    }

    function refreshCavePresetControls() {
        const select = document.getElementById("minibia-bot-cave-preset-select");
        const label = document.getElementById("minibia-bot-cave-preset-status");
        const delBtn = document.getElementById("minibia-bot-cave-preset-delete");
        const status = bot.cave?.status?.();
        // ★ Get the list and sort it alphabetically (case-insensitive)
        let names = status?.presetNames || bot.cave?.getPresetNames?.() || [];
        names = [...names].sort((a, b) => a.localeCompare(b, undefined, {
                sensitivity: 'base'
            }));
        const active = status?.activePresetName || bot.cave?.getActivePresetName?.() || "Default";

        if (select) {
            const prev = select.value;
            select.innerHTML = "";
            if (!names.length) {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "No saved presets";
                select.appendChild(opt);
                select.disabled = true;
            } else {
                names.forEach(n => {
                    const opt = document.createElement("option");
                    opt.value = n;
                    opt.textContent = n;
                    select.appendChild(opt);
                });
                select.disabled = false;
                // Set value: prefer active, fallback to prev selection or first in list
                select.value = names.includes(active) ? active : (prev && names.includes(prev) ? prev : names[0]);
            }
        }
        if (label)
            label.textContent = names.length ? `Preset: ${active} (${names.length} saved)` : `Preset: ${active}`;
        if (delBtn)
            delBtn.disabled = !names.length || !select?.value;
    }

    function refreshCaveClosestStatus() {
        const label = document.getElementById("minibia-bot-cave-closest");
        if (!label)
            return;
        const pos = bot.getPlayerPosition?.();
        const route = bot.cave?.getRoute?.() || [];
        if (!pos) {
            label.textContent = "Closest start: current position unavailable";
            return;
        }
        if (!route.length) {
            label.textContent = "Closest start: no waypoints";
            return;
        }
        const idx = bot.cave?.findClosestWaypointIndex?.(pos) ?? 0;
        const wp = route[idx];
        if (!wp) {
            label.textContent = "Closest start: unavailable";
            return;
        }
        label.textContent = `Closest start: ${idx + 1}. ${wp.x}, ${wp.y}, ${wp.z}`;
    }

    function refreshCaveTransitionStatus() {
        const label = document.getElementById("minibia-bot-cave-transition-status");
        if (!label)
            return;
        const trans = bot.cave?.getTransitions?.() || [];
        if (!trans.length) {
            label.textContent = "Transitions learned: none";
            return;
        }
        const latest = trans.slice().sort((a, b) => (b?.lastSeenAt || 0) - (a?.lastSeenAt || 0))[0];
        if (!latest?.from || !latest?.to) {
            label.textContent = `Transitions learned: ${trans.length}`;
            return;
        }
        const extra = trans.length > 1 ? ` (+${trans.length - 1} more)` : "";
        label.textContent = `Transitions learned: ${latest.from.x}, ${latest.from.y}, ${latest.from.z} -> ${latest.to.x}, ${latest.to.y}, ${latest.to.z}${extra}`;
    }

    // ---- CAVE WAYPOINT LIST ----
    let selectedWaypointIndex = null;

    function refreshCaveWaypointList() {
        const container = document.getElementById("minibia-bot-cave-waypoint-list");
        if (!container)
            return;
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
            num.textContent = `${idx + 1}.`;
            num.style.cssText = "font-weight:bold;min-width:20px;";
            const coords = document.createElement("span");
            let displayText = "";
            // For normal waypoints with coordinates
            if (wp.x !== undefined && wp.x !== null) {
                displayText = `${wp.x}, ${wp.y}, ${wp.z}`;
            }
            // If it has a label, use it as title
            if (wp.label) {
                if (displayText) {
                    displayText = wp.label + ' (' + displayText + ')';
                } else {
                    displayText = wp.label;
                }
            }
            // If no coords and no label, it's a script-only without label – show as "Script"
            if (!displayText) {
                displayText = "Script";
            }
            if (wp.stand) {
                displayText = "📍 " + displayText;
            }
            if (wp.rope) {
                displayText = "🪢 " + displayText;
            }
            if (wp.shovel) {
                displayText = "⛏️ " + displayText;
            }
            if (wp.ladder) {
                displayText = "🪜 " + displayText;
            }
            if (wp.script) {
                displayText += ' 📜';
            }
            coords.textContent = displayText;
            if (idx === current)
                coords.style.cssText = "color:#ffcf5a;font-weight:bold;";
            const distSpan = document.createElement("span");
            distSpan.style.cssText = "margin-left:auto;font-size:10px;opacity:0.6;";
            const pos = bot.getPlayerPosition?.();
            if (pos && wp.z === pos.z) {
                const dx = Math.abs(pos.x - wp.x),
                dy = Math.abs(pos.y - wp.y);
                distSpan.textContent = `dist ${dx + dy}`;
            }
            row.appendChild(num);
            row.appendChild(coords);
            row.appendChild(distSpan);
            row.addEventListener("click", () => {
                container.querySelectorAll("[data-selected]").forEach(el => el.dataset.selected = "false");
                row.dataset.selected = "true";
                selectedWaypointIndex = idx;
                const wp = route[idx];
                const labelInput = document.getElementById("minibia-bot-cave-waypoint-label");
                const scriptInput = document.getElementById("minibia-bot-cave-waypoint-script");
                if (labelInput)
                    labelInput.value = wp.label || "";
                if (scriptInput)
                    scriptInput.value = wp.script || "";
                bot.cave.setCurrentIndex(idx);
                if (bot.cave?.status?.().running)
                    bot.cave.goToWaypoint(route[idx]);
                refreshCaveStatus();
                refreshCaveWaypointList();
                refreshTitlebarRunIndicators();
                scrollToSelectedWaypoint(); // <-- added
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

    function scrollToSelectedWaypoint() {
        const container = document.getElementById("minibia-bot-cave-waypoint-list");
        if (!container)
            return;
        if (selectedWaypointIndex === null || selectedWaypointIndex < 0)
            return;
        const rows = container.querySelectorAll("[data-index]");
        if (selectedWaypointIndex < rows.length) {
            const row = rows[selectedWaypointIndex];
            if (row) {
                row.scrollIntoView({
                    block: "nearest",
                    behavior: "smooth"
                });
            }
        }
    }

    function moveSelectedWaypoint(direction) {
        if (selectedWaypointIndex === null) {
            bot.log("No waypoint selected. Click a waypoint first.");
            return;
        }
        const route = bot.cave?.getRoute?.() || [];
        if (selectedWaypointIndex < 0 || selectedWaypointIndex >= route.length)
            return;
        if (direction === "up" && selectedWaypointIndex === 0)
            return;
        if (direction === "down" && selectedWaypointIndex === route.length - 1)
            return;
        let moved = false;
        if (direction === "up") {
            moved = bot.cave.moveWaypointUp(selectedWaypointIndex);
            if (moved)
                selectedWaypointIndex--;
        } else {
            moved = bot.cave.moveWaypointDown(selectedWaypointIndex);
            if (moved)
                selectedWaypointIndex++;
        }
        if (moved) {
            refreshCaveWaypointList();
            refreshCaveStatus();
            refreshCaveClosestStatus();
            refreshCaveTransitionStatus();
        }
    }

    function deleteSelectedWaypoint() {
        if (selectedWaypointIndex === null) {
            bot.log("No waypoint selected.");
            return;
        }
        const route = bot.cave?.getRoute?.() || [];
        if (selectedWaypointIndex < 0 || selectedWaypointIndex >= route.length)
            return;
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
        if (toggle)
            toggle.checked = !!status?.running;
        if (label) {
            if (!route.length)
                label.textContent = "Status: no waypoints";
            else if (status?.running) {
                const wpNum = (status.currentIndex ?? 0) + 1;
                const dist = Number.isFinite(status?.distanceToWaypoint) && status.distanceToWaypoint >= 0 ? `, dist ${status.distanceToWaypoint}` : "";
                label.textContent = `Status: running (${wpNum}/${route.length}${dist})`;
            } else {
                label.textContent = `Status: idle (${route.length} waypoint${route.length === 1 ? "" : "s"})`;
            }
        }
    }

    function refreshAntiAfkStatus() {
        const toggle = document.getElementById("minibia-bot-antiafk-enabled");
        const intervalInput = document.getElementById("minibia-bot-antiafk-interval");
        if (!bot.antiAfk) {
            if (toggle)
                toggle.checked = false;
            if (intervalInput)
                intervalInput.value = "60";
            return;
        }
        const status = bot.antiAfk.status();
        if (toggle && document.activeElement !== toggle) {
            toggle.checked = !!status.running;
        }
        if (intervalInput && document.activeElement !== intervalInput) {
            intervalInput.value = Math.round((status.config?.intervalMs || 60000) / 1000);
        }
    }

    function refreshPlayerAttackStatus() {
        const toggle = document.getElementById("minibia-bot-player-attack-alert");
        if (toggle && document.activeElement !== toggle) {
            toggle.checked = !!bot.playerAttackMonitor?.status?.().running;
        }
    }

    function refreshMessageAlertStatus() {
        const toggle = document.getElementById("minibia-bot-message-alert");
        if (toggle && document.activeElement !== toggle) {
            toggle.checked = !!bot.messageAlert?.status?.().running;
        }
    }

    // ---- VISIBLE CREATURES LIST ----
    function refreshVisibleCreatures() {
        const list = document.getElementById("minibia-bot-visible-creatures-list");
        if (!list)
            return;
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
                if (floor == null)
                    return false;
                if (selectedFloor != null)
                    return floor === selectedFloor;
                return floor !== me.z;
            })
            .sort((a, b) => {
                const fd = getFloorDist(a) - getFloorDist(b);
                if (fd !== 0)
                    return fd;
                const fo = getFloorOffset(a) - getFloorOffset(b);
                if (fo !== 0)
                    return fo;
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
            row.appendChild(name);
            row.appendChild(meta);
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
        if (!panel)
            return;
        const body = panel.querySelector(".mb-body");
        const toggle = panel.querySelector("#minibia-bot-collapse");
        const next = !!collapsed;
        panel.dataset.collapsed = next ? "true" : "false";
        if (body)
            body.hidden = next;
        if (toggle) {
            toggle.textContent = next ? "+" : "−";
            toggle.setAttribute("aria-label", next ? "Maximize panel" : "Minimize panel");
            toggle.title = next ? "Maximize" : "Minimize";
        }
        savePanelCollapsed(next);
    }

    function applySavedPanelPosition(panel, key = panelPositionKey) {
        const pos = getSavedPanelPosition(key);
        if (!pos)
            return;
        if (typeof pos.top === "number")
            panel.style.top = `${pos.top}px`;
        if (typeof pos.left === "number") {
            panel.style.left = `${pos.left}px`;
            panel.style.right = "auto";
        }
    }

    function clampPanelPosition(panel, left, top) {
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
        return {
            left: Math.min(Math.max(0, left), maxLeft),
            top: Math.min(Math.max(0, top), maxTop)
        };
    }

    function enableDrag(panel, key = panelPositionKey) {
        const handle = panel.querySelector(".mb-title");
        if (!handle)
            return;
        let dragState = null;
        const onMouseMove = (e) => {
            if (!dragState)
                return;
            const next = clampPanelPosition(panel, e.clientX - dragState.offsetX, e.clientY - dragState.offsetY);
            panel.style.left = `${next.left}px`;
            panel.style.top = `${next.top}px`;
            panel.style.right = "auto";
        };
        const onMouseUp = () => {
            if (!dragState)
                return;
            dragState = null;
            const rect = panel.getBoundingClientRect();
            savePanelPosition({
                left: rect.left,
                top: rect.top
            }, key);
        };
        handle.addEventListener("mousedown", (e) => {
            if (e.button !== 0)
                return;
            const rect = panel.getBoundingClientRect();
            dragState = {
                offsetX: e.clientX - rect.left,
                offsetY: e.clientY - rect.top
            };
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
        if (!panel)
            return;
        const btn = panel.querySelector("#minibia-bot-collapsed-stop");
        if (!btn)
            return;
        btn.style.display = panel.dataset.collapsed === "true" ? "" : "none";
    }

    // ---- TITLE BAR RUN INDICATORS (clickable) ----
    function refreshTitlebarRunIndicators() {
        const panel = document.getElementById("minibia-bot-panel");
        if (!panel)
            return;
        const caveInd = panel.querySelector("#minibia-bot-title-cave-status");
        const attackInd = panel.querySelector("#minibia-bot-title-attack-status");
        let caveRunning = false,
        attackRunning = false;
        try {
            caveRunning = !!bot.cave?.status?.().running;
        } catch {}
        try {
            attackRunning = !!bot.attack?.status?.().running;
        } catch {}
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
        try {
            bot.cave?.stop?.();
        } catch (e) {
            console.warn("[minibia-bot-ui] failed to stop cave", e);
        }
        try {
            bot.attack?.stop?.();
        } catch (e) {
            console.warn("[minibia-bot-ui] failed to stop attack", e);
        }
        try {
            refreshCaveStatus?.();
            refreshAutoAttackStatus?.();
            refreshTitlebarRunIndicators?.();
        } catch {}
    }

    // ---- INJECT THE PANEL ----
    function inject() {
        destroy();

        // Inject styles
        const style = document.createElement("style");
        style.id = "minibia-bot-style";
        style.textContent = `
      /* ── Base Panel ── */
      #minibia-bot-panel {
        position: fixed;
        z-index: 999999;
        top: 16px;
        right: 16px;
        width: 560px;
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 32px);
        border: 1px solid #000;
        border-radius: 0;
        box-shadow: 0px 0px 10px 0px #000;
        background-image: url("/png/bg.png");
        background-color: #1a1612;
        color: #dcdcdc;
        font: 12px/1.35 Verdana, "Sans-Serif", sans-serif;
        user-select: none;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* ── Header ── */
      #minibia-bot-panel .mb-titlebar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background-image: url("/png/bg2.png");
        background-color: #2a241e;
        border-bottom: 1px solid #000;
        flex-shrink: 0;
        cursor: grab;
        min-height: 28px;
      }

      #minibia-bot-panel .mb-title {
        margin: 0;
        font-weight: bold;
        font-size: 13px;
        color: #ffcc00;
        text-shadow: 0 0 2px #000, 0 0 2px #000;
        letter-spacing: 1px;
        flex: 0 0 auto;
      }

      #minibia-bot-panel .mb-title-status {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1 1 auto;
        justify-content: flex-end;
        min-width: 0;
      }

      #minibia-bot-panel .mb-run-indicator {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border: 1px solid #444;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.5);
        color: #999;
        font-size: 10px;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s, color 0.15s;
      }

      #minibia-bot-panel .mb-run-indicator:hover {
        border-color: #888;
        background: rgba(255, 255, 255, 0.06);
      }

      #minibia-bot-panel .mb-run-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #555;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
        transition: background 0.2s, box-shadow 0.2s;
      }

      #minibia-bot-panel .mb-run-indicator[data-running="true"] {
        color: #c8ffc8;
        border-color: rgba(90, 220, 120, 0.5);
        background: rgba(20, 70, 28, 0.3);
      }

      #minibia-bot-panel .mb-run-indicator[data-running="true"] .mb-run-dot {
        background: #39e86f;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 8px rgba(57, 232, 111, 0.7);
      }

      #minibia-bot-panel .mb-title-actions {
        display: flex;
        gap: 4px;
        flex: 0 0 auto;
      }

      #minibia-bot-panel .mb-title-actions button {
        width: 24px;
        min-width: 24px;
        height: 24px;
        padding: 0;
        margin: 0;
        border: 1px solid #444;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.4);
        color: #ccc;
        font-size: 14px;
        font-weight: bold;
        line-height: 1;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s, color 0.15s;
      }

      #minibia-bot-panel .mb-title-actions button:hover {
        border-color: #888;
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      #minibia-bot-panel .mb-collapsed-stop-button {
        color: #ff8888;
        border-color: #663333;
      }

      #minibia-bot-panel .mb-collapsed-stop-button:hover {
        border-color: #ff6666;
        background: rgba(255, 0, 0, 0.12);
        color: #ffaaaa;
      }

      /* ── Collapsed state ── */
      #minibia-bot-panel[data-collapsed="true"] {
        width: 260px;
      }

      #minibia-bot-panel[data-collapsed="true"] .mb-body {
        display: none !important;
      }

      #minibia-bot-panel[data-collapsed="true"] .mb-titlebar {
        border-bottom: none;
      }

      /* ── Body (tabs + content) ── */
      #minibia-bot-panel .mb-body {
        display: grid;
        grid-template-columns: 110px 1fr;
        gap: 0;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }

      /* ── Tab Menu ── */
      #minibia-bot-panel .mb-tab-menu {
        display: flex;
        flex-direction: column;
        gap: 0;
        background-image: url("/png/bg2.png");
        background-color: #1e1a16;
        border-right: 1px solid #000;
        padding: 4px 0;
        overflow-y: auto;
        flex-shrink: 0;
      }

      #minibia-bot-panel .mb-tab-button {
        display: block;
        width: 100%;
        padding: 6px 8px;
        border: none;
        border-bottom: 1px solid rgba(0, 0, 0, 0.3);
        background: transparent;
        color: #aaa;
        font-size: 10px;
        font-weight: bold;
        text-align: left;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.1s, color 0.1s;
        border-radius: 0;
        margin: 0;
      }

      #minibia-bot-panel .mb-tab-button:hover {
        background: rgba(255, 255, 255, 0.06);
        color: #ddd;
      }

      #minibia-bot-panel .mb-tab-button[data-active="true"] {
        background-image: url("/png/bg.png");
        background-color: #2a241e;
        color: #ffcc00;
        border-right: 2px solid #ffcc00;
        box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.5);
      }

      /* ── Tab Content ── */
      #minibia-bot-panel .mb-tab-content {
        padding: 8px 10px;
        overflow-y: auto;
        background-image: url("/png/bg.png");
        background-color: #1a1612;
        flex: 1 1 auto;
        min-height: 0;
      }

      #minibia-bot-panel .mb-tab-panel {
        display: none;
        gap: 8px;
      }

      #minibia-bot-panel .mb-tab-panel[data-active="true"] {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      /* ── Sections ── */
      #minibia-bot-panel .mb-section {
        padding: 10px 12px;
        border: 1px solid rgba(0, 0, 0, 0.6);
        background-image: url("/png/bg2.png");
        background-color: #1e1a16;
        box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.4);
        border-radius: 0;
      }

      #minibia-bot-panel .mb-label {
        margin: 0 0 8px 0;
        color: #ffcc00;
        font-weight: bold;
        font-size: 12px;
        text-shadow: 0 0 2px #000;
        letter-spacing: 0.5px;
      }

      #minibia-bot-panel .mb-small-note {
        color: #999;
        font-size: 10px;
        line-height: 1.4;
        margin: 2px 0;
      }

      #minibia-bot-panel .mb-note {
        color: #bbb;
        font-size: 11px;
        line-height: 1.4;
      }

      /* ── Form Elements ── */
      #minibia-bot-panel .mb-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      #minibia-bot-panel .mb-field-label {
        color: #c8b88a;
        font-size: 10px;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }

      #minibia-bot-panel input,
      #minibia-bot-panel textarea,
      #minibia-bot-panel select {
        width: 100%;
        box-sizing: border-box;
        padding: 5px 8px;
        border: 1px solid #222;
        border-radius: 0;
        background-image: url("/png/bg3.png");
        background-color: #0d0b0a;
        color: #eee;
        font: inherit;
        font-size: 11px;
        box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.6);
        outline: none;
        transition: border-color 0.15s;
      }

      #minibia-bot-panel input:focus,
      #minibia-bot-panel textarea:focus,
      #minibia-bot-panel select:focus {
        border-color: #c8a84e;
        box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.6), 0 0 4px rgba(200, 168, 78, 0.3);
      }

      #minibia-bot-panel input::placeholder,
      #minibia-bot-panel textarea::placeholder {
        color: #666;
      }

      #minibia-bot-panel textarea {
        min-height: 50px;
        resize: vertical;
        font-size: 11px;
      }

      #minibia-bot-panel select {
        appearance: none;
        -webkit-appearance: none;
        background-image: url("/png/bg3.png"), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='6'%3E%3Cpath d='M0 0l4 6 4-6z' fill='%23999'/%3E%3C/svg%3E");
        background-repeat: repeat, no-repeat;
        background-position: 0 0, right 8px center;
        padding-right: 24px;
        cursor: pointer;
      }

      /* ── Checkboxes (Toggle style) ── */
      #minibia-bot-panel .mb-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        color: #dcdcdc;
        font-size: 11px;
        cursor: pointer;
        user-select: none;
        padding: 2px 0;
      }

      #minibia-bot-panel .mb-toggle input[type="checkbox"] {
        width: 14px;
        height: 14px;
        margin: 0;
        flex: 0 0 14px;
        accent-color: #c8a84e;
        cursor: pointer;
        background: transparent;
        border: 1px solid #555;
        box-shadow: none;
        padding: 0;
      }

      #minibia-bot-panel .mb-toggle-main {
        font-weight: bold;
        font-size: 12px;
        color: #eee;
      }

      /* ── Buttons ── */
      #minibia-bot-panel button {
        padding: 6px 12px;
        border: 1px solid #222;
        border-radius: 0;
        background-image: url("/png/bg3.png");
        background-color: #2a241e;
        color: #eee;
        font-size: 10px;
        font-weight: bold;
        font-family: inherit;
        cursor: pointer;
        margin: 0;
        transition: border-color 0.15s, background 0.15s, color 0.15s;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      }

      #minibia-bot-panel button:hover {
        border-color: #888;
        background-image: url("/png/bg2.png");
        background-color: #3a322a;
        color: #fff;
      }

      #minibia-bot-panel button:active {
        transform: scale(0.98);
      }

      #minibia-bot-panel .mb-small-button {
        padding: 4px 10px;
        font-size: 10px;
        width: auto;
        flex: 0 0 auto;
      }

      #minibia-bot-panel .mb-button-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      #minibia-bot-panel .mb-form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      #minibia-bot-panel .mb-inline {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      #minibia-bot-panel .mb-inline > * {
        flex: 1 1 auto;
        min-width: 0;
      }

      #minibia-bot-panel .mb-inline > button {
        flex: 0 0 auto;
      }

      #minibia-bot-panel .mb-utility-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 6px;
        align-items: end;
      }

      /* ── Lists ── */
      #minibia-bot-panel .mb-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 140px;
        overflow-y: auto;
        padding-right: 4px;
        margin: 4px 0;
      }

      #minibia-bot-panel .mb-list-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 3px 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 11px;
        color: #ccc;
        gap: 6px;
      }

      #minibia-bot-panel .mb-list-row > span {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #minibia-bot-panel .mb-list-row > button {
        flex: 0 0 auto;
        padding: 2px 6px;
        font-size: 10px;
      }

      /* ── Creature rows ── */
      #minibia-bot-panel .mb-creature-row {
        padding: 4px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }

      #minibia-bot-panel .mb-creature-name {
        color: #e8e0d0;
        font-weight: bold;
        font-size: 11px;
      }

      #minibia-bot-panel .mb-floor-label {
        color: #c8a84e;
        font-size: 10px;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 4px 0 2px 4px;
        border-bottom: 1px solid rgba(200, 168, 78, 0.2);
      }

      /* ── Scrollbars ── */
      #minibia-bot-panel ::-webkit-scrollbar {
        width: 12px;
        background: #1a1a1a;
      }

      #minibia-bot-panel ::-webkit-scrollbar-thumb {
        background: #666;
        border: 2px solid #1a1a1a;
        border-radius: 0;
      }

      #minibia-bot-panel ::-webkit-scrollbar-thumb:hover {
        background: #888;
      }

      #minibia-bot-panel ::-webkit-scrollbar-corner {
        background: #1a1a1a;
      }

      #minibia-bot-panel .mb-list::-webkit-scrollbar,
      #minibia-bot-panel .mb-tab-content::-webkit-scrollbar,
      #minibia-bot-panel .mb-tab-menu::-webkit-scrollbar {
        width: 8px;
      }

      #minibia-bot-panel .mb-list::-webkit-scrollbar-thumb,
      #minibia-bot-panel .mb-tab-content::-webkit-scrollbar-thumb,
      #minibia-bot-panel .mb-tab-menu::-webkit-scrollbar-thumb {
        background: #555;
        border: 1px solid #222;
      }

      /* Firefox scrollbar */
      #minibia-bot-panel {
        scrollbar-color: #666 #1a1a1a;
        scrollbar-width: thin;
      }

      /* ── Misc ── */
      #minibia-bot-panel .mb-stack {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      #minibia-bot-panel .mb-mini-field {
        width: 80px;
      }

      #minibia-bot-panel hr {
        border: 0;
        height: 1px;
        background: linear-gradient(to right, transparent, #444, transparent);
        margin: 6px 0;
      }

      /* ── Mobile responsive ── */
      @media (max-width: 700px) {
        #minibia-bot-panel {
          width: min(540px, calc(100vw - 16px));
          max-height: calc(100vh - 16px);
          top: 8px;
          right: 8px;
        }

        #minibia-bot-panel .mb-body {
          grid-template-columns: 1fr;
          grid-template-rows: auto 1fr;
        }

        #minibia-bot-panel .mb-tab-menu {
          flex-direction: row;
          flex-wrap: wrap;
          padding: 2px 4px;
          border-right: none;
          border-bottom: 1px solid #000;
          overflow-x: auto;
          gap: 2px;
          background-image: url("/png/bg2.png");
        }

        #minibia-bot-panel .mb-tab-button {
          padding: 4px 8px;
          font-size: 9px;
          border-bottom: none;
          border-right: 1px solid rgba(0, 0, 0, 0.3);
          flex: 0 0 auto;
          width: auto;
          text-align: center;
        }

        #minibia-bot-panel .mb-tab-button[data-active="true"] {
          border-right: 2px solid #ffcc00;
          border-bottom: none;
        }

        #minibia-bot-panel .mb-tab-content {
          padding: 6px 8px;
        }

        #minibia-bot-panel .mb-form-grid,
        #minibia-bot-panel .mb-button-grid {
          grid-template-columns: 1fr;
        }

        #minibia-bot-panel .mb-utility-row {
          grid-template-columns: 1fr;
        }

        #minibia-bot-panel .mb-inline {
          flex-wrap: wrap;
        }

        #minibia-bot-panel .mb-title-status .mb-run-label {
          display: none;
        }

        #minibia-bot-panel[data-collapsed="true"] {
          width: 200px;
        }
      }

      @media (max-width: 420px) {
        #minibia-bot-panel {
          width: calc(100vw - 8px);
          top: 4px;
          right: 4px;
          max-height: calc(100vh - 8px);
        }

        #minibia-bot-panel .mb-title {
          font-size: 11px;
        }

        #minibia-bot-panel .mb-tab-button {
          font-size: 8px;
          padding: 3px 6px;
        }

        #minibia-bot-panel .mb-section {
          padding: 6px 8px;
        }
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
    <button type="button" class="mb-tab-button" data-tab-button="panic">Alerts</button>
    <button type="button" class="mb-tab-button" data-tab-button="utility">Utility</button>
    <button type="button" class="mb-tab-button" data-tab-button="cave">Cavebot</button>
    <button type="button" class="mb-tab-button" data-tab-button="targeting">Targeting</button>
	<button type="button" class="mb-tab-button" data-tab-button="paladin">Paladin Utility</button>
	<button type="button" class="mb-tab-button" data-tab-button="looter">Looter</button>
	<button type="button" class="mb-tab-button" data-tab-button="training">Training</button>
	<button type="button" class="mb-tab-button" data-tab-button="profiles">Profiles</button>
    <button type="button" class="mb-tab-button" data-tab-button="talk">Talk</button>
    <button type="button" class="mb-tab-button" data-tab-button="xray">Xray</button>
	<button type="button" class="mb-tab-button" data-tab-button="blacklist">Blacklisted Tiles</button>
  <button type="button" class="mb-tab-button" data-tab-button="combo">PVP</button>
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
    <div class="mb-stack">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px 32px;">
        <!-- Left Column -->
        <div style="display:flex; flex-direction:column; gap:10px;">
      
        <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-player-alert" /><span>Player On Screen Alert</span></label>
        <label class="mb-toggle"><input type="checkbox" id="minibia-bot-player-attack-alert" /><span>Player Attack Alert</span></label>
        
        </div>
        <!-- Right Column -->
        <div style="display:flex; flex-direction:column; gap:10px;">

        <label class="mb-toggle"><input type="checkbox" id="minibia-bot-antibot-enabled" /><span>Anti-Bot Alert</span></label>
        <label class="mb-toggle"><input type="checkbox" id="minibia-bot-message-alert" /><span>Message Alert</span></label>

        </div>
      </div>

        <div style="display:flex;gap:6px;align-items:center;"><label style="font-size:11px;color:#e9d39b;">Alert Cooldown (s)</label><input type="number" id="minibia-bot-panic-player-cooldown" min="10" value="10" style="width:60px;padding:2px 4px" /></div>
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
	  
      <div class="mb-section">
        <div class="mb-label" id="minibia-bot-home">Panic Runner Home: not set</div>
          <div class="mb-stack">
            <button type="button" id="minibia-bot-set-home">Set Home</button>
            <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-unknown" /><span>Unknown Player</span></label>
            <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-health" /><span>Healthloss</span></label>
            <label class="mb-toggle"><input type="checkbox" id="minibia-bot-panic-return" /><span>Auto Return to Position</span></label>
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

  <!-- Utility Modules -->
  <div class="mb-section" style="padding:12px 16px;">
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px 32px;">
      <!-- Left Column -->
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-auto-eat-enabled" /><span>Eat Food</span></label>
          <label class="mb-field" style="flex:0 0 60px;">
            <input type="number" id="minibia-bot-auto-eat-hotkey" min="1" max="12" placeholder="10" style="padding:4px 4px;font-size:12px;text-align:center;" />
          </label>
        </div>
        <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-auto-invisible-enabled" /><span>Invisible</span></label>
        <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-light-hack-enabled" /><span>Light Hack</span></label>
		<!-- Anti-AFK (Full Width) -->
		<label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-antiafk-enabled" /><span>Anti-AFK</span></label>
		<label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-autostacker-enabled" /><span>Auto Stacker</span></label>
	  
      </div>
      <!-- Right Column -->
      <div style="display:flex; flex-direction:column; gap:10px;">
        <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-auto-magic-shield-enabled" /><span>Utamo Vita</span></label>
        <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-equip-ring-enabled" /><span>Equip Ring</span></label>
        <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-pink-skull-enabled" /><span>Pink Skull</span></label>
		<label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-reconnect-enabled" /><span>Auto‑Reconnect</span></label>
		<label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-autostacker-convert-currency" /><span>Convert Currency</span></label>
      </div>
    </div>





    <!-- Fisher (Full Width) -->
    <div style="display:flex; align-items:center; gap:14px; margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.08); flex-wrap:wrap;">
      <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-fisher-enabled" /><span>Fisher</span></label>
      <button type="button" class="mb-small-button" id="minibia-bot-fisher-select-tile" style="padding:4px 14px;font-size:11px;">Set Tile</button>
      <span style="font-size:12px; color:#cdbb8b; min-width:80px;" id="minibia-bot-fisher-tile-display">none</span>
      <label class="mb-field" style="flex:0 0 72px;">
        <span class="mb-field-label" style="font-size:10px;">Delay (s)</span>
        <input type="number" id="minibia-bot-fisher-delay" min="0.5" step="0.5" value="2" style="padding:4px 4px;font-size:12px;text-align:center;" />
      </label>
      <label class="mb-field" style="flex:0 0 64px;">
        <span class="mb-field-label" style="font-size:10px;">Fish Cap</span>
        <input type="number" id="minibia-bot-fisher-threshold" min="1" value="10" style="padding:4px 4px;font-size:12px;text-align:center;" />
      </label>
      <span style="font-size:12px; color:#cdbb8b;">Fish: <span id="minibia-bot-fisher-count" style="font-weight:bold; color:#fff;">0</span></span>
    </div>
    
    <!-- Outfit Randomizer -->
    <div style="display:flex; align-items:center; gap:14px; margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08); flex-wrap:wrap;">
      <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-outfit-randomizer-enabled" /><span>Random Outfit</span></label>
      <label class="mb-field" style="flex:0 0 80px;">
        <span class="mb-field-label" style="font-size:10px;">Interval(m)</span>
        <input type="number" id="minibia-bot-outfit-randomizer-interval" min="1" value="5" style="padding:4px 4px;font-size:12px;text-align:center;" />
      </label>
      <button type="button" class="mb-small-button" id="minibia-bot-outfit-randomizer-now" style="padding:4px 14px;font-size:11px;">Randomize Now</button>
      <span style="font-size:11px; color:#cdbb8b;" id="minibia-bot-outfit-randomizer-status">Idle</span>
    </div>
    
  </div>
</div>

<!-- Cave Tab -->
<div class="mb-tab-panel" data-tab-panel="cave">
  <div class="mb-section">

    <!-- Header -->
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
      <div class="mb-label" style="margin:0;">Cave Bot</div>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-loop" /> Loop</label>
        <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-auto-transitions" /> Auto Transitions</label>
        <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-toggle" /> Enable</label>
      </div>
    </div>

    <!-- Presets -->
    <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
      <select id="minibia-bot-cave-preset-select" style="flex:1; padding:4px 6px; font-size:11px;"></select>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-new" style="padding:2px 8px; font-size:10px;">New</button>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-delete" style="padding:2px 8px; font-size:10px;">Del</button>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-preset-rename" style="padding:2px 8px; font-size:10px;">Rename</button>
    </div>

    <!-- Controls -->
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:6px;">
      <div style="display:flex; align-items:center; gap:4px;">
        <label style="font-size:11px; color:#e9d39b;">Direction</label>
        <select id="minibia-bot-cave-direction" style="padding:2px; font-size:11px;">
          <option value="NW">NW</option><option value="N">N</option><option value="NE">NE</option>
          <option value="W">W</option><option value="C" selected>C</option><option value="E">E</option>
          <option value="SW">SW</option><option value="S">S</option><option value="SE">SE</option>
        </select>
      </div>
	  
      <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-stand" /> Stand</label>
	  
	  <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-rope" /> Rope</label>
	  
	  <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-shovel" /> Shovel</label>
	  
	  <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-cave-ladder" /> Ladder</label>
	  
    </div>
	
	

    <!-- Buttons -->
    <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:4px; margin-bottom:6px;">
      <button type="button" class="mb-small-button" id="minibia-bot-cave-add" style="padding:4px;">+ Add</button>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-add-script" style="padding:4px;">+ Script</button>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-move-up" style="padding:4px;">▲</button>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-move-down" style="padding:4px;">▼</button>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-delete-selected" style="padding:4px; background:#5a2020; border-color:#883030;">✕</button>
    </div>

    <!-- Waypoint list -->
    <div style="margin-bottom:6px;">
      <!-- Row 1: WPT | SKIP + input -->
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
        <div class="mb-label" style="font-size:11px; margin:0 0 4px;">Waypoints</div>
        <span style="color:#666;">|</span>
        <label style="font-size:11px; color:#e9d39b; white-space:nowrap;">Skip sqm</label>
        <input type="number" id="minibia-bot-cave-tolerance" min="0" max="5" step="1" value="0" style="width:50px; padding:2px 4px; font-size:11px;" />
      </div>
      <div id="minibia-bot-cave-waypoint-list" style="max-height:120px; overflow-y:auto; border:1px solid rgba(224,200,148,0.2); border-radius:4px; padding:2px; font-size:11px;"></div>
    </div>

    <!-- Waypoint properties – exact match -->
    <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:6px; margin-top:4px;">
      <div class="mb-label" style="font-size:11px;">Waypoint Properties</div>
      <!-- Row 1: Script | Label + input -->
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
        <span style="font-size:11px; color:#e9d39b; font-weight:bold;">Script</span>
        <span style="color:#666;">|</span>
        <label style="font-size:11px; color:#e9d39b; white-space:nowrap;">Label</label>
        <input type="text" id="minibia-bot-cave-waypoint-label" placeholder="Optional label" style="flex:1; padding:4px 6px; font-size:11px;" />
      </div>
      <!-- Row 2: Script textarea -->
      <div>
        <textarea id="minibia-bot-cave-waypoint-script" placeholder="Code to run when reached" rows="2" style="width:100%; resize:vertical; padding:4px 6px; font-size:11px; box-sizing:border-box;"></textarea>
      </div>
      <button type="button" class="mb-small-button" id="minibia-bot-cave-waypoint-save" style="margin-top:4px;">Save</button>
    </div>

    <!-- Status -->
    <div style="font-size:10px; color:#cdbb8b; margin-top:6px; display:grid; gap:2px;">
      <div id="minibia-bot-cave-status">Status: no waypoints</div>
      <div id="minibia-bot-cave-closest">Closest start: none</div>
      <div id="minibia-bot-cave-transition-status">Transitions learned: none</div>
    </div>

  </div>
</div>

<!-- Targeting Tab -->
<div class="mb-tab-panel" data-tab-panel="targeting">
  <!-- Auto Attack -->
  <div class="mb-section" style="padding:8px 10px;">
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-auto-attack-enabled" /><span>Enable</span></label>
      <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-auto-attack-melee" /><span>Melee</span></label>
	  <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-auto-attack-client-chase" /><span>Client Chase</span></label>
      <label class="mb-field" style="flex:0 0 80px;"><span class="mb-field-label" style="font-size:10px;">Target</span><input type="number" id="minibia-bot-auto-attack-hotkey" min="1" max="12" placeholder="3" style="padding:3px 4px;font-size:11px;" /></label>
      <label class="mb-field" style="flex:0 0 80px;"><span class="mb-field-label" style="font-size:10px;">Rune</span><input type="number" id="minibia-bot-auto-attack-rune-hotkey" min="1" max="12" placeholder="4" style="padding:3px 4px;font-size:11px;" /></label>
    </div>
  </div>

  <!-- Combat Settings -->
  <div class="mb-section" style="padding:6px 10px;">
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <label class="mb-field" style="flex:0 0 90px;"><span class="mb-field-label" style="font-size:10px;">Max Dist</span><input type="number" id="minibia-bot-auto-attack-maxdist" min="1" max="10" value="5" style="padding:3px 4px;font-size:11px;" /></label>
      <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-auto-attack-antiks" /><span>Anti-KS</span></label>
      <label class="mb-field" style="flex:0 0 70px;"><span class="mb-field-label" style="font-size:10px;">Self</span><input type="number" id="minibia-bot-auto-attack-antiks-self" min="1" max="5" value="2" style="padding:3px 4px;font-size:11px;" /></label>
      <label class="mb-field" style="flex:0 0 70px;"><span class="mb-field-label" style="font-size:10px;">Other</span><input type="number" id="minibia-bot-auto-attack-antiks-other" min="1" max="5" value="2" style="padding:3px 4px;font-size:11px;" /></label>
    </div>
  </div>

  <!-- Kite Mode -->
  <div class="mb-section" style="padding:6px 10px;">
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <label class="mb-toggle" style="margin:0; font-size:11px;"><input type="checkbox" id="minibia-bot-auto-attack-kite" /><span>Kite</span></label>
      <label class="mb-field" style="flex:0 0 80px;"><span class="mb-field-label" style="font-size:10px;">Ideal Dist</span><input type="number" id="minibia-bot-auto-attack-ideal-dist" min="1" max="10" value="3" style="padding:3px 4px;font-size:11px;" /></label>
    </div>
  </div>

  <!-- Target Priority -->
  <div class="mb-section" style="padding:6px 10px;">
    <div style="display:flex; gap:6px; align-items:end; flex-wrap:wrap;">
      <label class="mb-field" style="flex:1; min-width:100px;"><span class="mb-field-label" style="font-size:10px;">Preferred Mobs</span><textarea id="minibia-bot-auto-attack-preferred-names" placeholder="Orc Shaman, Amazon" style="min-height:28px;padding:3px 4px;font-size:11px;resize:vertical;"></textarea></label>
      <label class="mb-field" style="flex:0 0 110px;"><span class="mb-field-label" style="font-size:10px;">Match Mode</span><select id="minibia-bot-auto-attack-preferred-match-mode" style="padding:3px 4px;font-size:11px;"><option value="exact">Exact</option><option value="includes">Contains</option></select></label>
      <button type="button" class="mb-small-button" id="minibia-bot-auto-attack-preferred-save" style="padding:3px 10px;font-size:11px;width:auto;">Save</button>
    </div>
    <div style="display:flex; gap:8px; margin-top:4px; flex-wrap:wrap;">
      <div class="mb-small-note" id="minibia-bot-auto-attack-preferred-status" style="font-size:10px;">Preferred: none</div>
      <div class="mb-small-note" style="font-size:10px;">Ranked first, others allowed</div>
    </div>
  </div>
  
    <!-- Ignored Mobs (Blacklist) -->
  <div class="mb-section" style="padding:6px 10px;">
    <div style="display:flex; gap:6px; align-items:end; flex-wrap:wrap;">
      <label class="mb-field" style="flex:1; min-width:100px;">
        <span class="mb-field-label">Ignored Mobs (never attack)</span>
        <textarea id="minibia-bot-auto-attack-ignored-names" placeholder="Dragon, Demon, Orc Berserker" style="min-height:28px;padding:3px 4px;font-size:11px;resize:vertical;"></textarea>
      </label>
      <button type="button" class="mb-small-button" id="minibia-bot-auto-attack-ignored-save" style="padding:3px 10px;font-size:11px;width:auto;">Save</button>
    </div>
    <div class="mb-small-note" id="minibia-bot-auto-attack-ignored-status" style="font-size:10px;">Ignored: none</div>
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

<!-- Paladin Tab -->
<div class="mb-tab-panel" data-tab-panel="paladin">
  <div class="mb-section">
    <div class="mb-label">Paladin Utilities</div>
    <div class="mb-stack">
      <!-- Enable toggle -->
      <label class="mb-toggle mb-toggle-main">
        <input type="checkbox" id="minibia-bot-paladin-enabled" />
        <span>Enable</span>
      </label>

      <!-- Row 1: Ammo Threshold + Equip Threshold -->
      <div class="mb-form-grid">
        <label class="mb-field" for="minibia-bot-paladin-ammo-threshold">
          <span class="mb-field-label">Ammo Threshold</span>
          <input type="number" id="minibia-bot-paladin-ammo-threshold" min="0" value="15" />
        </label>
        <label class="mb-field" for="minibia-bot-paladin-equip-threshold">
          <span class="mb-field-label">Equip Threshold</span>
          <input type="number" id="minibia-bot-paladin-equip-threshold" min="0" value="10" />
        </label>
      </div>

      <!-- Row 2: Craft Spell Words + Craft Mana Cost -->
      <div class="mb-form-grid">
        <label class="mb-field" for="minibia-bot-paladin-craft-spell">
          <span class="mb-field-label">Craft Spell Words</span>
          <input type="text" id="minibia-bot-paladin-craft-spell" placeholder="exeta con" />
        </label>
        <label class="mb-field" for="minibia-bot-paladin-craft-mana">
          <span class="mb-field-label">Craft Mana Cost</span>
          <input type="number" id="minibia-bot-paladin-craft-mana" min="0" value="140" />
        </label>
      </div>

      <!-- Row 3: High Mana Spell + High Mana % -->
      <div class="mb-form-grid">
        <label class="mb-field" for="minibia-bot-paladin-high-mana-spell">
          <span class="mb-field-label">High Mana Spell</span>
          <input type="text" id="minibia-bot-paladin-high-mana-spell" placeholder="utani hur" />
        </label>
        <label class="mb-field" for="minibia-bot-paladin-high-mana-threshold">
          <span class="mb-field-label">High Mana %</span>
          <input type="number" id="minibia-bot-paladin-high-mana-threshold" min="0" max="100" value="98" />
        </label>
      </div>

      <!-- Row 4: Equip Weapon + Weapon ID + Equip Cooldown -->
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        <label class="mb-toggle" style="margin:0; flex:0 0 auto;">
          <input type="checkbox" id="minibia-bot-paladin-equip-weapon" />
          <span>Equip Weapon</span>
        </label>
        <label class="mb-field" style="flex:1; min-width:80px;">
          <span class="mb-field-label">Weapon ID</span>
          <input type="number" id="minibia-bot-paladin-weapon-id" placeholder="e.g., 3277" />
        </label>
        <label class="mb-field" style="flex:0 0 120px;">
          <span class="mb-field-label">Equip CD (MS)</span>
          <input type="number" id="minibia-bot-paladin-equip-cooldown" min="1000" value="5000" />
        </label>
      </div>

      <!-- Row 5: Buttons -->
      <div style="display:flex; gap:6px;">
        <button type="button" class="mb-small-button" id="minibia-bot-paladin-capture-weapon" style="flex:1;">Click to Capture</button>
        <button type="button" class="mb-small-button" id="minibia-bot-paladin-equip-now" style="flex:1;background:#2a4a2a;border-color:#3a7a3a;">Equip Now</button>
      </div>

      <!-- Status line -->
      <div style="display:flex; gap:16px; flex-wrap:wrap; font-size:11px; color:#cdbb8b; margin-top:4px;">
        <span id="minibia-bot-paladin-status">Status: idle</span>
        <span>Ammo count: <span id="minibia-bot-paladin-ammo">0</span></span>
        <span>Hand count: <span id="minibia-bot-paladin-hand-count">0</span></span>
      </div>
    </div>
  </div>
</div>

<!-- Looter Tab -->
<div class="mb-tab-panel" data-tab-panel="looter">
  <div class="mb-section">
    <div class="mb-label">Auto Looter</div>
    <div class="mb-stack">
      <label class="mb-toggle mb-toggle-main">
        <input type="checkbox" id="minibia-bot-looter-enabled" />
        <span>Enable Looter</span>
      </label>
      <div style="display:flex; gap:6px;">
        <button type="button" class="mb-small-button" id="minibia-bot-looter-select-dest" style="flex:1;">Set Destination</button>
        <button type="button" class="mb-small-button" id="minibia-bot-looter-capture-item" style="flex:1;">Track Item</button>
      </div>
      <div class="mb-small-note" id="minibia-bot-looter-dest-status">No destination selected</div>
      <div class="mb-label" style="font-size:12px; margin-top:4px;">Tracked Items</div>
      <div id="minibia-bot-looter-item-list" style="max-height:150px; overflow-y:auto; border:1px solid rgba(224,200,148,0.2); border-radius:4px; padding:4px; font-size:11px;"></div>
      <div style="display:flex; gap:6px; margin-top:4px;">
        <input type="text" id="minibia-bot-looter-manual-input" placeholder="Item name" style="flex:1;" />
        <button type="button" class="mb-small-button" id="minibia-bot-looter-manual-add">Add</button>
      </div>
      <div class="mb-small-note" id="minibia-bot-looter-status">Status: idle</div>
    </div>
  </div>
</div>

<!-- Profiles Tab -->
<div class="mb-tab-panel" data-tab-panel="profiles">
  <div class="mb-section">
    <div class="mb-label">Profile Manager</div>
    <div class="mb-stack">
      <!-- Save -->
      <div class="mb-inline">
        <input type="text" id="minibia-bot-profile-name" placeholder="Profile name" />
        <button type="button" class="mb-small-button" id="minibia-bot-profile-save">Save</button>
      </div>
      <!-- Load / Delete -->
      <div class="mb-inline">
        <select id="minibia-bot-profile-select" style="flex:1;">
          <option value="">-- Select profile --</option>
        </select>
        <button type="button" class="mb-small-button" id="minibia-bot-profile-load">Load</button>
        <button type="button" class="mb-small-button" id="minibia-bot-profile-delete" style="background:#5a2020;border-color:#883030;">Delete</button>
      </div>
      <!-- Export / Import -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; align-items:center;">
        <button type="button" class="mb-small-button" id="minibia-bot-profile-export">Export Selected</button>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="file" id="minibia-bot-profile-import-input" accept=".json" style="display:none;" />
          <button type="button" class="mb-small-button" id="minibia-bot-profile-import">Import</button>
          <input type="text" id="minibia-bot-profile-import-name" placeholder="Profile name (optional)" style="flex:1; padding:4px; font-size:11px;" />
        </div>
      </div>
      <div class="mb-small-note" id="minibia-bot-profile-status">Ready</div>
      <div class="mb-small-note">Saves ALL bot settings into a named profile. Export to file, import from file.</div>
      <!-- Waypoint Import/Export (NEW) -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; align-items:center; margin-top:4px;">
        <button type="button" class="mb-small-button" id="minibia-bot-profile-export-waypoints">Export Waypoints</button>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="file" id="minibia-bot-profile-import-waypoints-input" accept=".json" style="display:none;" />
          <button type="button" class="mb-small-button" id="minibia-bot-profile-import-waypoints">Import Waypoints</button>
        </div>
      </div>
      
    </div>
  </div>
</div>

<!-- Blacklist Tab -->
<div class="mb-tab-panel" data-tab-panel="blacklist">
  <div class="mb-section">
    <div class="mb-label">Tile Blacklist</div>
    <div class="mb-stack">
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="mb-small-button" id="minibia-bot-blacklist-add-current">Add Current Tile</button>
        <button type="button" class="mb-small-button" id="minibia-bot-blacklist-clear" style="background:#5a2020;border-color:#883030;">Clear All</button>
      </div>
      <div style="display:grid; grid-template-columns:70px 70px 70px auto; gap:6px; align-items:end;">
        <label class="mb-field"><span class="mb-field-label">X</span><input type="number" id="minibia-bot-blacklist-x" step="1" /></label>
        <label class="mb-field"><span class="mb-field-label">Y</span><input type="number" id="minibia-bot-blacklist-y" step="1" /></label>
        <label class="mb-field"><span class="mb-field-label">Z</span><input type="number" id="minibia-bot-blacklist-z" step="1" /></label>
        <button type="button" class="mb-small-button" id="minibia-bot-blacklist-add">Add Tile</button>
      </div>
      <div class="mb-small-note" id="minibia-bot-blacklist-count">0 tiles blocked</div>
      <div id="minibia-bot-blacklist-list" style="max-height:200px; overflow-y:auto; border:1px solid rgba(224,200,148,0.2); border-radius:4px; padding:4px; font-size:11px;"></div>
    </div>
  </div>
</div>


<!-- Training Tab -->
<div class="mb-tab-panel" data-tab-panel="training">
  <!-- ML Trainer -->
  <div class="mb-section" style="padding:12px 16px;">
    <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
      <label class="mb-toggle" style="margin:0; font-size:12px;"><input type="checkbox" id="minibia-bot-rune-enabled" /><span>ML Trainer</span></label>
      <label class="mb-field" style="flex:2; min-width:140px;">
        <span class="mb-field-label" style="font-size:10px;">Spell</span>
        <input type="text" id="minibia-bot-rune-spell" placeholder="adori vita vis" style="padding:6px 10px;font-size:12px;" />
      </label>
      <label class="mb-field" style="flex:0 0 100px;">
        <span class="mb-field-label" style="font-size:10px;">Mana Percent</span>
        <input type="number" id="minibia-bot-rune-mana" min="0" placeholder="600" style="padding:6px 10px;font-size:12px;" />
      </label>
    </div>
  </div>
  
  <div class="mb-section">
    <div class="mb-label">Slime Trainer</div>
    <div class="mb-stack">
      <label class="mb-toggle mb-toggle-main">
        <input type="checkbox" id="minibia-bot-slime-trainer-enabled" />
        <span>Enable Slime Trainer</span>
      </label>
      <div style="display:flex; gap:6px; align-items:center;">
        <button type="button" class="mb-small-button" id="minibia-bot-slime-trainer-capture">Select Mother Slime</button>
        <span style="font-size:11px; color:#cdbb8b;" id="minibia-bot-slime-trainer-mother-status">None selected</span>
      </div>
      <div class="mb-small-note" id="minibia-bot-slime-trainer-status">Status: idle</div>
      <div class="mb-small-note">Attacks adjacent slimes (except the mother slime). Stops when a GM is detected.</div>
    </div>
  </div>
</div>

<!-- Combo Tab -->
<div class="mb-tab-panel" data-tab-panel="combo">
  <div class="mb-section">
    <div class="mb-label">ComboBot</div>
    <div class="mb-stack">
      <!-- Mode selector -->
      <div class="mb-field">
        <span class="mb-field-label">Mode</span>
        <select id="minibia-bot-combo-mode">
          <option value="leader">Leader</option>
          <option value="follower">Follower</option>
        </select>
      </div>

      <!-- Enable toggle -->
      <label class="mb-toggle mb-toggle-main">
        <input type="checkbox" id="minibia-bot-combo-enabled" />
        <span>Enable ComboBot</span>
      </label>

      <!-- Hotkey slot -->
      <div class="mb-field">
        <span class="mb-field-label">Hotkey Slot (0=F1 – 11=F12)</span>
        <input type="number" id="minibia-bot-combo-slot" min="0" max="11" value="11" />
      </div>

      <!-- Minimum mana -->
      <div class="mb-field">
        <span class="mb-field-label">Minimum Mana</span>
        <input type="number" id="minibia-bot-combo-minmana" min="0" value="0" />
      </div>

      <!-- Cooldown -->
      <div class="mb-field">
        <span class="mb-field-label">Cooldown (ms)</span>
        <input type="number" id="minibia-bot-combo-cooldown" min="100" value="1500" />
      </div>

      <!-- Status -->
      <div class="mb-small-note" id="minibia-bot-combo-status">Status: idle</div>
    </div>
  </div>
      
  <!-- ★ NEW: Standalone Follow section -->
  <div class="mb-section" style="margin-top:8px;">
    <div class="mb-label">Auto Follow</div>
    <div class="mb-stack">
      <div class="mb-field">
        <span class="mb-field-label">Player Name</span>
        <input type="text" id="minibia-bot-follow-name" placeholder="Enter player name" />
      </div>
      <label class="mb-toggle mb-toggle-main">
        <input type="checkbox" id="minibia-bot-follow-enabled" />
        <span>Enable Auto Follow</span>
      </label>
      <div class="mb-small-note" id="minibia-bot-follow-status">Status: idle</div>
    </div>
  </div>
</div>


  </div> <!-- end mb-tab-content -->
</div> <!-- end mb-body -->
`;
        document.body.appendChild(panel);

        // ---- SETUP UI BEHAVIOR ----
        // Tab switching
        function setActiveBotTab(tabId) {
            panel.querySelectorAll(".mb-tab-button").forEach(btn => btn.dataset.active = btn.dataset.tabButton === tabId ? "true" : "false");
            panel.querySelectorAll(".mb-tab-panel").forEach(tp => tp.dataset.active = tp.dataset.tabPanel === tabId ? "true" : "false");
            try {
                localStorage.setItem("minibia-bot-active-tab", tabId);
            } catch {}
        }
        panel.querySelectorAll(".mb-tab-button").forEach(btn => {
            btn.addEventListener("click", () => setActiveBotTab(btn.dataset.tabButton));
        });
        const savedTab = (() => {
            try {
                return localStorage.getItem("minibia-bot-active-tab") || "healing";
            } catch {
                return "healing";
            }
        })();
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

        // ---- Standalone Follow (separate from ComboBot) ----
        const followNameInput = panel.querySelector("#minibia-bot-follow-name");
        const followToggle = panel.querySelector("#minibia-bot-follow-enabled");
        const followStatus = panel.querySelector("#minibia-bot-follow-status");

        let followInterval = null;
        let followEnabled = false;

        function refreshFollowStatus() {
            if (followToggle && document.activeElement !== followToggle) {
                followToggle.checked = followEnabled;
            }
            if (followStatus) {
                followStatus.textContent = followEnabled ? "Following..." : "Idle";
            }
        }

        function stopFollow() {
            if (followInterval) {
                clearInterval(followInterval);
                followInterval = null;
            }
            followEnabled = false;
            bot.stopFollow();
            refreshFollowStatus();
            // Persist state
            localStorage.setItem("minibiaBot.follow.enabled", JSON.stringify(false));
        }

        function startFollow() {
            const name = followNameInput?.value?.trim();
            if (!name) {
                bot.log("Follow: Please enter a player name.");
                if (followToggle)
                    followToggle.checked = false;
                return;
            }
            // Stop any existing follow
            if (followInterval) {
                clearInterval(followInterval);
                followInterval = null;
            }
            followEnabled = true;
            // Persist state
            localStorage.setItem("minibiaBot.follow.enabled", JSON.stringify(true));
            localStorage.setItem("minibiaBot.follow.name", name);
            // First attempt immediately
            bot.follow(name);
            // Then retry every 5 seconds
            followInterval = setInterval(() => {
                if (followEnabled) {
                    bot.follow(name);
                }
            }, 5000);
            refreshFollowStatus();
        }

        if (followToggle) {
            // Load saved state
            try {
                const saved = localStorage.getItem("minibiaBot.follow.enabled");
                const savedName = localStorage.getItem("minibiaBot.follow.name") || "";
                if (saved === "true") {
                    followToggle.checked = true;
                    if (followNameInput)
                        followNameInput.value = savedName;
                    startFollow();
                }
            } catch (e) {}

            followToggle.addEventListener("change", function () {
                if (this.checked) {
                    startFollow();
                } else {
                    stopFollow();
                }
            });
        }

        if (followNameInput) {
            followNameInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    if (followToggle)
                        followToggle.click();
                }
            });
            // Save name on change
            followNameInput.addEventListener("change", function () {
                if (followEnabled) {
                    // Restart follow with new name
                    startFollow();
                }
                localStorage.setItem("minibiaBot.follow.name", this.value.trim());
            });
        }

        // Clean up when bot reloads
        bot.addCleanup(() => {
            if (followInterval) {
                clearInterval(followInterval);
                followInterval = null;
            }
            followEnabled = false;
        });

        // ---- ComboBot: Leader Name & Auto Follow ----
        const comboLeaderName = panel.querySelector("#minibia-bot-combo-leader-name");
        const comboAutoFollow = panel.querySelector("#minibia-bot-combo-auto-follow");

        if (comboLeaderName) {
            comboLeaderName.addEventListener("change", function () {
                bot.comboBot.updateConfig({
                    leaderName: this.value
                });
                refreshComboStatus();
            });
        }

        if (comboAutoFollow) {
            comboAutoFollow.addEventListener("change", function () {
                bot.comboBot.updateConfig({
                    autoFollowLeader: this.checked
                });
                refreshComboStatus();
            });
        }

        // ---- ComboBot ----
        const comboMode = panel.querySelector("#minibia-bot-combo-mode");
        const comboToggle = panel.querySelector("#minibia-bot-combo-enabled");
        const comboSlot = panel.querySelector("#minibia-bot-combo-slot");
        const comboMinMana = panel.querySelector("#minibia-bot-combo-minmana");
        const comboCooldown = panel.querySelector("#minibia-bot-combo-cooldown");
        const comboStatus = panel.querySelector("#minibia-bot-combo-status");

        function refreshComboStatus() {
            const status = bot.comboBot?.status?.();
            if (!status)
                return;

            if (comboToggle && document.activeElement !== comboToggle) {
                comboToggle.checked = status.running;
            }
            if (comboMode && document.activeElement !== comboMode) {
                comboMode.value = status.config.mode || 'follower';
            }
            if (comboSlot && document.activeElement !== comboSlot) {
                comboSlot.value = status.config.hotkeySlot ?? 11;
            }
            if (comboMinMana && document.activeElement !== comboMinMana) {
                comboMinMana.value = status.config.minMana || 0;
            }
            if (comboCooldown && document.activeElement !== comboCooldown) {
                comboCooldown.value = status.config.cooldownMs || 1500;
            }
            if (comboStatus) {
                comboStatus.textContent = status.running ? `Running (${status.config.mode})` : "Idle";
            }
        }

        // Toggle
        if (comboToggle) {
            comboToggle.checked = !!bot.comboBot?.status?.().running;
            comboToggle.addEventListener("change", function () {
                if (this.checked) {
                    // Gather current settings
                    const mode = comboMode?.value || 'follower';
                    const slot = parseInt(comboSlot?.value) || 11;
                    const minMana = parseInt(comboMinMana?.value) || 0;
                    const cooldown = parseInt(comboCooldown?.value) || 1500;
                    bot.comboBot.updateConfig({
                        mode,
                        hotkeySlot: slot,
                        minMana,
                        cooldownMs: cooldown,
                    });
                    bot.comboBot.start();
                } else {
                    bot.comboBot.stop();
                }
                refreshComboStatus();
            });
        }

        // Mode change
        if (comboMode) {
            comboMode.addEventListener("change", function () {
                const mode = this.value;
                bot.comboBot.updateConfig({
                    mode
                });
                // If running, restart to apply mode
                if (bot.comboBot.status().running) {
                    bot.comboBot.stop();
                    bot.comboBot.start();
                }
                refreshComboStatus();
            });
        }

        // Slot change
        if (comboSlot) {
            comboSlot.addEventListener("change", function () {
                const val = Math.min(11, Math.max(0, parseInt(this.value) || 0));
                this.value = val;
                bot.comboBot.updateConfig({
                    hotkeySlot: val
                });
                refreshComboStatus();
            });
        }

        // Min mana change
        if (comboMinMana) {
            comboMinMana.addEventListener("change", function () {
                const val = Math.max(0, parseInt(this.value) || 0);
                this.value = val;
                bot.comboBot.updateConfig({
                    minMana: val
                });
                refreshComboStatus();
            });
        }

        // Cooldown change
        if (comboCooldown) {
            comboCooldown.addEventListener("change", function () {
                const val = Math.max(100, parseInt(this.value) || 100);
                this.value = val;
                bot.comboBot.updateConfig({
                    cooldownMs: val
                });
                refreshComboStatus();
            });
        }

        // Periodic refresh (every 2s)
        setInterval(refreshComboStatus, 2000);

        // ---- Outfit Randomizer ----
        const outfitToggle = panel.querySelector("#minibia-bot-outfit-randomizer-enabled");
        const outfitInterval = panel.querySelector("#minibia-bot-outfit-randomizer-interval");
        const outfitNow = panel.querySelector("#minibia-bot-outfit-randomizer-now");
        const outfitStatus = panel.querySelector("#minibia-bot-outfit-randomizer-status");

        function refreshOutfitRandomizerStatus() {
            const status = bot.outfitRandomizer?.status?.();
            if (!status)
                return;
            if (outfitToggle && document.activeElement !== outfitToggle) {
                outfitToggle.checked = status.running;
            }
            if (outfitInterval && document.activeElement !== outfitInterval) {
                outfitInterval.value = status.config.intervalMinutes || 5;
            }
            if (outfitStatus) {
                outfitStatus.textContent = status.running ? `Running (every ${status.config.intervalMinutes} min)` : "Idle";
            }
        }

        if (outfitToggle) {
            outfitToggle.checked = !!bot.outfitRandomizer?.status?.().running;
            outfitToggle.addEventListener("change", function () {
                if (this.checked) {
                    const interval = parseInt(outfitInterval?.value) || 5;
                    bot.outfitRandomizer.updateConfig({
                        enabled: true,
                        intervalMinutes: interval,
                    });
                } else {
                    bot.outfitRandomizer.stop();
                }
                refreshOutfitRandomizerStatus();
            });
        }

        if (outfitInterval) {
            outfitInterval.value = bot.outfitRandomizer?.config?.intervalMinutes || 5;
            outfitInterval.addEventListener("change", function () {
                const val = Math.max(1, parseInt(this.value) || 5);
                this.value = val;
                bot.outfitRandomizer.updateConfig({
                    intervalMinutes: val,
                });
                refreshOutfitRandomizerStatus();
            });
        }

        if (outfitNow) {
            outfitNow.addEventListener("click", function () {
                bot.outfitRandomizer.randomizeNow();
                refreshOutfitRandomizerStatus();
            });
        }

        // Refresh periodically (like other utility modules)
        setInterval(refreshOutfitRandomizerStatus, 5000);

        const playerAttackToggle = panel.querySelector("#minibia-bot-player-attack-alert");
        if (playerAttackToggle) {
            playerAttackToggle.checked = !!bot.playerAttackMonitor?.status?.().running;
            playerAttackToggle.addEventListener("change", function () {
                if (this.checked) {
                    bot.playerAttackMonitor.start();
                } else {
                    bot.playerAttackMonitor.stop();
                }
                refreshPlayerAttackStatus();
            });
        }

        const messageAlertToggle = panel.querySelector("#minibia-bot-message-alert");
        if (messageAlertToggle) {
            messageAlertToggle.checked = !!bot.messageAlert?.status?.().running;
            messageAlertToggle.addEventListener("change", function () {
                if (this.checked) {
                    bot.messageAlert.start();
                } else {
                    bot.messageAlert.stop();
                }
                refreshMessageAlertStatus();
            });
        }

        const addScriptBtn = panel.querySelector("#minibia-bot-cave-add-script");
        if (addScriptBtn) {
            addScriptBtn.addEventListener("click", () => {
                const wp = {
                    label: "Script",
                    script: "// Enter script code here\nbot.log('Hello from script!');"
                };
                const added = bot.cave.addWaypoint(wp);
                if (added) {
                    const route = bot.cave.getRoute();
                    selectedWaypointIndex = route.length - 1;
                    const wpData = route[selectedWaypointIndex];
                    const labelInput = document.getElementById("minibia-bot-cave-waypoint-label");
                    const scriptInput = document.getElementById("minibia-bot-cave-waypoint-script");
                    if (labelInput)
                        labelInput.value = wpData.label || "";
                    if (scriptInput)
                        scriptInput.value = wpData.script || "";
                    refreshCaveWaypointList();
                    refreshCaveStatus();
                    refreshCaveClosestStatus();
                    refreshCaveTransitionStatus();
                    refreshCavePresetControls();
                    scrollToSelectedWaypoint();
                    bot.log("Script waypoint added.");
                } else {
                    bot.log("Failed to add script waypoint.");
                }
            });
        }

        const saveWpBtn = panel.querySelector("#minibia-bot-cave-waypoint-save");
        if (saveWpBtn) {
            saveWpBtn.addEventListener("click", () => {
                const route = bot.cave.getRoute();
                if (selectedWaypointIndex === null || selectedWaypointIndex >= route.length) {
                    bot.log("No waypoint selected.");
                    return;
                }
                const labelInput = document.getElementById("minibia-bot-cave-waypoint-label");
                const scriptInput = document.getElementById("minibia-bot-cave-waypoint-script");
                const label = labelInput.value.trim() || undefined;
                const script = scriptInput.value.trim() || undefined;
                // Update the actual route via the new method
                bot.cave.updateWaypoint(selectedWaypointIndex, {
                    label,
                    script
                });
                // Refresh the list and status
                refreshCaveWaypointList();
                refreshCaveStatus();
                bot.log("Waypoint properties saved.");
            });
        }

        // ---- AutoStacker ----
        function refreshAutoStackerStatus() {
            const toggle = document.getElementById("minibia-bot-autostacker-enabled");
            if (!toggle)
                return;
            const status = bot.autoStacker?.status?.();
            toggle.checked = !!status?.running;
        }

        const autoStackerToggle = panel.querySelector("#minibia-bot-autostacker-enabled");
        if (autoStackerToggle) {
            autoStackerToggle.checked = !!bot.autoStacker?.status?.().running;
            autoStackerToggle.addEventListener("change", function () {
                if (this.checked) {
                    bot.autoStacker.start();
                } else {
                    bot.autoStacker.stop();
                }
                refreshAutoStackerStatus();
            });
        }

        // ---- AutoStacker currency conversion ----
        const convertCurrencyToggle = panel.querySelector("#minibia-bot-autostacker-convert-currency");
        if (convertCurrencyToggle) {
            convertCurrencyToggle.checked = bot.autoStacker?.config?.convertCurrency !== false;
            convertCurrencyToggle.addEventListener("change", function () {
                bot.autoStacker.updateConfig({
                    convertCurrency: this.checked
                });
            });
        }

        // ---- Rune trainer ----
        const runeEnabledInput = panel.querySelector("#minibia-bot-rune-enabled");
        const runeSpellInput = panel.querySelector("#minibia-bot-rune-spell");
        const runeManaInput = panel.querySelector("#minibia-bot-rune-mana");

        if (runeSpellInput) {
            runeSpellInput.value = bot.rune?.config?.runeSpellWords || "";
            runeSpellInput.addEventListener("change", () => {
                bot.rune.updateConfig({
                    runeSpellWords: runeSpellInput.value.trim()
                });
            });
        }

        if (runeManaInput) {
            runeManaInput.value = String(bot.rune?.config?.runeManaCost ?? 0);
            runeManaInput.addEventListener("change", () => {
                const mana = Math.max(0, Number(runeManaInput.value) || 0);
                runeManaInput.value = String(mana);
                bot.rune.updateConfig({
                    runeManaCost: mana
                });
            });
        }

        if (runeEnabledInput) {
            runeEnabledInput.checked = !!bot.rune?.status?.().running;
            runeEnabledInput.addEventListener("change", function () {
                const spell = runeSpellInput?.value?.trim() || bot.rune.config.runeSpellWords;
                const mana = Math.max(0, Number(runeManaInput?.value) || bot.rune.config.runeManaCost || 0);
                if (this.checked) {
                    bot.rune.start({
                        runeSpellWords: spell,
                        runeManaCost: mana
                    });
                } else {
                    bot.rune.stop();
                }
                refreshRuneStatus();
            });
        }

        // ---- Set Home button ----
        const setHomeBtn = panel.querySelector("#minibia-bot-set-home");
        if (setHomeBtn) {
            setHomeBtn.addEventListener("click", () => {
                bot.setHomePzCurrentSpot?.();
                refreshHomeLabel(); // updates the label right away
            });
        }

        const reconnectToggle = panel.querySelector("#minibia-bot-reconnect-enabled");
        if (reconnectToggle) {
            reconnectToggle.checked = bot.reconnect.isEnabled();
            reconnectToggle.addEventListener("change", function () {
                if (this.checked)
                    bot.reconnect.enable();
                else
                    bot.reconnect.disable();
            });
        }

        const antiBotToggle = panel.querySelector("#minibia-bot-antibot-enabled");
        if (antiBotToggle) {
            antiBotToggle.checked = !!bot.antiBotMonitor?.status?.().running;
            antiBotToggle.addEventListener("change", function () {
                if (this.checked) {
                    bot.antiBotMonitor.start();
                } else {
                    bot.antiBotMonitor.stop();
                }
            });
        }

        // ---- Slime Trainer UI ----
        function refreshSlimeTrainerStatus() {
            const toggle = document.getElementById("minibia-bot-slime-trainer-enabled");
            const statusLabel = document.getElementById("minibia-bot-slime-trainer-status");
            const motherStatus = document.getElementById("minibia-bot-slime-trainer-mother-status");
            const status = bot.slimeTrainer?.status?.();

            if (toggle && document.activeElement !== toggle) {
                toggle.checked = !!status?.running;
            }
            if (statusLabel) {
                statusLabel.textContent = status?.running ? "Status: running" : "Status: idle";
            }
            if (motherStatus) {
                const name = status?.motherSlimeName || "None";
                const id = status?.motherSlimeId ? `(ID: ${status.motherSlimeId})` : "";
                motherStatus.textContent = name !== "None" ? `${name} ${id}` : "None selected";
            }
        }

        // ---- Event listeners ----
        const slimeToggle = panel.querySelector("#minibia-bot-slime-trainer-enabled");
        const captureBtn = panel.querySelector("#minibia-bot-slime-trainer-capture");

        if (slimeToggle) {
            slimeToggle.checked = !!bot.slimeTrainer?.status?.().running;
            slimeToggle.addEventListener("change", function () {
                if (this.checked) {
                    bot.slimeTrainer.start();
                } else {
                    bot.slimeTrainer.stop();
                }
                refreshSlimeTrainerStatus();
            });
        }

        if (captureBtn) {
            captureBtn.addEventListener("click", () => {
                bot.slimeTrainer.startCaptureMotherSlime();
            });
        }

        // ---- Fisher ----
        const fisherToggle = panel.querySelector("#minibia-bot-fisher-enabled");
        const fisherSelectTile = panel.querySelector("#minibia-bot-fisher-select-tile");
        const fisherDelay = panel.querySelector("#minibia-bot-fisher-delay");
        const fisherThreshold = panel.querySelector("#minibia-bot-fisher-threshold");
        const fisherStatus = panel.querySelector("#minibia-bot-fisher-status");
        const fisherCountDisplay = panel.querySelector("#minibia-bot-fisher-count");

        function refreshFisherStatus() {
            if (!bot.fisher)
                return;
            const status = bot.fisher.status();
            if (fisherToggle && document.activeElement !== fisherToggle) {
                fisherToggle.checked = status.running;
            }
            if (fisherDelay && document.activeElement !== fisherDelay) {
                fisherDelay.value = (status.config.delayMs / 1000).toFixed(1);
            }
            if (fisherThreshold && document.activeElement !== fisherThreshold) {
                fisherThreshold.value = status.config.fishThreshold;
            }
            if (fisherStatus) {
                fisherStatus.textContent = status.running ? "Status: running" : "Status: idle";
            }
            if (fisherCountDisplay) {
                fisherCountDisplay.textContent = status.fishCount;
            }
            const tile = bot.fisher.getTile();
            const tileDisplay = document.getElementById("minibia-bot-fisher-tile-display");
            if (tileDisplay) {
                tileDisplay.textContent = tile ? `${tile.x}, ${tile.y}, ${tile.z}` : "No tile selected";
            }
        }

        if (fisherToggle) {
            fisherToggle.checked = !!bot.fisher?.status?.().running;
            fisherToggle.addEventListener("change", function () {
                if (this.checked) {
                    // Read values from UI
                    const delay = parseFloat(fisherDelay?.value) || 2;
                    const threshold = parseInt(fisherThreshold?.value) || 10;
                    bot.fisher.updateConfig({
                        delayMs: delay * 1000,
                        fishThreshold: threshold
                    });
                    bot.fisher.start();
                } else {
                    bot.fisher.stop();
                }
                refreshFisherStatus();
            });
        }

        if (fisherSelectTile) {
            fisherSelectTile.addEventListener("click", function () {
                if (bot.fisher && typeof bot.fisher.startTileCapture === 'function') {
                    bot.fisher.startTileCapture();
                } else {
                    bot.log("Fisher module not available. Please reload the bot.");
                }
            });
        }

        if (fisherDelay) {
            fisherDelay.addEventListener("change", function () {
                const val = Math.max(0.5, parseFloat(this.value) || 2);
                this.value = val.toFixed(1);
                bot.fisher.updateConfig({
                    delayMs: val * 1000
                });
            });
        }

        if (fisherThreshold) {
            fisherThreshold.addEventListener("change", function () {
                const val = Math.max(1, parseInt(this.value) || 10);
                this.value = val;
                bot.fisher.updateConfig({
                    fishThreshold: val
                });
            });
        }

        // Periodic refresh
        const fisherTimer = window.setInterval(refreshFisherStatus, 1000);
        bot.addCleanup(() => window.clearInterval(fisherTimer));

        // ---- Anti-AFK ----
        const antiAfkToggle = panel.querySelector("#minibia-bot-antiafk-enabled");
        const antiAfkInterval = panel.querySelector("#minibia-bot-antiafk-interval");

        if (antiAfkToggle) {
            antiAfkToggle.checked = !!bot.antiAfk?.status?.().running;
            antiAfkToggle.addEventListener("change", function () {
                if (!bot.antiAfk) {
                    bot.log("Anti-AFK module not installed – please reload the bot.");
                    this.checked = false;
                    return;
                }
                if (this.checked) {
                    bot.antiAfk.start();
                } else {
                    bot.antiAfk.stop();
                }
                refreshAntiAfkStatus();
            });
        }

        if (antiAfkInterval) {
            antiAfkInterval.value = Math.round((bot.antiAfk?.config?.intervalMs || 60000) / 1000);
            antiAfkInterval.addEventListener("change", function () {
                const sec = Math.max(10, Number(this.value) || 60);
                this.value = sec;
                bot.antiAfk.updateConfig({
                    intervalMs: sec * 1000
                });
            });
        }

        // ---- Blacklist ----
        const blacklistX = panel.querySelector("#minibia-bot-blacklist-x");
        const blacklistY = panel.querySelector("#minibia-bot-blacklist-y");
        const blacklistZ = panel.querySelector("#minibia-bot-blacklist-z");
        const blacklistAddBtn = panel.querySelector("#minibia-bot-blacklist-add");
        const blacklistAddCurrentBtn = panel.querySelector("#minibia-bot-blacklist-add-current");
        const blacklistClearBtn = panel.querySelector("#minibia-bot-blacklist-clear");
        const blacklistList = panel.querySelector("#minibia-bot-blacklist-list");
        const blacklistCount = panel.querySelector("#minibia-bot-blacklist-count");

        function refreshBlacklist() {
            if (!blacklistList)
                return;
            const tiles = bot.blacklist?.getTiles?.() || [];
            blacklistList.innerHTML = "";
            if (!tiles.length) {
                const empty = document.createElement("div");
                empty.className = "mb-small-note";
                empty.textContent = "No tiles blacklisted.";
                blacklistList.appendChild(empty);
            } else {
                tiles.forEach((t, idx) => {
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);";
                    const label = document.createElement("span");
                    label.textContent = `${t.x}, ${t.y}, ${t.z}`;
                    const removeBtn = document.createElement("button");
                    removeBtn.type = "button";
                    removeBtn.className = "mb-small-button";
                    removeBtn.textContent = "✕";
                    removeBtn.style.cssText = "width:24px;padding:2px;background:#5a2020;color:#ff8888;border-color:#883030;";
                    removeBtn.addEventListener("click", () => {
                        bot.blacklist.remove(t.x, t.y, t.z);
                        refreshBlacklist();
                    });
                    row.appendChild(label);
                    row.appendChild(removeBtn);
                    blacklistList.appendChild(row);
                });
            }
            if (blacklistCount) {
                blacklistCount.textContent = `${tiles.length} tile${tiles.length !== 1 ? 's' : ''} blocked`;
            }
        }

        // Add manually
        if (blacklistAddBtn) {
            blacklistAddBtn.addEventListener("click", () => {
                const x = parseInt(blacklistX?.value, 10);
                const y = parseInt(blacklistY?.value, 10);
                const z = parseInt(blacklistZ?.value, 10);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                    bot.log("Please enter valid X, Y, Z coordinates.");
                    return;
                }
                bot.blacklist.add(x, y, z);
                refreshBlacklist();
                if (blacklistX)
                    blacklistX.value = "";
                if (blacklistY)
                    blacklistY.value = "";
                if (blacklistZ)
                    blacklistZ.value = "";
            });
        }

        // Add current position
        if (blacklistAddCurrentBtn) {
            blacklistAddCurrentBtn.addEventListener("click", () => {
                const added = bot.blacklist.addCurrentPosition();
                if (added) {
                    refreshBlacklist();
                    bot.log("Current tile added to blacklist.");
                } else {
                    bot.log("Could not add current position.");
                }
            });
        }

        // Clear all
        if (blacklistClearBtn) {
            blacklistClearBtn.addEventListener("click", () => {
                if (!confirm("Remove ALL blacklisted tiles?"))
                    return;
                bot.blacklist.clear();
                refreshBlacklist();
                bot.log("Blacklist cleared.");
            });
        }

        // ---- Profile Manager ----
        const profileNameInput = panel.querySelector("#minibia-bot-profile-name");
        const profileSaveBtn = panel.querySelector("#minibia-bot-profile-save");
        const profileSelect = panel.querySelector("#minibia-bot-profile-select");
        const profileLoadBtn = panel.querySelector("#minibia-bot-profile-load");
        const profileDeleteBtn = panel.querySelector("#minibia-bot-profile-delete");
        const profileStatus = panel.querySelector("#minibia-bot-profile-status");

        // Export button
        const exportBtn = panel.querySelector("#minibia-bot-profile-export");
        // Import elements
        const importInput = panel.querySelector("#minibia-bot-profile-import-input");
        const importBtn = panel.querySelector("#minibia-bot-profile-import");
        const importNameInput = panel.querySelector("#minibia-bot-profile-import-name");

        function refreshProfileList() {
            if (!profileSelect)
                return;
            const currentVal = profileSelect.value;
            const names = bot.profiles?.list?.() || [];
            profileSelect.innerHTML = `<option value="">-- Select profile --</option>`;
            names.forEach(n => {
                const opt = document.createElement("option");
                opt.value = n;
                opt.textContent = n;
                profileSelect.appendChild(opt);
            });
            if (currentVal && names.includes(currentVal)) {
                profileSelect.value = currentVal;
            }
            if (profileStatus) {
                profileStatus.textContent = names.length ? `${names.length} profile(s) available` : "No profiles saved";
            }
        }

        function saveProfile() {
            const name = profileNameInput?.value?.trim();
            if (!name) {
                if (profileStatus)
                    profileStatus.textContent = "Please enter a profile name";
                return;
            }
            const success = bot.profiles?.save(name);
            if (success) {
                profileNameInput.value = "";
                refreshProfileList();
                if (profileStatus)
                    profileStatus.textContent = `Profile "${name}" saved.`;
            } else {
                if (profileStatus)
                    profileStatus.textContent = `Failed to save "${name}".`;
            }
        }

        function loadProfile() {
            const name = profileSelect?.value;
            if (!name) {
                if (profileStatus)
                    profileStatus.textContent = "Select a profile to load.";
                return;
            }
            if (!confirm(`Load profile "${name}"? This will restart the bot with the saved settings.`))
                return;
            const success = bot.profiles?.load(name);
            if (!success && profileStatus) {
                profileStatus.textContent = `Failed to load "${name}".`;
            }
            // reload will happen inside loadProfile
        }

        function deleteProfile() {
            const name = profileSelect?.value;
            if (!name) {
                if (profileStatus)
                    profileStatus.textContent = "Select a profile to delete.";
                return;
            }
            if (!confirm(`Delete profile "${name}"?`))
                return;
            const success = bot.profiles?.delete (name);
            if (success) {
                refreshProfileList();
                if (profileStatus)
                    profileStatus.textContent = `Profile "${name}" deleted.`;
            } else {
                if (profileStatus)
                    profileStatus.textContent = `Failed to delete "${name}".`;
            }
        }

        // ---- Export Waypoints (just a convenience, not strictly requested but nice to have) ----
        const exportWaypointsBtn = panel.querySelector("#minibia-bot-profile-export-waypoints");
        if (exportWaypointsBtn) {
            exportWaypointsBtn.addEventListener("click", () => {
                const name = profileSelect?.value;
                if (!name) {
                    if (profileStatus)
                        profileStatus.textContent = "Select a profile to export waypoints from.";
                    return;
                }
                const profileData = bot.profiles.get(name);
                if (!profileData) {
                    if (profileStatus)
                        profileStatus.textContent = `Profile "${name}" not found.`;
                    return;
                }
                const presets = profileData["minibiaBot.cave.presets"];
                if (!presets || !Array.isArray(presets) || presets.length === 0) {
                    if (profileStatus)
                        profileStatus.textContent = `No waypoints found in "${name}".`;
                    return;
                }
                const data = JSON.stringify({
                    "minibiaBot.cave.presets": presets
                }, null, 2);
                const blob = new Blob([data], {
                    type: "application/json"
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${name}_waypoints.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                if (profileStatus)
                    profileStatus.textContent = `Waypoints exported from "${name}".`;
            });
        }

        // ---- Import Waypoints ----
        const importWaypointsInput = panel.querySelector("#minibia-bot-profile-import-waypoints-input");
        const importWaypointsBtn = panel.querySelector("#minibia-bot-profile-import-waypoints");

        if (importWaypointsBtn && importWaypointsInput) {
            importWaypointsBtn.addEventListener("click", () => {
                importWaypointsInput.click();
            });

            importWaypointsInput.addEventListener("change", async(e) => {
                const file = e.target.files[0];
                if (!file)
                    return;

                if (profileStatus)
                    profileStatus.textContent = "Importing waypoints...";

                try {
                    const result = await bot.profiles.importWaypointsFromFile(file);
                    if (profileStatus) {
                        profileStatus.textContent = `Imported ${result.added} waypoint preset(s), skipped ${result.skipped} duplicate(s).`;
                    }
                    // Refresh cave UI to show new presets
                    if (typeof refreshCavePresetControls === "function") {
                        refreshCavePresetControls();
                    }
                    // Also refresh the profile list just in case (though we didn't add a profile)
                    refreshProfileList();
                } catch (err) {
                    if (profileStatus)
                        profileStatus.textContent = `Import failed: ${err.message}`;
                    bot.log("Waypoint import error", err);
                }

                // Reset file input so the same file can be re-selected
                importWaypointsInput.value = "";
            });
        }

        // ---- Now attach event listeners ----
        if (profileSaveBtn)
            profileSaveBtn.addEventListener("click", saveProfile);
        if (profileLoadBtn)
            profileLoadBtn.addEventListener("click", loadProfile);
        if (profileDeleteBtn)
            profileDeleteBtn.addEventListener("click", deleteProfile);
        if (profileNameInput) {
            profileNameInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    saveProfile();
                }
            });
        }

        // Export
        if (exportBtn) {
            exportBtn.addEventListener("click", () => {
                const name = profileSelect?.value;
                if (!name) {
                    if (profileStatus)
                        profileStatus.textContent = "Select a profile to export.";
                    return;
                }
                bot.profiles.export(name);
            });
        }

        // Import
        if (importBtn && importInput) {
            importBtn.addEventListener("click", () => {
                importInput.click();
            });
            importInput.addEventListener("change", async(e) => {
                const file = e.target.files[0];
                if (!file)
                    return;
                const name = importNameInput?.value?.trim() || undefined;
                try {
                    const importedName = await bot.profiles.import(file, name);
                    if (profileStatus)
                        profileStatus.textContent = `Profile "${importedName}" imported.`;
                    refreshProfileList();
                    if (profileSelect)
                        profileSelect.value = importedName;
                } catch (err) {
                    if (profileStatus)
                        profileStatus.textContent = `Import failed: ${err.message}`;
                }
                importInput.value = ''; // Reset file input
            });
        }

        const clientChaseToggle = panel.querySelector("#minibia-bot-auto-attack-client-chase");
        if (clientChaseToggle) {
            clientChaseToggle.checked = bot.attack?.config?.useClientChase || false;
            clientChaseToggle.addEventListener("change", function () {
                const enabled = this.checked;
                bot.attack.updateConfig({
                    useClientChase: enabled
                });
                if (enabled) {
                    bot.attack.setClientChaseMode(2); // aggressive chase
                } else {
                    bot.attack.setClientChaseMode(0); // stand
                }
                bot.log("Client chase toggled to", enabled ? "ON" : "OFF");
            });
        }

        // Ignored monster save button
        const ignoredSaveBtn = panel.querySelector("#minibia-bot-auto-attack-ignored-save");
        const ignoredInput = panel.querySelector("#minibia-bot-auto-attack-ignored-names");
        if (ignoredSaveBtn) {
            ignoredSaveBtn.addEventListener("click", saveAutoAttackIgnoredConfig);
        }
        if (ignoredInput) {
            ignoredInput.addEventListener("change", saveAutoAttackIgnoredConfig);
            ignoredInput.addEventListener("blur", saveAutoAttackIgnoredConfig);
        }

        // ---- Light Hack ----
        const lightHackToggle = panel.querySelector("#minibia-bot-light-hack-enabled");
        if (lightHackToggle) {
            // Sync initial state
            lightHackToggle.checked = !!(bot.lightHack?.status?.().running);

            lightHackToggle.addEventListener("change", function () {
                // If the module isn't available, log error and uncheck
                if (!bot.lightHack) {
                    bot.log("LightHack module not installed – please reload the bot.");
                    this.checked = false;
                    return;
                }

                if (this.checked) {
                    bot.lightHack.start();
                } else {
                    bot.lightHack.stop();
                }

                // Re-sync the checkbox with the actual state (in case start/stop failed)
                this.checked = !!bot.lightHack.status().running;
            });
        }

        // ---- Auto Eat ----
        const autoEatToggle = panel.querySelector("#minibia-bot-auto-eat-enabled");
        const autoEatHotkeyInput = panel.querySelector("#minibia-bot-auto-eat-hotkey");

        if (autoEatToggle) {
            autoEatToggle.checked = !!bot.eat?.status?.().running;
            autoEatToggle.addEventListener("change", function () {
                if (this.checked) {
                    bot.eat.start();
                } else {
                    bot.eat.stop();
                }
                refreshAutoEatStatus();
            });
        }

        if (autoEatHotkeyInput) {
            // Load initial value from config
            autoEatHotkeyInput.value = bot.eat?.config?.eatHotbarSlot ?? 10;
            autoEatHotkeyInput.addEventListener("change", function () {
                const val = Math.min(12, Math.max(1, Number(this.value) || 1));
                this.value = String(val);
                bot.eat.updateConfig({
                    eatHotbarSlot: val
                });
                bot.log("Auto eat hotkey updated", {
                    slot: val
                });
            });
        }

        // ---- Pink Skull ----
        const pinkSkullToggle = panel.querySelector("#minibia-bot-pink-skull-enabled");
        if (pinkSkullToggle) {
            pinkSkullToggle.checked = !!bot.pinkSkull?.status?.().running;
            pinkSkullToggle.addEventListener("change", function () {
                if (!bot.pinkSkull) {
                    bot.log("Pink Skull module not installed");
                    this.checked = false;
                    return;
                }
                if (this.checked) {
                    bot.pinkSkull.start();
                } else {
                    bot.pinkSkull.stop();
                }
                this.checked = !!bot.pinkSkull.status().running;
            });
        }

        // ---- Paladin listeners ----
        const paladinToggle = panel.querySelector("#minibia-bot-paladin-enabled");
        const paladinAmmoThreshold = panel.querySelector("#minibia-bot-paladin-ammo-threshold");
        const paladinCraftMana = panel.querySelector("#minibia-bot-paladin-craft-mana");
        const paladinCraftSpell = panel.querySelector("#minibia-bot-paladin-craft-spell");
        const paladinHighManaSpell = panel.querySelector("#minibia-bot-paladin-high-mana-spell");
        const paladinHighManaThreshold = panel.querySelector("#minibia-bot-paladin-high-mana-threshold");
        const paladinEquipCooldown = panel.querySelector("#minibia-bot-paladin-equip-cooldown");
        const paladinEquipWeapon = panel.querySelector("#minibia-bot-paladin-equip-weapon");
        const paladinWeaponId = panel.querySelector("#minibia-bot-paladin-weapon-id");
        const paladinCaptureBtn = panel.querySelector("#minibia-bot-paladin-capture-weapon");
        const equipNowBtn = panel.querySelector("#minibia-bot-paladin-equip-now");

        const paladinEquipThreshold = panel.querySelector("#minibia-bot-paladin-equip-threshold");
        if (paladinEquipThreshold) {
            paladinEquipThreshold.value = bot.paladin?.config?.equipThreshold ?? 15;
            paladinEquipThreshold.addEventListener("change", function () {
                const val = Math.max(0, parseInt(this.value, 10) || 0);
                this.value = val;
                bot.paladin.updateConfig({
                    equipThreshold: val
                });
            });
        }

        function getPaladinConfigFromUI() {
            return {
                ammoThreshold: parseInt(document.getElementById("minibia-bot-paladin-ammo-threshold")?.value, 10) || 20,
                craftManaCost: parseInt(document.getElementById("minibia-bot-paladin-craft-mana")?.value, 10) || 100,
                craftSpellWords: document.getElementById("minibia-bot-paladin-craft-spell")?.value?.trim() || "",
                highManaSpellWords: document.getElementById("minibia-bot-paladin-high-mana-spell")?.value?.trim() || "",
                highManaThreshold: parseInt(document.getElementById("minibia-bot-paladin-high-mana-threshold")?.value, 10) || 98,
                equipCooldownMs: parseInt(document.getElementById("minibia-bot-paladin-equip-cooldown")?.value, 10) || 5000,
                equipWeapon: document.getElementById("minibia-bot-paladin-equip-weapon")?.checked || false,
                weaponId: parseInt(document.getElementById("minibia-bot-paladin-weapon-id")?.value, 10) || null,
            };
        }

        // Load initial values
        if (paladinAmmoThreshold)
            paladinAmmoThreshold.value = bot.paladin?.config?.ammoThreshold ?? 20;
        if (paladinCraftMana)
            paladinCraftMana.value = bot.paladin?.config?.craftManaCost ?? 100;
        if (paladinCraftSpell)
            paladinCraftSpell.value = bot.paladin?.config?.craftSpellWords || "";
        if (paladinHighManaSpell)
            paladinHighManaSpell.value = bot.paladin?.config?.highManaSpellWords || "";
        if (paladinHighManaThreshold)
            paladinHighManaThreshold.value = bot.paladin?.config?.highManaThreshold ?? 98;
        if (paladinEquipCooldown)
            paladinEquipCooldown.value = bot.paladin?.config?.equipCooldownMs ?? 5000;

        // ---- Paladin UI ----
        if (paladinEquipWeapon) {
            paladinEquipWeapon.checked = bot.paladin?.config?.equipWeapon || false;
            paladinEquipWeapon.addEventListener("change", function () {
                const config = getPaladinConfigFromUI();
                config.equipWeapon = this.checked;
                bot.paladin.updateConfig(config);
                // ❌ REMOVED: immediate equip – the tick loop handles it with threshold check
            });
        }

        if (paladinWeaponId)
            paladinWeaponId.value = bot.paladin?.config?.weaponId ?? "";

        if (paladinToggle) {
            paladinToggle.checked = !!bot.paladin?.status?.().running;
            paladinToggle.addEventListener("change", () => {
                if (paladinToggle.checked) {
                    const config = getPaladinConfigFromUI();
                    bot.paladin.updateConfig(config);
                    bot.paladin.start();
                } else {
                    bot.paladin.stop();
                }
                refreshPaladinStatus();
            });
        }

        // Capture weapon ID from left hand
        if (paladinCaptureBtn) {
            paladinCaptureBtn.addEventListener("click", () => {
                bot.paladin.startCaptureWeapon();
            });
        }

        // ---- Ammo threshold: update config on change ----
        if (paladinAmmoThreshold) {
            paladinAmmoThreshold.addEventListener("change", function () {
                const val = Math.max(0, parseInt(this.value, 10) || 0);
                this.value = val;
                bot.paladin.updateConfig({
                    ammoThreshold: val
                });
            });
        }

        // ---- Equip Now button (manual override, optionally threshold-aware) ----
        if (equipNowBtn) {
            equipNowBtn.addEventListener("click", function () {
                const weaponId = bot.paladin?.config?.weaponId;
                if (!weaponId) {
                    bot.log("Paladin: No weapon ID set. Capture or enter one first.");
                    return;
                }
                // Optional: respect threshold on manual click? Uncomment the next lines if you want.
                // const ammo = bot.paladin.getAmmoCount();
                // if (ammo > bot.paladin.config.ammoThreshold) {
                //   bot.log(`Paladin: Ammo count ${ammo} is above threshold ${bot.paladin.config.ammoThreshold}, not equipping.`);
                //   return;
                // }
                const success = bot.paladin.equipWeapon(weaponId);
                bot.log(success ? "Paladin: Weapon equipped manually." : "Paladin: Could not equip weapon. Check containers/equipment.");
            });
        }

        // ---- Looter listeners ----
        const looterToggle = panel.querySelector("#minibia-bot-looter-enabled");
        const selectDestBtn = panel.querySelector("#minibia-bot-looter-select-dest");
        const captureItemBtn = panel.querySelector("#minibia-bot-looter-capture-item");
        const manualInput = panel.querySelector("#minibia-bot-looter-manual-input");
        const manualAddBtn = panel.querySelector("#minibia-bot-looter-manual-add");

        if (looterToggle) {
            looterToggle.checked = !!bot.looter?.status?.().running;
            looterToggle.addEventListener("change", () => {
                if (looterToggle.checked) {
                    bot.looter.start();
                } else {
                    bot.looter.stop();
                }
                refreshLooterStatus();
            });
        }

        if (selectDestBtn) {
            selectDestBtn.addEventListener("click", () => {
                bot.looter.startSelectDestination();
            });
        }

        if (captureItemBtn) {
            captureItemBtn.addEventListener("click", () => {
                bot.looter.startCaptureItem();
            });
        }

        if (manualAddBtn && manualInput) {
            const addManualItem = () => {
                const name = manualInput.value.trim();
                if (!name)
                    return;
                // Find item by name
                const defs = window.gameClient?.itemDefinitionsBySid || {};
                let found = null;
                for (const [sid, def] of Object.entries(defs)) {
                    if (def?.properties?.name?.toLowerCase() === name.toLowerCase()) {
                        found = {
                            id: def.id,
                            name: def.properties.name
                        };
                        break;
                    }
                }
                if (!found) {
                    bot.log("Looter: item not found", name);
                    return;
                }
                const current = bot.looter.getTrackedItems();
                bot.looter.updateConfig({
                    trackedItems: [...current, [found.id, found.name]]
                });
                refreshLooterStatus();
                manualInput.value = "";
            };
            manualAddBtn.addEventListener("click", addManualItem);
            manualInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    addManualItem();
                }
            });
        }

        // Heal UI
        const healSave = panel.querySelector("#minibia-bot-heal-save");
        const healCancel = panel.querySelector("#minibia-bot-heal-cancel");
        if (healSave)
            healSave.addEventListener("click", saveHealRule);
        if (healCancel)
            healCancel.addEventListener("click", clearHealRuleForm);

        const autoHealToggle = panel.querySelector("#minibia-bot-auto-heal-enabled");
        if (autoHealToggle) {
            autoHealToggle.checked = !!bot.heal?.status?.().running;
            autoHealToggle.addEventListener("change", () => {
                if (autoHealToggle.checked)
                    bot.heal.start();
                else
                    bot.heal.stop();
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
                bot.attack.updateConfig({
                    targetHotbarSlot: val
                });
            });
        }
        if (autoAttackRuneHotkeyInput) {
            autoAttackRuneHotkeyInput.value = bot.attack?.config?.runeHotbarSlot ? String(bot.attack.config.runeHotbarSlot) : "";
            autoAttackRuneHotkeyInput.addEventListener("change", () => {
                const raw = Number(autoAttackRuneHotkeyInput.value);
                const slot = Number.isFinite(raw) && raw >= 1 && raw <= 12 ? Math.trunc(raw) : null;
                autoAttackRuneHotkeyInput.value = slot ? String(slot) : "";
                bot.attack.updateConfig({
                    runeHotbarSlot: slot
                });
            });
        }
        if (autoAttackMeleeInput) {
            autoAttackMeleeInput.checked = bot.attack?.config?.meleeMode !== false;
            autoAttackMeleeInput.addEventListener("change", () => {
                bot.attack.updateConfig({
                    meleeMode: autoAttackMeleeInput.checked
                });
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
                if (autoAttackEnabledInput.checked)
                    bot.attack.start({
                        targetHotbarSlot: targetSlot,
                        runeHotbarSlot: runeSlot,
                        meleeMode: melee
                    });
                else
                    bot.attack.stop();
                refreshAutoAttackStatus();
                refreshTitlebarRunIndicators();
            });
        }
        if (maxDistInput) {
            maxDistInput.value = bot.attack?.config?.maxTargetDistance ?? 5;
            maxDistInput.addEventListener("change", () => {
                const val = Math.min(10, Math.max(1, Number(maxDistInput.value) || 5));
                maxDistInput.value = val;
                bot.attack.updateConfig({
                    maxTargetDistance: val
                });
            });
        }
        if (antiKSInput) {
            antiKSInput.checked = bot.attack?.config?.antiKSEnabled !== false;
            antiKSInput.addEventListener("change", () => {
                bot.attack.updateConfig({
                    antiKSEnabled: antiKSInput.checked
                });
            });
        }
        if (antiKSSelfInput) {
            antiKSSelfInput.value = bot.attack?.config?.antiKSSelfRange ?? 2;
            antiKSSelfInput.addEventListener("change", () => {
                const val = Math.min(5, Math.max(1, Number(antiKSSelfInput.value) || 2));
                antiKSSelfInput.value = val;
                bot.attack.updateConfig({
                    antiKSSelfRange: val
                });
            });
        }
        if (antiKSOtherInput) {
            antiKSOtherInput.value = bot.attack?.config?.antiKSOtherRange ?? 2;
            antiKSOtherInput.addEventListener("change", () => {
                const val = Math.min(5, Math.max(1, Number(antiKSOtherInput.value) || 2));
                antiKSOtherInput.value = val;
                bot.attack.updateConfig({
                    antiKSOtherRange: val
                });
            });
        }

        // ---- Kite Mode ----
        const kiteToggle = panel.querySelector("#minibia-bot-auto-attack-kite");
        const idealDistInput = panel.querySelector("#minibia-bot-auto-attack-ideal-dist");

        if (kiteToggle) {
            kiteToggle.checked = bot.attack?.config?.kiteMode || false;
            kiteToggle.addEventListener("change", function () {
                bot.attack.updateConfig({
                    kiteMode: this.checked
                });
            });
        }

        if (idealDistInput) {
            idealDistInput.value = bot.attack?.config?.idealDistance ?? 3;
            idealDistInput.addEventListener("change", function () {
                const val = Math.max(1, Math.min(10, Number(this.value) || 3));
                this.value = val;
                bot.attack.updateConfig({
                    idealDistance: val
                });
            });
        }

        // Panic player alert
        const playerAlertToggle = panel.querySelector("#minibia-bot-panic-player-alert");
        const playerCooldownInput = panel.querySelector("#minibia-bot-panic-player-cooldown");
        if (playerAlertToggle) {
            playerAlertToggle.checked = bot.panic?.config?.playerAlertEnabled ?? false;
            playerAlertToggle.addEventListener("change", () => {
                bot.panic.updateConfig({
                    playerAlertEnabled: playerAlertToggle.checked
                });
            });
        }

        if (playerCooldownInput) {
            playerCooldownInput.value = (bot.panic?.config?.playerAlertCooldownMs ?? 60000) / 1000;
            playerCooldownInput.addEventListener("change", () => {
                const sec = Math.max(10, Number(playerCooldownInput.value) || 60);
                playerCooldownInput.value = sec;
                bot.panic.updateConfig({
                    playerAlertCooldownMs: sec * 1000
                });
            });
        }

        // Talk ignored phrases
        const talkIgnoredInput = panel.querySelector("#minibia-bot-talk-ignored");
        if (talkIgnoredInput) {
            talkIgnoredInput.value = (bot.talk?.config?.ignoredPhrases || []).join(", ");
            talkIgnoredInput.addEventListener("change", saveTalkIgnoredPhrases);
            talkIgnoredInput.addEventListener("blur", saveTalkIgnoredPhrases);
        }

        //Talk main
        const talkEnabledInput = panel.querySelector("#minibia-bot-talk-enabled");
        const talkApiKeyInput = panel.querySelector("#minibia-bot-talk-api-key");
        const talkPromptInput = panel.querySelector("#minibia-bot-talk-prompt");

        // --- Load talk config into UI ---
        if (talkApiKeyInput) {
            talkApiKeyInput.value = bot.talk?.config?.apiKey || "";
        }
        if (talkPromptInput) {
            talkPromptInput.value = bot.talk?.config?.systemPrompt || "";
        }

        if (talkEnabledInput) {
            talkEnabledInput.checked = !!bot.talk?.status?.().running;
            talkEnabledInput.addEventListener("change", function () {
                // Disable the checkbox briefly to prevent rapid clicks
                this.disabled = true;

                const apiKey = talkApiKeyInput?.value?.trim() || "";
                const systemPrompt = talkPromptInput?.value?.trim() || bot.talk.config.systemPrompt || "";

                if (this.checked) {
                    // Save config first
                    bot.talk.updateConfig({
                        apiKey,
                        systemPrompt
                    });
                    const started = bot.talk.start();
                    if (!started) {
                        // If start failed, uncheck and show status
                        this.checked = false;
                        // The refresh will show the error
                    }
                } else {
                    bot.talk.stop();
                }

                refreshTalkStatus();
                this.disabled = false;
            });
        }

        // Cave bot waypoint actions
        const addBtn = panel.querySelector("#minibia-bot-cave-add");
        const moveUpBtn = panel.querySelector("#minibia-bot-cave-move-up");
        const moveDownBtn = panel.querySelector("#minibia-bot-cave-move-down");
        const delBtn = panel.querySelector("#minibia-bot-cave-delete-selected");
        if (addBtn) {
            addBtn.addEventListener("click", () => {
                const pos = bot.getPlayerPosition();
                if (!pos) {
                    bot.log("Cannot get player position.");
                    return;
                }
                const dirSelect = document.getElementById("minibia-bot-cave-direction");
                const standCheck = document.getElementById("minibia-bot-cave-stand");
                const ropeCheck = document.getElementById("minibia-bot-cave-rope");
                const shovelCheck = document.getElementById("minibia-bot-cave-shovel");
                const ladderCheck = document.getElementById("minibia-bot-cave-ladder");
                const dir = dirSelect ? dirSelect.value : "C";
                const offset = getDirectionOffset(dir);
                const x = pos.x + offset.dx;
                const y = pos.y + offset.dy;
                const z = pos.z;
                const stand = !!(standCheck && standCheck.checked);
                const rope = !!(ropeCheck && ropeCheck.checked);
                const shovel = !!(shovelCheck && shovelCheck.checked);
                const ladder = !!(ladderCheck && ladderCheck.checked);
                const label = stand ? "Stand" : (rope ? "Rope" : (shovel ? "Shovel" : ""));
                const waypoint = {
                    x,
                    y,
                    z,
                    label: label || undefined,
                    stand: stand,
                    rope: rope,
                    shovel: shovel,
                    ladder: ladder
                };
                const added = bot.cave.addWaypoint(waypoint);
                if (added) {
                    const route = bot.cave.getRoute();
                    selectedWaypointIndex = route.length - 1;
                    const wp = route[selectedWaypointIndex];
                    const labelInput = document.getElementById("minibia-bot-cave-waypoint-label");
                    const scriptInput = document.getElementById("minibia-bot-cave-waypoint-script");
                    if (labelInput)
                        labelInput.value = wp.label || "";
                    if (scriptInput)
                        scriptInput.value = wp.script || "";
                    refreshCaveWaypointList();
                    refreshCaveStatus();
                    refreshCaveClosestStatus();
                    refreshCaveTransitionStatus();
                    refreshCavePresetControls();
                    scrollToSelectedWaypoint();
                    bot.log("Waypoint added.");
                } else {
                    bot.log("Failed to add waypoint.");
                }
            });
        }
        if (moveUpBtn)
            moveUpBtn.addEventListener("click", () => moveSelectedWaypoint("up"));
        if (moveDownBtn)
            moveDownBtn.addEventListener("click", () => moveSelectedWaypoint("down"));
        if (delBtn)
            delBtn.addEventListener("click", deleteSelectedWaypoint);

        // Cave preset
        const presetSelect = panel.querySelector("#minibia-bot-cave-preset-select");
        const presetNew = panel.querySelector("#minibia-bot-cave-preset-new");
        const presetDelete = panel.querySelector("#minibia-bot-cave-preset-delete");
        if (presetSelect) {
            presetSelect.addEventListener("change", () => {
                const name = presetSelect.value;
                if (!name)
                    return;
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
                if (name == null)
                    return;
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
                if (!name)
                    return;
                bot.cave.deletePreset(name);
                refreshCavePresetControls();
                refreshCaveStatus();
                refreshCaveClosestStatus();
                refreshCaveTransitionStatus();
                refreshCaveWaypointList();
            });
        }

        const renamePresetBtn = panel.querySelector("#minibia-bot-cave-preset-rename");
        if (renamePresetBtn) {
            renamePresetBtn.addEventListener("click", () => {
                const select = document.getElementById("minibia-bot-cave-preset-select");
                if (!select)
                    return;
                const oldName = select.value;
                if (!oldName) {
                    bot.log("No preset selected to rename.");
                    return;
                }
                const newName = window.prompt("Enter new name for preset:", oldName);
                if (newName === null)
                    return; // cancelled
                const trimmed = newName.trim();
                if (!trimmed) {
                    bot.log("Invalid preset name.");
                    return;
                }
                const success = bot.cave.renamePreset(oldName, trimmed);
                if (success) {
                    refreshCavePresetControls();
                    refreshCaveStatus();
                    refreshCaveWaypointList();
                    // Select the new name in dropdown
                    const updatedSelect = document.getElementById("minibia-bot-cave-preset-select");
                    if (updatedSelect) {
                        const options = Array.from(updatedSelect.options);
                        const match = options.find(opt => opt.value === trimmed);
                        if (match)
                            updatedSelect.value = trimmed;
                    }
                    bot.log(`Preset renamed to "${trimmed}"`);
                } else {
                    bot.log("Rename failed. Check for duplicate names.");
                }
            });
        }

        // Cave tolerance
        const toleranceInput = panel.querySelector("#minibia-bot-cave-tolerance");
        if (toleranceInput) {
            toleranceInput.value = bot.cave?.config?.waypointTolerance ?? 0;
            toleranceInput.addEventListener("change", () => {
                const val = Math.min(5, Math.max(0, Number(toleranceInput.value) || 0));
                toleranceInput.value = val;
                bot.cave.updateConfig({
                    waypointTolerance: val
                });
            });
        }

        // Cave toggle
        const caveToggle = panel.querySelector("#minibia-bot-cave-toggle");
        if (caveToggle) {
            caveToggle.checked = !!bot.cave?.status?.().running;
            caveToggle.addEventListener("change", () => {
                if (caveToggle.checked)
                    bot.cave.start();
                else
                    bot.cave.stop();
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

        const autoTransToggle = panel.querySelector("#minibia-bot-cave-auto-transitions");
        if (autoTransToggle) {
            autoTransToggle.checked = bot.cave?.config?.autoTransitions ?? true;
            autoTransToggle.addEventListener("change", () => {
                bot.cave.updateConfig({
                    autoTransitions: autoTransToggle.checked
                });
            });
        }

        // ---- Reload Bot ----
        const reloadButton = panel.querySelector("#minibia-bot-reload");
        if (reloadButton) {
            reloadButton.addEventListener("click", () => {
                if (typeof window.minibiaBotReload === "function") {
                    window.minibiaBotReload();
                } else {
                    console.warn("[minibia-bot] minibiaBotReload not defined – reloading page instead.");
                    location.reload();
                }
            });
        }

        // ---- Trusted Name Add ----
        const panicTrustedInput = panel.querySelector("#minibia-bot-panic-trusted-input");
        const panicTrustedAddButton = panel.querySelector("#minibia-bot-panic-trusted-add");

        // ---- Game Master Name Add ----
        const gmInput = panel.querySelector("#minibia-bot-panic-gm-input");
        const gmAddButton = panel.querySelector("#minibia-bot-panic-gm-add");

        function addGameMasterName() {
            const rawName = gmInput?.value?.trim() || "";
            if (!rawName) {
                bot.log("No game master name entered.");
                return;
            }

            if (!bot.panic) {
                bot.log("Panic module not available.");
                return;
            }

            const currentNames = bot.panic.config.gameMasterNames || [];
            const exists = currentNames.some(
                    (name) => String(name).trim().toLowerCase() === rawName.toLowerCase());

            if (exists) {
                bot.log(`"${rawName}" is already in the GM list.`);
                gmInput.value = "";
                return;
            }

            bot.panic.updateConfig({
                gameMasterNames: [...currentNames, rawName]
            });
            gmInput.value = "";
            renderGameMasterNames();
            bot.log(`Added game master name: ${rawName}`);
        }

        if (gmAddButton) {
            gmAddButton.addEventListener("click", addGameMasterName);
        }

        if (gmInput) {
            gmInput.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    addGameMasterName();
                }
            });
        }

        function addTrustedName() {
            const rawName = panicTrustedInput?.value?.trim() || "";
            if (!rawName) {
                bot.log("No name entered.");
                return;
            }

            if (!bot.panic) {
                bot.log("Panic module not available.");
                return;
            }

            const currentNames = bot.panic.config.trustedNames || [];
            const exists = currentNames.some(
                    (name) => String(name).trim().toLowerCase() === rawName.toLowerCase());

            if (exists) {
                bot.log(`"${rawName}" is already trusted.`);
                panicTrustedInput.value = "";
                return;
            }

            bot.panic.updateConfig({
                trustedNames: [...currentNames, rawName]
            });
            panicTrustedInput.value = "";
            renderTrustedNames();
            bot.log(`Added trusted name: ${rawName}`);
        }

        if (panicTrustedAddButton) {
            panicTrustedAddButton.addEventListener("click", addTrustedName);
        } else {
            console.warn("Trusted add button not found.");
        }

        // Also handle Enter key on input
        if (panicTrustedInput) {
            panicTrustedInput.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    addTrustedName();
                }
            });
        }

        // ---- Panic toggles: Unknown Player, Healthloss, Auto Return ----
        const unknownToggle = panel.querySelector("#minibia-bot-panic-unknown");
        const healthToggle = panel.querySelector("#minibia-bot-panic-health");
        const returnToggle = panel.querySelector("#minibia-bot-panic-return");

        if (unknownToggle) {
            unknownToggle.checked = !!bot.panic?.config?.unknownPlayerEnabled;
            unknownToggle.addEventListener("change", () => {
                bot.panic.updateConfig({
                    unknownPlayerEnabled: unknownToggle.checked
                });
                refreshPanicStatus();
            });
        }

        if (healthToggle) {
            healthToggle.checked = !!bot.panic?.config?.healthLossEnabled;
            healthToggle.addEventListener("change", () => {
                bot.panic.updateConfig({
                    healthLossEnabled: healthToggle.checked
                });
                refreshPanicStatus();
            });
        }

        if (returnToggle) {
            returnToggle.checked = !!bot.panic?.config?.returnToOriginEnabled;
            returnToggle.addEventListener("change", () => {
                bot.panic.updateConfig({
                    returnToOriginEnabled: returnToggle.checked
                });
                refreshPanicStatus();
            });
        }

        // ---- OLDER EXISTING LISTENERS (reload, trusted, GM, rune, eat, invisible, shield, equip, talk, panic, xray, home) ----

        // ---- INITIAL REFRESHES ----
        try {
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
            refreshAutoAttackPreferredStatus({
                force: true
            });
            refreshAutoAttackIgnoredStatus({
                force: true
            });
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
            refreshPaladinStatus();
            refreshLooterStatus();
            refreshProfileList();
            refreshBlacklist();
            refreshAntiAfkStatus();
            refreshSlimeTrainerStatus();
            refreshAutoStackerStatus();
            refreshAntiBotStatus();
            refreshPlayerAttackStatus();
            refreshMessageAlertStatus();
            if (convertCurrencyToggle) {
                convertCurrencyToggle.checked = bot.autoStacker?.config?.convertCurrency !== false;
            }

        } catch (e) {
            console.error("[minibia-bot] UI init error:", e);
        }

        // Periodic refreshes
        const visibleTimer = window.setInterval(refreshVisibleCreatures, 1000);
        bot.addCleanup(() => window.clearInterval(visibleTimer));
        const talkTimer = window.setInterval(refreshTalkStatus, 1000);
        bot.addCleanup(() => window.clearInterval(talkTimer));
        const paladinTimer = window.setInterval(refreshPaladinStatus, 2000);
        bot.addCleanup(() => window.clearInterval(paladinTimer));
        const looterTimer = window.setInterval(refreshLooterStatus, 1000);
        bot.addCleanup(() => window.clearInterval(looterTimer));
        const antibotTimer = window.setInterval(refreshAntiBotStatus, 1000);
        bot.addCleanup(() => window.clearInterval(antibotTimer));
        const caveTimer = window.setInterval(() => {
            refreshCaveStatus();
            refreshCavePresetControls();
            refreshCaveClosestStatus();
            refreshCaveTransitionStatus();
            refreshCaveWaypointList();
            const loopToggle = document.getElementById("minibia-bot-cave-loop");
            if (loopToggle)
                loopToggle.checked = bot.cave?.getLoopMode?.() ?? false;
        }, 1000);
        setInterval(refreshBlacklist, 2000);
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
        panel.addEventListener("pointerdown", unlockAudio, {
            passive: true
        });
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
 * UI TWEAKS MODULE – with name spoofer (fixed), popup hider, hotbar banks & wide columns
 * ==================================================================================
 */
window.__minibiaBotBundle.installUiTweaksModule = function installUiTweaksModule(bot) {
    const configStorageKey = "minibiaBot.uiTweaks.config";

    const config = Object.assign({
        wideColumns: false,
        showBothHotbarBanks: false,
        nameSpooferEnabled: false,
        spoofedName: "",
        hideFloatingPopups: false,
    }, bot.storage.get(configStorageKey, {}));

    function persistConfig() {
        bot.storage.set(configStorageKey, config);
    }

    // ---- Name spoofer state ----
    let __originalNameDescriptor = null;
    let __originalChannelAddMessage = null;
    let __realName = null;

    // ---- Popup hider & floating text spoof ----
    let __originalCreateTextElement = null;
    let __originalCreateTextElementMethod = null;

    // ---- Food consumption messages ----
    const CONSUMPTION_MSGS = new Set([
        "yum.", "yummy.", "chomp.", "munch.", "burp.",
        "gulp..", "ugh!", "aaaah...", "ahhh..", "slurp.",
        "glug.", "nom.", "nom nom.", "tasty.", "crunch.",
        "gulp", "yum", "burp", "munch", "crunch"
    ]);

    function isConsumptionMessage(msg) {
        return CONSUMPTION_MSGS.has(String(msg).toLowerCase().trim());
    }

    // ---- Name spoofer for nameplate & chat ----
    function applyNameSpoof() {
        const player = window.gameClient?.player;
        if (!player) {
            bot.log("[UI] Name spoofer: player not ready, will retry");
            setTimeout(applyNameSpoof, 500);
            return;
        }

        const enabled = config.nameSpooferEnabled;
        const name = config.spoofedName.trim();

        if (!enabled || !name) {
            // Restore Creature.prototype.name
            if (__originalNameDescriptor) {
                Object.defineProperty(Creature.prototype, 'name', __originalNameDescriptor);
                __originalNameDescriptor = null;
                bot.log("[UI] Name spoofer: restored original name getter");
            }
            // Restore Channel.addMessage
            if (__originalChannelAddMessage) {
                Channel.prototype.addMessage = __originalChannelAddMessage;
                __originalChannelAddMessage = null;
                bot.log("[UI] Name spoofer: restored chat handler");
            }
            forceRefreshNameplates(); // will use real name
            return;
        }

        const realName = player.name;
        if (!realName) {
            bot.log("[UI] Name spoofer: real name not found");
            return;
        }
        __realName = realName;

        // ---- Patch Creature.prototype.name ----
        if (!__originalNameDescriptor) {
            const desc = Object.getOwnPropertyDescriptor(Creature.prototype, 'name');
            __originalNameDescriptor = desc;
            Object.defineProperty(Creature.prototype, 'name', {
                get: function() {
                    if (this === gameClient.player) {
                        return config.spoofedName.trim();
                    }
                    return __originalNameDescriptor ? __originalNameDescriptor.get.call(this) : this.__name;
                },
                set: function(value) {
                    if (this === gameClient.player) {
                        this.__realName = value;
                        return;
                    }
                    if (__originalNameDescriptor) {
                        __originalNameDescriptor.set.call(this, value);
                    } else {
                        this.__name = value;
                    }
                },
                configurable: true
            });
            bot.log("[UI] Name spoofer: patched Creature.prototype.name");
        }

        // ---- Patch Channel.addMessage ----
        if (!__originalChannelAddMessage) {
            __originalChannelAddMessage = Channel.prototype.addMessage;
            Channel.prototype.addMessage = function(message, level, name, color, timestamp, levelNumber) {
                if (name && name === __realName) {
                    name = config.spoofedName.trim();
                }
                return __originalChannelAddMessage.call(this, message, level, name, color, timestamp, levelNumber);
            };
            bot.log("[UI] Name spoofer: patched Channel.addMessage");
        }

        forceRefreshNameplates(); // will use spoofed name
        bot.log(`[UI] Name spoofer: applied "${name}"`);
    }

    // ★ FIXED: forceRefreshNameplates now checks the enabled state
    function forceRefreshNameplates() {
        const player = window.gameClient?.player;
        if (!player) return;
        // Use spoofed name only if enabled and non-empty, else real name
        const displayName = (config.nameSpooferEnabled && config.spoofedName.trim())
            ? config.spoofedName.trim()
            : player.name;

        if (player.characterElement) {
            const ce = player.characterElement;
            if (typeof ce.name !== 'undefined') ce.name = displayName;
            if (typeof ce._name !== 'undefined') ce._name = displayName;

            const el = ce.element;
            if (el) {
                const nameRow = el.querySelector('.skull-name-row');
                if (nameRow) {
                    const nameSpan = nameRow.querySelector('span');
                    if (nameSpan) {
                        nameSpan.textContent = displayName;
                    }
                }
            }
            if (typeof ce.render === 'function') ce.render();
            if (typeof ce.update === 'function') ce.update();
            if (typeof ce.updateNameplate === 'function') ce.updateNameplate();
            if (typeof ce.setName === 'function') ce.setName(displayName);
        }

        const battleWindow = gameClient.interface?.windowManager?.getWindow?.("battle-window");
        if (battleWindow && typeof battleWindow.updateCreature === 'function') {
            battleWindow.updateCreature(player);
        }

        if (window.gameClient?.renderer) {
            window.gameClient.renderer.updateTileCache();
            window.gameClient.renderer.render();
        }
    }

    // ---- Combined patch for floating text: spoof name + hide popups ----
    function applyFloatingTextPatch() {
        const mgr = gameClient?.interface?.screenElementManager;
        if (!mgr) {
            bot.log("[UI] Floating text patch: ScreenElementManager not ready, will retry");
            setTimeout(applyFloatingTextPatch, 500);
            return;
        }

        const proto = Object.getPrototypeOf(mgr);

        if (!__originalCreateTextElement) {
            __originalCreateTextElement = proto.__createTextElement;
        }
        if (!__originalCreateTextElementMethod) {
            __originalCreateTextElementMethod = proto.createTextElement;
        }

        proto.createTextElement = function(entity, message, color, loudness) {
            // ---- 1) Check if we should hide this floating bubble ----
            let hide = false;
            if (config.hideFloatingPopups) {
                let isSpell = false;
                if (typeof mgr.isSpellCastMessage === 'function') {
                    isSpell = mgr.isSpellCastMessage(message);
                } else {
                    const lower = String(message).toLowerCase().trim();
                    isSpell = /^[a-z ]+$/.test(lower) && lower.length < 30;
                }
                const isFood = isConsumptionMessage(message);
                hide = isSpell || isFood;
            }

            // ---- 2) Log to Default channel (original behavior) ----
            if (!hide && entity && entity.type !== 1) {
                let shouldHideLog = false;
                try {
                    shouldHideLog = gameClient.interface.settings
                        && gameClient.interface.settings.isHideSpellCastsEnabled()
                        && mgr.isSpellCastMessage && mgr.isSpellCastMessage(message);
                } catch (e) {}
                if (!shouldHideLog) {
                    gameClient.interface.channelManager.getChannel("Default").addMessage(
                        message, entity.type, entity.name, color, loudness, entity.level
                    );
                }
            }

            if (hide) {
                return null;
            }

            // ---- 3) Spoof name for floating bubble (if enabled) ----
            if (config.nameSpooferEnabled && config.spoofedName.trim() && entity === gameClient.player) {
                const realName = entity.name;
                entity.name = config.spoofedName.trim();
                const result = this.__createTextElement(
                    new MessageElement(entity, message, color, loudness)
                );
                entity.name = realName;
                return result;
            }

            // ---- 4) Default ----
            return this.__createTextElement(
                new MessageElement(entity, message, color, loudness)
            );
        };

        bot.log("[UI] Floating text patch: installed (name spoof + popup hider)");
    }

    // ---- CSS for hotbar banks ----
    function ensureBothBanksCSS() {
        if (document.getElementById("mb-ui-tweaks-style")) return;
        const style = document.createElement("style");
        style.id = "mb-ui-tweaks-style";
        style.textContent = `
            .hotbar.show-both-banks {
                display: flex !important;
                flex-direction: row !important;
                flex-wrap: wrap !important;
                gap: 2px !important;
            }
            .hotbar.show-both-banks .hotbar-bank1,
            .hotbar.show-both-banks .hotbar-bank2 {
                display: flex !important;
                flex-direction: row !important;
                gap: 2px !important;
            }
            .hotbar.show-both-banks .hotbar-item {
                flex: 0 0 36px !important;
                width: 36px !important;
                height: 36px !important;
            }
            .hotbar.show-both-banks .hotbar-spacer {
                display: none !important;
            }
            #hotbar-bank-toggle.hidden {
                opacity: 0;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    function applyStyles() {
        ensureBothBanksCSS();

        // Wide Columns
        const columns = document.querySelectorAll("#game-wrapper .column");
        const newWidth = config.wideColumns ? "224px" : "180px";
        columns.forEach(col => { col.style.width = newWidth; });

        // Hotbar banks
        const hotbar = document.querySelector(".hotbar");
        if (hotbar) {
            const bank1 = hotbar.querySelector(".hotbar-bank1");
            const bank2 = hotbar.querySelector(".hotbar-bank2");
            const toggleBtn = document.getElementById("hotbar-bank-toggle");

            if (config.showBothHotbarBanks) {
                hotbar.classList.add("show-both-banks");
                if (bank1) bank1.style.display = "";
                if (bank2) bank2.style.display = "";
                if (toggleBtn) toggleBtn.classList.add("hidden");
            } else {
                hotbar.classList.remove("show-both-banks");
                if (bank1) bank1.style.display = "";
                if (bank2) bank2.style.display = hotbar.classList.contains("show-bank2") ? "" : "none";
                if (toggleBtn) toggleBtn.classList.remove("hidden");
            }
        }

        applyNameSpoof();
        applyFloatingTextPatch();
    }

    function applyAll() {
        persistConfig();
        applyStyles();
        setTimeout(forceRefreshNameplates, 100);
    }

    // ---- Inject the UI tab ----
    function injectUiTab() {
        const panel = document.getElementById("minibia-bot-panel");
        if (!panel) {
            setTimeout(injectUiTab, 100);
            return;
        }

        const tabMenu = panel.querySelector(".mb-tab-menu");
        if (!tabMenu) return;
        if (tabMenu.querySelector('[data-tab-button="ui"]')) return;
        const tabBtn = document.createElement("button");
        tabBtn.type = "button";
        tabBtn.className = "mb-tab-button";
        tabBtn.dataset.tabButton = "ui";
        tabBtn.textContent = "UI";
        tabMenu.appendChild(tabBtn);

        const tabContent = panel.querySelector(".mb-tab-content");
        if (!tabContent) return;
        if (tabContent.querySelector('[data-tab-panel="ui"]')) return;

        const uiPanel = document.createElement("div");
        uiPanel.className = "mb-tab-panel";
        uiPanel.dataset.tabPanel = "ui";
        uiPanel.innerHTML = `
            <div class="mb-section">
                <div class="mb-label">Interface Tweaks</div>
                <div class="mb-stack">
                    <label class="mb-toggle mb-toggle-main">
                        <input type="checkbox" id="minibia-bot-ui-wide-columns" />
                        <span>Wide Columns (224px)</span>
                    </label>
                    <div class="mb-small-note">Expands the container widths from 180px to 224px.</div>

                    <label class="mb-toggle mb-toggle-main" style="margin-top:8px;">
                        <input type="checkbox" id="minibia-bot-ui-show-both-hotbar" />
                        <span>Show Both Hotbar Banks</span>
                    </label>
                    <div class="mb-small-note">Show all 24 hotbar slots (F1-F12 and Shift+F1-F12) at once.</div>

                    <hr style="margin:12px 0;border-color:#444;">

                    <div class="mb-label" style="font-size:12px;">Name Spoofer</div>
                    <label class="mb-toggle mb-toggle-main">
                        <input type="checkbox" id="minibia-bot-ui-name-spoofer-enabled" />
                        <span>Enable Name Spoof</span>
                    </label>
                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <input type="text" id="minibia-bot-ui-spoofed-name" placeholder="Enter custom name" style="flex:1;" />
                        <button type="button" class="mb-small-button" id="minibia-bot-ui-apply-spoofer">Apply</button>
                    </div>
                    <div class="mb-small-note">Changes your display name locally (nameplate, chat, and floating speech).</div>

                    <hr style="margin:12px 0;border-color:#444;">

                    <div class="mb-label" style="font-size:12px;">Floating Popups</div>
                    <label class="mb-toggle mb-toggle-main">
                        <input type="checkbox" id="minibia-bot-ui-hide-popups" />
                        <span>Hide Spell Casts &amp; Food Popups</span>
                    </label>
                    <div class="mb-small-note">Removes floating bubbles above your character when casting spells or eating food.</div>
                </div>
            </div>
        `;
        tabContent.appendChild(uiPanel);

        // ---- Tab click handler ----
        tabBtn.addEventListener("click", function() {
            const tabId = this.dataset.tabButton;
            panel.querySelectorAll(".mb-tab-button").forEach(btn => btn.dataset.active = btn === this ? "true" : "false");
            panel.querySelectorAll(".mb-tab-panel").forEach(tp => tp.dataset.active = tp.dataset.tabPanel === tabId ? "true" : "false");
            try { localStorage.setItem("minibia-bot-active-tab", tabId); } catch {}
        });

        // ---- Restore active tab ----
        const savedTab = (() => {
            try { return localStorage.getItem("minibia-bot-active-tab") || "healing"; } catch { return "healing"; }
        })();
        if (savedTab === "ui") {
            tabBtn.dataset.active = "true";
            uiPanel.dataset.active = "true";
        }

        // ---- Wire up controls ----
        const wideCheck = document.getElementById("minibia-bot-ui-wide-columns");
        const bothCheck = document.getElementById("minibia-bot-ui-show-both-hotbar");
        const nameSpoofCheck = document.getElementById("minibia-bot-ui-name-spoofer-enabled");
        const spoofNameInput = document.getElementById("minibia-bot-ui-spoofed-name");
        const applySpooferBtn = document.getElementById("minibia-bot-ui-apply-spoofer");
        const hidePopupsCheck = document.getElementById("minibia-bot-ui-hide-popups");

        function refreshUI() {
            if (wideCheck) wideCheck.checked = config.wideColumns;
            if (bothCheck) bothCheck.checked = config.showBothHotbarBanks;
            if (nameSpoofCheck) nameSpoofCheck.checked = config.nameSpooferEnabled;
            if (spoofNameInput) spoofNameInput.value = config.spoofedName || "";
            if (hidePopupsCheck) hidePopupsCheck.checked = config.hideFloatingPopups;
        }

        function applyAll() {
            persistConfig();
            applyStyles();
            setTimeout(forceRefreshNameplates, 100);
        }

        if (wideCheck) {
            wideCheck.addEventListener("change", function () {
                config.wideColumns = this.checked;
                applyAll();
            });
        }
        if (bothCheck) {
            bothCheck.addEventListener("change", function () {
                config.showBothHotbarBanks = this.checked;
                applyAll();
            });
        }
        if (nameSpoofCheck) {
            nameSpoofCheck.addEventListener("change", function () {
                config.nameSpooferEnabled = this.checked;
                applyAll();
            });
        }
        if (applySpooferBtn) {
            applySpooferBtn.addEventListener("click", function () {
                const name = spoofNameInput?.value?.trim() || "";
                config.spoofedName = name;
                if (name && !config.nameSpooferEnabled) {
                    config.nameSpooferEnabled = true;
                    if (nameSpoofCheck) nameSpoofCheck.checked = true;
                }
                applyAll();
            });
        }
        if (spoofNameInput) {
            spoofNameInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    if (applySpooferBtn) applySpooferBtn.click();
                }
            });
        }
        if (hidePopupsCheck) {
            hidePopupsCheck.addEventListener("change", function () {
                config.hideFloatingPopups = this.checked;
                applyAll();
            });
        }

        refreshUI();
        applyAll();
    }

    // ---- Injection ----
    if (document.getElementById("minibia-bot-panel")) {
        injectUiTab();
    } else {
        const observer = new MutationObserver(() => {
            if (document.getElementById("minibia-bot-panel")) {
                observer.disconnect();
                injectUiTab();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
            observer.disconnect();
            injectUiTab();
        }, 3000);
    }

    // ---- Public API ----
    bot.uiTweaks = {
        config,
        applyStyles,
        persistConfig,
        forceRefreshNameplates,
        applyNameSpoof,
        applyFloatingTextPatch,
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
            if (typeof enabled === "boolean")
                snapshot[name] = enabled;
        });
        return snapshot;
    }

    function restorePersistedEnabledSnapshot(snapshot) {
        persistedEnabledModules.forEach(([name, storageKey]) => {
            if (typeof snapshot?.[name] !== "boolean")
                return;
            try {
                const raw = window.localStorage.getItem(storageKey);
                const config = raw ? JSON.parse(raw) : {};
                config.enabled = snapshot[name];
                window.localStorage.setItem(storageKey, JSON.stringify(config));
            } catch (e) {
                console.error("[minibia-bot] failed to restore persisted enabled state", {
                    module: name,
                    error: e
                });
            }
        });
    }

    function boot(currentBundle = bundle) {
        const prevSnapshot = getPersistedEnabledSnapshot(window.minibiaBot);
        if (window.minibiaBot?.destroy)
            window.minibiaBot.destroy();
        restorePersistedEnabledSnapshot(prevSnapshot);

        const bot = currentBundle.createBot();
        currentBundle.installPzModule(bot);
        currentBundle.installXrayModule(bot);
        currentBundle.installPanicModule(bot);
        currentBundle.installRuneModule(bot);
        currentBundle.installHealModule(bot);
        currentBundle.installAutoInvisibleModule(bot);
        currentBundle.installAutoMagicShieldModule(bot);
        currentBundle.installBlacklistModule(bot);
        currentBundle.installAutoAttackModule(bot);
        currentBundle.installCaveModule(bot);
        currentBundle.installEquipRingModule(bot);
        currentBundle.installAutoEatModule(bot);
        currentBundle.installTalkModule(bot);
        currentBundle.installAntiBotMonitorModule(bot);
        currentBundle.installSlimeTrainerModule(bot);
        currentBundle.installPaladinModule(bot);
        currentBundle.installLooterModule(bot);
        currentBundle.installLightHackModule(bot);
        currentBundle.installPinkSkullDetectorModule(bot);
        currentBundle.installProfileModule(bot);
        currentBundle.installAntiAfkModule(bot);
        currentBundle.installFisherModule(bot);
        currentBundle.installAutoStackerModule(bot);
        currentBundle.installPlayerAttackMonitorModule(bot);
        currentBundle.installMessageAlertModule(bot);
        currentBundle.installNotificationModule(bot);
        currentBundle.installMovementPatch(bot);
        currentBundle.installOutfitRandomizerModule(bot);
        currentBundle.installComboBotModule(bot);
        currentBundle.installPanel(bot);
        currentBundle.installUiTweaksModule(bot);

        bot.ui.inject();

        bot.start = (...args) => bot.rune.start(...args);
        bot.stop = (...args) => bot.rune.stop(...args);
        bot.reload = () => window.minibiaBotReload?.();
        bot.status = () => ({
            version: bot.version,
            pz: {
                home: bot.pz.getHomePz()
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

        // ---- EXTERNAL COMBAT COOLDOWN MONITOR ----
        bot._combatCooldownUntil = 0;
        bot._wasInCombat = false;
        bot._combatMonitorInterval = null;

        function startCombatMonitor() {
            if (bot._combatMonitorInterval)
                return;
            bot._combatMonitorInterval = setInterval(() => {
                const now = Date.now();
                const hasTarget = !!(window.gameClient?.player?.__target ||
                    window.gameClient?.player?.getTarget?.() ||
                    bot.attack?.getCurrentTarget?.());
                const attackStatus = bot.attack?.status?.() || null;
                const combatActive = !!(attackStatus?.combatActive && Number(attackStatus?.combatDurationMs || 0) < 60000);
                const inCombat = combatActive || hasTarget || (bot.attack?.config?.kiteMode && !!attackStatus?.engagedTargetId);

                if (inCombat) {
                    bot._wasInCombat = true;
                    bot._combatCooldownUntil = 0;
                } else if (bot._wasInCombat) {
                    bot._combatCooldownUntil = now + 3000;
                    bot._wasInCombat = false;
                }
            }, 200);
        }

        function stopCombatMonitor() {
            if (bot._combatMonitorInterval) {
                clearInterval(bot._combatMonitorInterval);
                bot._combatMonitorInterval = null;
            }
        }

        startCombatMonitor();
        bot.addCleanup(stopCombatMonitor);

        // ---- PATCH CAVEBOT TICK TO CHECK COOLDOWN ----
        const origCaveTick = bot.cave?.tick;
        if (origCaveTick) {
            bot.cave.tick = function () {
                // If cooldown is active, wait
                if (this._running && bot._combatCooldownUntil > Date.now()) {
                    if (this._running) {
                        this._timerId = setTimeout(() => this.tick(), this._config.tickMs);
                    }
                    return;
                }
                // Otherwise, run original tick
                return origCaveTick.call(this);
            };
        }

        // Unlock audio on first user interaction
        const unlock = () => {
            if (window.minibiaBot) {
                window.minibiaBot.unlockAudio();
            }
            document.removeEventListener("click", unlock);
            document.removeEventListener("touchstart", unlock);
        };
        document.addEventListener("click", unlock, {
            once: true
        });
        document.addEventListener("touchstart", unlock, {
            once: true
        });

        window.pzBot = bot.pz;
        console.log("[minibia-bot] ready", {
            version: bot.version,
            modules: ["pz", "xray", "panic", "rune", "heal", "invisible", "magicShield", "attack", "cave", "equipRing", "eat", "talk", "ui"]
        });
        console.log("minibiaBot.reload()");
        return bot;
    }

    window.minibiaBotReload = () => {
        try {
            boot(window.__minibiaBotReloadBundle || bundle);
        } catch (e) {
            console.error("[minibia-bot] reload failed", e);
            location.reload();
        }
    };
    delete window.__minibiaBotBundle;
    boot(bundle);
})();
