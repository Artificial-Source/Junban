import { describe, it, expect } from "vitest";
import { validateOutboundNetworkUrl } from "../../src/plugins/network-policy.js";

describe("validateOutboundNetworkUrl", () => {
  it("allows public HTTPS URLs", () => {
    const url = validateOutboundNetworkUrl("https://example.com/plugin.tgz", {
      context: "test",
      requireHttps: true,
    });
    expect(url.hostname).toBe("example.com");
  });

  it("blocks private IPv4 ranges", () => {
    expect(() =>
      validateOutboundNetworkUrl("http://192.168.1.20/secret", {
        context: "test",
      }),
    ).toThrow(/private IPv4 ranges are not allowed/);
  });

  it("blocks internal hostname suffixes", () => {
    expect(() =>
      validateOutboundNetworkUrl("https://service.internal/api", {
        context: "test",
      }),
    ).toThrow(/internal hostnames are not allowed/);
  });

  it("blocks file scheme", () => {
    expect(() =>
      validateOutboundNetworkUrl("file:///etc/passwd", {
        context: "test",
      }),
    ).toThrow(/http\/https only/);
  });

  it("blocks IPv4-mapped IPv6 dotted loopback", () => {
    expect(() =>
      validateOutboundNetworkUrl("http://[::ffff:127.0.0.1]/", {
        context: "test",
      }),
    ).toThrow(/local\/private IPv6 ranges are not allowed/);
  });

  it("blocks IPv4-mapped IPv6 hex-colon loopback", () => {
    expect(() =>
      validateOutboundNetworkUrl("http://[::ffff:7f00:1]/", {
        context: "test",
      }),
    ).toThrow(/local\/private IPv6 ranges are not allowed/);
  });

  it("blocks IPv4-mapped IPv6 hex-colon private ranges", () => {
    expect(() =>
      validateOutboundNetworkUrl("http://[::ffff:c0a8:0102]/", {
        context: "test",
      }),
    ).toThrow(/local\/private IPv6 ranges are not allowed/);
  });

  it("enforces HTTPS for install flows", () => {
    expect(() =>
      validateOutboundNetworkUrl("http://example.com/plugin.tgz", {
        context: "plugin install download",
        requireHttps: true,
      }),
    ).toThrow(/HTTPS is required/);
  });
});
