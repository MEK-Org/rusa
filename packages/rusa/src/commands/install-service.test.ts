import { describe, expect, it } from "vitest";
import { buildAlertUnit, buildServiceUnit } from "./install-service.js";

const base = {
  description: "Rusa",
  mcHome: "/home/x/.rusa",
  cliPath: "/deploy/rusa-prod/packages/rusa/dist/cli.js",
  nodePath: "/usr/bin/node",
  userPath: "/usr/bin:/bin",
};

describe("buildServiceUnit — self-update systemd policy ", () => {
  it("orchestrator unit: Restart=always + StartLimit + OnFailure + ExecStartPre", () => {
    const unit = buildServiceUnit({
      ...base,
      restart: "always",
      startLimit: { intervalSec: 300, burst: 5 },
      onFailureUnit: "rusa-alert.service",
      execStartPre: '"/usr/bin/node" "/deploy/.../verify-build.mjs" "/deploy/rusa-prod"',
    });
    expect(unit).toContain("Restart=always"); // clean exit(0) → systemd restarts
    expect(unit).not.toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("OnFailure=rusa-alert.service");
    expect(unit).toContain("ExecStartPre=");
    expect(unit).toContain("verify-build.mjs");
    // StartLimit + OnFailure belong in [Unit], before [Service].
    expect(unit.indexOf("StartLimitBurst")).toBeLessThan(unit.indexOf("[Service]"));
    expect(unit.indexOf("OnFailure=")).toBeLessThan(unit.indexOf("[Service]"));
    // ExecStartPre runs before ExecStart.
    expect(unit.indexOf("ExecStartPre=")).toBeLessThan(unit.indexOf("ExecStart="));
  });

  it("defaults to on-failure with no extra directives (package mode / forwarder)", () => {
    const unit = buildServiceUnit(base);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("StartLimitBurst");
    expect(unit).not.toContain("OnFailure=");
    expect(unit).not.toContain("ExecStartPre=");
  });

  it("logs to an append-to-file sink by default, or the journal when opted in", () => {
    expect(buildServiceUnit(base)).toContain("StandardOutput=append:");
    const journal = buildServiceUnit({ ...base, logToJournal: true });
    expect(journal).toContain("StandardOutput=journal");
    expect(journal).toContain("StandardError=journal");
    expect(journal).not.toContain("append:");
  });
});

describe("buildAlertUnit — OnFailure oneshot (build-independent notifier)", () => {
  it("is a oneshot that runs the standalone notifier with env wired", () => {
    const unit = buildAlertUnit({
      description: "Rusa failure alert",
      nodePath: "/usr/bin/node",
      notifyScript: "/deploy/rusa-prod/packages/rusa/scripts/notify-failure.mjs",
      mcHome: "/home/x/.rusa",
      errorChat: "spaces/AAAA",
      gchatConfigDir: "/home/x/.config/gchat",
      message: "rusa.service entered a failed state",
    });
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("notify-failure.mjs");
    expect(unit).toContain("Environment=RUSA_ERROR_CHAT=spaces/AAAA");
    expect(unit).toContain("Environment=GCHAT_CONFIG_DIR=/home/x/.config/gchat");
    expect(unit).toContain("Environment=RUSA_HOME=/home/x/.rusa");
    expect(unit).toContain('ExecStart="/usr/bin/node"');
  });

  it("omits the chat env lines when unconfigured (journal+marker still fire)", () => {
    const unit = buildAlertUnit({
      description: "alert",
      nodePath: "/usr/bin/node",
      notifyScript: "/x/notify-failure.mjs",
      mcHome: "/home/x/.rusa",
      message: "failed",
    });
    expect(unit).not.toContain("RUSA_ERROR_CHAT");
    expect(unit).not.toContain("GCHAT_CONFIG_DIR");
  });
});
