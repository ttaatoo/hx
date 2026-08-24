const std = @import("std");
const io_mod = @import("../shared/io.zig");
const grok_oauth = @import("../auth/grok_oauth.zig");
const grok_session = @import("../auth/grok_session.zig");
const profile_paths = @import("../shared/profile_paths.zig");
const model_provider = @import("model_provider.zig");

const Allocator = std.mem.Allocator;
const max_config_bytes: usize = 64 * 1024;
const max_model_id_bytes: usize = 1024;
const max_models_per_provider: usize = 64;
const max_providers: usize = 8;

pub const ApiKind = enum {
    anthropic_messages,
    openai_completions,

    pub fn parse(value: []const u8) ?ApiKind {
        if (std.ascii.eqlIgnoreCase(value, "anthropic-messages")) return .anthropic_messages;
        if (std.ascii.eqlIgnoreCase(value, "openai-completions")) return .openai_completions;
        return null;
    }

    pub fn defaultBaseUrl(self: ApiKind) []const u8 {
        return switch (self) {
            .anthropic_messages => "https://api.anthropic.com",
            .openai_completions => grok_oauth.chat_proxy_base_url,
        };
    }

    pub fn defaultEnvKey(self: ApiKind) []const u8 {
        return switch (self) {
            .anthropic_messages => "ANTHROPIC_API_KEY",
            .openai_completions => "",
        };
    }

    pub fn defaultBaseUrlEnv(self: ApiKind) []const u8 {
        return switch (self) {
            .anthropic_messages => "ANTHROPIC_BASE_URL",
            .openai_completions => "GROK_CLI_CHAT_PROXY_BASE_URL",
        };
    }

    pub fn chatPath(self: ApiKind) []const u8 {
        return switch (self) {
            .anthropic_messages => "/v1/messages",
            .openai_completions => "/chat/completions",
        };
    }

    pub fn providerId(self: ApiKind) model_provider.ProviderId {
        return switch (self) {
            .anthropic_messages => .anthropic,
            .openai_completions => .xai,
        };
    }
};

pub const ModelRef = struct {
    id: []const u8,
};

pub const ProviderEntry = struct {
    id: []const u8,
    provider: model_provider.ProviderId,
    api: ApiKind,
    base_url: []const u8,
    api_key_spec: ?[]const u8,
    models: []const ModelRef,

    pub fn resolvedApiKey(self: ProviderEntry) ?[]const u8 {
        if (self.api_key_spec) |spec| {
            if (resolveSecretSpec(spec)) |value| return value;
        }
        return nonEmptyEnv(self.api.defaultEnvKey());
    }

    pub fn resolvedBaseUrl(self: ProviderEntry) []const u8 {
        const env_override = nonEmptyEnv(self.api.defaultBaseUrlEnv());
        const configured = std.mem.trim(u8, self.base_url, " \t\r\n");
        const raw = env_override orelse (if (configured.len > 0)
            configured
        else
            self.api.defaultBaseUrl());
        if (self.provider == .xai) return grok_oauth.effectiveChatBaseUrl(raw);
        return raw;
    }

    pub fn isReady(self: ProviderEntry, alloc: Allocator) bool {
        return switch (self.provider) {
            .anthropic => self.resolvedApiKey() != null,
            .xai => grok_session.sourceExists(alloc) catch false,
            .codex => false,
        };
    }

    pub fn containsModel(self: ProviderEntry, model: []const u8) bool {
        return self.matchModel(model) != null;
    }

    pub fn matchModel(self: ProviderEntry, model: []const u8) ?[]const u8 {
        const trimmed = std.mem.trim(u8, model, " \t\r\n");
        if (trimmed.len == 0) return null;
        for (self.models) |entry| {
            if (std.mem.eql(u8, entry.id, trimmed)) return entry.id;
        }
        var prefix_buf: [128]u8 = undefined;
        const prefix = std.fmt.bufPrint(&prefix_buf, "{s}/", .{self.id}) catch return null;
        if (std.mem.startsWith(u8, trimmed, prefix)) {
            const rest = trimmed[prefix.len..];
            for (self.models) |entry| {
                if (std.mem.eql(u8, entry.id, rest)) return entry.id;
            }
        }
        return null;
    }
};

pub const ModelHit = struct {
    provider: *const ProviderEntry,
    model_id: []const u8,
};

