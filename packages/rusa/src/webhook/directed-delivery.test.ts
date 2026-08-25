import { describe, expect, it } from "vitest";
import {
  directiveBodyForWebhookPayload,
  parseDirectedDeliveryDirective,
} from "./directed-delivery.js";

describe("parseDirectedDeliveryDirective", () => {
  it("parses the HTML-comment directive target", () => {
    expect(parseDirectedDeliveryDirective("hello\n<!-- mesh:deliver cloudy-porpoise -->")).toBe(
      "cloudy-porpoise"
    );
    expect(
      parseDirectedDeliveryDirective("<!-- mesh:deliver b4b43d69-5e63-4db2-b44b-35c031096aad -->")
    ).toBe("b4b43d69-5e63-4db2-b44b-35c031096aad");
  });

  it("does not parse prose, markdown tables, or the dropped visible alias", () => {
    expect(parseDirectedDeliveryDirective("please mesh:deliver cloudy-porpoise")).toBeNull();
    expect(parseDirectedDeliveryDirective("| mesh:deliver | cloudy-porpoise |")).toBeNull();
    expect(parseDirectedDeliveryDirective("!mesh cloudy-porpoise")).toBeNull();
  });
});

describe("directiveBodyForWebhookPayload", () => {
  it("extracts body from comment, review, pull_request, and issue payloads", () => {
    expect(directiveBodyForWebhookPayload({ comment: { body: "comment text" } })).toBe(
      "comment text"
    );
    expect(directiveBodyForWebhookPayload({ review: { body: "review text" } })).toBe("review text");
    expect(directiveBodyForWebhookPayload({ pull_request: { body: "pr text" } })).toBe("pr text");
    expect(directiveBodyForWebhookPayload({ issue: { body: "issue text" } })).toBe("issue text");
    expect(directiveBodyForWebhookPayload({})).toBeNull();
  });
});
