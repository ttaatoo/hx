const std = @import("std");
const stream_provider = @import("../core/agent/stream_provider.zig");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;

pub fn buildRequest(
    alloc: Allocator,
    request: stream_provider.BuildRequest,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    const writer = &out.writer;

    try writer.writeAll("{\"model\":");
    try std.json.Stringify.value(request.model, .{}, writer);
    try writer.writeAll(",\"stream\":true,\"messages\":[");
    try writeMessages(writer, request.messages);
    try writer.writeByte(']');
    _ = try writeTools(writer, alloc, request.serialized_tools, request.selected_dynamic_tool_schemas);
    if (request.max_output_tokens) |max_tokens| {
        try writer.print(",\"max_tokens\":{d}", .{max_tokens});
    }
    if (request.provider_options.reasoning) |effort| {
        if (effort.providerValue()) |label| {
            const mapped = if (std.mem.eql(u8, label, "minimal")) "low" else label;
            try writer.writeAll(",\"reasoning_effort\":");
            try std.json.Stringify.value(mapped, .{}, writer);
        }
    }
    try writer.writeByte('}');
    return out.toOwnedSlice();
}

fn writeMessages(writer: *std.Io.Writer, messages: []const types.ChatMessage) !void {
    var first = true;
    for (messages) |message| {
        switch (message.role) {
            .system => {
                const content = message.content orelse continue;
                if (content.len == 0) continue;
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"system\",\"content\":");
                try std.json.Stringify.value(content, .{}, writer);
                try writer.writeByte('}');
            },
            .user => {
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"user\",\"content\":");
                try std.json.Stringify.value(message.content orelse "", .{}, writer);
                try writer.writeByte('}');
            },
            .assistant => {
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"assistant\",\"content\":");
                try std.json.Stringify.value(message.content orelse "", .{}, writer);
                if (message.tool_calls.len > 0) {
                    try writer.writeAll(",\"tool_calls\":[");
                    for (message.tool_calls, 0..) |call, index| {
                        if (index > 0) try writer.writeByte(',');
                        try writer.writeAll("{\"id\":");
                        try std.json.Stringify.value(call.id, .{}, writer);
                        try writer.writeAll(",\"type\":\"function\",\"function\":{\"name\":");
                        try std.json.Stringify.value(call.name, .{}, writer);
                        try writer.writeAll(",\"arguments\":");
                        try std.json.Stringify.value(call.arguments_json, .{}, writer);
                        try writer.writeAll("}}");
                    }
                    try writer.writeByte(']');
                }
                try writer.writeByte('}');
            },
            .tool => {
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"tool\",\"tool_call_id\":");
                try std.json.Stringify.value(message.tool_call_id orelse "", .{}, writer);
                try writer.writeAll(",\"content\":");
                try std.json.Stringify.value(message.content orelse "", .{}, writer);
                try writer.writeByte('}');
            },
        }
    }
}

fn writeTools(
    writer: *std.Io.Writer,
    alloc: Allocator,
    serialized_tools: []const u8,
    selected_dynamic_schemas: []const []const u8,
) !usize {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, serialized_tools, .{}) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return 0,
    };
    defer parsed.deinit();
    if (parsed.value != .array) return 0;

    var count: usize = 0;
    var tools_out: std.Io.Writer.Allocating = .init(alloc);
    defer tools_out.deinit();
    try tools_out.writer.writeAll(",\"tools\":[");
    for (parsed.value.array.items) |tool| {
        if (try writeTool(&tools_out.writer, tool, count != 0)) count += 1;
    }
    for (selected_dynamic_schemas) |schema_json| {
        var selected = std.json.parseFromSlice(std.json.Value, alloc, schema_json, .{}) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            else => continue,
        };
        defer selected.deinit();
        if (try writeTool(&tools_out.writer, selected.value, count != 0)) count += 1;
    }
    try tools_out.writer.writeByte(']');
    if (count > 0) try writer.writeAll(tools_out.written());
    return count;
}