pub const Catalog = struct {
    alloc: Allocator,
    entries: []ProviderEntry = &.{},
    owned_strings: std.ArrayList([]u8) = .empty,

    pub fn empty(alloc: Allocator) Catalog {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *Catalog) void {
        for (self.entries) |entry| {
            self.alloc.free(entry.models);
        }
        if (self.entries.len > 0) self.alloc.free(self.entries);
        for (self.owned_strings.items) |value| self.alloc.free(value);
        self.owned_strings.deinit(self.alloc);
        self.* = undefined;
    }

    pub fn findByProvider(self: *const Catalog, provider: model_provider.ProviderId) ?*const ProviderEntry {
        for (self.entries) |*entry| {
            if (entry.provider == provider) return entry;
        }
        return null;
    }

    pub fn findModel(self: *const Catalog, model: []const u8) ?ModelHit {
        for (self.entries) |*entry| {
            if (entry.matchModel(model)) |model_id| {
                return .{ .provider = entry, .model_id = model_id };
            }
        }
        return null;
    }

    pub fn firstUsable(self: *const Catalog) ?ModelHit {
        return self.preferredUsable();
    }

    pub fn preferredUsable(self: *const Catalog) ?ModelHit {
        if (self.usableFor(.xai)) |hit| return hit;
        if (self.usableFor(.anthropic)) |hit| return hit;
        for (self.entries) |*entry| {
            if (self.hitIfReady(entry)) |hit| return hit;
        }
        return null;
    }

    fn usableFor(self: *const Catalog, provider: model_provider.ProviderId) ?ModelHit {
        const entry = self.findByProvider(provider) orelse return null;
        return self.hitIfReady(entry);
    }

    fn hitIfReady(self: *const Catalog, entry: *const ProviderEntry) ?ModelHit {
        if (entry.models.len == 0) return null;
        if (!entry.isReady(self.alloc)) return null;
        if (!isAllowedBaseUrl(entry.resolvedBaseUrl())) return null;
        return .{ .provider = entry, .model_id = entry.models[0].id };
    }

    pub fn firstApiKeyUsable(self: *const Catalog) ?ModelHit {
        for (self.entries) |*entry| {
            if (entry.provider == .xai) continue;
            if (entry.models.len == 0) continue;
            if (entry.resolvedApiKey() == null) continue;
            if (!isAllowedBaseUrl(entry.resolvedBaseUrl())) continue;
            return .{ .provider = entry, .model_id = entry.models[0].id };
        }
        return null;
    }

    pub fn hasUsableKey(self: *const Catalog) bool {
        return self.firstApiKeyUsable() != null;
    }

    pub fn preferredModel(
        self: *const Catalog,
        provider: model_provider.ProviderId,
        requested: ?[]const u8,
    ) ?[]const u8 {
        const entry = self.findByProvider(provider) orelse return null;
        if (requested) |model| {
            if (entry.matchModel(model)) |id| return id;
        }
        if (entry.models.len == 0) return null;
        return entry.models[0].id;
    }
};

pub fn loadFromHome(alloc: Allocator) !Catalog {
    const home = io_mod.getenv("HOME") orelse {
        var catalog = Catalog.empty(alloc);
        errdefer catalog.deinit();
        try ensureDefaultAnthropic(&catalog);
        return catalog;
    };
    return loadFromHomeDir(alloc, home);
}

pub const default_xai_model_ids = [_][]const u8{ "grok-4.6", "grok-code-fast-1" };
pub const default_anthropic_model_ids = [_][]const u8{ "claude-opus-4-6", "claude-sonnet-4-6" };

pub fn loadFromHomeDir(alloc: Allocator, home: []const u8) !Catalog {
    const providers_path = try profile_paths.providersPath(alloc, home);
    defer alloc.free(providers_path);
    if (readOptionalJson(alloc, providers_path)) |bytes| {
        defer alloc.free(bytes);
        var catalog = try parseProvidersDocument(alloc, bytes);
        errdefer catalog.deinit();
        try ensureDefaultXai(&catalog);
        try ensureDefaultAnthropic(&catalog);
        return catalog;
    } else |err| switch (err) {
        error.FileNotFound, error.DurablePathUnsafe => {},
        else => return err,
    }

    var catalog = Catalog.empty(alloc);
    errdefer catalog.deinit();
    try ensureDefaultXai(&catalog);
    try ensureDefaultAnthropic(&catalog);
    return catalog;
}

