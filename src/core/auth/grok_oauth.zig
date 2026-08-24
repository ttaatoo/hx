const std = @import("std");
const grok_session = @import("grok_session.zig");
const host = @import("../hosts/host.zig");
const io_mod = @import("../shared/io.zig");
const login_flow = @import("login_flow.zig");
const oauth = @import("oauth.zig");
const oauth_transport = @import("oauth_transport.zig");
const secret = @import("secret.zig");

const Allocator = std.mem.Allocator;

pub const client_id = grok_session.default_client_id;
pub const issuer_url = grok_session.issuer;
pub const token_url = "https://auth.x.ai/oauth2/token";
pub const device_authorization_url = "https://auth.x.ai/oauth2/device/code";
pub const chat_proxy_base_url = "https://cli-chat-proxy.grok.com/v1";
pub const token_auth_header = "xai-grok-cli";
pub const client_identifier = "xai-grok-cli";
pub const default_client_version = "0.2.93";
pub const scope = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

const e2e_issuer_url_env = "FX_E2E_GROK_ISSUER_URL";
const e2e_token_url_env = "FX_E2E_GROK_TOKEN_URL";
const e2e_device_url_env = "FX_E2E_GROK_DEVICE_URL";
const client_version_env = "GROK_CLI_VERSION";
pub const RefreshMode = enum {
    if_needed,
    force,
    stored,
};

pub const Access = struct {
    access_token: []u8,
    refresh_after_ms: i64,

    pub fn deinit(self: *Access, alloc: Allocator) void {
        secret.zeroAndFree(alloc, self.access_token);
        self.* = undefined;
    }
};

pub fn clientVersion() []const u8 {
    if (io_mod.getenv(client_version_env)) |value| {
        const trimmed = std.mem.trim(u8, value, " \t\r\n");
        if (trimmed.len > 0) return trimmed;
    }
    return default_client_version;
}

pub fn chatProxyUserAgent(alloc: Allocator) ![]u8 {
    return std.fmt.allocPrint(alloc, "grok-cli/{s}", .{clientVersion()});
}

pub fn isDeveloperApiHost(url: []const u8) bool {
    const trimmed = std.mem.trim(u8, url, " \t\r\n");
    const rest = if (std.mem.startsWith(u8, trimmed, "https://"))
        trimmed["https://".len..]
    else if (std.mem.startsWith(u8, trimmed, "http://"))
        trimmed["http://".len..]
    else
        return false;
    const host_end = std.mem.findScalar(u8, rest, '/') orelse rest.len;
    const host_name = rest[0..host_end];
    const hostname = if (std.mem.lastIndexOfScalar(u8, host_name, ':')) |colon|
        host_name[0..colon]
    else
        host_name;
    return std.ascii.eqlIgnoreCase(hostname, "api.x.ai");
}

pub fn effectiveChatBaseUrl(configured: []const u8) []const u8 {
    if (isDeveloperApiHost(configured)) return chat_proxy_base_url;
    const trimmed = std.mem.trim(u8, configured, " \t\r\n");
    if (trimmed.len == 0) return chat_proxy_base_url;
    return trimmed;
}

pub fn startSignIn(
    runtime: *login_flow.SignInRuntime,
    alloc: Allocator,
    transport: oauth_transport.Provider,
) !bool {
    const prepared = try prepareDeviceSignIn(alloc, transport);
    return runtime.startPrepared(
        alloc,
        prepared,
        .{
            .oauth_transport = transport,
            .complete = completeSignIn,
            .save = saveSignIn,
        },
    );
}

