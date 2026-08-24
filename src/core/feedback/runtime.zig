const std = @import("std");

pub const url = "https://github.com/ttaatoo/hx/issues/new";

test "feedback URL opens the hx GitHub issue form" {
    try std.testing.expectEqualStrings("https://github.com/ttaatoo/hx/issues/new", url);
}
