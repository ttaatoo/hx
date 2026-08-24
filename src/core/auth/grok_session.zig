const std = @import("std");
const debug_trace = @import("../shared/debug_trace.zig");
const host_target = @import("../hosts/target.zig");
const io_mod = @import("../shared/io.zig");
const profile_paths = @import("../shared/profile_paths.zig");
const secret = @import("secret.zig");

const Allocator = std.mem.Allocator;
const schema_version: i64 = 1;
const max_auth_file_bytes: usize = 64 * 1024;
const expiry_skew_ms: i64 = 120 * 1000;
const mutation_lock_file_name = "grok-auth.lock";
const mutation_lock_deadline_ms: u64 = 2000;
const default_lifetime_ms: i64 = 30 * std.time.ms_per_hour * 24;

pub const issuer = "https://auth.x.ai";
pub const auth_file_name = profile_paths.grok_auth_file_name;
pub const grok_cli_auth_file_name = "auth.json";
pub const grok_cli_dir_name = ".grok";
pub const default_client_id = "b1a00492-073a-47ea-816f-4c329264a828";

pub const Origin = enum {
    fx,
    grok_cli,
};

pub fn refreshDeadlineMs(expires_at_ms: i64) i64 {
    return @max(expires_at_ms - expiry_skew_ms, 0);
}

pub const Session = struct {
    access_token: []u8,
    refresh_token: []u8,
    expires_at_ms: i64,
    client_id: []u8,
    origin: Origin = .fx,
    cli_entry_key: []u8 = &.{},

    pub fn deinit(self: *Session, alloc: Allocator) void {
        secret.zeroAndFree(alloc, self.access_token);
        secret.zeroAndFree(alloc, self.refresh_token);
        alloc.free(self.client_id);
        if (self.cli_entry_key.len > 0) alloc.free(self.cli_entry_key);
        self.* = undefined;
    }

    pub fn expired(self: Session, now_ms: i64) bool {
        return refreshDeadlineMs(self.expires_at_ms) <= now_ms;
    }
};

pub const DeleteOutcome = enum {
    deleted,
    missing,
    deleted_not_durable,
};

pub const Mutation = struct {
    fx_dir: io_mod.VerifiedDir,
    lock: io_mod.TimedAdvisoryLock,

    pub fn deinit(self: *Mutation) void {
        self.lock.release();
        self.fx_dir.close();
        self.* = undefined;
    }

    pub fn load(self: *Mutation, alloc: Allocator) !?Session {
        return loadFxFromDir(alloc, &self.fx_dir.dir, true);
    }

    pub fn save(self: *Mutation, alloc: Allocator, session: Session) !void {
        const text = try stringifyFx(alloc, session);
        defer secret.zeroAndFree(alloc, text);
        try io_mod.durableReplaceVerified(alloc, &self.fx_dir, auth_file_name, text);
    }

    pub fn delete(self: *Mutation) !DeleteOutcome {
        self.fx_dir.dir.deleteFile(io_mod.getIo(), auth_file_name) catch |err| switch (err) {
            error.FileNotFound => return .missing,
            else => return err,
        };
        const durable: io_mod.DurableOps = .{};
        durable.sync_dir(durable.ctx, self.fx_dir.dir) catch return .deleted_not_durable;
        return .deleted;
    }
};

pub fn load(alloc: Allocator) !?Session {
    if (comptime host_target.is_wasm) return null;
    if (try loadFx(alloc)) |session| return session;
    return loadGrokCli(alloc);
}

pub fn sourceExists(alloc: Allocator) !bool {
    var session = (try load(alloc)) orelse return false;
    defer session.deinit(alloc);
    return true;
}

pub fn saveNewSession(alloc: Allocator, session: Session) !void {
    if (comptime host_target.is_wasm) return error.GrokOAuthUnavailable;
    var mutation = try beginMutation();
    defer mutation.deinit();
    try mutation.save(alloc, session);
}

pub fn persistRefreshed(alloc: Allocator, session: Session) !void {
    switch (session.origin) {
        .fx => try saveNewSession(alloc, session),
        .grok_cli => try saveGrokCliSession(alloc, session),
    }
}