pub fn resolveSecretSpec(spec: []const u8) ?[]const u8 {
    const trimmed = std.mem.trim(u8, spec, " \t\r\n");
    if (trimmed.len == 0) return null;
    if (trimmed[0] == '$') {
        const name = if (trimmed.len >= 2 and trimmed[1] == '{') blk: {
            if (trimmed[trimmed.len - 1] != '}') return null;
            break :blk trimmed[2 .. trimmed.len - 1];
        } else trimmed[1..];
        if (name.len == 0) return null;
        return nonEmptyEnv(name);
    }
    return trimmed;
}

pub fn isAllowedBaseUrl(url: []const u8) bool {
    const trimmed = std.mem.trim(u8, url, " \t\r\n/");
    if (std.mem.startsWith(u8, trimmed, "https://")) {
        return hostLen(trimmed["https://".len..]) > 0;
    }
    return isLoopbackHttpUrl(trimmed);
}

pub fn isLoopbackHttpUrl(url: []const u8) bool {
    const trimmed = std.mem.trim(u8, url, " \t\r\n");
    if (!std.mem.startsWith(u8, trimmed, "http://")) return false;
    const rest = trimmed["http://".len..];
    const host = hostOf(rest);
    return std.ascii.eqlIgnoreCase(host, "127.0.0.1") or
        std.ascii.eqlIgnoreCase(host, "localhost") or
        std.mem.eql(u8, host, "[::1]");
}

pub fn joinEndpoint(alloc: Allocator, base_url: []const u8, path: []const u8) ![]u8 {
    const base = std.mem.trimEnd(u8, std.mem.trim(u8, base_url, " \t\r\n"), "/");
    if (std.mem.endsWith(u8, base, path)) return alloc.dupe(u8, base);
    if (std.mem.eql(u8, path, "/v1/messages") and std.mem.endsWith(u8, base, "/v1")) {
        return std.fmt.allocPrint(alloc, "{s}/messages", .{base});
    }
    if (std.mem.eql(u8, path, "/chat/completions") and std.mem.endsWith(u8, base, "/v1")) {
        return std.fmt.allocPrint(alloc, "{s}/chat/completions", .{base});
    }
    if (path.len == 0) return alloc.dupe(u8, base);
    return std.fmt.allocPrint(alloc, "{s}{s}", .{ base, path });
}

pub const StartupSelection = struct {
    provider: model_provider.ProviderId,
    model: []const u8,
};

pub fn overlayStartupSelection(
    catalog: *const Catalog,
    fallback: StartupSelection,
    process_model: []const u8,
    provider_explicit: bool,
) StartupSelection {
    if (catalog.findModel(process_model)) |hit| {
        return .{ .provider = hit.provider.provider, .model = hit.model_id };
    }
    if (model_provider.isDirect(fallback.provider) and provider_explicit) {
        if (catalog.findByProvider(fallback.provider)) |entry| {
            if (entry.matchModel(process_model)) |model_id| {
                return .{ .provider = entry.provider, .model = model_id };
            }
            if (entry.models.len > 0 and std.mem.eql(u8, process_model, fallback.model)) {
                return .{ .provider = entry.provider, .model = entry.models[0].id };
            }
        }
        return .{ .provider = fallback.provider, .model = process_model };
    }
    const product_explicit = provider_explicit;
    if (!product_explicit) {
        if (catalog.preferredUsable()) |hit| {
            if (std.mem.eql(u8, process_model, fallback.model)) {
                return .{ .provider = hit.provider.provider, .model = hit.model_id };
            }
        }
    }
    return .{
        .provider = fallback.provider,
        .model = process_model,
    };
}

fn parseProvidersDocument(alloc: Allocator, bytes: []const u8) !Catalog {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, bytes, .{
        .ignore_unknown_fields = true,
    }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return Catalog.empty(alloc),
    };
    defer parsed.deinit();
    if (parsed.value != .object) return Catalog.empty(alloc);
    const providers_value = parsed.value.object.get("providers") orelse return Catalog.empty(alloc);
    if (providers_value != .object) return Catalog.empty(alloc);

    var catalog = Catalog.empty(alloc);
    errdefer catalog.deinit();

    var collected: std.ArrayList(ProviderEntry) = .empty;
    defer collected.deinit(alloc);

    var it = providers_value.object.iterator();
    while (it.next()) |pair| {
        if (collected.items.len >= max_providers) break;
        const entry = (try parseProviderEntry(&catalog, pair.key_ptr.*, pair.value_ptr.*)) orelse continue;
        try collected.append(alloc, entry);
    }

    catalog.entries = try collected.toOwnedSlice(alloc);
    return catalog;
}

