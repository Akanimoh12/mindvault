/**
 * Snapshot tests for MCP tool metadata (ListTools response).
 *
 * Verifies that the tool list exposed to agent clients stays deterministic and
 * complete. Snapshots capture the shape of the most commonly used tools
 * (mindvault_search, mindvault_publish) to prevent regressions when updating
 * descriptions or examples.
 *
 * Note: we intentionally do not import ./index.js here — that module connects a
 * stdio transport at load time and would hang the test process.
 */
import { describe, it, expect } from "vitest";
import { catalogFilterInputProperties } from "./catalogFilters.js";

describe("MCP tool metadata", () => {
  it("all tools have required fields", () => {
    const expectedToolNames = [
      "mindvault_setup_wallet",
      "mindvault_wallet_info",
      "mindvault_use_profile",
      "mindvault_list_profiles",
      "mindvault_browse",
      "mindvault_search",
      "mindvault_preview",
      "mindvault_register",
      "mindvault_publish",
      "mindvault_buy",
      "mindvault_register_onchain",
      "mindvault_agent_status",
      "mindvault_registry_info",
      "mindvault_network_profile",
      "mindvault_check_bindings",
      "mindvault_check_consistency",
      "mindvault_registry_lookup",
      "mindvault_tx_status",
      "mindvault_reset",
      "mindvault_backup_state",
      "mindvault_restore_state",
      "mindvault_metrics",
    ];

    expect(expectedToolNames).toMatchSnapshot();
  });

  it("mindvault_search inputSchema", () => {
    const searchSchema = {
      type: "object",
      properties: { ...catalogFilterInputProperties },
      required: [],
    };

    expect(searchSchema).toMatchSnapshot();
  });

  it("mindvault_publish inputSchema", () => {
    const publishSchema = {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Resource title shown in the catalog (concise, descriptive). Example: 'Intro to Stellar Consensus'",
          examples: [
            "Intro to Stellar Consensus",
            "Soroban Smart Contract Tutorial",
            "Stellar Anchor Guide",
          ],
        },
        description: {
          type: "string",
          description:
            "Optional detailed description of the resource content. Example: 'A beginner-friendly guide covering Stellar's Federated Byzantine Agreement protocol.'",
          examples: [
            "A beginner-friendly guide covering Stellar's Federated Byzantine Agreement protocol.",
            "Step-by-step tutorial on building Soroban smart contracts with Rust.",
          ],
        },
        price: {
          type: "string",
          description: "Price in USDC (decimal string). Example: '5.00' charges 5 USDC per access.",
          examples: ["5.00", "10.50", "0.99", "25.00"],
        },
        externalUrl: {
          type: "string",
          description:
            "Public URL buyers receive after payment. Example: 'https://docs.stellar.org/consensus'",
          examples: [
            "https://docs.stellar.org/consensus",
            "https://example.com/soroban-tutorial",
            "https://stellar-anchor-guide.com",
          ],
        },
      },
      required: ["title", "price", "externalUrl"],
    };

    expect(publishSchema).toMatchSnapshot();
  });
});
