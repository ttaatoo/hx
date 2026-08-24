const std = @import("std");
const secret = @import("../core/auth/secret.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const model_capabilities = @import("../core/config/model_capabilities.zig");
const direct_providers = @import("../core/config/direct_providers.zig");
const gateway_provider = @import("../core/gateway/gateway_provider.zig");
const io_mod = @import("../core/shared/io.zig");
const types = @import("../core/shared/types.zig");
const grok_oauth = @import("../core/auth/grok_oauth.zig");
const gateway_client = @import("http.zig");
const anthropic_messages = @import("anthropic_messages.zig");
const openai_completions = @import("openai_completions.zig");

const Allocator = std.mem.Allocator;
const max_error_body_bytes: usize = 1024 * 1024;
const transfer_buffer_bytes: usize = 256 * 1024;
const connect_timeout_ms: i64 = 30_000;
const anthropic_version = "2023-06-01";

pub const agent_stream_provider = stream_provider.Provider{
    .build_fn = buildRequest,
    .stream_fn = streamCompletion,
};

pub const model_catalog_provider = model_catalog.Provider{
    .fetch_fn = fetchCatalogForProvider,
};

pub const cli_model_catalog_provider = gateway_provider.CliModelCatalogProvider{
    .fetch_fn = fetchCliModelCatalog,
};

fn buildRequest(
    _: ?*anyopaque,
    alloc: Allocator,
    request: stream_provider.BuildRequest,
) ![]u8 {
    var catalog = try direct_providers.loadFromHome(alloc);
    defer catalog.deinit();
    const hit = catalog.findModel(request.model) orelse return error.UnknownDirectProviderModel;
    var adjusted = request;
    adjusted.model = hit.model_id;
    return switch (hit.provider.api) {
        .anthropic_messages => anthropic_messages.buildRequest(alloc, adjusted),
        .openai_completions => openai_completions.buildRequest(alloc, adjusted),
    };
}

fn streamCompletion(
    _: ?*anyopaque,
    alloc: Allocator,
    request: stream_provider.Request,
) !stream_provider.Result {
    return streamCompletionCore(alloc, request) catch |err| {
        if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
        request.attempt_evidence.network_failure = gateway_client.networkFailureEvidence(err, request.delivery.load());
        return err;
    };
}

const OpenedRequest = struct {
    request: ?std.http.Client.Request,

    pub fn deinit(self: *OpenedRequest, _: Allocator) void {
        if (self.request) |*value| value.deinit();
        self.request = null;
    }

    pub fn take(self: *OpenedRequest) std.http.Client.Request {
        const value = self.request.?;
        self.request = null;
        return value;
    }
};

const OpenRequestOperation = struct {
    client: *std.http.Client,
    uri: std.Uri,
    extra_headers: []const std.http.Header,
    authorization: ?[]const u8,
    user_agent: []const u8,

    pub fn run(self: *@This()) !OpenedRequest {
        return .{ .request = try self.client.request(.POST, self.uri, .{
            .headers = .{
                .content_type = .{ .override = "application/json" },
                .authorization = if (self.authorization) |value|
                    .{ .override = value }
                else
                    .omit,
                .accept_encoding = .omit,
                .user_agent = .{ .override = self.user_agent },
            },
            .extra_headers = self.extra_headers,
            .keep_alive = false,
            .redirect_behavior = .unhandled,
        }) };
    }
};

fn streamCompletionCore(alloc: Allocator, request: stream_provider.Request) !stream_provider.Result {
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;
    var catalog = try direct_providers.loadFromHome(alloc);
    defer catalog.deinit();
    const hit = catalog.findModel(request.model) orelse return error.UnknownDirectProviderModel;
    const use_grok_subscription = hit.provider.provider == .xai;
    const api_key = if (use_grok_subscription)
        (if (request.credential_source == .grok_subscription and request.api_key.len > 0)
            request.api_key
        else
            return error.DirectProviderKeyMissing)
    else
        hit.provider.resolvedApiKey() orelse
            (if (request.credential_source == .custom_provider and request.api_key.len > 0)
                request.api_key
            else
                return error.DirectProviderKeyMissing);
    const base_url = hit.provider.resolvedBaseUrl();
    if (!direct_providers.isAllowedBaseUrl(base_url)) return error.DirectProviderUrlNotAllowed;
    const request_url = try direct_providers.joinEndpoint(alloc, base_url, hit.provider.api.chatPath());
    defer alloc.free(request_url);
    const uri = try std.Uri.parse(request_url);

    var extra_headers_buf: [10]std.http.Header = undefined;
    var extra_count: usize = 0;
    extra_headers_buf[extra_count] = .{ .name = "accept", .value = "text/event-stream" };
    extra_count += 1;

    var auth_header: ?[]u8 = null;
    defer if (auth_header) |header| secret.zeroAndFree(alloc, header);
    var anthropic_key: ?[]u8 = null;
    defer if (anthropic_key) |header| secret.zeroAndFree(alloc, header);
    var grok_user_agent: ?[]u8 = null;
    defer if (grok_user_agent) |header| alloc.free(header);

    switch (hit.provider.api) {
        .openai_completions => {
            auth_header = try std.fmt.allocPrint(alloc, "Bearer {s}", .{api_key});
            if (use_grok_subscription) {
                extra_headers_buf[extra_count] = .{ .name = "X-XAI-Token-Auth", .value = grok_oauth.token_auth_header };
                extra_count += 1;
                extra_headers_buf[extra_count] = .{ .name = "x-grok-client-identifier", .value = grok_oauth.client_identifier };
                extra_count += 1;
                extra_headers_buf[extra_count] = .{ .name = "x-grok-client-version", .value = grok_oauth.clientVersion() };
                extra_count += 1;
                extra_headers_buf[extra_count] = .{ .name = "x-grok-model-override", .value = hit.model_id };
                extra_count += 1;
                grok_user_agent = try grok_oauth.chatProxyUserAgent(alloc);
            }
        },
        .anthropic_messages => {
            anthropic_key = try alloc.dupe(u8, api_key);
            extra_headers_buf[extra_count] = .{ .name = "x-api-key", .value = anthropic_key.? };
            extra_count += 1;
            extra_headers_buf[extra_count] = .{ .name = "anthropic-version", .value = anthropic_version };
            extra_count += 1;
        },
    }

    var client: std.http.Client = .{ .allocator = alloc, .io = io_mod.getIo() };
    defer client.deinit();
    var open_operation = OpenRequestOperation{
        .client = &client,
        .uri = uri,
        .extra_headers = extra_headers_buf[0..extra_count],
        .authorization = auth_header,
        .user_agent = grok_user_agent orelse gateway_client.user_agent,
    };
    const connect_deadline = std.Io.Clock.Timestamp.fromNow(io_mod.getIo(), .{
        .clock = .awake,
        .raw = .fromMilliseconds(connect_timeout_ms),
    });
    var opened = try gateway_client.runBoundedHttpOperation(
        OpenedRequest,
        alloc,
        request.cancel_flag,
        connect_deadline,
        &open_operation,
    );
    var http_request = opened.take();
    defer http_request.deinit();
    var cancel_watch_done = std.atomic.Value(bool).init(false);
    const cancel_watcher = if (http_request.connection) |connection|
        try gateway_client.spawnHttpCancelWatcher(
            &cancel_watch_done,
            request.cancel_flag,
            connection.stream_writer.stream,
        )
    else
        null;
    defer {
        cancel_watch_done.store(true, .seq_cst);
        if (cancel_watcher) |thread| thread.join();
    }
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    http_request.transfer_encoding = .{ .content_length = request.payload.len };
    var send_buffer: [8192]u8 = undefined;
    request.delivery.markPossiblySent();
    var body_writer = try http_request.sendBodyUnflushed(&send_buffer);
    try body_writer.writer.writeAll(request.payload);
    try body_writer.end();
    if (http_request.connection) |connection| try connection.flush();
    if (request.cancel_flag.load(.seq_cst)) return error.Cancelled;

    var response = try http_request.receiveHead(&.{});
    if (response.head.status != .ok) {
        var transfer: [16 * 1024]u8 = undefined;
        const reader = response.reader(&transfer);
        const body = reader.allocRemaining(alloc, .limited(max_error_body_bytes)) catch |err| switch (err) {
            error.StreamTooLong => try alloc.dupe(u8, "Direct provider error response exceeded the local limit"),
            else => return err,
        };
        return .{
            .status = response.head.status,
            .err_body = body,
            .ownership = .owned,
        };
    }

    var transfer_buffer: [transfer_buffer_bytes]u8 = undefined;
    const reader = response.reader(&transfer_buffer);
    const completion = switch (hit.provider.api) {
        .anthropic_messages => try anthropic_messages.consumeSse(
            alloc,
            reader,
            request.callback_ctx,
            request.on_content_chunk,
            request.on_tool_start,
            request.on_reasoning_chunk,
            request.on_tool_input_chunk,
            request.cancel_flag,
            request.content_capture_limit,
        ),
        .openai_completions => try openai_completions.consumeSse(
            alloc,
            reader,
            request.callback_ctx,
            request.on_content_chunk,
            request.on_tool_start,
            request.on_reasoning_chunk,
            request.on_tool_input_chunk,
            request.cancel_flag,
            request.content_capture_limit,
        ),
    };
    return .{
        .status = .ok,
        .completion = completion,
        .generation_origin = base_url,
        .reconcile_generation_usage = false,
        .ownership = .owned,
    };
}

fn fetchCliModelCatalog(
    _: ?*anyopaque,
    alloc: Allocator,
    input: gateway_provider.CliModelCatalogInput,
) gateway_provider.CliModelCatalogResult {
    return switch (model_catalog.fetchWithPublicFallback(model_catalog_provider, alloc, .{
        .access = input.access,
        .endpoint = input.endpoint,
        .cancel_flag = input.cancel_flag,
        .view = .full,
    })) {
        .loaded => |loaded| blk: {
            var catalog = loaded.catalog;
            defer model_catalog.freeModelCatalog(alloc, &catalog);
            const ids = model_catalog.projectModelIds(alloc, catalog.items) catch return .{ .failure = .{
                .access = loaded.provenance.access,
                .anonymous_fallback_used = false,
                .failure = .{ .category = .resource_exhausted },
            } };
            break :blk .{ .loaded = .{
                .ids = ids,
                .provenance = loaded.provenance,
            } };
        },
        .failed => |failure| .{ .failure = failure },
    };
}

fn fetchCatalogForProvider(
    _: ?*anyopaque,
    alloc: Allocator,
    input: model_catalog.FetchInput,
) std.mem.Allocator.Error!model_catalog.ProviderResult {
    _ = input;
    var loaded = direct_providers.loadFromHome(alloc) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return .{ .failure = .{ .category = .runtime } },
    };
    defer loaded.deinit();
    var catalog: std.ArrayList(model_catalog.ModelCatalogEntry) = .empty;
    errdefer model_catalog.freeModelCatalog(alloc, &catalog);
    for (loaded.entries) |entry| {
        for (entry.models) |model| {
            try catalog.append(alloc, try catalogEntryForModel(alloc, model.id));
        }
    }
    return .{ .catalog = catalog };
}