fn ensureDefaultXai(catalog: *Catalog) !void {
    if (catalog.findByProvider(.xai) != null) return;
    if (!(grok_session.sourceExists(catalog.alloc) catch false)) return;
    try appendDefaultXai(catalog);
}

fn ensureDefaultAnthropic(catalog: *Catalog) !void {
    if (catalog.findByProvider(.anthropic) != null) return;
    if (nonEmptyEnv("ANTHROPIC_API_KEY") == null) return;
    try appendDefaultAnthropic(catalog);
}

fn appendDefaultXai(catalog: *Catalog) !void {
    const models = try catalog.alloc.alloc(ModelRef, default_xai_model_ids.len);
    errdefer catalog.alloc.free(models);
    for (default_xai_model_ids, 0..) |id, i| {
        models[i] = .{ .id = try retain(catalog, id) };
    }
    const new_entries = try catalog.alloc.alloc(ProviderEntry, catalog.entries.len + 1);
    errdefer catalog.alloc.free(new_entries);
    if (catalog.entries.len > 0) {
        @memcpy(new_entries[0..catalog.entries.len], catalog.entries);
        catalog.alloc.free(catalog.entries);
    }
    new_entries[new_entries.len - 1] = .{
        .id = try retain(catalog, "xai"),
        .provider = .xai,
        .api = .openai_completions,
        .base_url = try retain(catalog, grok_oauth.chat_proxy_base_url),
        .api_key_spec = null,
        .models = models,
    };
    catalog.entries = new_entries;
}

fn appendDefaultAnthropic(catalog: *Catalog) !void {
    const models = try catalog.alloc.alloc(ModelRef, default_anthropic_model_ids.len);
    errdefer catalog.alloc.free(models);
    for (default_anthropic_model_ids, 0..) |id, i| {
        models[i] = .{ .id = try retain(catalog, id) };
    }
    const new_entries = try catalog.alloc.alloc(ProviderEntry, catalog.entries.len + 1);
    errdefer catalog.alloc.free(new_entries);
    if (catalog.entries.len > 0) {
        @memcpy(new_entries[0..catalog.entries.len], catalog.entries);
        catalog.alloc.free(catalog.entries);
    }
    const base_url = nonEmptyEnv("ANTHROPIC_BASE_URL") orelse "https://api.anthropic.com";
    new_entries[new_entries.len - 1] = .{
        .id = try retain(catalog, "anthropic"),
        .provider = .anthropic,
        .api = .anthropic_messages,
        .base_url = try retain(catalog, base_url),
        .api_key_spec = try retain(catalog, "$ANTHROPIC_API_KEY"),
        .models = models,
    };
    catalog.entries = new_entries;
}

fn parseProviderEntry(catalog: *Catalog, key: []const u8, value: std.json.Value) !?ProviderEntry {
    if (value != .object) return null;
    const api_value = value.object.get("api") orelse return null;
    if (api_value != .string) return null;
    const api = ApiKind.parse(api_value.string) orelse return null;

    const id = try retain(catalog, key);
    const provider = model_provider.parse(id) orelse api.providerId();
    if (!model_provider.isDirect(provider)) return null;

    const base_url = if (value.object.get("baseUrl")) |raw|
        if (raw == .string) try retain(catalog, raw.string) else api.defaultBaseUrl()
    else
        api.defaultBaseUrl();
    const api_key_spec = if (value.object.get("apiKey")) |raw|
        if (raw == .string) try retain(catalog, raw.string) else null
    else
        null;
    const models = try parseModels(catalog, value.object.get("models"));
    if (models.len == 0) {
        catalog.alloc.free(models);
        return null;
    }
    return .{
        .id = id,
        .provider = provider,
        .api = api,
        .base_url = base_url,
        .api_key_spec = api_key_spec,
        .models = models,
    };
}