pub fn runLogin(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    url_opener: host.UrlOpener,
) !void {
    var runtime: login_flow.SignInRuntime = .{};
    defer runtime.deinit(alloc);
    if (!try startSignIn(&runtime, alloc, transport)) return error.GrokLoginBusy;

    const authorization_url = (try runtime.browserUrlAlloc(alloc)) orelse
        return error.GrokAuthorizationUrlMissing;
    defer alloc.free(authorization_url);
    const snapshot = runtime.snapshot();
    try writeStdout("Open this URL to sign in with SuperGrok / X Premium+:\n");
    try writeStdout(authorization_url);
    try writeStdout("\n");
    if (snapshot.user_code.len > 0) {
        try writeStdout("Code: ");
        try writeStdout(snapshot.user_code);
        try writeStdout("\n");
    }
    try writeStdout("\nWaiting for authorization...\n");
    if (!login_flow.browserOpenSuppressed()) {
        _ = url_opener.open(alloc, authorization_url) catch false;
    }

    while (true) {
        switch (runtime.pollTransition(alloc)) {
            .none => try io_mod.getIo().sleep(.fromMilliseconds(50), .awake),
            .succeeded => |completion| {
                var owned = completion;
                defer owned.deinit(alloc);
                try writeStdout("Signed in with SuperGrok. This uses SuperGrok / X Premium+ quota, not xAI API credits.\n");
                return;
            },
            .failed => |err| return err,
            .cancelled => return error.Cancelled,
        }
    }
}

pub fn logout() !grok_session.DeleteOutcome {
    var mutation = (try grok_session.beginExistingMutation()) orelse return .missing;
    defer mutation.deinit();
    return mutation.delete();
}

pub fn sourceExists(alloc: Allocator) !bool {
    return grok_session.sourceExists(alloc);
}

pub fn loadAccess(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    mode: RefreshMode,
) !?Access {
    if (mode == .stored) {
        var session = (try grok_session.load(alloc)) orelse return null;
        defer session.deinit(alloc);
        return takeAccess(&session);
    }

    var session = (try grok_session.load(alloc)) orelse return null;
    defer session.deinit(alloc);
    if (mode == .force or session.expired(io_mod.milliTimestamp())) {
        try refreshSession(alloc, transport, &session);
        try grok_session.persistRefreshed(alloc, session);
    }
    return takeAccess(&session);
}

fn takeAccess(session: *grok_session.Session) Access {
    const access_token = session.access_token;
    session.access_token = &.{};
    return .{
        .access_token = access_token,
        .refresh_after_ms = grok_session.refreshDeadlineMs(session.expires_at_ms),
    };
}

fn refreshSession(
    alloc: Allocator,
    transport: oauth_transport.Provider,
    session: *grok_session.Session,
) !void {
    if (session.refresh_token.len == 0) return error.GrokRefreshTokenMissing;
    var metadata = try configuredMetadata(alloc);
    defer metadata.deinit(alloc);
    var token = try oauth.refreshToken(
        alloc,
        transport,
        metadata,
        session.client_id,
        session.refresh_token,
    );
    defer token.deinit(alloc);
    const refresh_token = if (token.refresh_token) |rotated| rotated else try alloc.dupe(u8, session.refresh_token);
    if (token.refresh_token != null) token.refresh_token = null;
    errdefer secret.zeroAndFree(alloc, refresh_token);
    const expires_at_ms = oauth.expiry_timestamp_ms(io_mod.milliTimestamp(), token.expires_in) catch
        grok_session.jwtExpiresAtMs(token.access_token) orelse
        (io_mod.milliTimestamp() + std.time.ms_per_hour);
    secret.zeroAndFree(alloc, session.access_token);
    secret.zeroAndFree(alloc, session.refresh_token);
    session.access_token = token.access_token;
    session.refresh_token = refresh_token;
    session.expires_at_ms = expires_at_ms;
    token.access_token = &.{};
}

fn prepareDeviceSignIn(alloc: Allocator, transport: oauth_transport.Provider) !login_flow.PreparedLogin {
    var metadata = try configuredMetadata(alloc);
    errdefer metadata.deinit(alloc);
    var device = try oauth.requestDeviceAuthorizationWithScope(
        alloc,
        transport,
        metadata,
        client_id,
        scope,
    );
    errdefer device.deinit(alloc);
    const owned_client_id = try alloc.dupe(u8, client_id);
    return .{
        .metadata = metadata,
        .device = device,
        .client_id = owned_client_id,
    };
}

