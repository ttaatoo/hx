const std = @import("std");

const api_key_validator_contract = @import("../core/auth/api_key_validator.zig");
const oauth_http = @import("../core/auth/oauth_http.zig");
const model_provider = @import("../core/config/model_provider.zig");
const gateway_provider = @import("../core/gateway/gateway_provider.zig");
const model_catalog = @import("../core/gateway/model_catalog.zig");
const stream_provider = @import("../core/agent/stream_provider.zig");
const openai_codex = @import("../gateway/openai_codex.zig");
const openai_codex_models = @import("../gateway/openai_codex_models.zig");
const direct_provider = @import("../gateway/direct_provider.zig");

const Allocator = std.mem.Allocator;

pub const default_model = model_provider.default_model;
pub const retry_count: usize = 3;
pub const models_path = "/v1/models";

pub fn defaultChatUrl() []const u8 {
    return "";
}

pub const api_key_validator = api_key_validator_contract.unavailable_provider;
pub const oauth_transport_provider = oauth_http.provider;

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

/// Composition root for native OAuth transport. Model catalogs stay on the
/// SuperGrok, Anthropic, and Codex providers.
pub const provider = gateway_provider.Provider{
    .oauth_transport = oauth_transport_provider,
    .cli_model_catalog = .{ .fetch_fn = unavailableCliModelCatalog },
    .model_catalog = .{ .fetch_fn = unavailableModelCatalog },
};

pub fn agentStream(selected: model_provider.ProviderId) stream_provider.Provider {
    return switch (selected) {
        .codex => openai_codex.agent_stream_provider,
        .anthropic, .xai => direct_provider.agent_stream_provider,
    };
}

pub fn modelCatalog(selected: model_provider.ProviderId) model_catalog.Provider {
    return switch (selected) {
        .codex => openai_codex_models.model_catalog_provider,
        .anthropic, .xai => direct_provider.model_catalog_provider,
    };
}
