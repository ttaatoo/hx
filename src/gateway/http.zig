const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const agent_stream_provider = @import("../core/agent/stream_provider.zig");
const debug_trace = @import("../core/shared/debug_trace.zig");
const io_mod = @import("../core/shared/io.zig");

pub fn isRetryableTransportError(err: anyerror) bool {
    return err == error.HttpConnectionClosing or
        err == error.ConnectionResetByPeer or
        err == error.ConnectionTimedOut;
}

/// Legacy name used by existing call sites.
pub const isRetryableGatewayError = isRetryableTransportError;

pub fn networkFailureEvidence(
    err: anyerror,
    delivery: agent_stream_provider.DeliveryCertainty.State,
) ?agent_stream_provider.NetworkFailureEvidence {
    const cause: agent_stream_provider.NetworkFailureCause = if (err == error.SystemResumed)
        .system_resumed
    else if (isRetryableAgentNetworkError(err))
        .transport_interrupted
    else
        return null;
    return .{ .cause = cause, .delivery = delivery };
}

fn isRetryableAgentNetworkError(err: anyerror) bool {
    return err == error.TlsInitializationFailed or
        err == error.ConnectionSetupTimedOut or
        err == error.UnknownHostName or
        err == error.NameServerFailure or
        err == error.NoAddressReturned or
        err == error.DetectingNetworkConfigurationFailed or
        err == error.AddressUnavailable or
        err == error.ConnectionPending or
        err == error.ConnectionRefused or
        err == error.HostUnreachable or
        err == error.NetworkUnreachable or
        err == error.NetworkDown or
        err == error.Timeout or
        err == error.WouldBlock or
        err == error.WriteFailed or
        err == error.ReadFailed or
        isRetryableTransportError(err);
}

fn connectedIoFailure(
    cancelled: bool,
    system_resumed: bool,
    transport_error: anyerror,
) anyerror {
    if (cancelled) return error.Cancelled;
    if (system_resumed) return error.SystemResumed;
    return transport_error;
}

test "connected request failures prefer cancellation then wake evidence" {
    try std.testing.expectEqual(
        error.Cancelled,
        connectedIoFailure(true, true, error.WriteFailed),
    );
    try std.testing.expectEqual(
        error.SystemResumed,
        connectedIoFailure(false, true, error.WriteFailed),
    );
    try std.testing.expectEqual(
        error.WriteFailed,
        connectedIoFailure(false, false, error.WriteFailed),
    );
}

test "isRetryableTransportError matches active retryable transport errors" {
    try std.testing.expect(isRetryableTransportError(error.HttpConnectionClosing));
    try std.testing.expect(isRetryableTransportError(error.ConnectionResetByPeer));
    try std.testing.expect(isRetryableTransportError(error.ConnectionTimedOut));
    try std.testing.expect(!isRetryableTransportError(error.AccessDenied));
}

test "native network failure evidence covers setup send read and resume failures" {
    const Cases = struct {
        err: anyerror,
        cause: agent_stream_provider.NetworkFailureCause = .transport_interrupted,
    };
    const cases = [_]Cases{
        .{ .err = error.TlsInitializationFailed },
        .{ .err = error.ConnectionSetupTimedOut },
        .{ .err = error.UnknownHostName },
        .{ .err = error.NameServerFailure },
        .{ .err = error.NoAddressReturned },
        .{ .err = error.DetectingNetworkConfigurationFailed },
        .{ .err = error.AddressUnavailable },
        .{ .err = error.ConnectionPending },
        .{ .err = error.ConnectionRefused },
        .{ .err = error.ConnectionResetByPeer },
        .{ .err = error.ConnectionTimedOut },
        .{ .err = error.HostUnreachable },
        .{ .err = error.NetworkUnreachable },
        .{ .err = error.NetworkDown },
        .{ .err = error.Timeout },
        .{ .err = error.WouldBlock },
        .{ .err = error.HttpConnectionClosing },
        .{ .err = error.WriteFailed },
        .{ .err = error.ReadFailed },
        .{ .err = error.SystemResumed, .cause = .system_resumed },
    };

    for (cases) |case| {
        const evidence = networkFailureEvidence(
            case.err,
            .possibly_sent,
        ) orelse return error.TestExpectedNetworkFailureEvidence;
        try std.testing.expectEqual(case.cause, evidence.cause);
        try std.testing.expectEqual(
            agent_stream_provider.DeliveryCertainty.State.possibly_sent,
            evidence.delivery,
        );
    }

    const pre_send = networkFailureEvidence(
        error.ConnectionRefused,
        .definitely_unsent,
    ).?;
    try std.testing.expectEqual(
        agent_stream_provider.DeliveryCertainty.State.definitely_unsent,
        pre_send.delivery,
    );
}