fn configuredMetadata(alloc: Allocator) !oauth.Metadata {
    const configured_issuer = try configuredEndpoint(alloc, e2e_issuer_url_env, issuer_url);
    errdefer alloc.free(configured_issuer);
    const configured_device = try configuredEndpoint(alloc, e2e_device_url_env, device_authorization_url);
    errdefer alloc.free(configured_device);
    const configured_token = try configuredEndpoint(alloc, e2e_token_url_env, token_url);
    return .{
        .issuer = configured_issuer,
        .device_authorization_endpoint = configured_device,
        .token_endpoint = configured_token,
    };
}

fn configuredEndpoint(alloc: Allocator, env_name: []const u8, fallback: []const u8) ![]u8 {
    if (io_mod.getenv(env_name)) |value| {
        const trimmed = std.mem.trim(u8, value, " \t\r\n");
        if (trimmed.len > 0) {
            if (!isLoopbackHttpUrl(trimmed)) return error.GrokOAuthEndpointNotLoopback;
            return alloc.dupe(u8, trimmed);
        }
    }
    return alloc.dupe(u8, fallback);
}

fn isLoopbackHttpUrl(url: []const u8) bool {
    if (!std.mem.startsWith(u8, url, "http://")) return false;
    const rest = url["http://".len..];
    const host_end = std.mem.findScalar(u8, rest, '/') orelse rest.len;
    const host_port = rest[0..host_end];
    const hostname = if (std.mem.lastIndexOfScalar(u8, host_port, ':')) |colon|
        host_port[0..colon]
    else
        host_port;
    return std.ascii.eqlIgnoreCase(hostname, "127.0.0.1") or
        std.ascii.eqlIgnoreCase(hostname, "localhost") or
        std.mem.eql(u8, hostname, "[::1]");
}

fn completeSignIn(
    _: ?*anyopaque,
    alloc: Allocator,
    _: []const u8,
    _: []const u8,
    token: *oauth.TokenSet,
) !login_flow.SignInCompletion {
    const refresh_token = token.refresh_token orelse return error.GrokRefreshTokenMissing;
    const expires_at_ms = oauth.expiry_timestamp_ms(io_mod.milliTimestamp(), token.expires_in) catch
        grok_session.jwtExpiresAtMs(token.access_token) orelse
        (io_mod.milliTimestamp() + std.time.ms_per_hour);
    const completion: login_flow.SignInCompletion = .{ .grok = .{
        .access_token = token.access_token,
        .refresh_token = refresh_token,
        .expires_at_ms = expires_at_ms,
        .client_id = try alloc.dupe(u8, client_id),
        .origin = .fx,
    } };
    token.access_token = &.{};
    token.refresh_token = null;
    return completion;
}

fn saveSignIn(_: ?*anyopaque, alloc: Allocator, completion: login_flow.SignInCompletion) !void {
    const session = switch (completion) {
        .grok => |session| session,
        .chatgpt => return error.InvalidSignInCompletion,
    };
    try grok_session.saveNewSession(alloc, session);
}

fn writeStdout(text: []const u8) !void {
    try std.Io.File.stdout().writeStreamingAll(io_mod.getIo(), text);
}

test "developer API hosts rewrite to the Grok CLI chat proxy" {
    try std.testing.expect(isDeveloperApiHost("https://api.x.ai/v1"));
    try std.testing.expect(isDeveloperApiHost("https://api.x.ai"));
    try std.testing.expect(!isDeveloperApiHost("https://cli-chat-proxy.grok.com/v1"));
    try std.testing.expectEqualStrings(
        chat_proxy_base_url,
        effectiveChatBaseUrl("https://api.x.ai/v1"),
    );
    try std.testing.expectEqualStrings(
        "https://cli-chat-proxy.grok.com/v1",
        effectiveChatBaseUrl("https://cli-chat-proxy.grok.com/v1"),
    );
}