pub fn beginExistingMutation() !?Mutation {
    if (comptime host_target.is_wasm) return null;
    const home = io_mod.getenv("HOME") orelse return error.HomeNotSet;
    var home_dir = io_mod.VerifiedDir{
        .dir = try std.Io.Dir.openDirAbsolute(io_mod.getIo(), home, .{ .iterate = true }),
    };
    defer home_dir.close();

    const fx_dir = openExistingPrivateFxDir(&home_dir) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    return try lockMutation(fx_dir);
}

fn beginMutation() !Mutation {
    const home = io_mod.getenv("HOME") orelse return error.HomeNotSet;
    var home_dir = io_mod.VerifiedDir{
        .dir = try std.Io.Dir.openDirAbsolute(io_mod.getIo(), home, .{ .iterate = true }),
    };
    defer home_dir.close();

    const fx_dir = try io_mod.openOrCreateVerifiedPrivateDir(&home_dir, profile_paths.root_dir_name);
    return lockMutation(fx_dir);
}

fn lockMutation(open_fx_dir: io_mod.VerifiedDir) !Mutation {
    var fx_dir = open_fx_dir;
    errdefer fx_dir.close();
    var lock = try io_mod.acquireTimedAdvisoryLock(
        &fx_dir,
        mutation_lock_file_name,
        mutation_lock_deadline_ms,
    );
    errdefer lock.release();
    return .{ .fx_dir = fx_dir, .lock = lock };
}

fn openExistingPrivateFxDir(home_dir: *io_mod.VerifiedDir) !io_mod.VerifiedDir {
    var dir = try home_dir.dir.openDir(io_mod.getIo(), profile_paths.root_dir_name, .{
        .iterate = true,
        .follow_symlinks = false,
    });
    errdefer dir.close(io_mod.getIo());

    const initial_stat = try dir.stat(io_mod.getIo());
    if (initial_stat.kind != .directory) return error.DurablePathUnsafe;
    if (initial_stat.permissions.toMode() & 0o200 == 0) return error.PrivateStatePermissionsUnsupported;
    dir.setPermissions(io_mod.getIo(), std.Io.File.Permissions.fromMode(0o700)) catch {
        return error.PrivateStatePermissionsUnsupported;
    };
    const stat = try dir.stat(io_mod.getIo());
    if (stat.kind != .directory or stat.permissions.toMode() & 0o777 != 0o700) {
        return error.PrivateStatePermissionsUnsupported;
    }
    return .{ .dir = dir };
}

fn loadFx(alloc: Allocator) !?Session {
    const home = io_mod.getenv("HOME") orelse return null;
    var home_dir = std.Io.Dir.openDirAbsolute(io_mod.getIo(), home, .{ .iterate = true }) catch |err| {
        debug_trace.logf("auth", "Grok session load failed step=open_home err={s}", .{@errorName(err)});
        return null;
    };
    defer home_dir.close(io_mod.getIo());

    var fx_dir = home_dir.openDir(io_mod.getIo(), profile_paths.root_dir_name, .{
        .iterate = true,
        .follow_symlinks = false,
    }) catch |err| {
        if (err != error.FileNotFound) {
            debug_trace.logf("auth", "Grok session load failed step=open_profile err={s}", .{@errorName(err)});
        }
        return null;
    };
    defer fx_dir.close(io_mod.getIo());
    return loadFxFromDir(alloc, &fx_dir, false);
}

fn loadFxFromDir(alloc: Allocator, fx_dir: *std.Io.Dir, report_open_failure: bool) !?Session {
    var file = fx_dir.openFile(io_mod.getIo(), auth_file_name, .{
        .mode = .read_only,
        .allow_directory = false,
        .follow_symlinks = false,
        .resolve_beneath = true,
    }) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => {
            debug_trace.logf("auth", "Grok session load failed step=open_file err={s}", .{@errorName(err)});
            if (report_open_failure) return err;
            return null;
        },
    };
    defer file.close(io_mod.getIo());

    const stat = try file.stat(io_mod.getIo());
    if (stat.kind != .file or stat.permissions.toMode() & 0o077 != 0) {
        debug_trace.logf("auth", "Grok session load failed step=permissions err=InsecureAuthFile", .{});
        return null;
    }

    const bytes = try io_mod.readFileToEnd(alloc, &file, max_auth_file_bytes);
    defer secret.zeroAndFree(alloc, bytes);
    return parseFx(alloc, bytes) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => {
            debug_trace.logf("auth", "Grok session load failed step=parse err={s}", .{@errorName(err)});
            return null;
        },
    };
}