fn writeTool(writer: *std.Io.Writer, value: std.json.Value, comma: bool) !bool {
    if (value != .object) return false;
    const name = value.object.get("name") orelse return false;
    if (name != .string or name.string.len == 0) return false;
    const schema = value.object.get("inputSchema") orelse value.object.get("parameters") orelse return false;
    if (schema != .object) return false;
    if (comma) try writer.writeByte(',');
    try writer.writeAll("{\"type\":\"function\",\"function\":{\"name\":");
    try std.json.Stringify.value(name.string, .{}, writer);
    if (value.object.get("description")) |description| if (description == .string) {
        try writer.writeAll(",\"description\":");
        try std.json.Stringify.value(description.string, .{}, writer);
    };
    try writer.writeAll(",\"parameters\":");
    try std.json.Stringify.value(schema, .{}, writer);
    try writer.writeAll("}}");
    return true;
}

fn writeComma(writer: *std.Io.Writer, first: *bool) !void {
    if (!first.*) try writer.writeByte(',');
    first.* = false;
}

const ToolAccumulator = struct {
    index: i64,
    id: []u8,
    name: []u8,
    arguments: std.ArrayList(u8) = .empty,

    fn deinit(self: *ToolAccumulator, alloc: Allocator) void {
        alloc.free(self.id);
        alloc.free(self.name);
        self.arguments.deinit(alloc);
        self.* = undefined;
    }
};

pub fn consumeSse(
    alloc: Allocator,
    reader: anytype,
    callback_ctx: *anyopaque,
    on_content_chunk: stream_provider.StreamCallback,
    on_tool_start: ?stream_provider.ToolStartCallback,
    on_reasoning_chunk: ?stream_provider.StreamCallback,
    on_tool_input_chunk: ?stream_provider.StreamCallback,
    cancel_flag: *std.atomic.Value(bool),
    content_capture_limit: ?usize,
) !types.ProviderCompletion {
    var content: std.ArrayList(u8) = .empty;
    errdefer content.deinit(alloc);
    var tools: std.ArrayList(ToolAccumulator) = .empty;
    defer {
        for (tools.items) |*tool| tool.deinit(alloc);
        tools.deinit(alloc);
    }
    var pending_line: std.ArrayList(u8) = .empty;
    defer pending_line.deinit(alloc);
    var input_tokens: ?u64 = null;
    var output_tokens: ?u64 = null;
    var finish_reason: ?types.ProviderFinishReason = null;

    while (true) {
        if (cancel_flag.load(.seq_cst)) return error.Cancelled;
        const line = try readSseLine(alloc, reader, &pending_line) orelse break;
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0 or trimmed[0] == ':') {
            pending_line.clearRetainingCapacity();
            continue;
        }
        if (!std.mem.startsWith(u8, trimmed, "data:")) {
            pending_line.clearRetainingCapacity();
            continue;
        }
        const data = std.mem.trim(u8, trimmed["data:".len..], " \t");
        if (data.len == 0) {
            pending_line.clearRetainingCapacity();
            continue;
        }
        if (std.mem.eql(u8, data, "[DONE]")) break;

        var parsed = std.json.parseFromSlice(std.json.Value, alloc, data, .{}) catch {
            pending_line.clearRetainingCapacity();
            continue;
        };
        defer parsed.deinit();
        if (parsed.value != .object) {
            pending_line.clearRetainingCapacity();
            continue;
        }
        if (parsed.value.object.get("usage")) |usage| if (usage == .object) {
            input_tokens = jsonU64(usage.object.get("prompt_tokens")) orelse input_tokens;
            output_tokens = jsonU64(usage.object.get("completion_tokens")) orelse output_tokens;
        };
        const choices = parsed.value.object.get("choices") orelse {
            pending_line.clearRetainingCapacity();
            continue;
        };
        if (choices != .array or choices.array.items.len == 0) {
            pending_line.clearRetainingCapacity();
            continue;
        }
        const choice = choices.array.items[0];
        if (choice != .object) {
            pending_line.clearRetainingCapacity();
            continue;
        }
        if (choice.object.get("finish_reason")) |reason| if (reason == .string) {
            finish_reason = finishReasonFromOpenAi(reason.string);
        };
        if (choice.object.get("delta")) |delta| if (delta == .object) {
            try applyDelta(
                alloc,
                delta.object,
                &content,
                &tools,
                callback_ctx,
                on_content_chunk,
                on_tool_start,
                on_reasoning_chunk,
                on_tool_input_chunk,
                content_capture_limit,
            );
        };
        pending_line.clearRetainingCapacity();
    }

    const tool_calls = try finishTools(alloc, &tools);
    return .{
        .content = if (content.items.len > 0) try content.toOwnedSlice(alloc) else null,
        .tool_calls = tool_calls,
        .finish_reason = finish_reason orelse if (tool_calls.len > 0) .tool_calls else .stop,
        .usage = .{
            .input_tokens = input_tokens,
            .output_tokens = output_tokens,
        },
    };
}