test "native network failure evidence excludes opaque and configuration failures" {
    const excluded = [_]anyerror{
        error.JsHostStreamFailed,
        error.OutOfMemory,
        error.AccessDenied,
        error.UnsupportedUriScheme,
        error.ProtocolUnsupportedBySystem,
        error.ResolvConfParseFailed,
        error.InvalidDnsARecord,
    };

    for (excluded) |err| {
        try std.testing.expectEqual(
            @as(?agent_stream_provider.NetworkFailureEvidence, null),
            networkFailureEvidence(err, .definitely_unsent),
        );
    }
}

/// Identifies hx on outbound HTTP; the zig std.http default is never sent.
pub const user_agent = "hx/" ++ build_options.app_version;

pub fn runBoundedHttpOperation(
    comptime Result: type,
    alloc: std.mem.Allocator,
    cancel_flag: *std.atomic.Value(bool),
    deadline: std.Io.Clock.Timestamp,
    operation: anytype,
) !Result {
    if (cancel_flag.load(.seq_cst)) {
        debug_trace.logf("stream", "bounded termination cause=cancellation phase=admission", .{});
        return error.Cancelled;
    }
    std.debug.assert(deadline.clock == .awake);

    const zio = io_mod.getIo();
    const now = std.Io.Clock.Timestamp.now(zio, .awake);
    if (!std.Io.Clock.Timestamp.compare(now, .lt, deadline)) {
        debug_trace.logf("stream", "bounded termination cause=deadline phase=admission", .{});
        return error.Timeout;
    }

    const Event = union(enum) {
        request: anyerror!Result,
        cancelled: anyerror!void,
        deadline: anyerror!void,
    };
    const Operation = @TypeOf(operation);
    const Runner = struct {
        fn run(value: Operation) anyerror!Result {
            return value.run();
        }
    };
    const Cleanup = struct {
        fn drain(result_alloc: std.mem.Allocator, select: *std.Io.Select(Event)) void {
            while (select.cancel()) |item| switch (item) {
                .request => |request_result| {
                    var late_result = request_result catch continue;
                    late_result.deinit(result_alloc);
                },
                .cancelled, .deadline => {},
            };
        }
    };

    var select_buffer: [3]Event = undefined;
    var select: std.Io.Select(Event) = .init(zio, &select_buffer);
    select.concurrent(.cancelled, waitForBoundedCancellation, .{cancel_flag}) catch |err| {
        return err;
    };
    select.concurrent(.deadline, waitForBoundedDeadline, .{deadline}) catch |err| {
        select.cancelDiscard();
        return err;
    };
    select.concurrent(.request, Runner.run, .{operation}) catch |err| {
        select.cancelDiscard();
        return err;
    };

    const event = select.await() catch |err| {
        Cleanup.drain(alloc, &select);
        return err;
    };
    switch (event) {
        .request => |request_result| {
            Cleanup.drain(alloc, &select);
            if (cancel_flag.load(.seq_cst)) {
                debug_trace.logf("stream", "bounded termination cause=cancellation phase=request_result", .{});
                var owned_result = request_result catch return error.Cancelled;
                owned_result.deinit(alloc);
                return error.Cancelled;
            }
            return request_result;
        },
        .cancelled => |cancel_result| {
            cancel_result catch |err| {
                Cleanup.drain(alloc, &select);
                return err;
            };
            Cleanup.drain(alloc, &select);
            debug_trace.logf("stream", "bounded termination cause=cancellation phase=control", .{});
            return error.Cancelled;
        },
        .deadline => |deadline_result| {
            deadline_result catch |err| {
                Cleanup.drain(alloc, &select);
                return err;
            };
            Cleanup.drain(alloc, &select);
            if (cancel_flag.load(.seq_cst)) {
                debug_trace.logf("stream", "bounded termination cause=cancellation phase=deadline_cleanup", .{});
                return error.Cancelled;
            }
            debug_trace.logf("stream", "bounded termination cause=deadline phase=control", .{});
            return error.Timeout;
        },
    }
}

fn waitForBoundedCancellation(cancel_flag: *std.atomic.Value(bool)) anyerror!void {
    while (!cancel_flag.load(.seq_cst)) {
        try io_mod.getIo().sleep(.fromMilliseconds(5), .awake);
    }
}

