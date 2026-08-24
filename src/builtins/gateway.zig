const std = @import("std");

const api_key_validator_contract = @import("../core/auth/api_key_validator.zig");
const oauth_transport = @import("../core/auth/oauth_transport.zig");
const secret = @import("../core/auth/secret.zig");
const io_mod = @import("../core/shared/io.zig");
const http_client = @import("../gateway/http.zig");
const gateway_provider = @import("../core/gateway/gateway_provider.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");

const Allocator = std.mem.Allocator;
const oauth_request_timeout_ms: i64 = 15_000;
const oauth_response_max_bytes: usize = 64 * 1024;

pub const default_model = @import("../core/config/model_provider.zig").default_model;
pub const retry_count: usize = 3;
pub const models_path = "/v1/models";

pub fn defaultChatUrl() []const u8 {
    return "";
}

pub const api_key_validator = api_key_validator_contract.unavailable_provider;

pub const oauth_transport_provider = oauth_transport.Provider{
    .execute_fn = executeOAuthRequest,
};

fn unavailableCliModelCatalog(
    _: ?*anyopaque,
    _: Allocator,
    input: gateway_provider.CliModelCatalogInput,
) gateway_provider.CliModelCatalogResult {
    return .{ .failure = .{
        .access = .init(input.access),
        .anonymous_fallback_used = false,
        .failure = .{ .category = .runtime },
    } };
}

fn unavailableModelCatalog(
    _: ?*anyopaque,
    _: Allocator,
    _: model_catalog.FetchInput,
) Allocator.Error!model_catalog.ProviderResult {
    return .{ .failure = .{ .category = .runtime } };
}

pub const provider = gateway_provider.Provider{
    .oauth_transport = oauth_transport_provider,
    .cli_model_catalog = .{ .fetch_fn = unavailableCliModelCatalog },
    .model_catalog = .{ .fetch_fn = unavailableModelCatalog },
};

fn executeOAuthRequest(
    _: ?*anyopaque,
    alloc: Allocator,
    request: oauth_transport.Request,
) !oauth_transport.Response {
    var local_cancel = std.atomic.Value(bool).init(false);
    const cancel_flag = request.cancel_flag orelse &local_cancel;
    const deadline = request.deadline orelse std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(oauth_request_timeout_ms),
    });
    var operation = OAuthHttpOperation{
        .alloc = alloc,
        .request = request,
    };
    return http_client.runBoundedHttpOperation(
        oauth_transport.Response,
        alloc,
        cancel_flag,
        deadline,
        &operation,
    );
}

const OAuthHttpOperation = struct {
    alloc: Allocator,
    request: oauth_transport.Request,

    pub fn run(self: *@This()) !oauth_transport.Response {
        var client: std.http.Client = .{
            .allocator = self.alloc,
            .io = io_mod.getIo(),
        };
        defer client.deinit();

        const response_buffer = try self.alloc.alloc(u8, oauth_response_max_bytes + 1);
        defer secret.zeroAndFree(self.alloc, response_buffer);
        var response_writer = std.Io.Writer.fixed(response_buffer);

        const result = client.fetch(.{
            .location = .{ .url = self.request.url },
            .method = switch (self.request.method) {
                .get => .GET,
                .post_form, .post_json => .POST,
            },
            .payload = self.request.payload,
            .headers = .{
                .content_type = switch (self.request.method) {
                    .get => .default,
                    .post_form => .{ .override = "application/x-www-form-urlencoded" },
                    .post_json => .{ .override = "application/json" },
                },
                .user_agent = .{ .override = http_client.user_agent },
                .accept_encoding = .omit,
            },
            .response_writer = &response_writer,
        }) catch |err| switch (err) {
            error.WriteFailed => return error.OAuthResponseTooLarge,
            else => return err,
        };
        const body = response_writer.buffered();
        if (body.len > oauth_response_max_bytes) return error.OAuthResponseTooLarge;

        return .{
            .disposition = if (result.status == .ok) .accepted else .rejected,
            .body = try self.alloc.dupe(u8, body),
        };
    }
};

test "oauth transport user agent uses the product version" {
    try std.testing.expect(std.mem.startsWith(u8, http_client.user_agent, "hx/"));
    try std.testing.expect(http_client.user_agent.len > "hx/".len);
    try std.testing.expect(std.mem.find(u8, http_client.user_agent, "zig") == null);
    try std.testing.expect(std.mem.find(u8, http_client.user_agent, "std.http") == null);
}
