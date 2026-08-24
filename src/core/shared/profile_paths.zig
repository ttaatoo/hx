const std = @import("std");
const io_mod = @import("io.zig");
const product = @import("product.zig");

const Allocator = std.mem.Allocator;

pub const root_dir_name = ".hx";
pub const leftover_root_dir_name = product.leftover_root_dir_name;
pub const auth_file_name = "auth.json";
pub const chatgpt_auth_file_name = "chatgpt-auth.json";
pub const grok_auth_file_name = "grok-auth.json";
pub const api_key_file_name = "api-key";
pub const sessions_dir_name = "sessions";
pub const prompt_history_file_name = "history.jsonl";
pub const usage_file_name = "usage.jsonl";
pub const usage_recovery_dir_name = "usage-recovery";
pub const backups_dir_name = "backups";
pub const mcp_credentials_dir_name = "mcp-credentials";
pub const mcp_credentials_file_name = "credentials.json";

const settings_file_name = "settings.json";
const providers_file_name = "providers.json";
const mcp_config_file_name = "mcp.json";
const managed_skills_dir_name = "skills";
const memories_file_name = "memories.json";
const logs_dir_name = "logs";
const trace_log_file_name = "trace.log";
const recordings_dir_name = "recordings";

pub fn rootDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name });
}

fn homeChildExists(home_dir: std.Io.Dir, name: []const u8) bool {
    const stat = home_dir.statFile(io_mod.getIo(), name, .{ .follow_symlinks = false }) catch return false;
    return stat.kind == .directory;
}

/// If `~/.hx` is missing and leftover `~/.fx` exists, copy it. Yeet-style:
/// copy, do not move, and never overwrite an existing hx profile.
pub fn adoptLeftoverRootIfMissing(alloc: Allocator, home: []const u8) void {
    if (home.len == 0) return;
    const zio = io_mod.getIo();
    var home_dir = std.Io.Dir.openDirAbsolute(zio, home, .{
        .iterate = true,
        .follow_symlinks = false,
    }) catch return;
    defer home_dir.close(zio);

    if (homeChildExists(home_dir, root_dir_name)) return;
    if (!homeChildExists(home_dir, leftover_root_dir_name)) return;

    const src = std.fs.path.join(alloc, &.{ home, leftover_root_dir_name }) catch return;
    defer alloc.free(src);
    const dest = std.fs.path.join(alloc, &.{ home, root_dir_name }) catch return;
    defer alloc.free(dest);

    const result = std.process.run(alloc, zio, .{
        .argv = &.{ "cp", "-R", src, dest },
    }) catch return;
    defer alloc.free(result.stdout);
    defer alloc.free(result.stderr);
}

pub fn openOrCreateRoot(alloc: Allocator, home: *io_mod.VerifiedDir, home_path: []const u8) !io_mod.VerifiedDir {
    adoptLeftoverRootIfMissing(alloc, home_path);
    return io_mod.openOrCreateVerifiedPrivateDir(home, root_dir_name);
}

pub fn settingsPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, settings_file_name });
}

pub fn providersPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, providers_file_name });
}

pub fn mcpConfigPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, mcp_config_file_name });
}

pub fn mcpCredentialsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, mcp_credentials_dir_name });
}

pub fn mcpCredentialsPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{
        home,
        root_dir_name,
        mcp_credentials_dir_name,
        mcp_credentials_file_name,
    });
}

pub fn managedSkillsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, managed_skills_dir_name });
}

pub fn authPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, auth_file_name });
}

pub fn chatgptAuthPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, chatgpt_auth_file_name });
}

pub fn apiKeyPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, api_key_file_name });
}

pub fn sessionsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, sessions_dir_name });
}

pub fn promptHistoryPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, prompt_history_file_name });
}

pub fn memoriesPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, memories_file_name });
}

pub fn backupsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, backups_dir_name });
}

pub fn logsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, logs_dir_name });
}

pub fn traceLogPath(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, logs_dir_name, trace_log_file_name });
}

pub fn recordingsDir(alloc: Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(alloc, &.{ home, root_dir_name, recordings_dir_name });
}