fn parseModels(catalog: *Catalog, value: ?std.json.Value) ![]ModelRef {
    const raw = value orelse return catalog.alloc.alloc(ModelRef, 0);
    if (raw != .array) return catalog.alloc.alloc(ModelRef, 0);
    var models: std.ArrayList(ModelRef) = .empty;
    errdefer models.deinit(catalog.alloc);
    for (raw.array.items) |item| {
        if (models.items.len >= max_models_per_provider) break;
        const id = modelIdFromValue(item) orelse continue;
        if (id.len == 0 or id.len > max_model_id_bytes) continue;
        try models.append(catalog.alloc, .{ .id = try retain(catalog, id) });
    }
    return models.toOwnedSlice(catalog.alloc);
}

fn modelIdFromValue(value: std.json.Value) ?[]const u8 {
    return switch (value) {
        .string => |id| id,
        .object => |object| if (object.get("id")) |id| (if (id == .string) id.string else null) else null,
        else => null,
    };
}

fn retain(catalog: *Catalog, value: []const u8) ![]u8 {
    const owned = try catalog.alloc.dupe(u8, value);
    errdefer catalog.alloc.free(owned);
    try catalog.owned_strings.append(catalog.alloc, owned);
    return owned;
}

fn readOptionalJson(alloc: Allocator, path: []const u8) ![]u8 {
    var file = io_mod.openExistingRegularFile(std.Io.Dir.cwd(), path, .read_only) catch |err| switch (err) {
        error.FileNotFound, error.DurablePathUnsafe => return error.FileNotFound,
        else => return err,
    };
    defer file.close(io_mod.getIo());
    return io_mod.readFileToEnd(alloc, &file, max_config_bytes);
}

fn nonEmptyEnv(name: []const u8) ?[]const u8 {
    const value = io_mod.getenv(name) orelse return null;
    const trimmed = std.mem.trim(u8, value, " \t\r\n");
    return if (trimmed.len == 0) null else trimmed;
}

fn hostOf(rest: []const u8) []const u8 {
    if (rest.len == 0) return rest;
    if (rest[0] == '[') {
        const end = std.mem.findScalar(u8, rest, ']') orelse return rest;
        return rest[0 .. end + 1];
    }
    const slash = std.mem.findScalar(u8, rest, '/') orelse rest.len;
    const prefix = rest[0..slash];
    const colon = std.mem.findScalar(u8, prefix, ':') orelse prefix.len;
    return prefix[0..colon];
}

fn hostLen(rest: []const u8) usize {
    return hostOf(rest).len;
}

test "secret specs resolve environment placeholders and literals" {
    var environ = std.process.Environ.Map.init(std.testing.allocator);
    defer environ.deinit();
    try environ.put("ANTHROPIC_API_KEY", "sk-ant-test");
    try environ.put("EMPTY_KEY", "   ");
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    try std.testing.expectEqualStrings("sk-ant-test", resolveSecretSpec("$ANTHROPIC_API_KEY").?);
    try std.testing.expectEqualStrings("sk-ant-test", resolveSecretSpec("${ANTHROPIC_API_KEY}").?);
    try std.testing.expectEqualStrings("literal-key", resolveSecretSpec("literal-key").?);
    try std.testing.expect(resolveSecretSpec("$EMPTY_KEY") == null);
    try std.testing.expect(resolveSecretSpec("$MISSING_KEY") == null);
}