test "Grok device authorization form uses the CLI scope" {
    const alloc = std.testing.allocator;
    const State = struct {
        payload: [512]u8 = undefined,
        payload_len: usize = 0,
        url: [256]u8 = undefined,
        url_len: usize = 0,

        fn execute(
            raw: ?*anyopaque,
            response_alloc: Allocator,
            request: oauth_transport.Request,
        ) !oauth_transport.Response {
            const self: *@This() = @ptrCast(@alignCast(raw.?));
            const payload = request.payload orelse &.{};
            self.payload_len = @min(payload.len, self.payload.len);
            @memcpy(self.payload[0..self.payload_len], payload[0..self.payload_len]);
            self.url_len = @min(request.url.len, self.url.len);
            @memcpy(self.url[0..self.url_len], request.url[0..self.url_len]);
            return .{
                .disposition = .accepted,
                .body = try response_alloc.dupe(
                    u8,
                    "{\"device_code\":\"dc\",\"user_code\":\"ABCD-EFGH\",\"verification_uri\":\"https://auth.x.ai/activate\",\"expires_in\":600,\"interval\":5}",
                ),
            };
        }
    };
    var state = State{};
    var metadata = oauth.Metadata{
        .issuer = try alloc.dupe(u8, issuer_url),
        .device_authorization_endpoint = try alloc.dupe(u8, device_authorization_url),
        .token_endpoint = try alloc.dupe(u8, token_url),
    };
    defer metadata.deinit(alloc);
    var device = try oauth.requestDeviceAuthorizationWithScope(
        alloc,
        .{ .context = &state, .execute_fn = State.execute },
        metadata,
        client_id,
        scope,
    );
    defer device.deinit(alloc);
    try std.testing.expect(std.mem.find(u8, state.payload[0..state.payload_len], "grok-cli%3Aaccess") != null);
    try std.testing.expect(std.mem.find(u8, state.payload[0..state.payload_len], "offline_access") != null);
    try std.testing.expectEqualStrings("ABCD-EFGH", device.user_code);
}

test "Grok refresh form posts the public CLI client" {
    const alloc = std.testing.allocator;
    const State = struct {
        payload: [512]u8 = undefined,
        payload_len: usize = 0,

        fn execute(
            raw: ?*anyopaque,
            response_alloc: Allocator,
            request: oauth_transport.Request,
        ) !oauth_transport.Response {
            const self: *@This() = @ptrCast(@alignCast(raw.?));
            const payload = request.payload orelse &.{};
            self.payload_len = @min(payload.len, self.payload.len);
            @memcpy(self.payload[0..self.payload_len], payload[0..self.payload_len]);
            return .{
                .disposition = .accepted,
                .body = try response_alloc.dupe(
                    u8,
                    "{\"token_type\":\"Bearer\",\"access_token\":\"next-access\",\"refresh_token\":\"next-refresh\",\"expires_in\":3600}",
                ),
            };
        }
    };
    var state = State{};
    var session = grok_session.Session{
        .access_token = try alloc.dupe(u8, "old-access"),
        .refresh_token = try alloc.dupe(u8, "old-refresh"),
        .expires_at_ms = 1,
        .client_id = try alloc.dupe(u8, client_id),
    };
    defer session.deinit(alloc);
    try refreshSession(alloc, .{ .context = &state, .execute_fn = State.execute }, &session);
    try std.testing.expectEqualStrings("next-access", session.access_token);
    try std.testing.expectEqualStrings("next-refresh", session.refresh_token);
    try std.testing.expect(std.mem.find(u8, state.payload[0..state.payload_len], "grant_type=refresh_token") != null);
    try std.testing.expect(std.mem.find(u8, state.payload[0..state.payload_len], client_id) != null);
}