fn grokHomePath(alloc: Allocator) !?[]u8 {
    if (io_mod.getenv("GROK_HOME")) |override| {
        const trimmed = std.mem.trim(u8, override, " \t\r\n");
        if (trimmed.len == 0) return null;
        return @as(?[]u8, try alloc.dupe(u8, trimmed));
    }
    const home = io_mod.getenv("HOME") orelse return null;
    return @as(?[]u8, try std.fs.path.join(alloc, &.{ home, grok_cli_dir_name }));
}

fn loadGrokCli(alloc: Allocator) !?Session {
    const grok_home = (try grokHomePath(alloc)) orelse return null;
    defer alloc.free(grok_home);
    var grok_dir = std.Io.Dir.openDirAbsolute(io_mod.getIo(), grok_home, .{ .iterate = true }) catch return null;
    defer grok_dir.close(io_mod.getIo());
    var file = grok_dir.openFile(io_mod.getIo(), grok_cli_auth_file_name, .{
        .mode = .read_only,
        .allow_directory = false,
        .follow_symlinks = false,
        .resolve_beneath = true,
    }) catch return null;
    defer file.close(io_mod.getIo());
    const bytes = try io_mod.readFileToEnd(alloc, &file, max_auth_file_bytes);
    defer secret.zeroAndFree(alloc, bytes);
    return parseGrokCli(alloc, bytes) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => {
            debug_trace.logf("auth", "Grok CLI session parse failed err={s}", .{@errorName(err)});
            return null;
        },
    };
}

fn saveGrokCliSession(alloc: Allocator, session: Session) !void {
    const grok_home = (try grokHomePath(alloc)) orelse return error.HomeNotSet;
    defer alloc.free(grok_home);
    var grok_dir = try std.Io.Dir.openDirAbsolute(io_mod.getIo(), grok_home, .{ .iterate = true });
    defer grok_dir.close(io_mod.getIo());
    var file = grok_dir.openFile(io_mod.getIo(), grok_cli_auth_file_name, .{
        .mode = .read_only,
        .allow_directory = false,
        .follow_symlinks = false,
        .resolve_beneath = true,
    }) catch return error.GrokCliAuthMissing;
    const existing = try io_mod.readFileToEnd(alloc, &file, max_auth_file_bytes);
    file.close(io_mod.getIo());
    defer secret.zeroAndFree(alloc, existing);

    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, existing, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidGrokCliAuthSession;
    const entry_key = if (session.cli_entry_key.len > 0)
        session.cli_entry_key
    else
        try std.fmt.allocPrint(alloc, "{s}::{s}", .{ issuer, session.client_id });
    defer if (session.cli_entry_key.len == 0) alloc.free(entry_key);

    var expires_buf: [32]u8 = undefined;
    const expires_at = formatExpiresAtUtc(&expires_buf, session.expires_at_ms);
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try out.writer.writeAll("{\n");
    var it = parsed.value.object.iterator();
    while (it.next()) |pair| {
        if (std.mem.eql(u8, pair.key_ptr.*, entry_key)) continue;
        try out.writer.writeAll("  ");
        try std.json.Stringify.value(pair.key_ptr.*, .{}, &out.writer);
        try out.writer.writeAll(": ");
        try std.json.Stringify.value(pair.value_ptr.*, .{ .whitespace = .indent_2 }, &out.writer);
        try out.writer.writeAll(",\n");
    }
    try out.writer.writeAll("  ");
    try std.json.Stringify.value(entry_key, .{}, &out.writer);
    try out.writer.writeAll(": {\n    \"key\": ");
    try std.json.Stringify.value(session.access_token, .{}, &out.writer);
    try out.writer.writeAll(",\n    \"refresh_token\": ");
    try std.json.Stringify.value(session.refresh_token, .{}, &out.writer);
    try out.writer.writeAll(",\n    \"expires_at\": ");
    try std.json.Stringify.value(expires_at, .{}, &out.writer);
    try out.writer.writeAll("\n  }\n}\n");
    const text = try out.toOwnedSlice();
    defer secret.zeroAndFree(alloc, text);

    var replace = try grok_dir.createFile(io_mod.getIo(), grok_cli_auth_file_name, .{
        .truncate = true,
        .exclusive = false,
    });
    defer replace.close(io_mod.getIo());
    try replace.writeStreamingAll(io_mod.getIo(), text);
}

