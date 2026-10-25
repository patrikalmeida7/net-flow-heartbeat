import { describe, it, expect } from "vitest";
import { collectionHealth } from "@/lib/collectionHealth";

const now = Date.parse("2026-10-25T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("collectionHealth", () => {
  it("no data when never collected", () => {
    expect(collectionHealth({ lastCollectAt: null, anyDeviceOffline: false, now })).toBe("no_data");
  });
  it("ok within 2 minutes", () => {
    expect(collectionHealth({ lastCollectAt: ago(60_000), anyDeviceOffline: false, now })).toBe("ok");
  });
  it("delayed after 2 minutes", () => {
    expect(collectionHealth({ lastCollectAt: ago(3 * 60_000), anyDeviceOffline: false, now })).toBe("delayed");
  });
  it("collector down after 10 minutes", () => {
    expect(collectionHealth({ lastCollectAt: ago(11 * 60_000), anyDeviceOffline: false, now })).toBe("collector_down");
  });
  it("device down when fresh but a device is offline", () => {
    expect(collectionHealth({ lastCollectAt: ago(30_000), anyDeviceOffline: true, now })).toBe("device_down");
  });
});
