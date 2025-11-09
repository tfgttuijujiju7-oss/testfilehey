/**
 * FakeMessageComposer (Kettu plugin)
 *
 * This plugin only manipulates the local Discord client view.
 * It must not be used for impersonation to deceive others or forge logs for malicious purposes.
 * No real messages are ever sent via the Discord API; generated messages are injected purely client-side.
 */

"use strict";

const STORAGE_SLOT = "FakeMessageComposerConfig";
const MESSAGE_ID_PREFIX = "fake-message-composer";
const LOCAL_BADGE_TEXT = "LOCAL FAKE";
const PERSIST_DEBOUNCE_MS = 250;

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    discordId: "",
    messageContent: "This is a local-only fake message.",
    channelMode: "any", // "any" | "specific"
    targetChannelId: "",
    embeds: []
});

class FakeMessageComposer {
    constructor(meta = {}) {
        this.meta = meta;
        this.id = meta.id ?? "tfqttujiujju7-oss.fake-message-composer";
        this.name = meta.name ?? "FakeMessageComposer";
        this.version = meta.version ?? "1.0.0";

        this.storage = kettu?.PluginStorage ?? this.buildFallbackStorage();
        this.logger = kettu?.Logger?.create?.(this.name) ?? kettu?.Logger ?? console;

        this.React = null;
        this.ReactNative = null;
        this.dispatcher = null;
        this.userStore = null;
        this.channelStore = null;
        this.selectedChannelStore = null;
        this.messageActions = null;

        this.config = this.getDefaultConfig();
        this.persistTimer = null;
        this.timestampBadgePatched = false;
        this.injectedMessages = new Map();
        this.userCache = new Map();
        this.channelSelectUnsub = null;
        this.started = false;
        this.patches = [];
    }

    async start() {
        this.log("Starting FakeMessageComposer");
        this.config = this.loadConfig();
        this.started = true;

        try {
            await this.bootstrap();
        } catch (error) {
            this.error("Failed to start FakeMessageComposer", error);
        }
    }

    stop() {
        this.log("Stopping FakeMessageComposer");
        this.started = false;
        this.unsubscribeFromChannelChanges();
        this.unpatchAll();
        this.clearInjectedMessages();
        this.clearPersistTimer();
    }

    async bootstrap() {
        await this.ensureModules();
        await this.patchTimestampBadge();
        this.subscribeToChannelChanges();
        this.refreshForCurrentChannel(true);
    }
    // ------------------------------------------------------------------
    // Storage helpers
    // ------------------------------------------------------------------

    getDefaultConfig() {
        return {
            enabled: DEFAULT_CONFIG.enabled,
            discordId: DEFAULT_CONFIG.discordId,
            messageContent: DEFAULT_CONFIG.messageContent,
            channelMode: DEFAULT_CONFIG.channelMode,
            targetChannelId: DEFAULT_CONFIG.targetChannelId,
            embeds: []
        };
    }

    loadConfig() {
        try {
            const saved = this.storage?.get?.(this.id, STORAGE_SLOT);
            if (!saved) return this.getDefaultConfig();

            const parsed = typeof saved === "string" ? JSON.parse(saved) : saved;
            return this.mergeWithDefaults(parsed);
        } catch (error) {
            this.warn("Failed to load config, reverting to defaults", error);
            return this.getDefaultConfig();
        }
    }

    mergeWithDefaults(configLike = {}) {
        return {
            ...this.getDefaultConfig(),
            ...(configLike ?? {}),
            embeds: this.normalizeEmbeds(configLike?.embeds ?? [])
        };
    }

    normalizeEmbeds(candidate) {
        if (!Array.isArray(candidate)) return [];
        return candidate.map((entry) => ({
            label: typeof entry?.label === "string" ? entry.label : "",
            url: typeof entry?.url === "string" ? entry.url : ""
        }));
    }

    applyConfig(nextConfig, options = {}) {
        this.config = this.mergeWithDefaults(nextConfig ?? this.config);
        if (!options.skipPersist) {
            this.enqueuePersist();
        }
        if (!options.skipReload) {
            this.reapplyFakeMessages();
        }
        return this.config;
    }

    updateConfig(patch, options = {}) {
        const next = { ...this.config, ...(patch ?? {}) };
        return this.applyConfig(next, options);
    }