pub fn parseFx(alloc: Allocator, bytes: []const u8) !Session {
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, bytes, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidGrokAuthSession;
    const object = parsed.value.object;
    const version = object.get("version") orelse return error.InvalidGrokAuthSession;
    if (version != .integer or version.integer != schema_version) return error.InvalidGrokAuthSession;

    const access_token = try dupeRequiredString(alloc, object, "access_token");
    errdefer secret.zeroAndFree(alloc, access_token);
    const refresh_token = try dupeRequiredString(alloc, object, "refresh_token");
    errdefer secret.zeroAndFree(alloc, refresh_token);
    const client_id = dupeOptionalString(alloc, object, "client_id") catch
        try alloc.dupe(u8, default_client_id);
    errdefer alloc.free(client_id);
    const expires_at_ms = requiredInteger(object, "expires_at_ms") catch
        jwtExpiresAtMs(access_token) orelse
        (io_mod.milliTimestamp() + default_lifetime_ms);
    return .{
        .access_token = access_token,
        .refresh_token = refresh_token,
        .expires_at_ms = expires_at_ms,
        .client_id = client_id,
        .origin = .fx,
    };
}

pub fn parseGrokCli(alloc: Allocator, bytes: []const u8) !Session {
    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, bytes, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidGrokCliAuthSession;

    var best: ?Session = null;
    errdefer if (best) |*session| session.deinit(alloc);
    var it = parsed.value.object.iterator();
    while (it.next()) |pair| {
        const session = parseGrokCliEntry(alloc, pair.key_ptr.*, pair.value_ptr.*) catch continue;
        if (best == null or session.expires_at_ms > best.?.expires_at_ms) {
            if (best) |*previous| previous.deinit(alloc);
            best = session;
        } else {
            var rejected = session;
            rejected.deinit(alloc);
        }
    }
    return best orelse error.InvalidGrokCliAuthSession;
}

fn parseGrokCliEntry(alloc: Allocator, key: []const u8, value: std.json.Value) !Session {
    if (value == .string) {
        const access_token = try alloc.dupe(u8, value.string);
        errdefer secret.zeroAndFree(alloc, access_token);
        return .{
            .access_token = access_token,
            .refresh_token = try alloc.dupe(u8, ""),
            .expires_at_ms = jwtExpiresAtMs(access_token) orelse (io_mod.milliTimestamp() + default_lifetime_ms),
            .client_id = try alloc.dupe(u8, clientIdFromEntryKey(key)),
            .origin = .grok_cli,
            .cli_entry_key = try alloc.dupe(u8, key),
        };
    }
    if (value != .object) return error.InvalidGrokCliAuthSession;
    const object = value.object;
    const access_token = try dupeRequiredString(alloc, object, "key");
    errdefer secret.zeroAndFree(alloc, access_token);
    const refresh_token = dupeOptionalString(alloc, object, "refresh_token") catch
        try alloc.dupe(u8, "");
    errdefer secret.zeroAndFree(alloc, refresh_token);
    const expires_at_ms = parseCliExpiry(object.get("expires_at")) orelse
        jwtExpiresAtMs(access_token) orelse
        (io_mod.milliTimestamp() + default_lifetime_ms);
    return .{
        .access_token = access_token,
        .refresh_token = refresh_token,
        .expires_at_ms = expires_at_ms,
        .client_id = try alloc.dupe(u8, clientIdFromEntryKey(key)),
        .origin = .grok_cli,
        .cli_entry_key = try alloc.dupe(u8, key),
    };
}

