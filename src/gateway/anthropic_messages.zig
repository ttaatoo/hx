const std = @import("std");
const stream_provider = @import("../core/agent/stream_provider.zig");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;
const default_max_tokens: u32 = 16_384;
const thinking_budget_tokens: u32 = 8_192;

pub fn buildRequest(
    alloc: Allocator,
    request: stream_provider.BuildRequest,
) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    errdefer out.deinit();
    const writer = &out.writer;

    try writer.writeAll("{\"model\":");
    try std.json.Stringify.value(request.model, .{}, writer);
    const max_tokens = request.max_output_tokens orelse default_max_tokens;
    const thinking = request.provider_options.reasoning != null and
        request.provider_options.reasoning.?.providerValue() != null;
    const effective_max = if (thinking) @max(max_tokens, thinking_budget_tokens + 4_096) else max_tokens;
    try writer.print(",\"max_tokens\":{d},\"stream\":true", .{effective_max});

    if (systemPrompt(request.messages)) |system| {
        try writer.writeAll(",\"system\":");
        try std.json.Stringify.value(system, .{}, writer);
    }

    try writer.writeAll(",\"messages\":[");
    try writeMessages(writer, alloc, request.messages);
    try writer.writeByte(']');

    _ = try writeTools(writer, alloc, request.serialized_tools, request.selected_dynamic_tool_schemas);

    if (thinking) {
        try writer.print(
            ",\"thinking\":{{\"type\":\"enabled\",\"budget_tokens\":{d}}}",
            .{thinking_budget_tokens},
        );
    }
    try writer.writeByte('}');
    return out.toOwnedSlice();
}

fn systemPrompt(messages: []const types.ChatMessage) ?[]const u8 {
    for (messages) |message| {
        if (message.role == .system) {
            if (message.content) |content| if (content.len > 0) return content;
        }
    }
    return null;
}

fn writeMessages(
    writer: *std.Io.Writer,
    alloc: Allocator,
    messages: []const types.ChatMessage,
) !void {
    var first = true;
    var index: usize = 0;
    while (index < messages.len) {
        const message = messages[index];
        switch (message.role) {
            .system => {
                index += 1;
            },
            .user => {
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"user\",\"content\":");
                try std.json.Stringify.value(message.content orelse "", .{}, writer);
                try writer.writeByte('}');
                index += 1;
            },
            .assistant => {
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"assistant\",\"content\":[");
                var part_first = true;
                if (message.content) |content| if (content.len > 0) {
                    try writer.writeAll("{\"type\":\"text\",\"text\":");
                    try std.json.Stringify.value(content, .{}, writer);
                    try writer.writeByte('}');
                    part_first = false;
                };
                for (message.tool_calls) |call| {
                    if (!part_first) try writer.writeByte(',');
                    try writer.writeAll("{\"type\":\"tool_use\",\"id\":");
                    try std.json.Stringify.value(call.id, .{}, writer);
                    try writer.writeAll(",\"name\":");
                    try std.json.Stringify.value(call.name, .{}, writer);
                    try writer.writeAll(",\"input\":");
                    try writeToolInput(writer, alloc, call.arguments_json);
                    try writer.writeByte('}');
                    part_first = false;
                }
                try writer.writeAll("]}");
                index += 1;
            },
            .tool => {
                try writeComma(writer, &first);
                try writer.writeAll("{\"role\":\"user\",\"content\":[");
                var part_first = true;
                while (index < messages.len and messages[index].role == .tool) : (index += 1) {
                    if (!part_first) try writer.writeByte(',');
                    try writer.writeAll("{\"type\":\"tool_result\",\"tool_use_id\":");
                    try std.json.Stringify.value(messages[index].tool_call_id orelse "", .{}, writer);
                    try writer.writeAll(",\"content\":");
                    try std.json.Stringify.value(messages[index].content orelse "", .{}, writer);
                    try writer.writeByte('}');
                    part_first = false;
                }
                try writer.writeAll("]}");
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
    const schema = value.object.get("inputSchema") orelse value.object.get("input_schema") orelse
        value.object.get("parameters") orelse return false;
    if (schema != .object) return false;
    if (comma) try writer.writeByte(',');
    try writer.writeAll("{\"name\":");
    try std.json.Stringify.value(name.string, .{}, writer);
    if (value.object.get("description")) |description| if (description == .string) {
        try writer.writeAll(",\"description\":");
        try std.json.Stringify.value(description.string, .{}, writer);
    };
    try writer.writeAll(",\"input_schema\":");
    try std.json.Stringify.value(schema, .{}, writer);
    try writer.writeByte('}');
    return true;
}

fn writeToolInput(writer: *std.Io.Writer, alloc: Allocator, arguments_json: []const u8) !void {
    if (arguments_json.len == 0) {
        try writer.writeAll("{}");
        return;
    }
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, arguments_json, .{}) catch {
        try writer.writeAll("{}");
        return;
    };
    defer parsed.deinit();
    try std.json.Stringify.value(parsed.value, .{}, writer);
}

