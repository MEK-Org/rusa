import { describe, expect, it } from "vitest";
import { verifiedSenderWorkspace } from "./sender-workspace.js";

// Synthetic Slack ids; not a real workspace or user.
const HOME = "T0HOME";
const OTHER = "T0OTHER";

function envelope(overrides: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return {
    team_id: HOME,
    event_id: "Ev1",
    event: {
      type: "app_mention",
      channel: "C1",
      ts: "1720000000.000001",
      user: "U1",
      team: HOME,
      ...event,
    },
    ...overrides,
  };
}

describe("verifiedSenderWorkspace (#1038)", () => {
  it("returns the installation's workspace when every workspace field agrees", () => {
    expect(verifiedSenderWorkspace(envelope(), HOME)).toBe(HOME);
    expect(
      verifiedSenderWorkspace(envelope({}, { user_team: HOME, source_team: HOME }), HOME)
    ).toBe(HOME);
    // Event-level team fields are optional; the envelope's team_id is not.
    expect(verifiedSenderWorkspace(envelope({}, { team: undefined }), HOME)).toBe(HOME);
    // A single-workspace envelope as Slack sends it, with its null enterprise fields.
    expect(
      verifiedSenderWorkspace(
        envelope({
          context_team_id: HOME,
          context_enterprise_id: null,
          authorizations: [
            { enterprise_id: null, team_id: HOME, user_id: "U0BOT", is_enterprise_install: false },
          ],
        }),
        HOME
      )
    ).toBe(HOME);
  });

  it("reads an empty enterprise id as naming no enterprise, as auth.test does", () => {
    expect(
      verifiedSenderWorkspace(
        envelope({
          enterprise_id: "",
          context_enterprise_id: "",
          authorizations: [{ enterprise_id: "", team_id: HOME, is_enterprise_install: false }],
        }),
        HOME
      )
    ).toBe(HOME);
  });

  it.each<[string, unknown, string | undefined]>([
    ["installation unknown", envelope(), undefined],
    ["envelope from another workspace", envelope({ team_id: OTHER }, { team: OTHER }), HOME],
    ["envelope without a team", envelope({ team_id: undefined }), HOME],
    ["sender from another workspace", envelope({}, { user_team: OTHER }), HOME],
    ["event team disagrees", envelope({}, { team: OTHER }), HOME],
    ["source team disagrees", envelope({}, { source_team: OTHER }), HOME],
    ["externally shared channel", envelope({ is_ext_shared_channel: true }), HOME],
    ["Enterprise Grid envelope", envelope({ enterprise_id: "E0GRID" }), HOME],
    [
      "enterprise install",
      envelope({ authorizations: [{ team_id: HOME, is_enterprise_install: true }] }),
      HOME,
    ],
    ["context team disagrees", envelope({ context_team_id: OTHER }), HOME],
    ["Grid context enterprise", envelope({ context_enterprise_id: "E0GRID" }), HOME],
    [
      "Grid authorization",
      envelope({
        authorizations: [{ enterprise_id: "E0GRID", team_id: HOME, is_enterprise_install: false }],
      }),
      HOME,
    ],
    ["case differs", envelope({ team_id: HOME.toLowerCase() }), HOME],
    ["not an object", "T0HOME", HOME],
  ])("withholds a workspace it cannot prove: %s", (_name, body, installation) => {
    expect(verifiedSenderWorkspace(body, installation)).toBeUndefined();
  });
});