fn applyDelta(
    alloc: Allocator,
    delta: std.json.ObjectMap,
    content: *std.ArrayList(u8),
    tools: *std.ArrayList(ToolAccumulator),
    callback_ctx: *anyopaque,
    on_content_chunk: stream_provider.StreamCallback,
    on_tool_start: ?stream_provider.ToolStartCallback,
    on_reasoning_chunk: ?stream_provider.StreamCallback,
    on_tool_input_chunk: ?stream_provider.StreamCallback,
    content_capture_limit: ?usize,
) !void {
    if (delta.get("content")) |text| if (text == .string and text.string.len > 0) {
        if (content_capture_limit == null or content.items.len + text.string.len <= content_capture_limit.?) {
            try content.appendSlice(alloc, text.string);
        }
        on_content_chunk(callback_ctx, text.string);
    };
    if (delta.get("reasoning_content") orelse delta.get("reasoning")) |reasoning| {
        if (reasoning == .string and reasoning.string.len > 0) {
            if (on_reasoning_chunk) |callback| callback(callback_ctx, reasoning.string);
        }
    }
    const tool_calls = delta.get("tool_calls") orelse return;
    if (tool_calls != .array) return;
    for (tool_calls.array.items) |item| {
        if (item != .object) continue;
        const index = jsonI64(item.object.get("index")) orelse 0;
        var tool = findTool(tools, index);
        if (tool == null) {
            const id = if (item.object.get("id")) |value| (if (value == .string) value.string else "") else "";
            const name = if (item.object.get("function")) |function|
                if (function == .object)
                    if (function.object.get("name")) |value| (if (value == .string) value.string else "") else ""
                else
                    ""
            else
                "";
            try tools.append(alloc, .{
                .index = index,
                .id = try alloc.dupe(u8, id),
                .name = try alloc.dupe(u8, name),
            });
            tool = &tools.items[tools.items.len - 1];
            if (on_tool_start) |callback| if (id.len > 0) callback(callback_ctx, id, name, null);
        }
        const selected = tool.?;
        if (item.object.get("id")) |value| if (value == .string and value.string.len > 0 and selected.id.len == 0) {
            alloc.free(selected.id);
            selected.id = try alloc.dupe(u8, value.string);
        };
        if (item.object.get("function")) |function| if (function == .object) {
            if (function.object.get("name")) |value| if (value == .string and value.string.len > 0 and selected.name.len == 0) {
                alloc.free(selected.name);
                selected.name = try alloc.dupe(u8, value.string);
                if (on_tool_start) |callback| callback(callback_ctx, selected.id, selected.name, null);
            };
            if (function.object.get("arguments")) |value| if (value == .string) {
                try selected.arguments.appendSlice(alloc, value.string);
                if (on_tool_input_chunk) |callback| callback(callback_ctx, value.string);
            };
        };
    }
}

fn findTool(tools: *std.ArrayList(ToolAccumulator), index: i64) ?*ToolAccumulator {
    for (tools.items) |*tool| {
        if (tool.index == index) return tool;
    }
    return null;
}

fn finishTools(alloc: Allocator, tools: *std.ArrayList(ToolAccumulator)) ![]types.ToolCall {
    if (tools.items.len == 0) return &.{};
    const calls = try alloc.alloc(types.ToolCall, tools.items.len);
    for (tools.items, 0..) |*tool, index| {
        calls[index] = .{
            .id = tool.id,
            .name = tool.name,
            .arguments_json = try tool.arguments.toOwnedSlice(alloc),
        };
        tool.id = &.{};
        tool.name = &.{};
        tool.deinit(alloc);
    }
    tools.clearRetainingCapacity();
    return calls;
}