fn catalogEntryForModel(
    alloc: Allocator,
    model_id: []const u8,
) !model_catalog.ModelCatalogEntry {
    const capabilities = model_capabilities.capabilitiesForModel(model_id);
    var reasoning_efforts: std.ArrayList(types.ReasoningEffort) = .empty;
    errdefer reasoning_efforts.deinit(alloc);
    if (capabilities.reasoning_efforts.len > 0) {
        try reasoning_efforts.appendSlice(alloc, capabilities.reasoning_efforts.slice());
    } else {
        try reasoning_efforts.appendSlice(alloc, &.{
            types.ReasoningEffort.literal("low"),
            types.ReasoningEffort.literal("medium"),
            types.ReasoningEffort.literal("high"),
        });
    }
    return .{
        .id = try alloc.dupe(u8, model_id),
        .model_type = try alloc.dupe(u8, "language"),
        .has_tool_use = true,
        .has_reasoning = true,
        .reasoning_efforts = reasoning_efforts,
        .supports_fast_mode = false,
        .has_vision = capabilities.supports_vision,
        .has_file_input = false,
        .has_web_search = false,
        .context_window = capabilities.context_window orelse 0,
        .max_tokens = capabilities.max_output_tokens orelse 0,
    };
}

test "direct catalog lists configured models without a gateway credential" {
    const alloc = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io_mod.getIo(), "home/.hx");
    var providers_file = try tmp.dir.createFile(io_mod.getIo(), "home/.hx/providers.json", .{});
    try providers_file.writeStreamingAll(io_mod.getIo(),
        \\{"providers":{"anthropic":{"api":"anthropic-messages","models":[{"id":"claude-opus-4-6"}]},"xai":{"api":"openai-completions","models":[{"id":"grok-4.6"}]}}}
    );
    providers_file.close(io_mod.getIo());
    const home = try io_mod.dirRealpathAlloc(alloc, tmp.dir, "home");
    defer alloc.free(home);

    var environ = std.process.Environ.Map.init(alloc);
    defer environ.deinit();
    try environ.put("HOME", home);
    io_mod.setEnvironMap(&environ);
    const restore_env = try stableEmptyTestEnviron();
    defer io_mod.setEnvironMap(restore_env);

    const fetched = try model_catalog_provider.fetch(alloc, .{
        .access = .{ .public_only = .no_credential },
        .endpoint = "/unused",
    });
    var catalog = switch (fetched) {
        .catalog => |value| value,
        .failure => return error.TestExpectedCatalog,
    };
    defer model_catalog.freeModelCatalog(alloc, &catalog);
    try std.testing.expectEqual(@as(usize, 2), catalog.items.len);
    try std.testing.expectEqualStrings("claude-opus-4-6", catalog.items[0].id);
    try std.testing.expectEqualStrings("grok-4.6", catalog.items[1].id);
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