fn waitForBoundedDeadline(deadline: std.Io.Clock.Timestamp) anyerror!void {
    try deadline.wait(io_mod.getIo());
}

const HttpCancelWatcher = struct {
    fn run(
        done: *std.atomic.Value(bool),
        cancel_flag: *std.atomic.Value(bool),
        system_resumed: ?*std.atomic.Value(bool),
        stream: std.Io.net.Stream,
    ) void {
        var previous = SuspendClockSample.now();
        while (!done.load(.seq_cst)) {
            if (cancel_flag.load(.seq_cst)) {
                stream.shutdown(io_mod.getIo(), .both) catch {};
                return;
            }
            io_mod.sleep(10 * std.time.ns_per_ms);
            const current = SuspendClockSample.now();
            if (system_resumed != null and suspendGapDetected(previous, current)) {
                if (cancel_flag.load(.seq_cst)) {
                    stream.shutdown(io_mod.getIo(), .both) catch {};
                    return;
                }
                system_resumed.?.store(true, .seq_cst);
                stream.shutdown(io_mod.getIo(), .both) catch {};
                return;
            }
            previous = current;
        }
    }
};

const suspend_gap_tolerance_ns: i128 = 100 * std.time.ns_per_ms;

const SuspendClockSample = struct {
    awake_ns: i128,
    boot_ns: i128,

    fn now() SuspendClockSample {
        const io = io_mod.getIo();
        return .{
            .awake_ns = @intCast(std.Io.Clock.Timestamp.now(io, .awake).raw.toNanoseconds()),
            .boot_ns = @intCast(std.Io.Clock.Timestamp.now(io, .boot).raw.toNanoseconds()),
        };
    }
};

fn suspendGapDetected(previous: SuspendClockSample, current: SuspendClockSample) bool {
    const awake_elapsed = current.awake_ns - previous.awake_ns;
    const boot_elapsed = current.boot_ns - previous.boot_ns;
    if (awake_elapsed < 0 or boot_elapsed < 0) return false;
    return boot_elapsed - awake_elapsed > suspend_gap_tolerance_ns;
}

pub fn spawnHttpCancelWatcher(
    done: *std.atomic.Value(bool),
    cancel_flag: *std.atomic.Value(bool),
    stream: std.Io.net.Stream,
) !?std.Thread {
    if (comptime builtin.single_threaded) return null;
    return try std.Thread.spawn(.{}, HttpCancelWatcher.run, .{
        done,
        cancel_flag,
        @as(?*std.atomic.Value(bool), null),
        stream,
    });
}

test "suspend gap classification compares boot and awake clocks" {
    const before = SuspendClockSample{ .awake_ns = 1_000, .boot_ns = 10_000 };
    try std.testing.expect(!suspendGapDetected(before, .{
        .awake_ns = before.awake_ns + 10 * std.time.ns_per_ms,
        .boot_ns = before.boot_ns + 10 * std.time.ns_per_ms,
    }));
    try std.testing.expect(!suspendGapDetected(before, .{
        .awake_ns = before.awake_ns + 10 * std.time.ns_per_ms,
        .boot_ns = before.boot_ns + 10 * std.time.ns_per_ms + suspend_gap_tolerance_ns,
    }));
    try std.testing.expect(suspendGapDetected(before, .{
        .awake_ns = before.awake_ns + 10 * std.time.ns_per_ms,
        .boot_ns = before.boot_ns + 10 * std.time.ns_per_ms + suspend_gap_tolerance_ns + 1,
    }));
}

pub fn isLoopbackHttpUrl(url: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "http") or
        uri.user != null or
        uri.password != null or
        uri.port == null)
    {
        return false;
    }

    const host_component = uri.host orelse return false;
    var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
    const host = host_component.toRaw(&host_buf) catch return false;
    return std.mem.eql(u8, host, "127.0.0.1") or
        std.ascii.eqlIgnoreCase(host, "localhost") or
        std.mem.eql(u8, host, "[::1]");
}

test "oauth transport user agent uses the product version" {
    try std.testing.expect(std.mem.startsWith(u8, user_agent, "hx/"));
    try std.testing.expect(user_agent.len > "hx/".len);
    try std.testing.expect(std.mem.find(u8, user_agent, "zig") == null);
    try std.testing.expect(std.mem.find(u8, user_agent, "std.http") == null);
}