fn clientIdFromEntryKey(key: []const u8) []const u8 {
    if (std.mem.find(u8, key, "::")) |index| {
        const rest = key[index + 2 ..];
        if (rest.len > 0) return rest;
    }
    return default_client_id;
}

fn parseCliExpiry(value: ?std.json.Value) ?i64 {
    const raw = value orelse return null;
    return switch (raw) {
        .integer => |n| normalizeEpoch(n),
        .float => |n| if (n > 0) normalizeEpoch(@intFromFloat(n)) else null,
        .string => |text| parseExpiresAtString(text),
        else => null,
    };
}

fn parseExpiresAtString(text: []const u8) ?i64 {
    const trimmed = std.mem.trim(u8, text, " \t\r\n");
    if (trimmed.len == 0) return null;
    if (std.fmt.parseInt(i64, trimmed, 10)) |n| {
        return normalizeEpoch(n);
    } else |_| {}
    return parseIso8601Ms(trimmed);
}

fn normalizeEpoch(value: i64) i64 {
    if (value <= 0) return 0;
    if (value > 100_000_000_000) return value;
    return value * std.time.ms_per_s;
}

fn parseIso8601Ms(text: []const u8) ?i64 {
    if (text.len < 19) return null;
    const year = std.fmt.parseInt(i64, text[0..4], 10) catch return null;
    const month = std.fmt.parseInt(u8, text[5..7], 10) catch return null;
    const day = std.fmt.parseInt(u8, text[8..10], 10) catch return null;
    const hour = std.fmt.parseInt(u8, text[11..13], 10) catch return null;
    const minute = std.fmt.parseInt(u8, text[14..16], 10) catch return null;
    const second = std.fmt.parseInt(u8, text[17..19], 10) catch return null;
    if (text[4] != '-' or text[7] != '-' or (text[10] != 'T' and text[10] != 't')) return null;
    if (year < 1970 or month < 1 or month > 12 or day < 1) return null;
    var days: i64 = 0;
    var walking: i64 = 1970;
    while (walking < year) : (walking += 1) {
        days += if (std.time.epoch.isLeapYear(@intCast(walking))) 366 else 365;
    }
    const offsets = [_]i64{ 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
    days += offsets[month - 1] + @as(i64, day) - 1;
    if (month > 2 and std.time.epoch.isLeapYear(@intCast(year))) days += 1;
    const seconds = days * std.time.s_per_day +
        @as(i64, hour) * std.time.s_per_hour +
        @as(i64, minute) * std.time.s_per_min +
        @as(i64, second);
    return seconds * std.time.ms_per_s;
}

fn formatExpiresAtUtc(buf: *[32]u8, expires_at_ms: i64) []const u8 {
    const seconds: u64 = @intCast(@max(@divTrunc(expires_at_ms, std.time.ms_per_s), 0));
    const epoch_seconds = std.time.epoch.EpochSeconds{ .secs = seconds };
    const year_day = epoch_seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    return std.fmt.bufPrint(
        buf,
        "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z",
        .{
            year_day.year,
            month_day.month.numeric(),
            month_day.day_index + 1,
            day_seconds.getHoursIntoDay(),
            day_seconds.getMinutesIntoHour(),
            day_seconds.getSecondsIntoMinute(),
        },
    ) catch "1970-01-01T00:00:00Z";
}

pub fn stringifyFx(alloc: Allocator, session: Session) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    try out.writer.writeAll("{\"version\":1,\"access_token\":");
    try std.json.Stringify.value(session.access_token, .{}, &out.writer);
    try out.writer.writeAll(",\"refresh_token\":");
    try std.json.Stringify.value(session.refresh_token, .{}, &out.writer);
    try out.writer.print(",\"expires_at_ms\":{d},\"client_id\":", .{session.expires_at_ms});
    try std.json.Stringify.value(session.client_id, .{}, &out.writer);
    try out.writer.writeAll("}\n");
    return out.toOwnedSlice();
}