fn writeComma(writer: *std.Io.Writer, first: *bool) !void {
    if (!first.*) try writer.writeByte(',');
    first.* = false;
}

const ToolAccumulator = struct {
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
    var current_tool: ?*ToolAccumulator = null;
    var current_block: enum { none, text, thinking, tool } = .none;
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
        if (data.len == 0 or std.mem.eql(u8, data, "[DONE]")) {
            pending_line.clearRetainingCapacity();
            if (std.mem.eql(u8, data, "[DONE]")) break;
            continue;
        }
        var parsed = std.json.parseFromSlice(std.json.Value, alloc, data, .{}) catch {
            pending_line.clearRetainingCapacity();
            continue;
        };
        defer parsed.deinit();
        if (parsed.value != .object) {
            pending_line.clearRetainingCapacity();
            continue;
        }
        const event_type = if (parsed.value.object.get("type")) |value|
            if (value == .string) value.string else ""
        else
            "";

        if (std.mem.eql(u8, event_type, "content_block_start")) {
            current_tool = null;
            current_block = .none;
            const block = parsed.value.object.get("content_block") orelse {
                pending_line.clearRetainingCapacity();
                continue;
            };
            if (block != .object) {
                pending_line.clearRetainingCapacity();
                continue;
            }
            const block_type = if (block.object.get("type")) |value|
                if (value == .string) value.string else ""
            else
                "";
            if (std.mem.eql(u8, block_type, "text")) {
                current_block = .text;
            } else if (std.mem.eql(u8, block_type, "thinking")) {
                current_block = .thinking;
            } else if (std.mem.eql(u8, block_type, "tool_use")) {
                const id = if (block.object.get("id")) |value| (if (value == .string) value.string else "") else "";
                const name = if (block.object.get("name")) |value| (if (value == .string) value.string else "") else "";
                try tools.append(alloc, .{
                    .id = try alloc.dupe(u8, id),
                    .name = try alloc.dupe(u8, name),
                });
                current_tool = &tools.items[tools.items.len - 1];
                current_block = .tool;
                if (on_tool_start) |callback| callback(callback_ctx, id, name, null);
            }
        } else if (std.mem.eql(u8, event_type, "content_block_delta")) {
            const delta = parsed.value.object.get("delta") orelse {
                pending_line.clearRetainingCapacity();
                continue;
            };
            if (delta != .object) {
                pending_line.clearRetainingCapacity();
                continue;
            }
            if (delta.object.get("text")) |text| if (text == .string and text.string.len > 0) {
                if (current_block == .thinking) {
                    if (on_reasoning_chunk) |callback| callback(callback_ctx, text.string);
                } else {
                    if (shouldCapture(content.items.len, content_capture_limit, text.string.len)) {
                        try content.appendSlice(alloc, text.string);
                    }
                    on_content_chunk(callback_ctx, text.string);
                }
            };
            if (delta.object.get("thinking")) |thinking| if (thinking == .string and thinking.string.len > 0) {
                if (on_reasoning_chunk) |callback| callback(callback_ctx, thinking.string);
            };
            if (delta.object.get("partial_json")) |partial| if (partial == .string) {
                if (current_tool) |tool| {
                    try tool.arguments.appendSlice(alloc, partial.string);
                    if (on_tool_input_chunk) |callback| callback(callback_ctx, partial.string);
                }
            };
        } else if (std.mem.eql(u8, event_type, "message_delta")) {
            if (parsed.value.object.get("delta")) |delta| if (delta == .object) {
                if (delta.object.get("stop_reason")) |reason| if (reason == .string) {
                    finish_reason = finishReasonFromAnthropic(reason.string);
                };
            };
            if (parsed.value.object.get("usage")) |usage| if (usage == .object) {
                output_tokens = jsonU64(usage.object.get("output_tokens")) orelse output_tokens;
            };
        } else if (std.mem.eql(u8, event_type, "message_start")) {
            if (parsed.value.object.get("message")) |message| if (message == .object) {
                if (message.object.get("usage")) |usage| if (usage == .object) {
                    input_tokens = jsonU64(usage.object.get("input_tokens")) orelse input_tokens;
                };
            };
        }
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

fn finishReasonFromAnthropic(reason: []const u8) types.ProviderFinishReason {
    if (std.mem.eql(u8, reason, "tool_use")) return .tool_calls;
    if (std.mem.eql(u8, reason, "max_tokens")) return .length;
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

fn shouldCapture(current_len: usize, limit: ?usize, incoming: usize) bool {
    const max_bytes = limit orelse return true;
    return current_len + incoming <= max_bytes;
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

test "anthropic request encodes tools thinking and tool results" {
    const alloc = std.testing.allocator;
    const tools_json =
        \\[{"type":"function","name":"read_file","description":"Read","inputSchema":{"type":"object","properties":{"path":{"type":"string"}}}}]
    ;
    const messages = [_]types.ChatMessage{
        .{ .role = .system, .content = "You are helpful." },
        .{ .role = .user, .content = "Read it" },
        .{
            .role = .assistant,
            .content = "",
            .tool_calls = &.{.{
                .id = "toolu_1",
                .name = "read_file",
                .arguments_json = "{\"path\":\"a.txt\"}",
            }},
        },
        .{ .role = .tool, .tool_call_id = "toolu_1", .content = "hi" },
    };
    const body = try buildRequest(alloc, .{
        .model = "claude-opus-4-6",
        .serialized_tools = tools_json,
        .messages = &messages,
        .tool_choice = .auto,
        .provider_options = .{ .reasoning = types.ReasoningEffort.literal("high") },
    });
    defer alloc.free(body);
    try std.testing.expect(std.mem.find(u8, body, "\"model\":\"claude-opus-4-6\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"system\":\"You are helpful.\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"type\":\"tool_use\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"type\":\"tool_result\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"input_schema\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"thinking\"") != null);
    try std.testing.expect(std.mem.find(u8, body, "\"stream\":true") != null);
}

test "anthropic SSE parser reconstructs text and tool calls" {
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
        \\data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}
        \\
        \\data: {"type":"content_block_start","content_block":{"type":"text"}}
        \\
        \\data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
        \\
        \\data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}
        \\
        \\data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}
        \\
        \\data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\"a.txt\"}"}}
        \\
        \\data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}
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
    try std.testing.expectEqualStrings("Hello", completion.content.?);
    try std.testing.expectEqualStrings("Hello", capture.chunks.items);
    try std.testing.expectEqual(@as(usize, 1), completion.tool_calls.len);
    try std.testing.expectEqualStrings("toolu_1", completion.tool_calls[0].id);
    try std.testing.expectEqualStrings("read_file", completion.tool_calls[0].name);
    try std.testing.expectEqualStrings("{\"path\":\"a.txt\"}", completion.tool_calls[0].arguments_json);
    try std.testing.expectEqual(types.ProviderFinishReason.tool_calls, completion.finish_reason.?);
    try std.testing.expectEqual(@as(u64, 11), completion.usage.input_tokens.?);
}