fn finishReasonFromOpenAi(reason: []const u8) types.ProviderFinishReason {
    if (std.mem.eql(u8, reason, "tool_calls")) return .tool_calls;
    if (std.mem.eql(u8, reason, "length")) return .length;
    if (std.mem.eql(u8, reason, "content_filter")) return .content_filter;
    return .stop;
}

fn jsonU64(value: ?std.json.Value) ?u64 {
    const raw = value orelse return null;
    return switch (raw) {
        .integer => |n| if (n >= 0) @intCast(n) else null,
        .float => |n| if (n >= 0) @intFromFloat(n) else null,
        else => null,
    };
}

fn jsonI64(value: ?std.json.Value) ?i64 {
    const raw = value orelse return null;
    return switch (raw) {
        .integer => |n| n,
        else => null,
    };
}

fn readSseLine(alloc: Allocator, reader: anytype, pending: *std.ArrayList(u8)) !?[]const u8 {
    while (true) {
        const fragment = reader.takeDelimiter('\n') catch |err| switch (err) {
            error.StreamTooLong => {
                const buffered = reader.buffered();
                if (buffered.len == 0) return error.ReadFailed;
                try pending.appendSlice(alloc, buffered);
                reader.tossBuffered();
                continue;
            },
            error.ReadFailed => return error.ReadFailed,
        } orelse {
            if (pending.items.len > 0) return pending.items;
            return null;
        };
        if (pending.items.len == 0) return fragment;
        try pending.appendSlice(alloc, fragment);
        return pending.items;
    }
}

test "openai completions request encodes tools and reasoning effort" {
    const alloc = std.testing.allocator;
    const tools_json =
        \\[{"type":"function","name":"read_file","description":"Read","inputSchema":{"type":"object"}}]
    ;
    const messages = [_]types.ChatMessage{
        .{ .role = .user, .content = "hi" },
        .{
            .role = .assistant,
            .tool_calls = &.{.{
                .id = "call_1",
                .name = "read_file",
                .arguments_json = "{\"path\":\"a.txt\"}",
            }},
        },
        .{ .role = .tool, .tool_call_id = "call_1", .content = "ok" },
    };
    const body = try buildRequest(alloc, .{
        .model = "grok-4.6",
        .serialized_tools = tools_json,
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{ .reasoning = types.ReasoningEffort.literal("high") },
    });
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "\"model\":\"grok-4.6\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"reasoning_effort\":\"high\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"role\":\"tool\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"type\":\"function\"") != null);
}

test "openai completions SSE parser reconstructs text and tool calls" {
    const alloc = std.testing.allocator;
    const Capture = struct {
        chunks: std.ArrayList(u8) = .empty,
        fn append(raw: *anyopaque, chunk: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(raw));
            self.chunks.appendSlice(std.testing.allocator, chunk) catch {};
        }
    };
    var capture = Capture{};
    defer capture.chunks.deinit(alloc);
    var cancelled = std.atomic.Value(bool).init(false);
    const payload =
        \\data: {"choices":[{"delta":{"content":"Hi"}}]}
        \\
        \\data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"p"}}]}}]}
        \\
        \\data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\":\"a\"}"}}]},"finish_reason":"tool_calls"}]}
        \\
        \\data: [DONE]
        \\
    ;
    var reader = std.Io.Reader.fixed(payload);
    const completion = try consumeSse(
        alloc,
        &reader,
        @ptrCast(&capture),
        Capture.append,
        null,
        null,
        null,
        &cancelled,
        null,
    );
    defer {
        if (completion.content) |content| alloc.free(content);
        types.freeToolCallSlice(alloc, @constCast(completion.tool_calls));
    }
    try std.testing.expectEqualStrings("Hi", completion.content.?);
    try std.testing.expectEqual(@as(usize, 1), completion.tool_calls.len);
    try std.testing.expectEqualStrings("call_1", completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{\"path\":\"a\"}", completion.tool_calls[0].arguments_json);
    try std.testing.expectEqual(types.ProviderFinishReason.tool_calls, completion.finish_reason.?);
}