pub fn jwtExpiresAtMs(token: []const u8) ?i64 {
    const first = std.mem.findScalar(u8, token, '.') orelse return null;
    const rest = token[first + 1 ..];
    const second = std.mem.findScalar(u8, rest, '.') orelse return null;
    const payload = rest[0..second];
    var decoding: std.base64.Base64Decoder = .init(std.base64.url_safe_no_pad.alphabet_chars, null);
    const decoded_len = decoding.calcSizeForSlice(payload) catch return null;
    var decoded_buf: [1024]u8 = undefined;
    if (decoded_len > decoded_buf.len) return null;
    decoding.decode(decoded_buf[0..decoded_len], payload) catch return null;
    var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, decoded_buf[0..decoded_len], .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const exp = parsed.value.object.get("exp") orelse return null;
    const seconds: i64 = switch (exp) {
        .integer => |n| n,
        .float => |n| if (n > 0) @intFromFloat(n) else return null,
        else => return null,
    };
    return normalizeEpoch(seconds);
}

fn dupeRequiredString(alloc: Allocator, object: std.json.ObjectMap, key: []const u8) ![]u8 {
    const value = object.get(key) orelse return error.InvalidGrokAuthSession;
    if (value != .string or value.string.len == 0) return error.InvalidGrokAuthSession;
    return alloc.dupe(u8, value.string);
}

fn dupeOptionalString(alloc: Allocator, object: std.json.ObjectMap, key: []const u8) ![]u8 {
    const value = object.get(key) orelse return error.InvalidGrokAuthSession;
    if (value != .string or value.string.len == 0) return error.InvalidGrokAuthSession;
    return alloc.dupe(u8, value.string);
}

fn requiredInteger(object: std.json.ObjectMap, key: []const u8) !i64 {
    const value = object.get(key) orelse return error.InvalidGrokAuthSession;
    if (value != .integer) return error.InvalidGrokAuthSession;
    return value.integer;
}

test "hx grok auth session round trips" {
    const alloc = std.testing.allocator;
    var session = Session{
        .access_token = try alloc.dupe(u8, "grok-access"),
        .refresh_token = try alloc.dupe(u8, "grok-refresh"),
        .expires_at_ms = 1_700_000_000_000,
        .client_id = try alloc.dupe(u8, default_client_id),
    };
    defer session.deinit(alloc);

    const encoded = try stringifyFx(alloc, session);
    defer secret.zeroAndFree(alloc, encoded);
    var decoded = try parseFx(alloc, encoded);
    defer decoded.deinit(alloc);

    try std.testing.expectEqualStrings(session.access_token, decoded.access_token);
    try std.testing.expectEqualStrings(session.refresh_token, decoded.refresh_token);
    try std.testing.expectEqual(session.expires_at_ms, decoded.expires_at_ms);
    try std.testing.expectEqual(Origin.fx, decoded.origin);
}

test "grok CLI auth.json keyed issuer entry parses" {
    const alloc = std.testing.allocator;
    const bytes =
        \\{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"cli-access","refresh_token":"cli-refresh","expires_at":"2026-01-02T03:04:05Z"}}
    ;
    var session = try parseGrokCli(alloc, bytes);
    defer session.deinit(alloc);
    try std.testing.expectEqualStrings("cli-access", session.access_token);
    try std.testing.expectEqualStrings("cli-refresh", session.refresh_token);
    try std.testing.expectEqual(Origin.grok_cli, session.origin);
    try std.testing.expectEqualStrings(default_client_id, session.client_id);
    try std.testing.expect(session.expires_at_ms > 0);
}

test "legacy accounts.x.ai sign-in key parses" {
    const alloc = std.testing.allocator;
    const bytes =
        \\{"https://accounts.x.ai/sign-in":{"key":"legacy-access","refresh_token":"legacy-refresh"}}
    ;
    var session = try parseGrokCli(alloc, bytes);
    defer session.deinit(alloc);
    try std.testing.expectEqualStrings("legacy-access", session.access_token);
    try std.testing.expectEqualStrings("legacy-refresh", session.refresh_token);
}