test "profile path helpers preserve current default locations" {
    const alloc = std.testing.allocator;

    const root = try rootDir(alloc, "/tmp/fake-home");
    defer alloc.free(root);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx", root);

    const settings = try settingsPath(alloc, "/tmp/fake-home");
    defer alloc.free(settings);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/settings.json", settings);

    const providers = try providersPath(alloc, "/tmp/fake-home");
    defer alloc.free(providers);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/providers.json", providers);

    const mcp = try mcpConfigPath(alloc, "/tmp/fake-home");
    defer alloc.free(mcp);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/mcp.json", mcp);

    const mcp_credentials_dir = try mcpCredentialsDir(alloc, "/tmp/fake-home");
    defer alloc.free(mcp_credentials_dir);
    try std.testing.expectEqualStrings(
        "/tmp/fake-home/.hx/mcp-credentials",
        mcp_credentials_dir,
    );

    const mcp_credentials = try mcpCredentialsPath(alloc, "/tmp/fake-home");
    defer alloc.free(mcp_credentials);
    try std.testing.expectEqualStrings(
        "/tmp/fake-home/.hx/mcp-credentials/credentials.json",
        mcp_credentials,
    );

    const skills = try managedSkillsDir(alloc, "/tmp/fake-home");
    defer alloc.free(skills);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/skills", skills);

    const auth = try authPath(alloc, "/tmp/fake-home");
    defer alloc.free(auth);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/auth.json", auth);

    const chatgpt_auth = try chatgptAuthPath(alloc, "/tmp/fake-home");
    defer alloc.free(chatgpt_auth);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/chatgpt-auth.json", chatgpt_auth);

    const api_key = try apiKeyPath(alloc, "/tmp/fake-home");
    defer alloc.free(api_key);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/api-key", api_key);

    const sessions = try sessionsDir(alloc, "/tmp/fake-home");
    defer alloc.free(sessions);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/sessions", sessions);

    const history = try promptHistoryPath(alloc, "/tmp/fake-home");
    defer alloc.free(history);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/history.jsonl", history);

    const memories = try memoriesPath(alloc, "/tmp/fake-home");
    defer alloc.free(memories);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/memories.json", memories);

    const backups = try backupsDir(alloc, "/tmp/fake-home");
    defer alloc.free(backups);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/backups", backups);

    const logs = try logsDir(alloc, "/tmp/fake-home");
    defer alloc.free(logs);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/logs", logs);

    const trace = try traceLogPath(alloc, "/tmp/fake-home");
    defer alloc.free(trace);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/logs/trace.log", trace);

    const recordings = try recordingsDir(alloc, "/tmp/fake-home");
    defer alloc.free(recordings);
    try std.testing.expectEqualStrings("/tmp/fake-home/.hx/recordings", recordings);
}

test "leftover ~/.fx is copied into ~/.hx when hx profile is missing" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, ".");
    defer alloc.free(home);

    try tmp.dir.createDirPath(io_mod.getIo(), ".fx");
    {
        var leftover = try tmp.dir.createFile(io_mod.getIo(), ".fx/settings.json", .{});
        defer leftover.close(io_mod.getIo());
        try leftover.writeStreamingAll(io_mod.getIo(), "{\"copied\":true}\n");
    }

    adoptLeftoverRootIfMissing(alloc, home);

    {
        var copied = try tmp.dir.openFile(io_mod.getIo(), ".hx/settings.json", .{});
        defer copied.close(io_mod.getIo());
        const bytes = try io_mod.readFileToEnd(alloc, &copied, 1024);
        defer alloc.free(bytes);
        try std.testing.expectEqualStrings("{\"copied\":true}\n", bytes);
    }

    {
        var leftover = try tmp.dir.createFile(io_mod.getIo(), ".fx/settings.json", .{ .truncate = true });
        defer leftover.close(io_mod.getIo());
        try leftover.writeStreamingAll(io_mod.getIo(), "{\"copied\":false}\n");
    }
    adoptLeftoverRootIfMissing(alloc, home);
    var again = try tmp.dir.openFile(io_mod.getIo(), ".hx/settings.json", .{});
    defer again.close(io_mod.getIo());
    const again_bytes = try io_mod.readFileToEnd(alloc, &again, 1024);
    defer alloc.free(again_bytes);
    try std.testing.expectEqualStrings("{\"copied\":true}\n", again_bytes);
}
