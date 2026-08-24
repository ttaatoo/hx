const std = @import("std");
const devbox_executor = @import("../core/execution/devbox_executor.zig");
const io_mod = @import("../core/shared/io.zig");

/// No sandbox backend talks to a remote host. The composition root still
/// injects this stub so callers keep a provider without an HTTP client.
pub const provider = devbox_executor.unavailable_provider;

test "builtin devbox provider is the unavailable stub" {
    try std.testing.expect(provider.execute_fn == devbox_executor.unavailable_provider.execute_fn);
    const outcome = try provider.execute(
        std.testing.allocator,
        "printf no",
        "/tmp",
        .{ .started_ms = io_mod.milliTimestamp() },
    );
    try std.testing.expect(outcome == .unavailable);
}