    async resetConfigToDefaults() {
        const defaults = this.getDefaultConfig();
        this.applyConfig(defaults);
        return defaults;
    }

    enqueuePersist() {
        this.clearPersistTimer();
        this.persistTimer = setTimeout(() => {
            try {
                this.storage?.set?.(this.id, STORAGE_SLOT, this.config);
            } catch (error) {
                this.warn("Failed to persist FakeMessageComposer configuration", error);
            }
        }, PERSIST_DEBOUNCE_MS);
    }

    clearPersistTimer() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
    }

    buildFallbackStorage() {
        const backing = typeof window !== "undefined" ? window.localStorage : null;
        return {
            get: (pluginId, key) => {
                if (!backing) return null;
                try {
                    const raw = backing.getItem(`${pluginId}:${key}`);
                    return raw ? JSON.parse(raw) : null;
                } catch {
                    return null;
                }
            },
            set: (pluginId, key, value) => {
                if (!backing) return;
                try {
                    backing.setItem(`${pluginId}:${key}`, JSON.stringify(value));
                } catch {
                    // ignore quota/storage errors
                }
            },
            delete: (pluginId, key) => {
                if (!backing) return;
                try {
                    backing.removeItem(`${pluginId}:${key}`);
                } catch {
                    // ignore
                }
            }
        };
    }
    // ------------------------------------------------------------------
    // Module lookups and patches
    // ------------------------------------------------------------------

    async ensureModules() {
        if (this.React && this.dispatcher) return;

        const common = kettu?.Modules?.common ?? {};
        this.React = common.React ?? window?.React ?? null;
        this.ReactNative = common.ReactNative ?? null;
        if (!this.React) {
            throw new Error("React is unavailable - cannot render settings UI.");
        }

        this.dispatcher = common.FluxDispatcher ?? (await this.waitForModule(["dispatch", "subscribe"]));
        this.userStore = await this.waitForModule(["getUser", "getCurrentUser"]);
        this.channelStore = await this.waitForModule(["getChannel"]);
        this.selectedChannelStore = await this.waitForModule(["getCurrentlySelectedChannelId", "getChannelId"]);
        this.messageActions = kettu?.Modules?.getByProps?.("receiveMessage", "sendMessage", "deleteMessage") ?? null;
    }

    async patchTimestampBadge() {
        try {
            const timestampModule = await this.waitForModule((module) => {
                return typeof module?.default === "function" && module.default.displayName === "MessageTimestamp";
            });
            if (!timestampModule) throw new Error("MessageTimestamp module not found");

            const React = this.React;
            const Original = timestampModule.default;
            const Container = this.ReactNative?.View ?? "span";
            const TextComponent = this.ReactNative?.Text ?? "span";

            const containerStyle = this.ReactNative
                ? { flexDirection: "row", alignItems: "center" }
                : { display: "inline-flex", alignItems: "center" };
            const badgeStyle = this.ReactNative
                ? {
                      marginLeft: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: 4,
                      fontSize: 10,
                      textTransform: "uppercase",
                      color: "#f0b429",
                      backgroundColor: "rgba(240, 180, 41, 0.15)"
                  }
                : {
                      marginLeft: 6,
                      padding: "0 6px",
                      borderRadius: 4,
                      fontSize: 10,
                      textTransform: "uppercase",
                      color: "#f0b429",
                      backgroundColor: "rgba(240, 180, 41, 0.15)"
                  };

            timestampModule.default = function patchedTimestamp(props) {
                const rendered = Original.apply(this, arguments);
                if (!props?.message?.__fakeMessageComposer) {
                    return rendered;
                }

                return React.createElement(
                    Container,
                    { style: containerStyle },
                    rendered,
                    React.createElement(TextComponent, { style: badgeStyle }, LOCAL_BADGE_TEXT)
                );
            };

            this.timestampBadgePatched = true;
            this.patches.push(() => {
                timestampModule.default = Original;
            });
        } catch (error) {
            this.timestampBadgePatched = false;
            this.warn("Failed to patch MessageTimestamp - falling back to inline prefix", error);
        }
    }

    unpatchAll() {
        while (this.patches.length) {
            const undo = this.patches.shift();
            try {
                undo();
            } catch (error) {
                this.warn("Failed to undo patch", error);
            }
        }
        this.timestampBadgePatched = false;
    }

    async waitForModule(match, timeout = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                let module = null;
                if (Array.isArray(match)) {
                    module = kettu?.Modules?.getByProps?.(...match);
                } else if (typeof match === "function") {
                    module =
                        kettu?.Modules?.find?.(match) ??
                        kettu?.Modules?.getModule?.(match) ??
                        null;
                }
                if (module) return module;
            } catch {
                // ignore errors while retrying
            }
            await this.delay(100);
        }
        throw new Error(`Module ${Array.isArray(match) ? match.join(", ") : "predicate"} not found within timeout`);
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    // ------------------------------------------------------------------
    // Message injection lifecycle
    // ------------------------------------------------------------------

    subscribeToChannelChanges() {
        if (!this.dispatcher || this.channelSelectUnsub) return;

        const handler = (payload = {}) => {
            const channelId =
                payload?.channelId ??
                payload?.channel?.id ??
                payload?.id ??
                (typeof payload === "string" ? payload : null);
            if (channelId) {
                this.refreshChannel(channelId);
            }
        };

        if (this.dispatcher.subscribe && this.dispatcher.unsubscribe) {
            this.dispatcher.subscribe("CHANNEL_SELECT", handler);
            this.channelSelectUnsub = () => this.dispatcher.unsubscribe("CHANNEL_SELECT", handler);
        } else if (this.dispatcher.addListener && this.dispatcher.removeListener) {
            this.dispatcher.addListener("CHANNEL_SELECT", handler);
            this.channelSelectUnsub = () => this.dispatcher.removeListener("CHANNEL_SELECT", handler);
        } else {
            this.warn("Flux dispatcher did not expose subscribe or unsubscribe APIs; channel tracking may be limited.");
        }
    }

    unsubscribeFromChannelChanges() {
        if (this.channelSelectUnsub) {
            try {
                this.channelSelectUnsub();
            } catch (error) {
                this.warn("Failed to unsubscribe from CHANNEL_SELECT", error);
            }
        }
        this.channelSelectUnsub = null;
    }

    refreshForCurrentChannel(force = false) {
        if (!this.started && !force) return;
        const current = this.getCurrentChannelId();
        if (current) {
            this.refreshChannel(current);
        }
    }

    async refreshChannel(channelIdRaw) {
        if (!channelIdRaw) return;
        const channelId = channelIdRaw.toString();

        this.removeFakeMessage(channelId);

        if (!this.shouldRenderInChannel(channelId)) {
            return;
        }

        try {
            const fakeMessage = await this.buildFakeMessage(channelId);
            if (fakeMessage) {
                this.injectFakeMessage(fakeMessage);
                this.injectedMessages.set(channelId, fakeMessage.id);
            }
        } catch (error) {
            this.warn("Failed to create fake message", error);
        }
    }

    shouldRenderInChannel(channelId) {
        if (!this.config.enabled) return false;
        if (!this.isSnowflake(this.config.discordId)) return false;
        if (!this.config.messageContent?.trim()) return false;

        if (this.config.channelMode === "specific") {
            if (!this.isSnowflake(this.config.targetChannelId)) return false;
            return channelId === this.config.targetChannelId;
        }

        return true;
    }

    async buildFakeMessage(channelId) {
        const authorId = this.config.discordId.trim();
        const author = await this.fetchUser(authorId);
        const baseContent = this.config.messageContent;
        if (!baseContent) return null;

        const timestamp = new Date().toISOString();
        const messageId = `${MESSAGE_ID_PREFIX}:${channelId}`;
        const embeds = this.buildEmbeds();
        const guildId = this.channelStore?.getChannel?.(channelId)?.guild_id ?? null;

        return {
            id: messageId,
            type: 0,
            channel_id: channelId,
            guild_id: guildId,
            author: this.buildAuthor(author, authorId),
            content: this.decorateContent(baseContent),
            timestamp,
            edited_timestamp: null,
            tts: false,
            mention_roles: [],
            mention_everyone: false,
            mentions: [],
            attachments: [],
            embeds,
            pinned: false,
            reactions: [],
            flags: 0,
            state: "SENT",
            __fakeMessageComposer: true,
            nonce: `${MESSAGE_ID_PREFIX}:${Date.now()}`
        };
    }

    decorateContent(content) {
        if (this.timestampBadgePatched) return content;
        return `[${LOCAL_BADGE_TEXT}] ${content}`;
    }

    buildAuthor(user, userId) {
        const username =
            user?.username ??
            user?.global_name ??
            user?.globalName ??
            `Unknown User (${userId})`;
        return {
            id: userId,
            username,
            discriminator: user?.discriminator ?? "0000",
            avatar: user?.avatar ?? null,
            bot: user?.bot ?? false,
            public_flags: user?.public_flags ?? 0,
            global_name: user?.global_name ?? user?.globalName ?? null
        };
    }

    buildEmbeds() {
        return (this.config.embeds ?? [])
            .filter((entry) => entry && (entry.label?.trim() || entry.url?.trim()))
            .map((entry, index) => {
                const label = entry.label?.trim() || `Link ${index + 1}`;
                const url = entry.url?.trim();
                if (!url) return null;
                return {
                    type: "link",
                    title: label,
                    url,
                    description: url,
                    color: 0x5865f2,
                    footer: { text: "LOCAL PREVIEW ONLY" }
                };
            })
            .filter(Boolean);
    }

    injectFakeMessage(message) {
        if (this.messageActions?.receiveMessage) {
            this.messageActions.receiveMessage(message.channel_id, message);
            return;
        }

        this.dispatcher?.dispatch?.({
            type: "MESSAGE_CREATE",
            channelId: message.channel_id,
            message,
            optimistic: false
        });
    }

    removeFakeMessage(channelId) {
        const existingId = this.injectedMessages.get(channelId);
        if (!existingId) return;
        this.dispatchMessageDelete(channelId, existingId);
        this.injectedMessages.delete(channelId);
    }

    dispatchMessageDelete(channelId, messageId) {
        if (this.messageActions?.deleteMessage) {
            this.messageActions.deleteMessage(channelId, messageId, false);
            return;
        }

        this.dispatcher?.dispatch?.({
            type: "MESSAGE_DELETE",
            id: messageId,
            channelId
        });
    }

    clearInjectedMessages() {
        for (const [channelId, messageId] of this.injectedMessages.entries()) {
            this.dispatchMessageDelete(channelId, messageId);
        }
        this.injectedMessages.clear();
    }

    async fetchUser(userId) {
        const trimmed = (userId ?? "").trim();
        if (!trimmed) return null;
        if (this.userCache.has(trimmed)) {
            return this.userCache.get(trimmed);
        }

        let user = this.userStore?.getUser?.(trimmed);
        if (!user && this.userStore?.fetchUser) {
            try {
                user = await this.userStore.fetchUser(trimmed);
            } catch (error) {
                this.warn("Failed to fetch user from cache - falling back to placeholder", error);
            }
        }

        if (user) {
            this.userCache.set(trimmed, user);
        }

        return user ?? { id: trimmed };
    }

    getCurrentChannelId() {
        return (
            this.selectedChannelStore?.getCurrentlySelectedChannelId?.() ??
            this.selectedChannelStore?.getChannelId?.() ??
            this.selectedChannelStore?.getMostRecentSelectedTextChannelId?.() ??
            null
        );
    }

    reapplyFakeMessages() {
        if (!this.started) return;
        this.clearInjectedMessages();
        this.refreshForCurrentChannel(true);
    }

    isSnowflake(value) {
        if (typeof value !== "string") return false;
        return /^\d{5,}$/.test(value.trim());
    }
    // ------------------------------------------------------------------
    // Settings UI
    // ------------------------------------------------------------------

    getSettingsPanel() {
        const plugin = this;
        const React = this.React ?? kettu?.Modules?.common?.React;
        const RN = this.ReactNative ?? kettu?.Modules?.common?.ReactNative;
        if (!React) return () => null;

        const primitives = this.getUiPrimitives(React, RN);

        return function FakeMessageComposerSettings() {
            const [settings, setSettings] = React.useState(() => ({
                ...plugin.config,
                embeds: plugin.normalizeEmbeds(plugin.config.embeds)
            }));
            const [previewState, setPreviewState] = React.useState({ status: "idle", user: null });
            const [busy, setBusy] = React.useState(false);

            const sync = React.useCallback(
                (next) => {
                    setSettings(next);
                    plugin.applyConfig(next);
                },
                [setSettings]
            );

            const updatePartial = (patch) => {
                sync({ ...settings, ...patch });
            };

            React.useEffect(() => {
                let cancelled = false;
                (async () => {
                    if (!plugin.isSnowflake(settings.discordId)) {
                        setPreviewState({ status: "invalid", user: null });
                        return;
                    }
                    setPreviewState({ status: "loading", user: null });
                    const user = await plugin.fetchUser(settings.discordId.trim());
                    if (cancelled) return;
                    setPreviewState({
                        status: user?.username ? "resolved" : "fallback",
                        user
                    });
                })();
                return () => {
                    cancelled = true;
                };
            }, [settings.discordId]);

            const updateEmbed = (index, field, value) => {
                const embeds = settings.embeds.slice();
                embeds[index] = { ...embeds[index], [field]: value };
                updatePartial({ embeds });
            };

            const removeEmbed = (index) => {
                const embeds = settings.embeds.slice();
                embeds.splice(index, 1);
                updatePartial({ embeds });
            };

            const addEmbed = () => {
                updatePartial({
                    embeds: [...settings.embeds, { label: "", url: "" }]
                });
            };

            const handleClear = async () => {
                if (busy) return;
                setBusy(true);
                const confirmed = await plugin.confirmReset();
                if (confirmed) {
                    const defaults = await plugin.resetConfigToDefaults();
                    setSettings({
                        ...defaults,
                        embeds: plugin.normalizeEmbeds(defaults.embeds)
                    });
                    setPreviewState({ status: "idle", user: null });
                }
                setBusy(false);
            };

            const channelSpecific = settings.channelMode === "specific";
            const idValid = plugin.isSnowflake(settings.discordId);
            const channelValid = !channelSpecific || plugin.isSnowflake(settings.targetChannelId);

            const embedCards = settings.embeds.map((entry, index) =>
                React.createElement(
                    primitives.View,
                    { key: `embed-${index}`, style: primitives.styles.embedCard },
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.label },
                        `Entry ${index + 1}`
                    ),
                    React.createElement(primitives.TextInput, {
                        style: primitives.styles.input,
                        placeholder: "Label",
                        value: entry.label,
                        onChangeText: (text) => updateEmbed(index, "label", text)
                    }),
                    React.createElement(primitives.TextInput, {
                        style: primitives.styles.input,
                        placeholder: "https://example.com",
                        autoCapitalize: "none",
                        autoCorrect: false,
                        value: entry.url,
                        onChangeText: (text) => updateEmbed(index, "url", text)
                    }),
                    entry.url && !/^https?:\/\//i.test(entry.url.trim())
                        ? React.createElement(
                              primitives.Text,
                              { style: primitives.styles.warning },
                              "URL should start with http:// or https:// (still allowed locally)."
                          )
                        : null,
                    React.createElement(
                        primitives.Button,
                        {
                            style: primitives.styles.removeButton,
                            textStyle: primitives.styles.buttonTextLight,
                            onPress: () => removeEmbed(index)
                        },
                        "Remove"
                    )
                )
            );

            const previewBlock = (() => {
                const { user, status } = previewState;
                if (status === "loading") {
                    return React.createElement(
                        primitives.Text,
                        { style: primitives.styles.muted },
                        "Resolving user..."
                    );
                }
                if (status === "invalid") {
                    return React.createElement(
                        primitives.Text,
                        { style: primitives.styles.warning },
                        "Enter a numeric Discord ID."
                    );
                }
                if (!user?.id) {
                    return React.createElement(
                        primitives.Text,
                        { style: primitives.styles.muted },
                        settings.discordId
                            ? `Using ID: ${settings.discordId}`
                            : "No user selected."
                    );
                }

                const avatar = plugin.getAvatarUrl(user);
                return React.createElement(
                    primitives.View,
                    { style: primitives.styles.previewRow },
                    avatar
                        ? React.createElement(primitives.Image, {
                              source: { uri: avatar },
                              style: primitives.styles.avatar
                          })
                        : null,
                    React.createElement(
                        primitives.View,
                        null,
                        React.createElement(
                            primitives.Text,
                            { style: primitives.styles.previewTitle },
                            plugin.getDisplayName(user)
                        ),
                        React.createElement(
                            primitives.Text,
                            { style: primitives.styles.muted },
                            `ID: ${user.id}`
                        )
                    )
                );
            })();
            return React.createElement(
                primitives.ScrollView,
                { style: primitives.styles.container },
                React.createElement(
                    primitives.Text,
                    { style: primitives.styles.notice },
                    "These fake messages are only visible to you on this device. Please do not use them to mislead others."
                ),

                React.createElement(
                    primitives.Section,
                    null,
                    React.createElement(
                        primitives.Row,
                        { style: primitives.styles.switchRow },
                        React.createElement(
                            primitives.Text,
                            { style: primitives.styles.title },
                            "Enable Fake Message Rendering"
                        ),
                        React.createElement(primitives.Switch, {
                            value: settings.enabled,
                            onValueChange: (value) => updatePartial({ enabled: value })
                        })
                    ),
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.muted },
                        "Turn this off to keep settings but skip injecting messages."
                    )
                ),

                React.createElement(
                    primitives.Section,
                    null,
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.title },
                        "Source User ID"
                    ),
                    React.createElement(primitives.TextInput, {
                        style: primitives.styles.input,
                        placeholder: "Enter Discord User ID (snowflake)",
                        value: settings.discordId,
                        keyboardType: "numeric",
                        onChangeText: (text) => updatePartial({ discordId: text })
                    }),
                    !idValid
                        ? React.createElement(
                              primitives.Text,
                              { style: primitives.styles.warning },
                              "Invalid snowflake. The fake message still renders with a placeholder."
                          )
                        : null,
                    previewBlock
                ),

                React.createElement(
                    primitives.Section,
                    null,
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.title },
                        "Fake Message Content"
                    ),
                    React.createElement(primitives.MultiLineInput, {
                        style: primitives.styles.textArea,
                        multiline: true,
                        numberOfLines: 4,
                        value: settings.messageContent,
                        onChangeText: (text) => updatePartial({ messageContent: text })
                    }),
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.muted },
                        "Supports line breaks. Markdown is rendered by Discord as usual."
                    )
                ),

                React.createElement(
                    primitives.Section,
                    null,
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.title },
                        "Optional Embedded Links"
                    ),
                    embedCards,
                    React.createElement(
                        primitives.Button,
                        {
                            style: primitives.styles.addButton,
                            textStyle: primitives.styles.buttonTextDark,
                            onPress: addEmbed
                        },
                        "Add Link"
                    )
                ),

                React.createElement(
                    primitives.Section,
                    null,
                    React.createElement(
                        primitives.Text,
                        { style: primitives.styles.title },
                        "Channel / Context Behavior"
                    ),
                    React.createElement(
                        primitives.Row,
                        { style: primitives.styles.switchRow },
                        React.createElement(
                            primitives.Text,
                            { style: primitives.styles.label },
                            "Only show in selected channel"
                        ),
                        React.createElement(primitives.Switch, {
                            value: channelSpecific,
                            onValueChange: (value) =>
                                updatePartial({
                                    channelMode: value ? "specific" : "any"
                                })
                        })
                    ),
                    channelSpecific
                        ? React.createElement(primitives.TextInput, {
                              style: primitives.styles.input,
                              placeholder: "Target Channel ID (snowflake)",
                              value: settings.targetChannelId,
                              keyboardType: "numeric",
                              onChangeText: (text) => updatePartial({ targetChannelId: text })
                          })
                        : React.createElement(
                              primitives.Text,
                              { style: primitives.styles.muted },
                              "Fake messages render in whichever channel is currently open."
                          ),
                    channelSpecific && !channelValid
                        ? React.createElement(
                              primitives.Text,
                              { style: primitives.styles.warning },
                              "Set a valid channel ID to avoid accidental display elsewhere."
                          )
                        : null
                ),

                React.createElement(
                    primitives.Section,
                    null,
                    React.createElement(
                        primitives.Button,
                        {
                            style: primitives.styles.clearButton,
                            textStyle: primitives.styles.buttonTextLight,
                            onPress: handleClear,
                            disabled: busy
                        },
                        busy ? "Clearing..." : "Clear Cached Config"
                    )
                )
            );
        };
    }
    getUiPrimitives(React, RN) {
        if (RN) {
            const styles = RN.StyleSheet?.create
                ? RN.StyleSheet.create(this.buildStyleSheet())
                : this.buildStyleSheet();
            const ButtonBase = RN.TouchableOpacity ?? RN.Pressable;
            const Button = (props) =>
                React.createElement(
                    ButtonBase,
                    {
                        onPress: props.onPress,
                        style: [styles.buttonBase, props.style],
                        disabled: props.disabled
                    },
                    React.createElement(
                        RN.Text,
                        { style: [styles.buttonText, props.textStyle] },
                        props.children
                    )
                );

            const Section = (props) =>
                React.createElement(
                    RN.View,
                    { style: styles.section },
                    props.children
                );

            const Row = (props) =>
                React.createElement(
                    RN.View,
                    { style: [styles.row, props.style] },
                    props.children
                );

            const MultiLineInput = (props) =>
                React.createElement(
                    RN.TextInput,
                    { ...props, multiline: true, textAlignVertical: "top" }
                );

            return {
                ScrollView: RN.ScrollView,
                View: RN.View,
                Text: RN.Text,
                TextInput: RN.TextInput,
                MultiLineInput,
                Switch: RN.Switch,
                Button,
                Section,
                Row,
                Image: RN.Image,
                styles
            };
        }

        const styles = this.buildDomStyles();
        const Button = (props) =>
            React.createElement(
                "button",
                {
                    onClick: props.onPress,
                    style: { ...styles.buttonBase, ...props.style },
                    disabled: props.disabled
                },
                props.children
            );

        const Section = (props) =>
            React.createElement("div", { style: styles.section }, props.children);
        const Row = (props) =>
            React.createElement(
                "div",
                { style: { ...styles.row, ...props.style } },
                props.children
            );

        const TextInput = (props) =>
            React.createElement("input", {
                ...props,
                style: { ...styles.input, ...props.style },
                onChange: (e) => props.onChangeText?.(e.target.value)
            });

        const MultiLineInput = (props) =>
            React.createElement("textarea", {
                ...props,
                style: { ...styles.textArea, ...props.style },
                onChange: (e) => props.onChangeText?.(e.target.value)
            });

        const Switch = (props) =>
            React.createElement("input", {
                type: "checkbox",
                checked: !!props.value,
                onChange: (e) => props.onValueChange?.(e.target.checked),
                style: styles.switch
            });

        const Image = (props) =>
            React.createElement("img", {
                ...props,
                src: props.source?.uri ?? props.src,
                style: { ...styles.avatar, ...props.style }
            });

        const Text = (props) =>
            React.createElement(
                "div",
                { style: { ...styles.text, ...props.style } },
                props.children
            );

        return {
            ScrollView: (props) => React.createElement("div", { style: styles.container }, props.children),
            View: (props) =>
                React.createElement(
                    "div",
                    { style: { ...styles.view, ...props.style } },
                    props.children
                ),
            Text,
            TextInput,
            MultiLineInput,
            Switch,
            Button,
            Section,
            Row,
            Image,
            styles
        };
    }

    buildStyleSheet() {
        return {
            container: { padding: 16 },
            section: {
                marginBottom: 16,
                padding: 12,
                backgroundColor: "rgba(255,255,255,0.04)",
                borderRadius: 8
            },
            row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
            switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
            title: { fontSize: 16, fontWeight: "600", marginBottom: 8 },
            label: { fontSize: 14, fontWeight: "500", marginBottom: 6 },
            text: { fontSize: 14, color: "#fff" },
            input: {
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.2)",
                borderRadius: 6,
                padding: 10,
                color: "#fff",
                marginBottom: 8
            },
            textArea: {
                minHeight: 100,
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.2)",
                borderRadius: 6,
                padding: 10,
                color: "#fff",
                marginBottom: 8
            },
            notice: {
                marginBottom: 16,
                padding: 12,
                borderRadius: 6,
                backgroundColor: "rgba(240, 180, 41, 0.15)",
                color: "#f0d38a"
            },
            warning: { color: "#ffb347", fontSize: 12, marginBottom: 8 },
            muted: { color: "#a0a0a0", fontSize: 12, marginBottom: 4 },
            previewRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
            previewTitle: { fontSize: 15, fontWeight: "600" },
            avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 10 },
            embedCard: {
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.1)",
                borderRadius: 6,
                padding: 10,
                marginBottom: 8
            },
            addButton: {
                marginTop: 4,
                backgroundColor: "#f6f6f6"
            },
            clearButton: { backgroundColor: "#e5534b" },
            removeButton: {
                marginTop: 6,
                backgroundColor: "rgba(229, 83, 75, 0.2)",
                borderWidth: 1,
                borderColor: "rgba(229, 83, 75, 0.8)"
            },
            buttonBase: {
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 6,
                alignItems: "center"
            },
            buttonText: { fontWeight: "600", color: "#000" },
            buttonTextDark: { color: "#000" },
            buttonTextLight: { color: "#fff" }
        };
    }

    buildDomStyles() {
        return {
            container: { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", color: "#fff" },
            section: { background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "12px" },
            row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
            switchRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
            title: { fontSize: "16px", fontWeight: 600, marginBottom: "8px" },
            label: { fontSize: "14px", fontWeight: 500, marginBottom: "4px" },
            text: { fontSize: "14px", color: "#fff" },
            input: {
                width: "100%",
                boxSizing: "border-box",
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(0,0,0,0.2)",
                color: "#fff",
                marginBottom: "8px"
            },
            textArea: {
                width: "100%",
                minHeight: "100px",
                boxSizing: "border-box",
                padding: "8px",
                borderRadius: "6px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(0,0,0,0.2)",
                color: "#fff",
                marginBottom: "8px"
            },
            notice: {
                background: "rgba(240, 180, 41, 0.15)",
                color: "#f0d38a",
                padding: "10px",
                borderRadius: "6px"
            },
            warning: { color: "#ffb347", fontSize: "12px", marginBottom: "6px" },
            muted: { color: "#a0a0a0", fontSize: "12px", marginBottom: "4px" },
            previewRow: { display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" },
            previewTitle: { fontSize: "15px", fontWeight: 600 },
            avatar: { width: "40px", height: "40px", borderRadius: "50%" },
            embedCard: {
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "6px",
                padding: "10px",
                marginBottom: "8px"
            },
            addButton: {
                background: "#f6f6f6",
                color: "#000",
                marginTop: "4px"
            },
            clearButton: { background: "#e5534b", color: "#fff" },
            removeButton: {
                marginTop: "6px",
                background: "rgba(229, 83, 75, 0.15)",
                color: "#fff",
                border: "1px solid rgba(229, 83, 75, 0.6)"
            },
            buttonBase: {
                border: "none",
                borderRadius: "6px",
                padding: "10px",
                fontWeight: 600,
                cursor: "pointer"
            },
            buttonTextDark: { color: "#000" },
            buttonTextLight: { color: "#fff" },
            removeButtonText: { color: "#fff" },
            switch: { width: "20px", height: "20px" }
        };
    }
    // ------------------------------------------------------------------
    // UI helpers
    // ------------------------------------------------------------------

    getAvatarUrl(user) {
        if (!user?.id) return null;
        if (user.avatar) {
            const format = user.avatar.startsWith("a_") ? "gif" : "png";
            return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${format}?size=128`;
        }
        const discriminator = Number(user.id) % 5;
        return `https://cdn.discordapp.com/embed/avatars/${discriminator}.png`;
    }

    getDisplayName(user) {
        return user?.global_name ?? user?.globalName ?? `${user?.username ?? "Unknown"}#${user?.discriminator ?? "0000"}`;
    }

    async confirmReset() {
        const message = "Clear all saved FakeMessageComposer settings?";
        if (kettu?.UI?.showConfirmation) {
            return new Promise((resolve) => {
                try {
                    kettu.UI.showConfirmation({
                        title: "Clear Cached Config",
                        body: message,
                        confirmText: "Clear",
                        cancelText: "Cancel",
                        onConfirm: () => resolve(true),
                        onCancel: () => resolve(false)
                    });
                } catch (error) {
                    this.warn("kettu.UI.showConfirmation failed, using fallback confirm", error);
                    resolve(typeof window !== "undefined" ? window.confirm(message) : true);
                }
            });
        }

        if (typeof window !== "undefined" && typeof window.confirm === "function") {
            return window.confirm(message);
        }
        return true;
    }

    // ------------------------------------------------------------------
    // Logging helpers
    // ------------------------------------------------------------------

    log(...args) {
        (this.logger?.info ?? this.logger?.log ?? console.log).call(this.logger ?? console, `[${this.name}]`, ...args);
    }

    warn(...args) {
        (this.logger?.warn ?? console.warn).call(this.logger ?? console, `[${this.name}]`, ...args);
    }

    error(...args) {
        (this.logger?.error ?? console.error).call(this.logger ?? console, `[${this.name}]`, ...args);
    }
}

module.exports = FakeMessageComposer;