test "direct provider catalog loads providers.json and matches models" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.hx");
    var providers_file = try tmp.dir.createFile(io_mod.getIo(), "home/.hx/providers.json", .{});
    try providers_file.writeStreamingAll(io_mod.getIo(),
        \\{
        \\  "providers": {
        \\    "anthropic": {
        \\      "api": "anthropic-messages",
        \\      "baseUrl": "https://api.anthropic.com",
        \\      "apiKey": "$ANTHROPIC_API_KEY",
        \\      "models": [{"id": "claude-opus-4-6"}, {"id": "claude-sonnet-4-6"}]
        \\    },
        \\    "xai": {
        \\      "api": "openai-completions",
        \\      "baseUrl": "https://api.x.ai/v1",
        \\      "models": [{"id": "grok-4.6"}, "grok-code-fast-1"]
        \\    }
        \\  }
        \\}
    );
    providers_file.close(io_mod.getIo());
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    try environ.put("ANTHROPIC_API_KEY", "sk-ant-test");
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    var catalog = try loadFromHomeDir(alloc, home);
    defer catalog.deinit();
    try std.testing.expectEqual(@as(usize, 2), catalog.entries.len);
    try std.testing.expectEqualStrings("sk-ant-test", catalog.findByProvider(.anthropic).?.resolvedApiKey().?);
    try std.testing.expect(catalog.findByProvider(.xai).?.resolvedApiKey() == null);
    try std.testing.expectEqualStrings(
        grok_oauth.chat_proxy_base_url,
        catalog.findByProvider(.xai).?.resolvedBaseUrl(),
    );
    try std.testing.expectEqualStrings("claude-opus-4-6", catalog.findModel("anthropic/claude-opus-4-6").?.model_id);
    try std.testing.expectEqualStrings("grok-4.6", catalog.findModel("grok-4.6").?.model_id);
    try std.testing.expect(catalog.findModel("missing-model") == null);
    try std.testing.expectEqualStrings(
        "claude-sonnet-4-6",
        catalog.preferredModel(.anthropic, "claude-sonnet-4-6").?,
    );
    try std.testing.expectEqualStrings("claude-opus-4-6", catalog.preferredModel(.anthropic, "other").?);
}

test "loopback SuperGrok proxy env wins over a baked-in production base URL" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.hx");
    var providers_file = try tmp.dir.createFile(io_mod.getIo(), "home/.hx/providers.json", .{});
    try providers_file.writeStreamingAll(io_mod.getIo(),
        \\{
        \\  "providers": {
        \\    "xai": {
        \\      "api": "openai-completions",
        \\      "baseUrl": "https://cli-chat-proxy.grok.com/v1",
        \\      "models": [{"id": "grok-4.6"}]
        \\    }
        \\  }
        \\}
    );
    providers_file.close(io_mod.getIo());
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    try environ.put("GROK_CLI_CHAT_PROXY_BASE_URL", "http://127.0.0.1:43721/v1");
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    var catalog = try loadFromHomeDir(alloc, home);
    defer catalog.deinit();
    try std.testing.expectEqualStrings(
        "http://127.0.0.1:43721/v1",
        catalog.findByProvider(.xai).?.resolvedBaseUrl(),
    );
}

test "catalog without HOME still loads Anthropic from the process environment" {
    const alloc = std.testing.allocator;
    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("ANTHROPIC_API_KEY", "sk-ant-wasm");
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    var catalog = try loadFromHome(alloc);
    defer catalog.deinit();
    try std.testing.expectEqual(@as(usize, 1), catalog.entries.len);
    try std.testing.expectEqualStrings("claude-opus-4-6", catalog.findModel("claude-opus-4-6").?.model_id);
    try std.testing.expect(catalog.findByProvider(.xai) == null);
}

test "startup overlay prefers FX_MODEL matches and usable direct providers" {
    const alloc = std.testing.allocator;
    var catalog = try parseProvidersDocument(alloc,
        \\{"providers":{"anthropic":{"api":"anthropic-messages","models":[{"id":"claude-opus-4-6"}]}}}
    );
    defer catalog.deinit();

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("ANTHROPIC_API_KEY", "sk-ant-test");
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    const matched = overlayStartupSelection(
        &catalog,
        .{ .provider = .xai, .model = "zai/glm-5.2" },
        "claude-opus-4-6",
        false,
    );
    try std.testing.expectEqual(model_provider.ProviderId.anthropic, matched.provider);
    try std.testing.expectEqualStrings("claude-opus-4-6", matched.model);

    const auto = overlayStartupSelection(
        &catalog,
        .{ .provider = .xai, .model = "zai/glm-5.2" },
        "zai/glm-5.2",
        false,
    );
    try std.testing.expectEqual(model_provider.ProviderId.anthropic, auto.provider);
    try std.testing.expectEqualStrings("claude-opus-4-6", auto.model);

    try environ.put("AI_GATEWAY_API_KEY", "gateway-key");
    const ignore_gateway_key = overlayStartupSelection(
        &catalog,
        .{ .provider = .xai, .model = "zai/glm-5.2" },
        "zai/glm-5.2",
        false,
    );
    try std.testing.expectEqual(model_provider.ProviderId.anthropic, ignore_gateway_key.provider);
    try std.testing.expectEqualStrings("claude-opus-4-6", ignore_gateway_key.model);

    const keep_env_model = overlayStartupSelection(
        &catalog,
        .{ .provider = .xai, .model = "zai/glm-5.2" },
        "env-model",
        false,
    );
    try std.testing.expectEqual(model_provider.ProviderId.xai, keep_env_model.provider);
    try std.testing.expectEqualStrings("env-model", keep_env_model.model);
}

