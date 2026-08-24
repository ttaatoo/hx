const std = @import("std");

/// User-visible product name. Internal Zig modules and `FX_*` env stay `fx`.
pub const name = "hx";
pub const leftover_root_dir_name = ".fx";
pub const github_repo = "ttaatoo/hx";
pub const github_url = "https://github.com/ttaatoo/hx";
pub const tap = "ttaatoo/hx";
pub const formula = "ttaatoo/hx/hx";

test "product name is hx" {
    try std.testing.expectEqualStrings("hx", name);
}
