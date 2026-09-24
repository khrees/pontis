import { describe, it, expect } from "vitest";
import { CLIENTS, ALL_CLIENTS, CLIENTS_WITH_INSTALL_SCRIPT } from "../src/cli/install-engine";

describe("New Clients (Hermes Agent)", () => {
  describe("Client Registry", () => {
    it("should include hermes in ALL_CLIENTS and CLIENTS_WITH_INSTALL_SCRIPT", () => {
      expect(ALL_CLIENTS).toContain("hermes");
      expect(CLIENTS_WITH_INSTALL_SCRIPT).toContain("hermes");
      expect(CLIENTS.hermes).toBeDefined();
      expect(CLIENTS.hermes.name).toBe("Hermes Agent");
      expect(CLIENTS.hermes.binary).toBe("hermes");
      expect(CLIENTS.hermes.installScript).toBe("https://hermes-agent.nousresearch.com/install.sh");
    });
  });
});