test "startup overlay selects SuperGrok when an OAuth session is present" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.hx");
    var auth_file = try tmp.dir.createFile(io_mod.getIo(), "home/.hx/grok-auth.json", .{
        .permissions = std.Io.File.Permissions.fromMode(0o600),
    });
    try auth_file.writeStreamingAll(io_mod.getIo(),
        \\{"version":1,"access_token":"grok-access","refresh_token":"grok-refresh","expires_at_ms":4102444800000,"client_id":"b1a00492-073a-47ea-816f-4c329264a828"}
        \\
    );
    auth_file.close(io_mod.getIo());
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    var catalog = try loadFromHomeDir(alloc, home);
    defer catalog.deinit();
    try std.testing.expectEqualStrings("grok-4.6", catalog.findModel("grok-4.6").?.model_id);
    try std.testing.expect(catalog.findByProvider(.xai).?.isReady(alloc));

    const auto = overlayStartupSelection(
        &catalog,
        .{ .provider = .xai, .model = "zai/glm-5.2" },
        "zai/glm-5.2",
        false,
    );
    try std.testing.expectEqual(model_provider.ProviderId.xai, auto.provider);
    try std.testing.expectEqualStrings("grok-4.6", auto.model);
}

test "ANTHROPIC_API_KEY without providers.json yields an anthropic catalog entry" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.hx");
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    try environ.put("ANTHROPIC_API_KEY", "sk-ant-default");
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    var catalog = try loadFromHomeDir(alloc, home);
    defer catalog.deinit();
    const entry = catalog.findByProvider(.anthropic) orelse return error.TestExpectedAnthropicEntry;
    try std.testing.expectEqualStrings("anthropic", entry.id);
    try std.testing.expectEqual(ApiKind.anthropic_messages, entry.api);
    try std.testing.expectEqualStrings("https://api.anthropic.com", entry.resolvedBaseUrl());
    try std.testing.expectEqualStrings("sk-ant-default", entry.resolvedApiKey().?);
    try std.testing.expectEqual(@as(usize, 2), entry.models.len);
    try std.testing.expectEqualStrings("claude-opus-4-6", entry.models[0].id);
    try std.testing.expectEqualStrings("claude-sonnet-4-6", entry.models[1].id);
}

test "endpoint joining and URL allowlist" {
    const alloc = std.testing.allocator;
    const anthropic = try joinEndpoint(alloc, "https://api.anthropic.com", "/v1/messages");
    defer alloc.free(anthropic);
    try std.testing.expectEqualStrings("https://api.anthropic.com/v1/messages", anthropic);

    const prefixed = try joinEndpoint(alloc, "https://proxy.example/v1", "/v1/messages");
    defer alloc.free(prefixed);
    try std.testing.expectEqualStrings("https://proxy.example/v1/messages", prefixed);

    const xai = try joinEndpoint(alloc, "https://api.x.ai/v1", "/chat/completions");
    defer alloc.free(xai);
    try std.testing.expectEqualStrings("https://api.x.ai/v1/chat/completions", xai);

    try std.testing.expect(isAllowedBaseUrl("https://api.anthropic.com"));
    try std.testing.expect(isAllowedBaseUrl("https://cli-chat-proxy.grok.com/v1"));
    try std.testing.expect(isAllowedBaseUrl("http://127.0.0.1:1234"));
    try std.testing.expect(isAllowedBaseUrl("http://localhost:4000"));
    try std.testing.expect(!isAllowedBaseUrl("http://example.com"));
    try std.testing.expect(!isAllowedBaseUrl("ftp://api.anthropic.com"));
}

var stable_test_environ: ?*std.process.Environ.Map = null;

fn stableEmptyTestEnviron() !*const std.process.Environ.Map {
    if (stable_test_environ) |map| return map;
    const alloc = std.heap.page_allocator;
    const map = try alloc.create(std.process.Environ.Map);
    map.* = std.process.Environ.Map.init(alloc);
    stable_test_environ = map;
    return map;
}
